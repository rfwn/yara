"use client";

import {
  Activity,
  AlertTriangle,
  BookOpen,
  Boxes,
  Check,
  ChevronLeft,
  Database,
  FileCode,
  FileText,
  FolderTree,
  GitCompare,
  Laptop,
  ScanSearch,
  FolderArchive,
  Globe,
  HardDrive,
  History,
  LoaderCircle,
  Network,
  ScrollText,
  Search,
  Server,
  Stethoscope,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { bytesFa, faDigits } from "@/lib/fa";
import { toolLabel } from "@/lib/tool-labels";

export type ToolPartLike = {
  type: string;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export const toolNameOf = (part: { type: string }) => part.type.replace(/^tool-/, "");

const TOOL_ICONS: Record<string, LucideIcon> = {
  getAccountOverview: UserRound,
  listApps: Boxes,
  getApp: Server,
  getAppLogs: ScrollText,
  getAppEvents: History,
  getAppReleases: History,
  getAppMetrics: Activity,
  diagnoseApp: Stethoscope,
  listDomains: Globe,
  checkDomain: Globe,
  listDisks: HardDrive,
  listDatabases: Database,
  getDatabase: Database,
  listDnsZones: Network,
  listDnsRecords: Network,
  listBuckets: FolderArchive,
  getBucket: FolderArchive,
  listBucketObjects: FolderArchive,
  getObjectInfo: FileText,
  getObjectDownloadLink: FileText,
  searchLiaraDocs: Search,
  readLiaraDocsPage: BookOpen,
  listWorkspaces: Laptop,
  listFiles: FolderTree,
  readFile: FileCode,
  searchCode: ScanSearch,
  detectProject: ScanSearch,
  gitChanges: GitCompare,
  getBuildLogs: ScrollText,
};

// ---------- evidence renderers ----------

type Series = { applet?: string; points: number; last?: number; min?: number; avg?: number; max?: number; samples?: number[] };

const fmtMetric = (metric: string, v?: number) => {
  if (v === undefined) return "–";
  if (metric === "memory") return bytesFa(v);
  if (metric.startsWith("network")) return `${bytesFa(v)}/s`;
  if (metric === "cpu") return `${faDigits(v.toFixed(2))} هسته`;
  return faDigits(v);
};

/** Sparklines in one metric block share a single scale, so instances compare honestly. */
function Sparkline({ values, min, max }: { values: number[]; min: number; max: number }) {
  const w = 140;
  const h = 30;
  if (values.length < 2) return <svg className="spark" width={w} height={h} aria-hidden />;
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`);
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden style={{ direction: "ltr" }}>
      <line className="base" x1="0" x2={w} y1={h - 3} y2={h - 3} strokeWidth="1" strokeDasharray="2 3" />
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const METRIC_NAMES: Record<string, string> = {
  cpu: "پردازنده",
  memory: "حافظه",
  "network-receive": "ورودی شبکه",
  "network-transmit": "خروجی شبکه",
};

export function MetricView({ metric, series }: { metric: string; series: Series[] }) {
  if (!series?.length) return <p className="faint small">در این بازه داده‌ای برای {METRIC_NAMES[metric] ?? metric} ثبت نشده است.</p>;
  const all = series.flatMap((s) => s.samples ?? []);
  const min = Math.min(0, ...all);
  const max = Math.max(...all, 0);
  return (
    <div className="metric">
      {series.map((s, i) => (
        <div key={i} className="metric-row">
          <span className="metric-name">
            {METRIC_NAMES[metric] ?? metric}
            {series.length > 1 && s.applet ? <span className="faint"> · {s.applet}</span> : null}
          </span>
          <Sparkline values={s.samples ?? []} min={min} max={max} />
          <span className="metric-stats">
            اکنون <b>{fmtMetric(metric, s.last)}</b> · میانگین {fmtMetric(metric, s.avg)} · بیشینه {fmtMetric(metric, s.max)}
          </span>
        </div>
      ))}
    </div>
  );
}

type Logs = { lines?: { t: string; stream: string; msg: string }[] };

function LogView({ logs }: { logs: Logs }) {
  if (!logs?.lines?.length) return <p className="faint small">در این بازه لاگی ثبت نشده است.</p>;
  return (
    <div className="logs">
      {logs.lines.map((l, i) => (
        <div key={i} className={l.stream === "stderr" ? "log-line err" : "log-line"}>
          <span className="log-time">{l.t?.slice(11, 19)}</span> {l.msg}
        </div>
      ))}
    </div>
  );
}

function JsonView({ value }: { value: unknown }) {
  let text = JSON.stringify(value, null, 2) ?? "";
  if (text.length > 6000) text = `${text.slice(0, 6000)}\n…`;
  return <pre className="json">{text}</pre>;
}

function EvidenceBody({ name, output }: { name: string; output: any }) {
  if (output && typeof output === "object" && "error" in output && Object.keys(output).length === 1) {
    return <p className="error-text ltr">{String(output.error)}</p>;
  }
  if (name === "getAppLogs") return <LogView logs={output} />;
  if (name === "getAppMetrics") {
    return (
      <>
        {(output?.series ?? []).map((s: any, i: number) =>
          s?.error ? (
            <p key={i} className="error-text ltr">
              {s.error}
            </p>
          ) : (
            <MetricView key={i} metric={s.metric} series={s.series} />
          ),
        )}
      </>
    );
  }
  if (name === "diagnoseApp") {
    return (
      <>
        {output?.cpu?.series && <MetricView metric="cpu" series={output.cpu.series} />}
        {output?.memory?.series && <MetricView metric="memory" series={output.memory.series} />}
        {output?.recentErrors?.lines && <LogView logs={output.recentErrors} />}
        <JsonView value={{ project: output?.project, releases: output?.releases, events: output?.events }} />
      </>
    );
  }
  if (name === "readLiaraDocsPage") {
    return (
      <div className="docs-preview">
        <a href={output?.url} target="_blank" rel="noreferrer" className="link ltr">
          {output?.url}
        </a>
        <p>{String(output?.content ?? "").slice(0, 500)}…</p>
      </div>
    );
  }
  return <JsonView value={output} />;
}

// ---------- the steps list ----------

function Step({ part }: { part: ToolPartLike }) {
  const [open, setOpen] = useState(false);
  const name = toolNameOf(part);
  const Icon = TOOL_ICONS[name] ?? Search;
  const running = part.state === "input-streaming" || part.state === "input-available";
  const output = part.output as any;
  const failed = part.state === "output-error" || (output && typeof output === "object" && "error" in output && Object.keys(output).length === 1);

  return (
    <li className="step" data-open={open}>
      <button type="button" className="step-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={running}>
        <Icon size={15} className="step-icon" aria-hidden />
        <span className="step-label">{toolLabel(name, part.input)}</span>
        {running ? (
          <span className="pill pill-accent">
            <LoaderCircle size={12} className="spin" aria-hidden /> در حال اجرا
          </span>
        ) : failed ? (
          <span className="pill pill-danger">
            <AlertTriangle size={12} aria-hidden /> خطا
          </span>
        ) : (
          <Check size={15} strokeWidth={2.4} style={{ color: "var(--ok)" }} aria-label="انجام شد" />
        )}
        <ChevronLeft size={14} className="step-chev" aria-hidden />
      </button>
      {open && !running && (
        <div className="step-body">
          {part.state === "output-error" ? <p className="error-text ltr">{part.errorText}</p> : <EvidenceBody name={name} output={output} />}
        </div>
      )}
    </li>
  );
}

export function Steps({ parts }: { parts: ToolPartLike[] }) {
  return (
    <ol className="steps" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="مراحل بررسی">
      {parts.map((p) => (
        <Step key={p.toolCallId} part={p} />
      ))}
    </ol>
  );
}
