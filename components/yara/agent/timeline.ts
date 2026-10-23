// Folds the agent event stream (live SSE or rebuilt history) into a renderable timeline.
// Live and restored threads go through the same reducer, so they render identically.

export type AgentId = "supervisor" | "deploy" | "debug" | "ops" | "monitor";

export type ApprovalRequest = {
  kind: "edit" | "command" | "deploy" | "liara" | "git";
  title: string;
  summary: string;
  risk: "low" | "medium" | "high";
  target?: string;
  diff?: string;
  command?: string;
  details?: Record<string, unknown>;
  confirmText?: string;
  /** Why the server-side policy asks for approval. */
  policy?: string;
  /** Which finding this change fixes (the agent's words). */
  why?: string;
  /** What happens right after it runs. */
  after?: string;
  /** Set when a restore point is saved. */
  undo?: string;
  callId: string;
  tool: string;
  agent: AgentId;
};

export type AgentEvent =
  | { t: "text"; agent: string; id: string; delta: string }
  | { t: "call"; agent: AgentId; id: string; name: string; args: unknown }
  | { t: "result"; id: string; name: string; output: unknown; error?: boolean }
  | { t: "handoff"; from: AgentId; to: AgentId; task: string }
  | { t: "ui"; id: string; component: string; props: Record<string, unknown> }
  | { t: "approval"; request: ApprovalRequest }
  | { t: "error"; message: string }
  | { t: "done" };

export type Call = {
  id: string;
  agent: AgentId;
  name: string;
  args: Record<string, any>;
  output?: any;
  error?: boolean;
  done: boolean;
  /** Latest props per live UI component (command output, deploy progress). */
  ui: Record<string, Record<string, any>>;
  approval?: ApprovalRequest;
  decision?: "pending" | "approved" | "denied";
};

export type Item =
  | { k: "user"; id: string; text: string }
  | { k: "text"; id: string; agent: AgentId; text: string }
  | { k: "call"; call: Call }
  | { k: "handoff"; id: string; from: AgentId; to: AgentId; task: string }
  | { k: "error"; id: string; message: string };

export type Timeline = { items: Item[]; calls: Record<string, Call> };

export const emptyTimeline = (): Timeline => ({ items: [], calls: {} });

const callOf = (tl: Timeline, id: string, fallback?: Partial<Call>): Call => {
  let c = tl.calls[id];
  if (!c) {
    c = { id, agent: "supervisor", name: "", args: {}, done: false, ui: {}, ...fallback };
    tl.calls[id] = c;
    tl.items.push({ k: "call", call: c });
  }
  return c;
};

/** Returns a new timeline; calls are copied on write so React sees the change. */
export function reduce(prev: Timeline, ev: AgentEvent): Timeline {
  const tl: Timeline = { items: [...prev.items], calls: { ...prev.calls } };
  const touch = (id: string, fallback?: Partial<Call>) => {
    const old = callOf(tl, id, fallback);
    const c = { ...old, ui: { ...old.ui } };
    tl.calls[id] = c;
    tl.items = tl.items.map((it) => (it.k === "call" && it.call.id === id ? { k: "call", call: c } : it));
    return c;
  };

  switch (ev.t) {
    case "text": {
      if (ev.agent === "user") {
        tl.items.push({ k: "user", id: ev.id, text: ev.delta });
        break;
      }
      const last = tl.items[tl.items.length - 1];
      if (last?.k === "text" && last.id === ev.id) tl.items[tl.items.length - 1] = { ...last, text: last.text + ev.delta };
      else tl.items.push({ k: "text", id: ev.id, agent: ev.agent as AgentId, text: ev.delta });
      break;
    }
    case "call": {
      const c = touch(ev.id, { agent: ev.agent, name: ev.name });
      c.agent = ev.agent;
      c.name = ev.name;
      c.args = (ev.args ?? {}) as Record<string, any>;
      break;
    }
    case "result": {
      const c = touch(ev.id, { name: ev.name });
      c.output = ev.output;
      c.error = ev.error;
      c.done = true;
      if (c.decision === "pending") c.decision = (ev.output as any)?.denied ? "denied" : "approved";
      else if (!c.decision && (ev.output as any)?.denied) c.decision = "denied";
      else if (!c.decision && (ev.output as any)?.ok) c.decision = "approved";
      break;
    }
    case "ui": {
      const c = touch(ev.id);
      c.ui[ev.component] = ev.props;
      break;
    }
    case "approval": {
      const c = touch(ev.request.callId, { agent: ev.request.agent, name: ev.request.tool });
      c.approval = ev.request;
      if (!c.done) c.decision = "pending";
      break;
    }
    case "handoff":
      tl.items.push({ k: "handoff", id: `h-${tl.items.length}`, from: ev.from, to: ev.to, task: ev.task });
      break;
    case "error":
      tl.items.push({ k: "error", id: `e-${tl.items.length}`, message: ev.message });
      break;
  }
  return tl;
}

export const fromEvents = (events: AgentEvent[]) => events.reduce(reduce, emptyTimeline());

export const pendingCall = (tl: Timeline) => Object.values(tl.calls).find((c) => c.decision === "pending");

/** Parses an SSE response body into events. */
export async function* readEvents(res: Response): AsyncGenerator<AgentEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            yield JSON.parse(line.slice(6)) as AgentEvent;
          } catch {
            // ignore a malformed frame
          }
        }
      }
    }
  }
}
