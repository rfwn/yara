import "server-only";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool as lcTool } from "@langchain/core/tools";
import { Annotation, Command, END, MessagesAnnotation, START, StateGraph, interrupt, isGraphInterrupt, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { dataDir } from "../server/db";
import { auditFinish, auditStart } from "../server/audit";
import { getMonitor, verifyAppHealth } from "../server/monitor";
import { decide } from "./policy";
import { agentPrompt } from "./prompts";
import { snapshot } from "./rollback";
import { AGENT_TOOLS, ALL_TOOLS } from "./tools";
import type { AgentCtx, AgentName, AgentTool, ApprovalRequest } from "./types";

const SPECIALISTS = ["deploy", "debug", "ops"] as const;
const AGENTS: AgentName[] = ["supervisor", ...SPECIALISTS];

export type RunCtx = AgentCtx & { model: string };

const State = Annotation.Root({
  ...MessagesAnnotation.spec,
  agent: Annotation<AgentName>({ reducer: (_a, b) => b, default: () => "supervisor" }),
});
type S = typeof State.State;

const ctxOf = (config: LangGraphRunnableConfig) => config.configurable?.ctx as RunCtx;

function llm(model: string) {
  return new ChatOpenAI({ model, apiKey: process.env.LIARA_AI_API_KEY, configuration: { baseURL: process.env.LIARA_AI_BASE_URL }, maxRetries: 2 });
}

// Tools are bound to the model by schema only; execution happens in our own nodes.
const bindable = (t: AgentTool) => lcTool(async () => "", { name: t.name, description: t.description, schema: t.schema as z.ZodObject<z.ZodRawShape> });
const handoff = (to: AgentName) =>
  lcTool(async () => "", {
    name: `transfer_to_${to}`,
    description: `Hand the task to the ${to} agent. Describe exactly what it should do and what you already found.`,
    schema: z.object({ task: z.string().describe("Precise instructions and context for the next agent") }),
  });

const boundTools = Object.fromEntries(
  AGENTS.map((a) => {
    const handoffs = a === "supervisor" ? SPECIALISTS.map(handoff) : SPECIALISTS.filter((s) => s !== a).map(handoff);
    return [a, [...AGENT_TOOLS[a].map(bindable), ...handoffs]];
  }),
) as unknown as Record<AgentName, ReturnType<typeof bindable>[]>;

// Which agent may run which tool: execution is limited to the calling agent's own set.
const allowed = Object.fromEntries(AGENTS.map((a) => [a, new Set(AGENT_TOOLS[a].map((t) => t.name))])) as Record<AgentName, Set<string>>;
const ownerOf = (tool: string) => SPECIALISTS.find((a) => allowed[a].has(tool));

const clip = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return s.length > 16_000 ? `${s.slice(0, 16_000)}…(truncated)` : s;
};
const errorText = (e: unknown) => JSON.stringify({ error: e instanceof Error ? e.message : String(e) });

const lastAI = (messages: BaseMessage[]) => [...messages].reverse().find((m): m is AIMessage => m instanceof AIMessage || m.getType() === "ai") as AIMessage | undefined;
const answeredIds = (messages: BaseMessage[]) => new Set(messages.filter((m) => m.getType() === "tool").map((m) => (m as ToolMessage).tool_call_id));

/** The policy verdict for one write call, with the request the approval card would show. */
async function assess(t: AgentTool, args: unknown, ctx: AgentCtx) {
  const request: ApprovalRequest = t.approval ? await t.approval(args as never, ctx) : { kind: "liara" as const, title: "تغییر در حساب لیارا", summary: "", risk: "medium" as const };
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.why === "string" && a.why.trim()) request.why = a.why.trim().slice(0, 300);
  request.after = APP_CHANGES.has(t.name) && !(t.name === "setAppPower" && a.on === false)
    ? "یارا بلافاصله سایت را دوباره می‌سنجد (کد پاسخ و زمان پاسخ) و نتیجه را همین‌جا نشان می‌دهد."
    : "نتیجه همین‌جا نشان داده می‌شود و در سوابق تغییرات ثبت می‌شود.";
  if (UNDOABLE.has(t.name)) request.undo = "یک نقطه‌ی بازگشت ذخیره می‌شود؛ هر وقت خواستید می‌توانید برش گردانید.";
  let safe = false;
  try {
    safe = !!(await t.autoApprove?.(args as never, ctx));
  } catch {
    safe = false;
  }
  return { request, verdict: decide(t.name, args, request, ctx, safe) };
}

