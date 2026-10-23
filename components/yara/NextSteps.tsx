"use client";

import { Activity, Check, Copy, Globe, Laptop, Lock, Rocket, Server, SquareTerminal, X, Zap, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useWorkbench } from "./Workbench";

// "What now?" guidance: where to start (the runner), and what to do after a deploy (domain, SSL,
// monitoring). Every action goes through Yara, so the usual approvals still apply.

type Item = { id: string; icon: LucideIcon; title: string; detail: ReactNode; done?: boolean; action?: ReactNode };

function CopyCmd({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <span className="ns-cmd">
      <code className="ltr">{text}</code>
      <button
        type="button"
        className="icon-btn"
        aria-label="کپی فرمان"
        title="کپی"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setOk(true);
            setTimeout(() => setOk(false), 1500);
          } catch {
            // clipboard blocked
          }
        }}
      >
        {ok ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      </button>
    </span>
  );
}

function StepList({ items, numbered }: { items: Item[]; numbered?: boolean }) {
  return (
    <ol className="ns-list" data-numbered={numbered || undefined}>
      {items.map((it, i) => {
        const Icon = it.done ? Check : it.icon;
        return (
          <li key={it.id} data-done={it.done || undefined}>
            <span className="ns-ico" aria-hidden>
              {numbered && !it.done ? <b>{i + 1}</b> : <Icon size={14} strokeWidth={it.done ? 2.6 : 2} />}
            </span>
            <div className="ns-body">
              <div className="ns-title">
                {it.title}
                {it.done && <span className="visually-hidden"> (انجام شد)</span>}
              </div>
              <div className="ns-detail small muted">{it.detail}</div>
            </div>
            {it.action && !it.done && <div className="ns-action">{it.action}</div>}
          </li>
        );
      })}
    </ol>
  );
}

const DISMISS_KEY = "yara.getting-started.dismissed";
type Workspace = { id: string; kind: "github" | "local"; label: string; online: boolean };

/** Overview: start with the runner, deploy with Yara, then the per-app next steps. Hides itself once all three are done. */
export function GettingStarted({ deployed, firstApp }: { deployed: boolean; firstApp?: string }) {
  const wb = useWorkbench();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
    let stop = false;
    const load = () =>
      fetch("/api/workspaces")
        .then((r) => (r.ok ? r.json() : { workspaces: [] }))
        .then((d) => !stop && setWorkspaces(d.workspaces ?? []))
        .catch(() => !stop && setWorkspaces([]));
    load();
    // Notice the runner coming online without a reload, so step 1 ticks itself off.
    const t = setInterval(load, 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  if (dismissed || workspaces === null) return null;
  const runner = workspaces.find((w) => w.kind === "local" && w.online);
  if (runner && deployed) return null;

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const items: Item[] = [
    {
      id: "runner",
      icon: Laptop,
      title: runner ? `رانر «${runner.label}» وصل است` : "رانر یارا را در پوشه‌ی پروژه اجرا کنید",
      done: !!runner,
      detail: runner ? (
        "یارا حالا کد شما را می‌بیند."
      ) : (
        <>
          بهترین راه استقرار همین است: یارا کد را همان‌جا روی رایانه‌ی شما می‌خواند، بیلد می‌گیرد، اگر خطا داد درستش می‌کند و دوباره مستقر می‌کند. فقط همان پوشه در دسترس است و هر ویرایش یا استقرار
          پیش از اجرا برای تأیید شما می‌آید. در ترمینال، داخل پوشه‌ی پروژه (Node.js ۲۲ یا بالاتر):
          <CopyCmd text={`npx yara-runner --server ${origin} --token <توکن> --dir .`} />
          توکن را از <Link href="/app/settings#runner" className="link">تنظیمات ← پوشه‌ی روی رایانه‌ی شما</Link> بسازید.
        </>
      ),
      action: (
        <Link href="/app/settings#runner" className="btn">
          ساخت توکن
        </Link>
      ),
    },
    {
      id: "deploy",
      icon: Rocket,
      title: "از یارا بخواهید مستقر کند",
      done: deployed,
      detail: (
        <>
          یارا نوع پروژه را تشخیص می‌دهد، اگر برنامه‌ای در لیارا ندارید با پلن مناسب می‌سازد و بیلد را تا آخر دنبال می‌کند. بدون رانر هم می‌شود:{" "}
          <button type="button" className="link-btn" onClick={wb.openDeploy}>
            بارگذاری فایل فشرده
          </button>
          ، ولی آن‌وقت یارا کد را نمی‌بیند و اگر بیلد خطا بدهد نمی‌تواند درستش کند.
        </>
      ),
      action: (
        <button type="button" className="btn btn-primary" onClick={() => wb.askYara(runner ? `پروژه‌ی پوشه‌ی «${runner.label}» را روی لیارا مستقر کن.` : "می‌خواهم پروژه‌ام را روی لیارا مستقر کنم.", false)}>
          استقرار با یارا
        </button>
      ),
    },
    {
      id: "after",
      icon: Globe,
      title: "بعد از استقرار: دامنه، SSL و پایش",
      detail: "در صفحه‌ی هر برنامه، قدم‌های بعدی را می‌بینید: وصل کردن دامنه‌ی خودتان (یارا می‌گوید کدام رکوردها و کجا)، گواهی SSL، و پایش دائمی که اگر سایت از دسترس خارج شد خبرتان کند.",
      action: firstApp ? (
        <button type="button" className="btn" onClick={() => wb.openApp(firstApp)}>
          باز کردن برنامه
        </button>
      ) : undefined,
    },
  ];

  return (
    <section className="box ns-box" aria-labelledby="gs-title">
      <h2 id="gs-title">
        شروع کار با یارا
        <button
          type="button"
          className="icon-btn"
          aria-label="بستن راهنما"
          title="بستن"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(DISMISS_KEY, "1");
            } catch {
              // storage blocked: hidden for this visit only
            }
          }}
        >
          <X size={14} aria-hidden />
        </button>
      </h2>
      <div className="body">
        <StepList items={items} numbered />
      </div>
    </section>
  );
}

