import "server-only";
import { promises as dns } from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { enc, type LiaraClient } from "../liara";
import { vmSshTarget } from "../vms";

// Guided domain setup. Liara's API can attach a domain to an app, host its DNS zone and issue SSL,
// but the registrar step (IRNIC for .ir, or whoever sold the domain) is outside any API. This module
// works out where the user is: what Liara reports, what public DNS actually answers right now, and
// the exact records still to enter at the registrar.

export type StepState = "done" | "todo" | "waiting" | "blocked";
export type GuideStep = { id: string; title: string; state: StepState; detail: string; by: "yara" | "user" };
export type DnsRecord = { where: string; type: "CNAME" | "NS" | "A" | "ALIAS"; name: string; value: string };

export type DomainGuide = {
  domain: string;
  app: string | null;
  apex: boolean;
  registrable: string;
  registrar: { name: string; panel: string | null; howTo: string[] };
  liara: { found: boolean; id?: string; status?: string; ssl?: string; target?: string | null; dnsZone?: { found: boolean; nameservers: string[]; fromApi: boolean } };
  live: { cname: string[]; a: string[]; ns: string[]; error?: string };
  steps: GuideStep[];
  records: DnsRecord[];
  next: string;
  ready: boolean;
};

// Second-level suffixes under .ir; everything else is treated as name.tld.
const IR_SLD = new Set(["co.ir", "ac.ir", "org.ir", "gov.ir", "id.ir", "net.ir", "sch.ir"]);
// Liara DNS name servers. Used only when the zone API does not return them; shown with that caveat.
const LIARA_NS_FALLBACK = ["ns1.liara.ir", "ns2.liara.ir"];

export function normalizeDomain(raw: string) {
  const d = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) throw new Error("Not a valid domain name.");
  return d;
}

export function registrableOf(domain: string) {
  const parts = domain.split(".");
  const last2 = parts.slice(-2).join(".");
  return IR_SLD.has(last2) && parts.length >= 3 ? parts.slice(-3).join(".") : last2;
}

function registrarFor(registrable: string): DomainGuide["registrar"] {
  if (registrable.endsWith(".ir"))
    return {
      name: "ایرنیک (IRNIC)",
      panel: "https://www.nic.ir",
      howTo: [
        "با شناسه‌ی ایرنیک (nic-handle) خود وارد nic.ir شوید.",
        "از فهرست «دامنه‌های من» دامنه را باز کنید و «تغییر سرورهای نام (DNS)» را بزنید.",
        "سرورهای نام فعلی را با مقادیر زیر جایگزین و ذخیره کنید.",
        "ایرنیک تغییر را معمولاً ظرف چند ساعت (گاهی تا ۴۸ ساعت) اعمال می‌کند؛ یارا می‌تواند وضعیت را دوباره بسنجد.",
      ],
    };
  return {
    name: "فروشنده‌ی دامنه (registrar)",
    panel: null,
    howTo: ["وارد پنل جایی شوید که دامنه را از آن خریده‌اید.", "بخش DNS یا Nameservers را باز کنید.", "مقادیر زیر را وارد و ذخیره کنید.", "اعمال تغییر DNS معمولاً از چند دقیقه تا چند ساعت طول می‌کشد."],
  };
}

const withTimeout = <T>(p: Promise<T>, ms = 4000) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), ms))]);
const quiet = async <T>(p: Promise<T[]>): Promise<T[]> => withTimeout(p).catch(() => [] as T[]);

/** What public DNS answers right now (a fresh lookup on Yara's server, not a cached guess). */
async function liveDns(domain: string, registrable: string) {
  try {
    const [cname, a, ns] = await Promise.all([quiet(dns.resolveCname(domain)), quiet(dns.resolve4(domain)), quiet(dns.resolveNs(registrable))]);
    return { cname: cname.map((x) => x.toLowerCase()), a, ns: ns.map((x) => x.toLowerCase()) };
  } catch (e) {
    return { cname: [] as string[], a: [] as string[], ns: [] as string[], error: e instanceof Error ? e.message : String(e) };
  }
}

