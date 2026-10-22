import { ZodError } from "zod";
import { runAction } from "@/lib/actions";
import { createLiaraClient, LiaraError } from "@/lib/liara";
import { apiUser } from "@/lib/server/auth";

// Runs an infrastructure action the user approved in the UI, with their own Liara token.
export async function POST(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const { name, input }: { name: string; input: unknown } = await req.json();
  try {
    const result = await runAction(createLiaraClient(auth.creds), name, input);
    return Response.json({ ok: true, result });
  } catch (e) {
    const error = e instanceof ZodError ? `Invalid input: ${e.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` : e instanceof Error ? e.message : String(e);
    const status = e instanceof LiaraError ? e.status : e instanceof ZodError ? 400 : 500;
    return Response.json({ ok: false, error }, { status });
  }
}
