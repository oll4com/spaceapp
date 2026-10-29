import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { AnimatedNumber } from "../ui-controls/AnimatedNumber.js";
import type {
  AgentSessionHistoryItem,
  AgentSessionHistoryResponse,
  AgentSessionInterval,
  AgentSessionStatusFilter
} from "@space/contracts";
import {
  Archive,
  Check,
  ChevronRight,
  History,
  Pencil,
  Play,
  RefreshCw,
  Terminal,
  X
} from "../ui-theme/app-icons.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import { api } from "../../api.js";
import { formatAppDate } from "../date-time-settings/date-time-settings.js";
import {
  DockButton,
  DockChips,
  DockFullscreenButton,
  DockIconButton,
  DockNotice,
  DockSearch,
  DockState,
  DockToolbar,
  useDockConfirm,
  useDockFullscreen
} from "../dock-kit/DockKit.js";
import "./agent-sessions-dock.css";

interface AgentSessionsDockProps {
  activePaneLabel: string | null;
  canResume: boolean;
  codexEnabled: boolean;
  onResume: (item: AgentSessionHistoryItem) => Promise<string | null>;
}

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The server keeps seven days of session history, so "all" and "7d" return the
 * same sessions. One option covers both and says so.
 */
const intervalOptions: Array<{ id: AgentSessionInterval; label: string }> = [
  { id: "all", label: "Last 7 days" },
  { id: "3d", label: "3 days" },
  { id: "24h", label: "24 hours" },
  { id: "today", label: "Today" }
];

const statusOptions: Array<{ id: AgentSessionStatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "completed", label: "Completed" }
];

function relativeTime(iso: string | null): string {
  if (!iso) return "recently";
  const diffMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diffMs)) return "recently";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatAppDate(iso);
}

function folderGroup(cwd: string | null): string {
  if (!cwd) return "No folder";
  const parts = cwd.split("/").filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return tail || cwd;
}

