import "server-only";
import type { UIMessage } from "ai";
import { isAction } from "../action-meta";
import { db } from "./db";

export type ChatSummary = { id: string; title: string; updatedAt: number; pending: number };

/** Approval cards still waiting in a conversation's last assistant message. */
function pendingIn(raw: string) {
  try {
    const msgs = JSON.parse(raw) as UIMessage[];
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "assistant") return 0;
    return last.parts.filter((p) => p.type.startsWith("tool-") && isAction(p.type.slice(5)) && (p as { state?: string }).state === "input-available").length;
  } catch {
    return 0;
  }
}

export function listChats(userId: string, limit = 100): ChatSummary[] {
  return (
    db().prepare("SELECT id, title, messages, updated_at FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?").all(userId, limit) as {
      id: string;
      title: string;
      messages: string;
      updated_at: number;
    }[]
  ).map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at, pending: pendingIn(r.messages) }));
}

export function getChat(userId: string, id: string): { id: string; title: string; messages: UIMessage[]; createdAt: number } | null {
  const row = db().prepare("SELECT id, title, messages, created_at FROM chats WHERE id = ? AND user_id = ?").get(id, userId) as
    | { id: string; title: string; messages: string; created_at: number }
    | undefined;
  if (!row) return null;
  return { id: row.id, title: row.title, messages: JSON.parse(row.messages), createdAt: row.created_at };
}

/** True when the id is free or already belongs to this user. */
export function canWriteChat(userId: string, id: string) {
  const row = db().prepare("SELECT user_id FROM chats WHERE id = ?").get(id) as { user_id: string } | undefined;
  return !row || row.user_id === userId;
}

function titleFrom(messages: UIMessage[]) {
  const first = messages.find((m) => m.role === "user");
  const text = first?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ") ?? "";
  const clean = text.replace(/[`*_#>\[\]]/g, "").replace(/\s+/g, " ").trim();
  return clean.length > 70 ? `${clean.slice(0, 68)}…` : clean || "گفت‌وگوی تازه";
}

export function saveChat(userId: string, id: string, messages: UIMessage[]) {
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO chats (id, user_id, title, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at WHERE chats.user_id = excluded.user_id`,
    )
    .run(id, userId, titleFrom(messages), JSON.stringify(messages), now, now);
}

export function renameChat(userId: string, id: string, title: string) {
  db().prepare("UPDATE chats SET title = ? WHERE id = ? AND user_id = ?").run(title.slice(0, 120), id, userId);
}

export function deleteChat(userId: string, id: string) {
  db().prepare("DELETE FROM chats WHERE id = ? AND user_id = ?").run(id, userId);
}

// ---- per-user model budget (in-process; protects the operator's AI key) ----
const usage = new Map<string, { n: number; reset: number }>();
const LIMIT = Number(process.env.CHAT_REQUESTS_PER_HOUR || 120);

export function takeChatQuota(userId: string) {
  const now = Date.now();
  const u = usage.get(userId);
  if (!u || u.reset < now) {
    usage.set(userId, { n: 1, reset: now + 3600_000 });
    return true;
  }
  return ++u.n <= LIMIT;
}
