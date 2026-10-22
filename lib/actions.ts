// Infrastructure-changing actions. The model can only *propose* these: the tools it
// sees have no execute(), the UI asks the user, and /api/actions runs them here.
import { z } from "zod";
import { enc, withKeyVariants, type Env, type LiaraClient, type Project } from "./liara";
import { execOnce } from "./server/exec";

const PLATFORMS = ["node", "next", "laravel", "php", "python", "django", "flask", "dotnet", "react", "angular", "vue", "static", "docker", "go"] as const;

const app = z.string().min(1).describe("App name (its project_id in Liara)");

type ActionDef<S extends z.ZodTypeAny> = {
  description: string;
  input: S;
  run: (c: LiaraClient, input: z.infer<S>) => Promise<unknown>;
};
const action = <S extends z.ZodTypeAny>(def: ActionDef<S>) => def;

async function currentEnvs(c: LiaraClient, name: string) {
  const { project } = await c.get<{ project: Project }>(`/v1/projects/${enc(name)}`);
  return project.envs ?? [];
}

const updateEnvs = (c: LiaraClient, project: string, variables: Env[]) =>
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
    description: "Create a new app. Names are lowercase letters, digits and dashes, globally unique. Use getAccountOverview for plan IDs.",
    input: z.object({
      name: z.string().regex(/^[a-z0-9-]{3,32}$/, "3-32 chars: a-z, 0-9, -"),
      platform: z.enum(PLATFORMS),
      planID: z.string().min(1),
      network: z.string().optional().describe("Private network name, if any"),
    }),
    run: (c, i) => c.post("/v1/projects", { name: i.name, platform: i.platform, planID: i.planID, network: i.network }),
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
};

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
