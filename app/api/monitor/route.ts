import { getPolicy } from "@/lib/agent/policy";
import { createLiaraClient, type Project } from "@/lib/liara";
import { apiUser } from "@/lib/server/auth";
import { hasWebhook, INTERVALS, listIncidents, listMonitors, listRoutines, notify, openIncidentCount, recentChecks, setWebhook, upsertMonitor, uptime } from "@/lib/server/monitor";

/** Everything the Monitoring page shows; ?summary=1 is the cheap badge count the workbench polls. */
export async function GET(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  if (new URL(req.url).searchParams.get("summary")) {
    // Cheap enough to poll: open incidents (for banners and the badge) and the last health of every watched app.
    const open = listIncidents(userId, { limit: 20 }).filter((i) => i.status === "open");
    return Response.json({
      open: openIncidentCount(userId),
      incidents: open.map(({ id, app, title, severity, causes, openedAt, escalated }) => ({ id, app, title, severity, causes: causes.slice(0, 3), openedAt, escalated })),
      health: Object.fromEntries(listMonitors(userId).filter((m) => m.enabled && m.lastStatus).map((m) => [m.app, m.lastStatus])),
    });
  }

  const monitors = listMonitors(userId);
  let apps: { name: string; platform: string; on: boolean }[] = [];
  let appsError: string | null = null;
  try {
    const { projects } = await createLiaraClient(auth.creds).get<{ projects: Project[] }>("/v1/projects");
    apps = projects.map((p) => ({ name: p.project_id, platform: p.type, on: p.scale > 0 }));
  } catch (e) {
    appsError = e instanceof Error ? e.message : String(e);
  }
  const names = [...new Set([...apps.map((a) => a.name), ...monitors.map((m) => m.app)])];
  const policy = getPolicy(userId);
  return Response.json({
    rows: names.map((name) => ({
      app: apps.find((a) => a.name === name) ?? { name, platform: "", on: false, missing: !appsError },
      monitor: monitors.find((m) => m.app === name) ?? null,
      checks: recentChecks(userId, name, 30),
      uptime24h: uptime(userId, name),
    })),
    appsError,
    incidents: listIncidents(userId, { limit: 30 }),
    routines: listRoutines(userId),
    webhook: hasWebhook(userId),
    policy: { autoHeal: policy.autoHeal, maxAutoHealsPerAppHour: policy.maxAutoHealsPerAppHour, allowRoutines: policy.allowRoutines, readOnly: policy.readOnly },
    intervals: INTERVALS,
  });
}

/** Turn monitoring on/off for an app, or change its interval, health path or auto-heal flag. */
export async function POST(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const b = (await req.json().catch(() => ({}))) as { app?: string; enabled?: boolean; intervalMin?: number; path?: string; autoHeal?: boolean };
  try {
    return Response.json({ monitor: upsertMonitor(auth.user.id, String(b.app ?? ""), { enabled: b.enabled, intervalMin: b.intervalMin, path: b.path, autoHeal: b.autoHeal }) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

/** Alert webhook: { webhook: "https://…" | null } sets it (stored encrypted); { test: true } sends a test alert. */
export async function PATCH(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const b = (await req.json().catch(() => ({}))) as { webhook?: string | null; test?: boolean };
  try {
    if (b.test) {
      const ok = await notify(auth.user.id, { event: "test", app: "-", status: "test", text: "✅ Yara alert test: this webhook will receive incident alerts." });
      return ok ? Response.json({ ok }) : Response.json({ error: "وب‌هوک پاسخ موفق نداد یا تنظیم نشده است." }, { status: 400 });
    }
    setWebhook(auth.user.id, b.webhook ? String(b.webhook).trim() : null);
    return Response.json({ webhook: hasWebhook(auth.user.id) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
