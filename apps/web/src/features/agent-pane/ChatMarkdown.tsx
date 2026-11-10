import { isValidElement, memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentFiles, Check, Copy } from "../ui-theme/app-icons.js";
import { AgentFileMentionContext } from "../terminal-pane/agent-file-mention-context.js";
import { writeClipboardText } from "../clipboard-dock/clipboard-events.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

/** `label` is Space's English text (or already translated): it is looked up here so callers outside this folder need no change. */
export function ChatCopyButton({ text, label: englishLabel }: { text: string; label: string }) {
  const language = useUiLanguage();
  const t = (value: string, vars?: Record<string, string | number>) => uiText(language, value, vars);
  const label = t(englishLabel);
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
    }}>{status === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}<span>{status === "copied" ? t("Copied") : label}</span></button>
    <span role="status" className={status === "failed" ? "chat-copy-error" : "sr-only"}>{status === "failed" ? t("Copy failed. Select the text and copy it manually.") : status === "copied" ? t("Copied to clipboard") : ""}</span>
  </span>;
}

// No raw HTML, embedded media, or automatic remote image requests from model output.
// Relative links are restricted to Space artifact downloads and page fragments.
export function safeChatUrl(url: string): string | undefined {
  if (/^(?:https?:\/\/|mailto:)/i.test(url)) return url;
  if (/^\/api\/artifacts\/[A-Za-z0-9%:_-]+\/download(?:\?[^\s]*)?$/.test(url)) return url;
  if (/^#[A-Za-z0-9_-]+$/.test(url)) return url;
  // A workspace file's link (AgentFileLinks.tsx): opened only through the Agent Files preview, never navigated to.
  if (/^\/api\/nous\/files\/agent-file\?path=[^\s]+$/.test(url)) return url;
  return undefined;
}

function ChatCodeBlock({ children }: { children?: ReactNode }) {
  const language = useUiLanguage();
  const t = (value: string) => uiText(language, value);
  const code = isValidElement<{ children?: ReactNode }>(children) ? children.props.children : "";
  const text = typeof code === "string" ? code : "";
  return <div className="chat-code-block"><div className="chat-code-toolbar"><span>{t("Code")}</span><ChatCopyButton text={text} label={t("Copy code")} /></div><pre tabIndex={0} aria-label={t("Code block")}>{children}</pre></div>;
}

function ChatLink({ href, children }: { href?: string; children?: ReactNode }) {
  const language = useUiLanguage();
  const agentFiles = useContext(AgentFileMentionContext);
  // Agent Files names, `artifact:` ids and workspace paths open the preview (a path is filed in Agent Files on the click).
  if (agentFiles && href && (agentFiles.artifact(href) || /^\/api\/(?:artifacts\/[^/?#]+\/download|nous\/files\/agent-file\?path=)/.test(href))) {
    return <a href={href} className="chat-agent-file-link" title={uiText(language, "Open the Agent Files preview")} onClick={(event) => {
      event.preventDefault();
      agentFiles.openHref(href);
    }}>{children}<AgentFiles aria-hidden="true" /></a>;
  }
  return href
    ? <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>;
}

function ChatImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const language = useUiLanguage();
  return typeof src === "string" && src
    ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || uiText(language, "Open image")}</a>
    : <span>{alt || uiText(language, "Image")}</span>;
}

function ChatTable({ children }: { children?: ReactNode }) {
  const language = useUiLanguage();
  return <div className="chat-table-scroll" tabIndex={0} role="region" aria-label={uiText(language, "Table")}><table>{children}</table></div>;
}

const components: Components = {
  a: ChatLink,
  img: ChatImage,
  pre: ({ children }) => <ChatCodeBlock>{children}</ChatCodeBlock>,
  table: ChatTable
};

export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  const agentFiles = useContext(AgentFileMentionContext);
  return <div className="chat-markdown"><Markdown remarkPlugins={agentFiles ? [remarkGfm, agentFiles.remark] : [remarkGfm]} skipHtml urlTransform={safeChatUrl} components={components}>{content}</Markdown></div>;
});
