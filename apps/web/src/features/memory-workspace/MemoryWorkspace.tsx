import { sendMemoryLayoutRequest } from "./memory-layout-request.js";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Calendar as CalendarIcon, Network, Search, X } from "../ui-theme/app-icons.js";
import type { MemoryGraphNodeDetail } from "@space/contracts";
import { api, type MemoryGraphOverviewResponse } from "../../api.js";
import { getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";
import { MemoryGraphErrorBoundary } from "./MemoryGraphErrorBoundary.js";
import { MemoryNodeDetail } from "./MemoryNodeDetail.js";
import { createMemoryAtlas } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { MemoryGraph3D } from "./MemoryGraph3D.js";
import type { MemoryPoint3D } from "./memory-3d.js";
import type { MemoryAtlas, MemoryLayoutMessage } from "./memory-layout-protocol.js";
import { hydrateMemoryMap, hydrateReferencedMemoryAtlas } from "./memory-layout-hydration.js";
import { MemoryCalendarView } from "./MemoryCalendarView.js";
import "./memory-atlas.css";

const DesktopMemoryGraph = lazy(() => import("./DesktopMemoryGraph.js"));
const emptyAtlas = createMemoryAtlas([], [], false);
const emptyDepth = new Map<string, MemoryPoint3D>();

function demoGraphSize(): number | null {
  if (getSpaceRuntimeKind() !== "demo" || !/^\/demo-workspace\/?$/.test(window.location.pathname)) return null;
  const value = new URLSearchParams(window.location.search).get("memoryGraphNodes");
  return value === "2000" ? 2000 : value === "10000" ? 10000 : value === "50000" ? 50000 : null;
}

type GraphLayout = {
  graph: MemoryGraphOverviewResponse;
  mode: "2d" | "3d";
  atlas: MemoryAtlas;
  depth: Map<string, MemoryPoint3D>;
  ready: boolean;
  complete: boolean;
  step: number;
};

export function MemoryWorkspace({ shellMode, onClose, initialMode = "calendar" }: {
  shellMode: "desktop" | "tablet" | "mobile";
  activeRoomId: string | null;
  onClose: () => void;
  initialMode?: "atlas" | "calendar";
}) {
  const [workspaceMode, setWorkspaceMode] = useState<"atlas" | "calendar">(initialMode);
  const [demoSize] = useState(demoGraphSize);
  const [view3D, setView3D] = useState(demoSize !== null);
  const [graphLimit, setGraphLimit] = useState(demoSize ?? 2000);
  const requestedLimit = view3D && typeof Worker !== "undefined" ? graphLimit : 2000;
  const [showTitles, setShowTitles] = useState(true);
  const [reset3D, setReset3D] = useState(0);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [graph, setGraph] = useState<MemoryGraphOverviewResponse | null>(null);
  const [loadedLimit, setLoadedLimit] = useState(2000);
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
    performance.mark?.("memory-graph-load-start");
    void api.memoryGraphOverview({ q: query || undefined, month: "all", relationMode: "RELATIONS", ...(requestedLimit !== 2000 ? { limit: requestedLimit } : {}) })
      .then(payload => { if (active) { setGraph(payload); setLoadedLimit(requestedLimit); } })
      .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "Memory could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceMode, query, closeDetail, requestedLimit]);

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

  const mode = view3D ? "3d" : "2d";
  // Browsers use the worker for atlas construction as well as force relaxation. The
  // no-worker path remains bounded for tests and older browsers.
  const synchronousAtlas = useMemo(() => {
    if (typeof Worker !== "undefined" || !graph) return emptyAtlas;
    const nodes = graph.data.nodes.slice(0, 2000);
    const ids = new Set(nodes.map(node => node.id));
    return createMemoryAtlas(nodes, graph.data.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).slice(0, 6000), false);
  }, [graph]);
  const [layout, setLayout] = useState<GraphLayout | null>(null);
  useEffect(() => {
    if (workspaceMode !== "atlas" || !graph || loadedLimit !== requestedLimit || typeof Worker === "undefined") return;
    let active = true;
    let ids: string[] = [];
    let pendingDepth: Extract<MemoryLayoutMessage, { kind: "depth" }> | null = null;
    let draining = false;
    let atlasReady: Promise<void> = Promise.resolve();
    const worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    const cancelled = () => !active;
    const drainDepth = async () => {
      if (draining) return;
      draining = true;
      try {
        await atlasReady;
        while (active && pendingDepth) {
          const message = pendingDepth;
          pendingDepth = null;
          const depth = await hydrateMemoryMap(ids.length, index => [ids[index]!, {
            x: message.coordinates[index * 3]!, y: message.coordinates[index * 3 + 1]!, z: message.coordinates[index * 3 + 2]!
          }], cancelled);
          if (!depth || !active) return;
          setLayout(previous => previous?.graph === graph && previous.mode === mode ? {
            ...previous, depth, ready: true, complete: message.complete, step: message.step
          } : previous);
          if (message.complete) worker.terminate();
        }
      } finally { draining = false; }
    };
    worker.onmessage = (event: MessageEvent<MemoryLayoutMessage>) => {
      if (!active) return;
      const message = event.data;
      if (message.kind === "atlas" || message.kind === "atlas-references") {
        atlasReady = (async () => {
          let atlas: MemoryAtlas | null;
          if (message.kind === "atlas-references") {
            atlas = await hydrateReferencedMemoryAtlas(message.atlas, graph.data, cancelled);
          } else {
            const positions = await hydrateMemoryMap(message.atlas.positions.length, index => message.atlas.positions[index]!, cancelled);
            atlas = positions ? { ...message.atlas, positions } : null;
          }
          if (!atlas || !active) return;
          setLayout({ graph, mode, atlas, depth: emptyDepth, ready: !atlas.nodes.length, complete: !atlas.nodes.length, step: 0 });
        })();
      } else if (message.kind === "depth") {
        if (message.ids) ids = message.ids;
        // Keep the newest snapshot while main-thread hydration yields to input.
        pendingDepth = message;
        void drainDepth();
      } else if (message.kind === "positions") {
        void atlasReady.then(() => {
          if (!active) return;
          setLayout(previous => {
            if (previous?.graph !== graph || previous.mode !== mode) return previous;
            const coordinates = new Map(message.positions);
            const positions = new Map([...previous.atlas.positions].map(([id, position]) => [id, { ...position, ...coordinates.get(id) }]));
            return { ...previous, atlas: { ...previous.atlas, positions }, ready: true, complete: true };
          });
          worker.terminate();
        });
      } else {
        setError(`Memory layout could not be calculated: ${message.message}`);
        worker.terminate();
      }
    };
    worker.onerror = event => { if (active) setError(`Memory layout could not be calculated: ${event.message || "worker unavailable"}`); worker.terminate(); };
    void sendMemoryLayoutRequest(worker, { kind: "layout", nodes: graph.data.nodes, edges: graph.data.edges, mode }, cancelled)
      .catch(caught => {
        if (active) setError(`Memory layout could not be calculated: ${caught instanceof Error ? caught.message : String(caught)}`);
        worker.terminate();
      });
    return () => { active = false; pendingDepth = null; worker.terminate(); };
  }, [workspaceMode, graph, mode, loadedLimit, requestedLimit]);
  const currentLayout = loadedLimit === requestedLimit && layout?.graph === graph && layout.mode === mode ? layout : null;
  const atlas = typeof Worker === "undefined" ? synchronousAtlas : currentLayout?.atlas ?? emptyAtlas;
  const layoutPending = typeof Worker !== "undefined" && Boolean(graph?.data.nodes.length) && !currentLayout?.ready;
  const layoutComplete = typeof Worker === "undefined" || Boolean(currentLayout?.complete);
  const atlasPositions = atlas.positions;
  const summary = graph?.data.summary;
  const atlasStats = useMemo(() => ({
    memories: atlas.nodes.filter(node => node.type === "MEMORY").length,
    sources: atlas.nodes.filter(node => node.type === "SOURCE").length,
    sourceLinks: atlas.edges.filter(edge => edge.type === "CONTAINS" || edge.type === "DERIVED_FROM").length,
    root: atlas.nodes.find(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label))?.id
  }), [atlas]);
  const displayGroups = useMemo(() => atlas.groups.filter(group => group.kind !== "tag" || group.count >= 10), [atlas.groups]);
  return (
    <section id="memory-atlas" className="memory-workspace memory-atlas" aria-label="Memory workspace" data-shell-mode={shellMode} data-workspace-mode={workspaceMode} data-view-mode={view3D ? "3D" : "2D"} data-titles-visible={showTitles} data-atlas-layout="network" data-layout-ready={!loading && !layoutPending} data-layout-complete={layoutComplete} data-layout-step={currentLayout?.step ?? 0} data-layout-root-x={view3D ? currentLayout?.depth.get(atlasStats.root ?? "")?.x : atlasPositions.get(atlasStats.root ?? "")?.x} data-atlas-group-count={displayGroups.length} data-atlas-color-count={new Set(displayGroups.map(group => group.color)).size}>
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
              <button type="button" aria-label="Toggle 3D memory view" aria-pressed={view3D} onClick={() => { setView3D(value => !value); if (view3D) setGraphLimit(2000); }}><span aria-hidden="true">◇</span> {view3D ? "2D" : "3D"}</button>
              <button type="button" aria-label="Toggle memory titles" aria-pressed={showTitles} onClick={() => setShowTitles(value => !value)}>Aa <span>Titles</span></button>
              {view3D && graphLimit < 50000 ? <button type="button" disabled={typeof Worker === "undefined"} onClick={() => setGraphLimit(50000)}>Load full graph (up to 50,000)</button> : null}
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
                <div><dt>In this map</dt><dd>{atlasStats.memories.toLocaleString()}</dd></div>
                <div><dt>Connections</dt><dd>{atlas.edges.length.toLocaleString()}</dd></div>
              </dl>
            </div>
            <div className="memory-graph-layout" data-detail-open={Boolean(selectedNodeId)} data-graph-mode="ATLAS" data-source-count={atlasStats.sources} data-source-link-count={atlasStats.sourceLinks} data-root-visible={Boolean(atlasStats.root)} data-raw-node-count={graph?.data.nodes.length ?? 0} data-visible-node-count={atlas.nodes.length} data-visible-edge-count={atlas.edges.length}>
              {!view3D ? <div className="memory-atlas-2d"><MemoryGraphErrorBoundary>
                <Suspense fallback={<div className="memory-graph-loading" role="status">Connecting your memories…</div>}>
                  <DesktopMemoryGraph nodes={atlas.nodes} edges={atlas.edges} displayMode="SEMANTIC" relationMode="RELATIONS" selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} error={error} totalNodes={graph?.data.totalMatchingNodes ?? 0} totalEdges={graph?.data.totalMatchingEdges ?? 0} truncated={graph?.data.truncated ?? false} atlasPositions={atlasPositions} showTitles={showTitles} />
                </Suspense>
              </MemoryGraphErrorBoundary></div> : null}
              {view3D ? <MemoryGraph3D nodes={atlas.nodes} edges={atlas.edges} positions={atlasPositions} coordinates={currentLayout?.depth ?? emptyDepth} showTitles={showTitles} selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} layoutComplete={layoutComplete} resetToken={reset3D} /> : null}
            </div>
            {!selectedNodeId && displayGroups.length > 0 ? <aside className="memory-atlas-topics" aria-label="Map topics">
              <span className="memory-atlas-eyebrow">COLOR GUIDE</span>
              <p>Tags, themes & archive months</p>
              <ul>{displayGroups.map(group => <li key={group.id}><i style={{ background: group.color }} /><span title={group.label}>{group.label}</span><small>{group.kind}</small><b>{group.count}</b></li>)}</ul>
            </aside> : null}
            {!selectedNodeId ? <aside className="memory-atlas-insight"><span className="memory-atlas-eyebrow">THE BIGGER PICTURE</span><strong>{atlas.semanticCount.toLocaleString()}</strong><p>semantic connections</p><small>Explore the links between your memories.</small><div className="memory-atlas-spectrum" /></aside> : null}
            {error ? <div className="memory-workspace-error" role="alert"><AlertTriangle /><span>{error}</span></div> : null}
            {graph?.data.truncated ? <div className="memory-atlas-search-status" role="status">Showing {atlas.nodes.length.toLocaleString()} of {graph.data.totalMatchingNodes.toLocaleString()} matching nodes{view3D ? "." : ". Switch to 3D to load up to 50,000."}</div> : null}
            {view3D && !layoutPending && !layoutComplete ? <div className="memory-atlas-search-status" role="status">Arranging connections… You can explore while the map settles.</div> : null}
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
