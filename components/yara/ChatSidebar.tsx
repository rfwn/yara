"use client";

import { ArrowRight, History, MessageSquare, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { relativeFa } from "@/lib/fa";
import { LogoMark } from "./Logo";
import type { Ask, CaseSummary } from "./Workbench";
import { AgentPane } from "./agent/AgentPane";
import type { AgentEvent } from "./agent/timeline";

/** Yara lives in its own full-height sidebar, with its conversation history inside it. */
export function ChatSidebar({
  chatId,
  initialEvents,
  app,
  ask,
  onAskConsumed,
  cases,
  onOpenChat,
  onNewChat,
  onDeleted,
  onClose,
  onResizeStart,
  resizing,
}: {
  chatId: string;
  initialEvents: AgentEvent[] | null;
  app?: string;
  ask: Ask | null;
  onAskConsumed: () => void;
  cases: CaseSummary[];
  onOpenChat: (id: string) => void;
  onNewChat: () => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
  onResizeStart: (e: React.PointerEvent) => void;
  resizing: boolean;
}) {
  const [history, setHistory] = useState(false);
  const current = cases.find((c) => c.id === chatId);

  const remove = async (c: CaseSummary) => {
    if (!confirm(`«${c.title}» برای همیشه حذف شود؟`)) return;
    await fetch(`/api/chats/${c.id}`, { method: "DELETE" });
    onDeleted(c.id);
  };

  return (
    <aside className="chatbar" aria-label="یارا">
      <div className="chat-resize" data-drag={resizing} onPointerDown={onResizeStart} aria-hidden />
      <header className="chat-head">
        {history ? (
          <>
            <button type="button" className="icon-btn" onClick={() => setHistory(false)} aria-label="بازگشت به گفت‌وگو">
              <ArrowRight size={15} aria-hidden />
            </button>
            <span className="chat-title">گفت‌وگوهای قبلی</span>
          </>
        ) : (
          <>
            <LogoMark size={20} />
            <span className="chat-title" dir="auto" title={current?.title}>
              {current?.title ?? "یارا"}
            </span>
          </>
        )}
        <span className="chat-tools">
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              setHistory(false);
              onNewChat();
            }}
            aria-label="گفت‌وگوی تازه"
            title="گفت‌وگوی تازه"
          >
            <Plus size={16} aria-hidden />
          </button>
          <button type="button" className="icon-btn" onClick={() => setHistory((h) => !h)} aria-pressed={history} aria-label="گفت‌وگوهای قبلی" title="گفت‌وگوهای قبلی">
            <History size={15} aria-hidden />
          </button>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="بستن یارا" title="بستن">
            <X size={15} aria-hidden />
          </button>
        </span>
      </header>

      {history ? (
        <div className="chat-history">
          {cases.length === 0 ? (
            <p className="ex-note" style={{ paddingInline: 16 }}>
              هنوز گفت‌وگویی ندارید.
            </p>
          ) : (
            <ul className="ex-list">
              {cases.map((c) => (
                <li key={c.id} className="sb-case">
                  <button
                    type="button"
                    className="ex-item"
                    aria-current={c.id === chatId ? "true" : undefined}
                    style={{ height: 34, paddingInline: "14px 10px" }}
                    onClick={() => {
                      onOpenChat(c.id);
                      setHistory(false);
                    }}
                  >
                    <MessageSquare size={14} aria-hidden />
                    <span className="grow" dir="auto">
                      {c.title}
                    </span>
                    <span className="trail num">{relativeFa(c.updatedAt)}</span>
                  </button>
                  <button type="button" className="icon-btn row-action" aria-label={`حذف ${c.title}`} onClick={() => remove(c)}>
                    <Trash2 size={13} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        chatId && <AgentPane key={chatId} chatId={chatId} initialEvents={initialEvents ?? []} app={app} ask={ask} onAskConsumed={onAskConsumed} />
      )}
    </aside>
  );
}
