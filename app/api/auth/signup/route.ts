import { AuthError, clientIp, createUser, startSession } from "@/lib/server/auth";

export async function POST(req: Request) {
  try {
    const { name = "", email = "", password = "" } = await req.json();
    const id = createUser({ name: String(name), email: String(email), password: String(password) }, clientIp(req));
    await startSession(id);
    return Response.json({ ok: true, next: "/onboarding" });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
