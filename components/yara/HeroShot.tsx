"use client";

import { Bot, Boxes, LayoutDashboard, Search, Settings, Upload } from "lucide-react";
import { useState } from "react";
import { Markdown } from "../Markdown";
import { Approval } from "./Approval";
import { Steps, type ToolPartLike } from "./Evidence";
import { LogoMark } from "./Logo";

// Illustrative data for the landing page; the frame is labelled as an example.
const APPS: [string, string, string, string, number, string][] = [
  ["shop", "up", "node", "۰٫۲۳", 92, "۵۴۵ MB"],
  ["api", "up", "django", "۰٫۳۷", 40, "۲۱۵ MB"],
  ["landing", "up", "next", "۰٫۰۵", 28, "۱۴۷ MB"],
  ["worker", "down", "python", "۰٫۰۱", 12, "۶۳ MB"],
];

const STEPS: ToolPartLike[] = [
  { type: "tool-diagnoseApp", toolCallId: "d1", state: "output-available", input: { app: "shop" }, output: {} },
  { type: "tool-getAppLogs", toolCallId: "d2", state: "output-available", input: { app: "shop", minutes: 60, errorsOnly: true }, output: {} },
];

export function HeroShot() {
  const [approval, setApproval] = useState<ToolPartLike>({
    type: "tool-setEnvVars",
    toolCallId: "d4",
    state: "input-available",
    input: { app: "shop", variables: [{ key: "NODE_OPTIONS", value: "--max-old-space-size=420" }] },
  });

  const resolve = async (approved: boolean) => {
    await new Promise((r) => setTimeout(r, approved ? 500 : 150));
    setApproval((p) => ({ ...p, state: "output-available", output: approved ? { ok: true, at: Date.now() } : { denied: true, at: Date.now() } }));
  };

  return (
    <div className="hero-shot" aria-label="نمونه‌ی نمایشی از میز کار یارا">
      <div className="shot-bar">
        <i />
        <i />
        <i />
        <span className="faint small" style={{ marginInline: "auto", direction: "rtl" }}>
          نمونه‌ی نمایشی
        </span>
      </div>
      <div className="wb shot-wb" dir="rtl" data-chat="open" data-side="open">
        <nav className="activity" aria-hidden>
          <span className="act-btn" aria-current="page">
            <LayoutDashboard size={19} />
          </span>
          <span className="act-btn">
            <Boxes size={19} />
          </span>
          <span className="act-btn" aria-pressed="true">
            <Bot size={19} />
          </span>
          <span className="act-btn">
            <Upload size={19} />
          </span>
          <span className="spacer" />
          <span className="act-btn">
            <Search size={19} />
          </span>
          <span className="act-btn">
            <Settings size={19} />
          </span>
        </nav>
        <aside className="explorer" aria-hidden>
          <div className="ex-head">منابع لیارا</div>
          <div className="ex-group">
            <div className="ex-item" style={{ paddingInlineStart: 12, fontWeight: 700, fontSize: 11.5 }}>
              برنامه‌ها
            </div>
            {APPS.map(([n, s, p]) => (
              <div key={n} className="ex-item" aria-current={n === "shop" ? "page" : undefined}>
                <span className={`dot ${s}`} />
                <span className="grow ltr" style={{ textAlign: "right" }}>
                  {n}
                </span>
                <span className="trail ltr">{p}</span>
              </div>
            ))}
          </div>
        </aside>
        <div className="wb-main">
          <div className="tabs" aria-hidden>
            <span className="tab" aria-current="page">
              <LayoutDashboard size={14} />
              <span className="tab-label">نمای کلی</span>
            </span>
            <span className="tab">
              <span className="dot warn" />
              <span className="tab-label ltr">shop</span>
            </span>
          </div>
          <div className="editor">
            <div className="page" style={{ padding: "16px 20px 12px", gap: 12 }}>
              <div className="box">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>برنامه</th>
                      <th>وضعیت</th>
                      <th className="hide-sm">پردازنده</th>
                      <th>حافظه</th>
                    </tr>
                  </thead>
                  <tbody>
                    {APPS.map(([n, s, , cpu, mem, memLabel]) => (
                      <tr key={n}>
                        <td>
                          <span className="row-link">
                            <span className={`dot ${s}`} />
                            <span className="ltr">{n}</span>
                          </span>
                        </td>
                        <td>
                          <span className={`pill ${s === "up" ? "pill-ok" : "pill-danger"}`}>{s === "up" ? "در حال اجرا" : "دچار خطا"}</span>
                        </td>
                        <td className="hide-sm">
                          <span className="cell-metric">{cpu}</span>
                        </td>
                        <td>
                          <span className="cell-metric">
                            <span className="meter">
                              <i className={mem > 90 ? "crit" : ""} style={{ width: `${mem}%` }} />
                            </span>
                            {memLabel}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
        <aside className="chatbar" aria-label="یارا">
          <header className="chat-head">
            <LogoMark size={20} />
            <span className="chat-title">shop مدام ری‌استارت می‌شود</span>
          </header>
          <div className="yara-pane">
            <div className="scroll">
              <div className="thread">
                <div className="turn-user">shop از دیشب مدام ری‌استارت می‌شود. علتش را پیدا کن.</div>
                <div className="turn-ai">
                  <div className="turn-ai-body">
                    <Steps parts={STEPS} />
                    <Markdown text="حافظه‌ی **shop** به سقف پلن می‌رسد و برنامه متوقف می‌شود (`OOM_KILLED`). پیشنهاد: محدودیت حافظه‌ی Node را کمی پایین‌تر از سقف بگذاریم." />
                    <Approval part={approval} name="setEnvVars" onResolve={resolve} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
