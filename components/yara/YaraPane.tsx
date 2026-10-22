"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from "ai";
import { Activity, ArrowLeft, ArrowUp, Boxes, CircleAlert, Globe, RotateCcw, ShieldCheck, Square, SquareTerminal, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isAction } from "@/lib/action-meta";
import { faTime } from "@/lib/fa";
import { Markdown } from "../Markdown";
import { Approval } from "./Approval";
import { Steps, toolNameOf, type ToolPartLike } from "./Evidence";
import { LogoMark } from "./Logo";
import { useWorkbench } from "./Workbench";

const SUGGESTIONS = [
  { icon: Boxes, text: "وضعیت همه‌ی برنامه‌هایم را بررسی کن و هر مشکلی دیدی بگو" },
  { icon: CircleAlert, text: "برنامه‌ام بعد از آخرین استقرار خطای ۵۰۲ می‌دهد؛ علتش را پیدا کن" },
  { icon: SquareTerminal, text: "فضای دیسک و پروسه‌های در حال اجرای برنامه‌ام را از داخل کانتینر بررسی کن" },
  { icon: Activity, text: "مصرف پردازنده و حافظه‌ی ۲۴ ساعت اخیر را ببین؛ پلن بزرگ‌تری لازم دارم؟" },
  { icon: Workflow, text: "برای برنامه‌ی Next.js من liara.json و یک workflow برای GitHub Actions بنویس" },
  { icon: Globe, text: "دامنه‌ی example.com را به برنامه‌ام وصل کن و برایش SSL بگیر" },
];

type Meta = { createdAt?: number };
type Msg = UIMessage<Meta>;

const isTool = (p: { type: string }) => p.type.startsWith("tool-");

function errorText(e: Error | undefined) {
  if (!e) return "";
  try {
    return JSON.parse(e.message).error ?? e.message;
  } catch {
    return e.message || "مشکلی پیش آمد.";
  }
}

function pendingApprovals(messages: Msg[]) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return 0;
  return last.parts.filter((p) => isTool(p) && isAction(toolNameOf(p)) && (p as ToolPartLike).state === "input-available").length;
}

