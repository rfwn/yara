import "server-only";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

// Network diagnostics that run on Yara's server: dig, http, tls, port, whois.
// Sandboxed by construction rather than by a jail:
// - No shell, no binaries: every tool is implemented with Node's own dns/net/tls/http modules,
//   so there is no command line to inject into and nothing else can be run.
// - Targets must resolve to public addresses only (no loopback, private, link-local, metadata or
//   multicast ranges), checked after DNS resolution and pinned for the connection, so a hostname
//   cannot be used to reach Yara's own network (SSRF / DNS rebinding).
// - Hard timeouts, response size caps, no redirects followed blindly, and a per-user rate limit.

export type NetResult = { command: string; ok: boolean; output: string; data?: unknown };

const TIMEOUT = 8000;
const MAX_BYTES = 16_000;
const RESOLVERS: Record<string, string[]> = { cloudflare: ["1.1.1.1", "1.0.0.1"], google: ["8.8.8.8", "8.8.4.4"], quad9: ["9.9.9.9"] };
const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA"] as const;

// ---------- guards ----------

const v4 = (ip: string) => ip.split(".").map(Number);
/** True only for addresses that are routable on the public internet. */
export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = v4(ip);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && v4(ip)[2] === 0) || (b === 0 && v4(ip)[2] === 2))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && v4(ip)[2] === 100))) return false;
    if (a === 203 && b === 0 && v4(ip)[2] === 113) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return false;
    if (x.startsWith("::ffff:")) return isPublicIp(x.slice(7));
    if (/^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x)) return false; // unique-local, link-local, multicast
    if (x.startsWith("2001:db8")) return false;
    return true;
  }
  return false;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
function checkHost(h: string) {
  const host = h.trim().toLowerCase().replace(/\.$/, "");
  if (!HOST_RE.test(host) && !net.isIP(host)) throw new Error(`Not a valid host name: ${h}`);
  return host;
}

/** Resolves a host and refuses unless every address is public. Returns the address to pin the connection to. */
async function publicAddress(host: string) {
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new Error(`${host} is a private or reserved address; Yara only probes public internet hosts.`);
    return { address: host, family: net.isIP(host) };
  }
  const addrs = await withTimeout(dns.promises.lookup(host, { all: true }), TIMEOUT);
  if (!addrs.length) throw new Error(`${host} does not resolve.`);
  const bad = addrs.find((a) => !isPublicIp(a.address));
  if (bad) throw new Error(`${host} resolves to ${bad.address}, a private or reserved address; refused.`);
  return addrs[0];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms))]);
}

// Per-user rate limit (in memory, like the app's other limits).
const usage = new Map<string, number[]>();
export function takeNetQuota(userId: string, perMinute = 30) {
  const now = Date.now();
  const recent = (usage.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= perMinute) return false;
  recent.push(now);
  usage.set(userId, recent);
  return true;
}

// ---------- tools ----------

async function dig(name: string, type = "A", via = "cloudflare"): Promise<NetResult> {
  const host = checkHost(name);
  const t = type.toUpperCase() as (typeof RECORD_TYPES)[number];
  if (!RECORD_TYPES.includes(t)) throw new Error(`Record type must be one of ${RECORD_TYPES.join(", ")}.`);
  const servers = RESOLVERS[via.replace(/^@/, "")] ?? (Object.values(RESOLVERS).flat().includes(via.replace(/^@/, "")) ? [via.replace(/^@/, "")] : null);
  if (!servers) throw new Error(`Resolver must be one of ${Object.keys(RESOLVERS).join(", ")} (or their IPs).`);
  const r = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
  r.setServers(servers);
  const started = Date.now();
  let answer: unknown;
  try {
    answer = await withTimeout(r.resolve(host, t as never), TIMEOUT);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { command: `dig ${host} ${t}`, ok: code === "ENODATA" || code === "ENOTFOUND", output: `;; ${host} ${t} via ${servers[0]}: ${code === "ENODATA" ? "no records of this type" : code === "ENOTFOUND" ? "NXDOMAIN (name does not exist)" : (e as Error).message}`, data: { host, type: t, error: code ?? String(e) } };
  }
  const rows = (Array.isArray(answer) ? answer : [answer]).map((x) => (typeof x === "string" ? x : Array.isArray(x) ? x.join("") : JSON.stringify(x)));
  return {
    command: `dig ${host} ${t}`,
    ok: true,
    output: [`;; ${host} ${t} @${servers[0]} (${Date.now() - started} ms)`, ...rows.map((v) => `${host}.\t${t}\t${v}`)].join("\n"),
    data: { host, type: t, resolver: servers[0], answers: rows },
  };
}

