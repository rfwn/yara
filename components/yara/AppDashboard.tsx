"use client";

import { Bot, ExternalLink, RefreshCw, RotateCw, ScrollText, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { relativeFa } from "@/lib/fa";
import { MetricView } from "./Evidence";
import { appStatus, useWorkbench } from "./Workbench";

type Detail = {
  name: string;
  platform: string;
  status: string;
  on: boolean;
  plan: string;
  zeroDowntime: boolean;
  url: string | null;
  hourlyPrice: number | null;
  env: { key: string; value: string }[];
  cpu: any[];
  memory: any[];
  releases: { id: string; state: string; at: string; port: number; message: string | null; commit: string | null; client: string }[];
  domains: { name: string; status: string; ssl: string }[];
};

const STATE: Record<string, [string, string]> = {
  READY: ["موفق", "pill-ok"],
  FAILED: ["ناموفق", "pill-danger"],
  CANCELED: ["لغوشده", ""],
  BUILDING: ["در حال ساخت", "pill-accent"],
  PENDING: ["در صف", "pill-accent"],
};

export function AppDashboard({ name }: { name: string }) {
  const wb = useWorkbench();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(name)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "اطلاعات برنامه بارگذاری نشد.");
      setD(data);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    load();
  }, [load]);

  // A restart clicked here is itself the human yes; it still goes through the same validated action route.
  const restart = async () => {
    setRestarting(true);
    setConfirmRestart(false);
    try {
      const res = await fetch("/api/actions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "restartApp", input: { app: name } }) });
      const data = await res.json();
      setNotice(data.ok ? "درخواست ری‌استارت ثبت شد." : `ری‌استارت ناموفق بود: ${data.error}`);
      wb.refreshApps();
    } finally {
      setRestarting(false);
    }
  };

  const s = d ? appStatus(d) : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>
            {s && <span className={`dot ${s.cls}`} aria-hidden />}
            <span className="ltr">{name}</span>
            {s && <span className={`pill ${s.cls === "up" ? "pill-ok" : s.cls === "down" ? "pill-danger" : s.cls === "warn" ? "pill-warn" : ""}`}>{s.label}</span>}
          </h1>
          {d && (
            <p className="sub">
              <span className="ltr">{d.platform}</span> · پلن <span className="ltr">{d.plan}</span>
              {d.url && (
                <>
                  {" · "}
                  <a href={d.url} target="_blank" rel="noreferrer" className="link ltr">
                    {d.url.replace("https://", "")}
                    <ExternalLink size={11} aria-hidden style={{ marginInlineStart: 4, verticalAlign: "-1px" }} />
                  </a>
                </>
              )}
            </p>
          )}
        </div>
        <div className="toolbar">
          <button type="button" className="btn" onClick={() => wb.openLogs(name)}>
            <ScrollText size={14} aria-hidden />
            لاگ‌ها
          </button>
          <button type="button" className="btn" onClick={() => wb.openConsole(name)}>
            <SquareTerminal size={14} aria-hidden />
            کنسول
          </button>
          {confirmRestart ? (
            <span className="confirm-inline">
              برنامه ری‌استارت شود؟
              <button type="button" className="btn btn-primary" style={{ height: 26 }} onClick={restart}>
                بله
              </button>
              <button type="button" className="btn btn-ghost" style={{ height: 26 }} onClick={() => setConfirmRestart(false)}>
                نه
              </button>
            </span>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirmRestart(true)} disabled={restarting}>
              <RotateCw size={14} className={restarting ? "spin" : ""} aria-hidden />
              ری‌استارت
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => wb.askYara(`وضعیت برنامه‌ی ${name} را بررسی کن: خطاهای اخیر، استقرارها و مصرف منابع.`)}>
            <Bot size={14} aria-hidden />
            بررسی با یارا
          </button>
          <button type="button" className="icon-btn" onClick={load} aria-label="به‌روزرسانی" title="به‌روزرسانی">
            <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden />
          </button>
        </div>
      </div>

      {notice && (
        <p className="small" role="status" style={{ color: notice.includes("ناموفق") ? "var(--danger)" : "var(--ok)" }}>
          {notice}
        </p>
      )}

      {error ? (
        <div className="alert" role="alert">
          <span className="ltr">{error}</span>
        </div>
      ) : !d ? (
        <div className="box">
          <div className="body" style={{ display: "grid", gap: 12 }}>
            <span className="skeleton" style={{ width: "40%" }} />
            <span className="skeleton" style={{ width: "70%" }} />
            <span className="skeleton" style={{ width: "55%" }} />
          </div>
        </div>
      ) : (
        <>
          <section className="box">
            <h2>
              مصرف منابع <span className="faint small">۶ ساعت اخیر</span>
            </h2>
            <div className="body" style={{ display: "grid", gap: 12 }}>
              {d.on ? (
                <>
                  <MetricView metric="cpu" series={d.cpu} />
                  <MetricView metric="memory" series={d.memory} />
                </>
              ) : (
                <p className="muted">برنامه خاموش است.</p>
              )}
            </div>
          </section>

          <div className="cols">
            <section className="box">
              <h2>استقرارهای اخیر</h2>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">وضعیت</th>
                      <th scope="col">زمان</th>
                      <th scope="col" className="hide-sm">
                        کامیت
                      </th>
                      <th scope="col">پورت</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.releases.length === 0 && (
                      <tr>
                        <td colSpan={4} className="muted">
                          هنوز استقراری نیست.
                        </td>
                      </tr>
                    )}
                    {d.releases.map((r) => {
                      const st = STATE[r.state] ?? [r.state, ""];
                      return (
                        <tr key={r.id}>
                          <td>
                            <span className={`pill ${st[1]}`}>{st[0]}</span>
                          </td>
                          <td className="muted">{r.at ? relativeFa(new Date(r.at).getTime()) : "–"}</td>
                          <td className="hide-sm" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }} title={r.message ?? ""}>
                            {r.commit ? (
                              <span className="ltr">
                                <code className="faint">{r.commit}</code> {r.message}
                              </span>
                            ) : (
                              <span className="faint">{r.client ?? "–"}</span>
                            )}
                          </td>
                          <td className="num ltr">{r.port ?? "–"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <div style={{ display: "grid", gap: 16 }}>
              <section className="box">
                <h2>دامنه‌ها</h2>
                <div className="body">
                  {d.domains.length === 0 ? (
                    <p className="muted small">دامنه‌ی اختصاصی ندارد.</p>
                  ) : (
                    <dl className="kv">
                      {d.domains.map((x) => (
                        <div key={x.name} style={{ display: "contents" }}>
                          <dt className="ltr" style={{ color: "var(--text)" }}>
                            {x.name}
                          </dt>
                          <dd>
                            <span className={`pill ${/active|ok|connected/i.test(x.status) ? "pill-ok" : "pill-warn"}`}>
                              {/active|ok|connected/i.test(x.status) ? "متصل" : /pending|wait/i.test(x.status) ? "در انتظار DNS" : x.status}
                            </span>{" "}
                            <span className="faint small">{/active|issued|ok/i.test(x.ssl ?? "") ? "با SSL" : "بدون SSL"}</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              </section>
              <section className="box">
                <h2>
                  متغیرهای محیطی <span className="faint small">مقادیر حساس پوشیده</span>
                </h2>
                <div className="body">
                  {d.env.length === 0 ? (
                    <p className="muted small">متغیری تعریف نشده است.</p>
                  ) : (
                    <dl className="kv ltr" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                      {d.env.map((e) => (
                        <div key={e.key} style={{ display: "contents" }}>
                          <dt>{e.key}</dt>
                          <dd>{e.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
