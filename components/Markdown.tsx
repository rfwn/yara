"use client";

import { Check, Copy } from "lucide-react";
import { Children, useRef, useState, type ComponentProps, type ReactNode } from "react";
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

// Latin runs inside Persian prose (g2-small, api.liara.run, 0.0.0.0:3000) are isolated as one LTR unit,
// so the bidi algorithm neither splits them at a hyphen nor mirrors the punctuation around them.
const LATIN_RUN = /([A-Za-z0-9][\w.\-/:@]*[A-Za-z0-9]|[A-Za-z])/g;
function isolateLatin(children: ReactNode): ReactNode {
  return Children.map(children, (c) => {
    if (typeof c !== "string" || !/[؀-ۿ]/.test(c)) return c;
    return c.split(LATIN_RUN).map((part, i) =>
      i % 2 ? (
        <bdi key={i} className="ltr-run" dir="ltr">
          {part}
        </bdi>
      ) : (
        part
      ),
    );
  });
}

export function Markdown({ text, className = "md" }: { text: string; className?: string }) {
  return (
    <div className={className} dir={directionOf(text)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CodeBlock,
          p: ({ node: _node, children, ...p }) => <p {...p}>{isolateLatin(children)}</p>,
          li: ({ node: _node, children, ...p }) => <li {...p}>{isolateLatin(children)}</li>,
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