async function httpCheck(rawUrl: string, method = "HEAD"): Promise<NetResult> {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    throw new Error("Not a valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https URLs.");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed.");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (![80, 443, 8080, 8443].includes(port)) throw new Error("Only ports 80, 443, 8080 and 8443.");
  const host = checkHost(url.hostname);
  const t0 = Date.now();
  const addr = await publicAddress(host);
  const tDns = Date.now() - t0;
  const m = method.toUpperCase() === "GET" ? "GET" : "HEAD";
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    let tConnect = 0;
    let tTls = 0;
    const req = lib.request(
      {
        host,
        port,
        path: url.pathname + url.search,
        method: m,
        servername: host,
        headers: { "User-Agent": "Yara-NetTools/1.0", Accept: "*/*" },
        // Connect to the address we vetted, not a second (possibly different) DNS answer.
        lookup: (_h: string, o: { all?: boolean } | undefined, cb: (e: Error | null, a: unknown, f?: number) => void) =>
          o?.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family),
        timeout: TIMEOUT,
      } as https.RequestOptions,
      (res) => {
        const ttfb = Date.now() - t0;
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) res.destroy();
        });
        res.on("close", () => {
          const keep = ["server", "content-type", "content-length", "location", "cache-control", "strict-transport-security", "x-powered-by", "date"];
          const headers = Object.fromEntries(Object.entries(res.headers).filter(([k]) => keep.includes(k)));
          resolve({
            command: `http ${m} ${url.href}`,
            ok: (res.statusCode ?? 0) < 500,
            output: [
              `${m} ${url.href} → HTTP ${res.statusCode} ${res.statusMessage ?? ""}`.trim(),
              `address ${addr.address} · dns ${tDns} ms · connect ${tConnect} ms${tTls ? ` · tls ${tTls} ms` : ""} · first byte ${ttfb} ms`,
              ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
            ].join("\n"),
            data: { status: res.statusCode, address: addr.address, timings: { dns: tDns, connect: tConnect, tls: tTls, ttfb }, headers },
          });
        });
        if (m === "HEAD") res.resume();
      },
    );
    req.on("socket", (s) => {
      s.on("connect", () => (tConnect = Date.now() - t0));
      s.on("secureConnect", () => (tTls = Date.now() - t0));
    });
    req.on("timeout", () => req.destroy(new Error(`timed out after ${TIMEOUT / 1000}s`)));
    req.on("error", (e) => resolve({ command: `http ${m} ${url.href}`, ok: false, output: `${m} ${url.href} → failed: ${(e as NodeJS.ErrnoException).code ?? e.message}`, data: { error: e.message } }));
    req.end();
  });
}

async function tlsCheck(rawHost: string, rawPort = "443"): Promise<NetResult> {
  const host = checkHost(rawHost);
  const port = Number(rawPort);
  if (![443, 8443, 465, 993, 995, 587].includes(port)) throw new Error("TLS port must be 443, 8443, 465, 587, 993 or 995.");
  const addr = await publicAddress(host);
  return new Promise((resolve) => {
    const s = tls.connect({ host: addr.address, port, servername: host, rejectUnauthorized: false, timeout: TIMEOUT });
    const done = (r: NetResult) => {
      s.destroy();
      resolve(r);
    };
    s.on("secureConnect", () => {
      const c = s.getPeerCertificate();
      const days = c.valid_to ? Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86_400_000) : null;
      const sans = String(c.subjectaltname ?? "").replace(/DNS:/g, "").split(", ").filter(Boolean);
      const covers = sans.some((n) => n === host || (n.startsWith("*.") && host.endsWith(n.slice(1)) && host.split(".").length === n.split(".").length));
      done({
        command: `tls ${host}:${port}`,
        ok: s.authorized && covers && (days ?? 0) > 0,
        output: [
          `${host}:${port} · ${s.getProtocol()} · ${s.authorized ? "trusted" : `NOT trusted (${s.authorizationError})`}`,
          `subject  ${c.subject?.CN ?? "-"}`,
          `issuer   ${c.issuer?.O ?? c.issuer?.CN ?? "-"}`,
          `valid    ${c.valid_from} → ${c.valid_to}${days !== null ? ` (${days} days left)` : ""}`,
          `names    ${sans.slice(0, 10).join(", ")}${sans.length > 10 ? ` (+${sans.length - 10})` : ""}`,
          covers ? "the certificate covers this host name" : "WARNING: the certificate does NOT cover this host name",
        ].join("\n"),
        data: { protocol: s.getProtocol(), trusted: s.authorized, error: s.authorizationError, subject: c.subject?.CN, issuer: c.issuer?.O, validTo: c.valid_to, daysLeft: days, names: sans, coversHost: covers },
      });
    });
    s.on("timeout", () => done({ command: `tls ${host}:${port}`, ok: false, output: `${host}:${port} → timed out` }));
    s.on("error", (e) => done({ command: `tls ${host}:${port}`, ok: false, output: `${host}:${port} → ${(e as NodeJS.ErrnoException).code ?? e.message}` }));
  });
}

