// Rule-based triage: turns raw evidence into a health status and a ranked list of likely causes.
// Deterministic on purpose: the same evidence always gives the same answer, the monitor can act on
// it without a model, and the agents get a grounded starting point instead of guessing.

import type { Evidence } from "./evidence";

export type HealthStatus = "healthy" | "degraded" | "down" | "off" | "unknown";

export type Cause = {
  id: string;
  /** Persian, shown to the user. */
  title: string;
  /** 0..1: how strongly the evidence points here. */
  confidence: number;
  evidence: string[];
  /** What to do about it, in Persian. */
  fix: string;
  /** Which agent should take it from here if the user asks Yara to fix it. */
  owner: "ops" | "debug" | "deploy";
  /** Safe enough for the monitor to try on its own, if the user's policy allows auto-heal. */
  autoHeal?: "restartApp";
};

export type Diagnosis = { status: HealthStatus; summary: string; causes: Cause[] };

const SIG = {
  oom: /out of memory|oomkilled|\bkilled\b|heap out of memory|allocation failed|memoryerror|exit code 137|signal 9/i,
  port: /EADDRINUSE|address already in use|listen EACCES|connection refused.*(?:127\.0\.0\.1|localhost):\d+|no (?:process|app) listening|port \d+ is not open/i,
  module: /cannot find module|module not found|modulenotfounderror|importerror|no module named|class .* not found|cannot resolve/i,
  syntax: /syntaxerror|unexpected token|referenceerror|typeerror|nameerror|parse error|is not a function/i,
  env: /missing (?:required )?env|environment variable .* (?:not set|missing|undefined)|keyerror: '[A-Z_]+'|process\.env\.[A-Z_]+ is undefined|secret_key|improperlyconfigured/i,
  db: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|could not connect to (?:server|database)|connection (?:refused|timed out|terminated)|too many connections|sequelizeconnectionerror|operationalerror|mongonetworkerror|redis.*(?:refused|closed)/i,
  crash: /fatal|panic|segfault|unhandled(?:promise)?rejection|uncaught exception|traceback \(most recent call last\)|crash/i,
};

const pct = (v: number, max: number) => Math.round((v / max) * 100);
const fa = (n: number) => n.toLocaleString("fa-IR");
const firstMatch = (lines: string[], re: RegExp) => lines.find((l) => re.test(l));

