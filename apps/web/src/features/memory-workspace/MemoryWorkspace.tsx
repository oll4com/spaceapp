import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AlertTriangle, Calendar as CalendarIcon, Network, Search, X } from "../ui-theme/app-icons.js";
import type { MemoryGraphNodeDetail } from "@space/contracts";
import { api, type MemoryGraphOverviewResponse } from "../../api.js";
import { MemoryGraphErrorBoundary } from "./MemoryGraphErrorBoundary.js";
import { MemoryNodeDetail } from "./MemoryNodeDetail.js";
import { createMemoryAtlas, type MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { MemoryGraph3D } from "./MemoryGraph3D.js";
import { MemorySceneStream, type GraphSource, type WorkerMessage, type WorkerRequest } from "./memory-layout-stream.js";
import { getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";
import { MemoryCalendarView } from "./MemoryCalendarView.js";
import "./memory-atlas.css";

const overviewUrl = (q: string, limit: number) => {
  const params = new URLSearchParams({ month: "all", relationMode: "RELATIONS", limit: String(limit) });
  if (q) params.set("q", q);
  return `/api/admin/memory/graph/overview?${params}`;
};
const GRAPH_SIZES_3D = [2000, 10_000, 50_000] as const;
const DesktopMemoryGraph = lazy(() => import("./DesktopMemoryGraph.js"));

export function MemoryWorkspace({ shellMode, onClose, initialMode = "calendar" }: {
  shellMode: "desktop" | "tablet" | "mobile";
  activeRoomId: string | null;
  onClose: () => void;
  initialMode?: "atlas" | "calendar";
}) {
  const [workspaceMode, setWorkspaceMode] = useState<"atlas" | "calendar">(initialMode);
  const [view3D, setView3D] = useState(false);
  // Explicit node limit chosen in the 3D view; null keeps the default overview. Reset when leaving 3D.
  const [size3D, setSize3D] = useState<number | null>(null);
  const limit = view3D && size3D ? size3D : undefined;
  const [showTitles, setShowTitles] = useState(true);
  const [reset3D, setReset3D] = useState(0);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState<{ response: MemoryGraphOverviewResponse; limit: number | undefined } | null>(null);
  // Only a graph fetched for the current limit is shown, so leaving 3D never hands a large graph to the 2D map.
  const graph = loaded && loaded.limit === limit ? loaded.response : null;
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

  useEffect(() => {
    // A chosen 3D size is fetched (or generated) inside the layout worker, so the main thread never parses it.
    if (workspaceMode !== "atlas" || limit) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    setError(null);
    closeDetail();
    // Search covers the entire archive; removing the month picker must not hide old memories.
    void api.memoryGraphOverview({ q: query || undefined, month: "all", relationMode: "RELATIONS", ...(limit ? { limit } : {}) })
      .then(payload => { if (active) setLoaded({ response: payload, limit }); })
      .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "Memory could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceMode, query, closeDetail, limit]);

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
  const [layout, setLayout] = useState<{ atlas: typeof atlas; positions: Map<string, MemoryAtlasPosition> } | null>(null);
  useEffect(() => {
    if (workspaceMode !== "atlas" || view3D || !atlas.nodes.length || typeof Worker === "undefined") return;
    const worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.type !== "layout2d") return;
      const coordinates = new Map(event.data.positions);
      setLayout({ atlas, positions: new Map([...atlas.positions].map(([id, position]) => [id, { ...position, ...coordinates.get(id) }])) });
      worker.terminate();
    };
    worker.onerror = event => { setError(`Memory layout could not be calculated: ${event.message || "worker unavailable"}`); worker.terminate(); };
    worker.postMessage({ type: "layout2d", id: 1, nodes: atlas.nodes, edges: atlas.edges } satisfies WorkerRequest);
    return () => worker.terminate();
  }, [workspaceMode, atlas, view3D]);

  // 3D: the worker builds the scene and streams positions while it converges.
  const runtimeKind = getSpaceRuntimeKind();
  const source3D = useMemo<GraphSource | null>(() => {
    if (workspaceMode !== "atlas" || !view3D) return null;
    if (limit) return runtimeKind === "demo" ? { kind: "synthetic", size: limit } : { kind: "url", url: overviewUrl(query, limit) };
    if (!graph) return null;
    const { data } = graph;
    return { kind: "inline", nodes: data.nodes, edges: data.edges, meta: { recordCount: data.summary.recordCount, totalMatchingNodes: data.totalMatchingNodes, totalMatchingEdges: data.totalMatchingEdges, truncated: data.truncated, isStale: data.isStale, rawNodeCount: data.nodes.length } };
  }, [workspaceMode, view3D, limit, graph, query, runtimeKind]);
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const [stream, setStream] = useState<MemorySceneStream | null>(null);
  useEffect(() => {
    if (!source3D) { setStream(null); return; }
    const next = new MemorySceneStream(source3D, typeof Worker === "undefined" ? null : () => new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" }));
    let sceneSeen = false, doneSeen = false;
    // Re-render for the scene, completion and errors only; position snapshots never re-render React.
    const off = next.subscribe(() => { if ((next.scene && !sceneSeen) || (next.done && !doneSeen) || next.error) { sceneSeen = Boolean(next.scene); doneSeen = next.done; bump(); } });
    setStream(next);
    next.start();
    return () => { off(); next.dispose(); };
  }, [source3D]);
  const scene = view3D ? stream?.scene ?? null : null;
  const streamDone = Boolean(stream?.done);
  const streamError = stream?.error ?? null;
  const shownError = error ?? streamError;
  const layoutPending = view3D
    ? Boolean(source3D) && !streamDone && !streamError
    : typeof Worker !== "undefined" && atlas.nodes.length > 0 && layout?.atlas !== atlas;
  const atlasPositions = layout?.atlas === atlas ? layout.positions : atlas.positions;
  const stats = scene ? scene.stats : { nodeCount: atlas.nodes.length, edgeCount: atlas.edges.length, memoryCount: atlas.nodes.filter(node => node.type === "MEMORY").length, sourceCount: atlas.nodes.filter(node => node.type === "SOURCE").length, sourceLinkCount: atlas.edges.filter(edge => edge.type === "CONTAINS" || edge.type === "DERIVED_FROM").length, rootVisible: atlas.nodes.some(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label)), semanticCount: atlas.semanticCount, groups: atlas.groups };
  const summary = scene ? { recordCount: stream?.meta?.recordCount ?? undefined } : graph?.data.summary;
  const memoryCount = stats.memoryCount;
  const displayGroups = useMemo(() => stats.groups.filter(group => group.kind !== "tag" || group.count >= 10), [stats.groups]);
  const rootX = scene ? (scene.root >= 0 && streamDone ? 0 : undefined) : atlasPositions.get(atlas.nodes.find(node => isMemoryCoreLabel(node.label))?.id ?? "")?.x;
  return (
    <section id="memory-atlas" className="memory-workspace memory-atlas" aria-label="Memory workspace" data-shell-mode={shellMode} data-workspace-mode={workspaceMode} data-view-mode={view3D ? "3D" : "2D"} data-titles-visible={showTitles} data-atlas-layout="network" data-layout-ready={scene ? streamDone : layout?.atlas === atlas} data-layout-root-x={rootX} data-atlas-group-count={displayGroups.length} data-atlas-color-count={new Set(displayGroups.map(group => group.color)).size}>
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
              <button type="button" aria-label="Toggle 3D memory view" aria-pressed={view3D} onClick={() => { setView3D(value => !value); setSize3D(null); }}><span aria-hidden="true">◇</span> {view3D ? "2D" : "3D"}</button>
              <button type="button" aria-label="Toggle memory titles" aria-pressed={showTitles} onClick={() => setShowTitles(value => !value)}>Aa <span>Titles</span></button>
              {view3D ? <button type="button" aria-label="Reset 3D memory view" onClick={() => setReset3D(value => value + 1)}>↺</button> : null}
              {view3D ? <div className="memory-3d-sizes" role="group" aria-label="3D graph size">
                {GRAPH_SIZES_3D.map(size => <button key={size} type="button" aria-label={`Load ${size.toLocaleString()} nodes`} aria-pressed={size3D === size} onClick={() => setSize3D(value => value === size ? null : size)}>{size / 1000}k</button>)}
              </div> : null}
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
                <div><dt>Memories</dt><dd>{summary?.recordCount?.toLocaleString() ?? "—"}</dd></div>
                <div><dt>In this map</dt><dd>{memoryCount.toLocaleString()}</dd></div>
                <div><dt>Connections</dt><dd>{stats.edgeCount.toLocaleString()}</dd></div>
              </dl>
            </div>
            <div className="memory-graph-layout" data-detail-open={Boolean(selectedNodeId)} data-graph-mode="ATLAS" data-source-count={stats.sourceCount} data-source-link-count={stats.sourceLinkCount} data-root-visible={stats.rootVisible} data-raw-node-count={scene ? stream?.meta?.rawNodeCount ?? 0 : graph?.data.nodes.length ?? 0} data-visible-node-count={stats.nodeCount} data-visible-edge-count={stats.edgeCount}>
              {!view3D ? <div className="memory-atlas-2d"><MemoryGraphErrorBoundary>
                <Suspense fallback={<div className="memory-graph-loading" role="status">Connecting your memories…</div>}>
                  <DesktopMemoryGraph nodes={atlas.nodes} edges={atlas.edges} displayMode="SEMANTIC" relationMode="RELATIONS" selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} error={shownError} totalNodes={graph?.data.totalMatchingNodes ?? 0} totalEdges={graph?.data.totalMatchingEdges ?? 0} truncated={graph?.data.truncated ?? false} atlasPositions={atlasPositions} showTitles={showTitles} />
                </Suspense>
              </MemoryGraphErrorBoundary></div> : null}
              {view3D ? <MemoryGraph3D stream={stream} scene={scene} error={shownError} showTitles={showTitles} selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} resetToken={reset3D} /> : null}
            </div>
            {!selectedNodeId && displayGroups.length > 0 ? <aside className="memory-atlas-topics" aria-label="Map topics">
              <span className="memory-atlas-eyebrow">COLOR GUIDE</span>
              <p>Tags, themes & archive months</p>
              <ul>{displayGroups.map(group => <li key={group.id}><i style={{ background: group.color }} /><span title={group.label}>{group.label}</span><small>{group.kind}</small><b>{group.count}</b></li>)}</ul>
            </aside> : null}
            {!selectedNodeId ? <aside className="memory-atlas-insight"><span className="memory-atlas-eyebrow">THE BIGGER PICTURE</span><strong>{stats.semanticCount.toLocaleString()}</strong><p>semantic connections</p><small>Explore the links between your memories.</small><div className="memory-atlas-spectrum" /></aside> : null}
            {graph?.data.isStale ? <div className="memory-atlas-stale" role="status"><AlertTriangle aria-hidden="true" /> Snapshot awaiting refresh</div> : null}
            {query && !loading && !shownError ? <div className="memory-atlas-search-status" role="status">{stats.nodeCount ? `${stats.nodeCount.toLocaleString()} matching nodes` : "No memories found. Try another search."}</div> : null}
          </>
        )}
        {selectedNodeId ? <div className="memory-atlas-detail">
          {detailError ? <div className="memory-workspace-error" role="alert"><AlertTriangle /><span>{detailError}</span><button onClick={closeDetail}>Close</button></div> : <MemoryNodeDetail detail={detail} loading={detailLoading} onClose={closeDetail} onSelectNode={selectNode} backLabel={workspaceMode === "calendar" ? "Back to day memories" : undefined} />}
        </div> : null}
      </div>
    </section>
  );
}
