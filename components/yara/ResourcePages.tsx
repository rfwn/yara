"use client";

import { Bot, Database, FileText, Folder, FolderArchive, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { bytesFa, faDigits, relativeFa } from "@/lib/fa";
import { ResourceUsage } from "./Usage";
import { useWorkbench } from "./Workbench";

export function useDetail<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(url);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "بارگذاری نشد.");
      setData(d);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, loading, load };
}

export function Skeleton() {
  return (
    <div className="box">
      <div className="body" style={{ display: "grid", gap: 12 }}>
        <span className="skeleton" style={{ width: "40%" }} />
        <span className="skeleton" style={{ width: "65%" }} />
        <span className="skeleton" style={{ width: "50%" }} />
      </div>
    </div>
  );
}

// ---------- database ----------

type Db = {
  id: string;
  name: string;
  type: string;
  version: string | null;
  status: string;
  on: boolean;
  plan: string | null;
  publicNetwork: boolean;
  backups: { name: string; size: number | null; at: string | null }[];
  cpu: any[];
  memory: any[];
};

export function DatabasePage({ id }: { id: string }) {
  const wb = useWorkbench();
  const { data: d, error, loading, load } = useDetail<Db>(`/api/databases/${encodeURIComponent(id)}`);
  const up = d && d.on && !/fail|error|stop/i.test(d.status);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>
            <Database size={18} aria-hidden style={{ color: "var(--text-3)" }} />
            <span className="ltr">{d?.name ?? id}</span>
            {d && <span className={`pill ${up ? "pill-ok" : d.on ? "pill-danger" : ""}`}>{up ? "فعال" : d.on ? "دچار خطا" : "خاموش"}</span>}
          </h1>
          {d && (
            <p className="sub">
              <span className="ltr">
                {d.type}
                {d.version ? ` ${d.version}` : ""}
              </span>
              {d.plan && (
                <>
                  {" "}
                  · پلن <span className="ltr">{d.plan}</span>
                </>
              )}{" "}
              · {d.publicNetwork ? "دسترسی از اینترنت باز است" : "فقط شبکه‌ی خصوصی"}
            </p>
          )}
        </div>
        <div className="toolbar">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => wb.askYara(`دیتابیس ${d?.name ?? id} (شناسه ${id}) را بررسی کن: وضعیت، مصرف منابع و پشتیبان‌ها.`)}
          >
            <Bot size={14} aria-hidden />
            بررسی با یارا
          </button>
          <button type="button" className="icon-btn" onClick={load} aria-label="به‌روزرسانی" title="به‌روزرسانی">
            <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden />
          </button>
        </div>
      </div>

      {error ? (
        <div className="alert" role="alert">
          <span className="ltr">{error}</span>
        </div>
      ) : !d ? (
        <Skeleton />
      ) : (
        <>
          <section className="box">
            <h2>
              مصرف منابع <span className="faint small">۶ ساعت اخیر</span>
            </h2>
            <div className="body">
              <ResourceUsage cpu={d.cpu} memory={d.memory} />
            </div>
          </section>
          <section className="box">
            <h2>
              پشتیبان‌ها
              <button type="button" className="btn btn-ghost" style={{ height: 26 }} onClick={() => wb.askYara(`از دیتابیس ${d.name} (شناسه ${id}) یک پشتیبان بگیر.`)}>
                پشتیبان تازه با یارا
              </button>
            </h2>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">نام</th>
                    <th scope="col">حجم</th>
                    <th scope="col">زمان</th>
                  </tr>
                </thead>
                <tbody>
                  {d.backups.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="muted">
                        پشتیبانی ثبت نشده است.
                      </td>
                    </tr>
                  ) : (
                    d.backups.map((b) => (
                      <tr key={b.name}>
                        <td className="ltr" style={{ textAlign: "right" }}>
                          {b.name}
                        </td>
                        <td className="muted">{b.size ? bytesFa(b.size) : "–"}</td>
                        <td className="muted">{b.at ? relativeFa(new Date(b.at).getTime()) : "–"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

// ---------- bucket ----------

type Bucket = {
  name: string;
  plan: string | null;
  permission: string | null;
  status: string;
  endpoint: string | null;
  objectCount: number | null;
  totalBytes: number | null;
  folders: string[];
  objects: { key: string; size: number; modified: string }[];
  listingError: boolean;
};

export function BucketPage({ name }: { name: string }) {
  const wb = useWorkbench();
  const { data: b, error, loading, load } = useDetail<Bucket>(`/api/buckets/${encodeURIComponent(name)}`);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>
            <FolderArchive size={18} aria-hidden style={{ color: "var(--text-3)" }} />
            <span className="ltr">{name}</span>
            {b?.permission && <span className={`pill ${b.permission === "public" ? "pill-warn" : ""}`}>{b.permission === "public" ? "عمومی" : "خصوصی"}</span>}
          </h1>
          {b && (
            <p className="sub">
              {b.objectCount !== null && <>{faDigits(b.objectCount)} فایل · </>}
              {b.totalBytes !== null && <>{bytesFa(b.totalBytes)} · </>}
              {b.plan && (
                <>
                  پلن <span className="ltr">{b.plan}</span>
                </>
              )}
              {b.endpoint && (
                <>
                  {" "}
                  · <span className="ltr">{b.endpoint}</span>
                </>
              )}
            </p>
          )}
        </div>
        <div className="toolbar">
          <button type="button" className="btn btn-primary" onClick={() => wb.askYara(`باکت ${name} را بررسی کن: حجم، دسترسی و فایل‌های اصلی.`)}>
            <Bot size={14} aria-hidden />
            بررسی با یارا
          </button>
          <button type="button" className="icon-btn" onClick={load} aria-label="به‌روزرسانی" title="به‌روزرسانی">
            <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden />
          </button>
        </div>
      </div>

      {error ? (
        <div className="alert" role="alert">
          <span className="ltr">{error}</span>
        </div>
      ) : !b ? (
        <Skeleton />
      ) : (
        <section className="box">
          <h2>فایل‌های ریشه</h2>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">نام</th>
                  <th scope="col">حجم</th>
                  <th scope="col">آخرین تغییر</th>
                </tr>
              </thead>
              <tbody>
                {b.listingError && (
                  <tr>
                    <td colSpan={3} className="muted">
                      فهرست فایل‌ها از لیارا دریافت نشد. از یارا بخواهید بررسی کند.
                    </td>
                  </tr>
                )}
                {!b.listingError && b.folders.length + b.objects.length === 0 && (
                  <tr>
                    <td colSpan={3} className="muted">
                      این باکت خالی است.
                    </td>
                  </tr>
                )}
                {b.folders.map((f) => (
                  <tr key={f}>
                    <td>
                      <span className="row-link">
                        <Folder size={14} aria-hidden style={{ color: "var(--text-3)" }} />
                        <span className="ltr">{f}</span>
                      </span>
                    </td>
                    <td className="faint">–</td>
                    <td className="faint">–</td>
                  </tr>
                ))}
                {b.objects.map((o) => (
                  <tr key={o.key}>
                    <td>
                      <span className="row-link" style={{ fontWeight: 500 }}>
                        <FileText size={14} aria-hidden style={{ color: "var(--text-3)" }} />
                        <span className="ltr">{o.key}</span>
                      </span>
                    </td>
                    <td className="muted">{bytesFa(o.size)}</td>
                    <td className="muted">{o.modified ? relativeFa(new Date(o.modified).getTime()) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
