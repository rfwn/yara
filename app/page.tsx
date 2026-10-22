import "./workbench.css";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { HeroShot } from "@/components/yara/HeroShot";
import { LogoMark } from "@/components/yara/Logo";
import { currentUser } from "@/lib/server/auth";

// What Yara can read and what it can change, straight from lib/tools.ts and lib/actions.ts.
const CAPABILITIES: [string, string, string][] = [
  ["برنامه‌ها", "وضعیت، پیکربندی، پلن و متغیرهای محیطی (مقادیر حساس پوشیده)", "ری‌استارت، روشن و خاموش، تغییر پلن، تنظیم متغیرها، ساخت و حذف"],
  ["استقرار", "تاریخچه‌ی نسخه‌ها، وضعیت ساخت، اطلاعات گیت", "استقرار سورسی که بارگذاری می‌کنید"],
  ["لاگ و رویداد", "لاگ‌های زنده با فیلتر خطا، رویدادهای پلتفرم", "–"],
  ["مصرف منابع", "پردازنده، حافظه و شبکه در طول زمان", "–"],
  ["دامنه و SSL", "دامنه‌ها، وضعیت اتصال و گواهی، رکورد لازم", "اتصال دامنه، صدور SSL"],
  ["دیتابیس", "نوع، نسخه، وضعیت، پشتیبان‌ها و مصرف", "ساخت، پشتیبان‌گیری، روشن و خاموش"],
  ["DNS", "زون‌ها و رکوردها", "افزودن و حذف رکورد"],
  ["ذخیره‌سازی ابری", "باکت‌ها، فایل‌ها و لینک دانلود موقت", "ساخت باکت و پوشه، تغییر دسترسی، حذف"],
  ["مستندات لیارا", "جست‌وجو و مطالعه‌ی docs.liara.ir هنگام پاسخ", "–"],
];

const PRINCIPLES: { title: string; body: string }[] = [
  {
    title: "کنسول، لاگ و یارا کنار هم",
    body: "مثل محیط کدنویسی‌تان: برنامه را باز کنید، لاگ‌ها را زنده ببینید، داخل کانتینر شل بگیرید و از یارا بخواهید با شواهد بررسی کند.",
  },
  {
    title: "هیچ تغییری بدون تأیید شما",
    body: "هر تغییر جداگانه پیش شما می‌آید و تا تأییدش نکنید اجرا نمی‌شود. برای کارهای پرخطر مثل حذف، باید نام منبع را هم تایپ کنید.",
  },
  {
    title: "کلید شما، دسترسی خود شما",
    body: "کلید API لیارا پیش از ذخیره با لیارا بررسی و رمزنگاری‌شده نگه داشته می‌شود. یارا هیچ‌وقت بیشتر از دسترسی خود شما کاری نمی‌کند.",
  },
  {
    title: "پاسخ از روی مستندات",
    body: "برای پیکربندی و رفع خطا، یارا مستندات رسمی لیارا را همان لحظه می‌خواند و پیوندش را می‌دهد، نه اینکه از حافظه حدس بزند.",
  },
];

export default async function Landing() {
  const user = await currentUser();
  const primary = user ? { href: "/app", label: "ورود به یارا" } : { href: "/signup", label: "شروع کنید" };

  return (
    <>
      <header className="site-nav">
        <Link href="/" className="logo">
          <LogoMark />
          یارا
        </Link>
        <nav>
          {user ? (
            <Link href="/app" className="btn btn-primary">
              باز کردن یارا
            </Link>
          ) : (
            <>
              <Link href="/login" className="btn btn-ghost">
                ورود
              </Link>
              <Link href="/signup" className="btn btn-primary">
                ساخت حساب
              </Link>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="hero">
          <h1>
            یارا، میز کار عملیات
            <br />
            <em>برای برنامه‌هایتان روی لیارا.</em>
          </h1>
          <p className="hero-lead">
            همه‌ی برنامه‌هایتان در یک نگاه، لاگ زنده و شل داخل کانتینر، با دستیاری کنار دستتان که علت مشکل را با شواهد پیدا می‌کند و راه‌حل پیشنهاد می‌دهد.
            هیچ تغییری اجرا نمی‌شود، مگر اینکه خودتان تأییدش کنید. یارا ابزاری مستقل است و با کلید API خود شما کار می‌کند.
          </p>
          <div className="hero-cta">
            <Link href={primary.href} className="btn btn-primary btn-lg">
              {primary.label}
              <ArrowLeft size={17} aria-hidden />
            </Link>
            {!user && (
              <Link href="/login" className="btn btn-lg">
                حساب دارم
              </Link>
            )}
          </div>
          <HeroShot />
        </section>

        <section className="section" aria-labelledby="cap-title">
          <div className="section-head">
            <h2 id="cap-title">همه‌ی حساب لیارا، در یک گفت‌وگو</h2>
            <p>خواندن خودکار است. هر تغییر فقط پس از تأیید شما اجرا می‌شود.</p>
          </div>
          <div className="table-wrap">
            <table className="cap-table">
              <thead>
                <tr>
                  <th scope="col">بخش</th>
                  <th scope="col">یارا می‌خواند</th>
                  <th scope="col">با تأیید شما تغییر می‌دهد</th>
                </tr>
              </thead>
              <tbody>
                {CAPABILITIES.map(([k, read, write]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{read}</td>
                    <td className={write === "–" ? "none" : undefined}>{write}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section" aria-labelledby="principles-title">
          <div className="section-head">
            <h2 id="principles-title">ساخته‌شده برای لحظه‌ای که سرویس خوابیده</h2>
            <p>چهار قاعده که یارا در هر گفت‌وگو رعایت می‌کند.</p>
          </div>
          <dl className="rules">
            {PRINCIPLES.map(({ title, body }) => (
              <div key={title} className="rule">
                <dt>{title}</dt>
                <dd>{body}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="section closing">
          <LogoMark size={44} />
          <h2>مشکل بعدی را به یارا بسپارید.</h2>
          <p className="muted">فارسی بپرسید یا انگلیسی؛ یارا به همان زبان جواب می‌دهد.</p>
          <Link href={primary.href} className="btn btn-primary btn-lg">
            {primary.label}
            <ArrowLeft size={17} aria-hidden />
          </Link>
        </section>
      </main>

      <footer className="footer">
        <span>یارا ابزاری مستقل است و وابستگی رسمی به لیارا ندارد.</span>
        <span>
          <Link href="/login" className="link">
            ورود
          </Link>{" "}
          ·{" "}
          <Link href="/signup" className="link">
            ساخت حساب
          </Link>
        </span>
      </footer>
    </>
  );
}
