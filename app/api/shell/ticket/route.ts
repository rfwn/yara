import { apiUser } from "@/lib/server/auth";
import { randomToken } from "@/lib/server/crypto";
import { db } from "@/lib/server/db";

// Mints a single-use, 30-second ticket the browser trades for a shell over /ws/shell.
export async function POST(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  if (!auth.creds.token) return Response.json({ error: "ابتدا کلید API لیارا را وصل کنید." }, { status: 400 });
  const { app } = (await req.json()) as { app?: string };
  if (!app || !/^[a-z0-9-]{1,64}$/.test(app)) return Response.json({ error: "نام برنامه نامعتبر است." }, { status: 400 });
  const ticket = randomToken(24);
  db().prepare("INSERT INTO shell_tickets (id, user_id, app, expires_at) VALUES (?, ?, ?, ?)").run(ticket, auth.user.id, app, Date.now() + 30_000);
  return Response.json({ ticket });
}
