import "server-only";
import crypto from "node:crypto";
import { ACTION_META } from "../action-meta";
import { actions, runAction } from "../actions";
import { decideUnattended, MONITOR_THREAD } from "../agent/policy";
import { createLiaraClient, enc, LiaraError, type LiaraClient, type LiaraCreds, type Project } from "../liara";
import { diagnose, type Cause, type Diagnosis, type HealthStatus } from "../monitor/diagnose";
import { appUrl, gatherEvidence, type Evidence } from "../monitor/evidence";
import { probeUrl, safePath, type Probe } from "../monitor/probe";
import { appPlanOptions, type AppPlan } from "../plans";
import { auditFinish, auditStart } from "./audit";
import { decrypt, encrypt } from "./crypto";
import { db } from "./db";

// The monitoring loop. server.mjs calls /api/monitor/tick every minute; each tick checks the
// monitors that are due, opens and resolves incidents, may auto-heal (only when the user's
// policy allows, only for causes a restart can fix, capped per hour, always verified and audited),
// and runs scheduled routines. Every change it makes goes through the same audit log as the agents.

const MIN = 60_000;
const HOUR = 60 * MIN;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newId = (p: string) => `${p}_${crypto.randomBytes(6).toString("hex")}`;

// ---------- types ----------

export type Monitor = {
  app: string;
  enabled: boolean;
  intervalMin: number;
  path: string;
  autoHeal: boolean;
  lastCheckAt: number | null;
  lastStatus: HealthStatus | null;
  failStreak: number;
  baselineMs: number | null;
};

export type Check = {
  id: number;
  app: string;
  at: number;
  status: HealthStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  cpuPct: number | null;
  memPct: number | null;
  errorLines: number | null;
  summary: string;
  causes: Cause[];
};

export type TimelineEntry = { at: number; kind: "opened" | "update" | "heal" | "skipped" | "escalated" | "resolved" | "note"; text: string; auditId?: string; verified?: boolean };

export type Incident = {
  id: string;
  app: string;
  status: "open" | "resolved";
  severity: "critical" | "warning";
  title: string;
  causes: Cause[];
  timeline: TimelineEntry[];
  healAttempts: number;
  escalated: boolean;
  openedAt: number;
  resolvedAt: number | null;
};

export type RoutineKind = "dbBackup" | "diskBackup" | "restartApp";
export type Routine = {
  id: string;
  kind: RoutineKind;
  target: Record<string, string>;
  label: string;
  hour: number;
  weekday: number | null;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastAuditId: string | null;
};

export type Verification = { verified: boolean; checks: number; probe: Probe | null; appStatus: string | null; note: string };

// ---------- monitors ----------

type MonitorRow = { app: string; enabled: number; interval_min: number; path: string; auto_heal: number; last_check_at: number | null; last_status: HealthStatus | null; fail_streak: number; baseline_ms: number | null };
const toMonitor = (r: MonitorRow): Monitor => ({
  app: r.app,
  enabled: !!r.enabled,
  intervalMin: r.interval_min,
  path: r.path,
  autoHeal: !!r.auto_heal,
  lastCheckAt: r.last_check_at,
  lastStatus: r.last_status,
  failStreak: r.fail_streak,
  baselineMs: r.baseline_ms,
});

export const INTERVALS = [1, 5, 15, 30, 60];

export function listMonitors(userId: string) {
  return (db().prepare("SELECT * FROM monitors WHERE user_id = ? ORDER BY app").all(userId) as MonitorRow[]).map(toMonitor);
}

export function getMonitor(userId: string, app: string) {
  const r = db().prepare("SELECT * FROM monitors WHERE user_id = ? AND app = ?").get(userId, app) as MonitorRow | undefined;
  return r ? toMonitor(r) : null;
}

