"use client";

import { ArrowLeft, Check, Eye, EyeOff, KeyRound, LoaderCircle, Monitor, Moon, Sun } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { faDigits } from "@/lib/fa";

async function sendJSON(url: string, body: unknown, method = "POST") {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "مشکلی پیش آمد. دوباره امتحان کنید.");
  return data;
}

function PasswordInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <input {...props} type={show ? "text" : "password"} className="input ltr" style={{ paddingInlineEnd: 40 }} />
      <button
        type="button"
        className="icon-btn"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "پنهان کردن رمز" : "نمایش رمز"}
        style={{ position: "absolute", insetInlineEnd: 4, top: 4 }}
      >
        {show ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
      </button>
    </div>
  );
}

const Spinner = () => <LoaderCircle size={15} className="spin" aria-hidden />;

// ---------- sign up / log in ----------

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signup = mode === "signup";

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await sendJSON(`/api/auth/${mode}`, Object.fromEntries(new FormData(e.currentTarget)));
      router.push(data.next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={submit}>
      {signup && (
        <label className="field">
          <span className="field-label">نام</span>
          <input name="name" className="input" required minLength={2} maxLength={60} autoComplete="name" />
        </label>
      )}
      <label className="field">
        <span className="field-label">ایمیل</span>
        <input name="email" type="email" className="input ltr" required autoComplete="email" inputMode="email" />
      </label>
      <label className="field">
        <span className="field-label">رمز عبور</span>
        <PasswordInput name="password" required minLength={signup ? 8 : 1} autoComplete={signup ? "new-password" : "current-password"} />
        {signup && <span className="hint">دست‌کم ۸ نویسه.</span>}
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
        {busy && <Spinner />}
        {signup ? "ساخت حساب" : "ورود"}
      </button>
      <p className="auth-alt">
        {signup ? (
          <>
            حساب دارید؟{" "}
            <Link href="/login" className="link">
              وارد شوید
            </Link>
          </>
        ) : (
          <>
            حساب ندارید؟{" "}
            <Link href="/signup" className="link">
              بسازید
            </Link>
          </>
        )}
      </p>
    </form>
  );
}

// ---------- onboarding: connect Liara ----------

