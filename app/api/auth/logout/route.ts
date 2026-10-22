import { endSession } from "@/lib/server/auth";

export async function POST() {
  await endSession();
  return Response.json({ ok: true });
}
