import "server-only";
import { countChanges, countFailures } from "../server/audit";
import { db } from "../server/db";
import type { AgentCtx, ApprovalRequest } from "./types";

// Server-side governance. The model proposes; this module decides whether a change runs
// automatically, waits for the user, or is refused. Nothing in a prompt can loosen it.

export type Policy = {
  /** Agents may only read; every change is refused. */
  readOnly: boolean;
  /** Low-risk changes (restart, backup, unfreeze, open PR) run without asking. */
  autoLowRisk: boolean;
  /** Builds, tests and read-only inspection commands run without asking. */
  autoSafeCommands: boolean;
  /** Deleting apps, VMs, disks, buckets, files or DNS records is refused outright. */
  blockDestructive: boolean;
  /** Changes executed per conversation per hour. */
  maxChangesPerThreadHour: number;
  /** Changes executed per account per hour. */
  maxChangesPerHour: number;
  /** Deploys of the same app per hour (stops deploy → fail → redeploy loops). */
  maxDeploysPerAppHour: number;
  /** The monitor may restart a down app on its own (only for causes a restart can fix), then verifies recovery. */
  autoHeal: boolean;
  /** Automatic restarts per app per hour before the monitor stops and escalates to the user. */
  maxAutoHealsPerAppHour: number;
  /** Scheduled routines (backups, restarts) the user created may run unattended. */
  allowRoutines: boolean;
};

export const DEFAULT_POLICY: Policy = {
  readOnly: false,
  autoLowRisk: false,
  autoSafeCommands: true,
  blockDestructive: false,
  maxChangesPerThreadHour: 12,
  maxChangesPerHour: 40,
  maxDeploysPerAppHour: 4,
  autoHeal: false,
  maxAutoHealsPerAppHour: 2,
  allowRoutines: true,
};

/** Irreversible: never automatic, always typed confirmation, optionally refused. */
export const DESTRUCTIVE = new Set(["deleteApp", "deleteBucket", "deleteObject", "deleteVM", "deleteVMDisk", "deleteDnsRecord"]);

const HOUR = 3600_000;

export function getPolicy(userId: string): Policy {
  const row = db().prepare("SELECT policy FROM users WHERE id = ?").get(userId) as { policy: string | null } | undefined;
  try {
    return { ...DEFAULT_POLICY, ...(row?.policy ? JSON.parse(row.policy) : {}) };
  } catch {
    return DEFAULT_POLICY;
  }
}

const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function setPolicy(userId: string, input: Partial<Policy>): Policy {
  const cur = getPolicy(userId);
  const next: Policy = {
    readOnly: typeof input.readOnly === "boolean" ? input.readOnly : cur.readOnly,
    autoLowRisk: typeof input.autoLowRisk === "boolean" ? input.autoLowRisk : cur.autoLowRisk,
    autoSafeCommands: typeof input.autoSafeCommands === "boolean" ? input.autoSafeCommands : cur.autoSafeCommands,
    blockDestructive: typeof input.blockDestructive === "boolean" ? input.blockDestructive : cur.blockDestructive,
    maxChangesPerThreadHour: clampInt(input.maxChangesPerThreadHour ?? cur.maxChangesPerThreadHour, 1, 50, DEFAULT_POLICY.maxChangesPerThreadHour),
    maxChangesPerHour: clampInt(input.maxChangesPerHour ?? cur.maxChangesPerHour, 1, 200, DEFAULT_POLICY.maxChangesPerHour),
    maxDeploysPerAppHour: clampInt(input.maxDeploysPerAppHour ?? cur.maxDeploysPerAppHour, 1, 20, DEFAULT_POLICY.maxDeploysPerAppHour),
    autoHeal: typeof input.autoHeal === "boolean" ? input.autoHeal : cur.autoHeal,
    maxAutoHealsPerAppHour: clampInt(input.maxAutoHealsPerAppHour ?? cur.maxAutoHealsPerAppHour, 1, 5, DEFAULT_POLICY.maxAutoHealsPerAppHour),
    allowRoutines: typeof input.allowRoutines === "boolean" ? input.allowRoutines : cur.allowRoutines,
  };
  db().prepare("UPDATE users SET policy = ? WHERE id = ?").run(JSON.stringify(next), userId);
  return next;
}

export type Verdict =
  | { mode: "auto"; reason: string }
  | { mode: "ask"; reason: string; confirmText?: string }
  | { mode: "block"; reason: string };

/**
 * Decides what happens to one proposed change.
 * `safe` is the tool's own judgement that this call is harmless (e.g. a build command).
 */