export function upsertMonitor(userId: string, app: string, patch: { enabled?: boolean; intervalMin?: number; path?: string; autoHeal?: boolean }) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(app)) throw new Error("Invalid app name.");
  const cur = getMonitor(userId, app);
  const interval = patch.intervalMin ?? cur?.intervalMin ?? 5;
  if (!INTERVALS.includes(interval)) throw new Error(`Interval must be one of ${INTERVALS.join(", ")} minutes.`);
  const next = {
    enabled: patch.enabled ?? cur?.enabled ?? true,
    intervalMin: interval,
    path: patch.path !== undefined ? safePath(patch.path) : (cur?.path ?? "/"),
    autoHeal: patch.autoHeal ?? cur?.autoHeal ?? true,
  };
  db()
    .prepare(
      `INSERT INTO monitors (user_id, app, enabled, interval_min, path, auto_heal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, app) DO UPDATE SET enabled = excluded.enabled, interval_min = excluded.interval_min, path = excluded.path, auto_heal = excluded.auto_heal`,
    )
    .run(userId, app, next.enabled ? 1 : 0, next.intervalMin, next.path, next.autoHeal ? 1 : 0, Date.now());
  return getMonitor(userId, app)!;
}

export function deleteMonitor(userId: string, app: string) {
  db().prepare("DELETE FROM monitors WHERE user_id = ? AND app = ?").run(userId, app);
}

// ---------- checks ----------

type CheckRow = { id: number; app: string; at: number; status: HealthStatus; http_status: number | null; latency_ms: number | null; cpu_pct: number | null; mem_pct: number | null; error_lines: number | null; summary: string; causes_json: string };
const toCheck = (r: CheckRow): Check => ({
  id: r.id,
  app: r.app,
  at: r.at,
  status: r.status,
  httpStatus: r.http_status,
  latencyMs: r.latency_ms,
  cpuPct: r.cpu_pct,
  memPct: r.mem_pct,
  errorLines: r.error_lines,
  summary: r.summary,
  causes: JSON.parse(r.causes_json),
});

/** The latest `limit` checks of an app, oldest first (for sparklines). */
export function recentChecks(userId: string, app: string, limit = 30) {
  const rows = db().prepare("SELECT * FROM health_checks WHERE user_id = ? AND app = ? ORDER BY at DESC LIMIT ?").all(userId, app, limit) as CheckRow[];
  return rows.reverse().map(toCheck);
}

/** Share of healthy checks over a window, for the uptime figure. */
export function uptime(userId: string, app: string, sinceMs = 24 * HOUR) {
  const r = db()
    .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('healthy','degraded') THEN 1 ELSE 0 END) AS up FROM health_checks WHERE user_id = ? AND app = ? AND at >= ? AND status != 'off'")
    .get(userId, app, Date.now() - sinceMs) as { n: number; up: number | null };
  return r.n ? Math.round(((r.up ?? 0) / r.n) * 1000) / 10 : null;
}

function recordCheck(userId: string, ev: Evidence | null, d: Diagnosis) {
  const p = ev?.probe;
  const pct = (v: number | undefined, max: number | null) => (v !== undefined && max ? Math.round((v / max) * 100) : null);
  const info = db()
    .prepare(
      "INSERT INTO health_checks (user_id, app, at, status, http_status, latency_ms, cpu_pct, mem_pct, error_lines, summary, causes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      userId,
      ev?.app ?? "",
      Date.now(),
      d.status,
      p?.status ?? null,
      p ? p.ms : null,
      pct(ev?.cpu?.last, ev?.cpuLimit ?? null),
      pct(ev?.memory?.last, ev?.memLimit ?? null),
      ev?.logs?.errorLines ?? null,
      d.summary,
      JSON.stringify(d.causes),
    );
  return Number(info.lastInsertRowid);
}

// ---------- incidents ----------

type IncidentRow = { id: string; app: string; status: "open" | "resolved"; severity: "critical" | "warning"; title: string; causes_json: string; timeline_json: string; heal_attempts: number; escalated: number; opened_at: number; resolved_at: number | null };
const toIncident = (r: IncidentRow): Incident => ({
  id: r.id,
  app: r.app,
  status: r.status,
  severity: r.severity,
  title: r.title,
  causes: JSON.parse(r.causes_json),
  timeline: JSON.parse(r.timeline_json),
  healAttempts: r.heal_attempts,
  escalated: !!r.escalated,
  openedAt: r.opened_at,
  resolvedAt: r.resolved_at,
});

