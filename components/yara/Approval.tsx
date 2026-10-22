"use client";

import { Ban, CircleAlert, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACTION_META, RISK_LABEL } from "@/lib/action-meta";
import { faTime } from "@/lib/fa";
import { Markdown } from "../Markdown";
import type { ToolPartLike } from "./Evidence";
import { useModKey } from "./useModKey";

export type ApprovalOutput = { ok?: boolean; error?: string; denied?: boolean; result?: unknown; at?: number };

function DrawnCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" className="check-draw" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A change Yara proposes. Nothing runs until the user approves it here.
 * Ctrl/⌘+Enter approves the focused (or only pending) card.
 */
export function Approval({ part, name, autoFocus, onResolve }: { part: ToolPartLike; name: string; autoFocus?: boolean; onResolve: (approved: boolean) => Promise<void> }) {
  const meta = ACTION_META[name];
  const input = (part.input ?? {}) as Record<string, any>;
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [typed, setTyped] = useState("");
  const [fresh, setFresh] = useState(false);
  const approveRef = useRef<HTMLButtonElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const mod = useModKey();
  const confirmRef = useRef<HTMLInputElement>(null);
  const expected = meta?.confirmText?.(input);
  const output = part.output as ApprovalOutput | undefined;
  const risk = meta?.risk ?? "medium";
  const pending = part.state === "input-available";
  const preparing = part.state === "input-streaming";
  const canApprove = !busy && (!expected || typed === expected);

  const state = preparing ? "preparing" : pending ? "pending" : part.state === "output-error" ? "failed" : output?.denied ? "denied" : output?.ok ? "approved" : "failed";

  useEffect(() => {
    if (pending && autoFocus) (expected ? confirmRef.current : approveRef.current)?.focus({ preventScroll: true });
  }, [pending, autoFocus, expected]);

  const decide = async (approved: boolean) => {
    if (approved && !canApprove) return;
    setBusy(approved ? "approve" : "deny");
    try {
      await onResolve(approved);
      setFresh(true);
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!pending) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      decide(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      denyRef.current?.focus();
    }
  };

  let target = "";
  try {
    target = meta ? String(meta.target(input) ?? "") : "";
  } catch {
    target = "";
  }

  return (
    <section className="approval" data-state={state} onKeyDown={onKeyDown} aria-label={`درخواست تأیید: ${meta?.label ?? name}`}>
      <header className="approval-head">
        <span className="kicker">
          {risk === "high" ? <ShieldAlert size={15} aria-hidden /> : <ShieldCheck size={15} aria-hidden />}
          {state === "pending" || state === "preparing" ? "نیاز به تأیید شما" : "تغییر پیشنهادی"}
        </span>
        <span className={`pill ${risk === "high" ? "pill-danger" : risk === "medium" ? "pill-warn" : "pill-ok"}`}>{RISK_LABEL[risk]}</span>
      </header>

      <div className="approval-main">
        <div className="approval-title">
          <span>{meta?.label ?? name}</span>
          {target && <span className="target">{target}</span>}
        </div>
        {preparing ? <p className="faint small">در حال آماده‌سازی…</p> : <Markdown text={meta ? meta.summary(input) : `\`${name}\``} />}
        {!preparing && (
          <details>
            <summary>جزئیات درخواست</summary>
            <pre className="json">{JSON.stringify(input, null, 2)}</pre>
          </details>
        )}
        {pending && expected && (
          <label className="confirm-field" style={{ marginTop: 4 }}>
            <span className="small muted">
              برای تأیید، <code className="ltr">{expected}</code> را تایپ کنید
            </span>
            <input
              ref={confirmRef}
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={typed.length > 0 && typed !== expected}
            />
          </label>
        )}
      </div>

      <footer className="approval-foot">
        {pending ? (
          <>
            <span className="approval-note">
              تا تأیید نکنید، چیزی تغییر نمی‌کند. <kbd className="hide-touch">{mod}</kbd>
              <kbd className="hide-touch">↵</kbd>
              <span className="hide-touch"> برای تأیید</span>
            </span>
            <div className="approval-actions">
              <button ref={denyRef} type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => decide(false)}>
                <X size={15} aria-hidden />
                رد کردن
              </button>
              <button ref={approveRef} type="button" className={`btn ${risk === "high" ? "btn-danger" : "btn-primary"}`} disabled={!canApprove} onClick={() => decide(true)}>
                {busy === "approve" ? "در حال اجرا…" : "تأیید و اجرا"}
              </button>
            </div>
          </>
        ) : state === "approved" ? (
          <div className="approval-result">
            <span className="pill pill-ok">
              {fresh ? <DrawnCheck /> : <ShieldCheck size={13} aria-hidden />}
              تأیید و اجرا شد
            </span>
            {output?.at && <span className="faint small num">{faTime(output.at)}</span>}
          </div>
        ) : state === "denied" ? (
          <div className="approval-result">
            <span className="pill">
              <Ban size={13} aria-hidden />
              رد شد، چیزی تغییر نکرد
            </span>
            {output?.at && <span className="faint small num">{faTime(output.at)}</span>}
          </div>
        ) : state === "failed" ? (
          <div className="approval-result" style={{ color: "var(--danger)" }}>
            <CircleAlert size={15} aria-hidden />
            <span>
              اجرا ناموفق بود: <span className="ltr">{output?.error ?? part.errorText ?? "خطای نامشخص"}</span>
            </span>
          </div>
        ) : (
          <span className="approval-note">…</span>
        )}
      </footer>
    </section>
  );
}