export function ConnectForm({ initialTeam = "" }: { initialTeam?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [apps, setApps] = useState<number | null>(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const data = await sendJSON("/api/me", { liaraToken: f.get("token"), teamID: f.get("team") }, "PATCH");
      setApps(data.apps ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (apps !== null) {
    return (
      <div className="success">
        <span className="success-icon">
          <Check size={26} strokeWidth={2.5} aria-hidden />
        </span>
        <h2 style={{ fontSize: 18 }}>حساب لیارای شما وصل شد</h2>
        <p className="muted">{apps ? `${faDigits(apps)} برنامه در این حساب پیدا شد.` : "هنوز برنامه‌ای در این حساب نیست، ولی یارا آماده است."}</p>
        <button
          type="button"
          className="btn btn-primary btn-lg"
          style={{ marginTop: 6 }}
          onClick={() => {
            router.push("/app");
            router.refresh();
          }}
        >
          شروع کار با یارا
          <ArrowLeft size={16} aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">کلید API لیارا</span>
        <input name="token" type="password" className="input ltr" required autoComplete="off" spellCheck={false} placeholder="eyJhbGciOi…" />
      </label>
      <ol className="steps-list">
        <li>
          وارد{" "}
          <a href="https://console.liara.ir/API" target="_blank" rel="noreferrer" className="link">
            بخش API کنسول لیارا
          </a>{" "}
          شوید.
        </li>
        <li>یک کلید تازه با مدت اعتبار دلخواه بسازید.</li>
        <li>کلید را کپی کنید و بالا بگذارید.</li>
      </ol>
      <label className="field">
        <span className="field-label">
          شناسه‌ی تیم <span className="faint">(اختیاری)</span>
        </span>
        <input name="team" className="input ltr" defaultValue={initialTeam} autoComplete="off" spellCheck={false} />
        <span className="hint">فقط اگر برنامه‌هایتان داخل یک تیم در لیاراست.</span>
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
        {busy && <Spinner />}
        بررسی و اتصال
      </button>
      <p className="hint" style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center" }}>
        <KeyRound size={13} aria-hidden />
        کلید پیش از ذخیره با لیارا بررسی و رمزنگاری‌شده نگه داشته می‌شود.
      </p>
    </form>
  );
}

// ---------- settings ----------

type Model = { id: string; label: string };

export function SettingsForm({
  user,
  models,
  defaultModel,
}: {
  user: { name: string; email: string; teamID: string | null; model: string | null; hasToken: boolean };
  models: Model[];
  defaultModel: string;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState("system");
  const [confirmDelete, setConfirmDelete] = useState("");

  useEffect(() => {
    try {
      setTheme(localStorage.getItem("yara-theme") ?? "system");
    } catch {
      // storage unavailable
    }
  }, []);

  const applyTheme = (t: string) => {
    setTheme(t);
    try {
      if (t === "system") localStorage.removeItem("yara-theme");
      else localStorage.setItem("yara-theme", t);
    } catch {
      // storage unavailable; theme applies for this visit
    }
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  };

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const body: Record<string, unknown> = { name: f.get("name"), teamID: f.get("team"), model: f.get("model") };
      const token = String(f.get("token") ?? "").trim();
      if (token) body.liaraToken = token;
      await sendJSON("/api/me", body, "PATCH");
      setSaved(true);
      const tokenInput = form.querySelector<HTMLInputElement>('input[name="token"]');
      if (tokenInput) tokenInput.value = "";
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await fetch("/api/me", { method: "DELETE" });
    router.push("/");
    router.refresh();
  };

  return (
    <>
      <section className="set-section">
        <h2>حساب و اتصال</h2>
        <form className="set-card" onSubmit={save} onChange={() => setSaved(false)}>
          <div className="set-row">
            <div>
              <div className="t">نام</div>
            </div>
            <input name="name" className="input" defaultValue={user.name} minLength={2} maxLength={60} required aria-label="نام" />
          </div>
          <div className="set-row">
            <div>
              <div className="t">ایمیل</div>
              <div className="d">برای ورود استفاده می‌شود.</div>
            </div>
            <span className="ltr muted" style={{ textAlign: "right" }}>
              {user.email}
            </span>
          </div>
          <div className="set-row">
            <div>
              <div className="t">کلید API لیارا</div>
              <div className="d">{user.hasToken ? "متصل است. برای جایگزینی، کلید تازه را وارد کنید." : "هنوز کلیدی وصل نشده است."}</div>
            </div>
            <input name="token" type="password" className="input ltr" autoComplete="off" spellCheck={false} placeholder={user.hasToken ? "••••••••" : ""} aria-label="کلید API لیارا" />
          </div>
          <div className="set-row">
            <div>
              <div className="t">شناسه‌ی تیم</div>
              <div className="d">اختیاری.</div>
            </div>
            <input name="team" className="input ltr" defaultValue={user.teamID ?? ""} autoComplete="off" aria-label="شناسه‌ی تیم" />
          </div>
          <div className="set-row">
            <div>
              <div className="t">مدل هوش مصنوعی</div>
              <div className="d">باید از ابزارها پشتیبانی کند.</div>
            </div>
            <select name="model" className="select" defaultValue={user.model ?? ""} aria-label="مدل هوش مصنوعی">
              <option value="">پیش‌فرض ({models.find((m) => m.id === defaultModel)?.label ?? defaultModel})</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="set-foot">
            <span role="status" className="small" style={{ color: error ? "var(--danger)" : "var(--ok)" }}>
              {error || (saved ? "ذخیره شد." : "")}
            </span>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy && <Spinner />}
              ذخیره‌ی تغییرات
            </button>
          </div>
        </form>
      </section>

      <section className="set-section">
        <h2>ظاهر</h2>
        <div className="set-card">
          <div className="set-row">
            <div>
              <div className="t">پوسته</div>
              <div className="d">از پنجره‌ی فرمان‌ها هم قابل تغییر است.</div>
            </div>
            <div className="segmented" role="radiogroup" aria-label="پوسته">
              {(
                [
                  ["system", "سیستم", Monitor],
                  ["light", "روشن", Sun],
                  ["dark", "تیره", Moon],
                ] as const
              ).map(([v, l, Icon]) => (
                <label key={v}>
                  <input type="radio" name="theme" value={v} checked={theme === v} onChange={() => applyTheme(v)} />
                  <Icon size={14} aria-hidden />
                  {l}
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="set-section">
        <h2 style={{ color: "var(--danger)" }}>حذف حساب</h2>
        <div className="set-card">
          <div className="set-row">
            <div>
              <div className="t">حذف همیشگی</div>
              <div className="d">حساب، همه‌ی گفت‌وگوها و کلید ذخیره‌شده پاک می‌شوند. برای تأیید، ایمیل خود را بنویسید.</div>
            </div>
            <input className="input ltr" value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} placeholder={user.email} autoComplete="off" aria-label="تأیید با ایمیل" />
          </div>
          <div className="set-foot" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn btn-danger" disabled={confirmDelete.trim().toLowerCase() !== user.email.toLowerCase()} onClick={remove}>
              حذف حساب
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
