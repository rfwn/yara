"use client";

import { Check, Copy, FolderGit2, Laptop, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type WorkspaceInfo = { id: string; kind: "github" | "local"; label: string; online: boolean };

async function sendJSON(url: string, body: unknown, method = "POST") {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "درخواست ناموفق بود.");
  return data;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label="کپی"
      title="کپی"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}

/** Where the agents get code from: GitHub clones on the server, or a folder on the user's machine via the runner. */
export function CodeSettings({ hasGithub, hasRunnerToken }: { hasGithub: boolean; hasRunnerToken: boolean }) {
  const [github, setGithub] = useState(hasGithub);
  const [ghMsg, setGhMsg] = useState("");
  const [repoMsg, setRepoMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [token, setToken] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);

  const load = useCallback(async () => {
    const res = await fetch("/api/workspaces");
    if (res.ok) setWorkspaces((await res.json()).workspaces);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const runCmd = `npx yara-runner --server ${origin} --token ${token || "<توکن>"} --dir .`;

  return (
    <section className="set-section">
      <h2>کد و فضاهای کاری</h2>
      <p className="muted small" style={{ marginTop: -4 }}>
        عامل‌ها برای پیدا و درست کردن باگ‌ها به کد شما دسترسی لازم دارند. خواندن و بیلد گرفتن خودکار است؛ هر ویرایش، push یا استقرار پیش از اجرا برای تأیید شما می‌آید.
      </p>

      <div className="set-card">
        <form
          className="set-row"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const form = e.currentTarget;
            setBusy("gh");
            setGhMsg("");
            try {
              await sendJSON("/api/me", { githubToken: String(f.get("gh") ?? "").trim() }, "PATCH");
              setGithub(true);
              setGhMsg("وصل شد.");
              form.reset();
            } catch (err) {
              setGhMsg(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy("");
            }
          }}
        >
          <div>
            <div className="t">توکن گیت‌هاب</div>
            <div className="d">{ghMsg || (github ? "متصل است. برای جایگزینی، توکن تازه وارد کنید." : "یک fine-grained token با دسترسی Contents و Pull requests روی مخزن‌هایتان.")}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input name="gh" type="password" className="input ltr" autoComplete="off" spellCheck={false} placeholder={github ? "••••••••" : "github_pat_…"} aria-label="توکن گیت‌هاب" required />
            <button type="submit" className="btn" disabled={busy === "gh"}>
              ذخیره
            </button>
          </div>
        </form>

        <form
          className="set-row"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const form = e.currentTarget;
            setBusy("repo");
            setRepoMsg("در حال کلون…");
            try {
              await sendJSON("/api/workspaces", { repo: f.get("repo"), branch: f.get("branch") });
              setRepoMsg("کلون شد.");
              form.reset();
              load();
            } catch (err) {
              setRepoMsg(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy("");
            }
          }}
        >
          <div>
            <div className="t">افزودن مخزن گیت‌هاب</div>
            <div className="d">{repoMsg || "روی سرور یارا کلون می‌شود؛ اصلاح‌ها در شاخه‌ی تازه push و PR باز می‌شود."}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input name="repo" className="input ltr" placeholder="owner/repo" required disabled={!github} aria-label="مخزن" />
            <input name="branch" className="input ltr" placeholder="main" style={{ width: 90 }} disabled={!github} aria-label="شاخه" />
            <button type="submit" className="btn" disabled={!github || busy === "repo"}>
              افزودن
            </button>
          </div>
        </form>

        <div className="set-row" id="runner" style={{ alignItems: "start", scrollMarginTop: 16 }}>
          <div>
            <div className="t">پوشه‌ی روی رایانه‌ی شما (پیشنهادی)</div>
            <div className="d">
              رانر یارا را در پوشه‌ی پروژه اجرا کنید تا عامل‌ها همان‌جا بخوانند، بیلد بگیرند و (با تأیید شما) ویرایش کنند. فقط همان پوشه در دسترس است و کلیدهای شما به فرمان‌ها منتقل نمی‌شوند.
              {hasRunnerToken && !token && " توکن قبلی همچنان کار می‌کند؛ ساختن توکن تازه آن را باطل می‌کند."}
            </div>
          </div>
          <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
            <button
              type="button"
              className="btn"
              disabled={busy === "runner"}
              onClick={async () => {
                setBusy("runner");
                try {
                  setToken((await sendJSON("/api/runner/token", {})).token);
                } finally {
                  setBusy("");
                }
              }}
            >
              <RefreshCw size={14} aria-hidden />
              {hasRunnerToken || token ? "ساخت توکن تازه" : "ساخت توکن رانر"}
            </button>
          </div>
        </div>
        {token && (
          <div className="set-row" style={{ display: "block" }}>
            <div className="d" style={{ marginBottom: 6 }}>
              این فرمان را در پوشه‌ی پروژه اجرا کنید (توکن فقط همین یک بار نمایش داده می‌شود):
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <pre className="json" style={{ flex: 1, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {runCmd}
              </pre>
              <CopyButton text={runCmd} />
            </div>
          </div>
        )}

        <div className="set-row" style={{ display: "block" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div className="t">فضاهای متصل</div>
            <button type="button" className="icon-btn" onClick={load} aria-label="به‌روزرسانی" title="به‌روزرسانی">
              <RefreshCw size={14} aria-hidden />
            </button>
          </div>
          {workspaces.length === 0 ? (
            <p className="d">هنوز چیزی وصل نشده است.</p>
          ) : (
            <ul className="ws-list">
              {workspaces.map((w) => (
                <li key={w.id}>
                  {w.kind === "github" ? <FolderGit2 size={14} aria-hidden /> : <Laptop size={14} aria-hidden />}
                  <span className="ltr grow" dir="ltr" title={w.label}>
                    {w.label}
                  </span>
                  <span className={`pill ${w.online ? "pill-ok" : ""}`}>{w.online ? "آنلاین" : "آفلاین"}</span>
                  {w.kind === "github" && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`حذف ${w.label}`}
                      onClick={async () => {
                        if (!confirm(`کلون «${w.label}» از سرور حذف شود؟`)) return;
                        await fetch(`/api/workspaces/${encodeURIComponent(w.id)}`, { method: "DELETE" });
                        load();
                      }}
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
