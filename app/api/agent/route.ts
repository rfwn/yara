import { cancelAgent, runAgent } from "@/lib/agent/run";
import { createLiaraClient } from "@/lib/liara";
import { DEFAULT_MODEL, MODELS } from "@/lib/models";
import { apiUser } from "@/lib/server/auth";
import { canWriteChat, takeChatQuota } from "@/lib/server/chats";

export const maxDuration = 900;

/** Starts or resumes an agent run; streams events as SSE. */
export async function POST(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const { user, creds, github } = auth;
  const body = (await req.json()) as { threadId?: string; message?: string; context?: string; resume?: { approved: boolean; confirmText?: string }; app?: string; workspaceId?: string };

  if (!body.threadId || !/^[\w-]{8,64}$/.test(body.threadId)) return Response.json({ error: "درخواست نامعتبر است." }, { status: 400 });
  if (!canWriteChat(user.id, body.threadId)) return Response.json({ error: "این گفت‌وگو پیدا نشد." }, { status: 404 });
  if (!body.message?.trim() && !body.resume) return Response.json({ error: "پیام خالی است." }, { status: 400 });
  if (!creds.token) return Response.json({ error: "ابتدا کلید API لیارا را وصل کنید." }, { status: 400 });
  if (!process.env.LIARA_AI_BASE_URL || !process.env.LIARA_AI_API_KEY) return Response.json({ error: "سرویس هوش مصنوعی روی سرور پیکربندی نشده است." }, { status: 503 });
  if (body.message && !takeChatQuota(user.id)) return Response.json({ error: "در یک ساعت گذشته درخواست زیادی فرستاده‌اید." }, { status: 429 });

  const model = user.model && MODELS.some((m) => m.id === user.model) ? user.model : DEFAULT_MODEL;
  const ctx = {
    userId: user.id,
    threadId: body.threadId,
    liara: createLiaraClient(creds),
    creds,
    github,
    app: body.app?.slice(0, 64),
    workspaceId: body.workspaceId?.slice(0, 80),
    model,
  };
  const input = body.resume ? { resume: { approved: !!body.resume.approved, confirmText: typeof body.resume.confirmText === "string" ? body.resume.confirmText.slice(0, 200) : undefined } } : { message: body.message!.trim().slice(0, 8000), context: typeof body.context === "string" ? body.context.slice(0, 6000) : undefined };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      for await (const ev of runAgent(ctx, input)) {
        if (!open) continue; // keep the run going even if the tab closed; the checkpointer keeps the result
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          open = false;
        }
      }
      if (open) controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}

/** Stops the running turn of a conversation (the "stop" button). */
export async function DELETE(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const threadId = new URL(req.url).searchParams.get("threadId") ?? "";
  if (!/^[\w-]{8,64}$/.test(threadId) || !canWriteChat(auth.user.id, threadId)) return Response.json({ error: "این گفت‌وگو پیدا نشد." }, { status: 404 });
  return Response.json({ stopped: cancelAgent(threadId) });
}
