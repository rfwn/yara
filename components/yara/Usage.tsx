"use client";

import { useId, useState } from "react";
import { bytesFa, faDigits, faNum, faTime, relativeFa } from "@/lib/fa";

type Series = { applet?: string; points: number; from?: number; to?: number; last?: number; min?: number; avg?: number; max?: number; samples?: number[] };

const NAMES: Record<string, string> = { cpu: "پردازنده", memory: "حافظه" };

const fmt = (metric: string, v?: number) => {
  if (v === undefined || !Number.isFinite(v)) return "–";
  if (metric === "memory") return bytesFa(v);
  return `${faDigits(v < 0.1 ? v.toFixed(3) : v.toFixed(2))} هسته`;
};

const tone = (pct: number | null) => (pct === null ? "" : pct >= 90 ? "crit" : pct >= 70 ? "hot" : "");

/** One metric: the current value against the plan, then how it moved across the window. */
function UsageTile({ metric, s, limit, hours, applet }: { metric: string; s: Series; limit: number | null; hours: number; applet?: string }) {
  const gid = `usage${useId().replace(/[^\w-]/g, "")}`;
  const [hover, setHover] = useState<number | null>(null);
  const values = s.samples ?? [];
  const name = NAMES[metric] ?? metric;
  const pct = limit && s.last !== undefined ? (s.last / limit) * 100 : null;
  const peakPct = limit && s.max !== undefined ? (s.max / limit) * 100 : null;
  const t = tone(peakPct !== null ? Math.max(pct ?? 0, peakPct) : null);

  // Scale to the data, not the limit, so the shape stays readable; the limit line shows only when it is close enough to matter.
  const top = Math.max(...values, s.max ?? 0, 0) * 1.15 || 1;
  const yMax = limit && limit <= top * 1.6 ? Math.max(top, limit * 1.05) : top;
  const W = 100;
  const H = 40;
  const x = (i: number) => (values.length < 2 ? W : (i / (values.length - 1)) * W);
  const y = (v: number) => H - (v / yMax) * H;
  const line = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const area = values.length > 1 ? `0,${H} ${line} ${W},${H}` : "";
  const limitY = limit && limit <= yMax ? y(limit) : null;

  // The chart spans what this container actually reported, which can be less than the window after a restart.
  const now = Date.now();
  const to = s.to ? s.to * 1000 : now;
  const from = s.from ? s.from * 1000 : now - hours * 3600_000;
  const at = (i: number) => from + (to - from) * (values.length < 2 ? 1 : i / (values.length - 1));
  const startedLate = from - (now - hours * 3600_000) > hours * 3600_000 * 0.05;
  const live = now - to < 5 * 60_000;
  const shown = hover ?? values.length - 1;

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (values.length < 2) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.round(f * (values.length - 1)));
  };

  return (
    <article className={`usage ${t}`} aria-label={`${name}: اکنون ${fmt(metric, s.last)}${limit ? ` از ${fmt(metric, limit)}` : ""}`}>
      <header className="usage-head">
        <span className="usage-name">
          {name}
          {applet && <span className="faint ltr"> · {applet}</span>}
        </span>
        {pct !== null && <span className="usage-pct num">{faNum(pct, pct < 10 ? 1 : 0)}٪ از پلن</span>}
      </header>

      <div className="usage-now">
        <b className="num">{fmt(metric, s.last)}</b>
        {limit ? <span className="faint">از {fmt(metric, limit)}</span> : <span className="faint">سقف پلن نامعلوم</span>}
      </div>

      {pct !== null && (
        <span className="usage-bar" aria-hidden>
          <i style={{ width: `${Math.min(100, Math.max(pct, 1.5))}%` }} />
          {peakPct !== null && peakPct > pct && <em style={{ left: `${Math.min(100, peakPct)}%` }} title="بیشینه" />}
        </span>
      )}

      {values.length > 1 ? (
        <div className="usage-chart" onPointerMove={onMove} onPointerLeave={() => setHover(null)} aria-hidden>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            <defs>
              <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
                <stop offset="1" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            {limitY !== null && <line className="usage-limit" x1="0" x2={W} y1={limitY} y2={limitY} vectorEffect="non-scaling-stroke" />}
            <polygon points={area} fill={`url(#${gid})`} />
            <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {hover !== null && <line className="usage-cursor" x1={x(hover)} x2={x(hover)} y1="0" y2={H} vectorEffect="non-scaling-stroke" />}
          </svg>
          <span className="usage-dot" style={{ left: `${x(shown)}%`, top: `${(y(values[shown]) / H) * 100}%` }} />
          {limitY !== null && (
            <span className="usage-limit-label" style={{ top: `${(limitY / H) * 100}%` }}>
              سقف پلن
            </span>
          )}
          {hover !== null && (
            <span className="usage-tip" style={{ left: `${x(hover)}%` }} data-edge={hover < values.length * 0.2 ? "start" : hover > values.length * 0.8 ? "end" : undefined}>
              <b>{fmt(metric, values[hover])}</b> <span className="faint">{faTime(at(hover))}</span>
            </span>
          )}
        </div>
      ) : (
        <p className="usage-empty faint small">برای رسم نمودار هنوز داده‌ی کافی نیست.</p>
      )}

      <div className="usage-axis faint">
        <span dir="rtl" title={startedLate ? "کانتینر فعلی از این زمان اجرا شده است؛ داده‌ی کانتینرهای قبلی نشان داده نمی‌شود." : undefined}>
          {startedLate ? `از ${faTime(from)} · شروع کانتینر فعلی` : relativeFa(from)}
        </span>
        <span dir="rtl">{live ? "اکنون" : relativeFa(to)}</span>
      </div>

      <dl className="usage-stats">
        <div>
          <dt>میانگین</dt>
          <dd className="num">{fmt(metric, s.avg)}</dd>
        </div>
        <div>
          <dt>بیشینه</dt>
          <dd className="num">{fmt(metric, s.max)}</dd>
        </div>
        <div>
          <dt>کمینه</dt>
          <dd className="num">{fmt(metric, s.min)}</dd>
        </div>
      </dl>
    </article>
  );
}

function EmptyTile({ metric }: { metric: string }) {
  return (
    <article className="usage">
      <header className="usage-head">
        <span className="usage-name">{NAMES[metric] ?? metric}</span>
      </header>
      <p className="usage-empty faint small">در این بازه داده‌ای ثبت نشده است.</p>
    </article>
  );
}

/** CPU and memory side by side, each read against what the plan allows. */
export function ResourceUsage({
  cpu,
  memory,
  cpuLimit = null,
  memLimit = null,
  hours = 6,
}: {
  cpu: Series[];
  memory: Series[];
  cpuLimit?: number | null;
  memLimit?: number | null;
  hours?: number;
}) {
  const tiles = (metric: string, series: Series[], limit: number | null) => {
    const real = (series ?? []).filter((s) => s.points > 0);
    if (!real.length) return [<EmptyTile key={metric} metric={metric} />];
    return real.map((s, i) => <UsageTile key={`${metric}-${i}`} metric={metric} s={s} limit={limit} hours={hours} applet={real.length > 1 ? s.applet : undefined} />);
  };
  return (
    <div className="usage-grid">
      {tiles("cpu", cpu, cpuLimit)}
      {tiles("memory", memory, memLimit)}
    </div>
  );
}
