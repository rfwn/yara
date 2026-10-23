// Client-safe description of every action that changes infrastructure.
// The change slip (برگ درخواست تغییر) renders these fields.

export type Risk = "low" | "medium" | "high";

export const RISK_LABEL: Record<Risk, string> = { low: "کم‌خطر", medium: "خطر متوسط", high: "پرخطر" };

type Meta = {
  /** Kind of change, e.g. «راه‌اندازی دوباره». */
  label: string;
  risk: Risk;
  /** The resource the slip is about, shown in its own field. */
  target: (i: Record<string, any>) => string;
  /** One or two sentences: what will happen. Markdown allowed. */
  summary: (i: Record<string, any>) => string;
  /** High-risk actions: the user must type this value to approve. */
  confirmText?: (i: Record<string, any>) => string;
};

const list = (xs?: unknown[]) => (xs ?? []).map((x) => `\`${String(x)}\``).join("، ");

export const ACTION_META: Record<string, Meta> = {
  runShellCommand: {
    label: "اجرای دستور در کانتینر",
    risk: "medium",
    target: (i) => i.app,
    summary: (i) => `این دستور در کنسول همین برنامه و جلوی چشم شما اجرا می‌شود و خروجی‌اش به یارا برمی‌گردد:

\`\`\`sh
${i.command}
\`\`\``,
  },
  restartApp: {
    label: "راه‌اندازی دوباره‌ی برنامه",
    risk: "low",
    target: (i) => i.app,
    summary: () => "همه‌ی نمونه‌های برنامه دوباره راه‌اندازی می‌شوند. اگر استقرار بدون توقف فعال نباشد، چند ثانیه قطعی دارد.",
  },
  setAppPower: {
    label: "روشن یا خاموش کردن برنامه",
    risk: "medium",
    target: (i) => i.app,
    summary: (i) => (i.on ? "برنامه روشن می‌شود." : "برنامه خاموش می‌شود و تا روشن شدن دوباره به هیچ درخواستی پاسخ نمی‌دهد."),
  },
  setEnvVars: {
    label: "تنظیم متغیرهای محیطی",
    risk: "medium",
    target: (i) => i.app,
    summary: (i) =>
      `${list((i.variables ?? []).map((v: { key: string }) => v.key))} تنظیم می‌شود. متغیرهای دیگر دست نمی‌خورند و برنامه برای اعمال تغییر ری‌استارت می‌شود.`,
  },
  unsetEnvVars: {
    label: "حذف متغیرهای محیطی",
    risk: "medium",
    target: (i) => i.app,
    summary: (i) => `${list(i.keys)} حذف می‌شود و برنامه ری‌استارت می‌شود.`,
  },
  changeAppPlan: {
    label: "تغییر پلن",
    risk: "medium",
    target: (i) => i.app,
    summary: (i) => `برنامه به پلن \`${i.planID}\` منتقل می‌شود. هزینه تغییر می‌کند و برنامه ری‌استارت می‌شود.`,
  },
  createApp: {
    label: "ساخت برنامه‌ی تازه",
    risk: "low",
    target: (i) => i.name,
    summary: (i) => `یک برنامه‌ی **${i.platform}** روی پلن \`${i.planID}\`${i.bundlePlanID ? ` با بسته‌ی امکانات \`${i.bundlePlanID}\`` : ""} ساخته می‌شود. هزینه از لحظه‌ی ساخت محاسبه می‌شود.`,
  },
  deleteApp: {
    label: "حذف برنامه",
    risk: "high",
    target: (i) => i.app,
    summary: () => "برنامه همراه با استقرارها و دیسک‌هایش برای همیشه حذف می‌شود. این کار بازگشت‌پذیر نیست.",
    confirmText: (i) => String(i.app),
  },
  setAppFeature: {
    label: "تغییر قابلیت برنامه",
    risk: "low",
    target: (i) => i.app,
    summary: (i) => `قابلیت \`${i.feature}\` ${i.enabled ? "فعال" : "غیرفعال"} می‌شود.`,
  },
  deployRelease: {
    label: "استقرار نسخه‌ی تازه",
    risk: "medium",
    target: (i) => i.app,
    summary: (i) => `سورس \`${i.sourceID}\` به‌عنوان برنامه‌ی ${i.platform} روی پورت ${i.port} ساخته و منتشر می‌شود.`,
  },
  addDomain: {
    label: "اتصال دامنه",
    risk: "low",
    target: (i) => i.domain,
    summary: (i) => `دامنه به برنامه‌ی **${i.app}** وصل می‌شود. بعد از آن باید DNS دامنه را به لیارا اشاره دهید.`,
  },
  enableDomainSsl: {
    label: "صدور گواهی SSL",
    risk: "low",
    target: (i) => i.domain,
    summary: () => "یک گواهی SSL رایگان صادر می‌شود. DNS دامنه باید از قبل به لیارا اشاره کند.",
  },
  createDisk: {
    label: "ساخت دیسک",
    risk: "low",
    target: (i) => i.app,
    summary: (i) => `دیسک **${i.name}** با حجم ${i.size} گیگابایت ساخته می‌شود. بعد باید آن را در liara.json متصل کنید.`,
  },
  createDiskBackup: {
    label: "پشتیبان‌گیری از دیسک",
    risk: "low",
    target: (i) => `${i.app} / ${i.disk}`,
    summary: () => "از محتوای فعلی دیسک یک نسخه‌ی پشتیبان گرفته می‌شود.",
  },
  createDatabase: {
    label: "ساخت دیتابیس",
    risk: "low",
    target: (i) => i.hostname,
    summary: (i) =>
      `یک دیتابیس **${i.type}${i.version ? ` ${i.version}` : ""}** روی پلن \`${i.planID}\` ساخته می‌شود${i.publicNetwork ? " و از اینترنت در دسترس خواهد بود" : ""}.`,
  },
  createDatabaseBackup: {
    label: "پشتیبان‌گیری از دیتابیس",
    risk: "low",
    target: (i) => i.databaseId,
    summary: () => "از وضعیت فعلی دیتابیس یک نسخه‌ی پشتیبان گرفته می‌شود.",
  },
  setDatabasePower: {
    label: "روشن یا خاموش کردن دیتابیس",
    risk: "medium",
    target: (i) => i.databaseId,
    summary: (i) => (i.on ? "دیتابیس روشن می‌شود." : "دیتابیس خاموش می‌شود و برنامه‌هایی که به آن وصل‌اند خطا می‌گیرند."),
  },
  createDnsRecord: {
    label: "افزودن رکورد DNS",
    risk: "low",
    target: (i) => i.zone,
    summary: (i) => `رکورد **${i.type}** با نام \`${i.name}\` اضافه می‌شود.`,
  },
  deleteDnsRecord: {
    label: "حذف رکورد DNS",
    risk: "high",
    target: (i) => i.zone,
    summary: (i) => `رکورد \`${i.recordId}\` حذف می‌شود و ترافیکی که به آن وابسته است دیگر به مقصد نمی‌رسد.`,
    confirmText: (i) => String(i.zone),
  },
  createBucket: {
    label: "ساخت باکت",
    risk: "low",
    target: (i) => i.name,
    summary: (i) => `یک باکت ${i.permission === "public" ? "عمومی" : "خصوصی"} روی پلن \`${i.plan}\` ساخته می‌شود.`,
  },
  setBucketPermission: {
    label: "تغییر دسترسی باکت",
    risk: "medium",
    target: (i) => i.bucket,
    summary: (i) =>
      i.permission === "public"
        ? "باکت عمومی می‌شود و هر کسی با داشتن آدرس یک فایل، می‌تواند آن را بخواند."
        : "باکت خصوصی می‌شود و لینک‌های عمومی فایل‌ها از کار می‌افتند.",
  },
  createBucketFolder: {
    label: "ساخت پوشه در باکت",
    risk: "low",
    target: (i) => `${i.bucket} / ${i.path}`,
    summary: () => "یک پوشه‌ی خالی ساخته می‌شود.",
  },
  deleteObject: {
    label: "حذف فایل",
    risk: "high",
    target: (i) => `${i.bucket} / ${i.object}`,
    summary: () => "فایل برای همیشه از باکت حذف می‌شود.",
    confirmText: (i) => String(i.object).split("/").pop() ?? String(i.object),
  },
  deleteBucket: {
    label: "حذف باکت",
    risk: "high",
    target: (i) => i.bucket,
    summary: () => "باکت و همه‌ی فایل‌های داخلش برای همیشه حذف می‌شوند. این کار بازگشت‌پذیر نیست.",
    confirmText: (i) => String(i.bucket),
  },

  // ---- virtual machines ----
  setVMPower: {
    label: "تغییر وضعیت روشن/خاموش ماشین مجازی",
    risk: "medium",
    target: (i) => i.vm,
    summary: (i) =>
      (({
        start: "ماشین مجازی روشن می‌شود.",
        reboot: "ماشین مجازی دوباره راه‌اندازی می‌شود؛ سرویس‌های داخلش چند ثانیه تا چند دقیقه در دسترس نیستند.",
        shutdown: "به سیستم‌عامل فرمان خاموش شدن داده می‌شود (خاموش کردن امن). تا روشن کردن دوباره، سرویس‌های داخلش از دسترس خارج‌اند.",
        stop: "ماشین **به‌زور** خاموش می‌شود، مثل کشیدن دوشاخه. ممکن است داده‌های ذخیره‌نشده از دست بروند؛ فقط وقتی خاموش کردن امن جواب نمی‌دهد.",
      } as Record<string, string>)[String(i.action)] ?? `اقدام: \`${i.action}\``) + "\n\nیارا صبر می‌کند تا لیارا عملیات را تمام کند و نتیجه را بررسی می‌کند.",
  },
  resizeVM: {
    label: "تغییر پلن ماشین مجازی",
    risk: "high",
    target: (i) => i.vm,
    summary: (i) => `پلن به \`${i.plan}\` تغییر می‌کند. هزینه‌ی ماهانه عوض می‌شود و ممکن است ماشین دوباره راه‌اندازی شود.`,
    confirmText: (i) => String(i.vm),
  },
  createVMDisk: {
    label: "افزودن دیسک به ماشین مجازی",
    risk: "medium",
    target: (i) => i.vm,
    summary: (i) => `یک دیسک تازه‌ی ${i.size} گیگابایتی ساخته و به ماشین وصل می‌شود. هزینه‌اش به صورت‌حساب اضافه می‌شود؛ باید داخل سیستم‌عامل mount شود.`,
  },
  extendVMDisk: {
    label: "بزرگ کردن دیسک ماشین مجازی",
    risk: "medium",
    target: (i) => `${i.vm} / ${i.diskId}`,
    summary: (i) => `دیسک به ${i.newSize} گیگابایت بزرگ می‌شود (کوچک کردن ممکن نیست). فایل‌سیستم داخل ماشین را باید جداگانه بزرگ کرد.`,
  },
  deleteVMDisk: {
    label: "حذف دیسک ماشین مجازی",
    risk: "high",
    target: (i) => `${i.vm} / ${i.diskId}`,
    summary: () => "دیسک و همه‌ی داده‌هایش برای همیشه پاک می‌شوند.",
    confirmText: (i) => String(i.diskId),
  },
  resetVMNetwork: {
    label: "بازنشانی شبکه‌ی ماشین مجازی",
    risk: "medium",
    target: (i) => i.vm,
    summary: () => "تنظیمات شبکه‌ی ماشین به حالت پیش‌فرض برمی‌گردد. ماشین باید خاموش باشد.",
  },
  resetVMPassword: {
    label: "بازنشانی رمز root",
    risk: "high",
    target: (i) => i.vm,
    summary: () => "رمز root ماشین عوض می‌شود و رمز قبلی دیگر کار نمی‌کند. ماشین باید خاموش باشد. رمز تازه فقط یک بار و فقط برای شما نمایش داده می‌شود؛ یارا آن را نمی‌بیند.",
    confirmText: (i) => String(i.vm),
  },
  unfreezeVM: {
    label: "رفع انجماد ماشین مجازی",
    risk: "low",
    target: (i) => i.vm,
    summary: () => "ماشینی که به‌خاطر کمبود اعتبار متوقف شده دوباره فعال می‌شود. اعتبار حساب باید کافی باشد.",
  },
  createVM: {
    label: "ساخت ماشین مجازی",
    risk: "medium",
    target: (i) => i.name,
    summary: (i) => `ماشین \`${i.name}\` با \`${i.os}\` روی پلن \`${i.plan}\` ساخته می‌شود. از همین لحظه هزینه‌ی ساعتی دارد.${i.sshKeys?.length ? ` ${i.sshKeys.length} کلید SSH نصب می‌شود.` : ""}`,
  },
  deleteVM: {
    label: "حذف ماشین مجازی",
    risk: "high",
    target: (i) => i.vm,
    summary: () => "ماشین با همه‌ی دیسک‌ها و داده‌هایش برای همیشه حذف می‌شود. این کار بازگشت‌پذیر نیست.",
    confirmText: (i) => String(i.vm),
  },
};

export const isAction = (toolName: string) => toolName in ACTION_META;
