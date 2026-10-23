import crypto from "node:crypto";
import { internalKey } from "@/lib/server/crypto";
import { runTick } from "@/lib/server/monitor";

/** Called by server.mjs every minute with an in-process key; refused without it. */
export async function POST(req: Request) {
  const given = Buffer.from(req.headers.get("x-yara-internal") ?? "");
  const want = Buffer.from(internalKey("monitor-tick"));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return Response.json({ error: "forbidden" }, { status: 403 });
  // A tick may take minutes (a heal waits for recovery): answer now and let it run.
  void runTick().catch((e) => console.error("[monitor] tick failed:", e));
  return Response.json({ accepted: true }, { status: 202 });
}