/** Whether a finished change proved its own result (VM operations, deploys, app changes). */
function verifiedOf(tool: string, result: any): boolean | null {
  if (result?.verification) return !!result.verification.verified;
  if (tool === "deployWorkspace") return result?.state === "READY";
  return null;
}

/** Changes rollback.ts saves a restore point for. */
const UNDOABLE = new Set(["setEnvVars", "unsetEnvVars", "changeAppPlan", "setAppPower", "setAppFeature", "setDatabasePower", "resizeVM", "setVMPower", "editFile", "writeFile"]);

/** Changes after which the app must be shown to serve again before anyone calls it fixed. */
const APP_CHANGES = new Set(["restartApp", "setAppPower", "setEnvVars", "unsetEnvVars", "changeAppPlan", "setAppFeature", "deployRelease", "deployWorkspace"]);

/** Re-checks the app from outside after a change and attaches the outcome to the result the model sees. */
async function withVerification(tool: string, args: Record<string, unknown>, result: any, ctx: RunCtx, config: LangGraphRunnableConfig, callId: string) {
  if (!APP_CHANGES.has(tool) || typeof args.app !== "string") return result;
  if (tool === "setAppPower" && args.on === false) return result;
  if (tool === "deployWorkspace" && result?.state !== "READY") return result;
  uiFor(config, callId)("verify", { app: args.app, state: "running" });
  try {
    const verification = await verifyAppHealth(ctx.liara, args.app, { path: getMonitor(ctx.userId, args.app)?.path });
    uiFor(config, callId)("verify", { app: args.app, state: verification.verified ? "ok" : "failed", note: verification.note });
    return {
      ...(result && typeof result === "object" ? result : { response: result ?? null }),
      verification,
      ...(verification.verified ? {} : { next: "The change ran but the app is NOT healthy afterwards. Say so plainly, then investigate with diagnoseApp instead of claiming success." }),
    };
  } catch (e) {
    return { ...(result && typeof result === "object" ? result : { response: result ?? null }), verification: { verified: false, note: `Verification could not run: ${e instanceof Error ? e.message : String(e)}` } };
  }
}

/** Runs one write: rollback point, execution, audit record. Returns the tool message for the model. */
async function execWrite(
  call: { id?: string; name: string },
  t: AgentTool,
  args: unknown,
  meta: { agent: AgentName; request: ApprovalRequest; decision: "auto" | "approved"; reason: string },
  ctx: RunCtx,
  config: LangGraphRunnableConfig,
) {
  const auditId = auditStart({ userId: ctx.userId, threadId: ctx.threadId, agent: meta.agent, tool: t.name, title: meta.request.title, target: meta.request.target, risk: meta.request.risk, args, decision: meta.decision, reason: meta.reason });
  const rollback = await snapshot(t.name, args as Record<string, unknown>, ctx);
  try {
    const result = await withVerification(t.name, (args ?? {}) as Record<string, unknown>, await t.run(args as never, ctx, uiFor(config, call.id!)), ctx, config, call.id!);
    auditFinish(auditId, { status: "ok", result, verified: verifiedOf(t.name, result), rollback });
    return new ToolMessage({ tool_call_id: call.id!, name: call.name, content: clip({ ok: true, result, auditId, ...(rollback ? { rollback: `available: rollbackChange("${auditId}")` } : {}) }) });
  } catch (e) {
    if (isGraphInterrupt(e)) throw e;
    auditFinish(auditId, { status: "error", result: { error: e instanceof Error ? e.message : String(e) } });
    return new ToolMessage({ tool_call_id: call.id!, name: call.name, content: errorText(e), status: "error" });
  }
}

/** A refused change: recorded, and explained to the model so it tells the user instead of retrying. */
function blocked(call: { id?: string; name: string }, args: unknown, meta: { agent: AgentName; request: ApprovalRequest; reason: string }, ctx: RunCtx) {
  auditStart({ userId: ctx.userId, threadId: ctx.threadId, agent: meta.agent, tool: call.name, title: meta.request.title, target: meta.request.target, risk: meta.request.risk, args, decision: "blocked", reason: meta.reason, status: "skipped" });
  return new ToolMessage({
    tool_call_id: call.id!,
    name: call.name,
    status: "error",
    content: JSON.stringify({ blocked: true, reason: meta.reason, title: meta.request.title, next: "Blocked by the user's governance policy, enforced by the server. Do not retry or work around it. Tell the user plainly what was blocked, why, and what they can do (e.g. change Settings → Governance, or do it themselves)." }),
  });
}

