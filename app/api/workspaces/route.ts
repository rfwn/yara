import { apiUser } from "@/lib/server/auth";
import { cloneRepo, listWorkspaces } from "@/lib/server/workspaces";

export async function GET() {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  return Response.json({ workspaces: listWorkspaces(auth.user.id) });
}

/** Clones a GitHub repo into a server workspace. */
export async function POST(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  if (!auth.github) return Response.json({ error: "ابتدا توکن گیت‌هاب را در تنظیمات وصل کنید." }, { status: 400 });
  const { repo, branch } = (await req.json()) as { repo?: string; branch?: string };
  try {
    const id = await cloneRepo(auth.user.id, String(repo ?? "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""), auth.github, branch?.trim() || undefined);
    return Response.json({ id });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
