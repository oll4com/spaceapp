import { useState } from "react";
import { ArrowUp, CircleAlert, Clock3, Loader2, MessageSquare, RotateCw, ShieldCheck, Sparkles, X } from "../ui-theme/app-icons.js";
import type { AgentPaneMessage, AgentPaneTaskRun, CodexThreadItem } from "@space/contracts";
import { ChatCopyButton, ChatMarkdown } from "./ChatMarkdown.js";
import { TaskDetails } from "./TaskDetails.js";

type VisibleChatMessage = Pick<CodexThreadItem, "id" | "role" | "content" | "createdAt">;

const internalSpaceActionBlockPattern =
  /```space-(?:room|memory|clipboard|chat|task|skill|mcp|browser)-actions\b[\s\S]*?(?:```|$)/gi;

export function visibleAssistantContent(content: string): string {
  return content
    .replace(internalSpaceActionBlockPattern, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function visibleCodexThreadItems(items: CodexThreadItem[]): CodexThreadItem[] {
  return items.flatMap((item) => {
    if (
      (item.role !== "user" && item.role !== "assistant") ||
      (item.kind !== "message" && (item.kind !== "event" || item.rawType !== "agent_message"))
    ) return [];
    const content = item.role === "assistant" ? visibleAssistantContent(item.content) : item.content;
    return content.trim().length > 0 ? [{ ...item, content }] : [];
  });
}

export function visibleChatMessages(
  items: CodexThreadItem[],
  messages: AgentPaneMessage[]
): VisibleChatMessage[] {
  const nativeItems = visibleCodexThreadItems(items);
  if (nativeItems.length) return nativeItems;
  return messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const content = message.role === "assistant" ? visibleAssistantContent(message.content) : message.content;
    return content.trim().length > 0 ? [{ ...message, content }] : [];
  });
}

