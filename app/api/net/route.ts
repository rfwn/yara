import { apiUser } from "@/lib/server/auth";
import { auditNet } from "@/lib/server/audit";
import { NET_HELP, runNetCommand, takeNetQuota } from "@/lib/server/nettools";

/** The Network panel's command line: dig, http, tls, port, whois. No shell exists behind it. */
export async function POST(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const { command } = (await req.json().catch(() => ({}))) as { command?: string };
  const line = String(command ?? "").slice(0, 300);
  if (!line.trim()) return Response.json({ command: "help", ok: true, output: NET_HELP });
  if (!takeNetQuota(auth.user.id)) return Response.json({ error: "Rate limit: at most 30 network checks per minute." }, { status: 429 });
  try {
    const r = await runNetCommand(line);
    auditNet(auth.user.id, null, "user", r);
    return Response.json(r);
  } catch (e) {
    return Response.json({ command: line, ok: false, output: e instanceof Error ? e.message : String(e) });
  }
}
