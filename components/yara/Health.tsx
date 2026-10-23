"use client";

// One vocabulary for app health across the workbench: Overview, the app page, Monitoring and the chat's
// diagnosis card all show the same status words, the same ranked causes and the same "fix with Yara" handoff.

import { Bot, Eye, Wrench } from "lucide-react";
import { faDigits, faNum } from "@/lib/fa";

export type HealthStatus = "healthy" | "degraded" | "down" | "off" | "unknown";
export type Cause = { id: string; title: string; confidence: number; evidence: string[]; fix: string; owner?: string; autoHeal?: string };

export const HEALTH: Record<HealthStatus, { label: string; cls: string; dot: string }> = {
  healthy: { label: "سالم", cls: "pill-ok", dot: "up" },
  degraded: { label: "مشکل‌دار", cls: "pill-warn", dot: "warn" },
  down: { label: "از دسترس خارج", cls: "pill-danger", dot: "down" },
  off: { label: "خاموش", cls: "", dot: "" },
  unknown: { label: "نامشخص", cls: "", dot: "" },
};

export function HealthPill({ status }: { status: HealthStatus }) {
  const h = HEALTH[status] ?? HEALTH.unknown;
  return <span className={`pill ${h.cls}`}>{h.label}</span>;
}

/** Likely causes, most likely first, each with its evidence and fix. `limit` keeps chat cards short. */
export function CauseList({ causes, limit = 4 }: { causes: Cause[]; limit?: number }) {
  if (!causes.length) return null;
  return (
    <ol className="mon-causes" aria-label="علت‌های محتمل، از محتمل‌ترین">
      {causes.slice(0, limit).map((c, i) => (
        <li key={c.id} data-top={i === 0 || undefined}>
          <div className="mon-cause-head">
            <span className="mon-rank num">{faDigits(i + 1)}</span>
            <b>{c.title}</b>
            <span className="mon-conf" title="میزان اطمینان یارا به این علت">
              <span className="meter" aria-hidden>
                <i className={c.confidence >= 0.75 ? "crit" : c.confidence >= 0.55 ? "hot" : ""} style={{ width: `${Math.round(c.confidence * 100)}%` }} />
              </span>
              <span className="num small">اطمینان {faNum(Math.round(c.confidence * 100))}٪</span>
            </span>
          </div>
          <ul className="mon-evidence" aria-label="شواهد">
            {c.evidence.map((e, j) => (
              <li key={j} dir="auto">
                <Eye size={11} aria-hidden /> {e}
              </li>
            ))}
          </ul>
          <p className="mon-fix">
            <Wrench size={12} aria-hidden /> <span>{c.fix}</span>
          </p>
        </li>
      ))}
    </ol>
  );
}

/**
 * What "Fix with Yara" sends: a short Persian sentence the user sees as their own message,
 * plus the monitor's findings as hidden context for the agents (never shown as the user's words).
 */
export function fixRequest(app: string, summary: string, causes: Cause[], incidentId?: string) {
  const top = causes[0];
  const text = top ? `${app} مشکل دارد (${top.title}). علت را تأیید کن و رفعش کن.` : `${app} مشکل دارد. علتش را پیدا کن و رفعش کن.`;
  const context = [
    `Monitoring findings for app "${app}"${incidentId ? ` (incident ${incidentId})` : ""}: ${summary}`,
    ...causes.slice(0, 3).map((c, i) => `${i + 1}. ${c.title} (confidence ${Math.round(c.confidence * 100)}%). Evidence: ${c.evidence.join(" ")} Suggested fix: ${c.fix}`),
    "Confirm with diagnoseApp before changing anything, propose the fix that matches the top cause, and after the change show that the site serves again.",
  ].join("\n");
  return { text, context };
}

type BannerIncident = { id: string; app: string; title: string; severity: "critical" | "warning"; causes: Cause[]; openedAt: number; escalated?: boolean };

/** Open incidents at the top of a page: what is wrong, since when, and the one obvious next step. */
export function IncidentBanner({ incidents, onFix, relative }: { incidents: BannerIncident[]; onFix: (i: BannerIncident) => void; relative: (t: number) => string }) {
  if (!incidents.length) return null;
  return (
    <div className="inc-banner-list" role="region" aria-label="حادثه‌های باز">
      {incidents.map((i) => (
        <div key={i.id} className="inc-banner" data-severity={i.severity} role="alert">
          <span className={`dot ${i.severity === "critical" ? "down" : "warn"}`} aria-hidden />
          <div className="inc-banner-text">
            <b>
              <span className="ltr">{i.app}</span> · {i.severity === "critical" ? "از دسترس خارج" : "مشکل‌دار"}
              {i.escalated && <span className="pill pill-danger">نیاز به شما</span>}
            </b>
            <span className="small muted">
              {i.causes[0] ? `محتمل‌ترین علت: ${i.causes[0].title}` : i.title} · از {relative(i.openedAt)}
            </span>
          </div>
          <span className="inc-banner-actions">
            <a href="/app/monitoring" className="btn btn-ghost" style={{ height: 28 }}>
              علت‌ها
            </a>
            <FixButton compact onClick={() => onFix(i)} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function FixButton({ onClick, label = "رفع با یارا", compact }: { onClick: () => void; label?: string; compact?: boolean }) {
  return (
    <button type="button" className="btn btn-primary" style={compact ? { height: 28 } : undefined} onClick={onClick}>
      <Bot size={compact ? 13 : 14} aria-hidden /> {label}
    </button>
  );
}
