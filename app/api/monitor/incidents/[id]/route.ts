import { apiUser } from "@/lib/server/auth";
import { resolveIncidentByUser } from "@/lib/server/monitor";

type Ctx = { params: Promise<{ id: string }> };

/** The user closes an incident by hand. */
export async function POST(_req: Request, { params }: Ctx) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  try {
    return Response.json({ incident: resolveIncidentByUser(auth.user.id, (await params).id) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
