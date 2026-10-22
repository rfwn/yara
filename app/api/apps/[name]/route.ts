import { createLiaraClient, LiaraError } from "@/lib/liara";
import { apiUser } from "@/lib/server/auth";
import { appDetail } from "@/lib/server/views";

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  try {
    return Response.json(await appDetail(createLiaraClient(auth.creds), (await params).name));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof LiaraError ? e.status : 500 });
  }
}
