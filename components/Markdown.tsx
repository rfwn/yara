"use client";

import { Check, Copy } from "lucide-react";
import { useRef, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function CodeBlock({ node: _node, children, ...rest }: ComponentProps<"pre"> & { node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ref.current?.innerText ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked; nothing to do
    }
  };
  return (
    <div className="codeblock">
      <button type="button" className="btn btn-sm copy" onClick={copy} aria-label="کپی کد">
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {copied ? "کپی شد" : "کپی"}
      </button>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
    </div>
  );
}

/** Persian-majority text is RTL even when it starts with an English identifier. */
function directionOf(text: string): "rtl" | "ltr" {
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  const fa = (prose.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (prose.match(/[A-Za-z]/g) ?? []).length;
  return fa > 0 && fa >= latin * 0.3 ? "rtl" : latin ? "ltr" : "rtl";
}

export function Markdown({ text, className = "md" }: { text: string; className?: string }) {
  return (
    <div className={className} dir={directionOf(text)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CodeBlock,
          a: ({ node: _node, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
          table: ({ node: _node, ...p }) => (
            <div className="table-wrap">
              <table {...p} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
