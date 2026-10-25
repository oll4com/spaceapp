import { cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import { ArrowRightLeft, History, Loader2, Search, Terminal, X } from "../ui-theme/app-icons.js";
import { type CliTaskHistoryItem, type CodexHistoryItem, type Room } from "@space/contracts";

export type TaskHistoryDialogItem = CodexHistoryItem | CliTaskHistoryItem;

export function TaskHistoryDialog({
  mode,
  paneTitle,
  runtimeLabel,
  items,
  loading,
  error,
  loadMorePending,
  hasMore,
  query,
  onClose,
  onSelect,
  onLoadMore,
  onQueryChange
}: {
  mode: "chat" | "cli";
  paneTitle: string;
  runtimeLabel: string;
  items: TaskHistoryDialogItem[];
  loading: boolean;
  error: string | null;
  loadMorePending: boolean;
  hasMore: boolean;
  query: string;
  onClose: () => void;
  onSelect: (item: TaskHistoryDialogItem) => void;
  onLoadMore: () => void;
  onQueryChange: (query: string) => void;
}) {
  const isChat = mode === "chat";
  let description = `Open an existing Codex thread in ${paneTitle}.`;
  if (!isChat) {
    description = `Shared Space CLI task history. Continue a task in ${paneTitle} with ${runtimeLabel}; the runtime stays unchanged.`;
  }
  return (
    <div className="attachment-modal codex-resume-modal" onClick={onClose}>
      <section
        className="attachment-modal-body codex-resume-modal-body"
        role="dialog"
        aria-modal="true"
        aria-label={isChat ? "Open Codex task history" : "Resume CLI task"}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="terminal-upload-modal-close codex-resume-modal-close"
          aria-label={isChat ? "Close task history" : "Close resume task history"}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
        <div className="codex-resume-modal-header">
          <span className="terminal-upload-modal-label codex-resume-modal-label">
            <History aria-hidden="true" />
            {isChat ? "Task history" : "Resume task"}
          </span>
          <strong>{isChat ? "Codex task history" : "CLI task history"}</strong>
          <small>{description}</small>
        </div>
        <div className="codex-resume-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label={isChat ? "Search Codex tasks" : "Search CLI tasks"}
            placeholder="Search tasks"
            autoComplete="off"
            autoFocus
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
          />
          {query ? (
            <button type="button" aria-label="Clear task search" title="Clear task search" onClick={() => onQueryChange("")}>
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className="vscode-codex-task-list codex-resume-task-list">
          {loading ? (
            <div className="vscode-codex-state" role="status">
              <Loader2 aria-hidden="true" />
              <span>Loading tasks</span>
            </div>
          ) : error ? (
            <div className="vscode-codex-state" role="alert">
              <span>{error}</span>
            </div>
          ) : items.length ? (
            items.map((item) => {
              const runtimeId = "runtimeId" in item ? item.runtimeId : "cli:codex";
              const runtimeBrand = cliRuntimePresentation(runtimeId);
              const itemProviderLabel = "providerLabel" in item ? item.providerLabel : "Codex";
              return (
                <button
                  key={item.id}
                  type="button"
                  className="vscode-codex-task-row"
                  onClick={() => onSelect(item)}
                  aria-label={`${itemProviderLabel} task ${item.title}`}
                >
                  <div className="cli-task-history-row-content">
                    <strong>{item.title}</strong>
                    <span className="cli-task-history-provider">
                      {runtimeBrand ? (
                        <img
                          src={runtimeBrand.iconSrc}
                          alt=""
                          aria-hidden="true"
                          data-terminal-runtime-brand={runtimeBrand.brand}
                          draggable={false}
                        />
                      ) : (
                        <Terminal aria-hidden="true" />
                      )}
                      <span>{itemProviderLabel}</span>
                    </span>
                  </div>
                </button>
              );
            })
          ) : (
            <div className="vscode-codex-state" role="status">
              <span>{isChat ? "No Codex tasks found" : "No CLI tasks found"}</span>
            </div>
          )}
        </div>
        <div className="codex-resume-modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
          {hasMore ? (
            <button type="button" onClick={onLoadMore} disabled={loadMorePending}>
              {loadMorePending ? "Loading..." : "Load more"}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function MovePaneDialog({
  paneTitle,
  targetRooms,
  targetRoomId,
  pending,
  error,
  onTargetRoomChange,
  onClose,
  onConfirm
}: {
  paneTitle: string;
  targetRooms: Room[];
  targetRoomId: string;
  pending: boolean;
  error: string | null;
  onTargetRoomChange: (roomId: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="attachment-modal codex-resume-modal" onClick={onClose}>
      <section
        className="attachment-modal-body codex-resume-modal-body"
        role="dialog"
        aria-modal="true"
        aria-label="Move pane to another room"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="terminal-upload-modal-close codex-resume-modal-close" aria-label="Close pane move dialog" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
        <div className="codex-resume-modal-header">
          <span className="terminal-upload-modal-label codex-resume-modal-label">
            <ArrowRightLeft aria-hidden="true" />
            Move pane
          </span>
          <strong>{paneTitle}</strong>
          <small>A running CLI task keeps running in the new room. You can also drag the pane onto a room in the Rooms list.</small>
        </div>
        <label className="provider-form-row">
          <span>Target room</span>
          <select
            aria-label="Target room"
            value={targetRoomId}
            disabled={pending || targetRooms.length === 0}
            onChange={(event) => onTargetRoomChange(event.currentTarget.value)}
          >
            {targetRooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </select>
        </label>
        {error ? (
          <div className="validation-result bad" role="alert">
            {error}
          </div>
        ) : null}
        <div className="codex-resume-modal-actions">
          <button type="button" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={pending || !targetRooms.length || !targetRoomId}>
            {pending ? "Moving..." : "Move pane"}
          </button>
        </div>
      </section>
    </div>
  );
}
