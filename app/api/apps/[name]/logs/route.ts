import { createLiaraClient, LiaraError } from "@/lib/liara";
import { apiUser } from "@/lib/server/auth";
import { recentLogs } from "@/lib/server/views";

export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const seconds = Math.min(Math.max(Number(new URL(req.url).searchParams.get("seconds")) || 900, 10), 86400);
  try {
    return Response.json({ lines: await recentLogs(createLiaraClient(auth.creds), (await params).name, seconds) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof LiaraError ? e.status : 500 });
  }
}
