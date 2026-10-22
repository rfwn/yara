"use client";

import { FileArchive, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppSummary } from "./Workbench";

const PLATFORMS = ["node", "next", "laravel", "php", "python", "django", "flask", "dotnet", "react", "angular", "vue", "static", "docker", "go"];

export type UploadedSource = { app: string; sourceID: string; fileName: string; size: number; port?: string; platform?: string };

export function DeployDialog({ apps, onUploaded, onClose }: { apps: AppSummary[]; onUploaded: (s: UploadedSource) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [app, setApp] = useState(apps[0]?.name ?? "");
  const [platform, setPlatform] = useState(apps[0]?.platform ?? "");
  const [port, setPort] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !app) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("app", app);
      form.set("file", file);
      const res = await fetch("/api/deploy/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `بارگذاری ناموفق بود (${res.status})`);
      onUploaded({ ...data, port, platform });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="deploy-title">
      <form onSubmit={submit}>
        <div className="dialog-head">
          <h2 id="deploy-title">استقرار کد</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="بستن">
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="dialog-body">
          <p className="hint">
            از پروژه‌تان یک فایل فشرده بسازید، مثلاً:{" "}
            <code className="ltr">tar --exclude=node_modules --exclude=.git -czf app.tar.gz .</code>
            <br />
            یارا فایل را بارگذاری می‌کند و استقرار را پیش از اجرا برای تأیید شما می‌آورد.
          </p>
          <label className="field">
            <span className="field-label">برنامه</span>
            {apps.length ? (
              <select
                className="select"
                value={app}
                onChange={(e) => {
                  setApp(e.target.value);
                  setPlatform(apps.find((a) => a.name === e.target.value)?.platform ?? "");
                }}
              >
                {apps.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name} ({a.platform})
                  </option>
                ))}
              </select>
            ) : (
              <input className="input ltr" value={app} onChange={(e) => setApp(e.target.value)} placeholder="app-name" />
            )}
          </label>
          <div className="grid-2">
            <label className="field">
              <span className="field-label">پلتفرم</span>
              <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="">مانند برنامه</option>
                {PLATFORMS.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">پورت (اختیاری)</span>
              <input className="input ltr" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="3000" />
            </label>
          </div>
          <label className="file-drop">
            <input type="file" accept=".gz,.tgz,application/gzip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <FileArchive size={22} aria-hidden />
            <span>{file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : "فایل .tar.gz را انتخاب کنید یا اینجا رها کنید"}</span>
          </label>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            انصراف
          </button>
          <button type="submit" className="btn btn-primary" disabled={!file || !app || busy}>
            {busy ? "در حال بارگذاری…" : "بارگذاری"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
