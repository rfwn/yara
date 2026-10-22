import { apiUser } from "@/lib/server/auth";
import { listChats } from "@/lib/server/chats";

export async function GET() {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  return Response.json({ chats: listChats(auth.user.id) });
}
