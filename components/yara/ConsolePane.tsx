"use client";

import { Bot, LoaderCircle, Plug, RotateCcw, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { cleanShellOutput, stripAnsi } from "@/lib/mask";
import { useWorkbench } from "./Workbench";

type State = "idle" | "connecting" | "open" | "closed" | "error";

const CLOSE_REASONS: Record<string, string> = {
  "app-not-found": "برنامه پیدا نشد یا در حال اجرا نیست.",
  unauthorized: "لیارا کلید را نپذیرفت. اتصال را در تنظیمات بررسی کنید.",
  "upstream-error": "ارتباط با کانتینر قطع شد.",
};

const RUN_TIMEOUT = 25_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ConsoleRunResult = { output: string; exitCode: number | null; timedOut: boolean; via: "console" };

/** What the workbench can ask of a mounted console (used to run Yara's approved commands in view). */
export type ConsoleController = {
  run: (command: string) => Promise<ConsoleRunResult>;
};

/**
 * An interactive shell inside the app's container (same channel as `liara shell`).
 * The browser gets a single-use ticket; the server holds the Liara token.
 * Yara's approved commands run here too, in view, while the user's typing is paused.
 */
export function ConsolePane({ app, active }: { app: string; active: boolean }) {
  const wb = useWorkbench();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const openWait = useRef<((ok: boolean) => void) | null>(null);
  const capture = useRef<{ buf: string; onData: () => void } | null>(null);
  const yaraBusy = useRef(false);
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState("");

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  /** Opens a shell session; resolves true once the shell is ready for input. */
  const connect = useCallback(async (): Promise<boolean> => {
    disconnect();
    setState("connecting");
    setMessage("");
    try {
      const res = await fetch("/api/shell/ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "اتصال برقرار نشد.");

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
        fit.fit();
        termRef.current = term;
        fitRef.current = fit;
        term.onData((d) => {
          // The keyboard is paused while one of Yara's commands is running.
          if (yaraBusy.current) return;
          if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "input", data: d }));
        });
        term.onResize(({ cols, rows }) => wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ type: "resize", cols, rows })));
      }
      const term = termRef.current!;
      term.clear();
      term.writeln(`\x1b[90mConnecting to ${app}…\x1b[0m`);

      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws/shell?ticket=${encodeURIComponent(data.ticket)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        setState("open");
        // Liara exec expects a start frame shortly after the socket opens.
        setTimeout(() => {
          ws.send(JSON.stringify({ action: "start", cols: term.cols, rows: term.rows }));
          // Give the shell a moment to print its prompt before anyone types.
          setTimeout(() => {
            openWait.current?.(true);
            openWait.current = null;
          }, 700);
        }, 600);
        term.focus();
      };
      ws.onmessage = (e) => {
        const text = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
        term.write(text);
        if (capture.current) {
          capture.current.buf += text;
          capture.current.onData();
        }
      };
      ws.onclose = (e) => {
        if (wsRef.current !== ws) return;
        const reason = CLOSE_REASONS[e.reason];
        setState(reason ? "error" : "closed");
        setMessage(reason ?? "");
        term.writeln(`\r\n\x1b[90m— session closed —\x1b[0m`);
        openWait.current?.(false);
        openWait.current = null;
      };
      return await new Promise<boolean>((resolve) => {
        openWait.current = resolve;
        setTimeout(() => {
          if (openWait.current === resolve) {
            openWait.current = null;
            resolve(false);
          }
        }, 15_000);
      });
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [app, disconnect]);

  /**
   * Runs one of Yara's approved commands in this terminal and captures its output.
   * A marker printed after the command tells us it finished and with which exit code;
   * the marker is split in the typed command so the shell's echo never matches it.
   */
  const run = useCallback(
    async (command: string): Promise<ConsoleRunResult> => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        const ok = await connect();
        if (!ok) throw new Error("console-unavailable");
      }
      const ws = wsRef.current!;
      const nonce = Math.random().toString(36).slice(2, 8);
      const marker = new RegExp(`__YARA_DONE_${nonce}_(\\d+)`);
      yaraBusy.current = true;
      setRunning(command);
      try {
        return await new Promise<ConsoleRunResult>((resolve) => {
          const finish = (exitCode: number | null, timedOut: boolean) => {
            const raw = capture.current?.buf ?? "";
            capture.current = null;
            clearTimeout(timer);
            const text = stripAnsi(raw);
            // Drop the echoed command line, keep everything up to the marker.
            const echoEnd = text.indexOf("\n", text.indexOf(`DONE_${nonce}`));
            const end = text.search(marker);
            const body = text.slice(echoEnd >= 0 ? echoEnd + 1 : 0, end >= 0 ? end : undefined);
            resolve({ output: cleanShellOutput(body.trim()), exitCode, timedOut, via: "console" });
          };
          capture.current = {
            buf: "",
            onData: () => {
              const m = stripAnsi(capture.current?.buf ?? "").match(marker);
              if (m) finish(Number(m[1]), false);
            },
          };
          const timer = setTimeout(() => {
            ws.send(JSON.stringify({ type: "input", data: "\x03" }));
            finish(null, true);
          }, RUN_TIMEOUT);
          ws.send(JSON.stringify({ type: "input", data: `${command}; printf '\\n%s%s_%s\\n' __YARA_ DONE_${nonce} $?\n` }));
        });
      } finally {
        yaraBusy.current = false;
        setRunning("");
        termRef.current?.focus();
      }
    },
    [connect],
  );

  // Register with the workbench so Yara's approved commands for this app run here.
  useEffect(() => wb.registerConsole(app, { run }), [app, run, wb]);

  /** Sends the selection, or the last ~150 lines, to Yara with secrets masked. */
  const askAbout = () => {
    const term = termRef.current;
    if (!term) return;
    let text = term.getSelection();
    if (!text.trim()) {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = Math.max(0, buf.length - 150); i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      text = lines.join("\n");
    }
    const clean = cleanShellOutput(text.trim(), 6000);
    if (!clean) return;
    wb.askYara(`این خروجی کنسول برنامه‌ی **${app}** است. توضیح بده چه اتفاقی افتاده و اگر مشکلی هست، راه‌حلش را بگو:\n\n\`\`\`text\n${clean}\n\`\`\``);
  };

  // Refit when the panel is shown or resized.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // terminal not ready yet
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (active && state === "open") termRef.current?.focus();
  }, [active, state]);

  useEffect(
    () => () => {
      disconnect();
      termRef.current?.dispose();
    },
    [disconnect],
  );

  const showOverlay = state === "idle" || state === "error" || (state === "closed" && !termRef.current);

  return (
    <>
      {showOverlay && (
        <div className="term-overlay">
          <SquareTerminal size={28} aria-hidden />
          <div className="t">
            شل داخل کانتینر <span className="ltr">{app}</span>
          </div>
          <p style={{ maxWidth: "46ch" }}>
            {state === "error" ? (
              message
            ) : (
              <>
                مثل <code className="ltr">liara shell</code>: هر دستوری اینجا مستقیم روی برنامه‌ی در حال اجرا اجرا می‌شود. کلید شما در مرورگر قرار نمی‌گیرد.
              </>
            )}
          </p>
          <button type="button" className="btn btn-primary" onClick={() => connect()}>
            {state === "error" ? <RotateCcw size={14} aria-hidden /> : <Plug size={14} aria-hidden />}
            {state === "error" ? "تلاش دوباره" : "اتصال"}
          </button>
        </div>
      )}
      <div className="term-wrap" hidden={showOverlay}>
        <div className="term" ref={hostRef} />
        {(running || state === "open") && (
          <div className={`term-bar ${running ? "busy" : ""}`} role={running ? "status" : undefined}>
            {running ? (
              <>
                <LoaderCircle size={13} className="spin" aria-hidden />
                <span>
                  یارا در حال اجرای <code className="ltr">{running.length > 60 ? `${running.slice(0, 60)}…` : running}</code> است؛ تا پایان، ورودی صفحه‌کلید متوقف است.
                </span>
              </>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={askAbout} title="متن انتخاب‌شده یا ۱۵۰ خط آخر را برای یارا می‌فرستد">
                <Bot size={14} aria-hidden />
                پرسیدن از یارا درباره‌ی این خروجی
              </button>
            )}
          </div>
        )}
      </div>
      {state === "closed" && termRef.current && (
        <div style={{ display: "flex", justifyContent: "center", padding: 6, background: "var(--term-bg)" }}>
          <button type="button" className="btn" onClick={() => connect()}>
            <RotateCcw size={14} aria-hidden />
            اتصال دوباره
          </button>
        </div>
      )}
    </>
  );
}
