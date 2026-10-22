import { createLiaraClient, LiaraError, type Project } from "@/lib/liara";
import { apiUser } from "@/lib/server/auth";

// Lightweight app list for the sidebar.
export async function GET() {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  try {
    const { projects } = await createLiaraClient(auth.creds).get<{ projects: Project[] }>("/v1/projects");
    return Response.json({
      apps: projects.map((p) => ({ name: p.project_id, platform: p.type, status: p.status, on: p.scale > 0 })),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof LiaraError ? e.status : 500 });
  }
}
