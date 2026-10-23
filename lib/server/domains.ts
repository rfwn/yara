import "server-only";
import { promises as dns } from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { enc, type LiaraClient } from "../liara";
import { vmSshTarget } from "../vms";

// Guided domain setup. Two separate Liara services are involved: the app's domain (Liara gives the
// records it needs: a pointer, a TXT ownership code and an _acme-challenge CNAME for SSL) and, optionally,
// Liara DNS hosting the domain's zone. Where the zone lives decides the path: on Liara DNS, Yara creates
// the records itself; elsewhere, the user adds them in that DNS panel. Only the nameserver change at the
// registrar (IRNIC for .ir) is outside every API. This module works out which path applies, what Liara
// reports, and what public DNS answers right now, record by record.

export type StepState = "done" | "todo" | "waiting" | "blocked";
export type GuideStep = { id: string; title: string; state: StepState; detail: string; by: "yara" | "user" };
/** "route" points the name at Liara, "verify" proves ownership, "ssl" lets Liara answer the DNS-01 challenge. */
export type RecordPurpose = "route" | "verify" | "ssl" | "ns";
export type DnsRecord = {
  where: string;
  type: "CNAME" | "NS" | "A" | "ALIAS" | "TXT";
  /** Relative to the zone, as DNS panels (and Liara's) expect: "yara", "liara-challenge.yara", "@". */
  name: string;
  value: string;
  purpose?: RecordPurpose;
  /** What public DNS answers for it right now. */
  live?: "ok" | "missing" | "wrong";
  /** For a zone on Liara DNS: the record already exists there. */
  inZone?: boolean;
  note?: string;
};
/** Where the domain's DNS is hosted decides who adds the records, and where. */
export type DnsMode = "liara-active" | "liara-pending" | "external";

