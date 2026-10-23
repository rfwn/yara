"use client";

import { ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type NetEntry = { id: number; command: string; ok: boolean; output: string; pending?: boolean; by: "user" | "yara" };

const EXAMPLES = ["dig example.ir NS", "http https://example.ir", "tls example.ir", "port example.ir 443", "whois example.ir"];

/**
 * A small command line for network checks run on Yara's server. Not a shell: only dig, http, tls,
 * port and whois exist, against public hosts, rate-limited and recorded in the audit log.
 */
export function NetPane({ active, entries, setEntries }: { active: boolean; entries: NetEntry[]; setEntries: (fn: (e: NetEntry[]) => NetEntry[]) => void }) {
  const [line, setLine] = useState("");
  const [hist, setHist] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const outRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active) inputRef.current?.focus({ preventScroll: true });
  }, [active]);
  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [entries]);

  const run = async (cmd: string) => {
    const command = cmd.trim();
    if (!command) return;
    if (command === "clear") {
      setEntries(() => []);
      setLine("");
      return;
    }
    setHist((h) => [command, ...h.filter((x) => x !== command)].slice(0, 50));
    setCursor(-1);
    setLine("");
    const id = Date.now();
    setEntries((e) => [...e, { id, command, ok: true, output: "", pending: true, by: "user" }]);
    let r: NetEntry;
    try {
      const res = await fetch("/api/net", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }) });
      const d = await res.json();
      r = { id, command, ok: !!d.ok, output: d.output ?? d.error ?? "خطا", by: "user" };
    } catch (e) {
      r = { id, command, ok: false, output: e instanceof Error ? e.message : String(e), by: "user" };
    }
    setEntries((e) => e.map((x) => (x.id === id ? r : x)));
  };

  return (
    <div className="net-pane" onClick={() => inputRef.current?.focus({ preventScroll: true })}>
      <div className="net-out ltr" dir="ltr" ref={outRef} aria-live="polite">
        {entries.length === 0 && (
          <div className="net-intro" dir="rtl">
            <p>
              <ShieldCheck size={13} aria-hidden /> ابزار شبکه روی سرور یارا اجرا می‌شود؛ پوسته نیست. فقط <code>dig</code>، <code>http</code>، <code>tls</code>، <code>port</code> و <code>whois</code> روی میزبان‌های عمومی اینترنت، با سقف ۳۰ بار در دقیقه، و هر اجرا در سوابق تغییرات ثبت می‌شود.
            </p>
            <div className="net-examples">
              {EXAMPLES.map((x) => (
                <button key={x} type="button" className="ltr" dir="ltr" onClick={() => setLine(x)}>
                  {x}
                </button>
              ))}
              <button type="button" className="ltr" dir="ltr" onClick={() => run("help")}>
                help
              </button>
            </div>
          </div>
        )}
        {entries.map((e) => (
          <div key={e.id} className="net-entry" data-ok={e.ok} data-by={e.by}>
            <div className="net-cmd">
              <span className="net-prompt">{e.by === "yara" ? "agent$" : "you$"}</span> {e.command}
              {e.by === "yara" && <span className="net-by">اجرا شده توسط یارا</span>}
            </div>
            <pre>{e.pending ? "…" : e.output}</pre>
          </div>
        ))}
      </div>
      <form
        className="net-input ltr"
        dir="ltr"
        onSubmit={(e) => {
          e.preventDefault();
          run(line);
        }}
      >
        <span className="net-prompt">yara$</span>
        <input
          ref={inputRef}
          value={line}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && hist.length) {
              e.preventDefault();
              const n = Math.min(cursor + 1, hist.length - 1);
              setCursor(n);
              setLine(hist[n]);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const n = cursor - 1;
              setCursor(Math.max(n, -1));
              setLine(n >= 0 ? hist[n] : "");
            }
          }}
          placeholder="dig example.ir NS"
          spellCheck={false}
          autoComplete="off"
          aria-label="فرمان شبکه"
          maxLength={300}
        />
      </form>
    </div>
  );
}
