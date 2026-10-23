import { apiUser } from "@/lib/server/auth";
import { getWorkspace, removeWorkspace } from "@/lib/server/workspaces";

type Ctx = { params: Promise<{ id: string }> };

/** File tree (?dir=&depth=), file content (?file=), or git changes (?changes=1). */
export async function GET(req: Request, { params }: Ctx) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const ws = getWorkspace(auth.user.id, decodeURIComponent((await params).id));
  if (!ws) return Response.json({ error: "این فضای کاری در دسترس نیست." }, { status: 404 });
  const q = new URL(req.url).searchParams;
  try {
    if (q.get("file")) return Response.json(await ws.read(q.get("file")!));
    if (q.get("changes")) return Response.json(await ws.changes());
    return Response.json({ info: ws.info, entries: await ws.list(q.get("dir") ?? ".", Number(q.get("depth")) || 1) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  return Response.json({ ok: removeWorkspace(auth.user.id, decodeURIComponent((await params).id)) });
}