export function listIncidents(userId: string, opts: { app?: string; limit?: number } = {}) {
  const rows = opts.app
    ? (db().prepare("SELECT * FROM incidents WHERE user_id = ? AND app = ? ORDER BY status = 'open' DESC, opened_at DESC LIMIT ?").all(userId, opts.app, opts.limit ?? 30) as IncidentRow[])
    : (db().prepare("SELECT * FROM incidents WHERE user_id = ? ORDER BY status = 'open' DESC, opened_at DESC LIMIT ?").all(userId, opts.limit ?? 30) as IncidentRow[]);
  return rows.map(toIncident);
}

export const openIncidentCount = (userId: string) => (db().prepare("SELECT COUNT(*) AS n FROM incidents WHERE user_id = ? AND status = 'open'").get(userId) as { n: number }).n;

const openIncident = (userId: string, app: string) => {
  const r = db().prepare("SELECT * FROM incidents WHERE user_id = ? AND app = ? AND status = 'open'").get(userId, app) as IncidentRow | undefined;
  return r ? toIncident(r) : null;
};

function saveIncident(userId: string, i: Incident) {
  db()
    .prepare(
      `INSERT INTO incidents (id, user_id, app, status, severity, title, causes_json, timeline_json, heal_attempts, escalated, opened_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, severity = excluded.severity, title = excluded.title, causes_json = excluded.causes_json,
         timeline_json = excluded.timeline_json, heal_attempts = excluded.heal_attempts, escalated = excluded.escalated, resolved_at = excluded.resolved_at`,
    )
    .run(i.id, userId, i.app, i.status, i.severity, i.title, JSON.stringify(i.causes), JSON.stringify(i.timeline.slice(-60)), i.healAttempts, i.escalated ? 1 : 0, i.openedAt, i.resolvedAt);
}

const push = (i: Incident, e: Omit<TimelineEntry, "at">) => i.timeline.push({ at: Date.now(), ...e });

export function resolveIncidentByUser(userId: string, id: string) {
  const r = db().prepare("SELECT * FROM incidents WHERE id = ? AND user_id = ?").get(id, userId) as IncidentRow | undefined;
  if (!r) throw new Error("Incident not found.");
  const i = toIncident(r);
  if (i.status === "resolved") return i;
  i.status = "resolved";
  i.resolvedAt = Date.now();
  push(i, { kind: "resolved", text: "کاربر حادثه را بست." });
  saveIncident(userId, i);
  return i;
}

// ---------- verification ----------

/**
 * Proves an app is serving again after a change: waits for it to settle, then needs two healthy
 * probes in a row (or a running status when the app has no public URL) within the time limit.
 */
export async function verifyAppHealth(c: LiaraClient, app: string, opts: { path?: string; timeoutMs?: number; settleMs?: number } = {}): Promise<Verification> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  await sleep(opts.settleMs ?? 8_000);
  let streak = 0;
  let checks = 0;
  let probe: Probe | null = null;
  let status: string | null = null;
  while (Date.now() < deadline) {
    checks++;
    try {
      const { project: p } = await c.get<{ project: Project }>(`/v1/projects/${enc(app)}`);
      status = p.status;
      if (p.scale === 0) return { verified: false, checks, probe, appStatus: status, note: "The app is turned off." };
      const url = await appUrl(c, p, opts.path);
      if (url) {
        probe = await probeUrl(url);
        streak = probe.ok ? streak + 1 : 0;
      } else streak = /run|active|ok|healthy/i.test(p.status) ? streak + 1 : 0;
    } catch {
      streak = 0;
    }
    if (streak >= 2)
      return {
        verified: true,
        checks,
        probe,
        appStatus: status,
        note: probe ? `Serving again: HTTP ${probe.status} in ${probe.ms} ms on two consecutive checks.` : "No public URL to probe; the app reports a running status on two consecutive checks.",
      };
    await sleep(8_000);
  }
  return {
    verified: false,
    checks,
    probe,
    appStatus: status,
    note: probe ? `Still failing after ${checks} checks: ${probe.status ? `HTTP ${probe.status}` : probe.error}.` : `Not healthy after ${checks} checks (status ${status ?? "unknown"}).`,
  };
}

