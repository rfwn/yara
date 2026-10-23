import { createLiaraClient, LiaraError } from "@/lib/liara";
import { apiUser } from "@/lib/server/auth";
import { randomToken } from "@/lib/server/crypto";
import { db } from "@/lib/server/db";
import { vmSshTarget } from "@/lib/vms";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Mints a single-use, 30-second ticket for an SSH session to one of the user's own VMs.
 * The host and port come from Liara here; the browser only ever holds the ticket, so it cannot
 * point the proxy anywhere else. Credentials are sent later over the socket and never stored.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  if (!auth.creds.token) return Response.json({ error: "ابتدا کلید API لیارا را وصل کنید." }, { status: 400 });
  try {
    const t = await vmSshTarget(createLiaraClient(auth.creds), decodeURIComponent((await params).id));
    if (!t.on) return Response.json({ error: "ماشین خاموش است؛ اول روشنش کنید." }, { status: 409 });
    if (!t.host) return Response.json({ error: "این ماشین آدرس IPv4 عمومی ندارد." }, { status: 409 });
    const ticket = randomToken(24);
    db().prepare("DELETE FROM ssh_tickets WHERE expires_at < ?").run(Date.now());
    db().prepare("INSERT INTO ssh_tickets (id, user_id, vm_id, vm_name, host, port, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(ticket, auth.user.id, t.id, t.name, t.host, t.port, Date.now() + 30_000);
    const known = db().prepare("SELECT fingerprint FROM vm_host_keys WHERE user_id = ? AND vm_id = ?").get(auth.user.id, t.id) as { fingerprint: string } | undefined;
    return Response.json({ ticket, host: t.host, port: t.port, liaraPassword: t.liaraPassword, knownFingerprint: known?.fingerprint ?? null });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof LiaraError ? e.status : 500 });
  }
}

/** Forget the stored host key (after the user rebuilt the VM and checked the new fingerprint). */
export async function DELETE(_req: Request, { params }: Ctx) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  try {
    const t = await vmSshTarget(createLiaraClient(auth.creds), decodeURIComponent((await params).id));
    db().prepare("DELETE FROM vm_host_keys WHERE user_id = ? AND vm_id = ?").run(auth.user.id, t.id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof LiaraError ? e.status : 500 });
  }
}
