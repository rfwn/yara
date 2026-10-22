import { apiUser } from "@/lib/server/auth";
import { deleteChat, getChat, renameChat } from "@/lib/server/chats";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const chat = getChat(auth.user.id, (await params).id);
  if (!chat) return Response.json({ error: "این گفت‌وگو پیدا نشد." }, { status: 404 });
  return Response.json(chat);
}

export async function PATCH(req: Request, { params }: Ctx) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const { title } = await req.json();
  if (typeof title !== "string" || !title.trim()) return Response.json({ error: "عنوان خالی است." }, { status: 400 });
  renameChat(auth.user.id, (await params).id, title.trim());
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  deleteChat(auth.user.id, (await params).id);
  return Response.json({ ok: true });
}
