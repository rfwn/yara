import { apiUser, rotateRunnerToken } from "@/lib/server/auth";

// Issues a fresh pairing token for the local runner (shown once; the old one stops working).
export async function POST() {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  return Response.json({ token: rotateRunnerToken(auth.user.id) });
}
