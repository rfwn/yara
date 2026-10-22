import { createLiaraClient, LiaraError, type Project } from "@/lib/liara";
import { MODELS } from "@/lib/models";
import { apiUser, deleteUser, endSession, updateUserSettings } from "@/lib/server/auth";

export async function GET() {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  return Response.json({ user: auth.user });
}

/** Update settings. A new Liara token is verified against the API before it is stored. */
export async function PATCH(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const body = (await req.json()) as { liaraToken?: string; teamID?: string; model?: string; name?: string };

  const update: Parameters<typeof updateUserSettings>[1] = {};
  if (typeof body.name === "string" && body.name.trim().length >= 2) update.name = body.name.trim().slice(0, 60);
  if (typeof body.model === "string") update.model = MODELS.some((m) => m.id === body.model) ? body.model : null;
  if (typeof body.teamID === "string") update.teamID = body.teamID.trim();

  let apps: number | undefined;
  if (typeof body.liaraToken === "string" && body.liaraToken.trim()) {
    const token = body.liaraToken.trim();
    const teamID = update.teamID ?? auth.user.teamID ?? undefined;
    try {
      const { projects } = await createLiaraClient({ token, teamID }).get<{ projects: Project[] }>("/v1/projects");
      apps = projects.length;
    } catch (e) {
      const status = e instanceof LiaraError ? e.status : 502;
      const error =
        status === 401 || status === 403
          ? "لیارا این کلید را نپذیرفت. کلید را دوباره از کنسول کپی کنید و مطمئن شوید منقضی نشده است."
          : `ارتباط با لیارا برقرار نشد (${status}). کمی بعد دوباره امتحان کنید.`;
      return Response.json({ error }, { status: 400 });
    }
    update.liaraToken = token;
  }

  updateUserSettings(auth.user.id, update);
  return Response.json({ ok: true, apps });
}

export async function DELETE() {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  await endSession();
  deleteUser(auth.user.id);
  return Response.json({ ok: true });
}
