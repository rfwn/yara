"use client";

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { KeyRound, LoaderCircle, Plug, ShieldAlert, ShieldCheck, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type State = "idle" | "connecting" | "open" | "closed" | "error";

const REASONS: Record<string, string> = {
  "auth-failed": "نام کاربری، رمز یا کلید پذیرفته نشد.",
  timeout: "ماشین پاسخ نداد. روشن است و پورت SSH از بیرون باز است؟",
  "host-key-changed": "کلید میزبان این ماشین با دفعه‌ی قبل فرق دارد. اگر ماشین را از نو نساخته‌اید، وصل نشوید.",
  "bad-host": "این ماشین آدرس عمومی معتبر ندارد.",
  idle: "۱۵ دقیقه بی‌فعالیت بود؛ اتصال بسته شد.",
  "max-duration": "هر نشست حداکثر ۲ ساعت است؛ دوباره وصل شوید.",
  "shell-failed": "پوسته‌ی ماشین باز نشد.",
  "no-liara-password": "لیارا رمز root این ماشین را ندارد (احتمالاً با کلید SSH ساخته شده). از «ورود دستی» استفاده کنید.",
  "liara-unreachable": "رمز ماشین از لیارا خوانده نشد. کمی بعد دوباره امتحان کنید یا دستی وارد شوید.",
};

/**
 * SSH into one of the user's own VMs, in the page. The browser gets a ticket bound to the VM's
 * address from Liara. By default the server reads the VM's root password from Liara itself at
 * connect time, so no credential ever passes through the browser; manual login (password or key)
 * is the fallback. Either way nothing is stored, logged or shown to Yara's agents.
 */
export function VmSsh({ vm, on }: { vm: string; on: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<State>("idle");
  const [msg, setMsg] = useState("");
  const [method, setMethod] = useState<"password" | "key">("password");
  const [username, setUsername] = useState("root");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [fp, setFp] = useState<{ fingerprint: string; firstTime?: boolean; changed?: boolean; expected?: string } | null>(null);
  const [target, setTarget] = useState("");
  const [manual, setManual] = useState(false);

  useEffect(
    () => () => {
      wsRef.current?.close();
      termRef.current?.dispose();
    },
    [],
  );

  useEffect(() => {
    const onResize = () => {
      fitRef.current?.fit();
      const t = termRef.current;
      if (t && wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ t: "resize", cols: t.cols, rows: t.rows }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const connect = async (mode: "liara" | "manual") => {
    setMsg("");
    setFp(null);
    setState("connecting");
    try {
      const res = await fetch(`/api/vms/${encodeURIComponent(vm)}/ssh`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "اتصال آماده نشد.");
      if (mode === "liara" && !d.liaraPassword) {
        setManual(true);
        throw new Error("لیارا رمز root این ماشین را ندارد (احتمالاً با کلید SSH ساخته شده). با «ورود دستی» وصل شوید.");
      }
      setTarget(`${mode === "liara" ? "root" : username}@${d.host}${d.port === 22 ? "" : `:${d.port}`}`);

      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (!termRef.current && hostRef.current) {
        const term = new Terminal({
          fontFamily: '"Cascadia Mono", "JetBrains Mono", ui-monospace, Consolas, monospace',
          fontSize: 13,
          cursorBlink: true,
          scrollback: 5000,
          theme: { background: "#141518", foreground: "#d9dce1", cursor: "#4f8bff", selectionBackground: "#4f8bff55" },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(hostRef.current);
        termRef.current = term;
        fitRef.current = fit;
        term.onData((data) => wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ t: "data", d: data })));
      }
      termRef.current?.reset();
      fitRef.current?.fit();

      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/ssh?ticket=${encodeURIComponent(d.ticket)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        const t = termRef.current;
        ws.send(
          JSON.stringify(
            mode === "liara"
              ? { t: "auth", mode: "liara", cols: t?.cols, rows: t?.rows }
              : { t: "auth", username, cols: t?.cols, rows: t?.rows, ...(method === "password" ? { password: secret } : { privateKey: secret, passphrase: passphrase || undefined }) },
          ),
        );
        // The secret has left the page's state; nothing keeps it.
        setSecret("");
        setPassphrase("");
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.t === "data") termRef.current?.write(m.d);
        else if (m.t === "hostkey") setFp(m);
        else if (m.t === "status") {
          if (m.state === "open") {
            setState("open");
            termRef.current?.focus();
          } else if (m.state === "error" || m.state === "closed") setMsg(REASONS[m.reason] ?? m.detail ?? m.reason);
        }
      };
      ws.onclose = (ev) => {
        wsRef.current = null;
        setState((s) => (s === "open" ? "closed" : "error"));
        if (ev.reason && REASONS[ev.reason]) setMsg(REASONS[ev.reason]);
        else if (ev.code === 1006) setMsg((m) => m || "اتصال برقرار نشد.");
      };
    } catch (e) {
      setState("error");
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const disconnect = () => wsRef.current?.close();
  const live = state === "open" || state === "connecting";

  return (
    <section className="box vm-ssh">
      <h2>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <KeyRound size={14} aria-hidden /> ترمینال SSH
        </span>
        {state === "open" && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span className="ltr small faint" dir="ltr">
              {target}
            </span>
            <button type="button" className="btn btn-ghost" style={{ height: 26 }} onClick={disconnect}>
              <Unplug size={13} aria-hidden /> قطع
            </button>
          </span>
        )}
      </h2>
      <div className="body" style={{ display: "grid", gap: 10 }}>
        {!live && (
          <div className="ssh-quick">
            <button type="button" className="btn btn-primary" disabled={!on} onClick={() => connect("liara")}>
              <Plug size={14} aria-hidden /> اتصال به‌عنوان root
            </button>
            <span className="small muted">رمز را سرور یارا همان لحظه از لیارا می‌گیرد؛ به مرورگر نمی‌آید.</span>
            <button type="button" className="link small" onClick={() => setManual((m) => !m)} aria-expanded={manual}>
              {manual ? "بستن ورود دستی" : "ورود دستی (کاربر دیگر یا کلید)"}
            </button>
          </div>
        )}
        {!live && manual && (
          <form
            className="ssh-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (on && secret) connect("manual");
            }}
          >
            <label>
              <span className="small muted">کاربر</span>
              <input className="input ltr" dir="ltr" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} />
            </label>
            <div className="segmented" role="radiogroup" aria-label="روش ورود" style={{ alignSelf: "flex-end" }}>
              {(
                [
                  ["password", "رمز"],
                  ["key", "کلید خصوصی"],
                ] as const
              ).map(([v, l]) => (
                <label key={v}>
                  <input type="radio" name={`ssh-method-${vm}`} value={v} checked={method === v} onChange={() => setMethod(v)} />
                  {l}
                </label>
              ))}
            </div>
            {method === "password" ? (
              <label>
                <span className="small muted">رمز</span>
                <input className="input ltr" dir="ltr" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="current-password" />
              </label>
            ) : (
              <>
                <label className="ssh-key">
                  <span className="small muted">کلید خصوصی (OpenSSH)</span>
                  <textarea className="input ltr" dir="ltr" rows={4} value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                </label>
                <label>
                  <span className="small muted">رمز کلید (اگر دارد)</span>
                  <input className="input ltr" dir="ltr" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" />
                </label>
              </>
            )}
            <button type="submit" className="btn" disabled={!on || !secret || !username}>
              <Plug size={14} aria-hidden /> اتصال دستی
            </button>
          </form>
        )}
        {!on && !live && <p className="small muted">ماشین خاموش است؛ برای اتصال اول روشنش کنید.</p>}
        <p className="small faint ssh-note">
          <ShieldCheck size={12} aria-hidden /> اتصال فقط به آدرس همین ماشین (از لیارا) برقرار می‌شود. هیچ رمز یا کلیدی ذخیره نمی‌شود و عامل‌های یارا آن را نمی‌بینند. کلید میزبان در اولین اتصال ثبت و بعد از آن بررسی می‌شود. ورود و خروج در سوابق تغییرات ثبت می‌شود.
        </p>
        {state === "connecting" && (
          <p className="small muted" role="status">
            <LoaderCircle size={13} className="spin" aria-hidden /> در حال اتصال…
          </p>
        )}
        {fp && (
          <p className={`small ${fp.changed ? "error-text" : "muted"} ltr`} dir="ltr">
            {fp.changed ? <ShieldAlert size={12} aria-hidden /> : <ShieldCheck size={12} aria-hidden />} host key {fp.fingerprint}
            {fp.firstTime ? " (first connection: saved; compare it with the VM console if you can)" : fp.changed ? ` ≠ saved ${fp.expected}` : " (matches the saved key)"}
          </p>
        )}
        {msg && (
          <p className="error-text small" role="alert">
            {msg}
          </p>
        )}
        {fp?.changed && state !== "open" && (
          <div className="ssh-quick">
            <span className="small muted">اگر ماشین را از نو ساخته یا سیستم‌عامل را دوباره نصب کرده‌اید، کلید جدید طبیعی است.</span>
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                await fetch(`/api/vms/${encodeURIComponent(vm)}/ssh`, { method: "DELETE" });
                setFp(null);
                setMsg("کلید قبلی فراموش شد. دوباره وصل شوید؛ کلید جدید ثبت می‌شود.");
              }}
            >
              ماشین را از نو ساخته‌ام؛ به کلید جدید اعتماد کن
            </button>
          </div>
        )}
        <div className="ssh-term" ref={hostRef} hidden={state === "idle" || state === "error"} />
      </div>
    </section>
  );
}
