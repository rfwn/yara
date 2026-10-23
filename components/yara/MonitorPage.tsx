"use client";

import { Activity, BellRing, CalendarClock, Check, ChevronDown, CircleAlert, LoaderCircle, Play, RefreshCw, ShieldAlert, Trash2, Wrench, X } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { faDigits, faTime, relativeFa } from "@/lib/fa";
import { CauseList, FixButton, fixRequest, HEALTH, HealthPill, type Cause, type HealthStatus } from "./Health";
import { Skeleton, useDetail } from "./ResourcePages";
import { useWorkbench } from "./Workbench";

type Status = HealthStatus;
type Check = { id: number; at: number; status: Status; httpStatus: number | null; latencyMs: number | null; cpuPct: number | null; memPct: number | null; errorLines: number | null; summary: string; causes: Cause[] };
type Monitor = { app: string; enabled: boolean; intervalMin: number; path: string; autoHeal: boolean; lastCheckAt: number | null; lastStatus: Status | null; baselineMs: number | null };
type Row = { app: { name: string; platform: string; on: boolean; missing?: boolean }; monitor: Monitor | null; checks: Check[]; uptime24h: number | null };
type Timeline = { at: number; kind: string; text: string; auditId?: string; verified?: boolean };
type Incident = { id: string; app: string; status: "open" | "resolved"; severity: "critical" | "warning"; title: string; causes: Cause[]; timeline: Timeline[]; healAttempts: number; escalated: boolean; openedAt: number; resolvedAt: number | null };
type Routine = { id: string; kind: "dbBackup" | "diskBackup" | "restartApp"; target: Record<string, string>; label: string; hour: number; weekday: number | null; enabled: boolean; nextRunAt: number; lastRunAt: number | null; lastStatus: string | null; lastAuditId: string | null };
type Data = {
  rows: Row[];
  appsError: string | null;
  incidents: Incident[];
  routines: Routine[];
  webhook: boolean;
  policy: { autoHeal: boolean; maxAutoHealsPerAppHour: number; allowRoutines: boolean; readOnly: boolean };
  intervals: number[];
};

const DAYS = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];
const ROUTINE_KIND = { dbBackup: "پشتیبان دیتابیس", diskBackup: "پشتیبان دیسک", restartApp: "ری‌استارت برنامه" } as const;

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error ?? "انجام نشد.");
  return d;
}

/** The last checks as a status strip: colour = health, height = latency against the app's own range. */
function HealthStrip({ checks }: { checks: Check[] }) {
  if (!checks.length) return <span className="faint small">هنوز بررسی نشده</span>;
  const ms = checks.map((c) => c.latencyMs ?? 0);
  const max = Math.max(...ms, 1);
  const bad = checks.filter((c) => c.status === "down" || c.status === "degraded").length;
  return (
    <span className="mon-strip" role="img" aria-label={`${faDigits(checks.length)} بررسی اخیر، ${bad ? `${faDigits(bad)} مورد با مشکل` : "همه سالم"}`} dir="ltr">
      {checks.map((c) => (
        <i
          key={c.id}
          data-status={c.status}
          style={{ height: `${Math.max(25, ((c.latencyMs ?? max * 0.5) / max) * 100)}%` }}
          title={`${faTime(c.at)} · ${HEALTH[c.status].label}${c.latencyMs != null ? ` · ${c.latencyMs} ms` : ""}${c.httpStatus ? ` · HTTP ${c.httpStatus}` : ""}`}
        />
      ))}
    </span>
  );
}

