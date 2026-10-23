import { createLiaraClient } from "@/lib/liara";
import { apiUser } from "@/lib/server/auth";
import { createRoutine, deleteRoutine, listRoutines, runRoutine, setRoutineEnabled, type RoutineKind } from "@/lib/server/monitor";

const fail = (e: unknown) => Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });

/** Create a routine. Creating it here is the user's standing authorisation; each run is still policy-checked and audited. */
export async function POST(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const b = (await req.json().catch(() => ({}))) as { kind?: RoutineKind; target?: Record<string, string>; hour?: number; weekday?: number | null };
  try {
    return Response.json({ routine: createRoutine(auth.user.id, { kind: b.kind as RoutineKind, target: b.target ?? {}, hour: Number(b.hour), weekday: b.weekday ?? null }) });
  } catch (e) {
    return fail(e);
  }
}

/** { id, enabled } pauses or resumes; { id, run: true } runs it now. */
export async function PATCH(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const b = (await req.json().catch(() => ({}))) as { id?: string; enabled?: boolean; run?: boolean };
  try {
    const r = listRoutines(auth.user.id).find((x) => x.id === b.id);
    if (!r) throw new Error("Routine not found.");
    if (b.run) return Response.json(await runRoutine(auth.user.id, createLiaraClient(auth.creds), r, true));
    setRoutineEnabled(auth.user.id, r.id, !!b.enabled);
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  deleteRoutine(auth.user.id, new URL(req.url).searchParams.get("id") ?? "");
  return Response.json({ ok: true });
}
