// Custom server: Next.js plus a WebSocket proxy for the app shell (Liara exec).
// The browser never sees the user's Liara token: it trades a short-lived, single-use
// ticket (minted by /api/shell/ticket) for a proxied shell session.
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import next from "next";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.PORT || 3000);
const dev = process.env.NODE_ENV !== "production";
// Overridable for local testing against a mock exec endpoint.
const LIARA_EXEC = process.env.LIARA_EXEC_URL || "wss://api.iran.liara.ir/v1/exec";
const DB_PATH = path.resolve(process.cwd(), process.env.DATABASE_PATH || "data/yara.db");

// ---- token decryption (format defined in lib/server/crypto.ts: v1.iv.tag.data, AES-256-GCM) ----
function secretKey() {
  let secret = process.env.APP_SECRET;
  if (!secret) secret = fs.readFileSync(path.join(path.dirname(DB_PATH), "secret.key"), "utf8").trim();
  return crypto.createHash("sha256").update(secret).digest();
}

function decrypt(payload) {
  const [v, iv, tag, data] = payload.split(".");
  if (v !== "v1") throw new Error("unknown token format");
  const d = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

let db;
function redeemTicket(ticket) {
  if (!db) {
    db = new Database(DB_PATH);
    // Same definition as lib/server/db.ts; the proxy may run before the app has touched the DB.
    db.exec(
      "CREATE TABLE IF NOT EXISTS shell_tickets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, app TEXT NOT NULL, expires_at INTEGER NOT NULL)",
    );
  }
  const row = db
    .prepare(
      `SELECT t.app, u.liara_token_enc AS token, u.team_id AS team FROM shell_tickets t JOIN users u ON u.id = t.user_id
       WHERE t.id = ? AND t.expires_at > ?`,
    )
    .get(ticket, Date.now());
  db.prepare("DELETE FROM shell_tickets WHERE id = ? OR expires_at < ?").run(ticket, Date.now());
  if (!row?.token) return null;
  return { app: row.app, token: decrypt(row.token), team: row.team ?? "" };
}

// ---- shell proxy ----
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

wss.on("connection", (client, _req, session) => {
  const url = `${LIARA_EXEC}?token=${encodeURIComponent(session.token)}&cmd=${encodeURIComponent("/bin/bash")}&project_id=${encodeURIComponent(session.app)}&teamID=${encodeURIComponent(session.team)}`;
  const upstream = new WebSocket(url);
  const pending = [];

  upstream.on("open", () => {
    for (const m of pending.splice(0)) upstream.send(m);
  });
  upstream.on("message", (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: false });
  });
  upstream.on("unexpected-response", (_r, res) => {
    const reason = res.statusCode === 404 ? "app-not-found" : res.statusCode === 401 ? "unauthorized" : `upstream-${res.statusCode}`;
    client.close(4000, reason);
  });
  upstream.on("error", () => client.readyState === WebSocket.OPEN && client.close(4001, "upstream-error"));
  upstream.on("close", () => client.readyState === WebSocket.OPEN && client.close(1000, "closed"));

  client.on("message", (data) => {
    const text = data.toString();
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else pending.push(text);
  });
  client.on("close", () => upstream.close());
});

const app = next({ dev, port });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((req, res) => handle(req, res));

// Next attaches its own "upgrade" listener on first request; keep it away from the shell path.
const isShell = (req) => (req.url ?? "").startsWith("/ws/shell");
const on = server.on.bind(server);
server.on = (event, listener) =>
  event === "upgrade" ? on(event, (req, socket, head) => (isShell(req) ? undefined : listener(req, socket, head))) : on(event, listener);

on("upgrade", (req, socket, head) => {
  if (!isShell(req)) return;
  try {
    const ticket = new URL(req.url, "http://x").searchParams.get("ticket") ?? "";
    const session = redeemTicket(ticket);
    if (!session) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, session));
  } catch (e) {
    console.error("[shell]", e);
    socket.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
  }
});

server.listen(port, () => console.log(`> Yara ready on http://localhost:${port} (${dev ? "dev" : "production"})`));