/** `baselineMs` is the app's usual healthy latency, learned by the monitor; it makes "slow" relative. */
export function diagnose(e: Evidence, opts: { baselineMs?: number | null } = {}): Diagnosis {
  if (!e.on) return { status: "off", summary: "برنامه خاموش است؛ پایش تا روشن شدن دوباره متوقف است.", causes: [] };

  const causes: Cause[] = [];
  const lines = e.logs?.samples ?? [];
  const add = (c: Cause) => causes.push(c);
  const probeDown = !!e.probe && !e.probe.ok;
  const http5xx = e.probe?.status != null && e.probe.status >= 500;
  const memPct = e.memory && e.memLimit ? pct(e.memory.max, e.memLimit) : null;
  const memNow = e.memory && e.memLimit ? pct(e.memory.last, e.memLimit) : null;
  const cpuPct = e.cpu && e.cpuLimit ? pct(e.cpu.avg, e.cpuLimit) : null;
  const cpuPeak = e.cpu && e.cpuLimit ? pct(e.cpu.max, e.cpuLimit) : null;
  const releaseAgeMin = e.release ? (Date.now() - new Date(e.release.at).getTime()) / 60000 : Infinity;
  const errRate = e.logs && e.logs.total ? e.logs.errorLines / e.logs.total : 0;

  // ---- memory ----
  const oomLine = firstMatch(lines, SIG.oom) ?? e.events.find((x) => SIG.oom.test(x));
  if (oomLine || (memPct !== null && memPct >= 90)) {
    add({
      id: "memory",
      title: "کمبود حافظه (RAM)",
      confidence: oomLine && memPct !== null && memPct >= 85 ? 0.92 : oomLine ? 0.8 : memNow !== null && memNow >= 95 ? 0.7 : 0.5,
      evidence: [
        ...(memPct !== null ? [`اوج مصرف RAM در ۳۰ دقیقه‌ی اخیر ${fa(memPct)}٪ سقف پلن (${e.plan}) بوده است.`] : []),
        ...(oomLine ? [`نشانه‌ی کشته شدن پردازه به‌خاطر حافظه: «${oomLine.slice(0, 160)}»`] : []),
      ],
      fix: "ری‌استارت فقط موقتاً حافظه را آزاد می‌کند. برای رفع دائمی یا پلن را بزرگ‌تر کنید یا نشت حافظه را در کد پیدا کنید (کش‌های بی‌سقف، بارگذاری فایل‌های بزرگ در حافظه).",
      owner: "ops",
      autoHeal: probeDown ? "restartApp" : undefined,
    });
  }

  // ---- CPU ----
  if (cpuPct !== null && (cpuPct >= 85 || (cpuPeak !== null && cpuPeak >= 98 && cpuPct >= 60))) {
    add({
      id: "cpu",
      title: "اشباع پردازنده (CPU)",
      confidence: cpuPct >= 95 ? 0.85 : 0.65,
      evidence: [`میانگین مصرف CPU در ۳۰ دقیقه‌ی اخیر ${fa(cpuPct)}٪ سهم پلن بوده و اوجش ${fa(cpuPeak ?? cpuPct)}٪.`],
      fix: "درخواست‌ها پشت CPU صف می‌کشند و سایت کند می‌شود. پلن با CPU بیشتر بگیرید، یا کار سنگین (پردازش تصویر، حلقه‌های بزرگ، کوئری بدون ایندکس) را بهینه یا به پس‌زمینه منتقل کنید.",
      owner: "ops",
    });
  }

  // ---- port / not listening ----
  const portLine = firstMatch(lines, SIG.port);
  if (portLine || (e.probe?.status === 502 && !lines.length)) {
    add({
      id: "port",
      title: "برنامه روی پورت درست گوش نمی‌دهد",
      confidence: portLine ? 0.85 : 0.55,
      evidence: [
        ...(e.probe?.status === 502 ? ["پروکسی لیارا پاسخ ۵۰۲ داد: درخواست به برنامه نرسید."] : []),
        ...(portLine ? [`«${portLine.slice(0, 160)}»`] : []),
      ],
      fix: "برنامه باید روی 0.0.0.0 و پورتی که در liara.json یا تنظیمات برنامه آمده گوش دهد. پورت را در کد یا liara.json اصلاح و دوباره مستقر کنید.",
      owner: "deploy",
    });
  }

  // ---- code / dependency error ----
  const modLine = firstMatch(lines, SIG.module);
  const synLine = firstMatch(lines, SIG.syntax);
  if (modLine || synLine) {
    add({
      id: "code",
      title: modLine ? "وابستگی یا ماژول جاافتاده" : "خطای کد در زمان اجرا",
      confidence: (modLine ? 0.85 : 0.7) + (releaseAgeMin < 60 ? 0.05 : 0),
      evidence: [`«${(modLine ?? synLine)!.slice(0, 180)}»`, ...(releaseAgeMin < 60 ? [`آخرین استقرار ${fa(Math.round(releaseAgeMin))} دقیقه پیش بوده است.`] : [])],
      fix: modLine
        ? "پکیج در dependencies نیست یا مسیر import اشتباه است. وابستگی را اضافه کنید (نه در devDependencies) و دوباره مستقر کنید. ری‌استارت کمکی نمی‌کند."
        : "خطا در کد است و با ری‌استارت برطرف نمی‌شود. یارا می‌تواند خطا را بازتولید، کد را اصلاح و پس از تأیید شما مستقر کند.",
      owner: "debug",
    });
  }

  // ---- env ----
  const envLine = firstMatch(lines, SIG.env);
  if (envLine) {
    add({
      id: "env",
      title: "متغیر محیطی تنظیم نشده",
      confidence: 0.75,
      evidence: [`«${envLine.slice(0, 180)}»`],
      fix: "متغیر لازم را در تنظیمات برنامه اضافه کنید (مقادیر محرمانه را خودتان وارد کنید). برنامه بعد از تنظیم خودکار ری‌استارت می‌شود.",
      owner: "ops",
    });
  }

  // ---- downstream dependency ----
  const dbLine = firstMatch(lines, SIG.db);
  if (dbLine && !portLine) {
    add({
      id: "dependency",
      title: "سرویس وابسته (دیتابیس یا API بیرونی) در دسترس نیست",
      confidence: 0.7,
      evidence: [`«${dbLine.slice(0, 180)}»`],
      fix: "وضعیت دیتابیس را بررسی کنید (روشن است؟ به سقف اتصال رسیده؟) و آدرس اتصال در متغیرهای محیطی را چک کنید. از شبکه‌ی خصوصی لیارا برای اتصال استفاده کنید.",
      owner: "ops",
    });
  }

  // ---- regression from the latest deploy ----
  if ((probeDown || errRate > 0.3) && releaseAgeMin < 45 && e.release?.state === "READY") {
    add({
      id: "regression",
      title: "خطا بعد از آخرین استقرار شروع شده",
      confidence: 0.6,
      evidence: [`نسخه‌ی ${e.release.id.slice(0, 8)} حدود ${fa(Math.round(releaseAgeMin))} دقیقه پیش منتشر شد و از آن موقع خطا دیده می‌شود.`],
      fix: "اگر نسخه‌ی قبلی سالم بوده، سریع‌ترین راه برگرداندن آن است (استقرار دوباره‌ی کامیت قبلی). سپس علت را در تغییرات همین نسخه پیدا کنید.",
      owner: "deploy",
    });
  }

  // ---- failed deploy (site may still run the previous release) ----
  if (e.release?.state === "FAILED") {
    add({
      id: "deploy-failed",
      title: "آخرین استقرار ناموفق بوده",
      confidence: probeDown ? 0.55 : 0.4,
      evidence: [`نسخه‌ی ${e.release.id.slice(0, 8)} به وضعیت FAILED رسید${probeDown ? "" : "؛ سایت احتمالاً هنوز نسخه‌ی قبلی را اجرا می‌کند"}.`],
      fix: "لاگ ساخت را بخوانید؛ یارا می‌تواند علت را پیدا و اصلاح کند و دوباره مستقر کند.",
      owner: "deploy",
    });
  }

  // ---- generic crash ----
  const crashLine = firstMatch(lines, SIG.crash);
  if (crashLine && !causes.some((c) => ["code", "memory", "port"].includes(c.id))) {
    add({
      id: "crash",
      title: "برنامه با استثنای مدیریت‌نشده متوقف می‌شود",
      confidence: 0.6,
      evidence: [`«${crashLine.slice(0, 180)}»`],
      fix: "ری‌استارت سرویس را موقتاً برمی‌گرداند، ولی خطا دوباره رخ می‌دهد تا وقتی کد اصلاح شود.",
      owner: "debug",
      autoHeal: probeDown ? "restartApp" : undefined,
    });
  }

  // ---- slow but up ----
  const base = opts.baselineMs ?? null;
  const slow = !!e.probe?.ok && (e.probe.ms > 3000 || (base !== null && e.probe.ms > Math.max(1500, base * 3)));
  if (slow && !causes.some((c) => c.id === "cpu" || c.id === "memory")) {
    add({
      id: "slow",
      title: "پاسخ کند بدون فشار منابع",
      confidence: 0.45,
      evidence: [
        `صفحه در ${fa(e.probe!.ms)} میلی‌ثانیه پاسخ داد${base !== null ? ` (معمولاً حدود ${fa(base)} میلی‌ثانیه)` : ""} در حالی که CPU و RAM عادی‌اند.`,
      ],
      fix: "کندی احتمالاً از کوئری‌های کند دیتابیس، فراخوانی API بیرونی یا نبود کش است. لاگ زمان پاسخ را بررسی و کش یا ایندکس اضافه کنید.",
      owner: "debug",
    });
  }

  // ---- down with no explanation ----
  if (probeDown && !causes.length) {
    add({
      id: "unresponsive",
      title: "برنامه پاسخ نمی‌دهد و علت در لاگ‌ها پیدا نیست",
      confidence: 0.5,
      evidence: [e.probe?.status ? `پاسخ HTTP ${e.probe.status}` : `درخواست به ${e.probe?.url} ناموفق بود: ${e.probe?.error ?? "بدون پاسخ"}`, ...(e.logs && !e.logs.total ? ["در ۱۰ دقیقه‌ی اخیر هیچ لاگی ثبت نشده؛ ممکن است پردازه گیر کرده باشد."] : [])],
      fix: "ری‌استارت معمولاً پردازه‌ی گیرکرده را آزاد می‌کند. اگر برنگشت، لاگ‌های بلندتر و رویدادهای پلتفرم را بررسی کنید.",
      owner: "ops",
      autoHeal: "restartApp",
    });
  }

  causes.sort((a, b) => b.confidence - a.confidence);
  for (const c of causes) c.confidence = Math.min(0.97, Math.round(c.confidence * 100) / 100);

  // ---- status ----
  const statusDown = /fail|crash|error/i.test(e.status);
  let status: HealthStatus;
  if (probeDown || http5xx || (!e.probe && statusDown)) status = "down";
  else if (causes.length || slow || errRate > 0.3) status = "degraded";
  else if (!e.probe && !e.logs && !e.cpu) status = "unknown";
  else status = "healthy";

  const top = causes[0];
  const what =
    status === "down"
      ? e.probe
        ? `سایت در دسترس نیست (${e.probe.status ? `HTTP ${e.probe.status}` : (e.probe.error ?? "بدون پاسخ")})`
        : "وضعیت برنامه خطا نشان می‌دهد"
      : status === "degraded"
        ? "برنامه کار می‌کند ولی مشکل دارد"
        : status === "unknown"
          ? "داده‌ی کافی برای سنجش سلامت نیست"
          : `سالم${e.probe ? ` · ${fa(e.probe.ms)} ms` : ""}`;
  return { status, summary: top ? `${what}. محتمل‌ترین علت: ${top.title}.` : `${what}.`, causes };
}
