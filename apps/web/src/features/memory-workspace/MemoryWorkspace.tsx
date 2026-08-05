import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  History,
  ListFilter,
  Network,
  Search,
  SlidersHorizontal,
  X
} from "../ui-theme/app-icons.js";
import type {
  MemoryEntry,
  MemoryGraphEdge,
  MemoryGraphIssue,
  MemoryGraphNode,
  MemoryGraphNodeDetail,
  MemoryGraphNodeType
} from "@space/contracts";
import { SpaceApiError, api, type MemoryGraphOverviewResponse, type MemoryGraphResponse } from "../../api.js";
import { MemoryIssueList } from "./MemoryIssueList.js";
import { MemoryJobsPanel } from "./MemoryJobsPanel.js";
import { MemoryGraphErrorBoundary } from "./MemoryGraphErrorBoundary.js";
import { MemoryNodeDetail } from "./MemoryNodeDetail.js";
import type { MemoryGraphDisplayMode } from "./DesktopMemoryGraph.js";

const DesktopMemoryGraph = lazy(() => import("./DesktopMemoryGraph.js"));
const MemoryChangeSetPanel = lazy(() =>
  import("./MemoryChangeSetPanel.js").then((module) => ({ default: module.MemoryChangeSetPanel }))
);
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

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function monthLabel(value: string): string {
  const [year, month] = value.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en", { month: "long", year: "numeric" });
}

function errorMessage(error: unknown): string {
  if (error instanceof SpaceApiError && error.code === "MEMORY_GRAPH_DISABLED") {
    return "Memory Graph is behind its guarded rollout flag. Enable it only after the canonical snapshot audit passes.";
  }
  return error instanceof Error ? error.message : "Memory Graph could not be loaded.";
}