export function YaraPane({
  chatId,
  initialMessages,
  ask,
  onAskConsumed,
}: {
  chatId: string;
  initialMessages: Msg[];
  ask: { text: string; send: boolean; nonce: number } | null;
  onAskConsumed: () => void;
}) {
  const wb = useWorkbench();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  // Approvals restored from history never grab focus; only ones that arrive live do.
  const restoredIds = useRef(new Set(initialMessages.map((m) => m.id)));

  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), []);
  const { messages, sendMessage, status, stop, error, clearError, regenerate, addToolResult } = useChat<Msg>({
    id: chatId,
    messages: initialMessages,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  const busy = status === "submitted" || status === "streaming";
  const pending = pendingApprovals(messages);

  useEffect(() => wb.setPending(pending), [pending, wb]);
  useEffect(() => () => wb.setPending(0), [wb]);

  useEffect(() => {
    if (status === "ready" && messages.length > 1) wb.refreshCases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // A request handed over from the editor (e.g. "investigate this app").
  useEffect(() => {
    if (!ask) return;
    if (ask.send) send(ask.text);
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
  }, [messages, status]);

  // A pending approval restored from history opens with its header (risk, title) in view.
  useEffect(() => {
    const el = scrollRef.current;
    const card = el?.querySelector<HTMLElement>('.approval[data-state="pending"]');
    if (el && card) {
      stick.current = false;
      el.scrollTop = card.offsetTop - el.offsetTop - 12;
    }
  }, []);

  function send(text: string) {
    const t = text.trim();
    if (!t || busy || pending) return;
    stick.current = true;
    sendMessage({ text: t, metadata: { createdAt: Date.now() } });
    setInput("");
  }

  const resolve = async (part: ToolPartLike, approved: boolean) => {
    const tool = toolNameOf(part);
    if (!approved) {
      addToolResult({ tool, toolCallId: part.toolCallId, output: { denied: true, at: Date.now(), message: "The user denied this action. Nothing was changed." } });
      return;
    }
    let output: Record<string, unknown> | null = null;
    // Shell commands run in the user's own Console, in view; the background exec is the fallback.
    if (tool === "runShellCommand") {
      const input = part.input as { app: string; command: string };
      try {
        const result = await wb.runInConsole(input.app, input.command);
        output = { ok: true, result };
      } catch {
        output = null;
      }
    }
    if (!output) {
      try {
        const res = await fetch("/api/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: tool, input: part.input }),
        });
        output = await res.json();
      } catch (e) {
        output = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    addToolResult({ tool, toolCallId: part.toolCallId, output: { ...output, at: Date.now() } });
    wb.refreshApps();
  };

  const lastId = messages[messages.length - 1]?.id;

  return (
    <div className="yara-pane">
      <div
        className="scroll"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        <div className="thread" aria-live="polite" aria-busy={busy}>
          {messages.length === 0 ? (
            <div className="empty">
              <div>
                <h1>از یارا بپرسید</h1>
                <p className="muted">لاگ، استقرار، مصرف منابع و حتی داخل کانتینر را بررسی می‌کند. هر تغییری پیش از اجرا برای تأیید شما می‌آید.</p>
              </div>
              <div className="suggest">
                {SUGGESTIONS.map(({ icon: Icon, text }) => (
                  <button type="button" key={text} onClick={() => send(text)}>
                    <Icon size={15} aria-hidden />
                    <span>{text}</span>
                    <ArrowLeft size={14} className="go" aria-hidden />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => {
              if (m.role === "user") {
                const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
                return (
                  <div key={m.id} className="turn-user" title={m.metadata?.createdAt ? faTime(m.metadata.createdAt) : undefined}>
                    <Markdown text={text} />
                  </div>
                );
              }
              const blocks: React.ReactNode[] = [];
              let run: ToolPartLike[] = [];
              const flush = (key: string) => {
                if (run.length) blocks.push(<Steps key={key} parts={run} />);
                run = [];
              };
              m.parts.forEach((part, i) => {
                if (isTool(part)) {
                  const name = toolNameOf(part);
                  if (isAction(name)) {
                    flush(`s-${i}`);
                    blocks.push(
                      <Approval
                        key={`a-${i}`}
                        part={part as unknown as ToolPartLike}
                        name={name}
                        autoFocus={m.id === lastId && !restoredIds.current.has(m.id)}
                        onResolve={(ok) => resolve(part as unknown as ToolPartLike, ok)}
                      />,
                    );
                  } else run.push(part as unknown as ToolPartLike);
                  return;
                }
                if (part.type === "text" && part.text.trim()) {
                  flush(`s-${i}`);
                  blocks.push(<Markdown key={`t-${i}`} text={part.text} />);
                } else if (part.type === "reasoning" && part.text.trim()) {
                  flush(`s-${i}`);
                  blocks.push(
                    <details key={`r-${i}`} className="reasoning">
                      <summary>روند فکر یارا</summary>
                      <Markdown text={part.text} />
                    </details>,
                  );
                }
              });
              flush("s-end");
              if (!blocks.length) return null;
              return (
                <div key={m.id} className="turn-ai">
                  <LogoMark size={24} />
                  <div className="turn-ai-body">{blocks}</div>
                </div>
              );
            })
          )}

          {busy && (
            <div className="turn-ai">
              <LogoMark size={24} />
              <div className="thinking" role="status">
                <span className="pulse">یارا در حال بررسی است…</span>
              </div>
            </div>
          )}

          {error && (
            <div className="alert" role="alert">
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <CircleAlert size={16} aria-hidden />
                {errorText(error)}
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  clearError();
                  regenerate();
                }}
              >
                <RotateCcw size={14} aria-hidden />
                تلاش دوباره
              </button>
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
        {pending > 0 && (
          <p className="composer-note">
            <ShieldCheck size={14} aria-hidden />
            برای ادامه، تغییر پیشنهادی بالا را تأیید یا رد کنید.
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
              placeholder={messages.length ? "پیام بعدی…" : "مشکل یا کاری که دارید را بنویسید…"}
              rows={1}
              dir="auto"
              disabled={pending > 0}
            />
            {busy ? (
              <button type="button" className="btn send" onClick={() => stop()} aria-label="توقف">
                <Square size={13} fill="currentColor" aria-hidden />
              </button>
            ) : (
              <button type="submit" className="btn btn-primary send" disabled={!input.trim() || pending > 0} aria-label="ارسال">
                <ArrowUp size={17} aria-hidden />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