type AppFacts = {
  name: string;
  on: boolean;
  deployed: boolean;
  zeroDowntime: boolean;
  domains: { name: string; status: string; ssl: string }[];
};

const domainOk = (s: string) => /active|ok|connected/i.test(s);
const sslOn = (s?: string) => /active|issued|ok/i.test(s ?? "");

/** App page: the next useful things after a deploy, most important first. Gone once there is nothing left to suggest. */
export function AppNextSteps({ app }: { app: AppFacts }) {
  const wb = useWorkbench();
  if (!app.on) return null;
  const items: Item[] = [];
  const name = app.name;

  if (!app.deployed) {
    items.push({
      id: "deploy",
      icon: Rocket,
      title: "هنوز استقرار موفقی ندارد",
      detail: "با رانر یارا کد را از پوشه‌ی پروژه مستقر کنید؛ اگر بیلد خطا بدهد، یارا علت را پیدا و درست می‌کند.",
      action: (
        <button type="button" className="btn btn-primary" onClick={() => wb.askYara(`پروژه را روی برنامه‌ی ${name} مستقر کن.`, false)}>
          استقرار با یارا
        </button>
      ),
    });
  }
  if (app.domains.length === 0) {
    items.push({
      id: "domain",
      icon: Globe,
      title: "دامنه‌ی خودتان را وصل کنید",
      detail: "یارا دامنه را به برنامه وصل می‌کند و دقیقاً می‌گوید کدام رکوردها لازم است: اگر DNS دامنه روی لیارا باشد خودش می‌سازدشان، وگرنه می‌گوید در کدام پنل چه بنویسید.",
      action: (
        <button type="button" className="btn" onClick={() => wb.askYara(`این دامنه را به برنامه‌ی ${name} وصل کن: `, false)}>
          اتصال دامنه
        </button>
      ),
    });
  }
  for (const d of app.domains) {
    if (!domainOk(d.status))
      items.push({
        id: `dns-${d.name}`,
        icon: Globe,
        title: `اتصال ${d.name} کامل نشده`,
        detail: "لیارا هنوز رکوردهای DNS را تأیید نکرده است. یارا نشان می‌دهد کدام رکورد مانده و دوباره بررسی می‌کند.",
        action: (
          <button type="button" className="btn" onClick={() => wb.askYara(`اتصال دامنه‌ی ${d.name} به برنامه‌ی ${name} را بررسی کن و بگو چه مانده.`)}>
            ادامه‌ی اتصال
          </button>
        ),
      });
    else if (!sslOn(d.ssl))
      items.push({
        id: `ssl-${d.name}`,
        icon: Lock,
        title: `SSL برای ${d.name}`,
        detail: "دامنه وصل است ولی هنوز گواهی ندارد؛ بازدیدکننده‌ها هشدار «ناامن» می‌بینند. صدور گواهی رایگان است.",
        action: (
          <button type="button" className="btn btn-primary" onClick={() => wb.askYara(`برای دامنه‌ی ${d.name} گواهی SSL صادر کن.`)}>
            صدور SSL
          </button>
        ),
      });
  }
  if (app.deployed && !(name in wb.health)) {
    items.push({
      id: "monitor",
      icon: Activity,
      title: "پایش دائمی را روشن کنید",
      detail: "یارا هر چند دقیقه سایت را مثل یک بازدیدکننده می‌سنجد؛ اگر از دسترس خارج شد، علت را با شواهد پیدا می‌کند و خبرتان می‌کند.",
      action: (
        <button type="button" className="btn" onClick={() => wb.askYara(`پایش دائمی برنامه‌ی ${name} را روشن کن.`)}>
          روشن کردن پایش
        </button>
      ),
    });
  }
  if (app.deployed && !app.zeroDowntime) {
    items.push({
      id: "zdd",
      icon: Zap,
      title: "استقرار بدون قطعی",
      detail: "با هر استقرار، نسخه‌ی قبلی تا آماده شدن نسخه‌ی تازه سرویس می‌دهد و سایت لحظه‌ای هم از دسترس خارج نمی‌شود.",
      action: (
        <button type="button" className="btn" onClick={() => wb.askYara(`استقرار بدون قطعی (zero-downtime) را برای برنامه‌ی ${name} روشن کن.`)}>
          روشن کردن
        </button>
      ),
    });
  }

  if (!items.length) return null;
  return (
    <section className="box ns-box" aria-labelledby="ns-app-title">
      <h2 id="ns-app-title">
        قدم‌های بعدی <span className="faint small">هر کار پیش از اجرا برای تأیید شما می‌آید</span>
      </h2>
      <div className="body">
        <StepList items={items.slice(0, 4)} />
      </div>
    </section>
  );
}