export function decide(tool: string, args: unknown, req: ApprovalRequest, ctx: AgentCtx, safe: boolean): Verdict {
  const p = getPolicy(ctx.userId);
  const a = (args ?? {}) as Record<string, unknown>;

  if (p.readOnly) return { mode: "block", reason: "Read-only mode is on in Settings → Governance: agents may not change anything." };
  if (DESTRUCTIVE.has(tool) && p.blockDestructive) return { mode: "block", reason: "Deleting resources is disabled in Settings → Governance. The user must do it in the Liara console or change the policy." };

  // Rate limits: protect against runaway loops and approval fatigue.
  const inThread = countChanges({ userId: ctx.userId, threadId: ctx.threadId }, HOUR);
  if (inThread >= p.maxChangesPerThreadHour)
    return { mode: "block", reason: `Limit reached: ${inThread} changes in this conversation in the last hour (policy max ${p.maxChangesPerThreadHour}). Summarise what was done and stop.` };
  const inAccount = countChanges({ userId: ctx.userId }, HOUR);
  if (inAccount >= p.maxChangesPerHour) return { mode: "block", reason: `Limit reached: ${inAccount} changes on this account in the last hour (policy max ${p.maxChangesPerHour}).` };
  if (tool === "deployWorkspace" || tool === "deployRelease") {
    const deploys = countChanges({ userId: ctx.userId, tool, target: req.target }, HOUR);
    if (deploys >= p.maxDeploysPerAppHour)
      return { mode: "block", reason: `${deploys} deploys of ${req.target} in the last hour (policy max ${p.maxDeploysPerAppHour}). Stop redeploying; find the cause from the build logs first.` };
  }
  const failures = countFailures(ctx.userId, ctx.threadId, tool, args, HOUR);
  if (failures >= 2) return { mode: "block", reason: "This exact change already failed twice in the last hour. Do not retry it; investigate the error or try a different fix." };

  // Approval tiers.
  if (req.risk === "high" || DESTRUCTIVE.has(tool)) return { mode: "ask", reason: "High-risk change: needs approval and the resource name typed.", confirmText: req.confirmText ?? String(a.vm ?? a.app ?? a.bucket ?? req.target ?? tool) };
  if (safe && p.autoSafeCommands) return { mode: "auto", reason: "Safe command (build, test or read-only inspection), allowed by policy." };
  if (req.risk === "low" && p.autoLowRisk) return { mode: "auto", reason: "Low-risk change, auto-approved by policy." };
  return { mode: "ask", reason: req.risk === "low" ? "Low-risk change; policy asks for approval." : "Changes need your approval under the current policy." };
}

/**
 * Verdict for a change nobody is watching live: a monitor auto-heal or a scheduled routine.
 * Same hard limits as agent changes (read-only, account rate), plus their own switches and caps.
 */
export function decideUnattended(userId: string, kind: "autoHeal" | "routine", tool: string, target: string): Verdict {
  const p = getPolicy(userId);
  if (p.readOnly) return { mode: "block", reason: "Read-only mode is on: unattended changes are not allowed." };
  if (kind === "autoHeal" && !p.autoHeal) return { mode: "block", reason: "Auto-heal is off in Settings → Governance; the monitor only reports and suggests." };
  if (kind === "routine" && !p.allowRoutines) return { mode: "block", reason: "Scheduled routines are paused in Settings → Governance." };
  const inAccount = countChanges({ userId }, HOUR);
  if (inAccount >= p.maxChangesPerHour) return { mode: "block", reason: `Account limit reached: ${inAccount} changes in the last hour (policy max ${p.maxChangesPerHour}).` };
  if (kind === "autoHeal") {
    const heals = countChanges({ userId, threadId: MONITOR_THREAD, tool, target }, HOUR);
    if (heals >= p.maxAutoHealsPerAppHour)
      return { mode: "block", reason: `${heals} automatic ${tool} of ${target} in the last hour (policy max ${p.maxAutoHealsPerAppHour}). Restarting again would hide the problem; escalating to the user.` };
    return { mode: "auto", reason: `Auto-heal allowed by policy (${heals + 1}/${p.maxAutoHealsPerAppHour} this hour); the cause is one a restart can fix.` };
  }
  return { mode: "auto", reason: "Scheduled routine the user created; allowed by policy." };
}

/** Audit thread id for changes made by the monitor and routines (not tied to a conversation). */
export const MONITOR_THREAD = "monitor";
