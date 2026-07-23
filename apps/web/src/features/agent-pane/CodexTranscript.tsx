import { ChevronRight, Clock3, Loader2, RotateCw, Wrench, X } from "lucide-react";
import type { CodexThreadItem } from "@space/contracts";

export function visibleCodexThreadItems(items: CodexThreadItem[]): CodexThreadItem[] {
  return items.filter(
    (item) =>
      item.kind === "reasoning" ||
      item.kind === "tool_call" ||
      item.kind === "tool_result" ||
      (item.kind === "message" && (item.role === "user" || item.role === "assistant"))
  );
}

export function copyableCodexTranscript(items: CodexThreadItem[]): string {
  return visibleCodexThreadItems(items)
    .map((item) => {
      if (item.kind === "message") return `${item.role === "user" ? "User" : "Assistant"}:\n${item.content}`;
      if (item.kind === "reasoning") return `Reasoning:\n${item.content}`;
      return `${item.kind === "tool_call" ? "Tool call" : "Tool result"}${item.toolName ? ` (${item.toolName})` : ""}:\n${item.content}`;
    })
    .join("\n\n");
}

function itemTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function CodexWorkRow({ item }: { item: CodexThreadItem }) {
  const reasoning = item.kind === "reasoning";
  const title = reasoning ? "Thought for a moment" : `Worked with ${item.toolName ?? "tool"}`;
  return (
    <details className={`codex-work-row ${item.kind}`}>
      <summary>
        <ChevronRight className="codex-work-chevron" aria-hidden="true" />
        {reasoning ? <Clock3 aria-hidden="true" /> : <Wrench aria-hidden="true" />}
        <span>{title}</span>
      </summary>
      {item.content ? <pre>{item.content}</pre> : <p>No additional output</p>}
    </details>
  );
}

export function CodexTranscript({ items, isRunning, loading }: { items: CodexThreadItem[]; isRunning: boolean; loading: boolean }) {
  const visibleItems = visibleCodexThreadItems(items);
  return (
    <main className="codex-transcript" aria-live="polite">
      {loading && !visibleItems.length ? <div className="codex-transcript-state" role="status"><Loader2 aria-hidden="true" /><span>Loading task</span></div> : null}
      {!loading && !visibleItems.length ? <div className="codex-transcript-empty" role="status"><strong>Start a new task</strong><span>Ask Codex to work in this Space.</span></div> : null}
      {visibleItems.map((item) => {
        if (item.kind === "reasoning" || item.kind === "tool_call" || item.kind === "tool_result") return <CodexWorkRow item={item} key={item.id} />;
        return (
          <article className={`codex-message ${item.role ?? "assistant"}`} key={item.id}>
            <p>{item.content}</p>
            {item.createdAt ? <time>{itemTime(item.createdAt)}</time> : null}
          </article>
        );
      })}
      {isRunning ? <div className="codex-running-row" role="status"><Loader2 aria-hidden="true" /><span>Codex is working</span></div> : null}
    </main>
  );
}

export function CodexNotification({
  tone,
  message,
  onDismiss,
  onRetry
}: {
  tone: "error" | "warning" | "info";
  message: string;
  onDismiss?: () => void;
  onRetry?: () => void;
}) {
  return (
    <div className={`codex-notification ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span>{message}</span>
      {onRetry ? <button type="button" onClick={onRetry}><RotateCw aria-hidden="true" /><span>Retry</span></button> : null}
      {onDismiss ? <button type="button" onClick={onDismiss} aria-label="Dismiss notification"><X aria-hidden="true" /></button> : null}
    </div>
  );
}
