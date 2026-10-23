// Infrastructure-changing actions. The model can only *propose* these: the tools it
// sees have no execute(), the UI asks the user, and /api/actions runs them here.
import { z } from "zod";
import { enc, LiaraError, withKeyVariants, type Env, type LiaraClient, type Project } from "./liara";
import { appPlanOptions } from "./plans";
import { execOnce } from "./server/exec";
import { operationKeys, resolveVM, VM_OSES, VM_PLANS, VM_POWER, waitForOperation } from "./vms";

const PLATFORMS = ["node", "next", "laravel", "php", "python", "django", "flask", "dotnet", "react", "angular", "vue", "static", "docker", "go"] as const;

const app = z.string().min(1).describe("App name (its project_id in Liara)");
const vm = z.string().min(1).describe("VM name or id");

type ActionDef<S extends z.ZodTypeAny> = {
  description: string;
  input: S;
  run: (c: LiaraClient, input: z.infer<S>) => Promise<unknown>;
};
const action = <S extends z.ZodTypeAny>(def: ActionDef<S>) => def;

// g2 plans need a private network, sent as its _id (an omitted one fails with g2_plan_unavailable).
// Same lookup as the CLI's promptNetwork/getNetwork, plus creating one when the account has none.
type Network = { _id: string; name: string };
async function resolveNetwork(c: LiaraClient, name?: string): Promise<Network> {
  const list = async () => (await c.get<{ networks: Network[] }>("/v1/networks")).networks ?? [];
  let networks = await list();
  if (name) {
    const found = networks.find((n) => n.name === name || n._id === name);
    if (!found) throw new Error(`Network "${name}" not found. Available: ${networks.map((n) => n.name).join(", ") || "none"}.`);
    return found;
  }
  if (!networks.length) {
    await c.post("/v1/networks", { networkName: "default" });
    networks = await list();
    if (!networks.length) throw new Error("Could not create a private network, which g2 app plans require.");
  }
  return networks[0];
}

async function currentEnvs(c: LiaraClient, name: string) {
  const { project } = await c.get<{ project: Project }>(`/v1/projects/${enc(name)}`);
  return project.envs ?? [];
}

export const updateEnvs = (c: LiaraClient, project: string, variables: Env[]) =>
  c.post("/v1/projects/update-envs", { project, variables: variables.map(({ key, value, encrypted }) => ({ key, value, encrypted })) });

