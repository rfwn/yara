// One-line Persian entries for the inspection log (سوابق بررسی).
type In = Record<string, any>;

const mins = (m?: number) => `${m ?? 30} دقیقه‌ی اخیر`;

export const TOOL_LABELS: Record<string, (i: In) => string> = {
  getAccountOverview: () => "مشخصات حساب، تیم و پلن‌ها",
  listApps: () => "فهرست برنامه‌ها",
  getApp: (i) => `پیکربندی برنامه‌ی ${i.app}`,
  getAppLogs: (i) => `لاگ‌های ${i.app} · ${mins(i.minutes)}${i.errorsOnly ? " · فقط خطاها" : ""}`,
  getAppEvents: (i) => `رویدادهای ${i.app} · ${i.hours ?? 24} ساعت اخیر`,
  getAppReleases: (i) => `تاریخچه‌ی استقرار ${i.app}`,
  getAppMetrics: (i) => `مصرف منابع ${i.app} · ${i.hours ?? 6} ساعت اخیر`,
  diagnoseApp: (i) => `معاینه‌ی کامل ${i.app}`,
  listDomains: (i) => (i.app ? `دامنه‌های ${i.app}` : "فهرست دامنه‌ها"),
  checkDomain: () => "بررسی دوباره‌ی DNS دامنه",
  listDisks: (i) => `دیسک‌های ${i.app}`,
  listDatabases: () => "فهرست دیتابیس‌ها",
  getDatabase: (i) => `دیتابیس ${i.databaseId}`,
  listDnsZones: () => "فهرست زون‌های DNS",
  listDnsRecords: (i) => `رکوردهای DNS ‏${i.zone}`,
  listBuckets: () => "فهرست باکت‌ها",
  getBucket: (i) => `باکت ${i.bucket}`,
  listBucketObjects: (i) => `فایل‌های ${i.bucket}${i.prefix && i.prefix !== "/" ? `/${String(i.prefix).replace(/^\//, "")}` : ""}`,
  getObjectInfo: (i) => `مشخصات ${i.object}`,
  getObjectDownloadLink: (i) => `لینک دانلود ${i.object}`,
  searchLiaraDocs: (i) => `جست‌وجو در مستندات لیارا: «${i.query}»`,
  readLiaraDocsPage: (i) => `مطالعه‌ی مستندات: ${String(i.url ?? "").replace(/^https:\/\/docs\.liara\.ir/, "")}`,
};

export function toolLabel(name: string, input: unknown) {
  const fn = TOOL_LABELS[name];
  try {
    return fn ? fn((input ?? {}) as In) : name;
  } catch {
    return name;
  }
}