// ---------- the check ----------

export type CheckResult = { check: Check; diagnosis: Diagnosis; evidence: Evidence | null; incident: Incident | null };

/** Runs one health check, records it, and moves the incident state machine. */
export async function checkApp(userId: string, c: LiaraClient, app: string, opts: { plans?: AppPlan[] | null; manual?: boolean } = {}): Promise<CheckResult> {
  const m = getMonitor(userId, app) ?? upsertMonitor(userId, app, { enabled: false });
  let ev: Evidence | null = null;
  let d: Diagnosis;
  try {
    ev = await gatherEvidence(c, app, { path: m.path, plans: opts.plans });
    d = diagnose(ev, { baselineMs: m.baselineMs });
  } catch (e) {
    if (e instanceof LiaraError && e.status === 404) {
      upsertMonitor(userId, app, { enabled: false });
      d = { status: "unknown", summary: "این برنامه در حساب لیارا پیدا نشد؛ پایش آن خاموش شد.", causes: [] };
    } else d = { status: "unknown", summary: `داده‌ها از API لیارا خوانده نشد: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`, causes: [] };
  }
  const checkId = recordCheck(userId, ev ?? ({ app } as Evidence), d);

  // Learned latency baseline (EWMA of healthy checks) makes "slow" relative to this app.
  const bad = d.status === "down" || d.status === "degraded";
  const ms = ev?.probe?.ok ? ev.probe.ms : null;
  const baseline = d.status === "healthy" && ms !== null ? Math.round(m.baselineMs ? m.baselineMs * 0.8 + ms * 0.2 : ms) : m.baselineMs;
  const streak = bad ? m.failStreak + 1 : d.status === "unknown" ? m.failStreak : 0;
  db().prepare("UPDATE monitors SET last_check_at = ?, last_status = ?, fail_streak = ?, baseline_ms = ? WHERE user_id = ? AND app = ?").run(Date.now(), d.status, streak, baseline, userId, app);

  // Debounce: one bad probe is noise; a person asking for a check sees it immediately.
  const threshold = opts.manual ? 1 : d.status === "down" ? 2 : 3;
  let inc = openIncident(userId, app);

  if (bad && !inc && streak >= threshold) {
    inc = {
      id: newId("inc"),
      app,
      status: "open",
      severity: d.status === "down" ? "critical" : "warning",
      title: d.summary,
      causes: d.causes,
      timeline: [],
      healAttempts: 0,
      escalated: false,
      openedAt: Date.now(),
      resolvedAt: null,
    };
    push(inc, { kind: "opened", text: d.summary });
    saveIncident(userId, inc);
    void notify(userId, { event: "incident.opened", app, status: d.status, text: `⚠️ ${app}: ${d.summary}`, incidentId: inc.id });
  } else if (bad && inc) {
    const wasCritical = inc.severity === "critical";
    inc.causes = d.causes;
    if (d.status === "down") inc.severity = "critical";
    if (inc.title !== d.summary) {
      inc.title = d.summary;
      push(inc, { kind: "update", text: d.summary });
    }
    saveIncident(userId, inc);
    if (!wasCritical && inc.severity === "critical") void notify(userId, { event: "incident.escalated", app, status: d.status, text: `🔴 ${app}: ${d.summary}`, incidentId: inc.id });
  } else if (inc && (d.status === "healthy" || d.status === "off")) {
    inc.status = "resolved";
    inc.resolvedAt = Date.now();
    const mins = Math.max(1, Math.round((inc.resolvedAt - inc.openedAt) / MIN));
    push(inc, { kind: "resolved", text: d.status === "off" ? "برنامه خاموش شد؛ حادثه بسته شد." : `برنامه دوباره سالم است (پس از ${mins.toLocaleString("fa-IR")} دقیقه).` });
    saveIncident(userId, inc);
    void notify(userId, { event: "incident.resolved", app, status: d.status, text: `✅ ${app}: ${d.status === "off" ? "turned off" : `recovered after ${mins} min`}`, incidentId: inc.id });
  }

  if (inc?.status === "open" && d.status === "down") inc = await maybeHeal(userId, c, m, inc, d);
  return { check: toCheck(db().prepare("SELECT * FROM health_checks WHERE id = ?").get(checkId) as CheckRow), diagnosis: d, evidence: ev, incident: inc };
}

