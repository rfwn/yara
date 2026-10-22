import { createLiaraClient, enc, LiaraError } from "@/lib/liara";
import { apiUser } from "@/lib/server/auth";

export const maxDuration = 300;

// Uploads a .tar.gz of the user's project to Liara and returns its sourceID.
// The release itself is created by the deployRelease action after approval.
export async function POST(req: Request) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const form = await req.formData();
  const app = String(form.get("app") ?? "");
  const file = form.get("file");
  if (!app || !(file instanceof File)) {
    return Response.json({ error: "یک برنامه و یک فایل .tar.gz انتخاب کنید." }, { status: 400 });
  }
  if (!/\.(tar\.gz|tgz|gz)$/i.test(file.name)) {
    return Response.json({ error: "فقط فایل فشرده‌ی .tar.gz یا .tgz پذیرفته می‌شود." }, { status: 400 });
  }

  try {
    const upstream = new FormData();
    upstream.set("file", file, file.name);
    const { sourceID } = await createLiaraClient(auth.creds).upload<{ sourceID: string }>(`/v2/projects/${enc(app)}/sources`, upstream);
    return Response.json({ sourceID, app, fileName: file.name, size: file.size });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof LiaraError ? e.status : 500 });
  }
}
