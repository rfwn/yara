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
    globalForDb.yaraDb = conn;
  }
  return globalForDb.yaraDb;
}

export const dataDir = () => path.dirname(DB_PATH);
