import { createLiaraClient, LiaraError } from "@/lib/liara";
import { apiUser } from "@/lib/server/auth";
import { vmDetail } from "@/lib/server/views";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  try {
    return Response.json(await vmDetail(createLiaraClient(auth.creds), decodeURIComponent((await params).id)));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof LiaraError ? e.status : 500 });
  }
}
