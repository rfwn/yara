import "server-only";
import { z } from "zod";
import { updateEnvs } from "../actions";
import { enc, type Env, type Project } from "../liara";
import { getAudit, markRolledBack, rollbackSnapshot } from "../server/audit";
import { resolveVM } from "../vms";
import { workspaceFor } from "./workspace";
import { defineTool, type AgentCtx } from "./types";

// Rollback points: before a change runs, record what it is about to overwrite.
// rollbackChange restores that state later, as a new approved change of its own.

type Snapshot =
  | { kind: "envs"; app: string; envs: Env[] }
  | { kind: "appPlan"; app: string; planID: string }
  | { kind: "appPower"; app: string; on: boolean }
  | { kind: "appFeature"; app: string; feature: string; enabled: boolean }
  | { kind: "dbPower"; databaseId: string; on: boolean }
  | { kind: "vmPlan"; vm: string; plan: string }
  | { kind: "vmPower"; vm: string; on: boolean }
  | { kind: "file"; workspace: string; path: string; content: string | null };

const MAX_FILE = 256 * 1024;

/** Captures the state a change is about to overwrite. Returns null when the change has no undo. */
export async function snapshot(tool: string, args: Record<string, any>, ctx: AgentCtx): Promise<Snapshot | null> {
  const c = ctx.liara;
  const project = async (app: string) => (await c.get<{ project: Project & { features?: Record<string, boolean> } }>(`/v1/projects/${enc(app)}`)).project;
  try {
    switch (tool) {
      case "setEnvVars":
      case "unsetEnvVars":
        return { kind: "envs", app: args.app, envs: (await project(args.app)).envs ?? [] };
      case "changeAppPlan":
        return { kind: "appPlan", app: args.app, planID: (await project(args.app)).planID };
      case "setAppPower":
        return { kind: "appPower", app: args.app, on: (await project(args.app)).scale > 0 };
      case "setAppFeature":
        return { kind: "appFeature", app: args.app, feature: args.feature, enabled: !args.enabled };
      case "setDatabasePower": {
        const d = await c.get<any>(`/v1/databases/${enc(args.databaseId)}`);
        const x = d.database ?? d;
        return { kind: "dbPower", databaseId: args.databaseId, on: x.scale === undefined ? true : x.scale > 0 };
      }
      case "resizeVM":
        return { kind: "vmPlan", vm: args.vm, plan: (await resolveVM(c, args.vm)).plan };
      case "setVMPower":
        return { kind: "vmPower", vm: args.vm, on: (await resolveVM(c, args.vm)).power === "POWERED_ON" };
      case "editFile":
      case "writeFile": {
        const ws = workspaceFor(ctx, args.workspace);
        const before = await ws.readRaw(args.path);
        if (before !== null && before.length > MAX_FILE) return null;
        return { kind: "file", workspace: ws.info.id, path: args.path, content: before };
      }
    }
  } catch {
    // No snapshot is better than blocking the change on a failed read; the audit shows "no rollback".
  }
  return null;
}

