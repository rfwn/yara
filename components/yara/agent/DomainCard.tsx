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
  live: { cname: string[]; a: string[]; ns: string[] };
  steps: Step[];
  records: { where: string; type: string; name: string; value: string }[];
  ready: boolean;
};

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
  const [g, setG] = useState<Guide>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const recheck = async () => {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/domains/guide?domain=${encodeURIComponent(g.domain)}${g.app ? `&app=${encodeURIComponent(g.app)}` : ""}&recheck=1`);
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
                <th scope="col">
                  <span className="visually-hidden">کپی</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {g.records.map((r, i) => (
                <tr key={i}>
                  <td className="ltr">{r.type}</td>
                  <td className="ltr">{r.name}</td>
                  <td className="ltr mono-cell">{r.value}</td>
                  <td>
                    <CopyValue value={r.value} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {g.apex && !g.liara.dnsZone?.fromApi && <p className="small faint">سرورهای نام از API خوانده نشد؛ مقدار پیش‌فرض لیارا نشان داده شده است. در کنسول لیارا بخش DNS هم بررسی کنید.</p>}
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
          <p className="small faint">این مرحله بیرون از لیاراست و هیچ API‌ای برایش وجود ندارد؛ برای همین یارا نمی‌تواند خودش انجامش دهد.</p>
        </div>
      )}

      <footer className="dom-foot">
        <span className="small faint">
          DNS همین الان:{" "}
          <span className="ltr" dir="ltr">
            {g.apex ? (g.live.ns.length ? `NS ${g.live.ns.join(", ")}` : "NS —") : g.live.cname.length ? `CNAME ${g.live.cname[0]}` : g.live.a.length ? `A ${g.live.a.join(", ")}` : "—"}
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
