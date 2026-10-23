"use client";

import {
  Activity,
  ArrowLeftRight,
  Ban,
  Eye,
  Gauge,
  Globe,
  Lightbulb,
  Network,
  RotateCcw,
  Stethoscope,
  Bug,
  Check,
  ChevronLeft,
  Circle,
  CircleAlert,
  CircleDot,
  FileDiff,
  GitBranch,
  LoaderCircle,
  Rocket,
  Server,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bytesFa, faDigits } from "@/lib/fa";
import { Markdown } from "../../Markdown";
import { CauseList, HealthPill, type HealthStatus } from "../Health";
import { useWorkbench } from "../Workbench";
import { useModKey } from "../useModKey";
import type { AgentId, Call } from "./timeline";

export const AGENTS: Record<AgentId, { label: string; icon: LucideIcon }> = {
  monitor: { label: "پایش خودکار", icon: Activity },
  supervisor: { label: "هماهنگ‌کننده", icon: Workflow },
  deploy: { label: "استقرار", icon: Rocket },
  debug: { label: "اشکال‌زدایی", icon: Bug },
  ops: { label: "عملیات", icon: Server },
};

export function AgentChip({ agent }: { agent: AgentId }) {
  const a = AGENTS[agent] ?? AGENTS.supervisor;
  return (
    <span className="agent-chip" data-agent={agent}>
      <a.icon size={12} aria-hidden />
      {a.label}
    </span>
  );
}

/** Write tools wrap their result as { ok, result }; reads and auto-approved runs return it directly. */
const unwrap = (output: any) => (output && typeof output === "object" && "ok" in output && "result" in output ? output.result : output);
const errorOf = (call: Call) => (call.output && typeof call.output === "object" && "error" in call.output ? String(call.output.error) : call.error ? "خطا" : "");

// ---------- plan ----------

type PlanStep = { title: string; status: "todo" | "doing" | "done" | "blocked" };