function IncidentCard({ inc, onChange }: { inc: Incident; onChange: () => void }) {
  const wb = useWorkbench();
  const [busy, setBusy] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const open = inc.status === "open";
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
    } finally {
      setBusy("");
      setConfirmClose(false);
      onChange();
      wb.refreshHealth();
    }
  };
  return (
    <article className="inc-card" data-severity={inc.severity} data-open={open || undefined}>
      <header>
        <span className={`pill ${open ? (inc.severity === "critical" ? "pill-danger" : "pill-warn") : "pill-ok"}`}>
          {open ? (inc.severity === "critical" ? <ShieldAlert size={12} aria-hidden /> : <CircleAlert size={12} aria-hidden />) : <Check size={12} aria-hidden />}
          {open ? (inc.severity === "critical" ? "از دسترس خارج" : "مشکل‌دار") : "برطرف شد"}
        </span>
        <Link href={`/app/apps/${encodeURIComponent(inc.app)}`} className="ltr inc-app">
          {inc.app}
        </Link>
        {inc.escalated && open && <span className="pill pill-danger">نیاز به شما</span>}
        <span className="faint small" title={faTime(inc.openedAt)} style={{ marginInlineStart: "auto" }}>
          {relativeFa(inc.openedAt)}
          {inc.resolvedAt && ` · طول کشید ${faDigits(Math.max(1, Math.round((inc.resolvedAt - inc.openedAt) / 60000)))} دقیقه`}
        </span>
      </header>
      <p className="inc-title">{inc.title}</p>
      {open && <CauseList causes={inc.causes} limit={3} />}
      <details className="inc-timeline" open={open}>
        <summary className="small muted">چه اتفاقی افتاد ({faDigits(inc.timeline.length)})</summary>
        <ol>
          {inc.timeline.map((t, i) => (
            <li key={i} data-kind={t.kind}>
              <span className="faint small num">{faTime(t.at)}</span>
              <span dir="auto">{t.text}</span>
              {t.verified === true && <span className="pill pill-ok">تأیید شد</span>}
              {t.verified === false && <span className="pill pill-warn">تأیید نشد</span>}
              {t.auditId && (
                <a className="audit-ref ltr" href="/app/audit">
                  {t.auditId}
                </a>
              )}
            </li>
          ))}
        </ol>
      </details>
      {open && (
        <div className="toolbar">
          <FixButton
            onClick={() => {
              const r = fixRequest(inc.app, inc.title, inc.causes, inc.id);
              wb.askYara(r.text, true, r.context);
            }}
          />
          <button type="button" className="btn" disabled={!!busy} onClick={() => act("check", () => send("/api/monitor/check", "POST", { app: inc.app }))}>
            {busy === "check" ? <LoaderCircle size={14} className="spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />} بررسی دوباره
          </button>
          {confirmClose ? (
            <span className="confirm-inline">
              حادثه بسته شود؟ پایش ادامه دارد.
              <button type="button" className="btn btn-primary" style={{ height: 26 }} disabled={!!busy} onClick={() => act("close", () => send(`/api/monitor/incidents/${inc.id}`, "POST"))}>
                بله
              </button>
              <button type="button" className="btn btn-ghost" style={{ height: 26 }} onClick={() => setConfirmClose(false)}>
                نه
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => setConfirmClose(true)}>
              <X size={14} aria-hidden /> بستن
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function AppRow({ row, intervals, policyAutoHeal, onChange }: { row: Row; intervals: number[]; policyAutoHeal: boolean; onChange: () => void }) {
  const wb = useWorkbench();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ diagnosis: { status: Status; summary: string; causes: Cause[] } } | null>(null);
  const m = row.monitor;
  const last = row.checks[row.checks.length - 1];
  const status = (last?.status ?? (row.app.on ? "unknown" : "off")) as Status;
  const save = async (patch: Partial<Monitor>) => {
    setErr("");
    try {
      await send("/api/monitor", "POST", { app: row.app.name, ...patch });
      onChange();
      wb.refreshHealth();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const checkNow = async () => {
    setBusy(true);
    setErr("");
    try {
      setResult(await send("/api/monitor/check", "POST", { app: row.app.name }));
      onChange();
      wb.refreshHealth();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Fragment>
      <tr data-watched={m?.enabled || undefined}>
        <td data-label="برنامه">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span className={`dot ${HEALTH[status].dot}`} aria-hidden />
            <Link href={`/app/apps/${encodeURIComponent(row.app.name)}`} className="ltr row-link">
              {row.app.name}
            </Link>
          </span>
          {row.app.missing && <div className="faint small">در حساب پیدا نشد</div>}
        </td>
        <td data-label="وضعیت">
          <HealthPill status={status} />
          {last && (
            <div className="faint small" title={faTime(last.at)} style={{ marginTop: 4 }}>
              {relativeFa(last.at)}
            </div>
          )}
        </td>
        <td data-label="بررسی‌های اخیر">
          <HealthStrip checks={row.checks} />
        </td>
        <td data-label="پاسخ و منابع" className="num small">
          {last?.latencyMs != null ? (
            <div>
              <span className="ltr" dir="ltr">
                {faDigits(last.latencyMs)} ms{last.httpStatus ? ` · HTTP ${faDigits(last.httpStatus)}` : ""}
              </span>
              {m?.baselineMs != null && <span className="faint"> (معمول {faDigits(m.baselineMs)})</span>}
            </div>
          ) : (
            <div className="faint">–</div>
          )}
          {(last?.cpuPct != null || last?.memPct != null) && (
            <div className="faint">
              پردازنده {faDigits(last?.cpuPct ?? "–")}٪ · حافظه {faDigits(last?.memPct ?? "–")}٪ پلن
            </div>
          )}
        </td>
        <td data-label="در دسترس (۲۴ ساعت)" className="num small">
          {row.uptime24h != null ? `${faDigits(row.uptime24h)}٪` : <span className="faint">–</span>}
        </td>
        <td data-label="پایش">
          <input type="checkbox" className="switch" checked={!!m?.enabled} onChange={(e) => save({ enabled: e.target.checked })} aria-label={`پایش ${row.app.name}`} />
        </td>
        <td className="mon-row-actions">
          <button type="button" className="btn btn-ghost" style={{ height: 28 }} disabled={busy || !row.app.on} onClick={checkNow} title="همین حالا بررسی کن">
            {busy ? <LoaderCircle size={13} className="spin" aria-hidden /> : <Activity size={13} aria-hidden />} بررسی
          </button>
          <button type="button" className="icon-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)} aria-label={`تنظیمات پایش ${row.app.name}`} title="تنظیمات">
            <ChevronDown size={15} aria-hidden style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 160ms var(--ease)" }} />
          </button>
        </td>
      </tr>
      {open && (
        <tr className="audit-detail">
          <td colSpan={7}>
            <div className="mon-settings">
              <label>
                <span className="small muted">هر چند وقت بررسی شود</span>
                <select className="select" value={m?.intervalMin ?? 5} onChange={(e) => save({ intervalMin: Number(e.target.value), enabled: m?.enabled ?? true })}>
                  {intervals.map((n) => (
                    <option key={n} value={n}>
                      هر {faDigits(n)} دقیقه
                    </option>
                  ))}
                </select>
              </label>
              <label className="mon-toggle">
                <input type="checkbox" className="switch" checked={m ? m.autoHeal : true} onChange={(e) => save({ autoHeal: e.target.checked, enabled: m?.enabled ?? false })} />
                <span>
                  <span>ری‌استارت خودکار این برنامه</span>
                  <span className="small muted">{policyAutoHeal ? "فقط وقتی از دسترس خارج شود و ری‌استارت واقعاً کمک کند." : "ترمیم خودکار در تنظیمات «اجازه‌های یارا» خاموش است؛ این گزینه تا روشن شدنش اثری ندارد."}</span>
                </span>
              </label>
            </div>
          </td>
        </tr>
      )}
      {(result || err) && (
        <tr className="audit-detail">
          <td colSpan={7}>
            {err ? (
              <p className="error-text">{err}</p>
            ) : (
              result && (
                <div className="mon-result">
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <HealthPill status={result.diagnosis.status} />
                    <span>{result.diagnosis.summary}</span>
                    <span style={{ marginInlineStart: "auto", display: "flex", gap: 6 }}>
                      {result.diagnosis.causes.length > 0 && (
                        <FixButton
                          compact
                          onClick={() => {
                            const r = fixRequest(row.app.name, result.diagnosis.summary, result.diagnosis.causes);
                            wb.askYara(r.text, true, r.context);
                          }}
                        />
                      )}
                      <button type="button" className="icon-btn" onClick={() => setResult(null)} aria-label="بستن نتیجه">
                        <X size={14} aria-hidden />
                      </button>
                    </span>
                  </div>
                  <CauseList causes={result.diagnosis.causes} limit={3} />
                </div>
              )
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function Routines({ data, onChange }: { data: Data; onChange: () => void }) {
  const [kind, setKind] = useState<Routine["kind"]>("dbBackup");
  const [dbs, setDbs] = useState<{ id: string; name: string }[]>([]);
  const [app, setApp] = useState("");
  const [db, setDb] = useState("");
  const [disk, setDisk] = useState("");
  const [hour, setHour] = useState(3);
  const [weekday, setWeekday] = useState<number | "">("");
  const [msg, setMsg] = useState("");
  const apps = data.rows.filter((r) => !r.app.missing).map((r) => r.app.name);

  useEffect(() => {
    fetch("/api/resources")
      .then((r) => r.json())
      .then((d) => setDbs((d.databases ?? []).map((x: { id: string; name: string }) => ({ id: x.id, name: x.name }))))
      .catch(() => {});
  }, []);

  const add = async () => {
    setMsg("");
    const target = kind === "dbBackup" ? { databaseId: db, name: dbs.find((d) => d.id === db)?.name ?? db } : kind === "diskBackup" ? { app, disk } : { app };
    try {
      await send("/api/monitor/routines", "POST", { kind, target, hour, weekday: weekday === "" ? null : weekday });
      onChange();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    setMsg("");
    try {
      const r = (await fn()) as { status?: string };
      if (r?.status) setMsg(r.status === "ok" ? "اجرا شد و در سوابق تغییرات ثبت شد." : `نتیجه: ${r.status}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
    onChange();
  };

  return (
    <section className="box">
      <h2>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <CalendarClock size={14} aria-hidden /> کارهای تکراری زمان‌بندی‌شده
        </span>
        {!data.policy.allowRoutines && <span className="pill pill-warn">در سیاست حساب متوقف است</span>}
      </h2>
      <div className="body" style={{ display: "grid", gap: 12 }}>
        <p className="muted small">ساختن یک کار زمان‌بندی‌شده یعنی یک بار اجازه می‌دهید. هر اجرا دوباره با سیاست حساب سنجیده و در سوابق تغییرات ثبت می‌شود. ساعت‌ها به وقت تهران است.</p>
        {data.routines.length > 0 && (
          <ul className="mon-routines">
            {data.routines.map((r) => (
              <li key={r.id}>
                <input type="checkbox" className="switch" checked={r.enabled} onChange={(e) => act(() => send("/api/monitor/routines", "PATCH", { id: r.id, enabled: e.target.checked }))} aria-label={`فعال بودن ${r.label}`} />
                <div style={{ minWidth: 0 }}>
                  <div>{r.label}</div>
                  <div className="faint small">
                    {r.weekday !== null ? `هر ${DAYS[r.weekday]}` : "هر روز"} ساعت {faDigits(String(r.hour).padStart(2, "0"))}:۰۰
                    {r.enabled && ` · اجرای بعد ${relativeFa(r.nextRunAt)}`}
                    {r.lastRunAt && ` · آخرین اجرا ${relativeFa(r.lastRunAt)} (${r.lastStatus === "ok" ? "موفق" : r.lastStatus === "blocked" ? "مسدود با سیاست" : (r.lastStatus ?? "")})`}
                  </div>
                </div>
                <button type="button" className="btn btn-ghost" style={{ height: 28 }} onClick={() => act(() => send("/api/monitor/routines", "PATCH", { id: r.id, run: true }))}>
                  <Play size={13} aria-hidden /> اجرا اکنون
                </button>
                <button type="button" className="icon-btn" aria-label={`حذف ${r.label}`} onClick={() => act(() => send(`/api/monitor/routines?id=${r.id}`, "DELETE"))}>
                  <Trash2 size={14} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mon-form">
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as Routine["kind"])} aria-label="نوع کار">
            {Object.entries(ROUTINE_KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          {kind === "dbBackup" ? (
            <select className="select" value={db} onChange={(e) => setDb(e.target.value)} aria-label="دیتابیس">
              <option value="">دیتابیس…</option>
              {dbs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <select className="select" value={app} onChange={(e) => setApp(e.target.value)} aria-label="برنامه">
              <option value="">برنامه…</option>
              {apps.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          )}
          {kind === "diskBackup" && <input className="input ltr" placeholder="disk name" value={disk} onChange={(e) => setDisk(e.target.value)} aria-label="نام دیسک" style={{ width: 130 }} />}
          <select className="select" value={weekday} onChange={(e) => setWeekday(e.target.value === "" ? "" : Number(e.target.value))} aria-label="روز">
            <option value="">هر روز</option>
            {DAYS.map((d, i) => (
              <option key={i} value={i}>
                هر {d}
              </option>
            ))}
          </select>
          <select className="select" value={hour} onChange={(e) => setHour(Number(e.target.value))} aria-label="ساعت">
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                ساعت {faDigits(String(h).padStart(2, "0"))}:۰۰
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={add} disabled={kind === "dbBackup" ? !db : !app || (kind === "diskBackup" && !disk)}>
            افزودن
          </button>
        </div>
        {msg && (
          <p className="small" role="status">
            {msg}
          </p>
        )}
      </div>
    </section>
  );
}

function Alerts({ data, onChange }: { data: Data; onChange: () => void }) {
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState("");
  const run = async (body: unknown, ok: string) => {
    setMsg("");
    try {
      await send("/api/monitor", "PATCH", body);
      setMsg(ok);
      setUrl("");
      onChange();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="box">
      <h2>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <BellRing size={14} aria-hidden /> اعلان‌ها
        </span>
        {data.webhook ? <span className="pill pill-ok">وب‌هوک فعال</span> : <span className="pill">فقط داخل یارا</span>}
      </h2>
      <div className="body" style={{ display: "grid", gap: 10 }}>
        <p className="muted small">
          باز شدن، بدتر شدن و برطرف شدن حادثه‌ها و ری‌استارت‌های خودکار به این آدرس فرستاده می‌شود (Slack، Discord یا هر سرویسی که JSON بگیرد). آدرس رمزنگاری‌شده نگه داشته می‌شود.
        </p>
        <div className="mon-form">
          <input className="input ltr" dir="ltr" type="url" placeholder="https://hooks.example.com/…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="آدرس وب‌هوک" style={{ flex: 1, minWidth: 220 }} />
          <button type="button" className="btn" disabled={!url} onClick={() => run({ webhook: url }, "ذخیره شد.")}>
            ذخیره
          </button>
          {data.webhook && (
            <>
              <button type="button" className="btn btn-ghost" onClick={() => run({ test: true }, "پیام آزمایشی فرستاده شد.")}>
                ارسال آزمایشی
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => run({ webhook: null }, "حذف شد.")}>
                حذف
              </button>
            </>
          )}
        </div>
        {msg && (
          <p className="small" role="status">
            {msg}
          </p>
        )}
      </div>
    </section>
  );
}

export function MonitorPage() {
  const wb = useWorkbench();
  const { data, error, loading, load } = useDetail<Data>("/api/monitor");
  const [showResolved, setShowResolved] = useState(false);

  // Keep the page live while it is open.
  useEffect(() => {
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const rows = data?.rows ?? [];
  const watched = rows.filter((r) => r.monitor?.enabled);
  const last = (r: Row) => r.checks[r.checks.length - 1]?.status;
  const count = (s: Status) => watched.filter((r) => last(r) === s).length;
  const open = (data?.incidents ?? []).filter((i) => i.status === "open");
  const resolved = (data?.incidents ?? []).filter((i) => i.status === "resolved");
  const unwatched = rows.filter((r) => !r.monitor?.enabled && r.app.on && !r.app.missing);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>
            <Activity size={18} aria-hidden style={{ color: "var(--text-3)" }} />
            پایش و سلامت
          </h1>
          <p className="sub">یارا برنامه‌ها را مدام مثل یک بازدیدکننده می‌سنجد، علت مشکل را با شاهد رتبه‌بندی می‌کند و در حدی که اجازه داده‌اید، خودش ترمیم و نتیجه را تأیید می‌کند.</p>
        </div>
        <div className="toolbar">
          <button type="button" className="icon-btn" onClick={load} aria-label="به‌روزرسانی" title="به‌روزرسانی">
            <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden />
          </button>
        </div>
      </div>

      {error ? (
        <div className="alert" role="alert">
          {error}
        </div>
      ) : !data ? (
        <Skeleton />
      ) : (
        <>
          <div className="stats">
            <div>
              <b className="num">{faDigits(watched.length)}</b>تحت پایش
            </div>
            <div>
              <b className="num">{faDigits(count("healthy"))}</b>سالم
            </div>
            <div className={count("degraded") ? "bad" : ""}>
              <b className="num">{faDigits(count("degraded"))}</b>مشکل‌دار
            </div>
            <div className={count("down") ? "bad" : ""}>
              <b className="num">{faDigits(count("down"))}</b>از دسترس خارج
            </div>
            <div className={open.length ? "bad" : ""}>
              <b className="num">{faDigits(open.length)}</b>حادثه‌ی باز
            </div>
          </div>

          <div className="mon-policy small">
            {data.policy.readOnly ? (
              <span className="pill pill-warn">حالت فقط خواندن: پایش فقط گزارش می‌دهد</span>
            ) : data.policy.autoHeal ? (
              <span className="pill pill-ok">
                <Wrench size={12} aria-hidden /> ترمیم خودکار روشن · حداکثر {faDigits(data.policy.maxAutoHealsPerAppHour)} ری‌استارت در ساعت برای هر برنامه
              </span>
            ) : (
              <span className="pill">ترمیم خودکار خاموش: پایش فقط گزارش و پیشنهاد می‌دهد</span>
            )}
            <Link href="/app/settings#governance" className="link">
              تغییر در تنظیمات
            </Link>
          </div>

          {data.appsError && (
            <div className="alert" role="alert">
              فهرست برنامه‌ها از لیارا خوانده نشد: {data.appsError}
            </div>
          )}

          {watched.length === 0 && unwatched.length > 0 && (
            <div className="mon-onboard">
              <div>
                <b>هنوز برنامه‌ای زیر نظر نیست.</b>
                <p className="small muted">با یک کلیک، یارا هر ۵ دقیقه سایت، منابع و لاگ‌ها را می‌سنجد و اگر مشکلی پیدا شد خبر می‌دهد.</p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  for (const r of unwatched) await send("/api/monitor", "POST", { app: r.app.name, enabled: true, intervalMin: 5 }).catch(() => {});
                  load();
                  wb.refreshHealth();
                }}
              >
                <Activity size={14} aria-hidden /> پایش همه‌ی برنامه‌ها
              </button>
            </div>
          )}

          {(open.length > 0 || resolved.length > 0) && (
            <section className="box">
              <h2>
                <span>حادثه‌ها</span>
                {resolved.length > 0 && (
                  <button type="button" className="btn btn-ghost" style={{ height: 26 }} onClick={() => setShowResolved((x) => !x)}>
                    {showResolved ? "پنهان کردن برطرف‌شده‌ها" : `برطرف‌شده‌ها (${faDigits(resolved.length)})`}
                  </button>
                )}
              </h2>
              <div className="body inc-list">
                {open.length === 0 && <p className="muted small">حادثه‌ی بازی نیست؛ همه‌چیز آرام است.</p>}
                {open.map((i) => (
                  <IncidentCard key={i.id} inc={i} onChange={load} />
                ))}
                {showResolved && resolved.map((i) => <IncidentCard key={i.id} inc={i} onChange={load} />)}
              </div>
            </section>
          )}

          <section className="box">
            <h2>برنامه‌ها</h2>
            <div className="table-scroll">
              <table className="data-table mon-table">
                <thead>
                  <tr>
                    <th scope="col">برنامه</th>
                    <th scope="col">وضعیت</th>
                    <th scope="col">بررسی‌های اخیر</th>
                    <th scope="col">پاسخ و منابع</th>
                    <th scope="col">در دسترس (۲۴ ساعت)</th>
                    <th scope="col">پایش</th>
                    <th scope="col">
                      <span className="visually-hidden">کارها</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="muted">
                        برنامه‌ای در حساب نیست.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => <AppRow key={r.app.name} row={r} intervals={data.intervals} policyAutoHeal={data.policy.autoHeal && !data.policy.readOnly} onChange={load} />)
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <div className="cols">
            <Routines data={data} onChange={load} />
            <Alerts data={data} onChange={load} />
          </div>
        </>
      )}
    </div>
  );
}
