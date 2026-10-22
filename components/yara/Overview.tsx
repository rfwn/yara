"use client";

import { Bot, RefreshCw, ScrollText, SquareTerminal, Upload } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { bytesFa, faDigits, relativeFa } from "@/lib/fa";
import { appStatus, useWorkbench } from "./Workbench";

type Row = {
  name: string;
  platform: string;
  status: string;
  on: boolean;
  plan: string;
  cpu: { last?: number; max?: number } | null;
  memory: { last?: number; max?: number } | null;
  release: { state: string; at: string } | null;
};

const RELEASE_LABEL: Record<string, [string, string]> = {
  READY: ["موفق", "pill-ok"],
  FAILED: ["ناموفق", "pill-danger"],
  CANCELED: ["لغوشده", ""],
  BUILDING: ["در حال ساخت", "pill-accent"],
  PENDING: ["در صف", "pill-accent"],
};

function Meter({ value, max, label }: { value?: number; max: number; label: string }) {
  if (value === undefined) return <span className="faint">–</span>;
  const pct = Math.min(100, (value / max) * 100);
  return (
    <span className="cell-metric">
      <span className="meter" aria-hidden>
        <i className={pct > 90 ? "crit" : pct > 70 ? "hot" : ""} style={{ width: `${Math.max(pct, 3)}%` }} />
      </span>
      {label}
    </span>
  );
}

export function Overview() {
  const wb = useWorkbench();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/overview");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "وضعیت برنامه‌ها بارگذاری نشد.");
      setRows(data.apps);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = (rows ?? []).reduce(
    (acc, r) => {
      const s = appStatus(r).cls;
      if (s === "up") acc.up++;
      else if (s === "down") acc.down++;
      else if (!r.on) acc.off++;
      if (r.release?.state === "FAILED") acc.failed++;
      return acc;
    },
    { up: 0, down: 0, off: 0, failed: 0 },
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>نمای کلی</h1>
          <p className="sub">وضعیت زنده‌ی برنامه‌های حساب لیارای شما · مصرف ۳ ساعت اخیر</p>
        </div>
        <div className="toolbar">
          <button type="button" className="btn" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden />
            به‌روزرسانی
          </button>
          <button type="button" className="btn" onClick={wb.openDeploy}>
            <Upload size={14} aria-hidden />
            استقرار کد
          </button>
          <button type="button" className="btn btn-primary" onClick={() => wb.askYara("وضعیت همه‌ی برنامه‌هایم را بررسی کن و هر مشکلی دیدی با شواهد بگو.")}>
            <Bot size={14} aria-hidden />
            بررسی همه با یارا
          </button>
        </div>
      </div>

      {rows && (
        <p className="summary-line" role="status">
          <span>
            <span className="dot up" />
            {faDigits(counts.up)} در حال اجرا
          </span>
          <span className={counts.down ? "bad" : undefined}>
            <span className="dot down" />
            {faDigits(counts.down)} دچار خطا
          </span>
          <span>
            <span className="dot" />
            {faDigits(counts.off)} خاموش
          </span>
          {counts.failed > 0 && <span className="bad">{faDigits(counts.failed)} استقرار ناموفق اخیر</span>}
        </p>
      )}

      {error ? (
        <div className="alert" role="alert">
          <span>{error}</span>
          <Link href="/app/settings" className="btn">
            بررسی اتصال
          </Link>
        </div>
      ) : (
        <div className="box table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">برنامه</th>
                <th scope="col">وضعیت</th>
                <th scope="col" className="hide-sm">
                  پلتفرم و پلن
                </th>
                <th scope="col">پردازنده</th>
                <th scope="col">حافظه</th>
                <th scope="col" className="hide-sm">
                  آخرین استقرار
                </th>
                <th scope="col" className="actions">
                  <span className="visually-hidden">کارها</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {!rows
                ? Array.from({ length: 4 }, (_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 7 }, (_, j) => (
                        <td key={j}>
                          <span className="skeleton" style={{ width: j === 0 ? 120 : 60 }} />
                        </td>
                      ))}
                    </tr>
                  ))
                : rows.map((r) => {
                    const s = appStatus(r);
                    const rel = r.release ? (RELEASE_LABEL[r.release.state] ?? [r.release.state, ""]) : null;
                    const memMax = Math.max(r.memory?.max ?? 0, r.memory?.last ?? 0, 512 * 1024 * 1024);
                    return (
                      <tr key={r.name}>
                        <td>
                          <Link href={`/app/apps/${encodeURIComponent(r.name)}`} className="row-link">
                            <span className={`dot ${s.cls}`} aria-hidden />
                            <span className="ltr">{r.name}</span>
                          </Link>
                        </td>
                        <td>
                          <span className={`pill ${s.cls === "up" ? "pill-ok" : s.cls === "down" ? "pill-danger" : s.cls === "warn" ? "pill-warn" : ""}`}>{s.label}</span>
                        </td>
                        <td className="hide-sm muted">
                          <span className="ltr">{r.platform}</span> · <span className="ltr">{r.plan}</span>
                        </td>
                        <td>
                          <Meter value={r.cpu?.last} max={Math.max(1, r.cpu?.max ?? 1)} label={r.cpu?.last !== undefined ? faDigits(r.cpu.last.toFixed(2)) : ""} />
                        </td>
                        <td>
                          <Meter value={r.memory?.last} max={memMax} label={bytesFa(r.memory?.last)} />
                        </td>
                        <td className="hide-sm">
                          {rel ? (
                            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                              <span className={`pill ${rel[1]}`}>{rel[0]}</span>
                              <span className="faint small">{relativeFa(new Date(r.release!.at).getTime())}</span>
                            </span>
                          ) : (
                            <span className="faint">–</span>
                          )}
                        </td>
                        <td className="actions">
                          <span style={{ display: "inline-flex" }}>
                            <button type="button" className="icon-btn" onClick={() => wb.openLogs(r.name)} aria-label={`لاگ‌های ${r.name}`} title="لاگ‌ها">
                              <ScrollText size={15} aria-hidden />
                            </button>
                            <button type="button" className="icon-btn" onClick={() => wb.openConsole(r.name)} aria-label={`کنسول ${r.name}`} title="کنسول">
                              <SquareTerminal size={15} aria-hidden />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => wb.askYara(`وضعیت برنامه‌ی ${r.name} را بررسی کن: خطاهای اخیر، استقرارها و مصرف منابع.`)}
                              aria-label={`بررسی ${r.name} با یارا`}
                              title="بررسی با یارا"
                            >
                              <Bot size={15} aria-hidden />
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
              {rows && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted" style={{ textAlign: "center", height: 80 }}>
                    هنوز برنامه‌ای در این حساب نیست. با «استقرار کد» یا از یارا بخواهید یکی بسازد.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
