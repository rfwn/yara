"use client";

import { Check, CircleDashed, Copy, ExternalLink, Globe, Hourglass, Lock, LoaderCircle, RefreshCw, User } from "lucide-react";
import { useState } from "react";
import { faDigits } from "@/lib/fa";
import type { Call } from "./timeline";

type Step = { id: string; title: string; state: "done" | "todo" | "waiting" | "blocked"; detail: string; by: "yara" | "user" };
type Guide = {
  domain: string;
  app: string | null;
  apex: boolean;
  registrar: { name: string; panel: string | null; howTo: string[] };
  liara: { dnsZone?: { fromApi: boolean } };
  dns?: { mode: "liara-active" | "liara-pending" | "external"; zone: string };
  live: { cname: string[]; a: string[]; ns: string[] };
  steps: Step[];
  records: Rec[];
  zoneRecords?: { name: string; type: string; contents: Record<string, string>[] }[];
  ready: boolean;
};
type Rec = { where: string; type: string; name: string; value: string; purpose?: "route" | "verify" | "ssl" | "ns"; live?: "ok" | "missing" | "wrong"; note?: string };

const PURPOSE_FA = { route: "اشاره به لیارا", verify: "تأیید مالکیت", ssl: "گواهی SSL", ns: "سرور نام" } as const;
const LIVE_FA = { ok: ["دیده شد", "pill-ok"], missing: ["پیدا نشد", ""], wrong: ["مقدار دیگری دارد", "pill-warn"] } as const;
const MODE_FA = {
  "liara-active": "DNS این دامنه روی لیاراست؛ یارا رکوردها را خودش (با تأیید شما) می‌سازد.",
  "liara-pending": "زون این دامنه در DNS لیارا ساخته شده ولی سرورهای نام هنوز به لیارا اشاره نمی‌کنند. فقط همین یک تغییر کار شماست؛ رکوردها را یارا می‌سازد.",
  external: "DNS این دامنه جای دیگری است (مثلاً کلادفلر یا پنل فروشنده)؛ رکوردها را خودتان آنجا می‌سازید.",
} as const;

const STATE_ICON = { done: Check, todo: CircleDashed, waiting: Hourglass, blocked: Lock } as const;
const STATE_FA = { done: "انجام شد", todo: "مانده", waiting: "در انتظار", blocked: "بعد از مرحله‌ی قبل" } as const;

function CopyValue({ value }: { value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={`کپی ${value}`}
      title="کپی"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setOk(true);
          setTimeout(() => setOk(false), 1500);
        } catch {
          // clipboard blocked
        }
      }}
    >
      {ok ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>
  );
}

