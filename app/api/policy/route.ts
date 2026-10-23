import { DEFAULT_POLICY, getPolicy, setPolicy, type Policy } from "@/lib/agent/policy";
import { PLATFORM_LIMITS } from "@/lib/limits";
import { apiUser } from "@/lib/server/auth";

export async function GET() {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  return Response.json({ policy: getPolicy(auth.user.id), defaults: DEFAULT_POLICY, limits: PLATFORM_LIMITS });
}

export async function PATCH(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const body = (await req.json().catch(() => ({}))) as Partial<Policy>;
  return Response.json({ policy: setPolicy(auth.user.id, body) });
}