async function portCheck(rawHost: string, rawPort: string): Promise<NetResult> {
  const host = checkHost(rawHost);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1–65535.");
  const addr = await publicAddress(host);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const s = net.connect({ host: addr.address, port, timeout: 5000 });
    const done = (open: boolean, why: string) => {
      s.destroy();
      resolve({ command: `port ${host} ${port}`, ok: open, output: `${host} (${addr.address}) port ${port}: ${open ? `open (${Date.now() - t0} ms)` : why}`, data: { open, address: addr.address, ms: Date.now() - t0 } });
    };
    s.on("connect", () => done(true, ""));
    s.on("timeout", () => done(false, "no answer (filtered or host down)"));
    s.on("error", (e) => done(false, (e as NodeJS.ErrnoException).code === "ECONNREFUSED" ? "closed (connection refused)" : ((e as NodeJS.ErrnoException).code ?? e.message)));
  });
}

const WHOIS: Record<string, string> = { ir: "whois.nic.ir", com: "whois.verisign-grs.com", net: "whois.verisign-grs.com", org: "whois.pir.org", io: "whois.nic.io", dev: "whois.nic.google", app: "whois.nic.google" };
async function whois(rawDomain: string): Promise<NetResult> {
  const domain = checkHost(rawDomain);
  const tld = domain.split(".").pop()!;
  const server = WHOIS[tld];
  if (!server) throw new Error(`whois is available for .${Object.keys(WHOIS).join(", .")} domains.`);
  const text = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const s = net.connect({ host: server, port: 43, timeout: TIMEOUT }, () => s.write(`${domain}\r\n`));
    s.on("data", (c) => {
      buf += c.toString("utf8");
      if (buf.length > MAX_BYTES) s.destroy();
    });
    s.on("close", () => resolve(buf));
    s.on("timeout", () => s.destroy(new Error("timed out")));
    s.on("error", reject);
  });
  // Contact details are personal data the diagnosis does not need: keep registration facts only.
  const keep = /^(domain|domain name|expire|expires|expiry|registry expiry|registrar|nserver|name server|status|created|creation date|last-updated|updated date|holder-c|source)\b/i;
  const lines = text.split(/\r?\n/).filter((l) => keep.test(l.trim()));
  return { command: `whois ${domain}`, ok: lines.length > 0, output: lines.length ? lines.join("\n") : `No whois record found at ${server}.`, data: { server, lines } };
}

// ---------- command line ----------

export const NET_HELP = `Commands (run on Yara's server, public hosts only):
  dig <name> [A|AAAA|CNAME|MX|NS|TXT|SOA|CAA] [@cloudflare|@google|@quad9]
  http <url> [GET]        status, timings, key headers (no redirects followed)
  tls <host> [port]       certificate issuer, expiry, names covered
  port <host> <port>      is a TCP port open
  whois <domain>          registrar, expiry, name servers (.ir .com .net .org .io .dev .app)`;

/** Parses one command line into a tool call. Only these verbs exist; there is no shell behind them. */
export async function runNetCommand(line: string): Promise<NetResult> {
  const parts = line.trim().split(/\s+/).filter(Boolean).slice(0, 4);
  const [verb, a, b, c] = parts;
  if (parts.length && parts.join(" ").length > 300) throw new Error("Command too long.");
  switch ((verb ?? "").toLowerCase()) {
    case "dig":
    case "nslookup":
      if (!a) throw new Error("usage: dig <name> [type] [@resolver]");
      return dig(a, b && !b.startsWith("@") ? b : "A", (b?.startsWith("@") ? b : c) ?? "cloudflare");
    case "http":
    case "curl":
      if (!a) throw new Error("usage: http <url> [GET]");
      return httpCheck(a, b);
    case "tls":
    case "ssl":
      if (!a) throw new Error("usage: tls <host> [port]");
      return tlsCheck(a, b);
    case "port":
    case "nc":
      if (!a || !b) throw new Error("usage: port <host> <port>");
      return portCheck(a, b);
    case "whois":
      if (!a) throw new Error("usage: whois <domain>");
      return whois(a);
    case "help":
    case "":
      return { command: "help", ok: true, output: NET_HELP };
    default:
      throw new Error(`Unknown command "${verb}". Only dig, http, tls, port and whois exist here; there is no shell.`);
  }
}
