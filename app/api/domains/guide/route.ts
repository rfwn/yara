import { createLiaraClient } from "@/lib/liara";
import { apiUser } from "@/lib/server/auth";
import { domainGuide } from "@/lib/server/domains";

/** The domain checklist, recomputed live. ?recheck=1 first asks Liara to re-verify (the card's «بررسی دوباره»). */
export async function GET(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const q = new URL(req.url).searchParams;
  try {
    return Response.json(await domainGuide(createLiaraClient(auth.creds), q.get("domain") ?? "", { app: q.get("app") ?? undefined, vm: q.get("vm") ?? undefined, recheck: q.get("recheck") === "1" }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
