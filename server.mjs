// Custom server: Next.js plus a WebSocket proxy for the app shell (Liara exec).
// The browser never sees the user's Liara token: it trades a short-lived, single-use
// ticket (minted by /api/shell/ticket) for a proxied shell session.
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import net from "node:net";
import next from "next";
import { Client as SshClient } from "ssh2";
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

// ---- VM SSH (browser terminal → this proxy → the user's own VM) ----
// The ticket (minted by /api/vms/[id]/ssh after checking the VM belongs to the user) fixes the host;
// credentials arrive once over the socket, go straight to ssh2 and are never stored or logged.
// Host keys are trusted on first use and pinned per user+VM; a changed key is refused.
const sshWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
const SSH_IDLE_MS = 15 * 60_000;
const SSH_MAX_MS = 2 * 60 * 60_000;
const isPrivateV4 = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
};

const IAAS_BASE = process.env.LIARA_IAAS_BASE || "https://iaas-api.liara.ir";

/** The VM's root password from Liara's IaaS API, only if the VM still has the address the ticket was minted for. */
async function vmCredsFromLiara(s) {
  const u = db.prepare("SELECT liara_token_enc AS token, team_id AS team FROM users WHERE id = ?").get(s.user_id);
  if (!u?.token) return null;
  const url = new URL(`/vm/${encodeURIComponent(s.vm_id)}`, IAAS_BASE);
  if (u.team) url.searchParams.set("teamID", u.team);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${decrypt(u.token)}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Liara IaaS ${res.status}`);
  const d = await res.json();
  if (!(d.IPs ?? []).some((ip) => ip.address === s.host)) throw new Error("VM address changed since the ticket was minted");
  return typeof d.config?.rootPassword === "string" && d.config.rootPassword ? d.config.rootPassword : null;
}

function redeemSshTicket(ticket) {
  db ??= new Database(DB_PATH);
  // Same definitions as lib/server/db.ts, in case this process meets an older database first.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ssh_tickets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, vm_id TEXT NOT NULL, vm_name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS vm_host_keys (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, vm_id TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, vm_id));
  `);
  const row = db.prepare("SELECT * FROM ssh_tickets WHERE id = ? AND expires_at > ?").get(ticket, Date.now());
  db.prepare("DELETE FROM ssh_tickets WHERE id = ? OR expires_at < ?").run(ticket, Date.now());
  return row ?? null;
}

/** Same row shape as lib/server/audit.ts, so SSH sessions show up in the audit log beside everything else. */
function sshAudit(s, status, extra) {
  try {
    const id = `ch_${crypto.randomBytes(6).toString("hex")}`;
    const now = Date.now();
    const args = JSON.stringify({ vm: s.vm_name, host: s.host, port: s.port, user: extra.user });
    db.prepare(
      `INSERT INTO audit_log (id, user_id, thread_id, agent, tool, title, target, risk, args_json, args_hash, decision, reason, status, result_json, created_at, finished_at)
       VALUES (?, ?, 'ssh', 'user', 'vmSsh', 'نشست SSH به ماشین مجازی', ?, 'medium', ?, ?, 'approved', 'Opened by the user from the VM page; credentials are never stored.', ?, ?, ?, ?)`,
    ).run(id, s.user_id, s.vm_name, args, crypto.createHash("sha256").update(args + now).digest("hex").slice(0, 24), status, JSON.stringify(extra), extra.startedAt ?? now, now);
  } catch (e) {
    console.error("[ssh] audit failed", e);
  }
}

