// What Liara's public APIs do not let Yara do, and what the user does instead.
// Agents read this through getPlatformLimits; the governance page shows it.

export type Limit = { id: string; area: string; title: string; detail: string; workaround: string };

export const PLATFORM_LIMITS: Limit[] = [
  {
    id: "vm-insight",
    area: "ماشین مجازی",
    title: "مصرف CPU و RAM، لاگ و اجرای دستور داخل ماشین",
    detail: "VM API only exposes state, power, plan, disks, network traffic and operation history. No CPU/RAM usage, no logs, no exec inside the VM.",
    workaround: "Open the SSH terminal on the VM page (Yara reads the root password from Liara at connect time) and run top, free -h, df -h or journalctl there, or run the Yara runner on the VM.",
  },
  {
    id: "vm-traffic-window",
    area: "ماشین مجازی",
    title: "بازه‌ی ترافیک شبکه کوتاه است",
    detail: "traffic-volume/graph need startTimeUnix and reject long windows (24 hours returns 400); data comes in 5-minute buckets.",
    workaround: "Yara asks for a few hours at most and falls back to the last hour.",
  },
  {
    id: "domain-registrar",
    area: "دامنه",
    title: "ثبت دامنه و تغییر NS در ثبت‌کننده (ایرنیک و…)",
    detail: "Registering a domain or changing its nameservers happens at the registrar (IRNIC for .ir, or the seller of the domain), outside Liara's API.",
    workaround: "domainGuide shows a checklist card: Yara attaches the domain, gives the exact NS / CNAME values with IRNIC how-to, the user sets them at the registrar, and «بررسی دوباره» re-verifies with a live DNS lookup and Liara's check before SSL is issued.",
  },
  {
    id: "billing",
    area: "حساب",
    title: "پرداخت و افزایش اعتبار",
    detail: "Top-ups and payments are not available through the API. A frozen VM or stopped app for low balance can only be resumed after the user pays.",
    workaround: "Yara reports the balance-related state and links the user to the Liara console to pay; then it can unfreeze or restart.",
  },
  {
    id: "deploy-endpoints",
    area: "استقرار",
    title: "API استقرار مستند نیست",
    detail: "Source upload, release creation and build logs (v2/projects/{app}/sources, v2/projects/{app}/releases, v2/releases/{id}/build-logs) come from the @liara/cli source, not the public docs, and may change without notice.",
    workaround: "Yara mirrors the CLI's requests; if a call fails, `liara deploy` from the CLI remains the fallback.",
  },
  {
    id: "release-rollback",
    area: "استقرار",
    title: "بازگشت به نسخه‌ی قبلی (rollback) استقرار",
    detail: "No documented API rolls an app back to an earlier release.",
    workaround: "Yara redeploys the previous code from the workspace (git checkout of the earlier commit), or the user uses the console's release history.",
  },
  {
    id: "container-exec",
    area: "برنامه",
    title: "اجرای دستور فقط داخل برنامه‌ی در حال اجرا",
    detail: "Shell access works only for running app containers, not for stopped apps, databases or buckets.",
    workaround: "Start the app first, or inspect databases with their own tools.",
  },
  {
    id: "storage-keys",
    area: "فضای ذخیره‌سازی",
    title: "کدگذاری مسیر فایل‌ها در API ذخیره‌سازی",
    detail: "How object keys with '/' must be encoded is undocumented; Yara tries the likely encodings in turn.",
    workaround: "If a nested object cannot be reached, use the console's file browser or an S3 client.",
  },
  {
    id: "logs-window",
    area: "برنامه",
    title: "لاگ‌ها فقط برای بازه‌ی اخیر",
    detail: "The logs API returns recent lines from a 'since' timestamp; old logs are not retained for long and there is no search.",
    workaround: "For long-term logs, ship them to an external service; Yara analyses recent windows.",
  },
  {
    id: "alerting",
    area: "پایش",
    title: "لیارا API هشدار یا پایش سلامت ندارد",
    detail: "There is no API to register uptime checks, alert rules or notification channels, and no push events: Liara does not tell anyone when an app goes down.",
    workaround: "Yara runs its own monitor on its server (every 1–60 min per app): it probes the public URL, reads metrics and logs, opens incidents and sends alerts to the user's webhook. If Yara's server is down, nothing is watched.",
  },
  {
    id: "http-metrics",
    area: "پایش",
    title: "آمار درخواست‌ها (تعداد، کد پاسخ، زمان پاسخ) در API نیست",
    detail: "The metrics API exposes CPU, memory and network per app only: no request rate, status-code breakdown, latency percentiles or access logs.",
    workaround: "Yara measures what visitors see by probing the app's URL itself and learns a latency baseline per app; for full request metrics the app must log them (they then show up in getAppLogs).",
  },
  {
    id: "probe-no-url",
    area: "پایش",
    title: "برنامه‌ی بدون آدرس عمومی را نمی‌توان از بیرون سنجید",
    detail: "When the default *.liara.run subdomain is off and no domain is connected, there is no URL to probe.",
    workaround: "Health then falls back to the app status, metrics and error logs; enabling the default subdomain (setAppFeature) restores HTTP checks.",
  },
  {
    id: "metrics-resolution",
    area: "پایش",
    title: "داده‌ی مصرف منابع با تأخیر و دانه‌درشت است",
    detail: "CPU/memory series arrive in coarse buckets and can lag a few minutes; a short spike may not show up at all.",
    workaround: "Yara judges resources over a 30-minute window (average and peak against the plan) and pairs them with logs (OOM kills) before blaming memory or CPU.",
  },
];
