// Collects everything the diagnosis rules look at, for one app, in parallel.
// Shared by the background monitor and the agents' diagnoseApp/probeApp tools.

import { enc, getAppLogs, latestInstance, nowSec, summarizeSeries, type LiaraClient, type Project, type Reports } from "../liara";
import { appPlanOptions, type AppPlan } from "../plans";
import { probeTwice, safePath, type Probe } from "./probe";

export type Series = { last: number; avg: number; max: number; samples: number[] } | null;

export type Evidence = {
  app: string;
  at: number;
  on: boolean;
  status: string;
  platform: string;
  plan: string;
  url: string | null;
  probe: Probe | null;
  cpu: Series;
  /** Cores the plan allows, when the plan is known. */
  cpuLimit: number | null;
  memory: Series;
  /** Bytes the plan allows, when the plan is known. */
  memLimit: number | null;
  logs: { windowMinutes: number; total: number; errorLines: number; samples: string[] } | null;
  release: { id: string; state: string; at: string } | null;
  events: string[];
  /** Sub-requests that failed; diagnosis treats their signal as unknown, not healthy. */
  gaps: string[];
};

const ERROR_LINE = /error|exception|traceback|fatal|panic|killed|oom|refused|timeout|ECONN|EADDRINUSE|cannot find module|segfault|unhandled|5\d\d /i;

const settle = async <T>(p: Promise<T>, gaps: string[], what: string): Promise<T | null> => {
  try {
    return await p;
  } catch (e) {
    gaps.push(`${what}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    return null;
  }
};

const series = (r: Reports | null): Series => {
  const s = r ? summarizeSeries(latestInstance(r))[0] : undefined;
  return s && "last" in s ? { last: s.last as number, avg: s.avg as number, max: s.max as number, samples: (s.samples as number[]) ?? [] } : null;
};

/** The public URL Yara may probe: the *.liara.run subdomain, else the app's first connected domain. */
export async function appUrl(c: LiaraClient, p: Project, path = "/") {
  const suffix = safePath(path);
  // Overridable for local testing against a mock (like LIARA_API_BASE): e.g. http://127.0.0.1:4555/apps/{app}
  const template = process.env.LIARA_APP_URL_TEMPLATE;
  if (template) return `${template.replace("{app}", p.project_id)}${suffix === "/" ? "" : suffix}`;
  if (p.defaultSubdomain) return `https://${p.project_id}.liara.run${suffix}`;
  try {
    const { domains } = await c.get<{ domains: { name: string; status?: string }[] }>("/v1/domains", { project: p.project_id });
    const d = domains.find((x) => /ok|connect|active/i.test(x.status ?? "")) ?? domains[0];
    return d ? `https://${d.name}${suffix}` : null;
  } catch {
    return null;
  }
}

/** Plans per user are read once per monitor tick; `plans` lets the caller share them. */
export async function gatherEvidence(c: LiaraClient, app: string, opts: { path?: string; logMinutes?: number; plans?: AppPlan[] | null } = {}): Promise<Evidence> {
  const gaps: string[] = [];
  const base = `/v1/projects/${enc(app)}`;
  const logMinutes = opts.logMinutes ?? 10;
  const { project: p } = await c.get<{ project: Project }>(base);
  const on = p.scale > 0;
  const since = nowSec() - 30 * 60;
  const url = await appUrl(c, p, opts.path);

  const [probe, cpu, mem, logs, rel, ev, plans] = await Promise.all([
    on && url ? probeTwice(url) : null,
    on ? settle(c.get<Reports>(`${base}/metrics/cpu`, { since }), gaps, "cpu") : null,
    on ? settle(c.get<Reports>(`${base}/metrics/memory`, { since }), gaps, "memory") : null,
    on ? settle(getAppLogs(c, app, nowSec() - logMinutes * 60), gaps, "logs") : null,
    settle(c.get<any>(`${base}/releases`, { page: 1, count: 1 }), gaps, "releases"),
    settle(c.get<any>(`${base}/events`, { start: nowSec() - 3600, end: nowSec() }), gaps, "events"),
    opts.plans !== undefined ? opts.plans : settle(appPlanOptions(c).then((x) => x.appPlans), gaps, "plans"),
  ]);

  const lines = Array.isArray(logs) ? logs : [];
  const errors = lines.filter((l) => l.type === "stderr" || ERROR_LINE.test(l.message));
  const plan = plans?.find((x) => x.id === p.planID);
  const r = rel?.releases?.[0];
  const rawEvents: any[] = Array.isArray(ev) ? ev : (ev?.events ?? []);

  return {
    app,
    at: Date.now(),
    on,
    status: p.status,
    platform: p.type,
    plan: p.planID,
    url,
    probe,
    cpu: series(cpu),
    cpuLimit: plan?.cpu || null,
    memory: series(mem),
    memLimit: plan?.ramGB ? plan.ramGB * 1024 ** 3 : null,
    logs: logs === null ? null : { windowMinutes: logMinutes, total: lines.length, errorLines: errors.length, samples: errors.slice(-12).map((l) => l.message.slice(0, 300)) },
    release: r ? { id: r._id, state: r.state, at: r.finishedAt || r.createdAt } : null,
    events: rawEvents.slice(0, 15).map((e) => (typeof e === "string" ? e : [e.type, e.message ?? e.reason ?? e.title, e.createdAt ?? e.time].filter(Boolean).join(" · ")).slice(0, 200)),
    gaps,
  };
}
