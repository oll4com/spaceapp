import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Database, ListFilter, Network, RefreshCw, Search, X } from "lucide-react";
import type { MemoryEntry, MemoryGraphIssue, MemoryGraphNode, MemoryGraphNodeDetail, MemoryGraphNodeType } from "@space/contracts";
import { SpaceApiError, api, type MemoryGraphOverviewResponse, type MemoryGraphResponse } from "../../api.js";
import { MemoryIssueList } from "./MemoryIssueList.js";
import { MemoryJobsPanel } from "./MemoryJobsPanel.js";
import { MemoryGraphErrorBoundary } from "./MemoryGraphErrorBoundary.js";
import { MemoryNodeDetail } from "./MemoryNodeDetail.js";

const DesktopMemoryGraph = lazy(() => import("./DesktopMemoryGraph.js"));
const MemoryChangeSetPanel = lazy(() => import("./MemoryChangeSetPanel.js").then((module) => ({ default: module.MemoryChangeSetPanel })));
const nodeTypes: Array<{ value: "" | MemoryGraphNodeType; label: string }> = [
  { value: "", label: "All node types" },
  { value: "MEMORY", label: "Memory blocks" },
  { value: "SOURCE", label: "Sources" },
  { value: "SECTION", label: "Sections" },
  { value: "ROOM", label: "Rooms" },
  { value: "PROVENANCE", label: "Provenance" },
  { value: "TOPIC", label: "Topics" },
  { value: "CACHE_RECORD", label: "Cache records" }
];

function readableType(value: string): string {
  return value.toLocaleLowerCase().replaceAll("_", " ");
}

function errorMessage(error: unknown): string {
  if (error instanceof SpaceApiError && error.code === "MEMORY_GRAPH_DISABLED") {
    return "Memory Graph is behind its guarded rollout flag. Enable it only after the canonical snapshot audit passes.";
  }
  return error instanceof Error ? error.message : "Memory Graph could not be loaded.";
}

