import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Calendar as CalendarIcon, Network, Search, X } from "../ui-theme/app-icons.js";
import type { MemoryGraphNodeDetail } from "@space/contracts";
import { api, type MemoryGraphOverviewResponse } from "../../api.js";
import { MemoryGraphErrorBoundary } from "./MemoryGraphErrorBoundary.js";
import { MemoryNodeDetail } from "./MemoryNodeDetail.js";
import { createMemoryAtlas } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { MemoryGraph3D } from "./MemoryGraph3D.js";
import { IndexedMemoryCoordinates, type MemoryCoordinates } from "./memory-coordinates.js";
import type { MemoryPoint3D } from "./memory-3d.js";
import type { MemoryLayoutMessage, MemoryLayoutRequest } from "./memory-network-layout.worker.js";
import { memoryBenchmarkEnabled, measureMemoryWork } from "./memory-benchmark.js";
import { yieldMemoryWork } from "./memory-yield.js";
import type { prepareMemoryGpuData } from "./memory-webgl-data.js";
import { MemoryCalendarView } from "./MemoryCalendarView.js";
import "./memory-atlas.css";

const DesktopMemoryGraph = lazy(() => import("./DesktopMemoryGraph.js"));

export function MemoryWorkspace({ shellMode, onClose, initialMode = "calendar" }: {
  shellMode: "desktop" | "tablet" | "mobile";
  activeRoomId: string | null;
  onClose: () => void;
  initialMode?: "atlas" | "calendar";
}) {
  const [workspaceMode, setWorkspaceMode] = useState<"atlas" | "calendar">(() => memoryBenchmarkEnabled() ? "atlas" : initialMode);
  const [view3D, setView3D] = useState(memoryBenchmarkEnabled);
  const loadStarted = useRef(performance.now());
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

  useEffect(() => {
    if (workspaceMode !== "atlas") return;
    let active = true;
    setLoading(true);
    setError(null);
    closeDetail();
    // Search covers the entire archive; removing the month picker must not hide old memories.
    void api.memoryGraphOverview({ q: query || undefined, month: "all", relationMode: "RELATIONS", ...(view3D ? { limit: 50000 } : {}) })
      .then(payload => { if (active) setGraph(payload); })
      .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "Memory could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceMode, query, closeDetail, view3D]);

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

  const emptyAtlas = useMemo(() => createMemoryAtlas([], [], false), []);
  const localAtlas = useMemo(() => typeof Worker === "undefined" ? createMemoryAtlas(graph?.data.nodes.slice(0, 2000) ?? [], graph?.data.edges ?? [], false) : emptyAtlas, [graph, emptyAtlas]);
  const [layout, setLayout] = useState<{ graph: typeof graph; view3D: boolean; atlas: typeof emptyAtlas; depth: MemoryCoordinates; gpuPositions?: Float32Array; extent?: number; volume?: number; ids: string[]; picking: MemoryLayoutMessage["picking"]; gpu: ReturnType<typeof prepareMemoryGpuData> | undefined; iteration: number; done: boolean } | null>(null);
  useEffect(() => {
    if (workspaceMode !== "atlas" || !graph?.data.nodes.length || typeof Worker === "undefined") return;
    const worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    let activeAtlas = { ...emptyAtlas, nodes: [] as typeof emptyAtlas.nodes, edges: [] as typeof emptyAtlas.edges, positions: new Map(emptyAtlas.positions) };
    let cancelled = false;
    const ids: string[] = [], index = new Map<string, number>();
    let gpu: ReturnType<typeof prepareMemoryGpuData> | undefined;
    worker.onmessage = (event: MessageEvent<MemoryLayoutMessage>) => measureMemoryWork("receive layout", () => {
      if (cancelled) return;
      if (event.data.positions) {
        for (const [id, position] of event.data.positions) activeAtlas.positions.set(id, position);
        return;
      }
      if (event.data.nodeIndices) {
        for (const i of event.data.nodeIndices) {
          const node = nodes[i]!;
          index.set(node.id, ids.length); ids.push(node.id); activeAtlas.nodes.push(node);
        }
        return;
      }
      if (event.data.edgeIndices) {
        for (const i of event.data.edgeIndices) activeAtlas.edges.push(edges[i]!);
        return;
      }
      if (event.data.atlas) {
        activeAtlas = { ...activeAtlas, ...event.data.atlas };
        return;
      }
      if (event.data.gpu) gpu = { ...event.data.gpu, index };
      const values = event.data.depth;
      const depth = values && gpu ? new IndexedMemoryCoordinates(gpu.index, values) : new Map<string, MemoryPoint3D>();
      setLayout({ graph, view3D, atlas: activeAtlas, depth, gpuPositions: event.data.gpuPositions, extent: event.data.extent, volume: event.data.volume, ids, picking: event.data.picking, gpu, iteration: event.data.iteration ?? 0, done: event.data.done ?? false });
      if (event.data.done) worker.terminate();
    });
    worker.onerror = event => { setError(`Memory layout could not be calculated: ${event.message || "worker unavailable"}`); worker.terminate(); };
    const nodes = view3D ? graph.data.nodes : graph.data.nodes.slice(0, 2000);
    const idsFor2D = view3D ? null : new Set(nodes.map(node => node.id));
    const edges = idsFor2D ? graph.data.edges.filter(edge => idsFor2D.has(edge.source) && idsFor2D.has(edge.target)) : graph.data.edges;
    const send = (message: MemoryLayoutRequest) => measureMemoryWork(`send ${message.kind}`, () => worker.postMessage(message));
    void (async () => {
      for (let i = 0; i < nodes.length && !cancelled; i += 1000) {
        send({ kind: "nodes", nodes: nodes.slice(i, i + 1000) });
        await yieldMemoryWork();
      }
      for (let i = 0; i < edges.length && !cancelled; i += 2000) {
        send({ kind: "edges", edges: edges.slice(i, i + 2000) });
        await yieldMemoryWork();
      }
      if (!cancelled) send({ kind: "run", view3D });
    })();
    return () => { cancelled = true; worker.terminate(); };
  }, [workspaceMode, graph, view3D, emptyAtlas]);
  const currentLayout = layout?.graph === graph && layout.view3D === view3D ? layout : null;
  const atlas = currentLayout?.atlas ?? localAtlas;
  const layoutPending = typeof Worker !== "undefined" && Boolean(graph?.data.nodes.length) && !currentLayout?.done;
  const atlasPositions = atlas.positions;
  const emptyDepth = useMemo(() => new Map<string, MemoryPoint3D>(), []);
  const summary = graph?.data.summary;
  const atlasStats = useMemo(() => ({
    memoryCount: atlas.nodes.reduce((sum, node) => sum + Number(node.type === "MEMORY"), 0),
    sourceCount: atlas.nodes.reduce((sum, node) => sum + Number(node.type === "SOURCE"), 0),
    sourceLinkCount: atlas.edges.reduce((sum, edge) => sum + Number(edge.type === "CONTAINS" || edge.type === "DERIVED_FROM"), 0),
    root: atlas.nodes.find(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label))
  }), [atlas]);
  const memoryCount = atlasStats.memoryCount;
  const displayGroups = useMemo(() => atlas.groups.filter(group => group.kind !== "tag" || group.count >= 10), [atlas.groups]);
  return (
    <section id="memory-atlas" className="memory-workspace memory-atlas" aria-label="Memory workspace" data-shell-mode={shellMode} data-workspace-mode={workspaceMode} data-view-mode={view3D ? "3D" : "2D"} data-titles-visible={showTitles} data-atlas-layout="network" data-layout-ready={Boolean(currentLayout)} data-layout-iteration={currentLayout?.iteration ?? 0} data-layout-root-x={atlasPositions.get(atlasStats.root?.id ?? "")?.x} data-atlas-group-count={displayGroups.length} data-atlas-color-count={new Set(displayGroups.map(group => group.color)).size}>
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
                <div><dt>In this map</dt><dd>{memoryCount.toLocaleString()}</dd></div>
                <div><dt>Connections</dt><dd>{atlas.edges.length.toLocaleString()}</dd></div>
              </dl>
            </div>
            <div className="memory-graph-layout" data-detail-open={Boolean(selectedNodeId)} data-graph-mode="ATLAS" data-source-count={atlasStats.sourceCount} data-source-link-count={atlasStats.sourceLinkCount} data-root-visible={Boolean(atlasStats.root)} data-raw-node-count={graph?.data.nodes.length ?? 0} data-visible-node-count={atlas.nodes.length} data-visible-edge-count={atlas.edges.length}>
              {!view3D ? <div className="memory-atlas-2d"><MemoryGraphErrorBoundary>
                <Suspense fallback={<div className="memory-graph-loading" role="status">Connecting your memories…</div>}>
                  <DesktopMemoryGraph nodes={atlas.nodes} edges={atlas.edges} displayMode="SEMANTIC" relationMode="RELATIONS" selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} error={error} totalNodes={graph?.data.totalMatchingNodes ?? 0} totalEdges={graph?.data.totalMatchingEdges ?? 0} truncated={graph?.data.truncated ?? false} atlasPositions={atlasPositions} showTitles={showTitles} />
                </Suspense>
              </MemoryGraphErrorBoundary></div> : null}
              {view3D ? <MemoryGraph3D loadStartedAt={loadStarted.current} nodes={atlas.nodes} edges={atlas.edges} positions={atlasPositions} coordinates={currentLayout?.depth ?? emptyDepth} picking={currentLayout?.picking} pickIds={currentLayout?.ids} gpuData={currentLayout?.gpu} gpuPositions={currentLayout?.gpuPositions} extent={currentLayout?.extent} volume={currentLayout?.volume} showTitles={showTitles} selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} resetToken={reset3D} /> : null}
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