/**
 * Auto-heal: a restart, only when the top cause is one a restart fixes (a stuck process, an OOM kill),
 * only when the policy and this monitor allow it, capped per hour. Always audited and verified;
 * when it does not work or the cap is hit, the monitor stops and hands the problem to the user.
 */
async function maybeHeal(userId: string, c: LiaraClient, m: Monitor, inc: Incident, d: Diagnosis): Promise<Incident> {
  const top = d.causes[0];
  const already = (text: string) => inc.timeline.some((t) => t.text === text);
  if (!top?.autoHeal) {
    const text = top ? `بازیابی خودکار انجام نشد: علت محتمل («${top.title}») با ری‌استارت رفع نمی‌شود.` : "بازیابی خودکار انجام نشد: علت مشخص نیست.";
    if (!already(text)) push(inc, { kind: "skipped", text }), saveIncident(userId, inc);
    return inc;
  }
  if (!m.autoHeal) {
    const text = "بازیابی خودکار برای این برنامه خاموش است؛ فقط گزارش داده می‌شود.";
    if (!already(text)) push(inc, { kind: "skipped", text }), saveIncident(userId, inc);
    return inc;
  }
  const verdict = decideUnattended(userId, "autoHeal", top.autoHeal, m.app);
  if (verdict.mode === "block") {
    const capped = /automatic/.test(verdict.reason);
    const why = /Read-only/.test(verdict.reason)
      ? "حالت «فقط خواندن» روشن است."
      : /Auto-heal is off/.test(verdict.reason)
        ? "ترمیم خودکار در تنظیمات «اجازه‌های یارا» خاموش است؛ فقط گزارش داده می‌شود."
        : /Account limit/.test(verdict.reason)
          ? "سقف تغییرات حساب در این ساعت پر شده است."
          : verdict.reason;
    const text = capped ? "سقف بازیابی خودکار در این ساعت پر شد؛ ری‌استارت بیشتر مشکل را پنهان می‌کند. نیاز به بررسی شماست." : `بازیابی خودکار انجام نشد: ${why}`;
    if (!already(text)) {
      push(inc, { kind: capped ? "escalated" : "skipped", text });
      if (capped && !inc.escalated) {
        inc.escalated = true;
        void notify(userId, { event: "incident.needs_user", app: m.app, status: d.status, text: `🆘 ${m.app}: auto-heal limit reached, needs you. ${d.summary}`, incidentId: inc.id });
      }
      saveIncident(userId, inc);
    }
    return inc;
  }

  const meta = ACTION_META[top.autoHeal];
  const auditId = auditStart({
    userId,
    threadId: MONITOR_THREAD,
    agent: "monitor",
    tool: top.autoHeal,
    title: meta?.label ?? top.autoHeal,
    target: m.app,
    risk: meta?.risk ?? "low",
    args: { app: m.app, incident: inc.id, cause: top.id },
    decision: "auto",
    reason: `${verdict.reason} Incident ${inc.id}: ${top.title}.`,
  });
  inc.healAttempts++;
  push(inc, { kind: "heal", text: `ری‌استارت خودکار به‌خاطر «${top.title}» (تلاش ${inc.healAttempts.toLocaleString("fa-IR")})…`, auditId });
  saveIncident(userId, inc);
  try {
    await actions.restartApp.run(c, { app: m.app });
    const v = await verifyAppHealth(c, m.app, { path: m.path });
    auditFinish(auditId, { status: "ok", result: { verification: v }, verified: v.verified });
    inc = openIncident(userId, m.app) ?? inc;
    push(inc, { kind: "heal", text: v.verified ? "پس از ری‌استارت، سلامت برنامه تأیید شد." : `ری‌استارت انجام شد ولی برنامه برنگشت: ${v.note}`, auditId, verified: v.verified });
    if (v.verified) {
      inc.status = "resolved";
      inc.resolvedAt = Date.now();
      push(inc, { kind: "resolved", text: "با بازیابی خودکار برطرف شد. علت ریشه‌ای را بررسی کنید تا تکرار نشود." });
      void notify(userId, { event: "incident.auto_healed", app: m.app, status: "healthy", text: `🔧 ${m.app}: restarted automatically and verified healthy. Root cause: ${top.title}`, incidentId: inc.id });
      db().prepare("UPDATE monitors SET fail_streak = 0, last_status = 'healthy' WHERE user_id = ? AND app = ?").run(userId, m.app);
    }
  } catch (e) {
    auditFinish(auditId, { status: "error", result: { error: e instanceof Error ? e.message : String(e) } });
    push(inc, { kind: "heal", text: `ری‌استارت خودکار خطا داد: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`, auditId, verified: false });
  }
  saveIncident(userId, inc);
  return inc;
}

