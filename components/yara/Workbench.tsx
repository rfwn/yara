"use client";

import {
  Activity,
  Bot,
  Boxes,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Database,
  FolderArchive,
  LayoutDashboard,
  LogOut,
  PanelBottom,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Upload,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { faDigits } from "@/lib/fa";
import { HEALTH, type Cause, type HealthStatus } from "./Health";
import { ChatSidebar } from "./ChatSidebar";
import { CommandPalette } from "./CommandPalette";
import { ConsolePane, type ConsoleController, type ConsoleRunResult } from "./ConsolePane";
import { DeployDialog, type UploadedSource } from "./DeployDialog";
import { LogoMark } from "./Logo";
import { LogsPane } from "./LogsPane";
import { useModKey } from "./useModKey";

export type AppSummary = { name: string; platform: string; status: string; on: boolean };
export type CaseSummary = { id: string; title: string; updatedAt: number; pending?: number };
type DbSummary = { id: string; name: string; type: string; status: string; on: boolean };
type BucketSummary = { name: string; permission: string; status: string };
type VMSummary = { id: string; name: string; power: string; state: string; os: string };
type PanelTab = "console" | "logs";
export type Ask = { text: string; send: boolean; nonce: number; context?: string };
export type OpenIncident = { id: string; app: string; title: string; severity: "critical" | "warning"; causes: Cause[]; openedAt: number; escalated: boolean };

type Ctx = {
  apps: AppSummary[];
  refreshApps: () => void;
  openApp: (name: string) => void;
  /** Opens a new Yara chat with `text`; `context` travels with it to the agents but is never shown as the user's words. */
  askYara: (text: string, send?: boolean, context?: string) => void;
  /** Open incidents and last known health per watched app, from the background monitor. */
  incidents: OpenIncident[];
  health: Record<string, HealthStatus>;
  refreshHealth: () => void;
  openConsole: (app: string) => void;
  openLogs: (app: string) => void;
  openPalette: () => void;
  openDeploy: () => void;
  setPending: (n: number) => void;
  refreshCases: () => void;
  registerConsole: (app: string, c: ConsoleController) => () => void;
  runInConsole: (app: string, command: string) => Promise<ConsoleRunResult>;
};

const WorkbenchCtx = createContext<Ctx | null>(null);
export const useWorkbench = () => {
  const c = useContext(WorkbenchCtx);
  if (!c) throw new Error("useWorkbench outside Workbench");
  return c;
};

/** Status of an app: the monitor's live health when it watches the app, else the platform's container status. */
export function appStatus(a: { on: boolean; status: string; name?: string }, health?: Record<string, HealthStatus>) {
  if (!a.on) return { cls: "", label: "خاموش" };
  const h = a.name ? health?.[a.name] : undefined;
  if (h && h !== "unknown" && h !== "off") return { cls: HEALTH[h].dot, label: HEALTH[h].label };
  if (/run|active|ok|healthy/i.test(a.status)) return { cls: "up", label: "در حال اجرا" };
  if (/fail|error|crash|stopped/i.test(a.status)) return { cls: "down", label: "دچار خطا" };
  return { cls: "warn", label: a.status };
}

const newChatId = () => crypto.randomUUID();
const isNarrow = () => typeof window !== "undefined" && window.innerWidth < 900;

function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // preferences are a convenience only
  }
}

type Tab = { href: string; label: string; icon: "app" | "db" | "bucket" | "vm"; dot?: string };

/** Which resource the current route shows, as an editor tab. */
function tabFor(pathname: string, apps: AppSummary[], dbs: DbSummary[], health: Record<string, HealthStatus>): Tab | null {
  const [, , kind, raw] = pathname.split("/");
  if (!raw) return null;
  const id = decodeURIComponent(raw);
  if (kind === "apps") {
    const a = apps.find((x) => x.name === id);
    return { href: pathname, label: id, icon: "app", dot: a ? appStatus(a, health).cls : "" };
  }
  if (kind === "databases") return { href: pathname, label: dbs.find((d) => d.id === id)?.name ?? id, icon: "db" };
  if (kind === "buckets") return { href: pathname, label: id, icon: "bucket" };
  if (kind === "vms") return { href: pathname, label: id, icon: "vm" };
  return null;
}

