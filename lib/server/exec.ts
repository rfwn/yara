import "server-only";
import { WebSocket } from "ws";
import { LiaraError, type LiaraCreds } from "../liara";
import { cleanShellOutput } from "../mask";

const LIARA_EXEC = "wss://api.iran.liara.ir/v1/exec";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one command in the app's container through Liara exec (the same channel as
 * `liara shell`) and returns its output, with ANSI codes stripped and secret-looking
 * env lines masked before anything reaches the model.
 */
export function execOnce(creds: LiaraCreds, app: string, command: string, timeoutMs = 25_000) {
  const url = `${LIARA_EXEC}?token=${encodeURIComponent(creds.token)}&cmd=${encodeURIComponent("/bin/sh")}&project_id=${encodeURIComponent(app)}&teamID=${encodeURIComponent(creds.teamID ?? "")}`;
  return new Promise<{ output: string; timedOut: boolean }>((resolve, reject) => {
    const ws = new WebSocket(url);
    let out = "";
    let done = false;
    const finish = (timedOut: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve({ output: cleanShellOutput(out), timedOut });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    ws.on("open", async () => {
      await sleep(800);
      ws.send(JSON.stringify({ action: "start", cols: 160, rows: 48 }));
      await sleep(300);
      ws.send(JSON.stringify({ type: "input", data: `${command}; exit\n` }));
    });
    ws.on("message", (d) => {
      out += d.toString();
    });
    ws.on("close", () => finish(false));
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      done = true;
      reject(new LiaraError(res.statusCode ?? 502, `Liara exec ${res.statusCode}: ${res.statusCode === 404 ? "app not found or not running" : "rejected"}`));
    });
    ws.on("error", (e) => {
      if (done) return;
      clearTimeout(timer);
      done = true;
      reject(e);
    });
  });
}
