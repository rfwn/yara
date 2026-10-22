"use client";

import { RotateCcw } from "lucide-react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="auth">
      <div className="auth-card">
        <div>
          <h1>کار به مشکل خورد</h1>
          <p className="lead">خطایی پیش‌بینی‌نشده رخ داد. دوباره امتحان کنید؛ اگر تکرار شد، صفحه را تازه کنید.</p>
          {error.digest && <p className="faint small ltr" style={{ marginTop: 8, textAlign: "right" }}>ref: {error.digest}</p>}
        </div>
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={reset}>
          <RotateCcw size={16} aria-hidden />
          تلاش دوباره
        </button>
      </div>
    </main>
  );
}
