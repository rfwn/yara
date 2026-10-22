import { AuthError, checkCredentials, clientIp, startSession } from "@/lib/server/auth";

export async function POST(req: Request) {
  try {
    const { email = "", password = "" } = await req.json();
    const id = checkCredentials(String(email), String(password), clientIp(req));
    await startSession(id);
    return Response.json({ ok: true, next: "/app" });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
