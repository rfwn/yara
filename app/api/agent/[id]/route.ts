import { threadHistory } from "@/lib/agent/run";
import { apiUser } from "@/lib/server/auth";
import { db } from "@/lib/server/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const row = db().prepare("SELECT title FROM chats WHERE id = ? AND user_id = ? AND engine = 'graph'").get(id, auth.user.id) as { title: string } | undefined;
  if (!row) return Response.json({ error: "این گفت‌وگو پیدا نشد." }, { status: 404 });
  return Response.json({ title: row.title, events: await threadHistory(id) });
}