/** VM page: a VM is not a Liara app, so the domain and SSL path is different (A record, nginx, certbot), and Yara does it over SSH. */
export function VmNextSteps({ vm, on }: { vm: string; on: boolean }) {
  const wb = useWorkbench();
  if (!on) return null;
  const items: Item[] = [
    {
      id: "domain",
      icon: Lock,
      title: "دامنه و SSL روی ماشین",
      detail: "روی ماشین مجازی، دامنه با یک رکورد A به IP ماشین وصل می‌شود و گواهی را certbot روی خود ماشین می‌گیرد. یارا رکورد لازم را می‌گوید، وب‌سرور را بررسی می‌کند و certbot را (با تأیید شما) اجرا می‌کند.",
      action: (
        <button type="button" className="btn btn-primary" onClick={() => wb.askYara(`این دامنه را به ماشین ${vm} وصل کن و برایش SSL بگیر: `, false)}>
          دامنه و SSL
        </button>
      ),
    },
    {
      id: "web",
      icon: Server,
      title: "راه‌اندازی وب‌سرور یا سرویس",
      detail: "nginx، Docker یا سرویس خودتان را یارا نصب و پیکربندی می‌کند؛ فرمان‌ها را در کنسول ماشین می‌بینید.",
      action: (
        <button type="button" className="btn" onClick={() => wb.askYara(`روی ماشین ${vm} بررسی کن چه سرویس‌هایی اجرا می‌شوند و وب‌سرور آماده است یا نه.`)}>
          بررسی با یارا
        </button>
      ),
    },
    {
      id: "console",
      icon: SquareTerminal,
      title: "کنسول ماشین",
      detail: "دسترسی مستقیم SSH از همین‌جا، بدون نصب چیزی.",
      action: (
        <button type="button" className="btn" onClick={() => wb.openVmConsole(vm)}>
          باز کردن کنسول
        </button>
      ),
    },
  ];
  return (
    <section className="box ns-box" aria-labelledby="ns-vm-title">
      <h2 id="ns-vm-title">کارهایی که می‌شود کرد</h2>
      <div className="body">
        <StepList items={items} />
      </div>
    </section>
  );
}
