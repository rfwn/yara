// HTTP probe of an app's public URL: the one signal Liara's API does not give (what visitors actually see).
// Only the app's own URLs are probed (its *.liara.run subdomain or its connected domains), never arbitrary hosts.

export type Probe = { url: string; ok: boolean; status: number | null; ms: number; error?: string; at: number };

export async function probeUrl(url: string, timeoutMs = 10_000): Promise<Probe> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { "User-Agent": "Yara-Monitor/1.0 (+health check)" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain a little of the body so latency includes the first bytes, then drop the rest.
    await res.body?.cancel().catch(() => {});
    return { url, ok: res.status < 500, status: res.status, ms: Date.now() - started, at: started };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const error = err.name === "TimeoutError" ? `timeout after ${timeoutMs / 1000}s` : (err.cause?.code ?? err.message);
    return { url, ok: false, status: null, ms: Date.now() - started, error, at: started };
  }
}

/** Probes twice on failure so one dropped packet does not page anyone. */
export async function probeTwice(url: string, timeoutMs = 10_000) {
  const first = await probeUrl(url, timeoutMs);
  if (first.ok) return first;
  await new Promise((r) => setTimeout(r, 2000));
  return probeUrl(url, timeoutMs);
}

/** A path the user may append to the app URL (e.g. /health). No scheme, host, or protocol-relative tricks. */
export function safePath(p: unknown) {
  const s = typeof p === "string" ? p.trim() : "";
  if (!s) return "/";
  if (!s.startsWith("/") || s.startsWith("//") || s.length > 200 || /[\s\\@]/.test(s)) throw new Error("Health-check path must start with a single / and contain no spaces, backslashes or @.");
  return s;
}