type RawDomain = { _id: string; name: string; status?: string; certificatesStatus?: string; CNameRecord?: string; project?: { project_id?: string } };
const connected = (s?: string) => /ok|connect|active|verified|ready/i.test(s ?? "");
const sslOk = (s?: string) => /ok|active|issued|ready|valid/i.test(s ?? "");

const tcpOpen = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port, timeout: 4000 });
    const done = (v: boolean) => (s.destroy(), resolve(v));
    s.on("connect", () => done(true));
    s.on("timeout", () => done(false));
    s.on("error", () => done(false));
  });

/** TLS handshake against the VM's own address with the domain as SNI: is a valid certificate for this name being served? */
const certFor = (host: string, servername: string) =>
  new Promise<{ ok: boolean; issuer?: string; daysLeft?: number; error?: string }>((resolve) => {
    const s = tls.connect({ host, port: 443, servername, timeout: 5000, rejectUnauthorized: false });
    const done = (v: { ok: boolean; issuer?: string; daysLeft?: number; error?: string }) => (s.destroy(), resolve(v));
    s.on("secureConnect", () => {
      const c = s.getPeerCertificate();
      const days = c.valid_to ? Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86_400_000) : undefined;
      done({ ok: s.authorized, issuer: c.issuer?.O ?? c.issuer?.CN, daysLeft: days, error: s.authorized ? undefined : String(s.authorizationError) });
    });
    s.on("timeout", () => done({ ok: false, error: "timeout" }));
    s.on("error", (e) => done({ ok: false, error: (e as NodeJS.ErrnoException).code ?? e.message }));
  });

/**
 * A domain on a virtual machine: Liara's app-domain API does not apply. The domain points at the VM's
 * public IP with an A record at the registrar, a web server answers on port 80, and certbot on the VM
 * issues the certificate (runVmCommand).
 */
async function vmDomainGuide(c: LiaraClient, domain: string, vmRef: string, registrable: string, apex: boolean): Promise<DomainGuide> {
  const registrar = registrarFor(registrable);
  const vm = await vmSshTarget(c, vmRef);
  const live = await liveDns(domain, registrable);
  const ip = vm.host;
  const pointed = !!ip && live.a.includes(ip);
  const [http, cert] = ip ? await Promise.all([tcpOpen(ip, 80), certFor(ip, domain)]) : [false, { ok: false, error: "no ip" }];
  const steps: GuideStep[] = [
    {
      id: "dns-a",
      title: `رکورد A در ${registrar.name}`,
      by: "user",
      state: pointed ? "done" : ip ? "todo" : "blocked",
      detail: pointed ? `دامنه به آدرس ماشین (${ip}) اشاره می‌کند.` : `${live.a.length ? `الان به ${live.a.join("، ")} اشاره می‌کند` : "رکورد A پیدا نشد"}؛ باید به آدرس ماشین ${ip ?? "?"} اشاره کند.`,
    },
    {
      id: "web",
      title: "وب‌سرور روی ماشین (پورت ۸۰)",
      by: "yara",
      state: http ? "done" : pointed ? "todo" : "blocked",
      detail: http ? "ماشین روی پورت ۸۰ پاسخ می‌دهد." : "certbot برای گرفتن گواهی به وب‌سرور روی پورت ۸۰ نیاز دارد. یارا با تأیید شما nginx را بررسی یا نصب می‌کند (runVmCommand).",
    },
    {
      id: "ssl",
      title: "گواهی SSL با certbot روی ماشین",
      by: "yara",
      state: cert.ok ? "done" : http && pointed ? "todo" : "blocked",
      detail: cert.ok ? `گواهی معتبر از ${cert.issuer ?? "?"} سرو می‌شود (${cert.daysLeft ?? "?"} روز مانده).` : "یارا با تأیید شما certbot را روی ماشین اجرا می‌کند و بعد گواهی را با یک اتصال TLS واقعی بررسی می‌کند.",
    },
  ];
  const first = steps.find((s) => s.state !== "done");
  return {
    domain,
    app: null,
    apex,
    registrable,
    registrar,
    liara: { found: false, target: ip },
    live,
    steps,
    records: ip ? [{ where: registrar.name, type: "A", name: apex ? "@" : domain.slice(0, -(registrable.length + 1)), value: ip }] : [],
    ready: !first,
    next: !first
      ? "Everything is done: the VM serves a valid certificate for this domain."
      : first.by === "user"
        ? "Next step is the user's: the A record at the registrar (no API). The card shows the exact record; ask them to press «بررسی دوباره» when done."
        : first.id === "web"
          ? "Next: runVmCommand to check the web server (systemctl status nginx; ss -tlnp), install nginx if missing (apt-get install -y nginx, approval), then domainGuide again."
          : "Next: runVmCommand apt-get install -y certbot python3-certbot-nginx, then certbot --nginx -d <domain> --non-interactive --agree-tos -m <email> --redirect (ask for the email), then domainGuide again to verify.",
  };
}

