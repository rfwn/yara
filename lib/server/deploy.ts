import "server-only";
import { enc, type LiaraClient } from "../liara";
import type { Workspace } from "./workspaces";

// Deploys a workspace the way `liara deploy` does (reverse-engineered from @liara/cli):
//   POST v2/projects/{app}/sources        multipart tarball → { sourceID }
//   POST v2/projects/{app}/releases       { sourceID, type, port, build, envs, disks, cron, healthCheck, platformConfig, gitInfo, message } → { releaseID }
//   GET  v1/releases/{id}                 { release: { state, queue, failReason } }
//   GET  v2/releases/{id}/build-logs?since=  { release, buildOutput: [{ line, stream, createdAt }] }
//   POST v2/releases/{id}/cancel

export const MAX_SOURCE_SIZE = 256 * 1024 * 1024;
const TERMINAL = new Set(["READY", "FAILED", "CANCELED", "TIMEDOUT", "UNHEALTHY"]);

export type DeployPlan = {
  app: string;
  platform: string;
  port: number | null;
  message?: string;
  liaraJson: Record<string, any> | null;
};

export type DeployProgress = {
  releaseID?: string;
  stage: "PACKING" | "UPLOADING" | "QUEUED" | "BUILDING" | "PUSHING" | "DEPLOYING" | "READY" | "FAILED" | "CANCELED" | "TIMEDOUT" | "UNHEALTHY";
  queue?: number;
  files?: number;
  size?: number;
  lines: string[];
  failReason?: string;
};

/** Builds the release body exactly like the CLI from liara.json. */
function releaseBody(plan: DeployPlan, sourceID: string, gitInfo: unknown) {
  const cfg = plan.liaraJson ?? {};
  const body: Record<string, unknown> = {
    sourceID,
    type: plan.platform,
    port: plan.port ?? undefined,
    message: plan.message,
    build: { cache: cfg.build?.cache !== false, args: cfg.build?.args, dockerfile: cfg.build?.dockerfile ?? cfg.dockerfile, location: cfg.build?.location },
    cron: cfg.cron,
    args: cfg.args,
    disks: cfg.disks,
    envs: cfg.envs,
    gitInfo,
    platformConfig: cfg[plan.platform] ?? {},
  };
  if (cfg.healthCheck) {
    body.healthCheck = { ...cfg.healthCheck, command: typeof cfg.healthCheck.command === "string" ? cfg.healthCheck.command.split(" ") : cfg.healthCheck.command };
  }
  return body;
}

export async function deployWorkspace(c: LiaraClient, ws: Workspace, plan: DeployPlan, onProgress: (p: DeployProgress) => void, signal?: { cancelled: boolean }) {
  const lines: string[] = [];
  const emit = (p: Omit<DeployProgress, "lines">) => onProgress({ ...p, lines: lines.slice(-40) });

  emit({ stage: "PACKING" });
  const { buffer, files, size } = await ws.archive(plan.platform);
  if (size > MAX_SOURCE_SIZE) throw new Error(`Source is ${Math.round(size / 1048576)} MB; Liara accepts up to 256 MB. Add large folders to .liaraignore.`);

  emit({ stage: "UPLOADING", files, size });
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(buffer)], { type: "application/gzip" }), "source.tar.gz");
  const { sourceID } = await c.upload<{ sourceID: string }>(`/v2/projects/${enc(plan.app)}/sources`, form);

  const gitInfo = await ws.gitInfo().catch(() => null);
  const { releaseID } = await c.post<{ releaseID: string }>(`/v2/projects/${enc(plan.app)}/releases`, releaseBody(plan, sourceID, gitInfo));

  let since = "";
  let stage: DeployProgress["stage"] = "QUEUED";
  const started = Date.now();
  for (;;) {
    if (signal?.cancelled) {
      await c.post(`/v2/releases/${enc(releaseID)}/cancel`).catch(() => undefined);
    }
    let release: { state: string; queue?: number; failReason?: string } | undefined;
    try {
      const r = await c.get<{ release: { state: string; failReason?: string }; buildOutput: { line: string; stream: string; createdAt: string }[] }>(
        `/v2/releases/${enc(releaseID)}/build-logs`,
        { since },
      );
      release = r.release;
      for (const o of r.buildOutput ?? []) {
        lines.push(o.line.replace(/\s+$/, ""));
        if (o.stream !== "STDOUT") stage = "FAILED";
        else if (o.line.startsWith("Successfully tagged") || (o.line.startsWith("Pushing...") && !o.line.startsWith("Pushing... 100%"))) stage = "PUSHING";
        else if (stage === "QUEUED") stage = "BUILDING";
      }
      if (r.buildOutput?.length) since = r.buildOutput[r.buildOutput.length - 1].createdAt;
      if (!r.buildOutput?.length && stage === "QUEUED") {
        const q = await c.get<{ release: { queue?: number } }>(`/v1/releases/${enc(releaseID)}`).catch(() => null);
        release = { ...release, queue: q?.release.queue };
      }
    } catch {
      // transient; keep polling
    }
    const state = release?.state;
    if (state === "DEPLOYING") stage = "DEPLOYING";
    if (state && TERMINAL.has(state)) stage = state as DeployProgress["stage"];
    emit({ releaseID, stage, queue: release?.queue, files, size, failReason: release?.failReason });
    if (TERMINAL.has(stage)) {
      return { releaseID, state: stage, failReason: release?.failReason ?? null, files, size, logTail: lines.slice(-80).join("\n") };
    }
    if (Date.now() - started > 20 * 60_000) return { releaseID, state: "TIMEDOUT", failReason: "Yara stopped waiting after 20 minutes.", files, size, logTail: lines.slice(-80).join("\n") };
    await new Promise((r) => setTimeout(r, 2500));
  }
}

export async function buildLogs(c: LiaraClient, releaseID: string) {
  const r = await c.get<{ release: { state: string; failReason?: string }; buildOutput: { line: string; stream: string }[] }>(`/v2/releases/${enc(releaseID)}/build-logs`, { since: "" });
  const all = (r.buildOutput ?? []).map((o) => (o.stream === "STDOUT" ? o.line : `[${o.stream}] ${o.line}`));
  return { state: r.release?.state, failReason: r.release?.failReason ?? null, lines: all.length, tail: all.slice(-150).join("\n") };
}
