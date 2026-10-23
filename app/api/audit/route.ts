import { apiUser } from "@/lib/server/auth";
import { listAudit } from "@/lib/server/audit";

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The user's audit log; ?format=csv|json downloads it, ?thread= narrows to one conversation. */
export async function GET(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const entries = listAudit(auth.user.id, { limit: Math.min(Number(url.searchParams.get("limit")) || 200, 1000), threadId: url.searchParams.get("thread") ?? undefined });
  const format = url.searchParams.get("format");
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "json")
    return new Response(JSON.stringify(entries, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="yara-audit-${stamp}.json"` } });
  if (format === "csv") {
    const cols = ["id", "createdAt", "finishedAt", "threadId", "agent", "tool", "title", "target", "risk", "decision", "reason", "status", "verified", "rolledBackBy", "args", "result"] as const;
    const rows = entries.map((e) => cols.map((c) => csvCell(c === "createdAt" || c === "finishedAt" ? (e[c] ? new Date(e[c] as number).toISOString() : "") : e[c])).join(","));
    return new Response([cols.join(","), ...rows].join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="yara-audit-${stamp}.csv"` } });
  }
  return Response.json({ entries });
}