export function Workbench({
  user,
  initialCases,
  modelLabel,
  children,
}: {
  user: { name: string; email: string; teamID: string | null };
  initialCases: CaseSummary[];
  modelLabel: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const mod = useModKey();

  const [apps, setApps] = useState<AppSummary[]>([]);
  const [appsError, setAppsError] = useState("");
  const [appsLoading, setAppsLoading] = useState(true);
  const [dbs, setDbs] = useState<DbSummary[]>([]);
  const [buckets, setBuckets] = useState<BucketSummary[]>([]);
  const [vms, setVms] = useState<VMSummary[]>([]);
  const [resErr, setResErr] = useState({ databases: false, buckets: false, vms: false });
  const [cases, setCases] = useState(initialCases);
  const [openIncidents, setOpenIncidents] = useState(0);
  const [incidents, setIncidents] = useState<OpenIncident[]>([]);
  const [health, setHealth] = useState<Record<string, HealthStatus>>({});

  // Open incidents and live health from the background monitor: the badge, banners and status dots.
  const refreshHealth = useCallback(() => {
    fetch("/api/monitor?summary=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setOpenIncidents(d.open ?? 0);
        setIncidents(d.incidents ?? []);
        setHealth(d.health ?? {});
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshHealth();
    const t = setInterval(refreshHealth, 30_000);
    return () => clearInterval(t);
  }, [pathname, refreshHealth]);

  const [sideOpen, setSideOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const [chatW, setChatW] = useState(420);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMax, setPanelMax] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("console");
  const [panelH, setPanelH] = useState(300);
  const [drag, setDrag] = useState<"" | "panel" | "chat">("");
  const [target, setTarget] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [pending, setPending] = useState(0);

  const [chatId, setChatId] = useState("");
  const [chatMessages, setChatMessages] = useState<unknown[] | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const consoles = useRef(new Map<string, ConsoleController>());
  const mainRef = useRef<HTMLDivElement>(null);

  const currentApp = pathname.startsWith("/app/apps/") ? decodeURIComponent(pathname.split("/")[3] ?? "") : "";

  // ---- data ----
  const refreshApps = useCallback(async () => {
    setAppsLoading(true);
    try {
      const [res, rres] = await Promise.all([fetch("/api/apps"), fetch("/api/resources")]);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "فهرست برنامه‌ها بارگذاری نشد.");
      setApps(data.apps);
      setAppsError("");
      if (rres.ok) {
        const r = await rres.json();
        setDbs(r.databases);
        setBuckets(r.buckets);
        setVms(r.vms ?? []);
        setResErr(r.errors);
      }
    } catch (e) {
      setAppsError(e instanceof Error ? e.message : String(e));
    } finally {
      setAppsLoading(false);
    }
  }, []);

  const refreshCases = useCallback(async () => {
    try {
      const res = await fetch("/api/chats");
      if (res.ok) setCases((await res.json()).chats);
    } catch {
      // keep the current list
    }
  }, []);

  const loadChat = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/agent/${id}`);
      if (!res.ok) throw new Error();
      setChatMessages((await res.json()).events);
      setChatId(id);
    } catch {
      setChatMessages(null);
      setChatId(newChatId());
    }
    setChatOpen(true);
  }, []);

  const newChat = useCallback(() => {
    setChatMessages(null);
    setChatId(newChatId());
    setChatOpen(true);
  }, []);

  useEffect(() => {
    refreshApps();
    setChatW(readPref("yara:chat-w", 420));
    setPanelH(readPref("yara:panel-h", 300));
    if (isNarrow()) {
      // Phones: resources lead; explorer and Yara open as overlays on demand.
      setSideOpen(false);
      setChatOpen(false);
    } else {
      setSideOpen(readPref("yara:side-open", true));
      setChatOpen(readPref("yara:chat-open", true));
    }
    const linked = new URLSearchParams(window.location.search).get("chat");
    if (linked) loadChat(linked);
    else setChatId(newChatId());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isNarrow()) writePref("yara:side-open", sideOpen);
  }, [sideOpen]);
  useEffect(() => {
    if (!isNarrow()) writePref("yara:chat-open", chatOpen);
  }, [chatOpen]);

  useEffect(() => {
    if (isNarrow()) setSideOpen(false);
  }, [pathname]);

  // Editor tabs follow the resources you open.
  useEffect(() => {
    const t = tabFor(pathname, apps, dbs, health);
    if (t) setTabs((ts) => (ts.some((x) => x.href === t.href) ? ts.map((x) => (x.href === t.href ? t : x)) : [...ts, t]));
    if (currentApp) setTarget(currentApp);
  }, [pathname, apps, dbs, health, currentApp]);

  useEffect(() => {
    if (!target && apps[0]) setTarget(apps[0].name);
  }, [apps, target]);

  // ---- actions exposed to editor pages ----
  const askYara = useCallback((text: string, send = true, context?: string) => {
    setChatMessages(null);
    setChatId(newChatId());
    setAsk({ text, send, nonce: Date.now(), context });
    setChatOpen(true);
  }, []);

  const openConsole = useCallback((app: string) => {
    setTarget(app);
    setPanelOpen(true);
    setPanelTab("console");
  }, []);

  const openLogs = useCallback((app: string) => {
    setTarget(app);
    setPanelOpen(true);
    setPanelTab("logs");
  }, []);

  const openApp = useCallback((name: string) => router.push(`/app/apps/${encodeURIComponent(name)}`), [router]);

  const registerConsole = useCallback((app: string, c: ConsoleController) => {
    consoles.current.set(app, c);
    return () => {
      if (consoles.current.get(app) === c) consoles.current.delete(app);
    };
  }, []);

  /** Shows the app's Console and runs an approved command there, in view of the user. */
  const runInConsole = useCallback(async (app: string, command: string) => {
    setTarget(app);
    setPanelMax(false);
    setPanelOpen(true);
    setPanelTab("console");
    for (let i = 0; i < 30 && !consoles.current.get(app); i++) await new Promise((r) => setTimeout(r, 100));
    const c = consoles.current.get(app);
    if (!c) throw new Error("console-unavailable");
    return c.run(command);
  }, []);

  const closeTab = (href: string) => {
    const next = tabs.filter((t) => t.href !== href);
    setTabs(next);
    if (pathname === href) router.push(next.length ? next[next.length - 1].href : "/app");
  };

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (k === "j") {
        e.preventDefault();
        setPanelOpen((o) => !o);
      } else if (k === "b") {
        e.preventDefault();
        setSideOpen((o) => !o);
      } else if (k === "i") {
        e.preventDefault();
        setChatOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- resizing (panel height, chat width) ----
  const startPanelResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const main = mainRef.current;
    if (!main) return;
    setDrag("panel");
    setPanelMax(false);
    const bottom = main.getBoundingClientRect().bottom;
    const move = (ev: PointerEvent) => setPanelH(Math.min(Math.max(bottom - ev.clientY, 140), main.clientHeight - 120));
    const up = () => {
      setDrag("");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPanelH((h) => (writePref("yara:panel-h", h), h));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startChatResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const shell = shellRef.current;
    if (!shell) return;
    setDrag("chat");
    // RTL: the chat sidebar sits at the left edge, so its width is the pointer's distance from that edge.
    const left = shell.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => setChatW(Math.min(Math.max(ev.clientX - left, 320), 720));
    const up = () => {
      setDrag("");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setChatW((w) => (writePref("yara:chat-w", w), w));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onUploaded = (s: UploadedSource) => {
    setDeployOpen(false);
    const extras = [s.platform && `پلتفرم: ${s.platform}`, s.port && `پورت: ${s.port}`].filter(Boolean).join("، ");
    askYara(
      `سورس تازه‌ای برای برنامه‌ی **${s.app}** بارگذاری کردم (\`${s.fileName}\`، ${(s.size / 1024 / 1024).toFixed(1)} مگابایت). sourceID: \`${s.sourceID}\`${extras ? ` (${extras})` : ""}. لطفاً آن را مستقر کن و روند استقرار را دنبال کن.`,
    );
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  };

  const down = apps.filter((a) => appStatus(a, health).cls === "down").length;
  const elsewhere = cases.filter((c) => c.id !== chatId && (c.pending ?? 0) > 0);
  const totalPending = pending + elsewhere.reduce((n, c) => n + (c.pending ?? 0), 0);
  const showPending = () => {
    if (pending === 0 && elsewhere[0]) loadChat(elsewhere[0].id);
    else setChatOpen(true);
  };
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openDeploy = useCallback(() => setDeployOpen(true), []);

  const ctx = useMemo<Ctx>(
    () => ({
      apps,
      refreshApps,
      openApp,
      askYara,
      incidents,
      health,
      refreshHealth,
      openConsole,
      openLogs,
      openPalette: () => setPaletteOpen(true),
      openDeploy,
      setPending,
      refreshCases,
      registerConsole,
      runInConsole,
    }),
    [apps, refreshApps, openApp, askYara, incidents, health, refreshHealth, openConsole, openLogs, openDeploy, refreshCases, registerConsole, runInConsole],
  );

  const TabIcon = ({ t }: { t: Tab }) =>
    t.icon === "app" ? <span className={`dot ${t.dot ?? ""}`} /> : t.icon === "db" ? <Database size={13} aria-hidden /> : t.icon === "vm" ? <Server size={13} aria-hidden /> : <FolderArchive size={13} aria-hidden />;

  return (
    <WorkbenchCtx.Provider value={ctx}>
      <div
        ref={shellRef}
        className="wb"
        data-side={sideOpen ? "open" : "closed"}
        data-chat={chatOpen ? "open" : "closed"}
        data-drag={drag || undefined}
        style={{ ["--chat-w" as string]: `${chatW}px` }}
      >
        {/* activity bar */}
        <nav className="activity" aria-label="نوار فعالیت">
          <Link href="/app" className="act-btn" aria-current={pathname === "/app" ? "page" : undefined} title="نمای کلی" aria-label="نمای کلی">
            <LayoutDashboard size={20} aria-hidden />
          </Link>
          <button type="button" className="act-btn" aria-pressed={sideOpen} onClick={() => setSideOpen((o) => !o)} title={`منابع (${mod}+B)`} aria-label="منابع">
            <Boxes size={20} aria-hidden />
          </button>
          <button type="button" className="act-btn" aria-pressed={chatOpen} onClick={() => setChatOpen((o) => !o)} title={`یارا (${mod}+I)`} aria-label="یارا">
            <Bot size={20} aria-hidden />
            {totalPending > 0 && <span className="act-badge">{faDigits(totalPending)}</span>}
          </button>
          <button type="button" className="act-btn" onClick={() => setDeployOpen(true)} title="استقرار کد" aria-label="استقرار کد">
            <Upload size={20} aria-hidden />
          </button>
          <Link
            href="/app/monitoring"
            className="act-btn"
            aria-current={pathname === "/app/monitoring" ? "page" : undefined}
            title={openIncidents ? `پایش و سلامت (${faDigits(openIncidents)} حادثه‌ی باز)` : "پایش و سلامت"}
            aria-label="پایش و سلامت"
          >
            <Activity size={20} aria-hidden />
            {openIncidents > 0 && <span className="act-badge act-badge-danger">{faDigits(openIncidents)}</span>}
          </Link>
          <Link href="/app/audit" className="act-btn" aria-current={pathname === "/app/audit" ? "page" : undefined} title="سوابق تغییرات" aria-label="سوابق تغییرات">
            <ShieldCheck size={20} aria-hidden />
          </Link>
          <span className="spacer" />
          <button type="button" className="act-btn" onClick={() => setPaletteOpen(true)} title={`فرمان‌ها (${mod}+K)`} aria-label="فرمان‌ها">
            <Search size={20} aria-hidden />
          </button>
          <Link href="/app/settings" className="act-btn" aria-current={pathname === "/app/settings" ? "page" : undefined} title="تنظیمات" aria-label="تنظیمات">
            <Settings size={20} aria-hidden />
          </Link>
        </nav>

        {/* explorer */}
        <aside className="explorer" aria-label="منابع">
          <div className="ex-head">
            <span>منابع لیارا</span>
            <button type="button" className="icon-btn" onClick={refreshApps} aria-label="به‌روزرسانی" title="به‌روزرسانی">
              <RefreshCw size={14} className={appsLoading ? "spin" : ""} aria-hidden />
            </button>
          </div>
          <div className="ex-scroll">
            <details className="ex-group" open>
              <summary>
                برنامه‌ها <span className="count num">{appsError ? "–" : faDigits(apps.length)}</span>
              </summary>
              {appsError ? (
                <div className="ex-note">
                  <span className="error-text">{appsError}</span>
                  <Link href="/app/settings" className="link">
                    بررسی اتصال
                  </Link>
                </div>
              ) : (
                <ul className="ex-list">
                  {apps.map((a) => {
                    const s = appStatus(a, health);
                    return (
                      <li key={a.name}>
                        <Link href={`/app/apps/${encodeURIComponent(a.name)}`} className="ex-item" aria-current={currentApp === a.name ? "page" : undefined} title={`${a.name} · ${s.label}`}>
                          <span className={`dot ${s.cls}`} role="img" aria-label={s.label} />
                          <span className="grow ltr" style={{ textAlign: "right" }}>
                            {a.name}
                          </span>
                          <span className="trail ltr">{a.platform}</span>
                        </Link>
                      </li>
                    );
                  })}
                  {!appsLoading && apps.length === 0 && <p className="ex-note">برنامه‌ای نیست.</p>}
                </ul>
              )}
            </details>
            <details className="ex-group" open>
              <summary>
                دیتابیس‌ها <span className="count num">{resErr.databases || appsError ? "–" : faDigits(dbs.length)}</span>
              </summary>
              <ul className="ex-list">
                {dbs.map((d) => {
                  const up = d.on && !/fail|error|stop/i.test(d.status);
                  const href = `/app/databases/${encodeURIComponent(d.id)}`;
                  return (
                    <li key={d.id}>
                      <Link href={href} className="ex-item" aria-current={pathname === href ? "page" : undefined}>
                        <span className={`dot ${up ? "up" : d.on ? "down" : ""}`} role="img" aria-label={up ? "فعال" : d.on ? "دچار خطا" : "خاموش"} />
                        <span className="grow ltr" style={{ textAlign: "right" }}>
                          {d.name}
                        </span>
                        <span className="trail ltr">{d.type}</span>
                      </Link>
                    </li>
                  );
                })}
                {!appsLoading && dbs.length === 0 && <p className="ex-note">{resErr.databases ? <span className="ex-unavail">
                        در دسترس نیست · 
                        <button type="button" className="link" onClick={refreshApps}>
                          دوباره
                        </button>
                      </span> : "دیتابیسی نیست."}</p>}
              </ul>
            </details>
            <details className="ex-group" open>
              <summary>
                ماشین‌های مجازی <span className="count num">{resErr.vms || appsError ? "–" : faDigits(vms.length)}</span>
              </summary>
              <ul className="ex-list">
                {vms.map((v) => {
                  const href = `/app/vms/${encodeURIComponent(v.name)}`;
                  const on = v.power === "POWERED_ON";
                  return (
                    <li key={v.id}>
                      <Link href={href} className="ex-item" aria-current={pathname === href ? "page" : undefined}>
                        <span className={`dot ${on ? "up" : v.power === "SUSPENDED" || v.state === "FROZEN" ? "down" : ""}`} role="img" aria-label={on ? "روشن" : "خاموش"} />
                        <span className="grow ltr" style={{ textAlign: "right" }}>
                          {v.name}
                        </span>
                        <span className="trail ltr">{v.os}</span>
                      </Link>
                    </li>
                  );
                })}
                {!appsLoading && vms.length === 0 && <p className="ex-note">{resErr.vms ? <span className="ex-unavail">
                        در دسترس نیست · 
                        <button type="button" className="link" onClick={refreshApps}>
                          دوباره
                        </button>
                      </span> : "ماشین مجازی‌ای نیست."}</p>}
              </ul>
            </details>
            <details className="ex-group" open>
              <summary>
                باکت‌ها <span className="count num">{resErr.buckets || appsError ? "–" : faDigits(buckets.length)}</span>
              </summary>
              <ul className="ex-list">
                {buckets.map((b) => {
                  const href = `/app/buckets/${encodeURIComponent(b.name)}`;
                  return (
                    <li key={b.name}>
                      <Link href={href} className="ex-item" aria-current={pathname === href ? "page" : undefined}>
                        <FolderArchive size={14} aria-hidden />
                        <span className="grow ltr" style={{ textAlign: "right" }}>
                          {b.name}
                        </span>
                        <span className="trail">{b.permission === "public" ? "عمومی" : "خصوصی"}</span>
                      </Link>
                    </li>
                  );
                })}
                {!appsLoading && buckets.length === 0 && <p className="ex-note">{resErr.buckets ? <span className="ex-unavail">
                        در دسترس نیست · 
                        <button type="button" className="link" onClick={refreshApps}>
                          دوباره
                        </button>
                      </span> : "باکتی نیست."}</p>}
              </ul>
            </details>
          </div>
        </aside>

        {/* editor + console/logs panel */}
        <div className="wb-main" ref={mainRef}>
          {!panelMax && (
            <>
              <div className="tabs" role="tablist" aria-label="زبانه‌ها">
                <Link href="/app" className="tab" aria-current={pathname === "/app" ? "page" : undefined}>
                  <LayoutDashboard size={14} aria-hidden />
                  <span className="tab-label">نمای کلی</span>
                </Link>
                {tabs.map((t) => (
                  <span key={t.href} className="tab" aria-current={pathname === t.href ? "page" : undefined}>
                    <Link href={t.href} style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <TabIcon t={t} />
                      <span className="tab-label ltr">{t.label}</span>
                    </Link>
                    <button type="button" className="icon-btn tab-close" onClick={() => closeTab(t.href)} aria-label={`بستن ${t.label}`}>
                      <X size={13} aria-hidden />
                    </button>
                  </span>
                ))}
                {pathname === "/app/settings" && (
                  <span className="tab" aria-current="page">
                    <Settings size={14} aria-hidden />
                    <span className="tab-label">تنظیمات</span>
                  </span>
                )}
                <div className="tab-tools">
                  <button type="button" className="icon-btn" onClick={() => setPanelOpen((o) => !o)} aria-label={`کنسول و لاگ‌ها (${mod}+J)`} title={`کنسول و لاگ‌ها (${mod}+J)`}>
                    <PanelBottom size={15} aria-hidden />
                  </button>
                </div>
              </div>
              <div className="editor">{children}</div>
            </>
          )}

          {/* Kept mounted while hidden so an open shell session survives toggling the panel. */}
          {(
            <section className="panel" hidden={!panelOpen} data-max={panelMax} style={{ ["--panel-h" as string]: `${panelH}px` }} aria-label="کنسول و لاگ‌ها">
              {!panelMax && <div className="panel-resize" data-drag={drag === "panel"} onPointerDown={startPanelResize} aria-hidden />}
              <div className="panel-tabs" role="tablist">
                {(
                  [
                    ["console", "کنسول", SquareTerminal],
                    ["logs", "لاگ‌ها", ScrollText],
                  ] as const
                ).map(([id, label, Icon]) => (
                  <button key={id} type="button" role="tab" className="ptab" aria-selected={panelTab === id} onClick={() => setPanelTab(id)}>
                    <Icon size={14} aria-hidden />
                    {label}
                  </button>
                ))}
                <div className="ptools">
                  {apps.length > 0 && (
                    <select className="target-select ltr" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="برنامه">
                      {apps.map((a) => (
                        <option key={a.name}>{a.name}</option>
                      ))}
                    </select>
                  )}
                  <button type="button" className="icon-btn" onClick={() => setPanelMax((m) => !m)} aria-label={panelMax ? "کوچک کردن پنل" : "بزرگ کردن پنل"}>
                    {panelMax ? <ChevronsDownUp size={15} aria-hidden /> : <ChevronsUpDown size={15} aria-hidden />}
                  </button>
                  <button type="button" className="icon-btn" onClick={() => setPanelOpen(false)} aria-label="بستن پنل">
                    <X size={15} aria-hidden />
                  </button>
                </div>
              </div>
              <div className="panel-body" hidden={panelTab !== "console"}>
                {target ? <ConsolePane key={target} app={target} active={panelOpen && panelTab === "console"} /> : <div className="term-overlay">برنامه‌ای انتخاب نشده است.</div>}
              </div>
              <div className="panel-body" hidden={panelTab !== "logs"}>
                {target ? <LogsPane key={target} app={target} active={panelOpen && panelTab === "logs"} /> : <div className="term-overlay">برنامه‌ای انتخاب نشده است.</div>}
              </div>
            </section>
          )}
        </div>

        {/* Yara: the AI chat sidebar */}
        <ChatSidebar
          chatId={chatId}
          initialEvents={chatMessages as never}
          app={currentApp}
          ask={ask}
          onAskConsumed={() => setAsk(null)}
          cases={cases}
          onOpenChat={loadChat}
          onNewChat={newChat}
          onDeleted={(id) => {
            setCases((cs) => cs.filter((c) => c.id !== id));
            if (id === chatId) newChat();
          }}
          onClose={() => setChatOpen(false)}
          onResizeStart={startChatResize}
          resizing={drag === "chat"}
        />

        {/* status bar */}
        <footer className="statusbar">
          <span className="sb-cell" title="اتصال به لیارا">
            {appsError ? <WifiOff size={13} aria-hidden style={{ color: "var(--danger)" }} /> : <Wifi size={13} aria-hidden />}
            {appsError ? "اتصال لیارا برقرار نیست" : `لیارا · ${faDigits(apps.length)} برنامه`}
          </span>
          {down > 0 && (
            <span className="sb-cell" style={{ color: "var(--danger)" }}>
              <CircleAlert size={13} aria-hidden />
              {faDigits(down)} برنامه دچار خطا
            </span>
          )}
          {totalPending > 0 && (
            <button type="button" className="sb-cell attention" onClick={showPending}>
              {faDigits(totalPending)} تغییر در انتظار تأیید
            </button>
          )}
          <span className="spacer" />
          {user.teamID && <span className="sb-cell hide-sm ltr">team {user.teamID.slice(0, 8)}</span>}
          <span className="sb-cell hide-sm">
            <Bot size={13} aria-hidden />
            {modelLabel}
          </span>
          <button type="button" className="sb-cell hide-sm" onClick={() => setPaletteOpen(true)}>
            {mod}+K
          </button>
          <span className="sb-cell hide-sm" title={user.email}>
            <LogoMark size={14} />
            {user.name}
          </span>
          <button type="button" className="sb-cell" onClick={logout} aria-label="خروج" title="خروج">
            <LogOut size={13} aria-hidden />
          </button>
        </footer>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        cases={cases}
        apps={apps}
        onDeploy={openDeploy}
        onOpenChat={loadChat}
        onNewChat={newChat}
        onConsole={openConsole}
        onAsk={askYara}
      />
      {deployOpen && <DeployDialog apps={apps} onUploaded={onUploaded} onClose={() => setDeployOpen(false)} />}
    </WorkbenchCtx.Provider>
  );
}