// ---------- routines ----------

const TEHRAN_OFFSET = 3.5 * HOUR; // Iran has had no DST since 2022.
export const ROUTINE_TOOL: Record<RoutineKind, "createDatabaseBackup" | "createDiskBackup" | "restartApp"> = {
  dbBackup: "createDatabaseBackup",
  diskBackup: "createDiskBackup",
  restartApp: "restartApp",
};

/** Next run at `hour`:00 Tehran time (on `weekday`, 0 = Sunday, if set), strictly after `from`. */
export function nextRun(hour: number, weekday: number | null, from = Date.now()) {
  const local = new Date(from + TEHRAN_OFFSET);
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, 0, 0));
  if (d.getTime() <= local.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  if (weekday !== null) while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime() - TEHRAN_OFFSET;
}

type RoutineRow = { id: string; user_id: string; kind: RoutineKind; target_json: string; label: string; hour: number; weekday: number | null; enabled: number; next_run_at: number; last_run_at: number | null; last_status: string | null; last_audit_id: string | null };
const toRoutine = (r: RoutineRow): Routine => ({
  id: r.id,
  kind: r.kind,
  target: JSON.parse(r.target_json),
  label: r.label,
  hour: r.hour,
  weekday: r.weekday,
  enabled: !!r.enabled,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  lastStatus: r.last_status,
  lastAuditId: r.last_audit_id,
});

export const listRoutines = (userId: string) => (db().prepare("SELECT * FROM routines WHERE user_id = ? ORDER BY created_at").all(userId) as RoutineRow[]).map(toRoutine);