/** The domain checklist: who does each step, what is done, and the exact records for the registrar. */
export function DomainCard({ call }: { call: Call }) {
  const initial = ((call.output as any)?.result ?? call.output) as Guide;
  const vm = typeof call.args.vm === "string" ? call.args.vm : null;
  const [g, setG] = useState<Guide>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const recheck = async () => {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/domains/guide?domain=${encodeURIComponent(g.domain)}${vm ? `&vm=${encodeURIComponent(vm)}` : g.app ? `&app=${encodeURIComponent(g.app)}` : ""}&recheck=1`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "بررسی نشد.");
      setG(d);
      setCheckedAt(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const done = g.steps.filter((s) => s.state === "done").length;
  const userTurn = g.steps.find((s) => s.state !== "done")?.by === "user";

  return (
    <section className="gen-card domain" data-state={g.ready ? "ok" : "running"} aria-label={`راه‌اندازی دامنه‌ی ${g.domain}`}>
      <header className="gen-head">
        <Globe size={14} aria-hidden />
        <span className="gen-title">
          دامنه‌ی <b className="ltr">{g.domain}</b>
        </span>
        <span className={`pill ${g.ready ? "pill-ok" : "pill-accent"}`}>{g.ready ? "آماده" : `${faDigits(done)} از ${faDigits(g.steps.length)}`}</span>
      </header>

      {g.dns && <p className="small muted dom-mode">{MODE_FA[g.dns.mode]}</p>}

      <ol className="dom-steps">
        {g.steps.map((s) => {
          const Icon = STATE_ICON[s.state];
          return (
            <li key={s.id} data-state={s.state}>
              <span className="dom-ico" aria-label={STATE_FA[s.state]}>
                <Icon size={12} strokeWidth={2.4} aria-hidden />
              </span>
              <div>
                <div className="dom-title">
                  {s.title}
                  <span className="dom-by">{s.by === "user" ? <><User size={11} aria-hidden /> کار شما</> : "یارا"}</span>
                </div>
                <p className="small muted">{s.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>

      {userTurn && g.records.length > 0 && (
        <div className="dom-records">
          <div className="small">
            <b>این مقادیر را در {g.registrar.name} وارد کنید:</b>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">نوع</th>
                <th scope="col">نام</th>
                <th scope="col">مقدار</th>
                <th scope="col">الان</th>
              </tr>
            </thead>
            <tbody>
              {g.records.map((r, i) => (
                <tr key={i} title={r.note}>
                  <td>
                    <span className="ltr">{r.type}</span>
                    {r.purpose && <span className="faint dom-purpose">{PURPOSE_FA[r.purpose]}</span>}
                  </td>
                  <td className="ltr mono-cell">
                    {r.name}
                    <CopyValue value={r.name} />
                  </td>
                  <td className="ltr mono-cell">
                    {r.value}
                    <CopyValue value={r.value} />
                  </td>
                  <td>{r.live ? <span className={`pill ${LIVE_FA[r.live][1]}`}>{LIVE_FA[r.live][0]}</span> : <span className="faint">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {g.records
            .filter((r) => r.note && r.live !== "ok")
            .map((r) => (
              <p key={r.name} className="small dom-note">
                <b className="ltr">{r.name}</b>: {r.note}
              </p>
            ))}
          {g.dns?.mode === "liara-pending" && !g.liara.dnsZone?.fromApi && <p className="small faint">سرورهای نام از API خوانده نشد؛ مقدار پیش‌فرض لیارا نشان داده شده است. در کنسول لیارا بخش DNS هم بررسی کنید.</p>}
          <details className="how-yara">
            <summary>قدم‌به‌قدم در {g.registrar.name}</summary>
            <ol className="small muted dom-howto">
              {g.registrar.howTo.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ol>
            {g.registrar.panel && (
              <a className="link small" href={g.registrar.panel} target="_blank" rel="noreferrer">
                باز کردن پنل <ExternalLink size={11} aria-hidden />
              </a>
            )}
          </details>
          <p className="small faint">
            {g.dns?.mode === "external"
              ? "یارا به پنل DNS بیرون از لیارا دسترسی ندارد؛ برای همین این رکوردها کار شماست."
              : "این مرحله بیرون از لیاراست و هیچ API‌ای برایش وجود ندارد؛ برای همین یارا نمی‌تواند خودش انجامش دهد."}
          </p>
        </div>
      )}

      {g.zoneRecords && g.zoneRecords.length > 0 && (
        <div className="dom-records dom-yara">
          <div className="small">
            <b>یارا این رکوردها را در زون {g.dns?.zone} لیارا می‌سازد:</b>
          </div>
          <ul className="dom-zone-list ltr">
            {g.zoneRecords.map((r) => (
              <li key={`${r.type}-${r.name}`}>
                <b>{r.type}</b> {r.name} → <span className="mono-cell">{Object.values(r.contents[0] ?? {})[0]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer className="dom-foot">
        <span className="small faint">
          DNS همین الان:{" "}
          <span className="ltr" dir="ltr">
            {g.live.ns.length ? `NS ${g.live.ns.join(", ")}` : "NS —"}
            {!g.apex && (g.live.cname.length ? ` · CNAME ${g.live.cname[0]}` : g.live.a.length ? ` · A ${g.live.a.join(", ")}` : "")}
          </span>
          {checkedAt && " · همین حالا بررسی شد"}
        </span>
        {!g.ready && (
          <button type="button" className="btn" onClick={recheck} disabled={busy}>
            {busy ? <LoaderCircle size={13} className="spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />} بررسی دوباره
          </button>
        )}
      </footer>
      {err && <p className="error-text small">{err}</p>}
    </section>
  );
}