function uiFor(config: LangGraphRunnableConfig, callId: string) {
  return (component: string, props: Record<string, unknown>) => config.writer?.({ type: "ui", id: callId, component, props });
}

// ---------- nodes ----------

/**
 * When an agent has just been handed a task, the shared history ends with another agent's turn.
 * Without an explicit brief, models continue in the previous agent's voice instead of working.
 */
function handoffBrief(name: AgentName, messages: BaseMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.getType() === "ai" && (m as AIMessage).name === name) return null;
    if (m.getType() === "tool" && (m as ToolMessage).name === `transfer_to_${name}`) {
      const task = String(m.content).replace(/^Transferred to the \w+ agent\. Task: /, "");
      return new HumanMessage(`[Handoff to the ${name} agent] Your task: ${task}
You are the ${name} agent now. Start working on it with your own tools in this turn; do not repeat what the previous agent said.`);
    }
  }
  return null;
}

const agentNode = (name: AgentName) => async (state: S, config: LangGraphRunnableConfig) => {
  const ctx = ctxOf(config);
  const brief = handoffBrief(name, state.messages);
  const res = (await llm(ctx.model)
    .bindTools(boundTools[name])
    .invoke([new SystemMessage(agentPrompt(name, ctx)), ...state.messages, ...(brief ? [brief] : [])], config)) as AIMessage;
  res.name = name;
  // Gateways can reuse response ids; the messages reducer would then overwrite earlier turns.
  res.id = `${name}-${randomUUID()}`;
  const hand = res.tool_calls?.find((c) => c.name.startsWith("transfer_to_"));
  if (hand) {
    const to = hand.name.slice("transfer_to_".length) as AgentName;
    // Every tool call needs a reply. Read tools in the same turn (e.g. updatePlan) still run; anything else is skipped.
    const replies: ToolMessage[] = [];
    for (const c of res.tool_calls ?? []) {
      let content: string;
      if (c === hand) content = `Transferred to the ${to} agent. Task: ${String(hand.args?.task ?? "")}`;
      else if (ALL_TOOLS[c.name]?.kind === "read" && allowed[name].has(c.name)) {
        try {
          const t = ALL_TOOLS[c.name];
          content = clip(await t.run(t.schema.parse(c.args), ctx, uiFor(config, c.id!)));
        } catch (e) {
          content = errorText(e);
        }
      } else content = JSON.stringify({ skipped: "handed off before running" });
      replies.push(new ToolMessage({ tool_call_id: c.id!, name: c.name, content }));
    }
    return new Command({ goto: to, update: { agent: to, messages: [res, ...replies] } });
  }
  return { messages: [res], agent: name };
};

/** Runs read tools and auto-approved writes; leaves approval-gated writes for the approval node. */
async function toolsNode(state: S, config: LangGraphRunnableConfig) {
  const ctx = ctxOf(config);
  const ai = lastAI(state.messages);
  const out: ToolMessage[] = [];
  for (const call of ai?.tool_calls ?? []) {
    const t = ALL_TOOLS[call.name];
    if (!t || !allowed[state.agent].has(call.name)) {
      const owner = ownerOf(call.name);
      const hint = owner ? `It belongs to the ${owner} agent: use transfer_to_${owner}.` : "No agent has this tool.";
      out.push(new ToolMessage({ tool_call_id: call.id!, name: call.name, content: errorText(`${call.name} is not available to the ${state.agent} agent. ${hint}`), status: "error" }));
      continue;
    }
    let args: unknown;
    try {
      args = t.schema.parse(call.args);
    } catch (e) {
      out.push(new ToolMessage({ tool_call_id: call.id!, name: call.name, content: errorText(e), status: "error" }));
      continue;
    }
    if (t.kind === "read") {
      try {
        out.push(new ToolMessage({ tool_call_id: call.id!, name: call.name, content: clip(await t.run(args as never, ctx, uiFor(config, call.id!))) }));
      } catch (e) {
        out.push(new ToolMessage({ tool_call_id: call.id!, name: call.name, content: errorText(e), status: "error" }));
      }
      continue;
    }
    // Writes: the server-side policy decides; "ask" is left for the approval node.
    let assessed;
    try {
      assessed = await assess(t, args, ctx);
    } catch (e) {
      out.push(new ToolMessage({ tool_call_id: call.id!, name: call.name, content: errorText(e), status: "error" }));
      continue;
    }
    const { request, verdict } = assessed;
    if (verdict.mode === "block") out.push(blocked(call, args, { agent: state.agent, request, reason: verdict.reason }, ctx));
    else if (verdict.mode === "auto") out.push(await execWrite(call, t, args, { agent: state.agent, request, decision: "auto", reason: verdict.reason }, ctx, config));
  }
  return { messages: out };
}

