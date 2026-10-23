"use client";

import { Activity, ArrowLeft, ArrowRightLeft, ArrowUp, CircleAlert, Eye, FolderGit2, Gauge, Globe, Laptop, RefreshCw, Rocket, RotateCcw, ShieldCheck, Siren, Square, Stethoscope, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { faDigits } from "@/lib/fa";
import { toolLabel } from "@/lib/tool-labels";
import { Markdown } from "../../Markdown";
import { Steps, type ToolPartLike } from "../Evidence";
import { fixRequest } from "../Health";
import { LogoMark } from "../Logo";
import { useWorkbench } from "../Workbench";
import { AGENTS, AgentChip, ApprovalCard, BlockedCard, CommandCard, DeployCard, DiagnosisCard, EditCard, NetCard, PlanCard, ProbeCard } from "./Cards";
import { DomainCard } from "./DomainCard";
import { fromEvents, pendingCall, readEvents, reduce, type AgentEvent, type AgentId, type Call, type Item, type Timeline } from "./timeline";

type Suggestion = { icon: LucideIcon; text: string; context?: string; urgent?: boolean };

// Short, in the user's words, led by the brief's own scenario: a broken or slow site.
const SUGGESTIONS: Suggestion[] = [
  { icon: CircleAlert, text: "سایتم خطای ۵۰۰ می‌دهد؛ علتش را پیدا کن" },
  { icon: Gauge, text: "سایتم کند شده؛ مشکل از کجاست؟" },
  { icon: Activity, text: "برنامه‌هایم در چه وضعی‌اند؟" },
  { icon: Rocket, text: "این پروژه را روی لیارا مستقر کن" },
  { icon: Globe, text: "دامنه‌ام را وصل کن و SSL بگیر" },
];

// Tools with their own generative card; everything else read-only shows up in the steps list.
const CARD_TOOLS = new Set(["updatePlan", "runCommand", "runVmCommand", "deployWorkspace", "editFile", "writeFile"]);

/** Handoffs already sent. Module-level so a remount (Strict Mode, a chat-id change) never sends the same request twice. */
const consumedAsks = new Set<number>();

type WorkspaceInfo = { id: string; kind: "github" | "local"; label: string; online: boolean };

const toPart = (c: Call): ToolPartLike => ({
  type: `tool-${c.name}`,
  toolCallId: c.id,
  state: !c.done ? "input-available" : c.error ? "output-error" : "output-available",
  input: c.args,
  output: c.output,
  errorText: c.error ? String((c.output as any)?.error ?? "خطا") : undefined,
});

/** "now: reading shop's logs · 12s": what the team is doing this moment, in words. */
function activity(tl: Timeline) {
  const running = [...tl.items].reverse().find((i): i is Extract<Item, { k: "call" }> => i.k === "call" && !i.call.done && !!i.call.name && i.call.decision !== "pending");
  if (running) return toolLabel(running.call.name, running.call.args);
  const last = tl.items[tl.items.length - 1];
  if (last?.k === "text") return "در حال نوشتن پاسخ";
  if (last?.k === "handoff") return `${AGENTS[last.to]?.label ?? last.to} کار را دست گرفت`;
  return "در حال فکر کردن";
}

export function AgentPane({
  chatId,
  initialEvents,
  ask,
  onAskConsumed,
  app,
}: {
  chatId: string;
  initialEvents: AgentEvent[];
  ask: { text: string; send: boolean; nonce: number; context?: string } | null;
  onAskConsumed: () => void;
  app?: string;
}) {
  const wb = useWorkbench();
  const [tl, setTl] = useState<Timeline>(() => fromEvents(initialEvents));
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [fail, setFail] = useState("");
  const [input, setInput] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const restored = useRef(new Set(Object.keys(tl.calls)));
  const lastBody = useRef<Record<string, unknown> | null>(null);

  const pending = pendingCall(tl);

  useEffect(() => wb.setPending(pending ? 1 : 0), [pending, wb]);
  useEffect(() => () => wb.setPending(0), [wb]);

  // Elapsed time while the team works, so a long investigation never looks frozen.
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await fetch("/api/workspaces");
      if (!res.ok) return;
      const list = (await res.json()).workspaces as WorkspaceInfo[];
      setWorkspaces(list);
      setWorkspaceId((cur) => {
        if (cur && list.some((w) => w.id === cur)) return cur;
        let saved = "";
        try {
          saved = localStorage.getItem("yara:workspace") ?? "";
        } catch {
          // storage unavailable
        }
        return list.find((w) => w.id === saved)?.id ?? list[0]?.id ?? "";
      });
    } catch {
      // offline; keep the last list
    }
  }, []);

  useEffect(() => {
    loadWorkspaces();
    const onFocus = () => loadWorkspaces();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadWorkspaces]);

  const pickWorkspace = (id: string) => {
    setWorkspaceId(id);
    try {
      localStorage.setItem("yara:workspace", id);
    } catch {
      // storage unavailable
    }
  };

  const run = useCallback(
    async (body: Record<string, unknown>) => {
      lastBody.current = body;
      setBusy(true);
      setStartedAt(Date.now());
      setFail("");
      let wrote = false;
      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId: chatId, app: app || undefined, workspaceId: workspaceId || undefined, ...body }),
        });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "درخواست به یارا نرسید.");
        }
        for await (const ev of readEvents(res)) {
          if (ev.t === "done") break;
          if (ev.t === "result" && (ev.output as any)?.ok) wrote = true;
          // Yara's commands on a VM stream into that VM's Console tab, in view.
          if (ev.t === "ui" && ev.component === "command" && typeof ev.props?.vm === "string") wb.showVmCommand(ev.id, ev.props.vm as string, ev.props as never);
          // Yara's network checks also land in the Network tab, in view, like its console commands.
          if (ev.t === "result" && ev.name === "netCheck" && (ev.output as any)?.command) {
            const o = ev.output as { command: string; ok: boolean; output: string };
            wb.showNet({ command: o.command, ok: o.ok, output: o.output });
          }
          setTl((t) => reduce(t, ev));
        }
      } catch (e) {
        setFail(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        setStopping(false);
        wb.refreshCases();
        if (wrote) {
          wb.refreshApps();
          wb.refreshHealth();
        }
      }
    },
    [chatId, app, workspaceId, wb],
  );

  const send = useCallback(
    (text: string, context?: string) => {
      const t = text.trim();
      if (!t || busy || pendingCall(tl)) return;
      stick.current = true;
      setTl((cur) => reduce(cur, { t: "text", agent: "user", id: `u-${Date.now()}`, delta: t }));
      setInput("");
      run({ message: t, context });
    },
    [busy, tl, run],
  );

  const stop = async () => {
    setStopping(true);
    await fetch(`/api/agent?threadId=${encodeURIComponent(chatId)}`, { method: "DELETE" }).catch(() => {});
  };

  const decide = async (approved: boolean, confirmText?: string) => {
    const c = pendingCall(tl);
    if (!c) return;
    stick.current = true;
    setTl((cur) => ({ ...cur, calls: { ...cur.calls, [c.id]: { ...c, decision: approved ? "approved" : "denied" } }, items: cur.items.map((it) => (it.k === "call" && it.call.id === c.id ? { k: "call", call: { ...c, decision: approved ? "approved" : "denied" } } : it)) }));
    await run({ resume: { approved, confirmText } });
  };

  const goToApproval = () => {
    const card = scrollRef.current?.querySelector<HTMLElement>('.agent-approval[data-state="pending"]');
    card?.scrollIntoView({ block: "center", behavior: "smooth" });
    card?.querySelector<HTMLElement>(".confirm-field input, .approval-actions .btn-primary, .approval-actions .btn-danger")?.focus({ preventScroll: true });
  };

  // A request handed over from the editor (e.g. "fix this incident"), with its hidden context.
  useEffect(() => {
    if (!ask || consumedAsks.has(ask.nonce)) return;
    consumedAsks.add(ask.nonce);
    if (ask.send) send(ask.text, ask.context);
    else {
      setInput(ask.text);
      inputRef.current?.focus();
    }
    onAskConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.nonce]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [tl, busy, fail]);

  const lastItem = tl.items[tl.items.length - 1];
  const blocks = useMemo(() => renderItems(tl, decide, restored.current, busy), [tl, run, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeAgent = [...tl.items].reverse().find((i): i is Extract<Item, { k: "text" | "call" }> => i.k === "call" || i.k === "text");
  const workingAgent: AgentId = activeAgent?.k === "call" ? activeAgent.call.agent : activeAgent?.k === "text" ? activeAgent.agent : "supervisor";
  const ws = workspaces.find((w) => w.id === workspaceId);
  const seconds = busy && startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;

  // Suggestions that know the account: an open incident (or the open app) comes first.
  const suggestions = useMemo(() => {
    const live: Suggestion[] = wb.incidents.slice(0, 2).map((i) => {
      const r = fixRequest(i.app, i.title, i.causes, i.id);
      return { icon: Siren, text: `${i.app} ${i.severity === "critical" ? "از دسترس خارج است" : "مشکل دارد"}؛ رفعش کن`, context: r.context, urgent: true };
    });
    if (app && !live.some((s) => s.text.startsWith(app))) live.push({ icon: Stethoscope, text: `${app} را معاینه کن؛ سالم است؟` });
    return [...live, ...SUGGESTIONS].slice(0, 5);
  }, [wb.incidents, app]);

  return (
    <div className="yara-pane agent-pane">
      <div
        className="scroll"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        <div className="thread" aria-live="polite" aria-busy={busy}>
          {tl.items.length === 0 ? (
            <div className="empty">
              <div>
                <h1>چه مشکلی پیش آمده؟</h1>
                <p className="muted">به زبان خودتان بنویسید، مثل «سایتم کند شده». یارا لاگ‌ها، مصرف منابع و پاسخ سایت را خودش می‌خواند و علت را با شاهد نشان می‌دهد.</p>
              </div>
              <ul className="trust-legend" aria-label="یارا چه کار می‌کند و چه کار نمی‌کند">
                <li>
                  <Eye size={14} aria-hidden /> بررسی‌ها خودکار و فقط خواندنی‌اند
                </li>
                <li>
                  <ShieldCheck size={14} aria-hidden /> هر تغییر اول برای تأیید شما می‌آید
                </li>
                <li>
                  <RotateCcw size={14} aria-hidden /> بعد از هر تغییر، نتیجه را می‌سنجد
                </li>
              </ul>
              <div className="suggest">
                {suggestions.map(({ icon: Icon, text, context, urgent }) => (
                  <button type="button" key={text} onClick={() => send(text, context)} data-urgent={urgent || undefined}>
                    <Icon size={15} aria-hidden />
                    <span>{text}</span>
                    <ArrowLeft size={14} className="go" aria-hidden />
                  </button>
                ))}
              </div>
              <details className="how-yara">
                <summary>یارا چطور کار می‌کند؟</summary>
                <p className="muted small">
                  پشت یارا یک تیم کوچک است: هماهنگ‌کننده درخواست شما را می‌فهمد و به متخصص درست می‌سپارد. استقرار کد را منتشر می‌کند، اشکال‌زدایی باگ را در کد پیدا و اصلاح می‌کند، عملیات منابع لیارا را مدیریت می‌کند و پایش خودکار برنامه‌ها را مدام زیر نظر دارد.
                </p>
                <div className="agent-roster" aria-label="عامل‌ها">
                  {(Object.keys(AGENTS) as AgentId[]).map((a) => (
                    <AgentChip key={a} agent={a} />
                  ))}
                </div>
              </details>
            </div>
          ) : (
            blocks
          )}

          {busy && !pending && (
            <div className="turn-ai">
              <LogoMark size={24} />
              <div className="thinking" role="status">
                <AgentChip agent={workingAgent} />
                <span className="pulse">{stopping ? "در حال توقف…" : `${activity(tl)}…`}</span>
                <span className="num faint small">{faDigits(seconds)} ثانیه</span>
                <button type="button" className="btn btn-ghost stop-btn" onClick={stop} disabled={stopping} title="توقف کار یارا">
                  <Square size={11} fill="currentColor" aria-hidden /> توقف
                </button>
              </div>
            </div>
          )}

          {!busy && lastItem?.k === "error" && !pending && (
            <div className="recover">
              <span className="small muted">کارهایی که تمام شده بود سر جایش است.</span>
              <button type="button" className="btn" onClick={() => send("ادامه بده")}>
                <RefreshCw size={13} aria-hidden /> ادامه بده
              </button>
            </div>
          )}

          {fail && !busy && (
            <div className="fail-card" role="alert">
              <CircleAlert size={18} aria-hidden />
              <div>
                <b>{fail}</b>
                <p className="small muted">هیچ تغییری در حساب لیارای شما انجام نشد. وضعیت برنامه‌ها را بدون یارا هم می‌توانید در صفحه‌ی پایش ببینید.</p>
                <div className="toolbar" style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-primary" onClick={() => lastBody.current && run(lastBody.current)}>
                    <RefreshCw size={13} aria-hidden /> تلاش دوباره
                  </button>
                  <Link href="/app/monitoring" className="btn btn-ghost">
                    <Activity size={13} aria-hidden /> صفحه‌ی پایش
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        {pending && (
          <p className="composer-note">
            <ShieldCheck size={14} aria-hidden />
            <span>یارا منتظر تصمیم شماست. اگر سؤالی دارید، رد کنید و بپرسید؛ چیزی تغییر نمی‌کند.</span>
            <button type="button" className="link" onClick={goToApproval}>
              رفتن به درخواست
            </button>
          </p>
        )}
        <div className="composer-box">
          <label htmlFor={`composer-${chatId}`} className="visually-hidden">
            پیام به یارا
          </label>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 6, paddingInlineEnd: 6, paddingBottom: 6 }}>
            <textarea
              id={`composer-${chatId}`}
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder={pending ? "اول درخواست بالا را تأیید یا رد کنید" : tl.items.length ? "پیام بعدی…" : "مثلاً: سایتم از صبح کند شده"}
              rows={1}
              dir="auto"
              disabled={!!pending}
            />
            <button type="submit" className="btn btn-primary send" disabled={!input.trim() || !!pending || busy} aria-label="ارسال">
              <ArrowUp size={17} aria-hidden />
            </button>
          </div>
          {(workspaces.length > 0 || app) && (
            <div className="composer-ctx">
              {workspaces.length > 0 && (
                <label className="ws-pick" title={ws ? `کد: ${ws.label}` : "یارا بدون دسترسی به کد کار می‌کند"}>
                  {ws?.kind === "github" ? <FolderGit2 size={13} aria-hidden /> : <Laptop size={13} aria-hidden />}
                  <span className="visually-hidden">کدی که یارا می‌تواند بخواند</span>
                  <select value={workspaceId} onChange={(e) => pickWorkspace(e.target.value)} disabled={busy}>
                    <option value="">بدون دسترسی به کد</option>
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id} disabled={!w.online}>
                        {w.kind === "github" ? w.label : w.label.split(": ").pop()?.split(/[\\/]/).pop()}
                        {w.online ? "" : " (آفلاین)"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {app && (
                <span className="ctx-chip ltr" dir="ltr" title="یارا درباره‌ی همین برنامه کار می‌کند">
                  {app}
                </span>
              )}
            </div>
          )}
        </div>
      </form>
    </div>
  );
}

function renderItems(tl: Timeline, decide: (approved: boolean, confirmText?: string) => Promise<void>, restored: Set<string>, busy: boolean) {
  const out: React.ReactNode[] = [];
  const lastPlan = [...tl.items].reverse().find((i) => i.k === "call" && i.call.name === "updatePlan");
  let reads: Call[] = [];
  let group: React.ReactNode[] = [];
  let groupAgent: AgentId | null = null;
  let groupKey = "";

  // Automatic, read-only checks are labelled as such, so they never read like changes.
  const flushReads = () => {
    if (reads.length)
      group.push(
        <div key={`s-${reads[0].id}`} className="steps-group">
          <p className="steps-cap">
            <Eye size={12} aria-hidden /> بررسی خودکار · فقط خواندنی، چیزی تغییر نکرد
          </p>
          <Steps parts={reads.map(toPart)} />
        </div>,
      );
    reads = [];
  };
  const flushGroup = () => {
    flushReads();
    if (group.length && groupAgent) {
      out.push(
        <div key={`g-${groupKey}`} className="turn-ai agent-turn">
          <LogoMark size={24} />
          <div className="turn-ai-body">
            <AgentChip agent={groupAgent} />
            {group}
          </div>
        </div>,
      );
    }
    group = [];
    groupAgent = null;
  };
  const into = (agent: AgentId, key: string) => {
    if (groupAgent !== agent) {
      flushGroup();
      groupAgent = agent;
      groupKey = key;
    }
  };

  for (const it of tl.items) {
    if (it.k === "user") {
      flushGroup();
      out.push(
        <div key={it.id} className="turn-user">
          <Markdown text={it.text} />
        </div>,
      );
    } else if (it.k === "handoff") {
      flushGroup();
      const To = AGENTS[it.to]?.icon ?? ArrowRightLeft;
      out.push(
        <details key={it.id} className="handoff">
          <summary>
            <ArrowRightLeft size={13} aria-hidden />
            <span>
              {AGENTS[it.from]?.label ?? it.from} کار را به <b>{AGENTS[it.to]?.label ?? it.to}</b> سپرد
            </span>
            <To size={13} aria-hidden />
          </summary>
          <p dir="auto">{it.task}</p>
        </details>,
      );
    } else if (it.k === "error") {
      flushGroup();
      out.push(
        <div key={it.id} className="alert" role="alert">
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <CircleAlert size={16} aria-hidden />
            <span dir="auto">{it.message}</span>
          </span>
        </div>,
      );
    } else if (it.k === "text") {
      if (!it.text.trim()) continue;
      into(it.agent, it.id);
      flushReads();
      group.push(<Markdown key={`t-${it.id}`} text={it.text} />);
    } else {
      const c = it.call;
      if (!c.name) continue;
      into(c.agent, c.id);
      if ((c.output as any)?.blocked) {
        flushReads();
        group.push(<BlockedCard key={`b-${c.id}`} call={c} />);
        continue;
      }
      // Finished health checks get their own card: the ranked diagnosis is the answer, not a log entry.
      if (c.done && !c.error && c.name === "diagnoseApp" && (c.output as any)?.health) {
        flushReads();
        group.push(<DiagnosisCard key={c.id} call={c} />);
        continue;
      }
      if (c.done && !c.error && c.name === "domainGuide" && (c.output as any)?.steps) {
        flushReads();
        group.push(<DomainCard key={c.id} call={c} />);
        continue;
      }
      if (c.done && c.name === "netCheck" && (c.output as any)?.command) {
        flushReads();
        group.push(<NetCard key={c.id} call={c} />);
        continue;
      }
      if (c.done && !c.error && c.name === "probeApp" && (c.output as any)?.samples) {
        flushReads();
        group.push(<ProbeCard key={c.id} call={c} />);
        continue;
      }
      const special = CARD_TOOLS.has(c.name);
      if (!special && !c.approval) {
        reads.push(c);
        continue;
      }
      flushReads();
      if (c.name === "updatePlan") {
        if (it === lastPlan) group.push(<PlanCard key={c.id} steps={(c.args.steps ?? []) as never} agent={c.agent} live={busy} />);
        continue;
      }
      // Pending, denied or failed approvals show the full request; approved ones collapse into their result card.
      const showApproval = c.approval && (c.decision !== "approved" || !special || (c.done && !!(c.output as any)?.error));
      if (showApproval) group.push(<ApprovalCard key={`a-${c.id}`} call={c} onDecide={decide} autoFocus={!restored.has(c.id)} />);
      if (c.name === "runCommand" || c.name === "runVmCommand") group.push(<CommandCard key={c.id} call={c} />);
      else if (c.name === "deployWorkspace") group.push(<DeployCard key={c.id} call={c} />);
      else if (c.name === "editFile" || c.name === "writeFile") group.push(<EditCard key={c.id} call={c} />);
    }
  }
  flushGroup();
  return out;
}
