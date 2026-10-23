"use client";

import { Activity, Bot, Boxes, CornerDownLeft, LayoutDashboard, MessageSquare, Moon, Plus, Search, Settings, ShieldCheck, SquareTerminal, Sun, Upload, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSummary, CaseSummary } from "./Workbench";

type Item = { id: string; group: string; label: string; icon: LucideIcon; hint?: string; run: () => void; ltr?: boolean };

const norm = (s: string) => s.toLowerCase().replace(/[‌\s]+/g, " ").trim();

export function CommandPalette({
  open,
  onClose,
  cases,
  apps,
  onDeploy,
  onOpenChat,
  onNewChat,
  onConsole,
  onAsk,
}: {
  open: boolean;
  onClose: () => void;
  cases: CaseSummary[];
  apps: AppSummary[];
  onDeploy: () => void;
  onOpenChat: (id: string) => void;
  onNewChat: () => void;
  onConsole: (app: string) => void;
  onAsk: (text: string) => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (href: string) => () => {
      onClose();
      router.push(href);
    };
    const setTheme = (t: "light" | "dark") => () => {
      try {
        localStorage.setItem("yara-theme", t);
      } catch {
        // storage unavailable; applies for this visit only
      }
      document.documentElement.dataset.theme = t;
      onClose();
    };
    const act = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const base: Item[] = [
      { id: "overview", group: "کارها", label: "نمای کلی برنامه‌ها", icon: LayoutDashboard, run: go("/app") },
      { id: "new", group: "کارها", label: "گفت‌وگوی تازه با یارا", icon: Plus, run: act(onNewChat) },
      {
        id: "deploy",
        group: "کارها",
        label: "استقرار کد روی یک برنامه",
        icon: Upload,
        run: () => {
          onClose();
          onDeploy();
        },
      },
      { id: "monitoring", group: "کارها", label: "پایش و سلامت، حادثه‌ها", icon: Activity, run: go("/app/monitoring") },
      { id: "audit", group: "کارها", label: "سوابق تغییرات", icon: ShieldCheck, run: go("/app/audit") },
      { id: "settings", group: "کارها", label: "تنظیمات", icon: Settings, run: go("/app/settings") },
      { id: "dark", group: "کارها", label: "پوسته‌ی تیره", icon: Moon, run: setTheme("dark") },
      { id: "light", group: "کارها", label: "پوسته‌ی روشن", icon: Sun, run: setTheme("light") },
    ];
    const appItems: Item[] = apps.flatMap((a) => [
      { id: `app-${a.name}`, group: "برنامه‌ها", label: a.name, hint: a.platform, icon: Boxes, ltr: true, run: go(`/app/apps/${encodeURIComponent(a.name)}`) },
      { id: `sh-${a.name}`, group: "کنسول", label: `${a.name}`, hint: "shell", icon: SquareTerminal, ltr: true, run: act(() => onConsole(a.name)) },
      {
        id: `ask-${a.name}`,
        group: "بررسی با یارا",
        label: a.name,
        icon: Bot,
        ltr: true,
        run: act(() => onAsk(`وضعیت برنامه‌ی ${a.name} را بررسی کن: خطاهای اخیر، استقرارها و مصرف منابع.`)),
      },
    ]);
    const caseItems: Item[] = cases.slice(0, 30).map((c) => ({ id: `case-${c.id}`, group: "گفت‌وگوها", label: c.title, icon: MessageSquare, run: act(() => onOpenChat(c.id)) }));
    const all = [...base, ...appItems, ...caseItems];
    const nq = norm(q);
    return nq ? all.filter((i) => norm(`${i.label} ${i.hint ?? ""} ${i.group}`).includes(nq)) : all;
  }, [q, apps, cases, router, onClose, onDeploy, onOpenChat, onNewChat, onConsole, onAsk]);

  useEffect(() => setSel(0), [q]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(items.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[sel]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = "";
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="فرمان‌ها" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <Search size={17} style={{ color: "var(--text-3)" }} aria-hidden />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="جست‌وجو یا فرمان…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[sel] ? `pi-${items[sel].id}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">چیزی پیدا نشد.</div>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? <div className="palette-group">{it.group}</div> : null;
            lastGroup = it.group;
            const Icon = it.icon;
            return (
              <div key={it.id}>
                {header}
                <button
                  type="button"
                  id={`pi-${it.id}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === sel}
                  className="palette-item"
                  onMouseMove={() => setSel(i)}
                  onClick={it.run}
                >
                  <Icon size={16} aria-hidden />
                  <span className={`grow ${it.ltr ? "ltr" : ""}`} style={it.ltr ? { textAlign: "right" } : undefined}>
                    {it.label}
                  </span>
                  {it.hint && <span className="faint small ltr">{it.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> جابه‌جایی
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={11} />
            </kbd>{" "}
            اجرا
          </span>
        </div>
      </div>
    </>
  );
}