export function PlanCard({ steps, agent, live }: { steps: PlanStep[]; agent: AgentId; live: boolean }) {
  const done = steps.filter((s) => s.status === "done").length;
  return (
    <section className="gen-card plan" aria-label="برنامه‌ی کار">
      <header className="gen-head">
        <span className="gen-title">برنامه‌ی کار</span>
        <AgentChip agent={agent} />
        <span className="gen-meta num">
          {faDigits(done)}/{faDigits(steps.length)}
        </span>
      </header>
      <ol className="plan-list">
        {steps.map((s, i) => (
          <li key={i} data-status={s.status}>
            {s.status === "done" ? (
              <Check size={14} strokeWidth={2.6} aria-label="انجام شد" />
            ) : s.status === "doing" ? (
              live ? <LoaderCircle size={14} className="spin" aria-label="در حال انجام" /> : <CircleDot size={14} aria-label="نیمه‌کاره" />
            ) : s.status === "blocked" ? (
              <CircleAlert size={14} aria-label="متوقف" />
            ) : (
              <Circle size={14} aria-label="مانده" />
            )}
            <span dir="auto">{s.title}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------- diff ----------

export function DiffView({ diff, max = 400 }: { diff: string; max?: number }) {
  const lines = diff
    .split("\n")
    .filter((l) => !l.startsWith("====") && !l.startsWith("Index:"))
    .slice(0, max);
  return (
    <pre className="diff ltr" dir="ltr">
      {lines.map((l, i) => {
        const kind = l.startsWith("+++") || l.startsWith("---") ? "file" : l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx";
        return (
          <span key={i} className={`dl dl-${kind}`}>
            {l || " "}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

// ---------- command ----------

export function CommandCard({ call }: { call: Call }) {
  const live = call.ui.command;
  const r = unwrap(call.output) as { exitCode?: number; output?: string; durationMs?: number; timedOut?: boolean } | undefined;
  const command = String(call.args.command ?? live?.command ?? "");
  const running = !call.done && call.decision !== "pending" && call.decision !== "denied";
  const exitCode = r?.exitCode ?? live?.exitCode;
  const output = String(r?.output ?? live?.output ?? "").replace(/\s+$/, "");
  const err = errorOf(call);
  const [open, setOpen] = useState(exitCode !== 0);
  const ok = exitCode === 0;
  if (call.decision === "pending" || call.decision === "denied") return null;
  return (
    <section className="gen-card cmd" data-state={running ? "running" : err || !ok ? "failed" : "ok"}>
      <button type="button" className="cmd-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={running && !output}>
        <SquareTerminal size={14} aria-hidden />
        <code className="ltr cmd-line" dir="ltr">
          {command}
        </code>
        {running ? (
          <LoaderCircle size={14} className="spin" aria-label="در حال اجرا" />
        ) : err ? (
          <span className="pill pill-danger">خطا</span>
        ) : (
          <span className={`pill ${ok ? "pill-ok" : "pill-danger"} num`}>
            {ok ? "موفق" : `کد ${faDigits(exitCode ?? "?")}`}
            {r?.durationMs != null && ` · ${faDigits((r.durationMs / 1000).toFixed(1))}ث`}
          </span>
        )}
        <ChevronLeft size={14} className="step-chev" aria-hidden />
      </button>
      {open && (output || err) && (
        <pre className="term-out ltr" dir="ltr">
          {err || output.split("\n").slice(-60).join("\n")}
        </pre>
      )}
    </section>
  );
}

// ---------- deploy ----------

const STAGES = ["PACKING", "UPLOADING", "BUILDING", "PUSHING", "DEPLOYING", "READY"] as const;
const STAGE_FA: Record<string, string> = {
  PACKING: "بسته‌بندی",
  UPLOADING: "آپلود",
  QUEUED: "در صف",
  BUILDING: "ساخت",
  PUSHING: "ارسال ایمیج",
  DEPLOYING: "راه‌اندازی",
  READY: "فعال",
};
const FAILED = ["FAILED", "UNHEALTHY", "TIMEDOUT", "CANCELED"];

export function DeployCard({ call }: { call: Call }) {
  const live = call.ui.deploy as Record<string, any> | undefined;
  const r = unwrap(call.output) as Record<string, any> | undefined;
  const err = errorOf(call);
  if (call.decision === "pending" || call.decision === "denied") return null;
  const state: string = r?.state ?? live?.stage ?? "PACKING";
  const failed = FAILED.includes(state) || !!err;
  const stage = state === "QUEUED" ? "BUILDING" : state;
  const reached = failed ? STAGES.indexOf((live?.stage as (typeof STAGES)[number]) ?? "BUILDING") : STAGES.indexOf(stage as (typeof STAGES)[number]);
  const lines: string[] = live?.lines ?? (r?.logTail ? String(r.logTail).split("\n") : []);
  const files = r?.files ?? live?.files;
  const size = r?.size ?? live?.size;
  const releaseID = r?.releaseID ?? live?.releaseID;
  const app = String(call.args.app ?? live?.app ?? "");
  const running = !call.done;

  return (
    <section className="gen-card deploy" data-state={running ? "running" : failed ? "failed" : "ok"} aria-label={`استقرار ${app}`}>
      <header className="gen-head">
        <Rocket size={14} aria-hidden />
        <span className="gen-title">
          استقرار <b className="ltr">{app}</b>
        </span>
        {running ? (
          <span className="pill pill-accent">
            <LoaderCircle size={12} className="spin" aria-hidden /> {STAGE_FA[state] ?? state}
          </span>
        ) : failed ? (
          <span className="pill pill-danger">ناموفق · {err ? "خطا" : state}</span>
        ) : (
          <span className="pill pill-ok">فعال شد</span>
        )}
      </header>
      <ol className="pipeline" aria-label="مراحل استقرار">
        {STAGES.map((s, i) => {
          const st = failed && i === Math.max(reached, 0) ? "failed" : i < reached || (!running && !failed) ? "done" : i === reached ? (running ? "active" : "done") : "todo";
          return (
            <li key={s} data-state={st}>
              <span className="dot" aria-hidden>
                {st === "done" ? <Check size={10} strokeWidth={3} /> : st === "failed" ? <X size={10} strokeWidth={3} /> : st === "active" ? <CircleDot size={10} /> : null}
              </span>
              <span className="lbl">{STAGE_FA[s]}</span>
            </li>
          );
        })}
      </ol>
      <div className="deploy-meta small muted">
        {files != null && <span className="num">{faDigits(files)} فایل</span>}
        {size != null && <span className="num">{bytesFa(size)}</span>}
        {releaseID && (
          <span className="ltr" dir="ltr">
            {releaseID}
          </span>
        )}
        {live?.queue ? <span className="num">نوبت {faDigits(live.queue)}</span> : null}
        <Verification call={call} />
      </div>
      {(r?.failReason || err) && <p className="error-text ltr">{r?.failReason ?? err}</p>}
      {lines.length > 0 && (
        <pre className="term-out ltr" dir="ltr">
          {lines.slice(-14).join("\n")}
        </pre>
      )}
    </section>
  );
}

// ---------- edits ----------

export function EditCard({ call }: { call: Call }) {
  const r = unwrap(call.output) as { path?: string; diff?: string } | undefined;
  const diff = r?.diff ?? call.approval?.diff;
  if (call.decision === "pending") return null;
  if (call.decision === "denied" || !diff) return null;
  return (
    <section className="gen-card edit" aria-label={`ویرایش ${call.args.path}`}>
      <header className="gen-head">
        <FileDiff size={14} aria-hidden />
        <span className="gen-title ltr" dir="ltr">
          {String(call.args.path ?? r?.path ?? "")}
        </span>
        <span className="pill pill-ok">اعمال شد</span>
      </header>
      <DiffView diff={diff} max={80} />
    </section>
  );
}

// ---------- approvals ----------

const RISK: Record<string, string> = { low: "کم‌خطر", medium: "خطر متوسط", high: "پرخطر" };
const KIND_ICON: Record<string, LucideIcon> = { edit: FileDiff, command: SquareTerminal, deploy: Rocket, git: GitBranch, liara: Server };

export function ApprovalCard({ call, onDecide, autoFocus }: { call: Call; onDecide: (approved: boolean, confirmText?: string) => Promise<void>; autoFocus?: boolean }) {
  const req = call.approval!;
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [typed, setTyped] = useState("");
  const approveRef = useRef<HTMLButtonElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const mod = useModKey();
  const pending = call.decision === "pending";
  const canApprove = !busy && (!req.confirmText || typed === req.confirmText);
  const Icon = KIND_ICON[req.kind] ?? ShieldCheck;
  const err = errorOf(call);
  const state = pending ? "pending" : call.decision === "denied" ? "denied" : err ? "failed" : "approved";

  useEffect(() => {
    if (pending && autoFocus) (req.confirmText ? confirmRef.current : approveRef.current)?.focus({ preventScroll: true });
  }, [pending, autoFocus, req.confirmText]);

  const decide = async (approved: boolean) => {
    if (approved && !canApprove) return;
    setBusy(approved ? "approve" : "deny");
    try {
      await onDecide(approved, approved ? typed : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="approval agent-approval"
      data-state={state}
      aria-label={`درخواست تأیید: ${req.title}`}
      onKeyDown={(e) => {
        if (pending && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          decide(true);
        } else if (pending && e.key === "Escape") {
          // Esc never denies by itself; it moves focus to «رد کردن» so the choice stays deliberate.
          e.preventDefault();
          denyRef.current?.focus();
        }
      }}
    >
      <header className="approval-head">
        <span className="kicker">
          {req.risk === "high" ? <ShieldAlert size={15} aria-hidden /> : <Icon size={15} aria-hidden />}
          {pending ? "نیاز به تأیید شما" : "تغییر پیشنهادی"}
        </span>
        <AgentChip agent={req.agent} />
        <span className={`pill ${req.risk === "high" ? "pill-danger" : req.risk === "medium" ? "pill-warn" : "pill-ok"}`}>{RISK[req.risk] ?? req.risk}</span>
      </header>
      <div className="approval-main">
        <div className="approval-title">
          <span>{req.title}</span>
          {req.target && (
            <span className="target ltr" dir="ltr" title={req.target}>
              {req.target.split(" · ").pop()}
            </span>
          )}
        </div>
        {req.summary && <Markdown text={req.summary} />}
        {(req.why || req.after || req.undo) && (
          <dl className="approval-why">
            {req.why && (
              <div>
                <dt>
                  <Lightbulb size={13} aria-hidden /> چرا
                </dt>
                <dd>
                  <Markdown text={req.why} />
                </dd>
              </div>
            )}
            {req.after && (
              <div>
                <dt>
                  <Eye size={13} aria-hidden /> بعد از اجرا
                </dt>
                <dd>{req.after}</dd>
              </div>
            )}
            {req.undo && (
              <div>
                <dt>
                  <RotateCcw size={13} aria-hidden /> برگشت‌پذیر
                </dt>
                <dd>{req.undo}</dd>
              </div>
            )}
          </dl>
        )}
        {pending && req.policy && (
          <p className="policy-note">
            <ShieldCheck size={13} aria-hidden />
            {POLICY_FA(req.policy)}
          </p>
        )}
        {req.command && (
          <pre className="term-out ltr" dir="ltr">
            $ {req.command}
          </pre>
        )}
        {req.diff && (pending || state === "failed") && <DiffView diff={req.diff} />}
        {/* Short facts (plan, price, port) are what the user is approving: show them, don't fold them away. */}
        {req.details && Object.keys(req.details).length > 0 && (
          <dl className="approval-facts">
            {Object.entries(req.details).map(([k, v]) => (
              <div key={k}>
                <dt>{DETAIL_FA[k] ?? k}</dt>
                <dd dir="auto">{typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        )}
        {pending && req.confirmText && (
          <label className="confirm-field">
            <span className="small muted">
              این تغییر پرخطر است. برای تأیید، <code className="ltr">{req.confirmText}</code> را تایپ کنید
            </span>
            <input ref={confirmRef} className="input ltr" dir="ltr" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={typed.length > 0 && typed !== req.confirmText} />
            {typed.length > 0 && typed !== req.confirmText && (
              <span className="small" style={{ color: "var(--danger)" }}>
                هنوز با نام منبع یکی نیست.
              </span>
            )}
          </label>
        )}
      </div>
      <footer className="approval-foot">
        {pending ? (
          <>
            <span className="approval-note">
              تا تأیید نکنید، چیزی تغییر نمی‌کند. <kbd className="hide-touch">{mod}</kbd>
              <kbd className="hide-touch">↵</kbd>
            </span>
            <div className="approval-actions">
              <button ref={denyRef} type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => decide(false)}>
                <X size={15} aria-hidden />
                رد کردن
              </button>
              <button ref={approveRef} type="button" className={`btn ${req.risk === "high" ? "btn-danger" : "btn-primary"}`} disabled={!canApprove} onClick={() => decide(true)}>
                {busy === "approve" ? "در حال اجرا…" : "تأیید و اجرا"}
              </button>
            </div>
          </>
        ) : state === "denied" ? (
          <div className="approval-result">
            <span className="pill">
              <Ban size={13} aria-hidden />
              رد شد، چیزی تغییر نکرد
            </span>
          </div>
        ) : state === "failed" ? (
          <div className="approval-result" style={{ color: "var(--danger)", flexWrap: "wrap" }}>
            <CircleAlert size={15} aria-hidden />
            <span>اجرا نشد؛ لیارا خطا داد و چیزی تغییر نکرد.</span>
            <span className="ltr small faint" dir="ltr">
              {err}
            </span>
          </div>
        ) : (
          <div className="approval-result" style={{ flexWrap: "wrap" }}>
            <span className="pill pill-ok">
              <ShieldCheck size={13} aria-hidden />
              {call.done ? "تأیید و اجرا شد" : "تأیید شد، در حال اجرا…"}
            </span>
            {!call.done && <LoaderCircle size={14} className="spin" aria-hidden />}
            <Verification call={call} />
            {auditIdOf(call.output) && (
              <a className="audit-ref ltr" href="/app/audit" title="در سوابق تغییرات ثبت شد">
                {auditIdOf(call.output)}
              </a>
            )}
          </div>
        )}
      </footer>
      {call.ui.secret && <SecretBox label={String(call.ui.secret.label)} value={String(call.ui.secret.value)} />}
    </section>
  );
}

/** Approval facts arrive with English keys from tools; the card labels them in Persian. */
const DETAIL_FA: Record<string, string> = {
  platform: "پلتفرم",
  port: "پورت",
  workspace: "کد",
  message: "توضیح",
  planID: "پلن",
  bundlePlanID: "بسته‌ی امکانات",
  app: "برنامه",
};

const auditIdOf = (output: any): string | undefined => (output && typeof output === "object" && typeof output.auditId === "string" ? output.auditId : undefined);

/** Policy reasons come from the server in English; the card shows them in Persian. */
function POLICY_FA(reason: string) {
  if (reason.startsWith("High-risk")) return "تغییر پرخطر: سیاست حساب تأیید و تایپ نام منبع را لازم می‌داند.";
  if (reason.startsWith("Low-risk")) return "تغییر کم‌خطر؛ سیاست فعلی برای آن هم تأیید می‌خواهد.";
  return "سیاست حساب برای این تغییر تأیید شما را لازم می‌داند.";
}

const BLOCK_FA: [RegExp, string][] = [
  [/Read-only mode/, "حالت «فقط خواندن» در تنظیمات «اجازه‌های یارا» روشن است."],
  [/Deleting resources is disabled/, "حذف منابع در تنظیمات «اجازه‌های یارا» ممنوع شده است."],
  [/changes in this conversation/, "سقف تعداد تغییر در این گفت‌وگو در یک ساعت پر شده است."],
  [/changes on this account/, "سقف تعداد تغییر حساب در یک ساعت پر شده است."],
  [/deploys of/, "سقف استقرار این برنامه در یک ساعت پر شده است؛ اول علت خطا را پیدا کنید."],
  [/failed twice/, "همین تغییر دو بار شکست خورده است؛ تکرارش مجاز نیست."],
  [/typed confirmation did not match/, "متن تأیید با نام منبع یکی نبود؛ سرور اجرا را رد کرد."],
];

/** A change the server refused under the account's governance policy. */
export function BlockedCard({ call }: { call: Call }) {
  const o = call.output as { reason?: string; title?: string };
  const fa = BLOCK_FA.find(([re]) => re.test(o?.reason ?? ""))?.[1];
  return (
    <section className="gen-card blocked" data-state="failed" aria-label="تغییر مسدود شد">
      <header className="gen-head">
        <ShieldAlert size={14} aria-hidden />
        <span className="gen-title">{o?.title ?? call.name}</span>
        <span className="pill pill-danger">مسدود با سیاست</span>
      </header>
      <p className="blocked-reason">
        {fa ?? o?.reason}{" "}
        <a className="link" href="/app/settings#governance">
          تنظیمات «اجازه‌های یارا»
        </a>
      </p>
    </section>
  );
}

const POWER_FA: Record<string, string> = { POWERED_ON: "روشن", POWERED_OFF: "خاموش", SUSPENDED: "معلق" };

/** The result check a change ran on itself: VM operations, and a health re-check of the app after app changes. */
function Verification({ call }: { call: Call }) {
  const live = call.ui.verify as { state?: string; note?: string } | undefined;
  const v = unwrap(call.output)?.verification as
    | { verified?: boolean; operation?: { name: string; state: string } | null; finalState?: { power?: string } | null; note?: string; probe?: { status: number | null; ms: number } | null }
    | undefined;
  if (!v && live?.state === "running")
    return (
      <span className="pill pill-accent">
        <LoaderCircle size={12} className="spin" aria-hidden /> بررسی سلامت برنامه پس از تغییر…
      </span>
    );
  if (!v) return null;
  return (
    <span className={`pill ${v.verified ? "pill-ok" : "pill-warn"}`} title={v.note}>
      {v.verified ? <Check size={12} strokeWidth={2.6} aria-hidden /> : <CircleAlert size={12} aria-hidden />}
      {v.verified ? "نتیجه بررسی شد" : "نتیجه تأیید نشد"}
      {v.operation && <span className="ltr"> · {v.operation.name} {v.operation.state}</span>}
      {v.finalState?.power && <span> · {POWER_FA[v.finalState.power] ?? v.finalState.power}</span>}
      {v.probe?.status != null && (
        <span className="ltr num">
          {" "}
          · HTTP {v.probe.status} · {faDigits(v.probe.ms)} ms
        </span>
      )}
    </span>
  );
}

/** A credential shown once, to the user only; it is not saved in the conversation. */
function SecretBox({ label, value }: { label: string; value: string }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret-box" role="group" aria-label={label}>
      <div className="small">
        <b>{label}</b>
        <span className="muted"> · فقط همین یک بار نمایش داده می‌شود و یارا آن را نمی‌بیند. جای امنی ذخیره‌اش کنید.</span>
      </div>
      <div className="secret-row">
        <code className="ltr" dir="ltr">
          {shown ? value : "•".repeat(Math.min(value.length, 24))}
        </code>
        <button type="button" className="btn btn-ghost" onClick={() => setShown((x) => !x)}>
          {shown ? "پنهان" : "نمایش"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? "کپی شد" : "کپی"}
        </button>
      </div>
    </div>
  );
}

// ---------- health ----------

const pctFa = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `${faDigits(n)}٪`);

/** The result of diagnoseApp: what is wrong, how sure Yara is, and the evidence, ranked. */
export function DiagnosisCard({ call }: { call: Call }) {
  const o = unwrap(call.output) as {
    app: string;
    health: { status: HealthStatus; summary: string; causes: any[] };
    probe: { status: number | null; ms: number; error?: string } | string | null;
    resources?: { plan?: string; cpu?: { avgPctOfPlan?: number | null } | null; memory?: { maxPctOfPlan?: number | null } | null };
    latestRelease?: { state: string } | null;
    dataGaps?: string[];
  };
  const probe = o.probe && typeof o.probe === "object" ? o.probe : null;
  const status = o.health.status;
  return (
    <section className="gen-card diagnosis" data-health={status} aria-label={`نتیجه‌ی معاینه‌ی ${o.app}`}>
      <header className="gen-head">
        <Stethoscope size={14} aria-hidden />
        <span className="gen-title">
          معاینه‌ی <b className="ltr">{o.app}</b>
        </span>
        <HealthPill status={status} />
      </header>
      <dl className="diag-facts">
        <div>
          <dt>
            <Globe size={12} aria-hidden /> پاسخ سایت
          </dt>
          <dd className="num">
            {probe ? (
              probe.status ? (
                <span className="ltr" dir="ltr">
                  HTTP {faDigits(probe.status)} · {faDigits(probe.ms)} ms
                </span>
              ) : (
                (probe.error ?? "بدون پاسخ")
              )
            ) : (
              <span className="faint">بدون آدرس عمومی</span>
            )}
          </dd>
        </div>
        <div>
          <dt>
            <Gauge size={12} aria-hidden /> پردازنده
          </dt>
          <dd className="num">{pctFa(o.resources?.cpu?.avgPctOfPlan)} از سهم پلن</dd>
        </div>
        <div>
          <dt>
            <Activity size={12} aria-hidden /> حافظه
          </dt>
          <dd className="num">{pctFa(o.resources?.memory?.maxPctOfPlan)} از سقف پلن</dd>
        </div>
        {o.latestRelease && (
          <div>
            <dt>
              <Rocket size={12} aria-hidden /> آخرین استقرار
            </dt>
            <dd>{STAGE_FA[o.latestRelease.state] ?? o.latestRelease.state}</dd>
          </div>
        )}
      </dl>
      <p className="diag-summary">{o.health.summary}</p>
      {o.health.causes.length > 0 ? (
        <CauseList causes={o.health.causes} limit={3} />
      ) : (
        status === "healthy" && <p className="small muted">نشانه‌ای از مشکل در پاسخ سایت، منابع یا لاگ‌ها دیده نشد.</p>
      )}
      <footer className="diag-foot small faint">
        <Eye size={12} aria-hidden /> فقط بررسی شد؛ چیزی تغییر نکرد.
        {o.dataGaps && o.dataGaps.length > 0 && <span> این‌ها خوانده نشد: {o.dataGaps.map((g) => g.split(":")[0]).join("، ")}.</span>}
      </footer>
    </section>
  );
}

/** probeApp: the site as a visitor sees it, a few samples. */
export function ProbeCard({ call }: { call: Call }) {
  const o = unwrap(call.output) as { app: string; url: string; healthy: boolean; medianMs: number | null; samples: { status: number | null; ms: number; error?: string }[] };
  return (
    <section className="gen-card probe" data-state={o.healthy ? "ok" : "failed"} aria-label={`پاسخ سایت ${o.app}`}>
      <header className="gen-head">
        <ArrowLeftRight size={14} aria-hidden />
        <span className="gen-title">
          درخواست به سایت <b className="ltr">{o.app}</b>
        </span>
        <span className={`pill ${o.healthy ? "pill-ok" : "pill-danger"}`}>{o.healthy ? "پاسخ می‌دهد" : "پاسخ درست نمی‌دهد"}</span>
      </header>
      <div className="probe-row">
        {o.samples.map((s, i) => (
          <span key={i} className={`pill ${s.status && s.status < 500 ? "" : "pill-danger"}`}>
            <span className="ltr num" dir="ltr">
              {s.status ? `${faDigits(s.status)} · ${faDigits(s.ms)} ms` : (s.error ?? "–")}
            </span>
          </span>
        ))}
        {o.medianMs !== null && <span className="small muted">میانه {faDigits(o.medianMs)} میلی‌ثانیه</span>}
      </div>
      <p className="ltr small faint probe-url" dir="ltr">
        {o.url}
      </p>
    </section>
  );
}

/** A network check Yara ran (netCheck): the command, its output, and a jump to the Network tab where it also landed. */
export function NetCard({ call }: { call: Call }) {
  const wb = useWorkbench();
  const o = (unwrap(call.output) ?? {}) as { command?: string; ok?: boolean; output?: string; error?: string };
  return (
    <section className="gen-card netcheck" data-state={o.ok ? "ok" : "failed"} aria-label={`بررسی شبکه: ${o.command ?? ""}`}>
      <header className="gen-head">
        <Network size={14} aria-hidden />
        <span className="gen-title ltr" dir="ltr">
          {o.command}
        </span>
        <button type="button" className="btn btn-ghost" style={{ height: 24, marginInlineStart: "auto" }} onClick={wb.openNet}>
          تب شبکه
        </button>
      </header>
      <pre className="ltr" dir="ltr">
        {o.output ?? o.error}
      </pre>
    </section>
  );
}
