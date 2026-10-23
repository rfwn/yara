import "server-only";
import { listVMs, resolveVM, vmDetails, vmOperations, vmTraffic } from "../vms";
import { appPlanOptions } from "../plans";
import { enc, getAppLogs, maskEnvs, latestInstance, nowSec, summarizeSeries, withKeyVariants, type LiaraClient, type LogLine, type Project, type Reports } from "../liara";

const settle = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

const latest = (r: Reports | null) => {
  const s = r ? summarizeSeries(latestInstance(r))[0] : undefined;
  return s && "last" in s ? { last: s.last, max: s.max, samples: s.samples } : null;
};

/** Every app with live CPU/memory and its latest release, for the Overview table. */
export async function overview(c: LiaraClient) {
  const { projects } = await c.get<{ projects: Project[] }>("/v1/projects");
  const since = nowSec() - 3 * 3600;
  const rows = await Promise.all(
    projects.map(async (p) => {
      const base = `/v1/projects/${enc(p.project_id)}`;
      const [cpu, mem, rel] = await Promise.all([
        p.scale > 0 ? settle(c.get<Reports>(`${base}/metrics/cpu`, { since })) : null,
        p.scale > 0 ? settle(c.get<Reports>(`${base}/metrics/memory`, { since })) : null,
        settle(c.get<any>(`${base}/releases`, { page: 1, count: 1 })),
      ]);
      const r = rel?.releases?.[0];
      return {
        name: p.project_id,
        platform: p.type,
        status: p.status,
        on: p.scale > 0,
        plan: p.planID,
        cpu: latest(cpu),
        memory: latest(mem),
        release: r ? { state: r.state as string, at: (r.finishedAt || r.createdAt) as string } : null,
      };
    }),
  );
  return rows;
}

/** Everything the app dashboard shows. */
export async function appDetail(c: LiaraClient, name: string) {
  const base = `/v1/projects/${enc(name)}`;
  const since = nowSec() - 6 * 3600;
  const [{ project: p }, releases, cpu, mem, domains, plans] = await Promise.all([
    c.get<{ project: Project & Record<string, any> }>(base),
    settle(c.get<any>(`${base}/releases`, { page: 1, count: 8 })),
    settle(c.get<Reports>(`${base}/metrics/cpu`, { since })),
    settle(c.get<Reports>(`${base}/metrics/memory`, { since })),
    settle(c.get<{ domains: any[] }>("/v1/domains", { project: name })),
    settle(appPlanOptions(c).then((x) => x.appPlans)),
  ]);
  const plan = plans?.find((x) => x.id === p.planID);
  return {
    name: p.project_id,
    platform: p.type,
    status: p.status,
    on: p.scale > 0,
    plan: p.planID,
    zeroDowntime: !!p.zeroDowntime,
    url: p.defaultSubdomain ? `https://${p.project_id}.liara.run` : null,
    hourlyPrice: p.hourlyPrice ?? null,
    env: maskEnvs(p.envs),
    cpu: cpu ? summarizeSeries(latestInstance(cpu)) : [],
    memory: mem ? summarizeSeries(latestInstance(mem)) : [],
    /** What the plan allows, so usage reads as a share of it; null when the plan is unknown. */
    cpuLimit: plan?.cpu || null,
    memLimit: plan?.ramGB ? plan.ramGB * 1024 ** 3 : null,
    releases: (releases?.releases ?? []).map((r: any) => ({
      id: r._id,
      state: r.state,
      at: r.finishedAt || r.createdAt,
      port: r.port,
      message: r.gitInfo?.message || null,
      commit: r.gitInfo?.commit?.slice(0, 7) || null,
      client: r.client,
    })),
    domains: (domains?.domains ?? []).map((d: any) => ({ name: d.name, status: d.status, ssl: d.certificatesStatus })),
  };
}

export async function recentLogs(c: LiaraClient, name: string, seconds: number) {
  const [lines, releases] = await Promise.all([getAppLogs(c, name, nowSec() - seconds), settle(c.get<any>(`/v1/projects/${enc(name)}/releases`, { page: 1, count: 100 }))]);
  // Release tags (v1, v2…) as the Liara console prints them, so a restart or redeploy is visible in the stream.
  const tags = new Map<string, string>(((releases?.releases ?? []) as any[]).map((r) => [r._id, r.tag]));
  return lines.slice(-500).map((l): LogLine & { release?: string } => ({ ...l, release: l.releaseId ? tags.get(l.releaseId) : undefined }));
}

