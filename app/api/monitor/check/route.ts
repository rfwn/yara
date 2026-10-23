import { createLiaraClient } from "@/lib/liara";
import { apiUser } from "@/lib/server/auth";
import { checkApp, getMonitor, verifyAppHealth } from "@/lib/server/monitor";

/** "Check now": one health check with the full diagnosis. May open an incident (and auto-heal, if the policy allows). */
export async function POST(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const { app, verify } = (await req.json().catch(() => ({}))) as { app?: string; verify?: boolean };
  if (!app) return Response.json({ error: "app is required" }, { status: 400 });
  try {
    // After a manual change (e.g. a restart from the app page): wait until it serves again, without opening incidents.
    if (verify) return Response.json({ verification: await verifyAppHealth(createLiaraClient(auth.creds), app, { path: getMonitor(auth.user.id, app)?.path, timeoutMs: 90_000 }) });
    const r = await checkApp(auth.user.id, createLiaraClient(auth.creds), app, { manual: true });
    return Response.json({ check: r.check, diagnosis: r.diagnosis, incident: r.incident, probe: r.evidence?.probe ?? null, gaps: r.evidence?.gaps ?? [] });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
