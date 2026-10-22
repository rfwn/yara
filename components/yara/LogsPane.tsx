"use client";

import { ArrowDownToLine, Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type Line = { type: string; datetime: string; message: string };

const ERROR_LINE = /error|exception|traceback|fatal|panic|killed|oom|refused|timeout|ECONN|EADDRINUSE/i;

/** Live-ish app logs: polls every few seconds while visible. */
export function LogsPane({ app, active }: { app: string; active: boolean }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active || paused) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(app)}/logs?seconds=1800`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "لاگ‌ها بارگذاری نشد.");
        if (!stop) {
          setLines(data.lines);
          setError("");
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [app, active, paused]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return lines.filter((l) => (!errorsOnly || l.type === "stderr" || ERROR_LINE.test(l.message)) && (!f || l.message.toLowerCase().includes(f)));
  }, [lines, filter, errorsOnly]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [shown, follow]);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 10px 6px" }}>
        <input className="log-filter" dir="auto" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="جست‌وجو در لاگ…" aria-label="فیلتر لاگ" />
        <label className="small muted" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
          فقط خطاها
        </label>
        <span style={{ flex: 1 }} />
        <span className="faint small">{error ? <span className="error-text">{error}</span> : paused ? "متوقف" : "به‌روزرسانی هر ۵ ثانیه · ۳۰ دقیقه‌ی اخیر"}</span>
        <button type="button" className="icon-btn" onClick={() => setPaused((p) => !p)} aria-label={paused ? "ادامه" : "توقف"} title={paused ? "ادامه" : "توقف"}>
          {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
        </button>
        <button type="button" className="icon-btn" onClick={() => setFollow(true)} aria-label="رفتن به آخر" title="رفتن به آخر" aria-pressed={follow}>
          <ArrowDownToLine size={14} aria-hidden />
        </button>
      </div>
      <div
        className="log-stream"
        ref={boxRef}
        onScroll={() => {
          const el = boxRef.current;
          if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
      >
        {shown.length === 0 ? (
          <span className="ts">{error ? "" : lines.length ? "No lines match the filter." : "No log lines in the last 30 minutes."}</span>
        ) : (
          shown.map((l, i) => (
            <div key={i} className={l.type === "stderr" || ERROR_LINE.test(l.message) ? "err" : undefined}>
              <span className="ts">{l.datetime?.slice(11, 19)}</span>
              {l.message}
            </div>
          ))
        )}
      </div>
    </>
  );
}
