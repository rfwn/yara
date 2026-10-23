import "server-only";
import crypto from "node:crypto";
import { decrypt, encrypt } from "./crypto";
import { db } from "./db";

// Append-only record of every change an agent made, was denied, or was blocked from making.
// Arguments and results are stored redacted; rollback snapshots (which may hold real values) are encrypted.

export type Decision = "auto" | "approved" | "denied" | "blocked";
export type Status = "running" | "ok" | "error" | "skipped";

export type AuditEntry = {
  id: string;
  threadId: string | null;
  agent: string;
  tool: string;
  title: string;
  target: string | null;
  risk: string;
  args: unknown;
  decision: Decision;
  reason: string | null;
  status: Status;
  result: unknown;
  verified: boolean | null;
  canRollback: boolean;
  rolledBackBy: string | null;
  createdAt: number;
  finishedAt: number | null;
};

type Row = {
  id: string;
  user_id: string;
  thread_id: string | null;
  agent: string;
  tool: string;
  title: string;
  target: string | null;
  risk: string;
  args_json: string;
  decision: Decision;
  reason: string | null;
  status: Status;
  result_json: string | null;
  verified: number | null;
  rollback_enc: string | null;
  rolled_back_by: string | null;
  created_at: number;
  finished_at: number | null;
};

const SECRET_KEY = /^(value|values|content|newString|oldString|dsn|apiKey|privateKey|sshKeys?)$|pass|secret|token|credential/i;

/** Redacts values that may be secrets or large payloads, keeping the shape readable. */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (typeof v === "string") return v.length > 400 ? `${v.slice(0, 400)}… (${v.length} chars)` : v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "secret") out[k] = x ? "•••• (shown to the user once, not stored)" : x;
      else if (SECRET_KEY.test(k) && typeof x === "string") out[k] = `•••• (${x.length} chars)`;
      else out[k] = redact(x, depth + 1);
    }
    return out;
  }
  return v;
}

export const argsHash = (tool: string, args: unknown) => crypto.createHash("sha256").update(`${tool}:${JSON.stringify(args)}`).digest("hex").slice(0, 24);

const toEntry = (r: Row): AuditEntry => ({
  id: r.id,
  threadId: r.thread_id,
  agent: r.agent,
  tool: r.tool,
  title: r.title,
  target: r.target,
  risk: r.risk,
  args: JSON.parse(r.args_json),
  decision: r.decision,
  reason: r.reason,
  status: r.status,
  result: r.result_json ? JSON.parse(r.result_json) : null,
  verified: r.verified === null ? null : !!r.verified,
  canRollback: !!r.rollback_enc && !r.rolled_back_by && r.status === "ok",
  rolledBackBy: r.rolled_back_by,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

export function auditStart(e: {
  userId: string;
  threadId: string;
  agent: string;
  tool: string;
  title: string;
  target?: string;
  risk: string;
  args: unknown;
  decision: Decision;
  reason?: string;
  status?: Status;
}) {
  const id = `ch_${crypto.randomBytes(6).toString("hex")}`;
  const now = Date.now();
  const done = e.status && e.status !== "running";
  db()
    .prepare(
      `INSERT INTO audit_log (id, user_id, thread_id, agent, tool, title, target, risk, args_json, args_hash, decision, reason, status, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, e.userId, e.threadId, e.agent, e.tool, e.title, e.target ?? null, e.risk, JSON.stringify(redact(e.args)), argsHash(e.tool, e.args), e.decision, e.reason ?? null, e.status ?? "running", now, done ? now : null);
  return id;
}

export function auditFinish(id: string, r: { status: Status; result?: unknown; verified?: boolean | null; rollback?: unknown }) {
  db()
    .prepare("UPDATE audit_log SET status = ?, result_json = ?, verified = ?, rollback_enc = COALESCE(?, rollback_enc), finished_at = ? WHERE id = ?")
    .run(
      r.status,
      r.result === undefined ? null : JSON.stringify(redact(r.result)),
      r.verified === undefined || r.verified === null ? null : r.verified ? 1 : 0,
      r.rollback === undefined || r.rollback === null ? null : encrypt(JSON.stringify(r.rollback)),
      Date.now(),
      id,
    );
}

export function listAudit(userId: string, opts: { limit?: number; threadId?: string } = {}) {
  const rows = opts.threadId
    ? (db().prepare("SELECT * FROM audit_log WHERE user_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, opts.threadId, opts.limit ?? 200) as Row[])
    : (db().prepare("SELECT * FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, opts.limit ?? 200) as Row[]);
  return rows.map(toEntry);
}

export function getAudit(userId: string, id: string) {
  const r = db().prepare("SELECT * FROM audit_log WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
  return r ? toEntry(r) : null;
}

/** The decrypted rollback snapshot of a change, if it has one and was not rolled back yet. */
export function rollbackSnapshot(userId: string, id: string) {
  const r = db().prepare("SELECT rollback_enc, rolled_back_by, status, tool FROM audit_log WHERE id = ? AND user_id = ?").get(id, userId) as
    | Pick<Row, "rollback_enc" | "rolled_back_by" | "status" | "tool">
    | undefined;
  if (!r) return { error: `No change ${id} in your audit log.` };
  if (r.rolled_back_by) return { error: `Change ${id} was already rolled back by ${r.rolled_back_by}.` };
  if (r.status !== "ok" || !r.rollback_enc) return { error: `Change ${id} (${r.tool}) has no rollback point.` };
  const plain = decrypt(r.rollback_enc);
  return plain ? { tool: r.tool, snapshot: JSON.parse(plain) as unknown } : { error: "The rollback point could not be decrypted." };
}

export function markRolledBack(id: string, by: string) {
  db().prepare("UPDATE audit_log SET rolled_back_by = ? WHERE id = ?").run(by, id);
}

/** Changes that actually ran (or are running) in a time window: the basis for rate limits. */
export function countChanges(where: { userId: string; threadId?: string; tool?: string; target?: string }, sinceMs: number) {
  // Auto-run safe commands (builds, tests) are audited but are not changes: a debug session runs many of them.
  const parts = ["user_id = ?", "decision IN ('auto','approved')", "NOT (decision = 'auto' AND tool = 'runCommand')", "status != 'skipped'", "created_at >= ?"];
  const params: unknown[] = [where.userId, Date.now() - sinceMs];
  if (where.threadId) parts.push("thread_id = ?"), params.push(where.threadId);
  if (where.tool) parts.push("tool = ?"), params.push(where.tool);
  if (where.target) parts.push("target = ?"), params.push(where.target);
  return (db().prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${parts.join(" AND ")}`).get(...params) as { n: number }).n;
}

/** How often this exact call already failed in the thread recently. */
export function countFailures(userId: string, threadId: string, tool: string, args: unknown, sinceMs: number) {
  return (
    db()
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND thread_id = ? AND args_hash = ? AND status = 'error' AND created_at >= ?")
      .get(userId, threadId, argsHash(tool, args), Date.now() - sinceMs) as { n: number }
  ).n;
}
