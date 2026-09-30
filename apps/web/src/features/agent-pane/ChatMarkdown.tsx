import { isValidElement, memo, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "../ui-theme/app-icons.js";
import { writeClipboardText } from "../clipboard-dock/clipboard-events.js";

export function ChatCopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setStatus("idle");
  }, [text]);
  useEffect(() => {
    if (status === "idle") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [status]);
  return <span className="chat-copy-control">
    <button type="button" aria-label={label} title={label} disabled={pending} onClick={async () => {
      setPending(true);
      try {
        await writeClipboardText(text);
        if (mounted.current) setStatus("copied");
      } catch {
        if (mounted.current) setStatus("failed");
      } finally {
        if (mounted.current) setPending(false);
      }
    }}>{status === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}<span>{status === "copied" ? "Copied" : label}</span></button>
    <span role="status" className={status === "failed" ? "chat-copy-error" : "sr-only"}>{status === "failed" ? "Copy failed. Select the text and copy it manually." : status === "copied" ? "Copied to clipboard" : ""}</span>
  </span>;
}

// No raw HTML, embedded media, or automatic remote image requests from model output.
// Relative links are restricted to Space artifact downloads and page fragments.
export function safeChatUrl(url: string): string | undefined {
  if (/^(?:https?:\/\/|mailto:)/i.test(url)) return url;
  if (/^\/api\/artifacts\/[A-Za-z0-9%:_-]+\/download(?:\?[^\s]*)?$/.test(url)) return url;
  if (/^#[A-Za-z0-9_-]+$/.test(url)) return url;
  return undefined;
}

function ChatCodeBlock({ children }: { children?: ReactNode }) {
  const code = isValidElement<{ children?: ReactNode }>(children) ? children.props.children : "";
  const text = typeof code === "string" ? code : "";
  return <div className="chat-code-block"><div className="chat-code-toolbar"><span>Code</span><ChatCopyButton text={text} label="Copy code" /></div><pre tabIndex={0} aria-label="Code block">{children}</pre></div>;
}

const components: Components = {
  a: ({ href, children }) => href
    ? <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>,
  img: ({ src, alt }) => typeof src === "string" && src
    ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || "Open image"}</a>
    : <span>{alt || "Image"}</span>,
  pre: ({ children }) => <ChatCodeBlock>{children}</ChatCodeBlock>,
  table: ({ children }) => <div className="chat-table-scroll" tabIndex={0} role="region" aria-label="Table"><table>{children}</table></div>
};

export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  return <div className="chat-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeChatUrl} components={components}>{content}</Markdown></div>;
});
