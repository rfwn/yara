"use client";

import { Ban, Check, CircleAlert, Download, LoaderCircle, RefreshCw, RotateCcw, ShieldCheck, ShieldX, Zap } from "lucide-react";
import { Fragment, useState } from "react";
import { faDigits, faTime, relativeFa } from "@/lib/fa";
import { AgentChip } from "./agent/Cards";
import type { AgentId } from "./agent/timeline";
import { Skeleton, useDetail } from "./ResourcePages";
import { useWorkbench } from "./Workbench";

type Entry = {
  id: string;
  threadId: string | null;
  agent: string;
  tool: string;
  title: string;
  target: string | null;
  risk: string;
  args: unknown;
  decision: "auto" | "approved" | "denied" | "blocked";
  reason: string | null;
  status: "running" | "ok" | "error" | "skipped";
  result: unknown;
  verified: boolean | null;
  canRollback: boolean;
  rolledBackBy: string | null;
  createdAt: number;
  finishedAt: number | null;
};

const DECISION: Record<Entry["decision"], { label: string; cls: string; icon: typeof Check }> = {
  auto: { label: "خودکار", cls: "pill-accent", icon: Zap },
  approved: { label: "با تأیید شما", cls: "pill-ok", icon: ShieldCheck },
  denied: { label: "رد شد", cls: "", icon: Ban },
  blocked: { label: "مسدود", cls: "pill-danger", icon: ShieldX },
};

const RISK: Record<string, string> = { low: "کم‌خطر", medium: "متوسط", high: "پرخطر" };

function Outcome({ e }: { e: Entry }) {
  if (e.status === "running")
    return (
      <span className="pill pill-accent">
        <LoaderCircle size={12} className="spin" aria-hidden /> در حال اجرا
      </span>
    );
  if (e.status === "skipped") return <span className="faint small">اجرا نشد</span>;
  if (e.status === "error")
    return (
      <span className="pill pill-danger">
        <CircleAlert size={12} aria-hidden /> خطا
      </span>
    );
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      <span className="pill pill-ok">
        <Check size={12} strokeWidth={2.6} aria-hidden /> انجام شد
      </span>
      {e.verified === true && <span className="pill pill-ok">نتیجه بررسی شد</span>}
      {e.verified === false && <span className="pill pill-warn">نتیجه تأیید نشد</span>}
      {e.rolledBackBy && <span className="pill">برگردانده شد</span>}
    </span>
  );
}

export function AuditPage() {
  const wb = useWorkbench();
  const { data, error, loading, load } = useDetail<{ entries: Entry[] }>("/api/audit?limit=300");
  const [filter, setFilter] = useState<"all" | Entry["decision"]>("all");
  const [open, setOpen] = useState<string | null>(null);
  const entries = data?.entries ?? [];
  const shown = filter === "all" ? entries : entries.filter((e) => e.decision === filter);
  const count = (d: Entry["decision"]) => entries.filter((e) => e.decision === d).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>
            <ShieldCheck size={18} aria-hidden style={{ color: "var(--text-3)" }} />
            سوابق تغییرات
          </h1>
          <p className="sub">هر تغییری که عامل‌های یارا انجام دادند، پیشنهاد دادند و شما رد کردید، یا سیاست حساب جلویش را گرفت.</p>
        </div>
        <div className="toolbar">
          <a className="btn" href="/api/audit?format=csv&limit=1000" download>
            <Download size={14} aria-hidden />
            CSV
          </a>
          <a className="btn" href="/api/audit?format=json&limit=1000" download>
            <Download size={14} aria-hidden />
            JSON
          </a>
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
          <div className="audit-stats" role="group" aria-label="فیلتر">
            {(
              [
                ["all", "همه", entries.length],
                ["approved", DECISION.approved.label, count("approved")],
                ["auto", DECISION.auto.label, count("auto")],
                ["denied", DECISION.denied.label, count("denied")],
                ["blocked", DECISION.blocked.label, count("blocked")],
              ] as const
            ).map(([k, label, n]) => (
              <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
                <b className="num">{faDigits(n)}</b>
                <span>{label}</span>
              </button>
            ))}
          </div>

          <section className="box">
            <div className="table-scroll">
              <table className="data-table audit-table">
                <thead>
                  <tr>
                    <th scope="col">تغییر</th>
                    <th scope="col">تصمیم</th>
                    <th scope="col">نتیجه</th>
                    <th scope="col">
                      <span className="visually-hidden">کارها</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="muted">
                        هنوز تغییری ثبت نشده است.
                      </td>
                    </tr>
                  ) : (
                    shown.map((e) => {
                      const D = DECISION[e.decision];
                      const isOpen = open === e.id;
                      return (
                        <Fragment key={e.id}>
                          <tr className="audit-row" data-open={isOpen} onClick={() => setOpen(isOpen ? null : e.id)}>
                            <td>
                              <div className="audit-title">
                                <span>{e.title}</span>
                                <span className={`risk risk-${e.risk}`}>{RISK[e.risk] ?? e.risk}</span>
                              </div>
                              <div className="audit-sub">
                                <AgentChip agent={(e.agent as AgentId) ?? "supervisor"} />
                                {e.target && (
                                  <span className="ltr faint small audit-target" dir="ltr">
                                    {e.target}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td>
                              <span className={`pill ${D.cls}`}>
                                <D.icon size={12} aria-hidden /> {D.label}
                              </span>
                            </td>
                            <td>
                              <Outcome e={e} />
                              <div className="faint small" title={faTime(e.createdAt)} style={{ marginTop: 4 }}>
                                {relativeFa(e.createdAt)}
                              </div>
                            </td>
                            <td onClick={(ev) => ev.stopPropagation()}>
                              {e.canRollback && (
                                <button type="button" className="btn btn-ghost" style={{ height: 28 }} onClick={() => wb.askYara(`«${e.title}» روی ${e.target ?? "-"} را برگردان.`, true, `Undo audit entry ${e.id} with rollbackChange("${e.id}"), then verify the result.`)}>
                                  <RotateCcw size={13} aria-hidden />
                                  برگرداندن
                                </button>
                              )}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="audit-detail">
                              <td colSpan={4}>
                                <dl>
                                  <div>
                                    <dt>شناسه</dt>
                                    <dd className="ltr">{e.id}</dd>
                                  </div>
                                  {e.reason && (
                                    <div>
                                      <dt>دلیل تصمیم</dt>
                                      <dd dir="auto">{e.reason}</dd>
                                    </div>
                                  )}
                                  <div>
                                    <dt>ابزار</dt>
                                    <dd className="ltr">{e.tool}</dd>
                                  </div>
                                </dl>
                                <div className="audit-json">
                                  <div>
                                    <div className="faint small">ورودی (مقادیر حساس پنهان شده‌اند)</div>
                                    <pre className="json">{JSON.stringify(e.args, null, 2)}</pre>
                                  </div>
                                  {e.result != null && (
                                    <div>
                                      <div className="faint small">نتیجه</div>
                                      <pre className="json">{JSON.stringify(e.result, null, 2)}</pre>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
