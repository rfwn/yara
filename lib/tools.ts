import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { actionList } from "./actions";
import { readDocsPage, searchDocs } from "./docs";
import { listVMs, resolveVM, vmDetails, vmOperations, vmTraffic, VM_API_LIMITS } from "./vms";
import { diagnose } from "./monitor/diagnose";
import { gatherEvidence } from "./monitor/evidence";
import { enc, LiaraError, maskEnvs, withKeyVariants, nowSec, summarizeSeries, type LiaraClient, type LogLine, type Project, type Reports } from "./liara";

const app = z.string().min(1).describe("App name (project_id)");
const ERROR_LINE = /error|exception|traceback|fatal|panic|killed|oom|refused|timeout|ECONN|EADDRINUSE|cannot find module|segfault|502|503/i;

/** Best-effort: never let one failing sub-request sink a composite tool. */
async function settle<T>(p: Promise<T>): Promise<T | { error: string }> {
  try {
    return await p;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function compactPlans(plans: unknown) {
  if (!plans || typeof plans !== "object") return plans;
  const out: Record<string, unknown> = {};
  for (const [group, entries] of Object.entries(plans as Record<string, unknown>)) {
    if (!entries || typeof entries !== "object") continue;
    out[group] = Object.entries(entries as Record<string, unknown>)
      .filter(([, p]) => p && typeof p === "object" && (p as { available?: boolean }).available !== false)
      .map(([id, p]) => {
        const flat: Record<string, unknown> = { id };
        for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
          if (["string", "number", "boolean"].includes(typeof v)) flat[k] = v;
          else if (v && typeof v === "object" && !Array.isArray(v)) {
            for (const [k2, v2] of Object.entries(v)) if (typeof v2 === "number" || typeof v2 === "string") flat[`${k}.${k2}`] = v2;
          }
        }
        return flat;
      })
      .slice(0, 40);
  }
  return out;
}

async function fetchLogs(c: LiaraClient, name: string, minutes: number, limit: number, errorsOnly = false) {
  const lines = await c.get<LogLine[]>(`/v1/projects/${enc(name)}/logs`, { since: nowSec() - minutes * 60 });
  const all = Array.isArray(lines) ? lines : [];
  const errors = all.filter((l) => l.type === "stderr" || ERROR_LINE.test(l.message));
  const picked = (errorsOnly ? errors : all).slice(-limit).map((l) => ({
    t: l.datetime,
    stream: l.type,
    msg: l.message.length > 600 ? `${l.message.slice(0, 600)}…` : l.message,
  }));
  return { windowMinutes: minutes, totalLines: all.length, errorLikeLines: errors.length, lines: picked };
}

async function fetchMetric(c: LiaraClient, base: string, metric: string, hours: number) {
  const r = await c.get<Reports>(`${base}/metrics/${metric}`, { since: nowSec() - hours * 3600 });
  return { metric, windowHours: hours, series: summarizeSeries(r) };
}

export function readTools(c: LiaraClient) {
  return {
    getAccountOverview: tool({
      description:
        "Who the user is, team context, and available plan IDs for apps and databases (with their resources/prices) plus database versions. Call before creating apps/databases or changing plans.",
      inputSchema: z.object({}),
      execute: async () => {
        const me = await c.get<Record<string, any>>("/v1/me");
        return {
          user: me.user ? { name: me.user.fullname, email: me.user.email, accountType: me.user.accountType } : undefined,
          team: me.team ? { id: me.team._id, name: me.team.name } : undefined,
          plans: compactPlans(me.plans),
          databaseVersions: me.databaseVersions,
        };
      },
    }),

    listApps: tool({
      description: "List every app with platform, status, power state (scale) and plan.",
      inputSchema: z.object({}),
      execute: async () => {
        const { projects } = await c.get<{ projects: Project[] }>("/v1/projects");
        return projects.map((p) => ({
          name: p.project_id,
          platform: p.type,
          status: p.status,
          on: p.scale > 0,
          plan: p.planID,
          deployed: p.isDeployed,
          created: p.created_at,
        }));
      },
    }),

    getApp: tool({
      description: "Full configuration of one app: plan, features, node IP, price and environment variables (secret-looking values are masked).",
      inputSchema: z.object({ app }),
      execute: async ({ app }) => {
        const { project: p } = await c.get<{ project: Project & Record<string, any> }>(`/v1/projects/${enc(app)}`);
        return {
          name: p.project_id,
          id: p._id,
          platform: p.type,
          status: p.status,
          on: p.scale > 0,
          plan: p.planID,
          deployed: p.isDeployed,
          zeroDowntime: p.zeroDowntime,
          defaultSubdomain: p.defaultSubdomain ? `https://${p.project_id}.liara.run` : false,
          readOnlyRootFilesystem: p.readOnlyRootFilesystem,
          fixedIP: p.fixedIPStatus,
          hourlyPrice: p.hourlyPrice,
          env: maskEnvs(p.envs),
        };
      },
    }),

    getAppLogs: tool({
      description: "Recent runtime logs of an app (stdout/stderr). Use errorsOnly to cut noise when debugging.",
      inputSchema: z.object({
        app,
        minutes: z.number().int().min(1).max(1440).default(30).describe("How far back to look"),
        limit: z.number().int().min(10).max(400).default(150),
        errorsOnly: z.boolean().default(false),
      }),
      execute: ({ app, minutes, limit, errorsOnly }) => fetchLogs(c, app, minutes, limit, errorsOnly),
    }),

    getAppEvents: tool({
      description: "Platform events for an app: deploys, restarts, crashes, OOM kills, scaling, plan changes.",
      inputSchema: z.object({ app, hours: z.number().min(1).max(720).default(24), search: z.string().optional() }),
      execute: async ({ app, hours, search }) => {
        const data = await c.get<any>(`/v1/projects/${enc(app)}/events`, { start: nowSec() - hours * 3600, end: nowSec(), search });
        const events = Array.isArray(data) ? data : (data?.events ?? data);
        return Array.isArray(events) ? events.slice(0, 50) : events;
      },
    }),

    getAppReleases: tool({
      description: "Deploy history of an app: state of each release (READY/FAILED/BUILDING…), git info, port, timestamps.",
      inputSchema: z.object({ app, count: z.number().int().min(1).max(30).default(8) }),
      execute: async ({ app, count }) => {
        const r = await c.get<any>(`/v1/projects/${enc(app)}/releases`, { page: 1, count });
        return {
          currentRelease: r.currentRelease,
          total: r.total,
          releases: (r.releases ?? []).map((x: any) => ({
            id: x._id,
            state: x.state,
            createdAt: x.createdAt,
            finishedAt: x.finishedAt,
            port: x.port,
            client: x.client,
            tag: x.tag,
            commit: x.gitInfo?.commit?.slice(0, 8) || undefined,
            message: x.gitInfo?.message || undefined,
            branch: x.gitInfo?.branch || undefined,
          })),
        };
      },
    }),

    getAppMetrics: tool({
      description: "CPU / memory / network usage of an app over time (min/avg/max/last per instance). CPU is in cores, memory in bytes.",
      inputSchema: z.object({
        app,
        metrics: z.array(z.enum(["cpu", "memory", "network-receive", "network-transmit"])).default(["cpu", "memory"]),
        hours: z.number().min(1).max(168).default(6),
      }),
      execute: async ({ app, metrics, hours }) => {
        const base = `/v1/projects/${enc(app)}`;
        const [summary, ...series] = await Promise.all([settle(c.get(`${base}/metrics/summary`)), ...metrics.map((m) => settle(fetchMetric(c, base, m, hours)))]);
        return { summary, series };
      },
    }),

    diagnoseApp: tool({
      description:
        "One-shot health check of an app: probes its public URL (HTTP status + latency), reads CPU/RAM against the plan's limits, error-like log lines, the latest release and platform events, then returns a health status and the likely causes RANKED by confidence, each with its evidence and fix. Start here when the user reports something broken or slow.",
      inputSchema: z.object({ app, path: z.string().optional().describe("Health path to probe, e.g. /health (default /)") }),
      execute: async ({ app, path }) => {
        const base = `/v1/projects/${enc(app)}`;
        const [ev, envKeys, recentErrors] = await Promise.all([
          gatherEvidence(c, app, { path, logMinutes: 30 }),
          settle(c.get<{ project: Project }>(base).then(({ project: p }) => (p.envs ?? []).map((e) => e.key))),
          settle(fetchLogs(c, app, 60, 40, true)),
        ]);
        const health = diagnose(ev);
        const pctOf = (v: number | undefined, max: number | null) => (v !== undefined && max ? Math.round((v / max) * 100) : null);
        return {
          app,
          health,
          probe: ev.probe ?? (ev.url ? null : "No public URL (default subdomain off and no domain): HTTP health cannot be probed."),
          resources: {
            plan: ev.plan,
            cpu: ev.cpu && { ...ev.cpu, unit: "cores", limit: ev.cpuLimit, avgPctOfPlan: pctOf(ev.cpu.avg, ev.cpuLimit), maxPctOfPlan: pctOf(ev.cpu.max, ev.cpuLimit) },
            memory: ev.memory && { last: ev.memory.last, max: ev.memory.max, unit: "bytes", limit: ev.memLimit, lastPctOfPlan: pctOf(ev.memory.last, ev.memLimit), maxPctOfPlan: pctOf(ev.memory.max, ev.memLimit) },
          },
          status: ev.status,
          on: ev.on,
          latestRelease: ev.release,
          recentErrors,
          events: ev.events,
          envKeys,
          dataGaps: ev.gaps,
          next: "Explain the top cause in plain words with its evidence, propose the fix, and after any fix verify it (probeApp or diagnoseApp again). Do not claim it is fixed without that check.",
        };
      },
    }),

    listDomains: tool({
      description: "Custom domains (optionally for one app) with connection status, SSL status and the CNAME target to set in DNS.",
      inputSchema: z.object({ app: z.string().optional() }),
      execute: async ({ app }) => {
        const { domains } = await c.get<{ domains: any[] }>("/v1/domains", { project: app });
        return domains.map((d) => ({
          id: d._id,
          name: d.name,
          app: d.project?.project_id,
          status: d.status,
          ssl: d.certificatesStatus,
          cname: d.CNameRecord,
          redirectTo: d.redirectTo || undefined,
        }));
      },
    }),

    checkDomain: tool({
      description: "Ask Liara to re-check whether a domain's DNS points at the app (use the domain id from listDomains).",
      inputSchema: z.object({ domainId: z.string() }),
      execute: ({ domainId }) => c.get(`/v1/domains/${enc(domainId)}/check`),
    }),

    listDisks: tool({
      description: "Persistent disks attached to an app, with size and usage.",
      inputSchema: z.object({ app }),
      execute: ({ app }) => c.get(`/v1/projects/${enc(app)}/disks`),
    }),

    listDatabases: tool({
      description: "All managed databases with type, version, status, plan and hostname.",
      inputSchema: z.object({}),
      execute: async () => {
        const data = await c.get<any>("/v1/databases");
        return (data.databases ?? data ?? []).map((d: any) => ({
          id: d._id,
          hostname: d.hostname,
          type: d.type,
          version: d.version,
          status: d.status,
          on: d.scale === undefined ? undefined : d.scale > 0,
          plan: d.planID,
          publicNetwork: d.publicNetwork,
        }));
      },
    }),

    getDatabase: tool({
      description: "Details of one managed database, its recent backups and CPU/memory usage. Credentials are never returned.",
      inputSchema: z.object({ databaseId: z.string() }),
      execute: async ({ databaseId }) => {
        const base = `/v1/databases/${enc(databaseId)}`;
        const [db, backups, cpu, memory] = await Promise.all([
          settle(c.get<any>(base).then((d) => {
            const x = d.database ?? d;
            // Strip anything that could be a credential.
            const { password, rootPassword, root_password, ...safe } = x ?? {};
            void password, rootPassword, root_password;
            return safe;
          })),
          settle(c.get<any>(`${base}/backups`).then((b) => (Array.isArray(b) ? b : (b?.backups ?? b)))),
          settle(fetchMetric(c, base, "cpu", 6)),
          settle(fetchMetric(c, base, "memory", 6)),
        ]);
        return { db, backups, cpu, memory };
      },
    }),

    listDnsZones: tool({
      description: "DNS zones managed by Liara DNS.",
      inputSchema: z.object({}),
      execute: () => c.dns.get("/api/v1/zones"),
    }),

    listDnsRecords: tool({
      description: "DNS records in a Liara DNS zone.",
      inputSchema: z.object({ zone: z.string() }),
      execute: ({ zone }) => c.dns.get(`/api/v1/zones/${enc(zone)}/dns-records`),
    }),

    listBuckets: tool({
      description: "Object storage (S3-compatible) buckets with plan, status and public/private permission.",
      inputSchema: z.object({}),
      execute: async () => {
        const { buckets } = await c.storage.get<{ buckets: any[] }>("/api/v1/buckets");
        return (buckets ?? []).map((b) => ({ name: b.name, plan: b.plan, status: b.status, permission: b.permission, created: b.createdAt }));
      },
    }),

    getBucket: tool({
      description: "Details and usage (object count, total size) of one bucket.",
      inputSchema: z.object({ bucket: z.string() }),
      execute: async ({ bucket }) => {
        const base = `/api/v1/buckets/${enc(bucket)}`;
        const [details, usage] = await Promise.all([
          settle(c.storage.get<any>(base).then((r) => r.bucket ?? r)),
          // Metrics come as [unixTimestamp, "value"] pairs; keep only the values.
          settle(
            c.storage.get<any>(`${base}/metrics/summary`).then((r) => {
              const m = r.data?.metrics ?? {};
              const val = (pair: unknown) => (Array.isArray(pair) ? Number(pair[1]) : undefined);
              const bytes = val(m.total_bytes);
              return {
                objectCount: val(m.totol_objects ?? m.total_objects),
                totalBytes: bytes,
                totalMB: bytes === undefined ? undefined : Math.round((bytes / 1024 / 1024) * 10) / 10,
              };
            }),
          ),
        ]);
        return { details, usage };
      },
    }),

    listBucketObjects: tool({
      description:
        "List objects and folders in a bucket under a prefix (folder). Use prefix '' for the root and e.g. 'images/' for a folder. Max 50 per call; if truncated, call again with the returned nextPage.",
      inputSchema: z.object({
        bucket: z.string(),
        prefix: z.string().default(""),
        page: z.string().optional().describe("nextPage value from a previous call; omit for the first page"),
      }),
      execute: async ({ bucket, prefix, page }) => {
        // `page` looks like an S3 continuation token rather than a page number, so it's only
        // sent when the API handed us one. `number` is dropped as a last resort.
        const r = await withKeyVariants(prefix, async (seg) => {
          const path = `/api/v1/buckets/${enc(bucket)}/objects/${seg}`;
          try {
            return await c.storage.get<any>(path, { number: 50, page });
          } catch (e) {
            if (e instanceof LiaraError && e.status === 500) return c.storage.get<any>(path, { page });
            throw e;
          }
        });
        const o = r.data?.objects ?? r;
        return {
          prefix: o.Prefix ?? prefix,
          truncated: o.IsTruncated,
          nextPage: o.NextContinuationToken ?? r.data?.nextPage ?? undefined,
          folders: (o.CommonPrefixes ?? []).map((p: any) => p.Prefix),
          objects: (o.Contents ?? []).map((x: any) => ({ key: x.Key, size: x.Size, modified: x.LastModified })),
        };
      },
    }),

    getObjectInfo: tool({
      description: "Size, content type and last-modified time of a single object.",
      inputSchema: z.object({ bucket: z.string(), object: z.string().describe("Object key, e.g. images/logo.png") }),
      execute: async ({ bucket, object }) => {
        const r = await withKeyVariants(object, (seg) => c.storage.get<any>(`/api/v1/buckets/${enc(bucket)}/objects/statistics/${seg}`));
        return r.data?.object ?? r;
      },
    }),

    getObjectDownloadLink: tool({
      description: "Create a temporary presigned download URL for an object (works for private buckets).",
      inputSchema: z.object({
        bucket: z.string(),
        object: z.string(),
        expiry: z.string().default("1 hours").describe("e.g. '30 minutes', '2 days 7 hours'"),
      }),
      execute: async ({ bucket, object, expiry }) => {
        const r = await withKeyVariants(object, (seg) => c.storage.get<any>(`/api/v1/buckets/${enc(bucket)}/download/${seg}`, { expiry }));
        return { url: r.data?.url ?? r.url ?? r, expiry };
      },
    }),

    listVMs: tool({
      description: "Virtual machines (Liara IaaS) with state, power, OS and plan.",
      inputSchema: z.object({}),
      execute: async () => (await listVMs(c)).map((v) => ({ id: v._id, name: v.name, state: v.state, power: v.power, os: v.OS, plan: v.plan, created: v.createdAt })),
    }),

    getVM: tool({
      description: `One VM: power and guest state, OS, plan with CPU/RAM/disk size and price, IPs, SSH port. Credentials are never returned. ${VM_API_LIMITS}`,
      inputSchema: z.object({ vm: z.string().describe("VM name or id") }),
      execute: ({ vm }) => vmDetails(c, vm),
    }),

    getVMOperations: tool({
      description: "Recent operations on a VM (power changes, resizes, disk changes) with their state: use it to see what happened to a VM and whether a change succeeded.",
      inputSchema: z.object({ vm: z.string().describe("VM name or id") }),
      execute: async ({ vm }) => {
        const v = await resolveVM(c, vm);
        return { vm: v.name, operations: (await vmOperations(c, v._id)).slice(0, 20) };
      },
    }),

    getVMDisks: tool({
      description: "Disks attached to a VM and the space still available to add.",
      inputSchema: z.object({ vm: z.string().describe("VM name or id") }),
      execute: async ({ vm }) => {
        const v = await resolveVM(c, vm);
        return c.iaas.get(`/vm/disk/${enc(v._id)}`);
      },
    }),

    getVMTraffic: tool({
      description: "Network traffic of a VM: total MB per destination IP and MB per 5-minute bucket. The only usage signal the VM API offers. Liara only serves short windows (a few hours).",
      inputSchema: z.object({ vm: z.string().describe("VM name or id"), hours: z.number().min(0.25).max(12).default(1) }),
      execute: ({ vm, hours }) => vmTraffic(c, vm, hours),
    }),

    listVMPlans: tool({
      description: "VM plans with CPU, RAM, disk, region and price, plus the available operating systems.",
      inputSchema: z.object({}),
      execute: async () => {
        const [plans, oss] = await Promise.all([settle(c.iaas.get<{ plans: unknown }>("/plans").then((r) => compactPlans({ vm: r.plans }))), settle(c.iaas.get("/oss"))]);
        return { plans, operatingSystems: oss };
      },
    }),

    searchLiaraDocs: tool({
      description:
        "Find relevant pages on docs.liara.ir by English keywords that appear in URLs (e.g. 'django worker-timeout', 'nextjs deploy', 'laravel cors', 'cicd github', 'disks backup', 'health-check'). Returns URLs; read them with readLiaraDocsPage.",
      inputSchema: z.object({ query: z.string().min(2) }),
      execute: async ({ query }) => ({ results: await searchDocs(query) }),
    }),

    readLiaraDocsPage: tool({
      description: "Read a docs.liara.ir page as text (the docs are in Persian). Use it to ground config snippets and fixes in the official docs.",
      inputSchema: z.object({ url: z.string().describe("Full URL or path, e.g. /paas/django/fix-common-errors/worker-timeout/") }),
      execute: ({ url }) => readDocsPage(url),
    }),
  } satisfies ToolSet;
}

/** Action tools are declared without execute(), so the stream pauses for the user's approval. */
export function actionTools() {
  return Object.fromEntries(
    actionList.map(([name, def]) => [
      name,
      tool({
        description: `${def.description} REQUIRES USER APPROVAL: the UI shows an approve/deny card when you call this, so don't ask for confirmation in text first.`,
        inputSchema: def.input,
      }),
    ]),
  ) as ToolSet;
}

export function buildTools(c: LiaraClient): ToolSet {
  return { ...readTools(c), ...actionTools() };
}
