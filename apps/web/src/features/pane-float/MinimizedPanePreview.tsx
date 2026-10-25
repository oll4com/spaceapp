import { useEffect, useState, type ReactNode, type Ref } from "react";
import type { Pane, Turn } from "@space/contracts";
import { CircleAlert, Loader2, Maximize2 } from "../ui-theme/app-icons.js";
import { setPaneDragData } from "../pane-drag/pane-drag.js";
import {
  getTerminalPreviewSummary,
  subscribeTerminalPreview,
  type TerminalPreviewSummary
} from "../terminal-pane/terminal-preview-service.js";

/** A spinner line older than this no longer counts as "working" on its own. */
const ACTIVITY_FRESH_MS = 6_000;
const PREVIEW_REFRESH_MS = 5_000;
const PREVIEW_LINES = 8;

export type MinimizedPaneStatus = "attention" | "working" | "error" | "done" | "idle";

const STATUS_LABELS: Record<MinimizedPaneStatus, string> = {
  attention: "Needs input",
  working: "Working",
  error: "Failed",
  done: "Done",
  idle: "Idle"
};

type LineTone = "error" | "success" | "step" | "result" | "input" | undefined;

function lineTone(line: string): LineTone {
  if (/✗|✘|\b(?:error|failed|exception)\b/i.test(line)) return "error";
  if (/✓|✔|\b(?:passed|succeeded|success)\b/i.test(line)) return "success";
  if (/^\s*[●•⏺]/.test(line)) return "step";
  if (/^\s*[└⎿↳]/.test(line)) return "result";
  if (/^\s*[>❯›$]\s/.test(line)) return "input";
  return undefined;
}

export function formatPreviewAge(lastUpdated: number, now: number): string | null {
  if (!lastUpdated) return null;
  const seconds = Math.max(0, Math.round((now - lastUpdated) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function terminalStatus(summary: TerminalPreviewSummary | null, isRunning: boolean, now: number): MinimizedPaneStatus {
  if (summary?.attention) return "attention";
  const activityFresh = Boolean(summary?.activity && summary.activityAt && now - summary.activityAt < ACTIVITY_FRESH_MS);
  return isRunning || activityFresh ? "working" : "idle";
}

function turnStatus(turn: Turn | null | undefined, isRunning: boolean): MinimizedPaneStatus | null {
  switch (turn?.status) {
    case "BLOCKED":
      return "attention";
    case "RUNNING":
    case "QUEUED":
      return "working";
    case "FAILED":
      return "error";
    case "COMPLETED":
      return "done";
    case "CANCELLED":
      return "idle";
    default:
      return isRunning ? "working" : null;
  }
}

/**
 * Reads the in-memory preview of a minimized terminal. It never attaches,
 * hydrates or replays the terminal: it only listens to output the pane is
 * already receiving.
 */
function useTerminalPreviewSummary(paneId: string, enabled: boolean) {
  const [summary, setSummary] = useState<TerminalPreviewSummary | null>(() =>
    enabled ? getTerminalPreviewSummary(paneId, PREVIEW_LINES) : null
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      setSummary(null);
      return;
    }
    const update = () => {
      setSummary(getTerminalPreviewSummary(paneId, PREVIEW_LINES));
      setNow(Date.now());
    };
    update();
    const unsubscribe = subscribeTerminalPreview((updatedPaneId) => {
      if (!updatedPaneId || updatedPaneId === paneId) update();
    });
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") update();
    }, PREVIEW_REFRESH_MS);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [paneId, enabled]);

  return { summary, now };
}

/** Status only, so compact chips re-render when the state changes rather than on every output chunk. */
function useTerminalPreviewStatus(paneId: string, enabled: boolean, isRunning: boolean): MinimizedPaneStatus {
  const [status, setStatus] = useState<MinimizedPaneStatus>(() =>
    enabled ? terminalStatus(getTerminalPreviewSummary(paneId, 1), isRunning, Date.now()) : "idle"
  );

  useEffect(() => {
    if (!enabled) return;
    const update = () => setStatus(terminalStatus(getTerminalPreviewSummary(paneId, 1), isRunning, Date.now()));
    update();
    const unsubscribe = subscribeTerminalPreview((updatedPaneId) => {
      if (!updatedPaneId || updatedPaneId === paneId) update();
    });
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") update();
    }, PREVIEW_REFRESH_MS);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [paneId, enabled, isRunning]);

  return enabled ? status : isRunning ? "working" : "idle";
}

function StatusRow({ status, detail }: { status: MinimizedPaneStatus; detail: string | null }) {
  return (
    <div className="minimized-preview-status" data-status={status} title={detail ?? undefined}>
      {status === "working" ? (
        <Loader2 className="minimized-pane-run-indicator" aria-hidden="true" />
      ) : status === "attention" ? (
        <CircleAlert aria-hidden="true" />
      ) : (
        <span className="minimized-preview-status-dot" aria-hidden="true" />
      )}
      <strong>{STATUS_LABELS[status]}</strong>
      {detail ? <span className="minimized-preview-status-detail">{detail}</span> : null}
    </div>
  );
}

