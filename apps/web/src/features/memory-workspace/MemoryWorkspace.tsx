import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Calendar as CalendarIcon, Network, Search, X } from "../ui-theme/app-icons.js";
import type { MemoryGraphNodeDetail } from "@space/contracts";
import { api, type MemoryGraphOverviewResponse } from "../../api.js";
import { MemoryGraphErrorBoundary } from "./MemoryGraphErrorBoundary.js";
import { MemoryNodeDetail } from "./MemoryNodeDetail.js";
import { createMemoryAtlas, type MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { MemoryGraph3D } from "./MemoryGraph3D.js";
import { selectMemory3DFallbackNodes, type MemoryPoint3D } from "./memory-3d.js";
import type { MemoryNetworkLayoutWorkerMessage } from "./memory-network-layout.worker.js";
import { MemoryCalendarView } from "./MemoryCalendarView.js";
import "./memory-atlas.css";

const DesktopMemoryGraph = lazy(() => import("./DesktopMemoryGraph.js"));

function readInitial3DFromLocation(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("view3D") === "1" || params.get("view") === "3d";
}

function readRequestedOverviewLimit(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("demoNodes") ?? params.get("demoGraphNodes") ?? params.get("memoryGraphNodes") ?? params.get("memoryGraphLimit");
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.min(50_000, parsed);
}

const EMPTY_COORDINATES = new Map<string, MemoryPoint3D>();

export function MemoryWorkspace({ shellMode, onClose, initialMode = "calendar" }: {
  shellMode: "desktop" | "tablet" | "mobile";
  activeRoomId: string | null;
  onClose: () => void;
  initialMode?: "atlas" | "calendar";
}) {
  const [workspaceMode, setWorkspaceMode] = useState<"atlas" | "calendar">(initialMode);
  const [view3D, setView3D] = useState(readInitial3DFromLocation);
  const [showTitles, setShowTitles] = useState(true);
  const [reset3D, setReset3D] = useState(0);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [graph, setGraph] = useState<MemoryGraphOverviewResponse | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryGraphNodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeDetail = useCallback(() => {
    detailRequest.current++;
    setSelectedNodeId(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError(null);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryDraft.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [queryDraft]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (selectedNodeId) closeDetail();
        else if (queryDraft) { setQueryDraft(""); setQuery(""); }
        else onClose();
      }
      if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLElement && event.target.isContentEditable)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeDetail, onClose, queryDraft, selectedNodeId]);

  const requestedLimit = useMemo(() => {
    const urlLimit = readRequestedOverviewLimit();
    if (urlLimit !== undefined) return urlLimit;
    return view3D ? 50_000 : undefined;
  }, [view3D]);

  useEffect(() => {
    if (workspaceMode !== "atlas") return;
    // Avoid re-fetching when toggling 3D if the current overview response was not truncated.
    if (
      requestedLimit === 50_000 &&
      graph &&
      !graph.data.truncated &&
      (graph.data.filters.q ?? "") === query
    ) {
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    closeDetail();
    // Search covers the entire archive; removing the month picker must not hide old memories.
    void api.memoryGraphOverview({
      q: query || undefined,
      month: "all",
      relationMode: "RELATIONS",
      ...(requestedLimit !== undefined ? { limit: requestedLimit } : {})
    })
      .then(payload => { if (active) setGraph(payload); })
      .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "Memory could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceMode, query, requestedLimit, closeDetail]);

  useEffect(() => () => { detailRequest.current++; }, []);
  const selectNode = useCallback((nodeId: string) => {
    const request = ++detailRequest.current;
    setSelectedNodeId(nodeId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    void api.memoryGraphNode(nodeId)
      .then(payload => { if (request === detailRequest.current) setDetail(payload); })
      .catch(caught => { if (request === detailRequest.current) setDetailError(caught instanceof Error ? caught.message : "This memory could not be opened."); })
      .finally(() => { if (request === detailRequest.current) setDetailLoading(false); });
  }, []);

  const atlas = useMemo(() => createMemoryAtlas(graph?.data.nodes ?? [], graph?.data.edges ?? [], false), [graph]);
  const [layout, setLayout] = useState<{
    atlas: typeof atlas;
    positions: Map<string, MemoryAtlasPosition>;
    depth: Map<string, MemoryPoint3D>;
    coords3d: Float32Array | null;
    done: boolean;
  } | null>(null);

  useEffect(() => {
    if (workspaceMode !== "atlas" || !atlas.nodes.length || typeof Worker === "undefined") return;
    const worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<MemoryNetworkLayoutWorkerMessage>) => {
      const { positions, depth, coords3d, done } = event.data;
      const isDone = done !== false;
      setLayout(prev => {
        const nextPositions = positions
          ? new Map([...atlas.positions].map(([id, position]) => {
              const coord = new Map(positions).get(id);
              return [id, coord ? { ...position, ...coord } : position];
            }))
          : (prev?.atlas === atlas ? prev.positions : atlas.positions);
        const nextDepth = depth
          ? new Map(depth)
          : (prev?.atlas === atlas ? prev.depth : EMPTY_COORDINATES);
        return {
          atlas,
          positions: nextPositions,
          depth: nextDepth,
          coords3d: coords3d ?? null,
          done: isDone
        };
      });
      if (isDone) {
        worker.terminate();
      }
    };
    worker.onerror = event => { setError(`Memory layout could not be calculated: ${event.message || "worker unavailable"}`); worker.terminate(); };
    worker.postMessage({ nodes: atlas.nodes, edges: atlas.edges });
    return () => worker.terminate();
  }, [workspaceMode, atlas]);

  const hasInitialLayoutFrame = layout?.atlas === atlas;
  const layoutPending = typeof Worker !== "undefined" && atlas.nodes.length > 0 && !hasInitialLayoutFrame;
  const atlasPositions = layout?.atlas === atlas ? layout.positions : atlas.positions;
  const summary = graph?.data.summary;
  const atlasMetrics = useMemo(() => {
    let memoryCount = 0;
    let sourceCount = 0;
    let rootId = "";
    for (let i = 0; i < atlas.nodes.length; i++) {
      const node = atlas.nodes[i]!;
      if (node.type === "MEMORY") memoryCount++;
      else if (node.type === "SOURCE") {
        sourceCount++;
        if (!rootId && isMemoryCoreLabel(node.label)) rootId = node.id;
      }
    }
    let sourceLinkCount = 0;
    for (let i = 0; i < atlas.edges.length; i++) {
      const edge = atlas.edges[i]!;
      if (edge.type === "CONTAINS" || edge.type === "DERIVED_FROM") sourceLinkCount++;
    }
    return {
      memoryCount,
      sourceCount,
      sourceLinkCount,
      rootVisible: Boolean(rootId),
      rootId
    };
  }, [atlas]);

  const graph2D = useMemo(
    () => selectMemory3DFallbackNodes(atlas.nodes, atlas.edges, selectedNodeId, 2000),
    [atlas.nodes, atlas.edges, selectedNodeId]
  );

  const displayGroups = useMemo(() => atlas.groups.filter(group => group.kind !== "tag" || group.count >= 10), [atlas.groups]);
  return (
    <section id="memory-atlas" className="memory-workspace memory-atlas" aria-label="Memory workspace" data-shell-mode={shellMode} data-workspace-mode={workspaceMode} data-view-mode={view3D ? "3D" : "2D"} data-titles-visible={showTitles} data-atlas-layout="network" data-layout-ready={Boolean(layout?.atlas === atlas && layout.done)} data-layout-root-x={atlasPositions.get(atlasMetrics.rootId)?.x} data-atlas-group-count={displayGroups.length} data-atlas-color-count={new Set(displayGroups.map(group => group.color)).size}>
      <header className="memory-atlas-header memory-workspace-header">
        <div className="memory-atlas-brand">
          {workspaceMode === "calendar" ? <CalendarIcon aria-hidden="true" /> : <Network aria-hidden="true" />}
          <h2>Memory</h2>
          <span>{workspaceMode === "calendar" ? "CALENDAR" : "ATLAS"}</span>
        </div>
        <form className="memory-workspace-controls memory-workspace-search" role="search" onSubmit={event => { event.preventDefault(); setQuery(queryDraft.trim()); }}>
          <label className="memory-search-input">
            <Search aria-hidden="true" />
            <input ref={searchRef} type="search" name="memoryQuery" aria-label="Search canonical memory" placeholder="Search your memory…" value={queryDraft} onChange={event => setQueryDraft(event.currentTarget.value)} />
            {queryDraft ? <button type="button" aria-label="Clear memory search" onClick={() => { setQueryDraft(""); setQuery(""); searchRef.current?.focus(); }}><X aria-hidden="true" /></button> : <kbd>/</kbd>}
          </label>
        </form>
        <div className="memory-atlas-actions">
          <div className="memory-workspace-mode-selector" role="group" aria-label="Memory mode switcher">
            <button
              type="button"
              className={`memory-mode-pill ${workspaceMode === "atlas" ? "is-active" : ""}`}
              aria-pressed={workspaceMode === "atlas"}
              onClick={() => { setWorkspaceMode("atlas"); closeDetail(); }}
            >
              <Network aria-hidden="true" /> Atlas
            </button>
            <button
              type="button"
              className={`memory-mode-pill ${workspaceMode === "calendar" ? "is-active" : ""}`}
              aria-pressed={workspaceMode === "calendar"}
              onClick={() => { setWorkspaceMode("calendar"); closeDetail(); }}
            >
              <CalendarIcon aria-hidden="true" /> Calendar
            </button>
          </div>
          {workspaceMode === "atlas" ? (
            <div className="memory-atlas-view-controls" aria-label="Memory view controls">
              <button type="button" aria-label="Toggle 3D memory view" aria-pressed={view3D} onClick={() => setView3D(value => !value)}><span aria-hidden="true">◇</span> {view3D ? "2D" : "3D"}</button>
              <button type="button" aria-label="Toggle memory titles" aria-pressed={showTitles} onClick={() => setShowTitles(value => !value)}>Aa <span>Titles</span></button>
              {view3D ? <button type="button" aria-label="Reset 3D memory view" onClick={() => setReset3D(value => value + 1)}>↺</button> : null}
            </div>
          ) : null}
          <button type="button" className="icon-button memory-atlas-close" aria-label="Close memory workspace" onClick={onClose}><X aria-hidden="true" /></button>
        </div>
      </header>
      <div className="memory-atlas-stage memory-workspace-body">
        {workspaceMode === "calendar" ? (
          <MemoryCalendarView
            onSelectNode={selectNode}
            selectedNodeId={selectedNodeId}
            onCloseDetail={closeDetail}
          />
        ) : (
          <>
            <div className="memory-atlas-intro" aria-label="Memory overview">
              <span className="memory-atlas-eyebrow"><i /> YOUR KNOWLEDGE, CONNECTED</span>
              <h3>Everything you know.<br /><em>Connected.</em></h3>
              <p>Your files, memories and<br />their real connections.</p>
              <dl className="memory-atlas-stats">
                <div><dt>Memories</dt><dd>{summary?.recordCount.toLocaleString() ?? "—"}</dd></div>
                <div><dt>In this map</dt><dd>{atlasMetrics.memoryCount.toLocaleString()}</dd></div>
                <div><dt>Connections</dt><dd>{atlas.edges.length.toLocaleString()}</dd></div>
              </dl>
            </div>
            <div className="memory-graph-layout" data-detail-open={Boolean(selectedNodeId)} data-graph-mode="ATLAS" data-source-count={atlasMetrics.sourceCount} data-source-link-count={atlasMetrics.sourceLinkCount} data-root-visible={atlasMetrics.rootVisible} data-raw-node-count={graph?.data.nodes.length ?? 0} data-visible-node-count={atlas.nodes.length} data-visible-edge-count={atlas.edges.length}>
              <div className="memory-atlas-2d" hidden={view3D}><MemoryGraphErrorBoundary>
                <Suspense fallback={<div className="memory-graph-loading" role="status">Connecting your memories…</div>}>
                  <DesktopMemoryGraph nodes={graph2D.nodes} edges={graph2D.edges} displayMode="SEMANTIC" relationMode="RELATIONS" selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} error={error} totalNodes={graph?.data.totalMatchingNodes ?? 0} totalEdges={graph?.data.totalMatchingEdges ?? 0} truncated={(graph?.data.truncated ?? false) || graph2D.nodes.length < atlas.nodes.length} atlasPositions={atlasPositions} showTitles={showTitles} />
                </Suspense>
              </MemoryGraphErrorBoundary></div>
              {view3D ? <MemoryGraph3D nodes={atlas.nodes} edges={atlas.edges} positions={atlasPositions} coordinates={layout?.atlas === atlas ? layout.depth : EMPTY_COORDINATES} packedCoordinates={layout?.atlas === atlas ? layout.coords3d : null} showTitles={showTitles} selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} resetToken={reset3D} /> : null}
            </div>
            {!selectedNodeId && displayGroups.length > 0 ? <aside className="memory-atlas-topics" aria-label="Map topics">
              <span className="memory-atlas-eyebrow">COLOR GUIDE</span>
              <p>Tags, themes & archive months</p>
              <ul>{displayGroups.map(group => <li key={group.id}><i style={{ background: group.color }} /><span title={group.label}>{group.label}</span><small>{group.kind}</small><b>{group.count}</b></li>)}</ul>
            </aside> : null}
            {!selectedNodeId ? <aside className="memory-atlas-insight"><span className="memory-atlas-eyebrow">THE BIGGER PICTURE</span><strong>{atlas.semanticCount.toLocaleString()}</strong><p>semantic connections</p><small>Explore the links between your memories.</small><div className="memory-atlas-spectrum" /></aside> : null}
            {graph?.data.isStale ? <div className="memory-atlas-stale" role="status"><AlertTriangle aria-hidden="true" /> Snapshot awaiting refresh</div> : null}
            {query && !loading && !error ? <div className="memory-atlas-search-status" role="status">{atlas.nodes.length ? `${atlas.nodes.length.toLocaleString()} matching nodes` : "No memories found. Try another search."}</div> : null}
          </>
        )}
        {selectedNodeId ? <div className="memory-atlas-detail">
          {detailError ? <div className="memory-workspace-error" role="alert"><AlertTriangle /><span>{detailError}</span><button onClick={closeDetail}>Close</button></div> : <MemoryNodeDetail detail={detail} loading={detailLoading} onClose={closeDetail} onSelectNode={selectNode} backLabel={workspaceMode === "calendar" ? "Back to day memories" : undefined} />}
        </div> : null}
      </div>
    </section>
  );
}
