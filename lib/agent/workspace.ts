import "server-only";
import { getWorkspace, listWorkspaces, type Workspace } from "../server/workspaces";
import type { AgentCtx } from "./types";

/** The workspace a tool call targets: explicit id, else the one the user has open, else the only one. */
export function workspaceFor(ctx: AgentCtx, id?: string): Workspace {
  const all = listWorkspaces(ctx.userId);
  const wanted = id ?? ctx.workspaceId ?? (all.length === 1 ? all[0].id : undefined);
  if (!wanted) {
    throw new Error(
      all.length
        ? `Several workspaces exist; pass "workspace" with one of: ${all.map((w) => `${w.id} (${w.label})`).join(", ")}`
        : "No workspace is connected. Ask the user to connect a GitHub repo or start the local runner (Settings).",
    );
  }
  const ws = getWorkspace(ctx.userId, wanted);
  if (!ws) throw new Error(`Workspace ${wanted} is not available (a local runner may have disconnected).`);
  return ws;
}