export function MemoryWorkspace({
  shellMode,
  activeRoomId,
  onClose
}: {
  shellMode: "desktop" | "tablet" | "mobile";
  activeRoomId: string | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"graph" | "issues" | "changes">("graph");
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [nodeType, setNodeType] = useState<"" | MemoryGraphNodeType>("");
  const [scope, setScope] = useState<"" | MemoryEntry["scope"]>("");
  const [sourcePath, setSourcePath] = useState("");
  const [lifecycleStatus, setLifecycleStatus] = useState<"" | "ACTIVE" | "ARCHIVED">("");
  const [relationMode, setRelationMode] = useState<"CLUSTERED" | "RELATIONS">("RELATIONS");
  const [issueStatus, setIssueStatus] = useState<"OPEN" | "IGNORED" | "RESOLVED">("OPEN");
  const [currentRoomOnly, setCurrentRoomOnly] = useState(false);
  const [detailsVisible, setDetailsVisible] = useState(true);
  const [page, setPage] = useState(1);
  const [graph, setGraph] = useState<MemoryGraphOverviewResponse | MemoryGraphResponse | null>(null);
  const [issues, setIssues] = useState<MemoryGraphIssue[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryGraphNodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const handleError = useCallback((caught: unknown) => setError(errorMessage(caught)), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setGraphError(null);
    const filters = {
      q: query || undefined,
      nodeType: nodeType || undefined,
      scope: scope || undefined,
      roomId: currentRoomOnly ? activeRoomId ?? undefined : undefined,
      sourcePath: sourcePath || undefined,
      lifecycleStatus: lifecycleStatus || undefined,
      relationMode
    };
    void (async () => {
      try {
        const payload = shellMode === "desktop"
          ? await api.memoryGraphOverview(filters)
          : await api.memoryGraph({ ...filters, page, pageSize: 100 });
        if (!active) return;
        setGraph(payload);
        setGraphError(null);
        setError(null);
      } catch (loadError) {
        if (active) {
          const message = errorMessage(loadError);
          setGraphError(message);
          setError(message);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [activeRoomId, currentRoomOnly, lifecycleStatus, nodeType, page, query, relationMode, scope, shellMode, sourcePath]);

  useEffect(() => {
    let active = true;
    api.memoryGraphIssues({ status: issueStatus, pageSize: 100 })
      .then((payload) => { if (active) setIssues(payload.data); })
      .catch((loadError: unknown) => { if (active) setError(errorMessage(loadError)); });
    return () => { active = false; };
  }, [issueStatus]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(queryDraft.trim());
  }

  function clearFilters() {
    setQueryDraft("");
    setQuery("");
    setNodeType("");
    setScope("");
    setSourcePath("");
    setLifecycleStatus("");
    setRelationMode("RELATIONS");
    setIssueStatus("OPEN");
    setCurrentRoomOnly(false);
    setPage(1);
  }

  const selectNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setDetailLoading(true);
    api.memoryGraphNode(nodeId)
      .then((payload) => {
        setDetail(payload);
        setError(null);
      })
      .catch((loadError: unknown) => setError(errorMessage(loadError)))
      .finally(() => setDetailLoading(false));
  }, []);

  const nodes = graph?.data.nodes ?? [];
  const pagination = graph && "pagination" in graph ? graph.pagination : undefined;
  const overview = graph && "truncated" in graph.data ? graph.data : null;
  const summary = graph?.data.summary;
  const sourceOptions = [...new Set((graph?.data.nodes ?? []).flatMap((node) => node.sourcePath ? [node.sourcePath] : []))].sort();
  const hasActiveFilters = Boolean(
    queryDraft || query || nodeType || scope || sourcePath || lifecycleStatus ||
    relationMode !== "RELATIONS" || issueStatus !== "OPEN" || currentRoomOnly
  );

  return (
    <section className="memory-workspace" aria-label="Memory workspace" data-shell-mode={shellMode}>
      <header className="memory-workspace-header">
        <div>
          <span className="memory-workspace-kicker"><Network aria-hidden="true" /> Canonical memory graph</span>
          <h2>Memory workspace</h2>
          <p>Inspect block-level history and manage audited proposals through guarded canonical write controls.</p>
        </div>
        <button type="button" className="icon-button" aria-label="Close memory workspace" title="Close memory workspace" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>

      <div className="memory-workspace-summary" aria-label="Memory graph summary">
        <article><Database aria-hidden="true" /><span>Records</span><strong>{summary?.recordCount ?? "—"}</strong></article>
        <article><Network aria-hidden="true" /><span>Nodes</span><strong>{summary?.nodeCount ?? "—"}</strong></article>
        <article><AlertTriangle aria-hidden="true" /><span>Open issues</span><strong>{summary?.issueCount ?? issues.length}</strong></article>
        <article data-state={graph?.data.isStale ? "stale" : "current"}>
          <RefreshCw aria-hidden="true" /><span>Snapshot</span><strong>{graph?.data.isStale ? "Stale" : graph ? "Current" : "—"}</strong>
        </article>
      </div>

      <MemoryJobsPanel onError={handleError} />

      <form className="memory-workspace-filters" role="search" onSubmit={submitSearch}>
        <label className={`memory-search-input${queryDraft || query ? " is-active-filter" : ""}`}>
          <Search aria-hidden="true" />
          <input
            type="search"
            name="memoryQuery"
            aria-label="Search canonical memory"
            placeholder="Search titles, content, provenance…"
            value={queryDraft}
            onChange={(event) => setQueryDraft(event.currentTarget.value)}
          />
        </label>
        <label className={nodeType ? "is-active-filter" : undefined}>
          <ListFilter aria-hidden="true" />
          <select
            aria-label="Memory node type"
            name="memoryNodeType"
            value={nodeType}
            onChange={(event) => {
              setPage(1);
              setNodeType(event.currentTarget.value as "" | MemoryGraphNodeType);
            }}
          >
            {nodeTypes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className={scope ? "is-active-filter" : undefined}>
          <select aria-label="Memory scope" name="memoryScope" value={scope} onChange={(event) => { setPage(1); setScope(event.currentTarget.value as typeof scope); }}>
            <option value="">All scopes</option>
            <option value="SYSTEM">System</option>
            <option value="PROJECT">Project</option>
            <option value="ROOM">Room</option>
          </select>
        </label>
        <label className={sourcePath ? "is-active-filter" : undefined}>
          <select aria-label="Memory source" name="memorySource" value={sourcePath} onChange={(event) => { setPage(1); setSourcePath(event.currentTarget.value); }}>
            <option value="">All sources</option>
            {sourceOptions.map((path) => <option key={path} value={path}>{path.split("/").at(-1)}</option>)}
          </select>
        </label>
        <label className={lifecycleStatus ? "is-active-filter" : undefined}>
          <select aria-label="Memory lifecycle" name="memoryLifecycle" value={lifecycleStatus} onChange={(event) => { setPage(1); setLifecycleStatus(event.currentTarget.value as typeof lifecycleStatus); }}>
            <option value="">All lifecycle states</option>
            <option value="ACTIVE">Active</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </label>
        <label className={relationMode !== "RELATIONS" ? "is-active-filter" : undefined}>
          <select aria-label="Memory relation mode" name="memoryRelationMode" value={relationMode} onChange={(event) => { setPage(1); setRelationMode(event.currentTarget.value as typeof relationMode); }}>
            <option value="CLUSTERED">Clustered map</option>
            <option value="RELATIONS">Relations map</option>
          </select>
        </label>
        <label className={issueStatus !== "OPEN" ? "is-active-filter" : undefined}>
          <select aria-label="Memory issue status" name="memoryIssueStatus" value={issueStatus} onChange={(event) => setIssueStatus(event.currentTarget.value as typeof issueStatus)}>
            <option value="OPEN">Open issues</option>
            <option value="IGNORED">Ignored issues</option>
            <option value="RESOLVED">Resolved issues</option>
          </select>
        </label>
        <div className="memory-filter-actions" role="group" aria-label="Memory filter actions">
          <button
            type="button"
            className={currentRoomOnly ? "is-active" : ""}
            aria-pressed={currentRoomOnly}
            disabled={!activeRoomId}
            onClick={() => {
              setPage(1);
              setCurrentRoomOnly((current) => !current);
            }}
          >
            Current room
          </button>
          <button type="submit">Search</button>
          <button type="button" disabled={!hasActiveFilters} onClick={clearFilters}>Clear filters</button>
        </div>
      </form>

      {error ? <div className="memory-workspace-error" role="alert"><AlertTriangle aria-hidden="true" /><span>{error}</span></div> : null}

      <div className="memory-workspace-viewbar">
        <div className="memory-workspace-tabs" role="tablist" aria-label="Memory workspace views">
          <button type="button" role="tab" aria-selected={tab === "graph"} onClick={() => setTab("graph")}>Map</button>
          <button type="button" role="tab" aria-selected={tab === "issues"} onClick={() => setTab("issues")}>Issues <span>{issues.length}</span></button>
          <button type="button" role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>Changes</button>
        </div>
        {tab === "graph" ? (
          <button
            type="button"
            className="memory-details-toggle"
            aria-pressed={detailsVisible}
            onClick={() => setDetailsVisible((visible) => !visible)}
          >
            {detailsVisible ? "Hide details" : "Show details"}
          </button>
        ) : null}
      </div>

      <div className="memory-workspace-body">
        {tab === "graph" ? (
          <div className="memory-graph-layout" data-details-visible={detailsVisible ? "true" : "false"}>
            {shellMode === "desktop" ? (
              <MemoryGraphErrorBoundary>
                <Suspense fallback={<div className="memory-graph-loading" role="status">Loading graph renderer…</div>}>
                  <DesktopMemoryGraph
                    nodes={nodes}
                    edges={graph?.data.edges ?? []}
                    relationMode={relationMode}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={selectNode}
                    loading={loading}
                    error={graphError}
                    totalNodes={overview?.totalMatchingNodes ?? nodes.length}
                    totalEdges={overview?.totalMatchingEdges ?? graph?.data.edges.length ?? 0}
                    truncated={overview?.truncated ?? false}
                  />
                </Suspense>
              </MemoryGraphErrorBoundary>
            ) : (
              <NodeList nodes={nodes} selectedNodeId={selectedNodeId} loading={loading} onSelect={selectNode} />
            )}
            {detailsVisible && (shellMode === "desktop" || detail || detailLoading) ? (
              <MemoryNodeDetail detail={detail} loading={detailLoading} onOpenChanges={() => setTab("changes")} />
            ) : null}
          </div>
        ) : tab === "issues" ? (
          <MemoryIssueList
            issues={issues}
            status={issueStatus}
            onError={handleError}
            onUpdated={(updated) => {
              setError(null);
              setIssues((current) => updated.status === issueStatus
                ? current.map((issue) => issue.id === updated.id ? updated : issue)
                : current.filter((issue) => issue.id !== updated.id));
            }}
            onOpenRecord={(recordId) => {
              setTab("graph");
              selectNode(recordId);
            }}
          />
        ) : (
          <Suspense fallback={<div className="memory-graph-loading" role="status">Loading guarded change sets…</div>}>
            <MemoryChangeSetPanel />
          </Suspense>
        )}
      </div>

      {tab === "graph" && pagination ? (
        <footer className="memory-workspace-pagination">
          <span>{pagination.totalItems} matching nodes · page {pagination.page} of {Math.max(pagination.totalPages, 1)}</span>
          <div>
            <button type="button" aria-label="Previous memory graph page" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft aria-hidden="true" /></button>
            <button type="button" aria-label="Next memory graph page" disabled={page >= pagination.totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight aria-hidden="true" /></button>
          </div>
        </footer>
      ) : null}
    </section>
  );
}

function NodeList({
  nodes,
  selectedNodeId,
  loading,
  onSelect
}: {
  nodes: MemoryGraphNode[];
  selectedNodeId: string | null;
  loading: boolean;
  onSelect: (nodeId: string) => void;
}) {
  return (
    <section className="memory-node-list" aria-label="Memory graph nodes">
      {loading ? <p role="status">Loading canonical graph…</p> : null}
      {!loading && nodes.length === 0 ? <p>No nodes match the current filters.</p> : null}
      {nodes.map((node) => (
        <button key={node.id} type="button" className={node.id === selectedNodeId ? "selected" : ""} onClick={() => onSelect(node.id)}>
          <span data-node-type={node.type}>{readableType(node.type)}</span>
          <strong>{node.label}</strong>
          <small>{node.sourcePath?.split("/").at(-1) ?? node.id}</small>
        </button>
      ))}
    </section>
  );
}
