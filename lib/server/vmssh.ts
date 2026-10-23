import "server-only";
import crypto from "node:crypto";
import net from "node:net";
import { Client } from "ssh2";
import { enc, type LiaraClient } from "../liara";
import { maskSecrets } from "../mask";
import { resolveVM } from "../vms";
import { db } from "./db";

// Commands on the user's VMs over SSH, for the agents. Credentials come from Liara at the moment
// of connecting (the VM's root password in the IaaS API) and stay inside this function: they are
// never returned, logged, stored or shown to the model. Host keys are pinned per user+VM (trust on
// first use, shared with the interactive console); a changed key stops before any password is sent.

export type VmExecResult = { vm: string; host: string; exitCode: number | null; output: string; durationMs: number; timedOut: boolean };

/** Which step failed, so the user and the agent can act on it instead of guessing. */
export class VmSshError extends Error {
  constructor(
    public stage: "lookup" | "no-password" | "network" | "auth" | "host-key" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

const MAX_OUTPUT = 200_000;

type Raw = { _id: string; name: string; power?: string; IPs?: { address: string; version: string }[]; config?: { sshPort?: string | number; rootPassword?: string } };

/** The VM's public IPv4, SSH port and root password, read from Liara now. The password never leaves this module. */
async function target(c: LiaraClient, ref: string) {
  const vm = await resolveVM(c, ref).catch((e) => {
    throw new VmSshError("lookup", e instanceof Error ? e.message : String(e));
  });
  const d = await c.iaas.get<Raw>(`/vm/${enc(vm._id)}`);
  if (d.power !== "POWERED_ON") throw new VmSshError("lookup", `VM ${vm.name} is not powered on (${d.power}). Start it first (setVMPower).`);
  const host = (d.IPs ?? []).map((ip) => ip.address).find((a) => net.isIPv4(a));
  if (!host) throw new VmSshError("lookup", `VM ${vm.name} has no public IPv4 address.`);
  const allowPrivate = process.env.SSH_ALLOW_PRIVATE === "1";
  const [a, b] = host.split(".").map(Number);
  const priv = a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  if (priv && !allowPrivate) throw new VmSshError("lookup", `VM ${vm.name} reports a private address (${host}); refusing.`);
  return { id: vm._id, name: vm.name, host, port: Number(d.config?.sshPort) || 22, password: d.config?.rootPassword || null };
}

function pinHostKey(userId: string, vmId: string) {
  let seen = "";
  const verifier = (key: Buffer) => {
    const fp = `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
    seen = fp;
    const known = db().prepare("SELECT fingerprint FROM vm_host_keys WHERE user_id = ? AND vm_id = ?").get(userId, vmId) as { fingerprint: string } | undefined;
    if (known && known.fingerprint !== fp) return false;
    if (!known) db().prepare("INSERT INTO vm_host_keys (user_id, vm_id, fingerprint, created_at) VALUES (?, ?, ?, ?)").run(userId, vmId, fp, Date.now());
    return true;
  };
  return { verifier, seen: () => seen };
}

/**
 * Runs one command on a VM as root (credentials from Liara) and returns its output, masked for secrets.
 * `onData` streams output as it arrives (the UI shows it live; the model only sees the final, masked text).
 */
export async function execOnVm(userId: string, c: LiaraClient, ref: string, command: string, opts: { timeoutMs?: number; onData?: (chunk: string) => void } = {}): Promise<VmExecResult> {
  const t = await target(c, ref);
  if (!t.password) throw new VmSshError("no-password", `Liara holds no root password for ${t.name} (it was probably created with SSH keys only). Yara cannot log in to it; the user can connect manually from the VM's Console tab.`);
  const pin = pinHostKey(userId, t.id);
  const started = Date.now();
  const timeoutMs = Math.min(opts.timeoutMs ?? 120_000, 900_000);

  return new Promise<VmExecResult>((resolve, reject) => {
    const ssh = new Client();
    let out = "";
    let settled = false;
    const done = (r: VmExecResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ssh.end();
      r instanceof Error ? reject(r) : resolve(r);
    };
    const result = (exitCode: number | null, timedOut: boolean): VmExecResult => ({
      vm: t.name,
      host: t.host,
      exitCode,
      output: maskSecrets(out.length > MAX_OUTPUT ? `…(${out.length - MAX_OUTPUT} chars cut)\n${out.slice(-MAX_OUTPUT)}` : out),
      durationMs: Date.now() - started,
      timedOut,
    });
    const timer = setTimeout(() => done(result(null, true)), timeoutMs);

    ssh
      .on("ready", () => {
        // A login shell so PATH and profile match what the user gets over SSH; non-interactive for apt and friends.
        ssh.exec(`export DEBIAN_FRONTEND=noninteractive; ${command}`, (err, stream) => {
          if (err) return done(new VmSshError("network", `Could not start the command: ${err.message}`));
          const take = (d: Buffer) => {
            const s = d.toString("utf8");
            out += s;
            opts.onData?.(s);
          };
          stream.on("data", take);
          stream.stderr.on("data", take);
          stream.on("close", (code: number | null) => done(result(code ?? null, false)));
        });
      })
      .on("error", (e: Error & { level?: string; code?: string }) => {
        if (/host denied|verification failed/i.test(e.message))
          return done(new VmSshError("host-key", `The VM's host key changed (now ${pin.seen()}). Refused before sending the password. If the VM was rebuilt, the user can trust the new key from the VM Console.`));
        if (/authentication/i.test(e.message)) return done(new VmSshError("auth", `The root password stored in Liara was rejected by ${t.name}; it was probably changed inside the VM. resetVMPassword (needs approval, VM off) sets a new one.`));
        if (e.level === "client-timeout") return done(new VmSshError("timeout", `No SSH answer from ${t.host}:${t.port} within 15s.`));
        const code = e.code ?? "";
        if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(code))
          return done(new VmSshError("network", `Cannot reach SSH on ${t.host}:${t.port} (${code}). Is sshd running and the port open in the VM's firewall?`));
        done(new VmSshError("network", e.message));
      })
      .connect({ host: t.host, port: t.port, username: "root", password: t.password!, readyTimeout: 15_000, hostVerifier: pin.verifier as never });
  });
}
