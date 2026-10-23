"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { faDigits } from "@/lib/fa";

type Policy = {
  readOnly: boolean;
  autoLowRisk: boolean;
  autoSafeCommands: boolean;
  blockDestructive: boolean;
  maxChangesPerThreadHour: number;
  maxChangesPerHour: number;
  maxDeploysPerAppHour: number;
  autoHeal: boolean;
  maxAutoHealsPerAppHour: number;
  allowRoutines: boolean;
};
type Limit = { id: string; area: string; title: string; detail: string; workaround: string };

const TOGGLES: { key: keyof Policy; title: string; desc: string }[] = [
  { key: "readOnly", title: "فقط خواندن", desc: "عامل‌ها فقط بررسی و پیشنهاد می‌کنند؛ هیچ تغییری، حتی با تأیید، اجرا نمی‌شود." },
  { key: "autoSafeCommands", title: "اجرای خودکار دستورهای امن", desc: "بیلد، تست، lint و دستورهای فقط‌خواندنی بدون پرسیدن اجرا می‌شوند. دستورهایی که به فایل‌های محرمانه (.env، کلیدها) دست بزنند همیشه تأیید می‌خواهند." },
  { key: "autoLowRisk", title: "اجرای خودکار تغییرات کم‌خطر", desc: "مثل ری‌استارت برنامه، گرفتن پشتیبان، رفع انجماد یا باز کردن Pull Request. تغییرات متوسط و پرخطر همیشه تأیید می‌خواهند." },
  { key: "autoHeal", title: "ترمیم خودکار با پایش", desc: "وقتی برنامه‌ی تحت پایش از دسترس خارج شود و علت محتمل با ری‌استارت رفع‌شدنی باشد (پردازه‌ی گیرکرده، کشته شدن به‌خاطر حافظه)، یارا خودش ری‌استارت می‌کند و برگشتن سایت را بررسی می‌کند. برای خطای کد هرگز ری‌استارت نمی‌کند." },
  { key: "allowRoutines", title: "اجرای کارهای زمان‌بندی‌شده", desc: "پشتیبان‌گیری‌ها و ری‌استارت‌هایی که در صفحه‌ی پایش زمان‌بندی کرده‌اید سر وقت اجرا شوند. خاموش کردنش همه را بدون حذف متوقف می‌کند." },
  { key: "blockDestructive", title: "ممنوعیت حذف", desc: "حذف برنامه، ماشین مجازی، دیسک، باکت، فایل یا رکورد DNS کاملاً مسدود می‌شود، حتی با تأیید شما." },
];

const LIMITS: { key: keyof Policy; title: string; desc: string; min: number; max: number }[] = [
  { key: "maxChangesPerThreadHour", title: "سقف تغییر در هر گفت‌وگو (در ساعت)", desc: "جلوی حلقه‌های بی‌پایان یک عامل را می‌گیرد.", min: 1, max: 50 },
  { key: "maxChangesPerHour", title: "سقف تغییر در کل حساب (در ساعت)", desc: "سقف کلی، همه‌ی گفت‌وگوها با هم.", min: 1, max: 200 },
  { key: "maxDeploysPerAppHour", title: "سقف استقرار هر برنامه (در ساعت)", desc: "جلوی چرخه‌ی استقرار ← خطا ← استقرار دوباره را می‌گیرد.", min: 1, max: 20 },
  { key: "maxAutoHealsPerAppHour", title: "سقف ری‌استارت خودکار هر برنامه (در ساعت)", desc: "بعد از این تعداد، پایش دیگر ری‌استارت نمی‌کند و مشکل را با برچسب «نیاز به شما» گزارش می‌دهد؛ ری‌استارت پشت سر هم فقط مشکل را پنهان می‌کند.", min: 1, max: 5 },
];

/** The rules the server enforces on every change the agents propose. */
export function GovernanceSettings() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [limits, setLimits] = useState<Limit[]>([]);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch("/api/policy")
      .then((r) => r.json())
      .then((d) => {
        setPolicy(d.policy);
        setLimits(d.limits ?? []);
      })
      .catch(() => setMsg("بارگذاری نشد."));
  }, []);

  const save = async (patch: Partial<Policy>) => {
    setMsg("");
    const res = await fetch("/api/policy", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      setPolicy(d.policy);
      setMsg("ذخیره شد.");
    } else setMsg(d.error ?? "ذخیره نشد.");
  };

  return (
    <>
      <section className="set-section" id="governance">
        <h2>اجازه‌های یارا</h2>
        <p className="muted small" style={{ marginTop: -4 }}>
          این قوانین روی سرور اجرا می‌شوند و مدل نمی‌تواند دورشان بزند. تغییرات پرخطر همیشه تأیید و تایپ نام منبع را لازم دارند. همه‌ی تصمیم‌ها در <Link href="/app/audit" className="link">سوابق تغییرات</Link> ثبت می‌شوند.
        </p>
        <div className="set-card">
          {!policy ? (
            <div className="set-row">
              <span className="faint small">{msg || "در حال بارگذاری…"}</span>
            </div>
          ) : (
            <>
              {TOGGLES.map((t) => (
                <label key={t.key} className="set-row" style={{ cursor: "pointer" }}>
                  <div>
                    <div className="t">{t.title}</div>
                    <div className="d">{t.desc}</div>
                  </div>
                  <input type="checkbox" className="switch" checked={!!policy[t.key]} onChange={(e) => save({ [t.key]: e.target.checked })} />
                </label>
              ))}
              {LIMITS.map((l) => (
                <div key={l.key} className="set-row">
                  <div>
                    <div className="t">{l.title}</div>
                    <div className="d">{l.desc}</div>
                  </div>
                  <input
                    type="number"
                    className="input num"
                    style={{ width: 90 }}
                    min={l.min}
                    max={l.max}
                    defaultValue={policy[l.key] as number}
                    aria-label={l.title}
                    onBlur={(e) => Number(e.target.value) !== policy[l.key] && save({ [l.key]: Number(e.target.value) })}
                  />
                </div>
              ))}
              <div className="set-foot">
                <span role="status" className="small" style={{ color: "var(--ok)" }}>
                  {msg}
                </span>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="set-section" id="limits">
        <h2>محدودیت‌های API لیارا</h2>
        <p className="muted small" style={{ marginTop: -4 }}>
          کارهایی که API لیارا اجازه نمی‌دهد و یارا به‌جایش چه می‌کند. عامل‌ها هم همین فهرست را می‌بینند و به آن ارجاع می‌دهند ({faDigits(limits.length)} مورد).
        </p>
        <div className="set-card">
          {limits.map((l) => (
            <details key={l.id} className="set-row limit-row">
              <summary>
                <span className="pill">{l.area}</span>
                <span className="t">{l.title}</span>
              </summary>
              <p className="d ltr" dir="ltr">
                {l.detail}
              </p>
              <p className="d ltr" dir="ltr">
                <b>Workaround:</b> {l.workaround}
              </p>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}
