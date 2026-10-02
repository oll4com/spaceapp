import { useWorkspaceSurface } from "../ui-theme/WorkspaceSurface.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Pane, Room } from "@space/contracts";
import { api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import type { PaneCompletionLifecycleState } from "../../pane-completion-lifecycle.js";
import { Bot, Folder, LayoutDashboard, Maximize2, Minimize2, Search, X } from "../ui-theme/app-icons.js";
import { agentStatuses, agentStatusLabels, dashboardAge, dashboardProject, dashboardStatus, isDashboardAgent, type AgentStatus, type AgentDashboardSummary } from "./dashboard-model.js";
import "./agents-dashboard.css";

export const AGENTS_DASHBOARD_FILTER_KEY = "space.agentsDashboard.filter";

export function storageKeyForUser(userId?: string): string {
  return userId ? `${AGENTS_DASHBOARD_FILTER_KEY}.${userId}` : AGENTS_DASHBOARD_FILTER_KEY;
}

function getStorage(): Storage | null {
  try {
    return getSpaceRuntime().platform.localStorage;
  } catch {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
    return null;
  }
}

export function readStoredFilter(userId?: string): AgentStatus | "all" {
  try {
    const storage = getStorage();
    if (!storage) return "all";
    const userRaw = userId ? storage.getItem(storageKeyForUser(userId)) : null;
    const globalRaw = storage.getItem(AGENTS_DASHBOARD_FILTER_KEY);
    const raw = userRaw ?? globalRaw;
    if (raw === "all" || (typeof raw === "string" && agentStatuses.includes(raw as AgentStatus))) {
      return raw as AgentStatus | "all";
    }
    return "all";
  } catch {
    return "all";
  }
}

export function writeStoredFilter(filter: AgentStatus | "all", userId?: string): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    if (userId) {
      storage.setItem(storageKeyForUser(userId), filter);
    }
    storage.setItem(AGENTS_DASHBOARD_FILTER_KEY, filter);
  } catch {
    // Storage is optional.
  }
}

export interface AgentsDashboardProps {
  open?: boolean;
  userId?: string;
  rooms: readonly Room[];
  completions: PaneCompletionLifecycleState["panes"];
  activePanes?: readonly Pane[];
  onOpenPane: (pane: Pane) => Promise<void> | void;
  onClose: () => void;
  onSummaryChange?: (summary: AgentDashboardSummary) => void;
}