export type MinimizedPanePreviewCardProps = {
  pane: Pane;
  icon: ReactNode;
  title: string;
  /** Second heading line: the task title, or the CLI / pane type when there is none. */
  subtitle: string | null;
  fullTitle: string;
  modeLabel: string;
  isRunning: boolean;
  latestTurn?: Turn | null;
  onRestore: () => void;
};

export function MinimizedPanePreviewCard({
  pane,
  icon,
  title,
  subtitle,
  fullTitle,
  modeLabel,
  isRunning,
  latestTurn,
  onRestore
}: MinimizedPanePreviewCardProps) {
  const isTerminal = pane.mode === "TERMINAL";
  const { summary, now } = useTerminalPreviewSummary(pane.id, isTerminal);
  const status = isTerminal ? terminalStatus(summary, isRunning, now) : turnStatus(latestTurn, isRunning);

  let body: ReactNode;
  let statusDetail: string | null = null;
  if (isTerminal) {
    const lines = summary?.lines ?? [];
    const age = formatPreviewAge(summary?.lastUpdated ?? 0, now);
    const activity = summary?.activity;
    if (status === "attention") {
      statusDetail = summary?.attention ?? null;
    } else if (status === "working") {
      const activityText = activity ? [activity.label, activity.elapsed].filter(Boolean).join(" · ") : "";
      statusDetail = activityText || (age ? `output ${age}` : null);
    } else {
      statusDetail = age ? `output ${age}` : null;
    }
    body = lines.length > 0 ? (
      <div className="minimized-preview-terminal-view">
        {lines.map((line, index) => (
          <div
            key={`${index}:${line}`}
            className="minimized-preview-terminal-line"
            data-tone={lineTone(line)}
            data-latest={index === lines.length - 1 ? "true" : undefined}
            title={line}
          >
            {line}
          </div>
        ))}
      </div>
    ) : (
      <div className="minimized-preview-placeholder">
        {status === "working" ? "Waiting for output…" : "No output yet"}
      </div>
    );
  } else if (pane.mode === "CHAT") {
    body = latestTurn?.prompt ? (
      <div className="minimized-preview-chat-view">
        <span className="minimized-preview-chat-label">Last prompt</span>
        <p className="minimized-preview-chat-prompt">{latestTurn.prompt}</p>
      </div>
    ) : (
      <div className="minimized-preview-placeholder">No messages yet</div>
    );
  } else {
    body = (
      <div className="minimized-preview-generic-view">
        <span className="minimized-preview-generic-icon" aria-hidden="true">{icon}</span>
        <span className="minimized-preview-generic-mode">{modeLabel}</span>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`minimized-preview-card${isRunning ? " is-running" : ""}`}
      data-status={status ?? undefined}
      data-category-color={pane.categoryColor ?? undefined}
      draggable
      onDragStart={(event) => setPaneDragData(event, pane, null)}
      onClick={onRestore}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onRestore();
        }
      }}
      aria-label={`Restore pane ${fullTitle}`}
      title={`Click to restore ${fullTitle}`}
    >
      <header className="minimized-preview-card-header">
        <span className="minimized-preview-card-icon" aria-hidden="true">{icon}</span>
        <span className="minimized-preview-card-heading">
          <span className="minimized-preview-card-title">{title}</span>
          {subtitle ? <span className="minimized-preview-card-subtitle">{subtitle}</span> : null}
        </span>
        <span className="minimized-preview-restore-hint" aria-hidden="true">
          <Maximize2 />
          Restore
        </span>
      </header>
      <div className="minimized-preview-card-body">{body}</div>
      {status ? <StatusRow status={status} detail={statusDetail} /> : null}
    </div>
  );
}

export type MinimizedPaneChipProps = {
  pane: Pane;
  icon: ReactNode;
  title: string;
  fullTitle: string;
  isRunning: boolean;
  latestTurn?: Turn | null;
  buttonRef?: Ref<HTMLButtonElement>;
  onRestore: () => void;
};

export function MinimizedPaneChip({
  pane,
  icon,
  title,
  fullTitle,
  isRunning,
  latestTurn,
  buttonRef,
  onRestore
}: MinimizedPaneChipProps) {
  const terminalChipStatus = useTerminalPreviewStatus(pane.id, pane.mode === "TERMINAL", isRunning);
  const status = pane.mode === "TERMINAL" ? terminalChipStatus : turnStatus(latestTurn, isRunning) ?? "idle";
  const statusSuffix = status === "attention" || status === "working" ? ` (${STATUS_LABELS[status]})` : "";

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`minimized-pane-chip${isRunning ? " is-running" : ""}`}
      data-status={status}
      data-category-color={pane.categoryColor ?? undefined}
      aria-label={`Restore pane ${fullTitle}`}
      title={`${fullTitle}${statusSuffix}`}
      draggable
      onDragStart={(event) => setPaneDragData(event, pane, null)}
      onClick={onRestore}
    >
      <span className="minimized-pane-chip-icon" aria-hidden="true">{icon}</span>
      <span className="minimized-pane-chip-label">{title}</span>
      {status === "working" ? (
        <>
          <Loader2 className="minimized-pane-run-indicator" aria-hidden="true" />
          <span className="sr-only">Agent is running</span>
        </>
      ) : status === "attention" ? (
        <>
          <span className="minimized-pane-chip-alert" aria-hidden="true" />
          <span className="sr-only">Needs input</span>
        </>
      ) : null}
    </button>
  );
}
