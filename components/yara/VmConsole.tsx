"use client";

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { KeyRound, LoaderCircle, Plug, ShieldAlert, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useWorkbench } from "./Workbench";

type State = "idle" | "connecting" | "open" | "closed" | "error";

const REASONS: Record<string, string> = {
  "auth-failed": "نام کاربری، رمز یا کلید پذیرفته نشد. اگر رمز root را داخل ماشین عوض کرده‌اید، رمز لیارا دیگر معتبر نیست.",
  timeout: "ماشین پاسخ نداد. پورت SSH از بیرون باز است و sshd اجرا می‌شود؟",
  "host-key-changed": "کلید میزبان این ماشین با دفعه‌ی قبل فرق دارد؛ اتصال پیش از فرستادن رمز قطع شد.",
  "bad-host": "این ماشین آدرس عمومی معتبر ندارد.",
  idle: "۱۵ دقیقه بی‌فعالیت بود؛ اتصال بسته شد.",
  "max-duration": "هر نشست حداکثر ۲ ساعت است؛ دوباره وصل شوید.",
  "shell-failed": "پوسته‌ی ماشین باز نشد.",
  "no-liara-password": "لیارا رمز root این ماشین را ندارد (احتمالاً با کلید SSH ساخته شده). از «ورود دستی» استفاده کنید.",
  "liara-unreachable": "رمز ماشین از لیارا خوانده نشد. کمی بعد دوباره امتحان کنید.",
  "ssh-error": "اتصال SSH برقرار نشد.",
};

const DIM = "\x1b[2m";
const BLUE = "\x1b[38;5;75m";
const RESET = "\x1b[0m";

/**
 * A VM's terminal in the bottom panel. Connect as root (the server reads the password from Liara,
 * so it never reaches the browser) or manually. Yara's own commands on this VM (runVmCommand) are
 * printed here too, marked as Yara's, whether or not an interactive session is open.
 */
export function VmConsole({ vm, active }: { vm: string; active: boolean }) {
  const wb = useWorkbench();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<State>("idle");
  const [msg, setMsg] = useState("");
  const [manual, setManual] = useState(false);
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [fp, setFp] = useState<{ fingerprint: string; firstTime?: boolean; changed?: boolean; expected?: string } | null>(null);
  const [target, setTarget] = useState("");

  // The terminal exists from the start, so Yara's commands can be shown before anyone connects.
  useEffect(() => {
    let disposed = false;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !hostRef.current) return;
      const term = new Terminal({
        fontFamily: '"Cascadia Mono", "JetBrains Mono", ui-monospace, Consolas, monospace',
        fontSize: 13,
        cursorBlink: true,
        scrollback: 8000,
        convertEol: true,
        theme: { background: "#141518", foreground: "#d9dce1", cursor: "#4f8bff", selectionBackground: "#4f8bff55" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();
      term.writeln(`${DIM}SSH console for VM ${vm}. Connect as root, or watch Yara's commands on this VM appear here.${RESET}`);
      term.onData((d) => wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ t: "data", d })));
      termRef.current = term;
      fitRef.current = fit;
    })();
    return () => {
      disposed = true;
      wsRef.current?.close();
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [vm]);

  // Lets the workbench print Yara's runVmCommand output into this terminal.
  useEffect(
    () =>
      wb.registerConsole(`vm:${vm}`, {
        print: (text: string) => termRef.current?.write(text),
      }),
    [vm, wb],
  );

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      fitRef.current?.fit();
      const term = termRef.current;
      if (term && wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    }, 50);
    return () => clearTimeout(t);
  }, [active]);

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
        throw new Error(REASONS["no-liara-password"]);
      }
      setTarget(`${mode === "liara" ? "root" : username}@${d.host}${d.port === 22 ? "" : `:${d.port}`}`);
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/ssh?ticket=${encodeURIComponent(d.ticket)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        const t = termRef.current;
        ws.send(JSON.stringify(mode === "liara" ? { t: "auth", mode: "liara", cols: t?.cols, rows: t?.rows } : { t: "auth", username, password, cols: t?.cols, rows: t?.rows }));
        setPassword("");
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
        // 1006 before anything else: the socket route itself was not reachable (an old server.mjs is still running).
        else if (ev.code === 1006) setMsg((m) => m || "اتصال به سرور SSH یارا برقرار نشد. اگر سرور توسعه را از قبل از این قابلیت اجرا کرده‌اید، یک بار ری‌استارتش کنید.");
      };
    } catch (e) {
      setState("error");
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const live = state === "open" || state === "connecting";

  return (
    <div className="vm-console">
      <div className="vm-console-bar">
        <KeyRound size={13} aria-hidden />
        <span className="ltr small" dir="ltr">
          {state === "open" ? target : vm}
        </span>
        {state === "connecting" && <LoaderCircle size={13} className="spin" aria-label="در حال اتصال" />}
        {msg && (
          <span className="vm-console-msg" role="alert">
            {msg}
          </span>
        )}
        <span className="spacer" />
        {fp?.changed && !live && (
          <button
            type="button"
            className="btn btn-danger"
            style={{ height: 24 }}
            onClick={async () => {
              await fetch(`/api/vms/${encodeURIComponent(vm)}/ssh`, { method: "DELETE" });
              setFp(null);
              setMsg("کلید قبلی فراموش شد؛ دوباره وصل شوید.");
            }}
            title={`کلید جدید: ${fp.fingerprint}`}
          >
            <ShieldAlert size={12} aria-hidden /> ماشین را از نو ساخته‌ام؛ به کلید جدید اعتماد کن
          </button>
        )}
        {live ? (
          <button type="button" className="btn btn-ghost" style={{ height: 24 }} onClick={() => wsRef.current?.close()}>
            <Unplug size={12} aria-hidden /> قطع
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" style={{ height: 24 }} onClick={() => setManual((m) => !m)} aria-expanded={manual}>
              ورود دستی
            </button>
            <button type="button" className="btn btn-primary" style={{ height: 24 }} onClick={() => connect("liara")} title="رمز root را سرور یارا همان لحظه از لیارا می‌گیرد؛ به مرورگر نمی‌آید.">
              <Plug size={12} aria-hidden /> اتصال به‌عنوان root
            </button>
          </>
        )}
      </div>
      {manual && !live && (
        <form
          className="vm-console-manual"
          onSubmit={(e) => {
            e.preventDefault();
            if (username && password) connect("manual");
          }}
        >
          <input className="input ltr" dir="ltr" value={username} onChange={(e) => setUsername(e.target.value)} aria-label="کاربر" autoComplete="username" spellCheck={false} />
          <input className="input ltr" dir="ltr" type="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="رمز" placeholder="password" autoComplete="current-password" />
          <button type="submit" className="btn" style={{ height: 28 }} disabled={!username || !password}>
            اتصال دستی
          </button>
          <span className="small faint">رمز فقط یک بار به سرور می‌رود و ذخیره نمی‌شود.</span>
        </form>
      )}
      {fp && !fp.changed && <div className="vm-console-fp ltr" dir="ltr">host key {fp.fingerprint}{fp.firstTime ? " (first connection: saved)" : " (matches)"}</div>}
      <div className="vm-console-term" ref={hostRef} />
    </div>
  );
}

/** Formats one of Yara's VM commands for the terminal: a marked prompt line, then the output. */
export function yaraCommandBlock(command: string) {
  return `\r\n${BLUE}[yara]${RESET} ${BLUE}$${RESET} ${command}\r\n`;
}