export type DomainGuide = {
  domain: string;
  app: string | null;
  apex: boolean;
  registrable: string;
  registrar: { name: string; panel: string | null; howTo: string[] };
  liara: { found: boolean; id?: string; status?: string; ssl?: string; target?: string | null; dnsZone?: { found: boolean; nameservers: string[]; fromApi: boolean } };
  dns?: { mode: DnsMode; zone: string; zoneStatus?: string; nameServers: string[]; currentNameServers: string[] };
  live: { cname: string[]; a: string[]; ns: string[]; error?: string };
  steps: GuideStep[];
  records: DnsRecord[];
  /** Records Yara can create itself (zone on Liara DNS), shaped for createDnsRecord. */
  zoneRecords?: { zone: string; name: string; type: "CNAME" | "ALIAS" | "TXT"; contents: Record<string, string>[] }[];
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

type RawZone = { name?: string; status?: string; nameServers?: string[]; currentNameServers?: string[] };
type RawRecord = { id: string; name: string; type: string; contents?: Record<string, unknown>[] };

const bare = (x: string) => x.toLowerCase().replace(/\.$/, "");
const resolveTxt = (name: string) =>
  withTimeout(dns.resolveTxt(name))
    .then((r) => r.map((parts) => parts.join("")))
    .catch(() => [] as string[]);
const resolveCname = (name: string) =>
  withTimeout(dns.resolveCname(name))
    .then((r) => r.map(bare))
    .catch(() => [] as string[]);
const resolveA = (name: string) => withTimeout(dns.resolve4(name)).catch(() => [] as string[]);

/**
 * The three records Liara's panel asks for when a domain is attached to an app, e.g. for yara.aenima.ir:
 *   ALIAS/ANAME/CNAME  yara                   damavand.liara.cloud
 *   TXT                liara-challenge.yara   <verificationCode>
 *   CNAME (no CDN)     _acme-challenge.yara   yara-aenima-ir._acme-challenge.liara.cloud
 * The API returns the target (CNameRecord) and the code (verificationCode, from /check); the ACME target
 * follows the panel's pattern: the domain with dots as dashes, under the target's parent domain.
 */
function appRecords(domain: string, registrable: string, apex: boolean, target: string, code: string | undefined, where: string): DnsRecord[] {
  const label = apex ? "" : domain.slice(0, -(registrable.length + 1));
  const under = (prefix: string) => (label ? `${prefix}.${label}` : prefix);
  const parent = target.split(".").slice(1).join(".") || "liara.cloud";
  const records: DnsRecord[] = [
    {
      where,
      type: apex ? "ALIAS" : "CNAME",
      name: label || "@",
      value: target,
      purpose: "route",
      note: apex ? "روی دامنه‌ی اصلی CNAME مجاز نیست؛ اگر DNS شما ALIAS ندارد، ANAME یا «CNAME flattening» همین کار را می‌کند." : undefined,
    },
  ];
  if (code) records.push({ where, type: "TXT", name: under("liara-challenge"), value: code, purpose: "verify" });
  records.push({
    where,
    type: "CNAME",
    name: under("_acme-challenge"),
    value: `${domain.replace(/\./g, "-")}._acme-challenge.${parent}`,
    purpose: "ssl",
    note: "پروکسی یا CDN را برای این رکورد خاموش کنید (No CDN)؛ وگرنه گواهی صادر یا تمدید نمی‌شود.",
  });
  return records;
}

/** Compare each record with what public DNS answers right now. */
async function checkLive(registrable: string, records: DnsRecord[]) {
  const fqdn = (name: string) => (name === "@" ? registrable : `${name}.${registrable}`);
  return Promise.all(
    records.map(async (r): Promise<DnsRecord> => {
      const name = fqdn(r.name);
      if (r.type === "TXT") {
        const txt = await resolveTxt(name);
        return { ...r, live: txt.includes(r.value) ? "ok" : txt.length ? "wrong" : "missing" };
      }
      const cname = await resolveCname(name);
      if (cname.includes(bare(r.value))) return { ...r, live: "ok" };
      // ALIAS/ANAME and CNAME flattening answer with A records: the target's own addresses count as pointed.
      if (r.purpose === "route") {
        const [mine, theirs] = await Promise.all([resolveA(name), resolveA(r.value)]);
        if (mine.length && mine.every((ip) => theirs.includes(ip))) return { ...r, live: "ok" };
        return { ...r, live: cname.length || mine.length ? "wrong" : "missing" };
      }
      return { ...r, live: cname.length ? "wrong" : "missing" };
    }),
  );
}

const recordInZone = (r: DnsRecord, existing: RawRecord[]) =>
  existing.some((z) => {
    if (bare(z.name) !== bare(r.name) || z.type.toUpperCase() !== r.type) return false;
    return (z.contents ?? []).some((c) => bare(String(c.host ?? c.text ?? c.ip ?? "")) === bare(r.value));
  });

const contentsFor = (r: DnsRecord): Record<string, string>[] => (r.type === "TXT" ? [{ text: r.value }] : [{ host: r.value }]);

const EXTERNAL_HOWTO = [
  "وارد پنل جایی شوید که DNS دامنه را میزبانی می‌کند (کلادفلر، ابرآروان، یا پنل فروشنده‌ی دامنه).",
  "رکوردهای زیر را با همان نوع، نام و مقدار بسازید. نام‌ها نسبت به دامنه‌ی اصلی‌اند.",
  "برای رکورد _acme-challenge پروکسی/CDN را خاموش کنید.",
  "رکوردهای قدیمیِ همان نام که به جای دیگری اشاره می‌کنند را حذف کنید.",
  "بعد «بررسی دوباره» را بزنید؛ معمولاً چند دقیقه طول می‌کشد.",
];

export async function domainGuide(c: LiaraClient, rawDomain: string, opts: { app?: string; vm?: string; recheck?: boolean } = {}): Promise<DomainGuide> {
  const domain = normalizeDomain(rawDomain);
  if (opts.vm) return vmDomainGuide(c, domain, opts.vm, registrableOf(domain), domain === registrableOf(domain));
  const registrable = registrableOf(domain);
  const apex = domain === registrable;
  const registrar = registrarFor(registrable);

  const listDomains = () =>
    c
      .get<{ domains: RawDomain[] }>("/v1/domains", opts.app ? { project: opts.app } : undefined)
      .then((r) => r.domains ?? [])
      .catch(() => [] as RawDomain[]);
  const [domains, zones, live] = await Promise.all([listDomains(), c.dns.get<{ data?: RawZone[] } | RawZone[]>("/api/v1/zones").catch(() => null), liveDns(domain, registrable)]);
  let d = domains.find((x) => x.name?.toLowerCase() === domain);

  // /check is where Liara hands out the TXT ownership code; it also asks Liara to verify again.
  let code: string | undefined;
  if (d) {
    const checked = await c.get<{ domain?: RawDomain & { verificationCode?: string } }>(`/v1/domains/${enc(d._id)}/check`).catch(() => null);
    code = checked?.domain?.verificationCode;
    if (checked?.domain) d = { ...d, ...checked.domain };
  }

  const zoneList: RawZone[] = Array.isArray(zones) ? zones : (zones?.data ?? []);
  const zone = zoneList.find((z) => bare(String(z.name ?? "")) === registrable);
  const zoneNs = (zone?.nameServers ?? []).map(bare);
  const currentNs = (zone?.currentNameServers ?? []).map(bare);
  const liaraNs = zoneNs.length ? zoneNs : LIARA_NS_FALLBACK;
  // The zone's own status says whether the registrar points at Liara yet; live NS is the fallback.
  const nsOnLiara = !!zone && (zone.status === "ACTIVE" || live.ns.some((n) => liaraNs.includes(bare(n))));
  const mode: DnsMode = !zone ? "external" : nsOnLiara ? "liara-active" : "liara-pending";
  if (zone && !nsOnLiara && opts.recheck) await c.dns.put(`/api/v1/zones/${enc(registrable)}/check`).catch(() => null);

  const target = d?.CNameRecord ? bare(String(d.CNameRecord)) : null;
  const app = d?.project?.project_id ?? opts.app ?? null;
  const where = mode === "external" ? "DNS فعلی دامنه" : "زون DNS لیارا";

  let records = target ? await checkLive(registrable, appRecords(domain, registrable, apex, target, code, where)) : [];
  let zoneRecords: DomainGuide["zoneRecords"];
  if (zone && records.length) {
    const existing = await c.dns
      .get<{ data?: RawRecord[] }>(`/api/v1/zones/${enc(registrable)}/dns-records`)
      .then((r) => r.data ?? [])
      .catch(() => null);
    if (existing) {
      records = records.map((r) => ({ ...r, inZone: recordInZone(r, existing) }));
      zoneRecords = records.filter((r) => !r.inZone).map((r) => ({ zone: registrable, name: r.name, type: r.type as "CNAME" | "ALIAS" | "TXT", contents: contentsFor(r) }));
    }
  }

  const isConnected = connected(d?.status);
  const allLive = records.length > 0 && records.every((r) => r.live === "ok");
  const allInZone = records.length > 0 && records.every((r) => r.inZone);
  const label = (r: DnsRecord) => `${r.type} ${r.name}`;

  const steps: GuideStep[] = [
    {
      id: "attach",
      title: "اتصال دامنه به برنامه در لیارا",
      by: "yara",
      state: d ? "done" : "todo",
      detail: d ? `دامنه به برنامه‌ی ${app ?? "?"} وصل است.` : `یارا با تأیید شما دامنه را به برنامه${app ? `‌ی ${app}` : ""} وصل می‌کند (addDomain). بعد از آن لیارا مقدار رکوردها را می‌دهد.`,
    },
  ];

  if (mode === "liara-pending")
    steps.push({
      id: "ns",
      title: `تغییر سرورهای نام در ${registrar.name}`,
      by: "user",
      state: "todo",
      detail: `زون ${registrable} در DNS لیارا ساخته شده ولی هنوز فعال نیست. ${currentNs.length ? `سرورهای نام فعلی ${currentNs.join("، ")} است` : "سرورهای نام فعلی معلوم نیست"}؛ باید به ${liaraNs.join("، ")} تغییر کند. این کار فقط از پنل ${registrar.name} ممکن است.`,
    });

  if (mode === "external")
    steps.push({
      id: "records",
      title: "افزودن رکوردها در DNS فعلی دامنه",
      by: "user",
      state: !target ? "blocked" : allLive ? "done" : "todo",
      detail: !target
        ? "بعد از اتصال دامنه، لیارا مقدار رکوردها را می‌دهد."
        : allLive
          ? "همه‌ی رکوردها الان در DNS عمومی دیده می‌شوند."
          : `DNS این دامنه روی لیارا نیست${live.ns.length ? ` (سرورهای نام: ${live.ns.join("، ")})` : ""}، پس رکوردها را خودتان در همان پنل اضافه کنید. مانده: ${records
              .filter((r) => r.live !== "ok")
              .map(label)
              .join("، ")}. اگر می‌خواهید یارا رکوردها را خودش بسازد، DNS دامنه را به لیارا بیاورید.`,
    });
  else
    steps.push({
      id: "records",
      title: "ساخت رکوردها در زون DNS لیارا",
      by: "yara",
      state: !target ? "blocked" : allInZone ? "done" : "todo",
      detail: !target
        ? "بعد از اتصال دامنه."
        : allInZone
          ? "رکوردها در زون لیارا ساخته شده‌اند."
          : `زون ${registrable} روی DNS لیاراست، پس یارا با تأیید شما رکوردها را خودش می‌سازد: ${records
              .filter((r) => !r.inZone)
              .map(label)
              .join("، ")}.`,
    });

  const recordsReady = mode === "external" ? allLive : allInZone && nsOnLiara;
  steps.push({
    id: "verify",
    title: "تأیید مالکیت و اتصال توسط لیارا",
    by: "yara",
    state: isConnected ? "done" : recordsReady ? "waiting" : "blocked",
    detail: isConnected
      ? "لیارا اتصال دامنه را تأیید کرده است."
      : recordsReady
        ? "رکوردها سر جایشان‌اند؛ تأیید لیارا ممکن است چند دقیقه طول بکشد. «بررسی دوباره» را بزنید."
        : "بعد از اینکه رکوردها سر جایشان باشند.",
  });
  steps.push({
    id: "ssl",
    title: "گواهی SSL رایگان",
    by: "yara",
    state: sslOk(d?.certificatesStatus) ? "done" : isConnected ? "todo" : "blocked",
    detail: sslOk(d?.certificatesStatus) ? "سایت روی https در دسترس است." : isConnected ? "یارا با تأیید شما گواهی را صادر می‌کند (enableDomainSsl)." : "بعد از تأیید اتصال دامنه.",
  });

  // What the user types somewhere: all records for external DNS, only the nameservers when the zone is on Liara.
  const shown: DnsRecord[] =
    mode === "external" ? records : mode === "liara-pending" ? liaraNs.map((ns) => ({ where: registrar.name, type: "NS" as const, name: registrable, value: ns, purpose: "ns" as const })) : [];

  const firstOpen = steps.find((x) => x.state !== "done");
  return {
    domain,
    app,
    apex,
    registrable,
    registrar: mode === "external" ? { name: "پنل DNS فعلی دامنه", panel: null, howTo: EXTERNAL_HOWTO } : registrar,
    liara: { found: !!d, id: d?._id, status: d?.status, ssl: d?.certificatesStatus, target, dnsZone: { found: !!zone, nameservers: liaraNs, fromApi: zoneNs.length > 0 } },
    dns: { mode, zone: registrable, zoneStatus: zone?.status, nameServers: zoneNs, currentNameServers: currentNs },
    live,
    steps,
    records: shown,
    zoneRecords,
    ready: !firstOpen,
    next: !firstOpen
      ? "Everything is done: tell the user the site is live on https and offer monitoring."
      : firstOpen.id === "attach"
        ? "Next: addDomain (approval), then domainGuide again: Liara only gives the record values once the domain is attached."
        : firstOpen.id === "records" && firstOpen.by === "yara"
          ? "Next: the zone is on Liara DNS, so create every entry of zoneRecords with createDnsRecord (exact zone, name, type, contents), then domainGuide with recheck: true."
          : firstOpen.by === "user"
            ? "Next step is the user's, outside Liara's API. The card shows the exact records and how-to; tell them to press «بررسی دوباره» on the card when done. Do not repeat the records in text."
            : firstOpen.id === "ssl"
              ? "Next: enableDomainSsl (approval), then domainGuide again."
              : "Liara is still verifying: call domainGuide with recheck: true in a few minutes.",
  };
}
