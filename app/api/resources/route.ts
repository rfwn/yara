import { createLiaraClient, LiaraError } from "@/lib/liara";
import { apiUser } from "@/lib/server/auth";
import { resources } from "@/lib/server/views";

export async function GET() {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  try {
    return Response.json(await resources(createLiaraClient(auth.creds)));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof LiaraError ? e.status : 500 });
  }
}