export async function domainGuide(c: LiaraClient, rawDomain: string, opts: { app?: string; vm?: string; recheck?: boolean } = {}): Promise<DomainGuide> {
  const domain = normalizeDomain(rawDomain);
  if (opts.vm) return vmDomainGuide(c, domain, opts.vm, registrableOf(domain), domain === registrableOf(domain));
  const registrable = registrableOf(domain);
  const apex = domain === registrable;
  const registrar = registrarFor(registrable);

  const [domains, zones, live] = await Promise.all([
    c.get<{ domains: RawDomain[] }>("/v1/domains").then((r) => r.domains ?? []).catch(() => [] as RawDomain[]),
    c.dns.get<any>("/api/v1/zones").catch(() => null),
    liveDns(domain, registrable),
  ]);
  let d = domains.find((x) => x.name?.toLowerCase() === domain);
  // Ask Liara to re-verify before reporting, when the user says they changed DNS.
  if (d && opts.recheck) {
    await c.get(`/v1/domains/${enc(d._id)}/check`).catch(() => null);
    d = (await c.get<{ domains: RawDomain[] }>("/v1/domains").then((r) => r.domains ?? []).catch(() => domains)).find((x) => x.name?.toLowerCase() === domain) ?? d;
  }

  const zoneList: any[] = Array.isArray(zones) ? zones : (zones?.data ?? zones?.zones ?? []);
  const zone = zoneList.find((z) => String(z.name ?? z.domain ?? "").toLowerCase() === registrable);
  const zoneNs: string[] = (zone?.nameServers ?? zone?.nameservers ?? zone?.ns ?? []).map((x: unknown) => String(x).toLowerCase().replace(/\.$/, ""));
  const nameservers = zoneNs.length ? zoneNs : LIARA_NS_FALLBACK;
  const target = d?.CNameRecord ? String(d.CNameRecord).toLowerCase().replace(/\.$/, "") : null;
  const app = d?.project?.project_id ?? opts.app ?? null;

  const nsOnLiara = live.ns.some((n) => nameservers.some((l) => n.replace(/\.$/, "") === l));
  const cnameOk = !!target && live.cname.some((x) => x.replace(/\.$/, "") === target);
  const dnsPointed = apex ? nsOnLiara : cnameOk || nsOnLiara;
  const isConnected = connected(d?.status);

  const steps: GuideStep[] = [
    {
      id: "attach",
      title: "اتصال دامنه به برنامه در لیارا",
      by: "yara",
      state: d ? "done" : "todo",
      detail: d ? `دامنه به برنامه‌ی ${app ?? "?"} وصل است.` : `یارا با تأیید شما دامنه را به برنامه${app ? `‌ی ${app}` : ""} وصل می‌کند (addDomain).`,
    },
  ];
  if (apex)
    steps.push({
      id: "zone",
      title: "ساخت زون DNS در لیارا",
      by: "user",
      state: zone ? "done" : "todo",
      detail: zone ? "زون DNS این دامنه در لیارا ساخته شده است." : "دامنه‌ی اصلی (بدون www) با DNS لیارا به برنامه وصل می‌شود. زون را در کنسول لیارا، بخش DNS، بسازید (یارا هنوز ابزار ساخت زون ندارد).",
    });
  steps.push({
    id: "registrar",
    title: apex ? `تغییر سرورهای نام در ${registrar.name}` : `افزودن رکورد CNAME در ${registrar.name}`,
    by: "user",
    state: dnsPointed ? "done" : d ? "todo" : "blocked",
    detail: dnsPointed
      ? apex
        ? "سرورهای نام دامنه الان به لیارا اشاره می‌کنند."
        : "رکورد CNAME الان به لیارا اشاره می‌کند."
      : apex
        ? `${live.ns.length ? `سرورهای نام فعلی ${live.ns.join("، ")} است` : "سرور نامی برای دامنه پیدا نشد"}؛ باید به سرورهای لیارا تغییر کند. این کار فقط از پنل ${registrar.name} ممکن است.`
        : `الان ${live.cname.length ? `CNAME به ${live.cname[0]}` : "رکورد CNAME پیدا نشد"}؛ باید به ${target ?? "آدرس لیارا"} اشاره کند.`,
  });
  steps.push({
    id: "verify",
    title: "تأیید اتصال توسط لیارا",
    by: "yara",
    state: isConnected ? "done" : dnsPointed ? "waiting" : "blocked",
    detail: isConnected ? "لیارا اتصال دامنه را تأیید کرده است." : dnsPointed ? "DNS درست است؛ لیارا ممکن است چند دقیقه طول بکشد تا تأیید کند. یارا دوباره می‌سنجد." : "بعد از تنظیم DNS انجام می‌شود.",
  });
  steps.push({
    id: "ssl",
    title: "گواهی SSL رایگان",
    by: "yara",
    state: sslOk(d?.certificatesStatus) ? "done" : isConnected ? "todo" : "blocked",
    detail: sslOk(d?.certificatesStatus) ? "سایت روی https در دسترس است." : isConnected ? "یارا با تأیید شما گواهی را صادر می‌کند (enableDomainSsl)." : "بعد از تأیید اتصال دامنه.",
  });

  const records: DnsRecord[] = apex
    ? nameservers.map((ns) => ({ where: registrar.name, type: "NS" as const, name: registrable, value: ns }))
    : target
      ? [{ where: `${registrar.name} یا زون DNS لیارا`, type: "CNAME", name: domain.slice(0, -(registrable.length + 1)) || "@", value: target }]
      : [];

  const firstOpen = steps.find((s) => s.state !== "done");
  return {
    domain,
    app,
    apex,
    registrable,
    registrar,
    liara: { found: !!d, id: d?._id, status: d?.status, ssl: d?.certificatesStatus, target, dnsZone: { found: !!zone, nameservers, fromApi: zoneNs.length > 0 } },
    live,
    steps,
    records,
    ready: !firstOpen,
    next: !firstOpen
      ? "Everything is done: tell the user the site is live on https and offer monitoring."
      : firstOpen.by === "yara"
        ? `Next step is yours: ${firstOpen.id === "attach" ? "addDomain" : firstOpen.id === "ssl" ? "enableDomainSsl" : "call domainGuide again with recheck: true in a few minutes"}. The card already shows the user the full checklist; keep your text short.`
        : "Next step is the user's, at the registrar (outside any API). The card shows the exact records and how-to; tell them to press «بررسی دوباره» on the card when done. Do not repeat the records in text.",
  };
}