export function createRoutine(userId: string, input: { kind: RoutineKind; target: Record<string, string>; hour: number; weekday?: number | null }) {
  if (!(input.kind in ROUTINE_TOOL)) throw new Error("Unknown routine kind.");
  const hour = Math.round(input.hour);
  const weekday = input.weekday === undefined || input.weekday === null ? null : Math.round(input.weekday);
  if (!(hour >= 0 && hour <= 23)) throw new Error("Hour must be 0–23 (Tehran time).");
  if (weekday !== null && !(weekday >= 0 && weekday <= 6)) throw new Error("Weekday must be 0–6 (0 = Sunday).");
  const t = input.target ?? {};
  let target: Record<string, string>;
  let label: string;
  if (input.kind === "dbBackup") {
    if (!t.databaseId) throw new Error("databaseId is required.");
    target = { databaseId: String(t.databaseId), name: String(t.name ?? t.databaseId) };
    label = `پشتیبان دیتابیس ${target.name}`;
  } else if (input.kind === "diskBackup") {
    if (!t.app || !t.disk) throw new Error("app and disk are required.");
    target = { app: String(t.app), disk: String(t.disk) };
    label = `پشتیبان دیسک ${target.disk} (${target.app})`;
  } else {
    if (!t.app) throw new Error("app is required.");
    target = { app: String(t.app) };
    label = `ری‌استارت ${target.app}`;
  }
  if ((db().prepare("SELECT COUNT(*) AS n FROM routines WHERE user_id = ?").get(userId) as { n: number }).n >= 20) throw new Error("At most 20 routines per account.");
  const id = newId("rt");
  db()
    .prepare("INSERT INTO routines (id, user_id, kind, target_json, label, hour, weekday, enabled, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
    .run(id, userId, input.kind, JSON.stringify(target), label, hour, weekday, nextRun(hour, weekday), Date.now());
  return toRoutine(db().prepare("SELECT * FROM routines WHERE id = ?").get(id) as RoutineRow);
}

export function setRoutineEnabled(userId: string, id: string, enabled: boolean) {
  const r = db().prepare("SELECT * FROM routines WHERE id = ? AND user_id = ?").get(id, userId) as RoutineRow | undefined;
  if (!r) throw new Error("Routine not found.");
  db().prepare("UPDATE routines SET enabled = ?, next_run_at = ? WHERE id = ?").run(enabled ? 1 : 0, nextRun(r.hour, r.weekday), id);
}

export const deleteRoutine = (userId: string, id: string) => db().prepare("DELETE FROM routines WHERE id = ? AND user_id = ?").run(id, userId);

/** Runs one routine through the policy and the audit log. `manual` = the user pressed "run now". */
export async function runRoutine(userId: string, c: LiaraClient, r: Routine, manual = false) {
  const tool = ROUTINE_TOOL[r.kind];
  const target = r.target.app ?? r.target.name ?? r.target.databaseId;
  const args = r.kind === "dbBackup" ? { databaseId: r.target.databaseId } : r.kind === "diskBackup" ? { app: r.target.app, disk: r.target.disk } : { app: r.target.app };
  const verdict = manual ? ({ mode: "auto", reason: "Run now, requested by the user from the Monitoring page." } as const) : decideUnattended(userId, "routine", tool, target);
  const base = { userId, threadId: MONITOR_THREAD, agent: "monitor", tool, title: `${ACTION_META[tool]?.label ?? tool} (زمان‌بندی‌شده)`, target, risk: ACTION_META[tool]?.risk ?? "low", args: { ...args, routine: r.id } };
  let status: string;
  let auditId: string;
  if (verdict.mode === "block") {
    auditId = auditStart({ ...base, decision: "blocked", reason: verdict.reason, status: "skipped" });
    status = "blocked";
  } else {
    auditId = auditStart({ ...base, decision: manual ? "approved" : "auto", reason: `${verdict.reason} Routine ${r.id} («${r.label}»).` });
    try {
      const result = await runAction(c, tool, args);
      const verification = tool === "restartApp" ? await verifyAppHealth(c, r.target.app) : null;
      auditFinish(auditId, { status: "ok", result: verification ? { result, verification } : result, verified: verification ? verification.verified : null });
      status = verification && !verification.verified ? "unverified" : "ok";
    } catch (e) {
      auditFinish(auditId, { status: "error", result: { error: e instanceof Error ? e.message : String(e) } });
      status = "error";
    }
  }
  db().prepare("UPDATE routines SET last_run_at = ?, last_status = ?, last_audit_id = ?, next_run_at = ? WHERE id = ?").run(Date.now(), status, auditId, nextRun(r.hour, r.weekday), r.id);
  if (status !== "ok") void notify(userId, { event: "routine.failed", app: target, status, text: `⏱️ Routine "${r.label}" ${status}. See the audit log (${auditId}).` });
  return { status, auditId };
}

// ---------- alerts ----------

export function setWebhook(userId: string, url: string | null) {
  if (url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error("Invalid URL.");
    }
    if (u.protocol !== "https:" || url.length > 500) throw new Error("The webhook must be an https:// URL (at most 500 characters).");
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(u.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) throw new Error("Private and local addresses are not allowed.");
  }
  db().prepare("UPDATE users SET alert_webhook_enc = ? WHERE id = ?").run(url ? encrypt(url) : null, userId);
}

