import "server-only";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// One SQLite file holds users, sessions and conversations. On Liara it lives on a
// mounted disk (see liara.json) so it survives deploys.

const DB_PATH = path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.DATABASE_PATH || "data/yara.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  liara_token_enc TEXT,
  team_id TEXT,
  model TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  messages TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_user_updated ON chats(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS shell_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

const globalForDb = globalThis as unknown as { yaraDb?: Database.Database };

export function db(): Database.Database {
  if (!globalForDb.yaraDb) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const conn = new Database(DB_PATH);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
    conn.exec(SCHEMA);
    migrate(conn);
    globalForDb.yaraDb = conn;
  }
  return globalForDb.yaraDb;
}

export const dataDir = () => path.dirname(DB_PATH);

/** Additive migrations for databases created by earlier versions. */
function migrate(conn: Database.Database) {
  const cols = (table: string) => new Set((conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  const users = cols("users");
  if (!users.has("github_token_enc")) conn.exec("ALTER TABLE users ADD COLUMN github_token_enc TEXT");
  if (!users.has("runner_token_hash")) conn.exec("ALTER TABLE users ADD COLUMN runner_token_hash TEXT");
  const chats = cols("chats");
  // "graph" chats live in the LangGraph checkpointer; "legacy" ones in chats.messages.
  if (!chats.has("engine")) conn.exec("ALTER TABLE chats ADD COLUMN engine TEXT NOT NULL DEFAULT 'legacy'");
  if (!chats.has("pending")) conn.exec("ALTER TABLE chats ADD COLUMN pending INTEGER NOT NULL DEFAULT 0");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      repo TEXT NOT NULL,
      branch TEXT,
      app TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workspaces_user ON workspaces(user_id);
  `);
  // Governance: per-user action policy and an append-only record of every change the agents made or tried.
  if (!users.has("policy")) conn.exec("ALTER TABLE users ADD COLUMN policy TEXT");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id TEXT,
      agent TEXT NOT NULL,
      tool TEXT NOT NULL,
      title TEXT NOT NULL,
      target TEXT,
      risk TEXT NOT NULL,
      args_json TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL,
      result_json TEXT,
      verified INTEGER,
      rollback_enc TEXT,
      rolled_back_by TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS audit_user_time ON audit_log(user_id, created_at);
    CREATE INDEX IF NOT EXISTS audit_thread ON audit_log(thread_id, created_at);
  `);
  // Monitoring: which apps are watched, every health check, incidents opened from them,
  // and scheduled routines (backups, restarts) the user authorised once.
  if (!users.has("alert_webhook_enc")) conn.exec("ALTER TABLE users ADD COLUMN alert_webhook_enc TEXT");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS monitors (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      app TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      interval_min INTEGER NOT NULL DEFAULT 5,
      path TEXT NOT NULL DEFAULT '/',
      auto_heal INTEGER NOT NULL DEFAULT 1,
      last_check_at INTEGER,
      last_status TEXT,
      fail_streak INTEGER NOT NULL DEFAULT 0,
      baseline_ms INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, app)
    );
    CREATE TABLE IF NOT EXISTS health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      app TEXT NOT NULL,
      at INTEGER NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER,
      latency_ms INTEGER,
      cpu_pct INTEGER,
      mem_pct INTEGER,
      error_lines INTEGER,
      summary TEXT NOT NULL,
      causes_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS checks_user_app_time ON health_checks(user_id, app, at);
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      app TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      causes_json TEXT NOT NULL DEFAULT '[]',
      timeline_json TEXT NOT NULL DEFAULT '[]',
      heal_attempts INTEGER NOT NULL DEFAULT 0,
      escalated INTEGER NOT NULL DEFAULT 0,
      opened_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS incidents_user ON incidents(user_id, status, opened_at);
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      target_json TEXT NOT NULL,
      label TEXT NOT NULL,
      hour INTEGER NOT NULL,
      weekday INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER NOT NULL,
      last_run_at INTEGER,
      last_status TEXT,
      last_audit_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS routines_due ON routines(enabled, next_run_at);
  `);
}
