import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, createIdGenerator, stepCountIs, streamText, type UIMessage } from "ai";
import { createLiaraClient } from "@/lib/liara";
import { DEFAULT_MODEL, MODELS } from "@/lib/models";
import { systemPrompt } from "@/lib/prompt";
import { apiUser } from "@/lib/server/auth";
import { canWriteChat, saveChat, takeChatQuota } from "@/lib/server/chats";
import { buildTools } from "@/lib/tools";

export const maxDuration = 300;

export async function POST(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const { user, creds } = auth;

  const { id, messages }: { id: string; messages: UIMessage[] } = await req.json();
  if (typeof id !== "string" || !/^[\w-]{8,64}$/.test(id) || !Array.isArray(messages)) {
    return Response.json({ error: "درخواست نامعتبر است." }, { status: 400 });
  }
  if (!canWriteChat(user.id, id)) return Response.json({ error: "این گفت‌وگو پیدا نشد." }, { status: 404 });
  if (!creds.token) return Response.json({ error: "ابتدا کلید API لیارا را در تنظیمات وصل کنید." }, { status: 400 });
  if (!takeChatQuota(user.id)) {
    return Response.json({ error: "در یک ساعت گذشته درخواست زیادی فرستاده‌اید. کمی بعد دوباره امتحان کنید." }, { status: 429 });
  }

  const baseURL = process.env.LIARA_AI_BASE_URL;
  const apiKey = process.env.LIARA_AI_API_KEY;
  if (!baseURL || !apiKey) return Response.json({ error: "سرویس هوش مصنوعی روی سرور پیکربندی نشده است." }, { status: 503 });

  const modelId = user.model && MODELS.some((m) => m.id === user.model) ? user.model : DEFAULT_MODEL;
  const provider = createOpenAICompatible({ name: "yara-ai", baseURL, apiKey });

  // Persist the user's message right away, so a failed stream never loses it.
  saveChat(user.id, id, messages);

  const result = streamText({
    model: provider(modelId),
    system: systemPrompt(),
    messages: convertToModelMessages(messages),
    tools: buildTools(createLiaraClient(creds)),
    stopWhen: stepCountIs(15),
  });
  // Keep generating (and saving) even if the browser tab closes mid-answer.
  result.consumeStream();

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    generateMessageId: createIdGenerator({ prefix: "msg", size: 16 }),
    messageMetadata: ({ part }) => (part.type === "start" ? { createdAt: Date.now() } : undefined),
    onFinish: ({ messages: all }) => saveChat(user.id, id, all),
    onError: (e) => {
      console.error("[chat]", e);
      return "پاسخ مدل با خطا روبه‌رو شد. دوباره امتحان کنید.";
    },
  });
}