export function copyableCodexTranscript(items: CodexThreadItem[], messages: AgentPaneMessage[] = []): string {
  return visibleChatMessages(items, messages)
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

function AgentOrbit({ active = false }: { active?: boolean }) {
  return (
    <span className={`room-agent-orbit${active ? " active" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 64 64" fill="none">
        <g className="room-agent-orbit-rings" stroke="currentColor">
          <circle cx="32" cy="32" r="22" strokeOpacity=".48" />
          <ellipse cx="32" cy="32" rx="22" ry="9" transform="rotate(-38 32 32)" strokeOpacity=".75" />
          <circle cx="11" cy="27" r="2.5" fill="currentColor" stroke="none" />
        </g>
        <path d="m32 21 2.8 8.2L43 32l-8.2 2.8L32 43l-2.8-8.2L21 32l8.2-2.8L32 21Z" stroke="currentColor" />
        <circle cx="32" cy="32" r="2" fill="currentColor" />
      </svg>
    </span>
  );
}

function CodexRunningIndicator({ elapsedSeconds, providerName, runStatus }: { elapsedSeconds: number; providerName: string; runStatus: string }) {
  const isActive = runStatus === "RUNNING";
  const title = runStatus === "QUEUED" ? "Waiting to start" : runStatus === "INTERRUPTING" ? "Stopping this task" : "Working on your request";
  return (
    <section className={`codex-running-row${isActive ? "" : " waiting"}`} role="status" aria-label={title}>
      <div className="room-agent-activity-top">
        <AgentOrbit active={isActive} />
        <div><strong>{title}</strong><span>{providerName} {isActive ? "is working" : runStatus === "QUEUED" ? "is next" : "is stopping"}</span></div>
        <time className="codex-running-timer" aria-label="Elapsed time"><Clock3 aria-hidden="true" /> {formatElapsed(elapsedSeconds)}</time>
      </div>
      <div className="room-agent-activity-line" aria-hidden="true"><span /></div>
      <p>{runStatus === "INTERRUPTING" ? "Keeping the conversation while the task stops." : "I'll show the result here as soon as it's ready."}</p>
    </section>
  );
}

function RoomAgentWelcome({ onAsk, onSetGoal }: { onAsk?: () => void; onSetGoal?: () => void }) {
  return (
    <section className="codex-transcript-empty room-agent-welcome" aria-label="Start a conversation">
      <div className="room-agent-welcome-art" aria-hidden="true">
        <span className="room-agent-welcome-orbit room-agent-welcome-orbit-outer" />
        <span className="room-agent-welcome-orbit room-agent-welcome-orbit-inner" />
        <AgentOrbit />
      </div>
      <div className="room-agent-welcome-copy">
        <span className="room-agent-welcome-eyebrow"><span className="room-agent-ready-dot" /> Room Agent is ready</span>
        <h2>What would you like to get done?</h2>
        <p>Ask a question or set a goal. Your work stays in this conversation.</p>
      </div>
      {onAsk || onSetGoal ? <div className="room-agent-welcome-actions">
        {onAsk ? <button type="button" onClick={onAsk}><MessageSquare aria-hidden="true" /><span><strong>Ask anything</strong><small>Start with a message</small></span><ArrowUp aria-hidden="true" /></button> : null}
        {onSetGoal ? <button type="button" onClick={onSetGoal}><Sparkles aria-hidden="true" /><span><strong>Set a goal</strong><small>Keep a task in focus</small></span><ArrowUp aria-hidden="true" /></button> : null}
      </div> : null}
      <span className="room-agent-welcome-footnote">Add files or a screenshot with the + button below.</span>
    </section>
  );
}

export function CodexTranscript({
  items,
  messages,
  latestRun,
  isRunning,
  loading,
  elapsedSeconds,
  providerName,
  goal,
  failureMessage,
  runStatus = "RUNNING",
  onAsk,
  onSetGoal
}: {
  items: CodexThreadItem[];
  messages: AgentPaneMessage[];
  latestRun?: AgentPaneTaskRun | null;
  isRunning: boolean;
  loading: boolean;
  elapsedSeconds: number;
  providerName: string;
  goal?: { objective: string; status: string } | null;
  failureMessage?: string | null;
  runStatus?: string;
  onAsk?: () => void;
  onSetGoal?: () => void;
}) {
  const visibleItems = visibleChatMessages(items, messages).filter((item) => !(failureMessage && item.role === "assistant" && (item.content.trim() === failureMessage.trim() || item.content.startsWith("Codex App Server turn timed out"))));
  return (
    <main className="codex-transcript" aria-live="polite">
      {loading && !visibleItems.length ? <div className="codex-transcript-state" role="status"><Loader2 aria-hidden="true" /><span>Loading task</span></div> : null}
      {!loading && !visibleItems.length && !isRunning ? <RoomAgentWelcome onAsk={onAsk} onSetGoal={onSetGoal} /> : null}
      {goal ? <div className="room-agent-goal-strip"><Sparkles aria-hidden="true" /><div><strong>{goal.objective}</strong><span>Goal · {goal.status.toLowerCase().replaceAll("_", " ")}</span></div></div> : null}
      {visibleItems.map((item) => (
        <article className={`codex-message ${item.role ?? "assistant"}`} key={item.id}>
          {item.role === "assistant" ? <><span className="room-agent-message-label"><AgentOrbit /> Room Agent</span><ChatMarkdown content={item.content} /></> : <p>{item.content}</p>}
          <div className="chat-message-footer">
            {item.createdAt ? <time dateTime={item.createdAt}>{itemTime(item.createdAt)}</time> : null}
            {item.role === "assistant" ? <ChatCopyButton text={item.content} label="Copy response" /> : null}
          </div>
        </article>
      ))}
      {latestRun ? <TaskDetails key={latestRun.runId} run={latestRun} /> : null}
      {isRunning ? <CodexRunningIndicator elapsedSeconds={elapsedSeconds} providerName={providerName} runStatus={runStatus} /> : null}
    </main>
  );
}

export function CodexNotification({
  tone,
  title,
  message,
  onDismiss,
  onRetry,
  retryLabel = "Try again",
  retryDisabled = false
}: {
  tone: "error" | "warning" | "info";
  title?: string;
  message: string;
  onDismiss?: () => void;
  onRetry?: () => void;
  retryLabel?: string;
  retryDisabled?: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const isError = tone === "error";
  return (
    <div className={`codex-notification ${tone}`} role={isError ? "alert" : "status"}>
      {isError ? <CircleAlert className="room-agent-notice-icon" aria-hidden="true" /> : <ShieldCheck className="room-agent-notice-icon" aria-hidden="true" />}
      <div className="room-agent-notice-copy">
        <strong>{title ?? (isError ? "This task needs attention" : tone === "warning" ? "Check this setting" : "Update")}</strong>
        {!isError || showDetails ? <span>{message}</span> : <span>The task could not finish. Your conversation is still here.</span>}
      </div>
      {isError ? <button type="button" aria-expanded={showDetails} onClick={() => setShowDetails(current => !current)}>{showDetails ? "Hide details" : "Details"}</button> : null}
      {onRetry ? <button type="button" onClick={onRetry} disabled={retryDisabled} aria-label={retryLabel === "Try again" ? "Retry" : retryLabel}><RotateCw aria-hidden="true" /><span>{retryLabel}</span></button> : null}
      {onDismiss ? <button type="button" onClick={onDismiss} aria-label="Dismiss notification"><X aria-hidden="true" /></button> : null}
    </div>
  );
}