/** Databases and buckets for the explorer tree. */
export async function resources(c: LiaraClient) {
  const [dbs, buckets, vms] = await Promise.all([settle(c.get<any>("/v1/databases")), settle(c.storage.get<any>("/api/v1/buckets")), settle(listVMs(c))]);
  return {
    databases: ((dbs?.databases ?? dbs) || []).map((d: any) => ({
      id: d._id as string,
      name: (d.hostname ?? d._id) as string,
      type: d.type as string,
      status: (d.status ?? "") as string,
      on: d.scale === undefined ? true : d.scale > 0,
    })),
    buckets: ((buckets?.buckets ?? []) as any[]).map((b) => ({ name: b.name as string, permission: b.permission as string, status: (b.status ?? "") as string })),
    vms: (vms ?? []).map((v) => ({ id: v._id, name: v.name, power: v.power, state: v.state, os: v.OS })),
    errors: { databases: dbs === null, buckets: buckets === null, vms: vms === null },
  };
}

export async function databaseDetail(c: LiaraClient, id: string) {
  const base = `/v1/databases/${enc(id)}`;
  const since = nowSec() - 6 * 3600;
  const [d, backups, cpu, mem] = await Promise.all([
    c.get<any>(base),
    settle(c.get<any>(`${base}/backups`)),
    settle(c.get<Reports>(`${base}/metrics/cpu`, { since })),
    settle(c.get<Reports>(`${base}/metrics/memory`, { since })),
  ]);
  const x = d.database ?? d;
  return {
    id,
    name: x.hostname ?? id,
    type: x.type,
    version: x.version ?? null,
    status: x.status ?? "",
    on: x.scale === undefined ? true : x.scale > 0,
    plan: x.planID ?? null,
    publicNetwork: !!x.publicNetwork,
    backups: ((Array.isArray(backups) ? backups : backups?.backups) || []).slice(0, 10).map((b: any) => ({ name: b.name ?? b.key ?? "", size: b.size ?? null, at: b.lastModified ?? b.createdAt ?? null })),
    cpu: cpu ? summarizeSeries(latestInstance(cpu)) : [],
    memory: mem ? summarizeSeries(latestInstance(mem)) : [],
  };
}

export async function bucketDetail(c: LiaraClient, name: string) {
  const base = `/api/v1/buckets/${enc(name)}`;
  const [b, usage, objects] = await Promise.all([
    c.storage.get<any>(base).then((r) => r.bucket ?? r),
    settle(c.storage.get<any>(`${base}/metrics/summary`)),
    settle(withKeyVariants("", (seg) => c.storage.get<any>(`${base}/objects/${seg}`, { number: 50 }))),
  ]);
  const m = usage?.data?.metrics ?? {};
  const val = (pair: unknown) => (Array.isArray(pair) ? Number(pair[1]) : undefined);
  const o = objects?.data?.objects ?? {};
  return {
    name: b.name ?? name,
    plan: b.plan ?? null,
    permission: b.permission ?? null,
    status: b.status ?? "",
    endpoint: b.cluster?.endPoint ?? null,
    objectCount: val(m.totol_objects ?? m.total_objects) ?? null,
    totalBytes: val(m.total_bytes) ?? null,
    folders: (o.CommonPrefixes ?? []).map((p: any) => p.Prefix as string),
    objects: (o.Contents ?? []).map((x: any) => ({ key: x.Key as string, size: x.Size as number, modified: x.LastModified as string })),
    listingError: objects === null,
  };
}

/** Everything the VM page shows, in one request. Credentials are never included. */
export async function vmDetail(c: LiaraClient, ref: string) {
  const vm = await resolveVM(c, ref);
  const [details, operations, disks, traffic] = await Promise.all([
    vmDetails(c, vm._id),
    settle(vmOperations(c, vm._id)),
    settle(c.iaas.get<{ availableSize?: number; disks?: { _id: string; name: string; size: number; createdAt: string }[] }>(`/vm/disk/${enc(vm._id)}`)),
    settle(vmTraffic(c, vm._id)),
  ]);
  return { ...details, operations: (operations ?? []).slice(0, 15), disks, traffic };
}
