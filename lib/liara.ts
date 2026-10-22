// Thin client for the Liara REST APIs (https://developers.liara.ir).
// Every call is made with the caller's own API token, so the assistant can never
// do more than the user could do from the console.

// Overridable for staging or local testing against a mock.
const API_BASE = process.env.LIARA_API_BASE || "https://api.liara.ir";
const DNS_BASE = "https://dns-service.liara.ir";
const STORAGE_BASE = "https://storage-service.liara.ir";

export type LiaraCreds = { token: string; teamID?: string };

export class LiaraError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;
type RequestOpts = { base?: string; query?: Query; body?: unknown; form?: FormData };

export function createLiaraClient(creds: LiaraCreds) {
  async function request<T = unknown>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    if (!creds.token) {
      throw new LiaraError(401, "No Liara API token is connected. Connect one in Settings.");
    }
    const url = new URL(path, opts.base ?? API_BASE);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    if (creds.teamID) url.searchParams.set("teamID", creds.teamID);

    const headers: Record<string, string> = { Authorization: `Bearer ${creds.token}` };
    let body: BodyInit | undefined;
    if (opts.form) {
      body = opts.form;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, { method, headers, body, cache: "no-store" });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body; keep raw text
    }
    if (!res.ok) {
      const obj = data && typeof data === "object" ? (data as { message?: unknown; error?: unknown }) : {};
      const msg = String(obj.message ?? obj.error ?? text.slice(0, 300));
      throw new LiaraError(res.status, `Liara API ${res.status} on ${method} ${url.pathname}: ${msg || res.statusText}`);
    }
    return data as T;
  }

  return {
    creds,
    get: <T = unknown>(path: string, query?: Query) => request<T>("GET", path, { query }),
    post: <T = unknown>(path: string, body?: unknown) => request<T>("POST", path, { body }),
    patch: <T = unknown>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
    delete: <T = unknown>(path: string) => request<T>("DELETE", path),
    upload: <T = unknown>(path: string, form: FormData) => request<T>("POST", path, { form }),
    dns: {
      get: <T = unknown>(path: string) => request<T>("GET", path, { base: DNS_BASE }),
      post: <T = unknown>(path: string, body?: unknown) => request<T>("POST", path, { base: DNS_BASE, body }),
      put: <T = unknown>(path: string, body?: unknown) => request<T>("PUT", path, { base: DNS_BASE, body }),
      delete: <T = unknown>(path: string) => request<T>("DELETE", path, { base: DNS_BASE }),
    },
    storage: {
      get: <T = unknown>(path: string, query?: Query) => request<T>("GET", path, { base: STORAGE_BASE, query }),
      post: <T = unknown>(path: string, body?: unknown) => request<T>("POST", path, { base: STORAGE_BASE, body }),
      patch: <T = unknown>(path: string, body?: unknown) => request<T>("PATCH", path, { base: STORAGE_BASE, body }),
      delete: <T = unknown>(path: string, query?: Query) => request<T>("DELETE", path, { base: STORAGE_BASE, query }),
    },
  };
}

export type LiaraClient = ReturnType<typeof createLiaraClient>;

export const enc = encodeURIComponent;

/**
 * The storage API takes object keys/prefixes as a path segment, but how it wants "/"
 * encoded is undocumented (a "%2F" root prefix returns 500). Try the likely forms in
 * order and fall through on 400/404/500.
 */
export async function withKeyVariants<T>(key: string, fn: (segment: string) => Promise<T>): Promise<T> {
  const variants = key === "" || key === "/" ? ["", "%2F"] : [...new Set([enc(key), key.split("/").map(enc).join("/")])];
  const failures: string[] = [];
  let status = 500;
  for (const v of variants) {
    try {
      return await fn(v);
    } catch (e) {
      if (!(e instanceof LiaraError) || ![400, 404, 500].includes(e.status)) throw e;
      failures.push(e.message);
      status = e.status;
    }
  }
  throw new LiaraError(status, failures.length > 1 ? `All ${failures.length} attempts failed:\n- ${failures.join("\n- ")}` : failures[0]);
}
export const nowSec = () => Math.floor(Date.now() / 1000);

// ---- Response shapes (subset of the OpenAPI spec) ----

export type Env = { key: string; value: string; encrypted?: boolean };

export type Project = {
  _id: string;
  project_id: string;
  type: string;
  status: string;
  scale: number;
  planID: string;
  created_at: string;
  isDeployed: boolean;
  envs?: Env[];
  zeroDowntime?: boolean;
  defaultSubdomain?: boolean;
  readOnlyRootFilesystem?: boolean;
  fixedIPStatus?: string;
  hourlyPrice?: number;
  reservedDiskSpace?: number;
};

export type LogLine = { type: string; datetime: string; message: string };

export type Reports = { end?: number; result?: { applet?: string; values: [number | string, number | string][] }[] };

const SECRET_KEY = /secret|token|key|pass|pwd|private|credential|auth|dsn|_uri$|_url$|database_url|conn/i;

/** Hide values that look like secrets before they reach the model. */
export function maskEnvs(envs: Env[] = []) {
  return envs.map((e) => ({
    key: e.key,
    value: e.encrypted || SECRET_KEY.test(e.key) ? `•••• (${e.value?.length ?? 0} chars, hidden)` : e.value,
  }));
}

/** Collapse a time series into numbers a model can reason about. */
export function summarizeSeries(r: Reports) {
  return (r.result ?? []).map((s) => {
    const nums = s.values.map(([, v]) => Number(v)).filter((n) => Number.isFinite(n));
    if (!nums.length) return { applet: s.applet, points: 0 };
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return {
      applet: s.applet,
      points: nums.length,
      last: round(nums[nums.length - 1]),
      min: round(Math.min(...nums)),
      avg: round(avg),
      max: round(Math.max(...nums)),
      // ~24 evenly spaced samples so the UI can draw a sparkline
      samples: nums.filter((_, i) => i % Math.max(1, Math.floor(nums.length / 24)) === 0).map(round),
    };
  });
}