function providerRuntimeId(item: AgentSessionHistoryItem): string | null {
  if (item.kind === "codex") return "cli:codex";
  return item.threadSource;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/** A count from the server, or the number of rows when the response leaves it out. */
function countOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function AgentBrandIcon({ item }: { item: AgentSessionHistoryItem }) {
  const runtimeId = providerRuntimeId(item);
  const brand = cliRuntimePresentation(runtimeId);
  if (brand?.iconSrc) {
    return (
      <img
        src={brand.iconSrc}
        alt=""
        aria-hidden="true"
        data-agent-session-brand={brand.brand}
        draggable={false}
      />
    );
  }
  return <Terminal aria-hidden="true" />;
}

interface AgentSessionGroup {
  label: string;
  path: string | null;
  items: AgentSessionHistoryItem[];
}

let cachedAgentSessionsPayload: { items: AgentSessionHistoryItem[]; total: number } | null = null;

/** Forget the cached default view (tests start from a cold dock). */
export function resetAgentSessionsDockCache(): void {
  cachedAgentSessionsPayload = null;
}

export function AgentSessionsDock({
  activePaneLabel,
  canResume,
  codexEnabled,
  onResume
}: AgentSessionsDockProps) {
  const { confirm, confirmDialog } = useDockConfirm();
  const [isFullscreen, setIsFullscreen] = useDockFullscreen();
  const [items, setItems] = useState<AgentSessionHistoryItem[]>(() => cachedAgentSessionsPayload?.items ?? []);
  const [totalItems, setTotalItems] = useState(() => cachedAgentSessionsPayload?.total ?? 0);
  const [hasLoaded, setHasLoaded] = useState(() => cachedAgentSessionsPayload !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadMorePending, setLoadMorePending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [intervalFilter, setIntervalFilter] = useState<AgentSessionInterval>("all");
  const [statusFilter, setStatusFilter] = useState<AgentSessionStatusFilter>("all");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const loadRequestIdRef = useRef(0);
  const [sessionListRef] = useAutoAnimate();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (targetPage: number, append: boolean) => {
    const requestId = ++loadRequestIdRef.current;
    // Items stay on screen while a refresh runs; only the buttons show progress.
    if (append) setLoadMorePending(true);
    else setRefreshing(true);
    try {
      const response: Partial<AgentSessionHistoryResponse> = await api.agentSessions({
        page: targetPage,
        pageSize: PAGE_SIZE,
        includeArchived,
        q: debouncedQuery.trim() || undefined,
        interval: intervalFilter,
        status: statusFilter !== "all" ? statusFilter : undefined
      });
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) return;
      const rows = Array.isArray(response?.data) ? response.data : [];
      const total = countOf(response?.totalItems, (append ? items.length : 0) + rows.length);
      if (!append && !debouncedQuery.trim() && intervalFilter === "all" && statusFilter === "all" && !includeArchived) {
        cachedAgentSessionsPayload = { items: rows, total };
      }
      setItems((current) => (append ? [...current, ...rows] : rows));
      setTotalItems(total);
      setPage(targetPage);
      setHasMore(rows.length === PAGE_SIZE);
      setLoadError(null);
    } catch (error) {
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) return;
      setLoadError(errorMessage(error, "Session history could not be loaded."));
    } finally {
      if (mountedRef.current && requestId === loadRequestIdRef.current) {
        setHasLoaded(true);
        setRefreshing(false);
        setLoadMorePending(false);
      }
    }
  }, [debouncedQuery, includeArchived, intervalFilter, statusFilter, items.length]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void loadRef.current(1, false);
  }, [debouncedQuery, includeArchived, intervalFilter, statusFilter]);

  const refresh = () => void load(1, false);

  const groups = useMemo<AgentSessionGroup[]>(() => {
    const byLabel = new Map<string, AgentSessionGroup>();
    for (const item of items) {
      const label = folderGroup(item.cwd);
      const group = byLabel.get(label);
      if (group) group.items.push(item);
      else byLabel.set(label, { label, path: item.cwd, items: [item] });
    }
    return [...byLabel.values()];
  }, [items]);

  function toggleGroup(label: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function startRename(item: AgentSessionHistoryItem) {
    setRenamingId(item.id);
    setRenameDraft(item.title);
  }

  async function renameItem(item: AgentSessionHistoryItem) {
    if (item.kind !== "codex" || !item.threadId || !codexEnabled || pendingActionId === item.id) return;
    const title = renameDraft.trim();
    if (!title || title === item.title) {
      setRenamingId(null);
      return;
    }
    setPendingActionId(item.id);
    setActionError(null);
    try {
      const renamed = await api.agentSessionRename(item.threadId, title);
      setItems((current) =>
        current.map((entry) => (entry.id === item.id ? { ...entry, title: renamed.title } : entry))
      );
      setRenamingId(null);
    } catch (error) {
      setActionError(errorMessage(error, "The session could not be renamed."));
    } finally {
      setPendingActionId(null);
    }
  }

  async function archiveItem(item: AgentSessionHistoryItem) {
    if (item.kind !== "codex" || !item.threadId || !codexEnabled || item.archived) return;
    const accepted = await confirm({
      title: "Archive this session?",
      message: `"${item.title}" will be hidden from this list. Turn on Include archived to see archived sessions. Space cannot unarchive a session.`,
      confirmLabel: "Archive"
    });
    if (!accepted) return;
    setPendingActionId(item.id);
    setActionError(null);
    try {
      await api.agentSessionArchive(item.threadId);
      if (includeArchived) {
        setItems((current) =>
          current.map((entry) => (entry.id === item.id ? { ...entry, archived: true } : entry))
        );
      } else {
        setItems((current) => current.filter((entry) => entry.id !== item.id));
        setTotalItems((current) => Math.max(0, current - 1));
      }
    } catch (error) {
      setActionError(errorMessage(error, "The session could not be archived."));
    } finally {
      setPendingActionId(null);
    }
  }

  function resumeItem(item: AgentSessionHistoryItem) {
    if (!canResume || pendingActionId) return;
    setPendingActionId(item.id);
    setActionError(null);
    void onResume(item)
      .then((resumeError) => {
        if (resumeError) setActionError(resumeError);
      })
      .catch((error) => setActionError(errorMessage(error, "The session could not be resumed.")))
      .finally(() => {
        if (mountedRef.current) setPendingActionId(null);
      });
  }

  function resumeHint(item: AgentSessionHistoryItem): string {
    if (!canResume) return "Open a room to resume";
    if (!item.threadId && !item.taskId) return "This session cannot be resumed";
    return `Resume in ${activePaneLabel ?? "a new pane"}`;
  }

  const isFiltered = Boolean(debouncedQuery.trim()) || intervalFilter !== "all" || statusFilter !== "all" || includeArchived;
  const codexActionHint = codexEnabled ? null : "Turn on Codex to rename or archive Codex sessions";

  function emptyState() {
    if (!hasLoaded) return <DockState kind="loading" title="Loading sessions…" />;
    if (loadError) {
      return <DockState kind="error" title="Session history could not be loaded" detail={loadError}
        action={{ label: "Try again", icon: RefreshCw, onClick: refresh }} />;
    }
    if (isFiltered) {
      return <DockState kind="empty" icon={History} title="No sessions match this view"
        detail="Change the search, the time range or the status." />;
    }
    return <DockState kind="empty" icon={History} title="No agent sessions yet"
      detail="Sessions from your CLI agents in the last 7 days appear here." />;
  }

  return (
    <div className="agent-sessions-dock">
      <div className={`agent-sessions-shell dock-kit-shell${isFullscreen ? " is-fullscreen" : ""}`}>
        <div className="agent-sessions-body dock-kit-dock">
          <DockToolbar
            title={isFullscreen ? "Sessions" : undefined}
            summary={hasLoaded ? (
              <>
                <strong><AnimatedNumber value={totalItems} /></strong> session{totalItems === 1 ? "" : "s"}
                {items.length < totalItems ? <> · {items.length.toLocaleString()} shown</> : null}
              </>
            ) : null}
          >
            <DockIconButton
              label="Refresh agent session history"
              icon={RefreshCw}
              busy={refreshing}
              disabled={refreshing}
              onClick={refresh}
            />
            <DockFullscreenButton name="sessions" active={isFullscreen} onToggle={() => setIsFullscreen((value) => !value)} />
          </DockToolbar>

          <div className="dock-kit-controls">
            <DockSearch name="agent-session-search" label="Search agent sessions" placeholder="Search sessions…" value={query} onChange={setQuery} />
            <DockChips label="Time range" options={intervalOptions} value={intervalFilter} onChange={setIntervalFilter} />
            <div className="agent-sessions-filters">
              <DockChips label="Session status" options={statusOptions} value={statusFilter} onChange={setStatusFilter} />
              <SpaceToggle
                className="agent-sessions-archive-toggle"
                label="Include archived"
                checked={includeArchived}
                onChange={setIncludeArchived}
              />
            </div>
          </div>

          {!canResume && items.length ? (
            <DockNotice tone="info" className="agent-sessions-hint">Open a room to resume a session.</DockNotice>
          ) : null}
          {actionError ? <DockNotice onDismiss={() => setActionError(null)}>{actionError}</DockNotice> : null}
          {loadError && items.length ? (
            <DockNotice onDismiss={() => setLoadError(null)}>Sessions could not be refreshed. {loadError}</DockNotice>
          ) : null}

          {!items.length ? emptyState() : null}

          <section
            ref={sessionListRef}
            className="agent-sessions-list dock-kit-list"
            aria-label="Agent session history list"
            aria-busy={refreshing || undefined}
            hidden={!items.length}
          >
            {groups.map((group) => {
              const collapsed = collapsedGroups.has(group.label);
              return (
                <div key={group.label} className="agent-sessions-group">
                  <button
                    type="button"
                    className="agent-sessions-folder"
                    onClick={() => toggleGroup(group.label)}
                    aria-expanded={!collapsed}
                    aria-label={`${group.label}, ${group.items.length} sessions`}
                    title={group.path ?? undefined}
                  >
                    <ChevronRight aria-hidden="true" className={collapsed ? undefined : "is-open"} />
                    <span className="agent-sessions-folder-name">{group.label}</span>
                    <span className="dock-kit-badge"><AnimatedNumber value={group.items.length} duration={0.3} /></span>
                  </button>
                  {!collapsed ? group.items.map((item) => {
                    const pending = pendingActionId === item.id;
                    const resumable = canResume && Boolean(item.threadId || item.taskId);
                    const isCodex = item.kind === "codex";
                    return (
                      <article
                        key={item.id}
                        className={`agent-sessions-card dock-kit-card${item.isCompleted ? "" : " is-accent"}${item.archived ? " is-muted" : ""}`}
                      >
                        <div className="dock-kit-meta">
                          <span className="agent-sessions-brand"><AgentBrandIcon item={item} /></span>
                          {item.isCompleted ? (
                            <span className="dock-kit-badge is-success agent-sessions-status" title="Completed session">
                              <Check aria-hidden="true" /> Completed
                            </span>
                          ) : (
                            <span className="dock-kit-badge is-accent agent-sessions-status" title="Active session">
                              <span className="agent-sessions-live-dot" aria-hidden="true" /> Active
                            </span>
                          )}
                          {item.archived ? <span className="dock-kit-badge">Archived</span> : null}
                          <span className="dock-kit-meta-text">
                            {item.providerLabel} · {relativeTime(item.recencyAt ?? item.updatedAt)}{item.model ? ` · ${item.model}` : ""}
                          </span>
                        </div>

                        {renamingId === item.id ? (
                          <div className="agent-sessions-rename-row">
                            <input
                              className="dock-kit-field"
                              type="text"
                              value={renameDraft}
                              autoFocus
                              maxLength={300}
                              disabled={pending}
                              onChange={(event) => setRenameDraft(event.currentTarget.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void renameItem(item);
                                }
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setRenamingId(null);
                                }
                              }}
                              aria-label="Session title"
                            />
                            <DockIconButton
                              label="Save session title"
                              icon={Check}
                              tone="primary"
                              busy={pending}
                              disabled={pending || !renameDraft.trim()}
                              onClick={() => void renameItem(item)}
                            />
                            <DockIconButton
                              label="Cancel session rename"
                              icon={X}
                              disabled={pending}
                              onClick={() => setRenamingId(null)}
                            />
                          </div>
                        ) : (
                          <div className="dock-kit-card-title" data-sensitive-masked="manual" title={item.title}>{item.title}</div>
                        )}

                        <p className="agent-sessions-preview" data-sensitive-masked="manual">{item.preview || item.firstUserMessage || "No preview"}</p>
                        {item.cwd ? (
                          <div className="dock-kit-meta">
                            <code className="dock-kit-meta-text agent-sessions-cwd" title={item.cwd}>{item.cwd}</code>
                          </div>
                        ) : null}

                        {renamingId !== item.id ? (
                          <div className="dock-kit-card-actions">
                            {isCodex ? (
                              <>
                                <DockIconButton
                                  label={`Rename session ${item.title}`}
                                  title={codexActionHint ?? "Rename session"}
                                  icon={Pencil}
                                  disabled={pending || !codexEnabled}
                                  onClick={() => startRename(item)}
                                />
                                {!item.archived ? (
                                  <DockIconButton
                                    label={`Archive session ${item.title}`}
                                    title={codexActionHint ?? "Archive session"}
                                    icon={Archive}
                                    disabled={pending || !codexEnabled}
                                    onClick={() => void archiveItem(item)}
                                  />
                                ) : null}
                              </>
                            ) : null}
                            <DockButton
                              icon={Play}
                              tone="primary"
                              busy={pending}
                              disabled={!resumable || Boolean(pendingActionId)}
                              onClick={() => resumeItem(item)}
                              title={resumeHint(item)}
                              aria-label={`Resume session ${item.title}`}
                            >
                              {pending ? "Opening…" : "Resume"}
                            </DockButton>
                          </div>
                        ) : null}
                      </article>
                    );
                  }) : null}
                </div>
              );
            })}
          </section>

          {hasMore && items.length ? (
            <DockButton
              className="agent-sessions-more"
              busy={loadMorePending}
              disabled={loadMorePending || refreshing}
              onClick={() => void load(page + 1, true)}
            >
              Load more
            </DockButton>
          ) : null}
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}