export const hasWebhook = (userId: string) => !!(db().prepare("SELECT alert_webhook_enc FROM users WHERE id = ?").get(userId) as { alert_webhook_enc: string | null } | undefined)?.alert_webhook_enc;

/** Posts an alert to the user's webhook (Slack/Mattermost read `text`, Discord reads `content`). Best effort. */
export async function notify(userId: string, alert: { event: string; app: string; status: string; text: string; incidentId?: string }) {
  const row = db().prepare("SELECT alert_webhook_enc FROM users WHERE id = ?").get(userId) as { alert_webhook_enc: string | null } | undefined;
  const url = row?.alert_webhook_enc ? decrypt(row.alert_webhook_enc) : null;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Yara-Monitor/1.0" },
      body: JSON.stringify({ ...alert, content: alert.text, at: new Date().toISOString(), source: "yara" }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------- the tick ----------

export function credsFor(userId: string): LiaraCreds | null {
  const r = db().prepare("SELECT liara_token_enc, team_id FROM users WHERE id = ?").get(userId) as { liara_token_enc: string | null; team_id: string | null } | undefined;
  const token = r?.liara_token_enc ? decrypt(r.liara_token_enc) : null;
  return token ? { token, teamID: r?.team_id ?? undefined } : null;
}

const g = globalThis as unknown as { __yaraMonitorBusy?: boolean; __yaraMonitorTicks?: number };

/** One pass of the loop. Overlapping ticks are skipped, so a slow heal never doubles up. */
export async function runTick() {
  if (g.__yaraMonitorBusy) return { skipped: true };
  g.__yaraMonitorBusy = true;
  const now = Date.now();
  let checked = 0;
  let routinesRun = 0;
  try {
    const due = db()
      .prepare("SELECT user_id, app FROM monitors WHERE enabled = 1 AND (last_check_at IS NULL OR last_check_at + interval_min * 60000 <= ?) ORDER BY last_check_at")
      .all(now + 5_000) as { user_id: string; app: string }[];
    const byUser = new Map<string, string[]>();
    for (const d of due) byUser.set(d.user_id, [...(byUser.get(d.user_id) ?? []), d.app]);

    for (const [userId, apps] of byUser) {
      const creds = credsFor(userId);
      if (!creds) continue;
      const c = createLiaraClient(creds);
      const plans = await appPlanOptions(c)
        .then((x) => x.appPlans)
        .catch(() => null);
      // A few apps at a time per user keeps us well inside Liara's rate limits.
      for (let i = 0; i < apps.length; i += 3) {
        await Promise.all(apps.slice(i, i + 3).map((app) => checkApp(userId, c, app, { plans }).catch((e) => console.error(`[monitor] ${app}:`, e))));
        checked += Math.min(3, apps.length - i);
      }
    }

    const routines = db().prepare("SELECT * FROM routines WHERE enabled = 1 AND next_run_at <= ?").all(now) as RoutineRow[];
    for (const r of routines) {
      const creds = credsFor(r.user_id);
      if (!creds) continue;
      await runRoutine(r.user_id, createLiaraClient(creds), toRoutine(r)).catch((e) => console.error(`[routine] ${r.id}:`, e));
      routinesRun++;
    }

    // Keep a week of checks.
    g.__yaraMonitorTicks = (g.__yaraMonitorTicks ?? 0) + 1;
    if (g.__yaraMonitorTicks % 60 === 1) db().prepare("DELETE FROM health_checks WHERE at < ?").run(now - 7 * 24 * HOUR);
  } finally {
    g.__yaraMonitorBusy = false;
  }
  return { checked, routinesRun };
}
