import { Loader2, RotateCw, X } from "../ui-theme/app-icons.js";
import type { CodexThreadItem } from "@space/contracts";

export function visibleCodexThreadItems(items: CodexThreadItem[]): CodexThreadItem[] {
  return items.filter((item) => item.kind === "message" && (item.role === "user" || item.role === "assistant"));
}

export function copyableCodexTranscript(items: CodexThreadItem[]): string {
  return visibleCodexThreadItems(items)
    .map((item) => `${item.role === "user" ? "User" : "Assistant"}:\n${item.content}`)
    .join("\n\n");
}

function itemTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function CodexRunningIndicator({ elapsedSeconds }: { elapsedSeconds: number }) {
  return (
    <div className="codex-running-row" role="status">
      <span className="codex-streaming-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="codex-running-label">
        <span>Codex is working</span>
        <time className="codex-running-timer">{formatElapsed(elapsedSeconds)}</time>
      </span>
    </div>
  );
}

export function CodexTranscript({
  items,
  isRunning,
  loading,
  elapsedSeconds
}: {
  items: CodexThreadItem[];
  isRunning: boolean;
  loading: boolean;
  elapsedSeconds: number;
}) {
  const visibleItems = visibleCodexThreadItems(items);
  return (
    <main className="codex-transcript" aria-live="polite">
      {loading && !visibleItems.length ? <div className="codex-transcript-state" role="status"><Loader2 aria-hidden="true" /><span>Loading task</span></div> : null}
      {!loading && !visibleItems.length ? <div className="codex-transcript-empty" role="status"><strong>Start a new task</strong><span>Ask Codex to work in this Space.</span></div> : null}
      {visibleItems.map((item) => (
        <article className={`codex-message ${item.role ?? "assistant"}`} key={item.id}>
          <p>{item.content}</p>
          {item.createdAt ? <time>{itemTime(item.createdAt)}</time> : null}
        </article>
      ))}
      {isRunning ? <CodexRunningIndicator elapsedSeconds={elapsedSeconds} /> : null}
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
