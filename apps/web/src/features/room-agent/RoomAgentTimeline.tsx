import { Fragment, useState, type FormEvent, type ReactNode } from "react";
import type { RoomAgentTimelineMessage } from "@space/contracts";
import {
  ArrowDown, Blend, Check, CircleAlert, CircleHelp, Clock, ExternalLink, Loader2, ShieldAlert, AlertTriangle, Wrench, X
} from "../ui-theme/app-icons.js";
import { DockIconButton } from "../dock-kit/DockKit.js";
import { ChatMarkdown } from "../agent-pane/ChatMarkdown.js";
import { useTranscriptScroll } from "../agent-pane/useTranscriptScroll.js";
import type { RoomAgentStreamState, RoomAgentStreamTool } from "./use-room-agent-stream.js";

export interface RoomAgentPendingMessage {
  id: string;
  content: string;
  createdAt: string;
}

type Meta = Record<string, unknown>;
const text = (meta: Meta | undefined, key: string): string | null => typeof meta?.[key] === "string" ? meta[key] as string : null;

function timeLabel(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

/** "Today", "Yesterday" or the date: one separator where the day changes. */
export function dayLabel(value: string | null, now = new Date()): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = (input: Date) => new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) }).format(date);
}

const toolIcons: Record<string, typeof Check> = {
  RUNNING: Loader2, DONE: Check, FAILED: CircleAlert, REFUSED: ShieldAlert, NEEDS_CONFIRMATION: CircleHelp
};

function ToolRow({ label, status }: { label: string; status: string }) {
  const Icon = toolIcons[status] ?? Wrench;
  return (
    <div className="room-agent-row room-agent-tool-row" data-kind="TOOL" data-status={status}>
      <Icon aria-hidden="true" className={status === "RUNNING" ? "is-spinning" : undefined} />
      <span>{label}</span>
    </div>
  );
}

const eventIcons: Record<string, typeof Check> = {
  FINISHED: Check, WAITING: AlertTriangle, ERROR: CircleAlert, USAGE_LIMIT: Clock, SIGN_IN: ShieldAlert, STUCK: Clock, OVERLAP: Blend
};
const eventStatusLabels: Record<string, string> = {
  OPEN: "New", HANDLED: "Handled", ESCALATED: "Needs you", RESOLVED: "Resolved", ACKED: "Seen"
};

export function roomAgentRowNeedsOperator(message: RoomAgentTimelineMessage): boolean {
  const status = text(message.meta, "status");
  return message.kind === "SYSTEM" && text(message.meta, "severity") === "ATTENTION" && (status === "OPEN" || status === "ESCALATED");
}

