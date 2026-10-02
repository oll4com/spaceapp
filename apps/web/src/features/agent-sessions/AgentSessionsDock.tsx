import { useEffect, useMemo, useRef, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { AnimatedNumber } from "../ui-controls/AnimatedNumber.js";
import type {
  AgentSessionHistoryItem,
  AgentSessionInterval,
  AgentSessionStatusFilter
} from "@space/contracts";
import {
  Archive,
  Check,
  ChevronRight,
  History,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Terminal,
  X
} from "../ui-theme/app-icons.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import { api, SpaceApiError } from "../../api.js";
import { formatAppDate } from "../date-time-settings/date-time-settings.js";

interface AgentSessionsDockProps {
  activePaneLabel: string | null;
  canResume: boolean;
  codexEnabled: boolean;
  onResume: (item: AgentSessionHistoryItem) => Promise<string | null>;
}

const PAGE_SIZE = 50;

function relativeTime(iso: string | null): string {
  if (!iso) return "recent";
  const diffMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diffMs)) return "recent";
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
  items: AgentSessionHistoryItem[];
}

export function AgentSessionsDock({
  activePaneLabel,
  canResume,
  codexEnabled,
  onResume
}: AgentSessionsDockProps) {
  const [items, setItems] = useState<AgentSessionHistoryItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [visibleItems, setVisibleItems] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadMorePending, setLoadMorePending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [interval, setInterval] = useState<AgentSessionInterval>("all");
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
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = async (targetPage: number, append: boolean) => {
    const requestId = ++loadRequestIdRef.current;
    const setPending = append ? setLoadMorePending : setLoading;
    setPending(true);
    if (!append) setError(null);
    try {
      const response = await api.agentSessions({
        page: targetPage,
        pageSize: PAGE_SIZE,
        includeArchived,
        q: debouncedQuery.trim() || undefined,
        interval,
        status: statusFilter !== "all" ? statusFilter : undefined
      });
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) return;
      setItems((current) => (append ? [...current, ...response.data] : response.data));
      setTotalItems(response.totalItems);
      setVisibleItems(response.visibleItems);
      setPage(targetPage);
      setHasMore(response.data.length === PAGE_SIZE);
    } catch (loadError) {
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Agent session history failed to load.");
      if (!append) {
        setItems([]);
        setPage(1);
        setHasMore(false);
      }
    } finally {
      if (mountedRef.current && requestId === loadRequestIdRef.current) setPending(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void load(1, false);
    return () => {
      mountedRef.current = false;
    };
  }, [debouncedQuery, includeArchived, interval, statusFilter]);

  const groups = useMemo<AgentSessionGroup[]>(() => {
    const byLabel = new Map<string, AgentSessionHistoryItem[]>();
    for (const item of items) {
      const label = folderGroup(item.cwd);
      const bucket = byLabel.get(label);
      if (bucket) bucket.push(item);
      else byLabel.set(label, [item]);
    }
    return [...byLabel.entries()].map(([label, groupItems]) => ({ label, items: groupItems }));
  }, [items]);

  function toggleGroup(label: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  async function renameItem(item: AgentSessionHistoryItem) {
    if (item.kind !== "codex" || !item.threadId || !codexEnabled) return;
    const title = renameDraft.trim();
    if (!title) {
      setRenamingId(null);
      return;
    }
    setPendingActionId(item.id);
    setError(null);
    try {
      const renamed = await api.agentSessionRename(item.threadId, title);
      setItems((current) =>
        current.map((entry) => (entry.id === item.id ? { ...entry, title: renamed.title } : entry))
      );
      setRenamingId(null);
    } catch (renameError) {
      setError(renameError instanceof SpaceApiError ? renameError.message : renameError instanceof Error ? renameError.message : "Session rename failed.");
    } finally {
      setPendingActionId(null);
    }
  }

  async function archiveItem(item: AgentSessionHistoryItem) {
    if (item.kind !== "codex" || !item.threadId || !codexEnabled) return;
    setPendingActionId(item.id);
    setError(null);
    try {
      await api.agentSessionArchive(item.threadId);
      if (includeArchived) {
        setItems((current) =>
          current.map((entry) => (entry.id === item.id ? { ...entry, archived: true } : entry))
        );
      } else {
        setItems((current) => current.filter((entry) => entry.id !== item.id));
      }
    } catch (archiveError) {
      setError(archiveError instanceof SpaceApiError ? archiveError.message : archiveError instanceof Error ? archiveError.message : "Session archive failed.");
    } finally {
      setPendingActionId(null);
    }
  }

  function resumeItem(item: AgentSessionHistoryItem) {
    if (!canResume) return;
    setPendingActionId(item.id);
    setError(null);
    void onResume(item).then((resumeError) => {
      setPendingActionId(null);
      if (resumeError) setError(resumeError);
    });
  }

  const canResumeItem = (item: AgentSessionHistoryItem): boolean => {
    return canResume && Boolean(item.threadId || item.taskId);
  };

  return (
    <div className="dock-panel agent-sessions-dock">
      <section className="agent-sessions-summary" aria-label="Agent session history status">
        <History aria-hidden="true" />
        <div>
          <strong>Agent Session History</strong>
          <small>
            <AnimatedNumber value={visibleItems} /> shown · <AnimatedNumber value={totalItems} /> recent — sessions from every active CLI runtime.
          </small>
        </div>
        <button
          className="compact-action"
          onClick={() => void load(1, false)}
          disabled={loading}
          title="Refresh agent session history"
          aria-label="Refresh agent session history"
        >
          {loading ? <Loader2 aria-hidden="true" className="spin" /> : <RefreshCw aria-hidden="true" />}
          <span>{loading ? "Loading" : "Refresh"}</span>
        </button>
      </section>

      <section className="agent-sessions-controls" aria-label="Agent session history filters">
        <div className="agent-sessions-filter-row">
          <div className="agent-sessions-pill-group" role="group" aria-label="Filter by time interval">
            {([
              { id: "all", label: "All (7d)" },
              { id: "today", label: "Today" },
              { id: "24h", label: "24h" },
              { id: "3d", label: "3d" },
              { id: "7d", label: "7d" }
            ] as const).map((t) => (
              <button
                key={t.id}
                type="button"
                className={`agent-sessions-pill ${interval === t.id ? "active" : ""}`}
                onClick={() => setInterval(t.id)}
                aria-pressed={interval === t.id}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="agent-sessions-pill-group" role="group" aria-label="Filter by status">
            {([
              { id: "all", label: "All" },
              { id: "completed", label: "Completed" },
              { id: "active", label: "Active" }
            ] as const).map((s) => (
              <button
                key={s.id}
                type="button"
                className={`agent-sessions-pill ${statusFilter === s.id ? "active" : ""}`}
                onClick={() => setStatusFilter(s.id)}
                aria-pressed={statusFilter === s.id}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <SpaceToggle
          className="agent-sessions-archive-toggle"
          label="Include archived"
          checked={includeArchived}
          onChange={setIncludeArchived}
        />
        <label className="agent-sessions-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search sessions"
            aria-label="Search agent sessions"
            autoComplete="off"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear session search"
              title="Clear session search"
              onClick={() => setQuery("")}
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </label>
      </section>

      <section ref={sessionListRef} className="agent-sessions-list" aria-label="Agent session history list">
        {loading ? (
          <div className="empty-mini" role="status">
            <Loader2 aria-hidden="true" className="spin" />
            <span>Loading sessions</span>
          </div>
        ) : error && !items.length ? (
          <div className="validation-result bad" role="alert">
            <strong>AGENT_SESSIONS_ERROR</strong>
            <small>{error}</small>
          </div>
        ) : items.length ? (
          groups.map((group) => {
            const collapsed = collapsedGroups.has(group.label);
            return (
              <div key={group.label} className="agent-sessions-group">
                <button
                  type="button"
                  className="agent-sessions-group-header"
                  onClick={() => toggleGroup(group.label)}
                  aria-expanded={!collapsed}
                  aria-label={`${group.label}, ${group.items.length} sessions`}
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={collapsed ? undefined : "agent-sessions-chevron-open"}
                  />
                  <span>{group.label}</span>
                  <span className="agent-sessions-group-count"><AnimatedNumber value={group.items.length} duration={0.3} /></span>
                </button>
                {!collapsed ? (
                  group.items.map((item) => {
                    const pending = pendingActionId === item.id;
                    const resumable = canResumeItem(item);
                    return (
                      <article key={item.id} className="agent-sessions-row">
                        <div className="agent-sessions-row-header">
                          <div className="agent-sessions-row-title">
                            <AgentBrandIcon item={item} />
                            <strong title={item.title}>{item.title}</strong>
                          </div>
                          <span
                            className={`agent-sessions-badge ${item.isCompleted ? "completed" : "active"}`}
                            title={item.isCompleted ? "Completed session" : "Active session"}
                          >
                            {item.isCompleted ? (
                              <>
                                <Check aria-hidden="true" />
                                <span>Completed</span>
                              </>
                            ) : (
                              <>
                                <span className="agent-sessions-dot" aria-hidden="true" />
                                <span>Active</span>
                              </>
                            )}
                          </span>
                        </div>
                        {renamingId === item.id ? (
                          <div className="agent-sessions-rename">
                            <input
                              type="text"
                              value={renameDraft}
                              autoFocus
                              maxLength={300}
                              onChange={(event) => setRenameDraft(event.currentTarget.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void renameItem(item);
                                if (event.key === "Escape") setRenamingId(null);
                              }}
                              aria-label="Session title"
                            />
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() => void renameItem(item)}
                              title="Save title"
                              aria-label="Save session title"
                            >
                              <Check aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setRenamingId(null)}
                              title="Cancel rename"
                              aria-label="Cancel session rename"
                            >
                              <X aria-hidden="true" />
                            </button>
                          </div>
                        ) : (
                          <div className="agent-sessions-row-actions">
                            <button
                              type="button"
                              className="compact-action"
                              disabled={!resumable || pending}
                              onClick={() => resumeItem(item)}
                              title={`Resume in ${activePaneLabel ?? "pane"}`}
                              aria-label={`Resume session ${item.title}`}
                            >
                              {pending ? <Loader2 aria-hidden="true" className="spin" /> : <Play aria-hidden="true" />}
                              <span>{pending ? "Opening…" : "Resume"}</span>
                            </button>
                            {item.kind === "codex" ? (
                              <>
                                <button
                                  type="button"
                                  title="Rename session"
                                  aria-label={`Rename session ${item.title}`}
                                  onClick={() => {
                                    setRenamingId(item.id);
                                    setRenameDraft(item.title);
                                  }}
                                >
                                  <Pencil aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  disabled={pending}
                                  title="Archive session"
                                  aria-label={`Archive session ${item.title}`}
                                  onClick={() => void archiveItem(item)}
                                >
                                  <Archive aria-hidden="true" />
                                </button>
                              </>
                            ) : null}
                          </div>
                        )}
                        <small className="agent-sessions-row-preview">
                          {item.preview || item.firstUserMessage || "No preview"}
                        </small>
                        <small className="agent-sessions-row-meta">
                          {item.providerLabel} · {relativeTime(item.recencyAt ?? item.updatedAt)} ·{" "}
                          {item.model ?? "unknown model"}
                        </small>
                        {item.cwd ? <code className="agent-sessions-row-cwd">{item.cwd}</code> : null}
                      </article>
                    );
                  })
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="empty-mini" role="status">
            No agent sessions found
          </div>
        )}
      </section>

      {error && items.length ? (
        <div className="validation-result bad" role="alert">
          <strong>AGENT_SESSIONS_ERROR</strong>
          <small>{error}</small>
        </div>
      ) : null}

      {hasMore ? (
        <button
          type="button"
          className="agent-sessions-load-more"
          disabled={loadMorePending}
          onClick={() => void load(page + 1, true)}
        >
          {loadMorePending ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}
