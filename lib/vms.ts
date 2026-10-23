// Liara virtual machines (IaaS). Endpoints from liara-cloud/openapi spec/Iaas.yaml; the power
// action values and operation polling come from the CLI (src/commands/vm/*), as the spec leaves them open.
import { enc, LiaraError, type LiaraClient } from "./liara";

export type VM = { _id: string; name: string; plan: string; OS: string; state: string; power: string; createdAt: string };
type VMDetails = VM & {
  config?: { sshPort?: string | number; SSHKeys?: string[]; rootPassword?: string; hostname?: string };
  guestState?: string;
  IPs?: { address: string; version: string }[];
  planDetails?: { region?: string; monthlyPrice?: number; hourlyPrice?: number; volume?: number; RAM?: { amount?: number }; CPU?: { amount?: number } };
};
export type VMOperation = { name: string; state: string; createdAt: string };

export const VM_PLANS = ["standard-base-g2", "standard-plus-g2", "pro-g2", "pro-plus-g2", "express-g2", "express-plus-g2"] as const;
export const VM_OSES = ["ubuntu-24.04", "ubuntu-22.04", "debian-12.9"] as const;
export const VM_POWER = ["start", "reboot", "shutdown", "stop"] as const;

/** What the VM API cannot see. Agents quote this instead of guessing. */
export const VM_API_LIMITS =
  "Liara's VM API manages the machine from the outside only: no CPU/RAM usage, no system or app logs, no command execution inside the VM. Only network traffic and the operation history are available. For in-guest diagnosis the user can run the Yara runner on the VM, or connect over SSH themselves.";

export async function listVMs(c: LiaraClient) {
  const { vms } = await c.iaas.get<{ vms: VM[] }>("/vm");
  return (vms ?? []).filter((v) => v.state !== "DELETED");
}

/** Accepts a VM name or id. */
export async function resolveVM(c: LiaraClient, ref: string): Promise<VM> {
  const vms = await listVMs(c);
  const vm = vms.find((v) => v._id === ref || v.name === ref);
  if (!vm) throw new LiaraError(404, `No VM named or with id "${ref}". Existing VMs: ${vms.map((v) => v.name).join(", ") || "none"}.`);
  return vm;
}

/** VM details without credentials: the root password never leaves the server. */
export async function vmDetails(c: LiaraClient, ref: string) {
  const vm = await resolveVM(c, ref);
  const d = await c.iaas.get<VMDetails>(`/vm/${enc(vm._id)}`);
  const p = d.planDetails ?? {};
  return {
    id: d._id,
    name: d.name,
    state: d.state,
    power: d.power,
    guestState: d.guestState,
    os: d.OS,
    plan: d.plan,
    resources: { cpuCores: p.CPU?.amount, ramGB: p.RAM?.amount, diskGB: p.volume, region: p.region },
    price: { monthly: p.monthlyPrice, hourly: p.hourlyPrice },
    ips: (d.IPs ?? []).map((ip) => `${ip.address} (${ip.version})`),
    ssh: { port: d.config?.sshPort, hostname: d.config?.hostname, keys: d.config?.SSHKeys?.filter(Boolean).length ?? 0, rootPasswordSet: !!d.config?.rootPassword },
    createdAt: d.createdAt,
    apiLimits: VM_API_LIMITS,
  };
}

/** Where to SSH: the VM's own public IPv4 and SSH port, straight from Liara (never from the browser). */
export async function vmSshTarget(c: LiaraClient, ref: string) {
  const vm = await resolveVM(c, ref);
  const d = await c.iaas.get<VMDetails>(`/vm/${enc(vm._id)}`);
  const host = (d.IPs ?? []).find((ip) => /4/.test(ip.version) || /^d+.d+.d+.d+$/.test(ip.address))?.address;
  const port = Number(d.config?.sshPort) || 22;
  // Only whether Liara holds a root password; the value itself is read by the SSH proxy at connect time.
  return { id: vm._id, name: vm.name, host: host ?? null, port, on: d.power === "POWERED_ON", liaraPassword: !!d.config?.rootPassword };
}