function describe(s: Snapshot) {
  switch (s.kind) {
    case "envs":
      return { title: "بازگرداندن متغیرهای محیطی", summary: `همه‌ی متغیرهای محیطی \`${s.app}\` به حالت پیش از تغییر برمی‌گردند (${s.envs.length} متغیر). برنامه دوباره راه‌اندازی می‌شود.`, target: s.app };
    case "appPlan":
      return { title: "بازگرداندن پلن برنامه", summary: `پلن \`${s.app}\` به \`${s.planID}\` برمی‌گردد.`, target: s.app };
    case "appPower":
      return { title: "بازگرداندن وضعیت برنامه", summary: `\`${s.app}\` ${s.on ? "روشن" : "خاموش"} می‌شود.`, target: s.app };
    case "appFeature":
      return { title: "بازگرداندن ویژگی برنامه", summary: `ویژگی \`${s.feature}\` روی \`${s.app}\` ${s.enabled ? "فعال" : "غیرفعال"} می‌شود.`, target: s.app };
    case "dbPower":
      return { title: "بازگرداندن وضعیت دیتابیس", summary: `دیتابیس ${s.on ? "روشن" : "خاموش"} می‌شود.`, target: s.databaseId };
    case "vmPlan":
      return { title: "بازگرداندن پلن ماشین مجازی", summary: `پلن \`${s.vm}\` به \`${s.plan}\` برمی‌گردد.`, target: s.vm };
    case "vmPower":
      return { title: "بازگرداندن وضعیت ماشین مجازی", summary: `\`${s.vm}\` ${s.on ? "روشن" : "به‌صورت امن خاموش"} می‌شود.`, target: s.vm };
    case "file":
      return { title: "بازگرداندن فایل", summary: s.content === null ? `فایل \`${s.path}\` که یارا ساخته بود خالی می‌شود.` : `\`${s.path}\` به محتوای پیش از ویرایش برمی‌گردد.`, target: s.path };
  }
}

async function apply(s: Snapshot, ctx: AgentCtx) {
  const c = ctx.liara;
  switch (s.kind) {
    case "envs":
      await updateEnvs(c, s.app, s.envs);
      return { restored: `${s.envs.length} env vars` };
    case "appPlan":
      return c.post(`/v1/projects/${enc(s.app)}/resize`, { planID: s.planID });
    case "appPower":
      return c.post(`/v1/projects/${enc(s.app)}/actions/scale`, { scale: s.on ? 1 : 0 });
    case "appFeature":
      return c.post(`/v1/projects/${enc(s.app)}/${s.feature}/${s.enabled ? "enable" : "disable"}`);
    case "dbPower":
      return c.post(`/v1/databases/${enc(s.databaseId)}/actions/scale`, { scale: s.on ? 1 : 0 });
    case "vmPlan": {
      const v = await resolveVM(c, s.vm);
      return c.iaas.patch(`/vm/resize/${enc(v._id)}`, { plan: s.plan });
    }
    case "vmPower": {
      const v = await resolveVM(c, s.vm);
      return c.iaas.patch(`/vm/power/${enc(v._id)}`, { action: s.on ? "start" : "shutdown" });
    }
    case "file": {
      const ws = workspaceFor(ctx, s.workspace);
      return ws.write(s.path, s.content ?? "");
    }
  }
}

export const rollbackChange = defineTool({
  name: "rollbackChange",
  description:
    "Undo an earlier change by its audit id (ch_…): restores env vars, plans, power state, app features or a file to what they were before. Every applied change result includes its auditId; the user can also see ids on the Audit page.",
  schema: z.object({ auditId: z.string().regex(/^ch_[0-9a-f]{12}$/) }),
  kind: "write",
  approval: async (a, ctx) => {
    const r = rollbackSnapshot(ctx.userId, a.auditId);
    if ("error" in r) throw new Error(r.error);
    const d = describe(r.snapshot as Snapshot);
    const orig = getAudit(ctx.userId, a.auditId);
    return { kind: "liara", title: d.title, summary: `${d.summary}\n\nبرگرداندن تغییر \`${a.auditId}\` (${orig?.title ?? r.tool}).`, risk: "medium", target: d.target };
  },
  run: async (a, ctx) => {
    const r = rollbackSnapshot(ctx.userId, a.auditId);
    if ("error" in r) throw new Error(r.error);
    const snap = r.snapshot as Snapshot;
    const result = await apply(snap, ctx);
    markRolledBack(a.auditId, ctx.threadId);
    const target = describe(snap).target;
    return { rolledBack: a.auditId, kind: snap.kind, target, result: result ?? null, next: `Verify the restored state of ${target} with a read tool (getApp, getVM, getDatabase or readFile) and report it.` };
  },
});