export const actions = {
  runShellCommand: action({
    description:
      "Run one shell command inside the app's running container (same channel as `liara shell`) and get its output. Use for inspection: ls, cat a config, df -h, ps aux, curl -sI localhost:PORT, node -v. Never print secrets; avoid destructive commands unless the user explicitly asked.",
    input: z.object({ app, command: z.string().min(1).max(500) }),
    run: (c, i) => execOnce(c.creds, i.app, i.command),
  }),
  restartApp: action({
    description: "Restart an app.",
    input: z.object({ app }),
    run: (c, i) => c.post(`/v1/projects/${enc(i.app)}/actions/restart`),
  }),
  setAppPower: action({
    description: "Turn an app on (scale 1) or off (scale 0).",
    input: z.object({ app, on: z.boolean() }),
    run: (c, i) => c.post(`/v1/projects/${enc(i.app)}/actions/scale`, { scale: i.on ? 1 : 0 }),
  }),
  setEnvVars: action({
    description: "Add or overwrite environment variables on an app. Other variables are preserved. Restarts the app.",
    input: z.object({ app, variables: z.array(z.object({ key: z.string().min(1), value: z.string() })).min(1) }),
    run: async (c, i) => {
      const keys = new Set(i.variables.map((v) => v.key));
      const kept = (await currentEnvs(c, i.app)).filter((e) => !keys.has(e.key));
      await updateEnvs(c, i.app, [...kept, ...i.variables]);
      return { updated: [...keys], kept: kept.length };
    },
  }),
  unsetEnvVars: action({
    description: "Remove environment variables from an app. Restarts the app.",
    input: z.object({ app, keys: z.array(z.string().min(1)).min(1) }),
    run: async (c, i) => {
      const envs = await currentEnvs(c, i.app);
      const remaining = envs.filter((e) => !i.keys.includes(e.key));
      await updateEnvs(c, i.app, remaining);
      return { removed: envs.length - remaining.length };
    },
  }),
  changeAppPlan: action({
    description: "Change an app's resource plan. Use getAccountOverview to find valid plan IDs.",
    input: z.object({ app, planID: z.string().min(1) }),
    run: (c, i) => c.post(`/v1/projects/${enc(i.app)}/resize`, { planID: i.planID }),
  }),
  createApp: action({
    description:
      "Create a new app on Liara (needed before the first deploy). Call recommendAppPlan first and use its planID and bundlePlanID. Names are lowercase letters, digits and dashes, and globally unique across Liara.",
    input: z.object({
      name: z.string().regex(/^[a-z0-9-]{3,32}$/, "3-32 chars: a-z, 0-9, -"),
      platform: z.enum(PLATFORMS),
      planID: z.string().min(1),
      bundlePlanID: z.string().optional().describe("Feature bundle (basic/standard/pro) from recommendAppPlan; defaults to the cheapest available"),
      network: z.string().optional().describe("Private network name; defaults to the account's first network (one is created if there is none)"),
    }),
    run: async (c, i) => {
      const bundlePlanID = i.bundlePlanID ?? (await appPlanOptions(c)).bundles(i.planID)[0]?.id;
      const network = await resolveNetwork(c, i.network);
      try {
        await c.post("/v1/projects/", { name: i.name, platform: i.platform, planID: i.planID, bundlePlanID, network: network._id, readOnlyRootFilesystem: false });
      } catch (e) {
        // Same cases the CLI distinguishes (src/commands/app/create.ts).
        if (e instanceof LiaraError && e.status === 409) throw new Error(`The name "${i.name}" is already taken on Liara (names are global). Propose another name, e.g. "${i.name}-${Math.random().toString(36).slice(2, 6)}".`);
        if (e instanceof LiaraError && e.status === 402) throw new Error("Not enough balance on the Liara account to create this app. The user must top up in the Liara console (payments are not available via API).");
        if (e instanceof LiaraError && e.status === 403) throw new Error(`Liara refused: ${e.message}. The free plan allows one app and not every platform; pick a paid plan.`);
        throw e;
      }
      return { created: i.name, platform: i.platform, planID: i.planID, bundlePlanID, network: network.name, next: "Now deploy to it with deployWorkspace (same app name)." };
    },
  }),
  deleteApp: action({
    description: "Permanently delete an app. Destructive and irreversible.",
    input: z.object({ app }),
    run: (c, i) => c.delete(`/v1/projects/${enc(i.app)}`),
  }),
  setAppFeature: action({
    description: "Enable or disable an app feature: zero-downtime deploys, the default *.liara.run subdomain, a fixed outbound IP, or a read-only root filesystem.",
    input: z.object({ app, feature: z.enum(["zero-downtime", "default-subdomain", "fixed-ip", "read-only"]), enabled: z.boolean() }),
    run: (c, i) => c.post(`/v1/projects/${enc(i.app)}/${i.feature}/${i.enabled ? "enable" : "disable"}`),
  }),
  deployRelease: action({
    description: "Build and release source code that the user uploaded through the UI (you receive its sourceID in the conversation).",
    input: z.object({ app, sourceID: z.string().min(1), port: z.number().int().min(1).max(65535), platform: z.enum(PLATFORMS) }),
    run: (c, i) => c.post(`/v2/projects/${enc(i.app)}/releases`, { sourceID: i.sourceID, port: i.port, type: i.platform }),
  }),
  addDomain: action({
    description: "Connect a custom domain to an app.",
    input: z.object({ app, domain: z.string().min(3) }),
    run: (c, i) => c.post("/v1/domains", { name: i.domain, project: i.app, type: "PROJECT" }),
  }),
  enableDomainSsl: action({
    description: "Provision a free SSL certificate for a domain already connected to an app.",
    input: z.object({ domain: z.string().min(3) }),
    run: (c, i) => c.post("/v1/domains/provision-ssl-certs", { domain: i.domain }),
  }),
  createDisk: action({
    description: "Create a persistent disk on an app (size in GB).",
    input: z.object({ app, name: z.string().regex(/^[a-z0-9-]+$/), size: z.number().positive() }),
    run: (c, i) => c.post(`/v1/projects/${enc(i.app)}/disks`, { name: i.name, size: i.size }),
  }),
  createDiskBackup: action({
    description: "Back up an app disk.",
    input: z.object({ app, disk: z.string().min(1) }),
    run: (c, i) => c.post(`/v1/projects/${enc(i.app)}/disks/${enc(i.disk)}/backups`),
  }),
  createDatabase: action({
    description: "Create a managed database. type is e.g. postgres, mysql, mariadb, mongodb, redis, mssql, elasticsearch, rabbitmq. Use getAccountOverview for plan IDs and versions.",
    input: z.object({
      hostname: z.string().regex(/^[a-z0-9-]{3,32}$/),
      type: z.string().min(1),
      planID: z.string().min(1),
      version: z.string().optional(),
      publicNetwork: z.boolean().default(false),
    }),
    run: (c, i) => c.post("/v1/databases", i),
  }),
  createDatabaseBackup: action({
    description: "Back up a managed database.",
    input: z.object({ databaseId: z.string().min(1) }),
    run: (c, i) => c.post(`/v1/databases/${enc(i.databaseId)}/backups`),
  }),
  setDatabasePower: action({
    description: "Turn a managed database on or off.",
    input: z.object({ databaseId: z.string().min(1), on: z.boolean() }),
    run: (c, i) => c.post(`/v1/databases/${enc(i.databaseId)}/actions/scale`, { scale: i.on ? 1 : 0 }),
  }),
  createDnsZone: action({
    description: "Host a domain's DNS on Liara DNS (creates the zone). The zone stays PENDING until the user switches the domain's nameservers at the registrar; domainGuide shows them.",
    input: z.object({ zone: z.string().min(3).describe("the registrable domain, e.g. example.ir") }),
    run: (c, i) => c.dns.post("/api/v1/zones", { name: i.zone }),
  }),
  createDnsRecord: action({
    description:
      'Create a DNS record in a Liara DNS zone. contents shapes: A/AAAA [{"ip":"1.2.3.4"}], CNAME/ALIAS [{"host":"x.liara.run"}], TXT/SPF [{"text":"..."}], MX [{"exchange":"mx.example.com","priority":10}].',
    input: z.object({
      zone: z.string().min(3),
      name: z.string().min(1).describe('"@" for the root, "*" for wildcard'),
      type: z.enum(["A", "AAAA", "TXT", "CNAME", "ALIAS", "MX", "SRV", "SPF", "PTR"]),
      ttl: z.number().int().optional(),
      contents: z.array(z.record(z.union([z.string(), z.number()]))).min(1),
    }),
    run: (c, { zone, ...record }) => c.dns.post(`/api/v1/zones/${enc(zone)}/dns-records`, record),
  }),
  deleteDnsRecord: action({
    description: "Delete a DNS record from a Liara DNS zone.",
    input: z.object({ zone: z.string().min(3), recordId: z.string().min(1) }),
    run: (c, i) => c.dns.delete(`/api/v1/zones/${enc(i.zone)}/dns-records/${enc(i.recordId)}`),
  }),
  createBucket: action({
    description: "Create an object storage bucket. Names: 3-63 chars, lowercase letters, digits, dashes. Ask for the plan if unknown.",
    input: z.object({
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
      plan: z.string().min(1),
      permission: z.enum(["private", "public"]).default("private"),
    }),
    run: (c, i) => c.storage.post("/api/v1/buckets", i),
  }),
  setBucketPermission: action({
    description: "Make a bucket public (anyone with the URL can read objects) or private.",
    input: z.object({ bucket: z.string().min(1), permission: z.enum(["private", "public"]) }),
    run: (c, i) => c.storage.patch(`/api/v1/buckets/${enc(i.bucket)}/type/${i.permission}`),
  }),
  createBucketFolder: action({
    description: "Create a folder (prefix) in a bucket.",
    input: z.object({ bucket: z.string().min(1), path: z.string().min(1) }),
    run: (c, i) => c.storage.post(`/api/v1/buckets/${enc(i.bucket)}/folders`, { path: i.path }),
  }),
  deleteObject: action({
    description: "Permanently delete one object from a bucket.",
    input: z.object({ bucket: z.string().min(1), object: z.string().min(1) }),
    run: (c, i) => withKeyVariants(i.object, (seg) => c.storage.delete(`/api/v1/buckets/${enc(i.bucket)}/objects/${seg}`)),
  }),
  deleteBucket: action({
    description: "Permanently delete a bucket and everything in it. Destructive and irreversible.",
    input: z.object({ bucket: z.string().min(1) }),
    run: (c, i) => c.storage.delete(`/api/v1/buckets/${enc(i.bucket)}`),
  }),

  // ---- virtual machines: every change waits for its operation and reports the verified final state ----
  setVMPower: action({
    description:
      "Power a VM: start, reboot, shutdown (graceful, asks the OS) or stop (forced, like pulling the plug; only when shutdown hangs). Waits for Liara to finish the operation and returns the verified final state.",
    input: z.object({ vm, action: z.enum(VM_POWER) }),
    run: (c, i) => vmChange(c, i.vm, (id) => c.iaas.patch(`/vm/power/${enc(id)}`, { action: i.action })),
  }),
  resizeVM: action({
    description: "Change a VM's plan (CPU/RAM/disk). Use listVMPlans first. The VM may need to restart.",
    input: z.object({ vm, plan: z.enum(VM_PLANS) }),
    run: (c, i) => vmChange(c, i.vm, (id) => c.iaas.patch(`/vm/resize/${enc(id)}`, { plan: i.plan })),
  }),
  createVMDisk: action({
    description: "Attach a new disk to a VM (size in GB). getVMDisks shows the space available.",
    input: z.object({ vm, size: z.number().int().positive() }),
    run: (c, i) => vmChange(c, i.vm, (id) => c.iaas.post(`/vm/disk/${enc(id)}`, { size: i.size })),
  }),
  extendVMDisk: action({
    description: "Grow an existing VM disk to newSize GB (cannot shrink). The filesystem inside the VM must be grown separately.",
    input: z.object({ vm, diskId: z.string().min(1), newSize: z.number().int().positive() }),
    run: (c, i) => vmChange(c, i.vm, (id) => c.iaas.post(`/vm/disk/${enc(id)}/${enc(i.diskId)}`, { newSize: i.newSize })),
  }),
  deleteVMDisk: action({
    description: "Permanently delete a disk from a VM and all data on it.",
    input: z.object({ vm, diskId: z.string().min(1) }),
    run: (c, i) => vmChange(c, i.vm, (id) => c.iaas.delete(`/vm/disk/${enc(id)}/${enc(i.diskId)}`)),
  }),
  resetVMNetwork: action({
    description: "Reset a VM's network configuration (fixes a VM that lost connectivity after network changes). The VM must be powered off first.",
    input: z.object({ vm }),
    run: async (c, i) => ({ ...(await vmChange(c, i.vm, (id) => c.iaas.post(`/vm/reset-network/${enc(id)}`))), next: "The VM is still powered off. Tell the user, and propose setVMPower start so they can use it again; don't tell them to log in before it is on." }),
  }),
  resetVMPassword: action({
    description: "Generate a new root password for a VM (the VM must be powered off). The password is shown only to the user, never to you.",
    input: z.object({ vm }),
    run: async (c, i) => {
      const v = await resolveVM(c, i.vm);
      const r = await c.iaas.post<{ password?: string }>(`/vm/reset-password/${enc(v._id)}`);
      return { vm: v.name, reset: true, secret: r?.password ? { label: `رمز تازه‌ی root برای ${v.name}`, value: r.password } : undefined, next: "The VM is still powered off. Tell the user, and propose setVMPower start so they can use it again; don't tell them to log in before it is on." };
    },
  }),
  unfreezeVM: action({
    description: "Unfreeze a VM that Liara froze for low balance (needs enough account balance).",
    input: z.object({ vm }),
    run: (c, i) => vmChange(c, i.vm, (id) => c.iaas.post(`/vm/unfreeze/${enc(id)}`)),
  }),
  createVM: action({
    description: "Create a new VM. Use listVMPlans for plans and OS versions. Costs money from the moment it exists.",
    input: z.object({
      name: z.string().regex(/^[a-z0-9-]{3,32}$/, "3-32 chars: a-z, 0-9, -"),
      os: z.string().regex(/^[a-z]+-[\w.-]+$/).describe(`"<name>-<version>" from listVMPlans' operatingSystems, e.g. ${VM_OSES.join(", ")}`),
      plan: z.enum(VM_PLANS),
      sshPort: z.string().regex(/^\d{2,5}$/).optional(),
      sshKeys: z.array(z.string().min(20)).max(10).optional().describe("Public SSH keys to install"),
    }),
    run: (c, i) => c.iaas.post("/vm", { name: i.name, OS: i.os, plan: i.plan, config: { sshPort: i.sshPort, SSHKeys: i.sshKeys ?? [] } }),
  }),
  deleteVM: action({
    description: "Permanently delete a VM with all its disks and data. Destructive and irreversible.",
    input: z.object({ vm }),
    run: async (c, i) => {
      const v = await resolveVM(c, i.vm);
      return { vm: v.name, ...(await c.iaas.delete<object>(`/vm/${enc(v._id)}`)) };
    },
  }),
};

/** Runs one VM change and verifies it: snapshot operations, act, wait for the new operation to finish. */
async function vmChange(c: LiaraClient, ref: string, act: (id: string) => Promise<unknown>) {
  const v = await resolveVM(c, ref);
  const before = await operationKeys(c, v._id);
  const response = await act(v._id);
  return { vm: v.name, response: response ?? null, verification: await waitForOperation(c, v._id, before) };
}

export type ActionName = keyof typeof actions;

/** Erased view of the action map, for code that iterates over every action. */
export const actionList = Object.entries(actions) as unknown as [ActionName, { description: string; input: z.ZodTypeAny }][];

export async function runAction(c: LiaraClient, name: string, rawInput: unknown) {
  const def = actions[name as ActionName] as unknown as ActionDef<z.ZodTypeAny> | undefined;
  if (!def) throw new Error(`Unknown action: ${name}`);
  const input = def.input.parse(rawInput);
  const result = await def.run(c, input);
  return result ?? { ok: true };
}