function SystemRow({ message, onAnswer, onDismiss, onOpenPane }: {
  message: RoomAgentTimelineMessage;
  onAnswer?: (eventId: string, input: { answer?: string; decline?: boolean }) => Promise<boolean>;
  onDismiss?: (eventId: string) => void;
  onOpenPane?: (paneId: string) => void;
}) {
  const [answering, setAnswering] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const meta = message.meta;
  const eventId = text(meta, "eventId");
  const paneId = text(meta, "paneId");
  const paneName = text(meta, "paneName");
  const status = text(meta, "status") ?? "OPEN";
  const kind = text(meta, "eventKind") ?? "FINISHED";
  const needsYou = roomAgentRowNeedsOperator(message);
  const Icon = eventIcons[kind] ?? CircleAlert;
  async function send(input: { answer?: string; decline?: boolean }, event?: FormEvent) {
    event?.preventDefault();
    if (!onAnswer || !eventId || sending || (!input.decline && !input.answer?.trim())) return;
    setSending(true);
    try {
      if (await onAnswer(eventId, input)) { setAnswering(false); setDraft(""); }
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="room-agent-row room-agent-system-row" data-kind="SYSTEM" data-event-kind={kind} data-status={status} data-attention={needsYou ? "true" : undefined}>
      <div className="room-agent-system-head">
        <Icon aria-hidden="true" />
        <strong>{message.content}</strong>
        <time dateTime={message.createdAt ?? undefined}>{timeLabel(message.createdAt)}</time>
      </div>
      {text(meta, "detail") ? <p className="room-agent-system-detail">{text(meta, "detail")}</p> : null}
      {text(meta, "decision") ? <p className="room-agent-system-decision">{text(meta, "decision")}</p> : null}
      {answering ? (
        <form className="room-agent-system-answer" onSubmit={(event) => void send({ answer: draft }, event)}>
          <input autoFocus value={draft} maxLength={2000} placeholder={`Answer for ${paneName ?? "the pane"}, e.g. 1, y or a reply`}
            aria-label={`Answer for ${paneName ?? "the pane"}`} onChange={(event) => setDraft(event.target.value)} />
          <button type="submit" className="dock-kit-chip" disabled={sending || !draft.trim()}>Send</button>
          <button type="button" className="dock-kit-chip" disabled={sending} onClick={() => setAnswering(false)}>Cancel</button>
        </form>
      ) : null}
      <div className="room-agent-system-actions">
        <span className="room-agent-system-status">{eventStatusLabels[status] ?? status}</span>
        {onAnswer && eventId && paneId && needsYou && !answering ? (
          <>
            <button type="button" className="dock-kit-chip" disabled={sending} onClick={() => { setAnswering(true); setDraft(""); }}>Answer</button>
            <button type="button" className="dock-kit-chip" disabled={sending} onClick={() => void send({ decline: true })}>Decline</button>
          </>
        ) : null}
        {paneId && onOpenPane ? <DockIconButton label={`Open ${paneName ?? "pane"}`} icon={ExternalLink} onClick={() => onOpenPane(paneId)} /> : null}
        {eventId && onDismiss ? <DockIconButton label="Dismiss" icon={X} onClick={() => onDismiss(eventId)} /> : null}
      </div>
    </div>
  );
}

const confirmationLabels: Record<string, string> = { CONFIRMED: "Done", DECLINED: "Not done", EXPIRED: "Expired" };

function ConfirmationRow({ message, busy, onReply }: {
  message: RoomAgentTimelineMessage;
  busy: boolean;
  onReply?: (token: string, yes: boolean) => void;
}) {
  const token = text(message.meta, "token");
  const status = text(message.meta, "status") ?? "PENDING";
  const result = text(message.meta, "result");
  return (
    <div className="room-agent-row room-agent-confirmation-row" data-kind="CONFIRMATION" data-status={status}>
      <CircleHelp aria-hidden="true" />
      <span className="room-agent-confirmation-text">{message.content}{status === "PENDING" ? "?" : ""}</span>
      {status === "PENDING" && token && onReply ? (
        <span className="room-agent-confirmation-actions">
          <button type="button" className="dock-kit-chip is-primary" disabled={busy} onClick={() => onReply(token, true)}>Yes</button>
          <button type="button" className="dock-kit-chip" disabled={busy} onClick={() => onReply(token, false)}>No</button>
        </span>
      ) : (
        <span className="room-agent-confirmation-status">{confirmationLabels[status] ?? status}{result && status === "CONFIRMED" ? ` · ${result}` : ""}</span>
      )}
    </div>
  );
}

function AssistantBubble({ content, status, streaming, createdAt }: { content: string; status: string; streaming: boolean; createdAt: string | null }) {
  const thinking = !content.trim() && (status === "RUNNING" || streaming);
  return (
    <div className="room-agent-row" data-kind="CHAT">
      <div className={`room-agent-bubble is-assistant${status === "FAILED" ? " is-failed" : ""}${status === "INTERRUPTED" ? " is-interrupted" : ""}`}
        aria-busy={streaming || status === "RUNNING" ? true : undefined}>
        {thinking ? (
          <p className="room-agent-thinking">
            <span className="room-agent-thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
            <span>Thinking…</span>
          </p>
        ) : (
          <div className="room-agent-markdown">
            <ChatMarkdown content={content} />
            {streaming ? <span className="room-agent-caret" aria-hidden="true" /> : null}
          </div>
        )}
        {!thinking && !streaming && createdAt ? <time dateTime={createdAt}>{timeLabel(createdAt)}</time> : null}
      </div>
    </div>
  );
}

/**
 * The whole conversation as one log: what the operator said (right), the Room Agent's answers (left, full width), the
 * tools a turn used just before its answer, what the room monitor saw, and actions waiting for a yes.
 */
export function RoomAgentTimeline({ conversationId, messages, pending, stream, isVisible, empty, busyReplying, onConfirmReply, onAnswerEvent, onDismissEvent, onOpenPane }: {
  conversationId: string | null;
  messages: RoomAgentTimelineMessage[];
  /** Operator messages still on their way to the server. */
  pending: RoomAgentPendingMessage[];
  stream: RoomAgentStreamState;
  isVisible: boolean;
  /** Shown when there is nothing to show yet. */
  empty: ReactNode;
  busyReplying: boolean;
  onConfirmReply?: (token: string, yes: boolean) => void;
  onAnswerEvent?: (eventId: string, input: { answer?: string; decline?: boolean }) => Promise<boolean>;
  onDismissEvent?: (eventId: string) => void;
  onOpenPane?: (paneId: string) => void;
}) {
  const ids = new Set(messages.map((message) => message.id));
  const streamTools = stream.tools.filter((tool) => !ids.has(tool.rowId) && tool.status !== "NEEDS_CONFIRMATION");
  const streamOpen = Boolean(stream.messageId) && stream.phase !== "done" && stream.phase !== "error";
  const streamHasRow = Boolean(stream.messageId && ids.has(stream.messageId));
  const hasContent = messages.length > 0 || pending.length > 0 || (streamOpen && !streamHasRow);
  const { transcriptRef, handleTranscriptScroll, showJumpToLatest, jumpToLatest } = useTranscriptScroll({
    conversationId, hasContent, contentVersion: `${messages.length}:${messages.at(-1)?.content.length ?? 0}:${pending.length}:${stream.version}`, isVisible
  });
  const toolRows = (tools: RoomAgentStreamTool[]) => tools.map((tool) => <ToolRow key={tool.rowId} label={tool.label} status={tool.status} />);
  let lastDay: string | null = null;
  const separator = (createdAt: string | null) => {
    const day = dayLabel(createdAt);
    if (!day || day === lastDay) return null;
    lastDay = day;
    return <div className="room-agent-separator" role="separator"><span>{day}</span></div>;
  };

  return (
    <div className="room-agent-timeline-wrap">
      <div className="room-agent-transcript" ref={transcriptRef} onScroll={handleTranscriptScroll} role="log" aria-live="polite" aria-label="Room Agent conversation">
        {!hasContent ? empty : (
          <div className="room-agent-timeline">
            {messages.map((message) => {
              const kind = message.kind ?? "CHAT";
              if (kind === "TOOL" && text(message.meta, "status") === "NEEDS_CONFIRMATION") return null;
              const day = separator(message.createdAt);
              let row: ReactNode;
              if (kind === "TOOL") row = <ToolRow label={message.content} status={text(message.meta, "status") ?? message.status} />;
              else if (kind === "SYSTEM") row = <SystemRow message={message} onAnswer={onAnswerEvent} onDismiss={onDismissEvent} onOpenPane={onOpenPane} />;
              else if (kind === "CONFIRMATION") row = <ConfirmationRow message={message} busy={busyReplying} onReply={onConfirmReply} />;
              else if (message.role === "user") {
                row = (
                  <div className="room-agent-row" data-kind="CHAT">
                    <div className="room-agent-bubble is-user"><p>{message.content}</p><time dateTime={message.createdAt ?? undefined}>{timeLabel(message.createdAt)}</time></div>
                  </div>
                );
              } else {
                const streaming = streamOpen && stream.messageId === message.id;
                const content = streaming && stream.text.length >= message.content.length ? stream.text : message.content;
                row = (
                  <>
                    {stream.messageId === message.id ? toolRows(streamTools) : null}
                    <AssistantBubble content={content} status={message.status} streaming={streaming} createdAt={message.createdAt} />
                  </>
                );
              }
              return <Fragment key={message.id}>{day}{row}</Fragment>;
            })}
            {pending.map((message) => (
              <div key={message.id} className="room-agent-row" data-kind="CHAT" data-pending="true">
                <div className="room-agent-bubble is-user"><p>{message.content}</p></div>
              </div>
            ))}
            {streamOpen && !streamHasRow ? (
              <>
                {toolRows(streamTools)}
                <AssistantBubble content={stream.text} status="RUNNING" streaming createdAt={null} />
              </>
            ) : null}
          </div>
        )}
      </div>
      {showJumpToLatest ? (
        <button type="button" className="room-agent-jump" onClick={jumpToLatest}>
          <ArrowDown aria-hidden="true" />
          <span>Jump to latest</span>
        </button>
      ) : null}
    </div>
  );
}
