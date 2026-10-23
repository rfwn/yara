import type { z } from "zod";
import type { LiaraClient, LiaraCreds } from "../liara";
import type { Risk } from "../action-meta";

/** Everything a tool may use for the current user; passed via the run config, never checkpointed. */
export type AgentCtx = {
  userId: string;
  threadId: string;
  liara: LiaraClient;
  creds: LiaraCreds;
  github: string | null;
  /** The workspace the user has open, if any. */
  workspaceId?: string;
  /** The Liara app the user has open, if any. */
  app?: string;
};

export type AgentName = "supervisor" | "deploy" | "debug" | "ops";

/** What the approval card shows. Rendered by components/yara/agent/ApprovalCard.tsx. */
export type ApprovalRequest = {
  kind: "edit" | "command" | "deploy" | "liara" | "git";
  title: string;
  summary: string;
  risk: Risk;
  target?: string;
  diff?: string;
  command?: string;
  details?: Record<string, unknown>;
  confirmText?: string;
  /** Why the policy wants approval (shown on the card). */
  policy?: string;
  /** Which finding this change addresses, in the agent's words. */
  why?: string;
  /** What happens right after it runs (e.g. the automatic health re-check). */
  after?: string;
  /** Whether Yara saved a restore point and can undo it. */
  undo?: string;
};

/** A live generative-UI update streamed while a tool runs. */
export type UiEmit = (component: string, props: Record<string, unknown>) => void;

export type AgentTool<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  schema: S;
  /** "write" tools pause for the user's approval unless autoApprove says otherwise. */
  kind: "read" | "write";
  run: (args: z.infer<S>, ctx: AgentCtx, ui: UiEmit) => Promise<unknown>;
  approval?: (args: z.infer<S>, ctx: AgentCtx) => Promise<ApprovalRequest> | ApprovalRequest;
  autoApprove?: (args: z.infer<S>, ctx: AgentCtx) => Promise<boolean> | boolean;
};

export const defineTool = <S extends z.ZodTypeAny>(t: AgentTool<S>) => t as unknown as AgentTool;