export function AgentsDashboard({ open = true, userId, rooms, completions, activePanes, onOpenPane, onClose, onSummaryChange }: AgentsDashboardProps) {
  const embedded = useWorkspaceSurface();
  const inFlight = useRef(false);
  const snapshots = useRef(new Map<string, { data: Pane[]; activity: Record<string, AgentStatus> }>());
  const missingRooms = useRef(new Set<string>());
  const dialog = useRef<HTMLDialogElement>(null);
  const [maximized, setMaximized] = useState(false);
  const [activity, setActivity] = useState<Record<string, AgentStatus>>({});
  const [panes, setPanes] = useState<Pane[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [sampledAt, setSampledAt] = useState<number | null>(null);
  const [filter, setFilter] = useState<AgentStatus | "all">(() => readStoredFilter(userId));
  const [groupBy, setGroupBy] = useState<"status" | "project">("status");
  const [query, setQuery] = useState("");
  const roomIds = JSON.stringify(rooms.filter(room => !room.archivedAt).map(room => room.id).sort());

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFilter(readStoredFilter(userId));
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.show();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } };
    element?.addEventListener("keydown", escape);
    return () => { element?.removeEventListener("keydown", escape); element?.close(); opener?.focus(); };
  }, [open, userId]);

  useEffect(() => {
    let disposed = false;
    let visibilityEpoch = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ids = JSON.parse(roomIds) as string[];
    for (const id of snapshots.current.keys()) if (!ids.includes(id)) snapshots.current.delete(id);
    for (const id of missingRooms.current) if (!ids.includes(id)) missingRooms.current.delete(id);
    const visible = () => document.visibilityState !== "hidden";
    // Read pane metadata only. Opening the dashboard never mounts a room or attaches a session.
    const load = async () => {
      if (disposed || !visible()) return;
      clearTimeout(timer);
      if (inFlight.current) { timer = setTimeout(() => void load(), 250); return; }
      inFlight.current = true;
      const epoch = visibilityEpoch;
      try {
        let failures = 0;
        const publish = () => {
          const values = [...snapshots.current.values()];
          setPanes(values.flatMap(value => value.data).filter(isDashboardAgent));
          setActivity(Object.assign({}, ...values.map(value => value.activity)));
          setLoaded(values.length > 0 || ids.length === 0 || ids.every(id => missingRooms.current.has(id)));
        };
        publish();
        // One room at a time; publish each success without waiting for other rooms.
        for (const roomId of ids) {
          if (disposed || !visible() || epoch !== visibilityEpoch) break;
          if (missingRooms.current.has(roomId)) continue;
          try {
            const snapshot = await api.dashboardAgents(roomId);
            if (disposed || !visible() || epoch !== visibilityEpoch) break;
            snapshots.current.set(roomId, snapshot);
            publish();
            setSampledAt(Date.now());
          } catch (error) {
            if (disposed || !visible() || epoch !== visibilityEpoch) break;
            const status = (error as { status?: number })?.status;
            if (status === 404 || status === 403) {
              snapshots.current.delete(roomId);
              // Deleted rooms can remain in an older navigation snapshot.
              if (status === 404) missingRooms.current.add(roomId);
              publish();
            } else failures++;
          }
        }
        if (!disposed && visible() && epoch === visibilityEpoch) {
          setError(failures ? "Some rooms could not be refreshed. Keeping available agents; retrying automatically." : null);
        }
      } finally {
        inFlight.current = false;
        clearTimeout(timer);
        if (!disposed && visible()) timer = setTimeout(() => void load(), 10_000);
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      visibilityEpoch++;
      if (document.visibilityState !== "hidden") void load();
    };
    void load();
    document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [roomIds]);

  const entries = useMemo(() => {
    const names = new Map(rooms.map(room => [room.id, room.name]));
    const paneMap = new Map<string, Pane>();
    for (const p of panes) {
      if (names.has(p.roomId)) paneMap.set(p.id, p);
    }
    if (activePanes) {
      for (const p of activePanes) {
        if (names.has(p.roomId) && isDashboardAgent(p)) paneMap.set(p.id, p);
      }
    }
    return [...paneMap.values()].map(pane => {
      const roomName = names.get(pane.roomId)!;
      const runtime = cliRuntimePresentation(pane.mode === "HARNESS" ? "cli:harness" : pane.terminalRuntimeId ?? (pane.mode === "TERMINAL" ? "cli:codex" : pane.providerId));
      const status = activity[pane.id] ?? dashboardStatus(pane, completions[pane.id]);
      return { pane, roomName, runtime, provider: runtime?.displayName ?? pane.providerId ?? "Space Agent", status, project: dashboardProject(pane, roomName) };
    }).sort((a, b) => b.pane.updatedAt.localeCompare(a.pane.updatedAt) || a.pane.id.localeCompare(b.pane.id));
  }, [panes, activePanes, rooms, completions, activity]);
  const counts = Object.fromEntries(agentStatuses.map(status => [status, entries.filter(entry => entry.status === status).length])) as Record<AgentStatus, number>;

  useEffect(() => {
    const summary: AgentDashboardSummary = {
      total: entries.length,
      working: counts.working,
      waiting: counts.waiting,
      done: counts.done,
      idle: counts.idle,
      loaded,
    };
    onSummaryChange?.(summary);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("space:agents-dashboard-summary", { detail: summary }));
    }
  }, [entries.length, counts.working, counts.waiting, counts.done, counts.idle, loaded, onSummaryChange]);
  const visible = entries.filter(entry => (filter === "all" || entry.status === filter) &&
    [entry.pane.title, entry.roomName, entry.project.path, entry.provider, entry.pane.modelId ?? "", entry.pane.taskMetadata?.description ?? ""].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const groups = groupBy === "status"
    ? agentStatuses.map(status => ({ key: status, label: agentStatusLabels[status], status, entries: visible.filter(entry => entry.status === status) }))
    : [...new Map(visible.map(entry => [entry.project.key, entry.project])).values()].sort((a, b) => a.path.localeCompare(b.path)).map(project => ({ key: project.key, label: project.label, path: project.path, status: undefined, entries: visible.filter(entry => entry.project.key === project.key) }));

  const handleFilterChange = (nextFilter: AgentStatus | "all") => {
    setFilter(nextFilter);
    writeStoredFilter(nextFilter, userId);
  };

  async function openPane(pane: Pane) {
    setOpening(pane.id);
    try { await onOpenPane(pane); onClose(); }
    catch { setError("This agent could not be opened. Refresh the dashboard and try again."); }
    finally { setOpening(null); }
  }

  if (!open) return null;

  return <dialog ref={dialog} data-embedded={embedded || undefined} className={`agents-dashboard${maximized ? " is-maximized" : ""}`} aria-labelledby="agents-dashboard-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="agents-dashboard-content">
      <header className="agents-dashboard-header">
        <span className="agents-dashboard-brand"><LayoutDashboard aria-hidden="true" /></span><div className="agents-dashboard-heading"><h2 id="agents-dashboard-title">Agents Dashboard</h2><p>Activity across your rooms</p></div>
        <div className="agents-dashboard-actions">
          <button type="button" className="agents-dashboard-icon agents-dashboard-expand-toggle" aria-label={maximized ? "Collapse agents dashboard" : "Expand agents dashboard"} aria-pressed={maximized} onClick={() => setMaximized(value => !value)}>{maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</button>
          <button type="button" className="agents-dashboard-icon agents-dashboard-close-btn" aria-label="Close agents dashboard" onClick={onClose}><X aria-hidden="true" /></button>
        </div>
      </header>
      <div className="agents-dashboard-summary">
        <div className="agents-dashboard-total"><strong>{loaded ? entries.length : "—"}</strong><div><b>agents</b><small>{counts.working} working · {counts.done} done · {counts.idle} idle</small></div></div>
        <div className="agents-dashboard-segmented" role="group" aria-label="Group agents by">
          <button type="button" aria-pressed={groupBy === "status"} onClick={() => setGroupBy("status")}>Status</button>
          <button type="button" aria-pressed={groupBy === "project"} onClick={() => setGroupBy("project")}>Project</button>
        </div>
      </div>
      <div className="agents-dashboard-distribution" aria-label={agentStatuses.map(status => `${counts[status]} ${agentStatusLabels[status]}`).join(", ")}>
        {agentStatuses.map(status => counts[status] > 0 && <span key={status} data-status={status} style={{ flex: counts[status] }} />)}
      </div>
      <div className="agents-dashboard-controls">
        <div className="agents-dashboard-filters" role="group" aria-label="Filter agents by status">
          <button type="button" aria-pressed={filter === "all"} onClick={() => handleFilterChange("all")}>All <span>{entries.length}</span></button>
          {agentStatuses.map(status => <button key={status} type="button" data-status={status} aria-pressed={filter === status} onClick={() => handleFilterChange(status)}><i />{agentStatusLabels[status]} <span>{counts[status]}</span></button>)}
        </div>
        <label className="agents-dashboard-search"><Search aria-hidden="true" /><input autoFocus type="search" aria-label="Search agents" placeholder="Search agents, projects or rooms…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      </div>
      <div className="agents-dashboard-body" aria-busy={!loaded && !error}>
        {error && <p className="agents-dashboard-error" role="alert">{error}</p>}
        {!loaded && !error ? <p className="agents-dashboard-empty" role="status">Loading agents…</p> : null}
        {loaded && visible.length === 0 ? <div className="agents-dashboard-empty"><Bot aria-hidden="true" /><h3>{entries.length ? "No matching agents" : "Your agents will appear here"}</h3><p>{entries.length ? "Try another filter or search." : "Open an AI CLI, Chat or Harness pane in a room to get started."}</p></div> : null}
        {groups.filter(group => group.entries.length > 0).map(group => <section className="agents-dashboard-group" key={group.key} aria-label={group.label}>
          <h3 data-status={group.status}>{group.status ? <i /> : <Folder aria-hidden="true" />}<span title={"path" in group ? group.path : undefined}>{group.label}</span><small>{group.entries.length}</small></h3>
          <div className="agents-dashboard-grid">{group.entries.map(({ pane, roomName, runtime, provider, status, project }) => <button key={pane.id} type="button" className="agents-dashboard-card" data-status={status} disabled={opening !== null} onClick={() => void openPane(pane)} aria-label={`Open ${pane.title} in ${roomName}`}>
            <span className="agents-dashboard-avatar">{runtime ? <img src={runtime.iconSrc} alt="" /> : <Bot aria-hidden="true" />}<i /></span>
            <span className="agents-dashboard-card-content"><strong title={pane.title}>{pane.title}</strong><small title={`${provider} · ${project.path}`}>{provider} · {project.label}</small>
              {pane.taskMetadata?.description && <span className="agents-dashboard-preview">{pane.taskMetadata.description}</span>}
              <span className="agents-dashboard-card-footer"><span title={roomName}>{roomName}</span><time dateTime={pane.updatedAt} title="Last pane activity">{dashboardAge(pane.updatedAt, sampledAt ?? Date.now())}</time></span>
            </span>
            <span className="agents-dashboard-badge"><i />{opening === pane.id ? "Opening…" : pane.status === "ERROR" ? "Needs attention" : agentStatusLabels[status]}</span>
          </button>)}</div>
        </section>)}
      </div>
      <footer className="agents-dashboard-footer"><span>{visible.length} of {entries.length} agents · All rooms</span><span>{error ? "Update delayed" : sampledAt ? "Updates every 10 seconds" : "Connecting…"}</span></footer>
    </div>
  </dialog>;
}