export async function vmOperations(c: LiaraClient, id: string) {
  const { operations } = await c.iaas.get<{ operations: VMOperation[] }>(`/vm/operation/${enc(id)}`);
  return [...(operations ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Verification step for every VM change: waits for the operation the change started
 * (a new entry in /vm/operation) to finish, the same way `liara vm` does.
 */
const opKey = (o: VMOperation) => `${o.name}|${o.createdAt}`;

/** Snapshot of the operation history, taken before a change so the new operation can be told apart. */
export async function operationKeys(c: LiaraClient, id: string) {
  return new Set((await vmOperations(c, id).catch(() => [])).map(opKey));
}

export async function waitForOperation(c: LiaraClient, id: string, before: Set<string>, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  let latest: VMOperation | undefined;
  while (Date.now() < until) {
    await sleep(2500);
    const ops = await vmOperations(c, id).catch(() => []);
    latest = ops.find((o) => !before.has(opKey(o))) ?? latest;
    if (latest && ["SUCCEEDED", "FAILED"].includes(latest.state)) break;
  }
  const vm = await c.iaas.get<VMDetails>(`/vm/${enc(id)}`).catch(() => null);
  return {
    operation: latest ? { name: latest.name, state: latest.state, at: latest.createdAt } : null,
    verified: latest?.state === "SUCCEEDED",
    finalState: vm ? { state: vm.state, power: vm.power, guestState: vm.guestState } : null,
    note: !latest ? "No matching operation appeared in the VM's history within the time limit; check getVMOperations." : latest.state === "FAILED" ? "Liara reports the operation FAILED." : latest.state === "SUCCEEDED" ? undefined : "Still running when Yara stopped waiting.",
  };
}

type Traffic = { result?: { minute?: number; dstip: string; sumbytes: string }[] };

/**
 * Traffic per destination IP (largest first) and per 5-minute bucket, in MB.
 * Undocumented: both endpoints require startTimeUnix and wrap rows in { result }; long windows (24h) return 400.
 */
export async function vmTraffic(c: LiaraClient, ref: string, hours = 1) {
  const vm = await resolveVM(c, ref);
  const fetchWindow = async (h: number) => {
    const q = { startTimeUnix: Math.floor(Date.now() / 1000) - Math.round(h * 3600) };
    const [v, g] = await Promise.all([c.iaas.get<Traffic>(`/vm/traffic-volume/${enc(vm._id)}`, q), c.iaas.get<Traffic>(`/vm/traffic-graph/${enc(vm._id)}`, q)]);
    return { volume: v?.result ?? [], graph: g?.result ?? [], hours: h };
  };
  let w: Awaited<ReturnType<typeof fetchWindow>> | { error: string };
  try {
    w = await fetchWindow(hours);
  } catch (e) {
    // Liara rejects long windows; fall back to the last hour rather than showing nothing.
    w = hours > 1 ? await fetchWindow(1).catch((e2) => ({ error: String(e2.message ?? e2) })) : { error: String((e as Error).message ?? e) };
  }
  if ("error" in w) return { vm: vm.name, error: w.error, apiLimits: VM_API_LIMITS };
  const { volume, graph } = w;
  const mb = (b: string) => Math.round((Number(b) / 1024 / 1024) * 100) / 100;
  const perMinute = new Map<number, number>();
  for (const g of graph) if (g.minute != null) perMinute.set(g.minute, (perMinute.get(g.minute) ?? 0) + Number(g.sumbytes));
  const series = [...perMinute.entries()].sort((a, b) => a[0] - b[0]).slice(-60);
  return {
    vm: vm.name,
    windowHours: w.hours,
    bucketMinutes: 5,
    byDestination: Array.isArray(volume) ? volume.map((v) => ({ ip: v.dstip, mb: mb(v.sumbytes) })).sort((a, b) => b.mb - a.mb).slice(0, 15) : volume,
    perMinuteMB: series.map(([minute, bytes]) => ({ minute, mb: mb(String(bytes)) })),
    apiLimits: VM_API_LIMITS,
  };
}
