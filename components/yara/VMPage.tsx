"use client";

import { Bot, Info, Power, RefreshCw, RotateCw, Server } from "lucide-react";
import { faDigits, relativeFa } from "@/lib/fa";
import { Skeleton, useDetail } from "./ResourcePages";
import { VmSsh } from "./VmSsh";
import { useWorkbench } from "./Workbench";

type VMDetail = {
  id: string;
  name: string;
  state: string;
  power: string;
  guestState?: string;
  os: string;
  plan: string;
  resources: { cpuCores?: number; ramGB?: number; diskGB?: number; region?: string };
  price: { monthly?: number; hourly?: number };
  ips: string[];
  ssh: { port?: string; hostname?: string; keys: number };
  createdAt: string;
  operations: { name: string; state: string; createdAt: string }[];
  disks: { availableSize?: number; disks?: { _id?: string; name: string; size: number; createdAt: string }[] } | null;
  traffic: { byDestination: { ip: string; mb: number }[] | { error: string }; perMinuteMB: { minute: number; mb: number }[] } | null;
};

const POWER: Record<string, { label: string; cls: string }> = {
  POWERED_ON: { label: "روشن", cls: "pill-ok" },
  POWERED_OFF: { label: "خاموش", cls: "" },
  SUSPENDED: { label: "معلق", cls: "pill-warn" },
};

function TrafficBars({ points }: { points: { minute: number; mb: number }[] }) {
  if (points.length < 2) return <p className="faint small">در این بازه ترافیکی ثبت نشده است.</p>;
  const max = Math.max(...points.map((p) => p.mb), 0.01);
  const w = 100 / points.length;
  return (
    <svg className="traffic" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="ترافیک شبکه در بازه‌های ۵ دقیقه‌ای" style={{ direction: "ltr" }}>
      {points.map((p, i) => {
        const h = Math.max((p.mb / max) * 38, 0.5);
        return <rect key={p.minute} x={i * w + w * 0.15} width={w * 0.7} y={40 - h} height={h} rx="0.4" />;
      })}
    </svg>
  );
}

