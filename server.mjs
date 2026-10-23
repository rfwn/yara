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

const port = Number(process.env.PORT || 3001);
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

// ---- local runners (runner/yara-runner.mjs) ----
// Registered on globalThis so Next route handlers in this process can reach them (lib/server/workspaces.ts).
const runners = (globalThis.__yaraRunners ??= new Map());
const runnerWss = new WebSocketServer({ noServer: true, maxPayload: 300 * 1024 * 1024 });

function runnerUser(token) {
  db ??= new Database(DB_PATH);
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  return db.prepare("SELECT id FROM users WHERE runner_token_hash = ?").get(hash)?.id ?? null;
}

runnerWss.on("connection", (ws, _req, userId) => {
  let id = "";
  const pending = new Map();
  let seq = 0;
  ws.once("message", (raw) => {
    let hello;
    try {
      hello = JSON.parse(raw.toString()).hello;
    } catch {}
    if (!hello) return ws.close(4400, "expected hello");
    // Stable per user + runner name + folder, so a reconnect keeps the same workspace id.
    id = crypto.createHash("sha256").update(`${userId}|${hello.name}|${hello.root}`).digest("hex").slice(0, 10);
    runners.get(id)?.socket.close(4409, "replaced by a newer connection");
    runners.set(id, {
      id,
      socket: ws,
      userId,
      name: String(hello.name ?? "runner").slice(0, 60),
      root: String(hello.root ?? "").slice(0, 300),
      platform: String(hello.platform ?? ""),
      call: (method, params, timeoutMs = 120_000) =>
        new Promise((resolve, reject) => {
          const n = ++seq;
          const timer = setTimeout(() => {
            pending.delete(n);
            reject(new Error(`Local runner timed out on ${method}`));
          }, timeoutMs);
          pending.set(n, { resolve, reject, timer });
          ws.send(JSON.stringify({ id: n, method, params }));
        }),
    });
    console.log(`[runner] ${hello.name} connected (${id})`);
    ws.on("message", (raw2) => {
      let msg;
      try {
        msg = JSON.parse(raw2.toString());
      } catch {
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
    });
  });
  ws.on("close", () => {
    if (runners.get(id)?.socket === ws) runners.delete(id);
    for (const p of pending.values()) p.reject(new Error("Local runner disconnected"));
  });
});

const app = next({ dev, port });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((req, res) => handle(req, res));

// Next attaches its own "upgrade" listener on first request; keep it away from our socket paths.
const isShell = (req) => (req.url ?? "").startsWith("/ws/shell") || (req.url ?? "").startsWith("/ws/runner");
const on = server.on.bind(server);
server.on = (event, listener) =>
  event === "upgrade" ? on(event, (req, socket, head) => (isShell(req) ? undefined : listener(req, socket, head))) : on(event, listener);

on("upgrade", (req, socket, head) => {
  if (!isShell(req)) return;
  if (req.url.startsWith("/ws/runner")) {
    const userId = runnerUser(new URL(req.url, "http://x").searchParams.get("token") ?? "");
    if (!userId) return socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return runnerWss.handleUpgrade(req, socket, head, (ws) => runnerWss.emit("connection", ws, req, userId));
  }
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

// ---- monitoring loop ----
// Every minute, ask the app to run due health checks and routines (lib/server/monitor.ts).
// The key is derived from APP_SECRET like lib/server/crypto.ts internalKey(), so only this process can trigger a tick.
const MONITOR_EVERY_MS = Number(process.env.MONITOR_TICK_SECONDS || 60) * 1000;
async function monitorTick() {
  try {
    const key = crypto.createHmac("sha256", secretKey()).update("monitor-tick").digest("hex");
    const res = await fetch(`http://127.0.0.1:${port}/api/monitor/tick`, { method: "POST", headers: { "x-yara-internal": key } });
    if (!res.ok && res.status !== 202) console.error(`[monitor] tick answered ${res.status}`);
  } catch (e) {
    // No secret key yet (fresh install before the first sign-up), or the app is still compiling.
    if (dev) console.warn("[monitor] tick skipped:", e instanceof Error ? e.message : e);
  }
}

server.listen(port, () => {
  console.log(`> Yara ready on http://localhost:${port} (${dev ? "dev" : "production"})`);
  if (process.env.MONITOR_DISABLED !== "1") {
    setTimeout(monitorTick, 15_000);
    setInterval(monitorTick, MONITOR_EVERY_MS).unref();
  }
});