sshWss.on("connection", (ws, _req, s) => {
  const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
  const ssh = new SshClient();
  let stream = null;
  let idle;
  let user = "";
  let credsFrom = "manual";
  const startedAt = Date.now();
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      send({ t: "status", state: "closed", reason: "idle" });
      ws.close(4000, "idle");
    }, SSH_IDLE_MS);
  };
  const hardStop = setTimeout(() => ws.close(4000, "max-duration"), SSH_MAX_MS);
  let audited = false;
  const finish = (status, reason) => {
    if (audited || !user) return;
    audited = true;
    sshAudit(s, status, { user, reason, startedAt, credentials: credsFrom, minutes: Math.round((Date.now() - startedAt) / 60000) });
  };

  ws.once("message", async (raw) => {
    let auth;
    try {
      auth = JSON.parse(raw.toString());
    } catch {}
    const fromLiara = auth?.mode === "liara";
    if (auth?.t !== "auth" || (!fromLiara && (!/^[a-z_][a-z0-9_-]{0,31}$/.test(auth.username ?? "") || (!auth.password && !auth.privateKey)))) return ws.close(4400, "bad-auth-message");
    if (!net.isIPv4(s.host) || (isPrivateV4(s.host) && process.env.SSH_ALLOW_PRIVATE !== "1")) return ws.close(4403, "bad-host");
    send({ t: "status", state: "connecting", host: s.host, port: s.port });
    if (fromLiara) {
      // The VM's root password, read from Liara with the user's own token at the moment of connecting.
      // It goes from Liara to ssh2 inside this process: never to the browser, the database or the agents.
      try {
        const c = vmCredsFromLiara(s);
        const creds = await c;
        if (!creds) return ws.close(4404, "no-liara-password");
        auth = { ...auth, username: "root", password: creds };
        credsFrom = "liara";
      } catch (e) {
        console.error("[ssh] liara credentials:", e instanceof Error ? e.message : e);
        return ws.close(4502, "liara-unreachable");
      }
    }
    user = auth.username;

    ssh
      .on("ready", () => {
        ssh.shell({ term: "xterm-256color", cols: Math.min(auth.cols || 100, 400), rows: Math.min(auth.rows || 30, 200) }, (err, st) => {
          if (err) return ws.close(4001, "shell-failed");
          stream = st;
          send({ t: "status", state: "open" });
          bump();
          st.on("data", (d) => send({ t: "data", d: d.toString("utf8") }));
          st.stderr?.on("data", (d) => send({ t: "data", d: d.toString("utf8") }));
          st.on("close", () => ws.close(1000, "closed"));
        });
      })
      .on("error", (e) => {
        const reason = /authentication/i.test(e.message) ? "auth-failed" : e.level === "client-timeout" ? "timeout" : /host key|host denied|verification failed/i.test(e.message) ? "host-key-changed" : "ssh-error";
        finish("error", reason);
        send({ t: "status", state: "error", reason, detail: reason === "ssh-error" ? e.message.slice(0, 200) : undefined });
        ws.close(4002, reason);
      })
      .connect({
        host: s.host,
        port: s.port,
        username: auth.username,
        password: auth.password || undefined,
        privateKey: auth.privateKey || undefined,
        passphrase: auth.passphrase || undefined,
        readyTimeout: 15_000,
        keepaliveInterval: 20_000,
        hostVerifier: (key) => {
          const fp = `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
          const known = db.prepare("SELECT fingerprint FROM vm_host_keys WHERE user_id = ? AND vm_id = ?").get(s.user_id, s.vm_id);
          if (known && known.fingerprint !== fp) {
            send({ t: "hostkey", fingerprint: fp, expected: known.fingerprint, changed: true });
            return false;
          }
          if (!known) db.prepare("INSERT INTO vm_host_keys (user_id, vm_id, fingerprint, created_at) VALUES (?, ?, ?, ?)").run(s.user_id, s.vm_id, fp, Date.now());
          send({ t: "hostkey", fingerprint: fp, firstTime: !known });
          return true;
        },
      });
    // Drop the credentials from this scope as soon as ssh2 has them.
    auth.password = auth.privateKey = auth.passphrase = undefined;

    ws.on("message", (m) => {
      let msg;
      try {
        msg = JSON.parse(m.toString());
      } catch {
        return;
      }
      if (msg.t === "data" && stream && typeof msg.d === "string") {
        stream.write(msg.d);
        bump();
      } else if (msg.t === "resize" && stream) stream.setWindow(Math.min(msg.rows || 30, 200), Math.min(msg.cols || 100, 400), 0, 0);
    });
  });

  ws.on("close", () => {
    clearTimeout(idle);
    clearTimeout(hardStop);
    finish("ok", "closed");
    ssh.end();
  });
});

const app = next({ dev, port });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((req, res) => handle(req, res));

// Next attaches its own "upgrade" listener on first request; keep it away from our socket paths.
const isShell = (req) => /^\/ws\/(shell|runner|ssh)(\?|$)/.test(req.url ?? "");
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
  if (req.url.startsWith("/ws/ssh")) {
    const s = redeemSshTicket(new URL(req.url, "http://x").searchParams.get("ticket") ?? "");
    if (!s) return socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return sshWss.handleUpgrade(req, socket, head, (ws) => sshWss.emit("connection", ws, req, s));
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