export function VMPage({ id }: { id: string }) {
  const wb = useWorkbench();
  const { data: d, error, loading, load } = useDetail<VMDetail>(`/api/vms/${encodeURIComponent(id)}`);
  const power = d ? (POWER[d.power] ?? { label: d.power, cls: "" }) : null;
  const on = d?.power === "POWERED_ON";
  const name = d?.name ?? id;
  const dest = d?.traffic && Array.isArray(d.traffic.byDestination) ? d.traffic.byDestination : [];
  const totalMB = (d?.traffic?.perMinuteMB ?? []).reduce((n, p) => n + p.mb, 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>
            <Server size={18} aria-hidden style={{ color: "var(--text-3)" }} />
            <span className="ltr">{name}</span>
            {power && <span className={`pill ${power.cls}`}>{power.label}</span>}
            {d && d.state !== "CREATED" && <span className="pill pill-warn ltr">{d.state}</span>}
          </h1>
          {d && (
            <p className="sub">
              ماشین مجازی · <span className="ltr">{d.os}</span> · پلن <span className="ltr">{d.plan}</span>
            </p>
          )}
        </div>
        <div className="toolbar">
          <button type="button" className="btn btn-primary" onClick={() => wb.askYara(`ماشین مجازی ${name} را بررسی کن: وضعیت، عملیات اخیر، دیسک‌ها و ترافیک شبکه. اگر چیزی غیرعادی است بگو.`)}>
            <Bot size={14} aria-hidden />
            بررسی با یارا
          </button>
          {d &&
            (on ? (
              <>
                <button type="button" className="btn" onClick={() => wb.askYara(`ماشین مجازی ${name} را ری‌استارت کن.`)}>
                  <RotateCw size={14} aria-hidden />
                  ری‌استارت
                </button>
                <button type="button" className="btn" onClick={() => wb.askYara(`ماشین مجازی ${name} را به‌صورت امن خاموش کن.`)}>
                  <Power size={14} aria-hidden />
                  خاموش
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={() => wb.askYara(`ماشین مجازی ${name} را روشن کن.`)}>
                <Power size={14} aria-hidden />
                روشن کردن
              </button>
            ))}
          <button type="button" className="icon-btn" onClick={load} aria-label="به‌روزرسانی" title="به‌روزرسانی">
            <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden />
          </button>
        </div>
      </div>

      {error ? (
        <div className="alert" role="alert">
          <span className="ltr">{error}</span>
        </div>
      ) : !d ? (
        <Skeleton />
      ) : (
        <>
          <section className="box">
            <h2>مشخصات</h2>
            <dl className="vm-specs">
              <div>
                <dt>پردازنده</dt>
                <dd className="num">{d.resources.cpuCores != null ? `${faDigits(d.resources.cpuCores)} هسته` : "–"}</dd>
              </div>
              <div>
                <dt>حافظه</dt>
                <dd className="num">{d.resources.ramGB != null ? `${faDigits(d.resources.ramGB)} گیگابایت` : "–"}</dd>
              </div>
              <div>
                <dt>دیسک</dt>
                <dd className="num">{d.resources.diskGB != null ? `${faDigits(d.resources.diskGB)} گیگابایت` : "–"}</dd>
              </div>
              <div>
                <dt>آی‌پی</dt>
                <dd className="ltr">{d.ips.map((ip) => ip.split(" ")[0]).join("، ") || "–"}</dd>
              </div>
              <div>
                <dt>SSH</dt>
                <dd>
                  پورت <span className="ltr">{d.ssh.port ?? "22"}</span> · {faDigits(d.ssh.keys)} کلید
                </dd>
              </div>
              <div>
                <dt>هزینه</dt>
                <dd className="num">{d.price.monthly != null ? `${faDigits(Math.round(d.price.monthly).toLocaleString("en"))} تومان در ماه` : "–"}</dd>
              </div>
            </dl>
          </section>

          <aside className="api-limit" role="note">
            <Info size={15} aria-hidden />
            <p>
              API لیارا برای ماشین مجازی <b>مصرف پردازنده و حافظه، لاگ‌ها و اجرای دستور داخل ماشین</b> را ارائه نمی‌دهد؛ یارا فقط وضعیت، دیسک‌ها، ترافیک شبکه و تاریخچه‌ی عملیات را می‌بیند. برای بررسی داخل ماشین، رانر یارا را روی آن اجرا
              کنید (تنظیمات ← کد و فضاهای کاری) یا دستورهایی را که یارا پیشنهاد می‌دهد خودتان با SSH اجرا کنید.
            </p>
          </aside>

          <section className="box">
            <h2>
              ترافیک شبکه <span className="faint small num">{faDigits(totalMB.toFixed(1))} مگابایت در بازه‌ی اخیر</span>
            </h2>
            <div className="body" style={{ display: "grid", gap: 12 }}>
              <TrafficBars points={d.traffic?.perMinuteMB ?? []} />
              {dest.length > 0 && (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">مقصد</th>
                        <th scope="col">حجم</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dest.slice(0, 6).map((t) => (
                        <tr key={t.ip}>
                          <td className="ltr" style={{ textAlign: "right" }}>
                            {t.ip}
                          </td>
                          <td className="muted num">{faDigits(t.mb)} MB</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="box">
            <h2>
              دیسک‌ها {d.disks?.availableSize != null && <span className="faint small num">{faDigits(d.disks.availableSize)} گیگابایت فضای قابل افزودن</span>}
            </h2>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">نام</th>
                    <th scope="col">حجم</th>
                    <th scope="col">ساخت</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.disks?.disks ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={3} className="muted">
                        دیسک اضافه‌ای وصل نیست.
                      </td>
                    </tr>
                  ) : (
                    d.disks!.disks!.map((k) => (
                      <tr key={k._id ?? k.name}>
                        <td className="ltr" style={{ textAlign: "right" }}>
                          {k.name}
                        </td>
                        <td className="muted num">{faDigits(k.size)} GB</td>
                        <td className="muted">{relativeFa(new Date(k.createdAt).getTime())}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <VmSsh vm={d.id ?? id} on={on} />

          <section className="box">
            <h2>تاریخچه‌ی عملیات</h2>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">عملیات</th>
                    <th scope="col">نتیجه</th>
                    <th scope="col">زمان</th>
                  </tr>
                </thead>
                <tbody>
                  {d.operations.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="muted">
                        عملیاتی ثبت نشده است.
                      </td>
                    </tr>
                  ) : (
                    d.operations.map((o) => (
                      <tr key={`${o.name}-${o.createdAt}`}>
                        <td className="ltr" style={{ textAlign: "right" }}>
                          {o.name}
                        </td>
                        <td>
                          <span className={`pill ${o.state === "SUCCEEDED" ? "pill-ok" : o.state === "FAILED" ? "pill-danger" : "pill-accent"} ltr`}>{o.state}</span>
                        </td>
                        <td className="muted">{relativeFa(new Date(o.createdAt).getTime())}</td>
                      </tr>
                    ))
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