function progressiveGraph(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  selectedNodeId: string | null,
  explorationActive: boolean
): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  if (explorationActive) return { nodes, edges };

  const visibleIds = new Set(
    nodes
      .filter((node) => node.type === "MEMORY" || node.type === "ROOM")
      .map((node) => node.id)
  );
  for (const edge of edges) {
    if (edge.type === "TAGGED_WITH" && edge.origin === "EXPLICIT_TAG") {
      visibleIds.add(edge.target);
    }
  }
  if (selectedNodeId) {
    visibleIds.add(selectedNodeId);
    for (const edge of edges) {
      if (edge.source === selectedNodeId) visibleIds.add(edge.target);
      if (edge.target === selectedNodeId) visibleIds.add(edge.source);
    }
  }

  return {
    nodes: nodes.filter((node) => visibleIds.has(node.id)),
    edges: edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
  };
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
  const [graphDisplayMode, setGraphDisplayMode] = useState<MemoryGraphDisplayMode>("SEMANTIC");
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [nodeType, setNodeType] = useState<"" | MemoryGraphNodeType>("");
  const [scope, setScope] = useState<"" | MemoryEntry["scope"]>("");
  const [sourcePath, setSourcePath] = useState("");
  const [month, setMonth] = useState("");
  const [lifecycleStatus, setLifecycleStatus] = useState<"" | "ACTIVE" | "ARCHIVED">("");
  const [issueStatus, setIssueStatus] = useState<"OPEN" | "IGNORED" | "RESOLVED">("OPEN");
  const [currentRoomOnly, setCurrentRoomOnly] = useState(false);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [graph, setGraph] = useState<MemoryGraphOverviewResponse | MemoryGraphResponse | null>(null);
  const [issues, setIssues] = useState<MemoryGraphIssue[]>([]);
  const [issueTotal, setIssueTotal] = useState(0);
  const [openIssueCount, setOpenIssueCount] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryGraphNodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const detailRequestRef = useRef(0);
  const issueRequestRef = useRef(0);
  const handleError = useCallback((caught: unknown) => setError(errorMessage(caught)), []);

  const graphFiltersActive = Boolean(
    query || nodeType || scope || sourcePath || lifecycleStatus || currentRoomOnly || month
  );
  const filtersOrDraftActive = Boolean(queryDraft || graphFiltersActive);
  const semanticGraphActive = shellMode !== "mobile" && graphDisplayMode === "SEMANTIC";
  const relationMode: "CLUSTERED" | "RELATIONS" = semanticGraphActive ||
    selectedNodeId ||
    graphFiltersActive
    ? "RELATIONS"
    : "CLUSTERED";
  const availableMonths = graph?.data.months ?? [];
  const monthOptions = availableMonths.filter((candidate) => candidate !== currentMonth());
  const selectedMonthLabel = month === "all"
    ? "All months"
    : month
      ? monthLabel(month)
      : "Current month";

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
      month: month || undefined,
      lifecycleStatus: lifecycleStatus || undefined,
      relationMode
    };
    void (async () => {
      try {
        const payload = shellMode === "mobile"
          ? await api.memoryGraph({ ...filters, page, pageSize: 100 })
          : await api.memoryGraphOverview(filters);
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
    return () => {
      active = false;
    };
  }, [
    activeRoomId,
    currentRoomOnly,
    lifecycleStatus,
    month,
    nodeType,
    page,
    query,
    relationMode,
    scope,
    shellMode,
    sourcePath
  ]);

  const refreshIssues = useCallback(async () => {
    const requestId = issueRequestRef.current + 1;
    issueRequestRef.current = requestId;
    try {
      const selectedPromise = api.memoryGraphIssues({ status: issueStatus, pageSize: 100 });
      const [selectedPayload, openPayload] = issueStatus === "OPEN"
        ? await selectedPromise.then((payload) => [payload, payload] as const)
        : await Promise.all([
          selectedPromise,
          api.memoryGraphIssues({ status: "OPEN", pageSize: 1 })
        ]);
      if (issueRequestRef.current !== requestId) return;
      setIssues(selectedPayload.data);
      setIssueTotal(selectedPayload.pagination.totalItems);
      setOpenIssueCount(openPayload.pagination.totalItems);
      setError(null);
    } catch (loadError) {
      if (issueRequestRef.current === requestId) setError(errorMessage(loadError));
    }
  }, [issueStatus]);

  useEffect(() => {
    void refreshIssues();
  }, [refreshIssues]);

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
    setMonth("");
    setLifecycleStatus("");
    setCurrentRoomOnly(false);
    setPage(1);
  }

  const selectNode = useCallback((nodeId: string) => {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setSelectedNodeId(nodeId);
    setDetail(null);
    setDetailLoading(true);
    api.memoryGraphNode(nodeId)
      .then((payload) => {
        if (detailRequestRef.current !== requestId) return;
        setDetail(payload);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (detailRequestRef.current === requestId) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (detailRequestRef.current === requestId) setDetailLoading(false);
      });
  }, []);

  const closeDetail = useCallback(() => {
    detailRequestRef.current += 1;
    setSelectedNodeId(null);
    setDetail(null);
    setDetailLoading(false);
  }, []);

  const rawNodes = graph?.data.nodes ?? [];
  const rawEdges = graph?.data.edges ?? [];
  const visibleGraph = useMemo(
    () => semanticGraphActive
      ? { nodes: rawNodes, edges: rawEdges }
      : progressiveGraph(rawNodes, rawEdges, selectedNodeId, graphFiltersActive),
    [graphFiltersActive, rawEdges, rawNodes, selectedNodeId, semanticGraphActive]
  );
  const pagination = graph && "pagination" in graph ? graph.pagination : undefined;
  const overview = graph && "truncated" in graph.data ? graph.data : null;
  const summary = graph?.data.summary;
  const rawNodeTypes = [...new Set(rawNodes.map((node) => node.type))].sort().join(",");
  const sourceOptions = [...new Set(
    rawNodes.flatMap((node) => node.sourcePath ? [node.sourcePath] : [])
  )].sort();

  return (
    <section className="memory-workspace" aria-label="Memory workspace" data-shell-mode={shellMode}>
      <header className="memory-workspace-header">
        <div className="memory-workspace-heading">
          <span className="memory-workspace-kicker"><Network aria-hidden="true" /> Canonical memory</span>
          <div>
            <h2>Memory workspace</h2>
            <p>{summary ? `${summary.recordCount} records · ${summary.nodeCount} nodes · ${selectedMonthLabel}` : "Loading records · nodes…"}</p>
          </div>
        </div>
        <div className="memory-workspace-header-actions">
          <MemoryJobsPanel onError={handleError} />
          <button
            type="button"
            className="icon-button"
            aria-label="Close memory workspace"
            title="Close memory workspace"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      {graph?.data.isStale ? (
        <div className="memory-snapshot-warning" role="status" aria-label="Memory snapshot warning">
          <AlertTriangle aria-hidden="true" />
          <span><strong>Snapshot out of date.</strong> Last generated <time dateTime={graph.data.generatedAt}>{graph.data.generatedAt}</time>.</span>
        </div>
      ) : null}

      <div className="memory-workspace-controls">
        <form className="memory-workspace-search" role="search" onSubmit={submitSearch}>
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
          <button
            type="button"
            className={advancedFiltersOpen || nodeType || scope || sourcePath || lifecycleStatus ? "is-active" : ""}
            aria-expanded={advancedFiltersOpen}
            aria-controls="memory-advanced-filters"
            onClick={() => setAdvancedFiltersOpen((open) => !open)}
          >
            <SlidersHorizontal aria-hidden="true" />
            Filters
          </button>
          <label className={`memory-month-select${month ? " is-active-filter" : ""}`} title="Show a single month or the full archive">
            <History aria-hidden="true" />
            <select
              aria-label="Memory month"
              name="memoryMonth"
              value={month}
              onChange={(event) => {
                setPage(1);
                setMonth(event.currentTarget.value);
              }}
            >
              <option value="">Current month</option>
              <option value="all">All months</option>
              {monthOptions.map((candidate) => (
                <option key={candidate} value={candidate}>{monthLabel(candidate)}</option>
              ))}
            </select>
          </label>
          {activeRoomId ? (
            <button
              type="button"
              className={currentRoomOnly ? "is-active" : ""}
              aria-pressed={currentRoomOnly}
              onClick={() => {
                setPage(1);
                setCurrentRoomOnly((current) => !current);
              }}
            >
              Current room
            </button>
          ) : null}
        </form>

        {advancedFiltersOpen ? (
          <div className="memory-advanced-filters" id="memory-advanced-filters">
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
              <select
                aria-label="Memory scope"
                name="memoryScope"
                value={scope}
                onChange={(event) => {
                  setPage(1);
                  setScope(event.currentTarget.value as typeof scope);
                }}
              >
                <option value="">All scopes</option>
                <option value="SYSTEM">System</option>
                <option value="PROJECT">Project</option>
                <option value="ROOM">Room</option>
              </select>
            </label>
            <label className={sourcePath ? "is-active-filter" : undefined}>
              <select
                aria-label="Memory source"
                name="memorySource"
                value={sourcePath}
                onChange={(event) => {
                  setPage(1);
                  setSourcePath(event.currentTarget.value);
                }}
              >
                <option value="">All sources</option>
                {sourceOptions.map((path) => <option key={path} value={path}>{path.split("/").at(-1)}</option>)}
              </select>
            </label>
            <label className={lifecycleStatus ? "is-active-filter" : undefined}>
              <select
                aria-label="Memory lifecycle"
                name="memoryLifecycle"
                value={lifecycleStatus}
                onChange={(event) => {
                  setPage(1);
                  setLifecycleStatus(event.currentTarget.value as typeof lifecycleStatus);
                }}
              >
                <option value="">All lifecycle states</option>
                <option value="ACTIVE">Active</option>
                <option value="ARCHIVED">Archived</option>
              </select>
            </label>
            {filtersOrDraftActive ? (
              <button type="button" onClick={clearFilters}>Clear filters</button>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="memory-workspace-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="memory-workspace-viewbar">
        <div className="memory-workspace-tabs" role="tablist" aria-label="Memory workspace views">
          <button type="button" role="tab" aria-selected={tab === "graph"} onClick={() => setTab("graph")}>Map</button>
          <button type="button" role="tab" aria-selected={tab === "issues"} onClick={() => setTab("issues")}>Issues <span>{openIssueCount}</span></button>
          <button type="button" role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>Changes</button>
        </div>
        {tab === "graph" && shellMode !== "mobile" ? (
          <div className="memory-workspace-map-modes" role="group" aria-label="Memory map mode">
            <button
              type="button"
              aria-pressed={graphDisplayMode === "SEMANTIC"}
              onClick={() => setGraphDisplayMode("SEMANTIC")}
            >
              Semantic Graph
            </button>
            <button
              type="button"
              aria-pressed={graphDisplayMode === "FOCUSED"}
              onClick={() => setGraphDisplayMode("FOCUSED")}
            >
              Focused Map
            </button>
          </div>
        ) : null}
        {tab === "issues" ? (
          <div className="memory-issue-status-filters" role="group" aria-label="Memory issue status">
            {(["OPEN", "IGNORED", "RESOLVED"] as const).map((status) => (
              <button
                key={status}
                type="button"
                aria-pressed={issueStatus === status}
                onClick={() => setIssueStatus(status)}
              >
                {status.charAt(0) + status.slice(1).toLocaleLowerCase()}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="memory-workspace-body">
        {tab === "graph" ? (
          <div
            className="memory-graph-layout"
            data-detail-open={selectedNodeId ? "true" : "false"}
            data-graph-mode={shellMode === "mobile" ? "LIST" : graphDisplayMode}
            data-raw-node-count={rawNodes.length}
            data-raw-edge-count={rawEdges.length}
            data-raw-node-types={rawNodeTypes}
            data-visible-node-count={visibleGraph.nodes.length}
            data-visible-edge-count={visibleGraph.edges.length}
          >
            {shellMode !== "mobile" ? (
              <MemoryGraphErrorBoundary>
                <Suspense fallback={<div className="memory-graph-loading" role="status">Loading graph renderer…</div>}>
                  <DesktopMemoryGraph
                    nodes={visibleGraph.nodes}
                    edges={visibleGraph.edges}
                    displayMode={graphDisplayMode}
                    relationMode={relationMode}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={selectNode}
                    loading={loading}
                    error={graphError}
                    totalNodes={overview?.totalMatchingNodes ?? rawNodes.length}
                    totalEdges={overview?.totalMatchingEdges ?? rawEdges.length}
                    truncated={overview?.truncated ?? false}
                  />
                </Suspense>
              </MemoryGraphErrorBoundary>
            ) : selectedNodeId ? null : (
              <NodeList
                nodes={visibleGraph.nodes}
                selectedNodeId={selectedNodeId}
                loading={loading}
                onSelect={selectNode}
              />
            )}
            {selectedNodeId ? (
              <MemoryNodeDetail
                detail={detail}
                loading={detailLoading}
                onClose={closeDetail}
                onOpenChanges={() => setTab("changes")}
              />
            ) : null}
          </div>
        ) : tab === "issues" ? (
          <div className="memory-issues-view">
            <p className="memory-issue-total">{issueTotal} {readableType(issueStatus)} issues</p>
            <MemoryIssueList
              issues={issues}
              status={issueStatus}
              onError={handleError}
              onUpdated={() => {
                void refreshIssues();
              }}
              onOpenRecord={(recordId) => {
                setTab("graph");
                selectNode(recordId);
              }}
            />
          </div>
        ) : (
          <Suspense fallback={<div className="memory-graph-loading" role="status">Loading guarded change sets…</div>}>
            <MemoryChangeSetPanel />
          </Suspense>
        )}
      </div>

      {tab === "graph" && shellMode === "mobile" && !selectedNodeId && pagination ? (
        <footer className="memory-workspace-pagination">
          <span>{pagination.totalItems} matching nodes · page {pagination.page} of {Math.max(pagination.totalPages, 1)}</span>
          <div>
            <button
              type="button"
              aria-label="Previous memory graph page"
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Next memory graph page"
              disabled={page >= pagination.totalPages}
              onClick={() => setPage((value) => value + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </button>
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
        <button
          key={node.id}
          type="button"
          className={node.id === selectedNodeId ? "selected" : ""}
          onClick={() => onSelect(node.id)}
        >
          <span data-node-type={node.type}>{readableType(node.type)}</span>
          <strong>{node.label}</strong>
          <small>{node.sourcePath?.split("/").at(-1) ?? node.id}</small>
        </button>
      ))}
    </section>
  );
}
