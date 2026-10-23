import "server-only";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { touchGraphChat } from "../server/chats";
import { agentGraph, type RunCtx } from "./graph";

/** Events sent to the browser (one JSON object per SSE "data:" line). */
export type AgentEvent =
  | { t: "text"; agent: string; id: string; delta: string }
  | { t: "call"; agent: string; id: string; name: string; args: unknown }
  | { t: "result"; id: string; name: string; output: unknown; error?: boolean }
  | { t: "handoff"; from: string; to: string; task: string }
  | { t: "ui"; id: string; component: string; props: Record<string, unknown> }
  | { t: "approval"; request: Record<string, unknown> }
  | { t: "error"; message: string }
  | { t: "done" };

/** Live runs per thread; aborting one stops the graph between steps (the checkpoint keeps what finished). */
const running = new Map<string, AbortController>();

/** Stops a running thread. Returns false when nothing was running. */
export function cancelAgent(threadId: string) {
  const ctl = running.get(threadId);
  if (!ctl) return false;
  ctl.abort();
  return true;
}

/** Marks hidden context (monitor findings handed over with "fix with Yara") so history never shows it as the user's words. */
const CONTEXT_NAME = "yara_context";
const AGENT_NODES = ["supervisor", "deploy", "debug", "ops"];

const parse = (s: unknown) => {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

const textOf = (content: unknown) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text : "")).join("") : "";

/** Model-gateway failures in words the user can act on; anything else passes through. */
function friendlyError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number })?.status ?? Number(msg.match(/^(\d{3})\b/)?.[1]);
  if (status === 402) return "اعتبار سرویس هوش مصنوعی (کلید API مدل) تمام شده است. پس از شارژ، همین گفت‌وگو را ادامه دهید؛ چیزی از دست نرفته است.";
  if (status === 401 || status === 403) return "کلید API سرویس هوش مصنوعی روی سرور معتبر نیست.";
  if (status === 429) return "سرویس هوش مصنوعی موقتاً درخواست زیادی دریافت کرده است. چند لحظه بعد دوباره تلاش کنید.";
  return msg;
}

/** Runs (or resumes) a thread and yields browser events. */
export async function* runAgent(ctx: RunCtx, input: { message: string; context?: string } | { resume: { approved: boolean; confirmText?: string } }): AsyncGenerator<AgentEvent> {
  if (running.has(ctx.threadId)) {
    yield { t: "error", message: "این گفت‌وگو هنوز در حال اجراست." };
    return;
  }
  const abort = new AbortController();
  running.set(ctx.threadId, abort);
  const graph = agentGraph();
  const config = { configurable: { thread_id: ctx.threadId, ctx }, recursionLimit: 80 };
  try {
    const messages =
      "message" in input
        ? [
            ...(input.context ? [new HumanMessage({ content: `[Context from Yara's monitor, not typed by the user]
${input.context}`, name: CONTEXT_NAME })] : []),
            new HumanMessage(input.message),
          ]
        : [];
    const graphInput = "message" in input ? { messages } : new Command({ resume: input.resume });
    if ("message" in input) touchGraphChat(ctx.userId, ctx.threadId, input.message, 0);

    const stream = await graph.stream(graphInput as Parameters<typeof graph.stream>[0], { ...config, streamMode: ["messages", "updates", "custom"], signal: abort.signal });
    for await (const [mode, chunk] of stream as AsyncIterable<[string, any]>) {
      if (mode === "messages") {
        const [msg, meta] = chunk as [BaseMessage, Record<string, any>];
        const node = meta?.langgraph_node;
        // Only streamed tokens. The node's final message (re-id'd as "<agent>-<uuid>" in graph.ts) is re-emitted at the end and would duplicate the text.
        if (AGENT_NODES.includes(node) && !msg.id?.startsWith(`${node}-`)) {
          const delta = textOf(msg.content);
          if (delta) yield { t: "text", agent: node, id: msg.id ?? `${node}-${meta.langgraph_step}`, delta };
        }
      } else if (mode === "custom") {
        if (chunk?.type === "ui") yield { t: "ui", id: chunk.id, component: chunk.component, props: chunk.props };
      } else if (mode === "updates") {
        for (const [node, update] of Object.entries(chunk as Record<string, any>)) {
          if (node === "__interrupt__") {
            for (const it of update as { value: Record<string, unknown> }[]) yield { t: "approval", request: it.value };
            continue;
          }
          for (const m of (update?.messages ?? []) as BaseMessage[]) {
            if (m.getType() === "ai") {
              for (const c of (m as any).tool_calls ?? []) {
                if (c.name.startsWith("transfer_to_")) yield { t: "handoff", from: node, to: c.name.slice(12), task: String(c.args?.task ?? "") };
                else yield { t: "call", agent: node, id: c.id, name: c.name, args: c.args };
              }
            } else if (m.getType() === "tool" && !(m as any).name?.startsWith("transfer_to_")) {
              yield { t: "result", id: (m as any).tool_call_id, name: (m as any).name, output: parse(m.content), error: (m as any).status === "error" };
            }
          }
        }
      }
    }
    const state = await graph.getState(config);
    const pending = state.tasks.reduce((n, t) => n + (t.interrupts?.length ?? 0), 0);
    touchGraphChat(ctx.userId, ctx.threadId, "", pending);
  } catch (e) {
    if (abort.signal.aborted) {
      yield { t: "error", message: "متوقف شد. کارهایی که تا این لحظه تمام شده بود سر جایش است؛ تغییری نیمه‌کاره اجرا نشد." };
    } else {
      console.error("[agent]", e);
      yield { t: "error", message: friendlyError(e) };
    }
  } finally {
    running.delete(ctx.threadId);
    yield { t: "done" };
  }
}

/** Rebuilds the visible timeline of a thread from its checkpoint. */
export async function threadHistory(threadId: string) {
  const graph = agentGraph();
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  const messages = (state.values?.messages ?? []) as BaseMessage[];
  const events: AgentEvent[] = [];
  for (const m of messages) {
    const type = m.getType();
    if (type === "human" && (m as any).name === CONTEXT_NAME) continue;
    if (type === "human") events.push({ t: "text", agent: "user", id: m.id ?? String(events.length), delta: textOf(m.content) });
    else if (type === "ai") {
      const agent = (m as any).name ?? "supervisor";
      const text = textOf(m.content);
      if (text) events.push({ t: "text", agent, id: m.id ?? String(events.length), delta: text });
      for (const c of (m as any).tool_calls ?? []) {
        if (c.name.startsWith("transfer_to_")) events.push({ t: "handoff", from: agent, to: c.name.slice(12), task: String(c.args?.task ?? "") });
        else events.push({ t: "call", agent, id: c.id, name: c.name, args: c.args });
      }
    } else if (type === "tool" && !(m as any).name?.startsWith("transfer_to_")) {
      events.push({ t: "result", id: (m as any).tool_call_id, name: (m as any).name, output: parse(m.content), error: (m as any).status === "error" });
    }
  }
  for (const t of state.tasks) for (const it of t.interrupts ?? []) events.push({ t: "approval", request: it.value as Record<string, unknown> });
  return events;
}
