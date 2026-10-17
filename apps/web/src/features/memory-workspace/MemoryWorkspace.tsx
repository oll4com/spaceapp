import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Calendar as CalendarIcon, Network, Search, X } from "../ui-theme/app-icons.js";
import type { MemoryGraphNodeDetail } from "@space/contracts";
import { api, type MemoryGraphOverviewResponse } from "../../api.js";
import { MemoryGraphErrorBoundary } from "./MemoryGraphErrorBoundary.js";
import { MemoryNodeDetail } from "./MemoryNodeDetail.js";
import { createMemoryAtlas, type MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { MemoryGraph3D } from "./MemoryGraph3D.js";
import type { MemoryPoint3D } from "./memory-3d.js";
import { MemoryCalendarView } from "./MemoryCalendarView.js";
import "./memory-atlas.css";

const DesktopMemoryGraph = lazy(() => import("./DesktopMemoryGraph.js"));

function requested3DGraphLimit(): number {
  if (typeof window === "undefined") return 50_000;
  const requested = Number(new URLSearchParams(window.location.search).get("memoryGraphSize"));
  return Number.isInteger(requested) && requested > 0 ? Math.min(50_000, requested) : 50_000;
}

export function MemoryWorkspace({ shellMode, onClose, initialMode = "calendar" }: {
  shellMode: "desktop" | "tablet" | "mobile";
  activeRoomId: string | null;
  onClose: () => void;
  initialMode?: "atlas" | "calendar";
}) {
  const [workspaceMode, setWorkspaceMode] = useState<"atlas" | "calendar">(initialMode);
  const [view3D, setView3D] = useState(false);
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
    void api.memoryGraphOverview({ q: query || undefined, month: "all", relationMode: "RELATIONS", limit: view3D ? requested3DGraphLimit() : undefined })
      .then(payload => { if (active) setGraph(payload); })
      .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "Memory could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceMode, query, view3D, closeDetail]);

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

  const atlasComputation = useMemo(() => {
    const started = performance.now();
    const atlas = createMemoryAtlas(graph?.data.nodes ?? [], graph?.data.edges ?? [], false);
    const ended = performance.now();
    return { atlas, durationMs: ended - started, window: `${started.toFixed(0)}-${ended.toFixed(0)}` };
  }, [graph]);
  const atlas = atlasComputation.atlas;
  const layoutPreparationMs = useRef(0);
  const layoutPreparationWindow = useRef("0-0");
  const layoutWorkerRun = useRef(0);
  const [layoutWorkerStatus, setLayoutWorkerStatus] = useState("idle");
  const [layout, setLayout] = useState<{ atlas: typeof atlas; positions: Map<string, MemoryAtlasPosition>; depth: Map<string, MemoryPoint3D>; progress: number; mapDurationMs: number } | null>(null);
  useEffect(() => {
    if (workspaceMode !== "atlas" || !atlas.nodes.length || typeof Worker === "undefined") return;
    const workerRun = ++layoutWorkerRun.current;
    setLayoutWorkerStatus(`starting:${workerRun}`);
    const worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    let depthIds: string[] = [];
    worker.onmessage = (event: MessageEvent<
      | { kind: "positions"; positions: Array<[string, { x: number; y: number }]> }
      | { kind: "depth"; ids?: string[]; coordinates: Float32Array; progress: number; complete: boolean }
    >) => {
      setLayoutWorkerStatus(`received:${event.data.kind}:${workerRun}`);
      if (event.data.kind === "positions") {
        const coordinates = new Map(event.data.positions);
        setLayout(previous => ({
          atlas,
          depth: previous?.atlas === atlas ? previous.depth : new Map(),
          positions: new Map([...atlas.positions].map(([id, position]) => [id, { ...position, ...coordinates.get(id) }])),
          progress: previous?.atlas === atlas ? previous.progress : 0,
          mapDurationMs: previous?.atlas === atlas ? previous.mapDurationMs : 0
        }));
        return;
      }
      const depthMessage = event.data;
      if (depthMessage.ids) depthIds = depthMessage.ids;
      const mapStarted = performance.now();
      const depth = new Map<string, MemoryPoint3D>();
      for (let index = 0; index < depthIds.length; index++) {
        depth.set(depthIds[index]!, {
          x: depthMessage.coordinates[index * 3]!,
          y: depthMessage.coordinates[index * 3 + 1]!,
          z: depthMessage.coordinates[index * 3 + 2]!
        });
      }
      const mapDurationMs = performance.now() - mapStarted;
      setLayout(previous => ({
        atlas,
        depth,
        positions: previous?.atlas === atlas ? previous.positions : atlas.positions,
        progress: depthMessage.progress,
        mapDurationMs
      }));
      if (depthMessage.complete) worker.terminate();
    };
    worker.onerror = event => { setLayoutWorkerStatus(`error:${workerRun}`); setError(`Memory layout could not be calculated: ${event.message || "worker unavailable"}`); worker.terminate(); };
    worker.onmessageerror = () => { setLayoutWorkerStatus(`message-error:${workerRun}`); setError("Memory layout could not be decoded."); worker.terminate(); };
    const postLayout = () => {
      if (view3D && atlas.nodes.length > 5_000) {
        const started = performance.now();
        const ids = new Array<string>(atlas.nodes.length);
        const nodeTypes = new Uint8Array(atlas.nodes.length);
        const indexById = new Map<string, number>();
        let root = -1;
        atlas.nodes.forEach((node, index) => {
          ids[index] = node.id;
          indexById.set(node.id, index);
          nodeTypes[index] = node.type === "SOURCE" ? 1 : 0;
          if (root < 0 && node.type === "SOURCE" && isMemoryCoreLabel(node.label)) root = index;
        });
        const allEndpoints = new Uint32Array(atlas.edges.length * 2);
        const allKinds = new Uint8Array(atlas.edges.length);
        let edgeCount = 0;
        for (const edge of atlas.edges) {
          const source = indexById.get(edge.source);
          const target = indexById.get(edge.target);
          if (source === undefined || target === undefined || source === target) continue;
          allEndpoints[edgeCount * 2] = source;
          allEndpoints[edgeCount * 2 + 1] = target;
          allKinds[edgeCount] = edge.type === "CONTAINS" ? 1 : 0;
          edgeCount++;
        }
        const edgeEndpoints = edgeCount === atlas.edges.length ? allEndpoints : allEndpoints.slice(0, edgeCount * 2);
        const edgeKinds = edgeCount === atlas.edges.length ? allKinds : allKinds.slice(0, edgeCount);
        layoutPreparationMs.current = performance.now() - started;
        layoutPreparationWindow.current = `${started.toFixed(0)}-${performance.now().toFixed(0)}`;
        setLayoutWorkerStatus(`posted:compact:${workerRun}`);
        worker.postMessage({ kind: "compact", input: { ids, nodeTypes, root, edgeEndpoints, edgeKinds } }, [nodeTypes.buffer, edgeEndpoints.buffer, edgeKinds.buffer]);
      } else {
        layoutPreparationMs.current = 0;
        setLayoutWorkerStatus(`posted:full:${workerRun}`);
        worker.postMessage({ kind: "full", nodes: atlas.nodes, edges: atlas.edges, include2D: !view3D });
      }
    };
    const postTimer = window.setTimeout(postLayout, 0);
    return () => { window.clearTimeout(postTimer); worker.terminate(); };
  }, [workspaceMode, atlas, view3D]);
  const layoutPending = typeof Worker !== "undefined" && atlas.nodes.length > 0 && (layout?.atlas !== atlas || layout.depth.size === 0);
  const atlasPositions = layout?.atlas === atlas ? layout.positions : atlas.positions;
  const summary = graph?.data.summary;
  const memoryCount = atlas.nodes.filter(node => node.type === "MEMORY").length;
  const displayGroups = useMemo(() => atlas.groups.filter(group => group.kind !== "tag" || group.count >= 10), [atlas.groups]);
  return (
    <section id="memory-atlas" className="memory-workspace memory-atlas" aria-label="Memory workspace" data-shell-mode={shellMode} data-workspace-mode={workspaceMode} data-view-mode={view3D ? "3D" : "2D"} data-titles-visible={showTitles} data-atlas-layout="network" data-atlas-build-ms={atlasComputation.durationMs.toFixed(2)} data-atlas-build-window={atlasComputation.window} data-layout-worker-status={layoutWorkerStatus} data-layout-preparation-ms={layoutPreparationMs.current.toFixed(2)} data-layout-preparation-window={layoutPreparationWindow.current} data-layout-map-ms={layout?.atlas === atlas ? layout.mapDurationMs.toFixed(2) : "0.00"} data-layout-ready={layout?.atlas === atlas} data-layout-progress={layout?.atlas === atlas ? layout.progress.toFixed(3) : "0.000"} data-layout-root-x={atlasPositions.get(atlas.nodes.find(node => isMemoryCoreLabel(node.label))?.id ?? "")?.x} data-atlas-group-count={displayGroups.length} data-atlas-color-count={new Set(displayGroups.map(group => group.color)).size}>
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
              <button type="button" aria-label="Toggle 3D memory view" aria-pressed={view3D} onClick={() => { setLoading(true); setGraph(null); setView3D(value => !value); }}><span aria-hidden="true">◇</span> {view3D ? "2D" : "3D"}</button>
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
            <div className="memory-graph-layout" data-detail-open={Boolean(selectedNodeId)} data-graph-mode="ATLAS" data-source-count={atlas.nodes.filter(node => node.type === "SOURCE").length} data-source-link-count={atlas.edges.filter(edge => edge.type === "CONTAINS" || edge.type === "DERIVED_FROM").length} data-root-visible={atlas.nodes.some(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label))} data-raw-node-count={graph?.data.nodes.length ?? 0} data-visible-node-count={atlas.nodes.length} data-visible-edge-count={atlas.edges.length}>
              {!view3D ? <div className="memory-atlas-2d"><MemoryGraphErrorBoundary>
                <Suspense fallback={<div className="memory-graph-loading" role="status">Connecting your memories…</div>}>
                  <DesktopMemoryGraph nodes={atlas.nodes} edges={atlas.edges} displayMode="SEMANTIC" relationMode="RELATIONS" selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} error={error} totalNodes={graph?.data.totalMatchingNodes ?? 0} totalEdges={graph?.data.totalMatchingEdges ?? 0} truncated={graph?.data.truncated ?? false} atlasPositions={atlasPositions} showTitles={showTitles} />
                </Suspense>
              </MemoryGraphErrorBoundary></div> : null}
              {view3D ? <MemoryGraph3D nodes={atlas.nodes} edges={atlas.edges} positions={atlasPositions} coordinates={layout?.atlas === atlas ? layout.depth : new Map()} showTitles={showTitles} selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} resetToken={reset3D} layoutProgress={layout?.atlas === atlas ? layout.progress : 0} /> : null}
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