/**
 * One approval at a time: ask first (no side effects before the user answers), then run once.
 * The policy is checked again here, and typed confirmations are verified on the server.
 */
async function approvalNode(state: S, config: LangGraphRunnableConfig) {
  const ctx = ctxOf(config);
  const ai = lastAI(state.messages)!;
  const done = answeredIds(state.messages);
  const call = ai.tool_calls?.find((c) => !done.has(c.id!));
  if (!call) return {};
  const t = ALL_TOOLS[call.name];
  let args: unknown, assessed;
  try {
    args = t.schema.parse(call.args);
    assessed = await assess(t, args, ctx);
  } catch (e) {
    return { messages: [new ToolMessage({ tool_call_id: call.id!, name: call.name, content: errorText(e), status: "error" })] };
  }
  const { request, verdict } = assessed;
  if (verdict.mode === "block") return { messages: [blocked(call, args, { agent: state.agent, request, reason: verdict.reason }, ctx)] };
  if (verdict.mode === "auto") return { messages: [await execWrite(call, t, args, { agent: state.agent, request, decision: "auto", reason: verdict.reason }, ctx, config)] };

  const confirmText = verdict.confirmText;
  const decision = interrupt({ ...request, confirmText, policy: verdict.reason, callId: call.id, tool: call.name, agent: state.agent }) as { approved?: boolean; confirmText?: string };
  if (!decision?.approved) {
    auditStart({ userId: ctx.userId, threadId: ctx.threadId, agent: state.agent, tool: call.name, title: request.title, target: request.target, risk: request.risk, args, decision: "denied", reason: "Rejected by the user.", status: "skipped" });
    return { messages: [new ToolMessage({ tool_call_id: call.id!, name: call.name, content: JSON.stringify({ denied: true, message: "The user rejected this. Nothing was changed. Do not propose the same change again unless the user asks." }) })] };
  }
  if (confirmText && decision.confirmText?.trim() !== confirmText) {
    return { messages: [blocked(call, args, { agent: state.agent, request, reason: `Approval refused by the server: the typed confirmation did not match "${confirmText}".` }, ctx)] };
  }
  return { messages: [await execWrite(call, t, args, { agent: state.agent, request, decision: "approved", reason: verdict.reason }, ctx, config)] };
}

// ---------- routing ----------

const afterAgent = (state: S) => {
  const ai = lastAI(state.messages);
  // A handoff routes itself via Command; running the tools node too would answer the transfer call twice.
  if (!ai?.tool_calls?.length || ai.tool_calls.some((c) => c.name.startsWith("transfer_to_"))) return END;
  return "tools";
};

const afterTools = (state: S) => {
  const ai = lastAI(state.messages);
  const done = answeredIds(state.messages);
  // Only the agent's own write tools can be pending here; anything else was answered with an error above.
  return ai?.tool_calls?.some((c) => !done.has(c.id!)) ? "approval" : state.agent;
};

// ---------- compile ----------

// The checkpointer's connection is process-wide; the compiled graph is per module so code reloads take effect.
const g = globalThis as unknown as { __yaraSaver?: SqliteSaver };
let compiled: ReturnType<typeof compile> | undefined;

function compile() {
  const builder = new StateGraph(State)
    .addNode("supervisor", agentNode("supervisor"), { ends: [...SPECIALISTS] })
    .addNode("deploy", agentNode("deploy"), { ends: ["debug", "ops"] })
    .addNode("debug", agentNode("debug"), { ends: ["deploy", "ops"] })
    .addNode("ops", agentNode("ops"), { ends: ["deploy", "debug"] })
    .addNode("tools", toolsNode)
    .addNode("approval", approvalNode)
    .addEdge(START, "supervisor");
  for (const a of AGENTS) builder.addConditionalEdges(a, afterAgent, ["tools", END]);
  builder.addConditionalEdges("tools", afterTools, ["approval", ...AGENTS]);
  builder.addConditionalEdges("approval", afterTools, ["approval", ...AGENTS]);
  g.__yaraSaver ??= SqliteSaver.fromConnString(path.join(dataDir(), "checkpoints.db"));
  return builder.compile({ checkpointer: g.__yaraSaver });
}

export function agentGraph() {
  return (compiled ??= compile());
}
