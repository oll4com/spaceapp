import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Calendar as CalendarIcon, ClipboardCheck, Network, Search, X } from "../ui-theme/app-icons.js";
import { MAX_MEMORY_GRAPH_OVERVIEW_NODES, type MemoryGraphNodeDetail } from "@space/contracts";
import { api, type MemoryGraphOverviewResponse } from "../../api.js";
import { getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";
import { MemoryGraphErrorBoundary } from "./MemoryGraphErrorBoundary.js";
import { MemoryNodeDetail } from "./MemoryNodeDetail.js";
import { createMemoryAtlas, type MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { MemoryGraph3D } from "./MemoryGraph3D.js";
import { unpackMemoryCoordinates3D, type MemoryCoordinateMap3D, type MemoryPoint3D } from "./memory-3d.js";
import type { MemoryLayoutWorkerMessage } from "./memory-network-layout.worker.js";
import { MemoryCalendarView } from "./MemoryCalendarView.js";
import { MemoryReviewView } from "./MemoryReviewView.js";
import "./memory-atlas.css";

const DesktopMemoryGraph = lazy(() => import("./DesktopMemoryGraph.js"));

export function MemoryWorkspace({ shellMode, onClose, initialMode = "calendar" }: {
  shellMode: "desktop" | "tablet" | "mobile";
  activeRoomId: string | null;
  onClose: () => void;
  initialMode?: "atlas" | "calendar" | "review";
}) {
  const [selectedMode, setWorkspaceMode] = useState<"atlas" | "calendar" | "review">(initialMode);
  // Mobile shows the Calendar list only: no graph canvas (ADR-006) and no review panels.
  const workspaceMode = shellMode === "mobile" ? "calendar" : selectedMode;
  const [view3D, setView3D] = useState(false);
  const [showTitles, setShowTitles] = useState(true);
  const [reset3D, setReset3D] = useState(0);
  const [requestedLimit, setRequestedLimit] = useState<number | null>(null);
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
  const isDemoRuntime = getSpaceRuntimeKind() === "demo";
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
    const overviewQuery: {
      q?: string;
      month: string;
      relationMode: "RELATIONS";
      limit?: number;
    } = { q: query || undefined, month: "all", relationMode: "RELATIONS" };
    if (requestedLimit !== null) {
      overviewQuery.limit = requestedLimit;
    }
    void api.memoryGraphOverview(overviewQuery)
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
    done: boolean;
  } | null>(null);
  useEffect(() => {
    if (workspaceMode !== "atlas" || !atlas.nodes.length || typeof Worker === "undefined") return;
    const worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    let currentDepth: MemoryCoordinateMap3D | undefined;
    worker.onmessage = (event: MessageEvent<MemoryLayoutWorkerMessage>) => {
      const data = event.data;
      if (data.packedDepth && Array.isArray(data.orderedIds)) {
        currentDepth = unpackMemoryCoordinates3D(
          data.orderedIds,
          data.packedDepth,
          data.step ?? 0,
          currentDepth
        );
      } else if (Array.isArray(data.depth)) {
        currentDepth = new Map(data.depth);
      }
      const nextDepth = currentDepth ?? new Map<string, MemoryPoint3D>();
      const done = data.done !== false;
      let nextPositions = atlas.positions;
      if (Array.isArray(data.positions)) {
        if (atlas.positions.size > 5_000) {
          for (let i = 0; i < data.positions.length; i++) {
            const [id, coord] = data.positions[i]!;
            const existing = atlas.positions.get(id);
            if (existing) {
              existing.x = coord.x;
              existing.y = coord.y;
            }
          }
          nextPositions = atlas.positions;
        } else {
          const coordinates = new Map(data.positions);
          nextPositions = new Map(
            [...atlas.positions].map(([id, position]) => [id, { ...position, ...coordinates.get(id) }])
          );
        }
      }
      setLayout(prev => ({
        atlas,
        depth: nextDepth,
        positions: Array.isArray(data.positions)
          ? nextPositions
          : prev?.atlas === atlas
            ? prev.positions
            : atlas.positions,
        done
      }));
      if (done) worker.terminate();
    };
    worker.onerror = event => { setError(`Memory layout could not be calculated: ${event.message || "worker unavailable"}`); worker.terminate(); };
    worker.postMessage({ nodes: atlas.nodes, edges: atlas.edges });
    return () => worker.terminate();
  }, [workspaceMode, atlas]);
  const layoutPending = typeof Worker !== "undefined" && atlas.nodes.length > 0 && (layout?.atlas !== atlas || !layout.done);
  const layoutPending3D = typeof Worker !== "undefined" && atlas.nodes.length > 0 && layout?.atlas !== atlas;
  const atlasPositions = layout?.atlas === atlas ? layout.positions : atlas.positions;
  const summary = graph?.data.summary;
  const memoryCount = atlas.nodes.filter(node => node.type === "MEMORY").length;
  const displayGroups = useMemo(() => atlas.groups.filter(group => group.kind !== "tag" || group.count >= 10), [atlas.groups]);
  return (
    <section id="memory-atlas" className="memory-workspace memory-atlas" aria-label="Memory workspace" data-shell-mode={shellMode} data-workspace-mode={workspaceMode} data-view-mode={view3D ? "3D" : "2D"} data-titles-visible={showTitles} data-atlas-layout="network" data-layout-ready={layout?.atlas === atlas && layout.done} data-layout-root-x={atlasPositions.get(atlas.nodes.find(node => isMemoryCoreLabel(node.label))?.id ?? "")?.x} data-atlas-group-count={displayGroups.length} data-atlas-color-count={new Set(displayGroups.map(group => group.color)).size}>
      <header className="memory-atlas-header memory-workspace-header">
        <div className="memory-atlas-brand">
          {workspaceMode === "calendar" ? <CalendarIcon aria-hidden="true" /> : workspaceMode === "review" ? <ClipboardCheck aria-hidden="true" /> : <Network aria-hidden="true" />}
          <h2>Memory</h2>
          <span>{workspaceMode.toUpperCase()}</span>
        </div>
        <form className="memory-workspace-controls memory-workspace-search" role="search" onSubmit={event => { event.preventDefault(); setQuery(queryDraft.trim()); }}>
          <label className="memory-search-input">
            <Search aria-hidden="true" />
            <input ref={searchRef} type="search" name="memoryQuery" aria-label="Search canonical memory" placeholder="Search your memory…" value={queryDraft} onChange={event => setQueryDraft(event.currentTarget.value)} />
            {queryDraft ? <button type="button" aria-label="Clear memory search" onClick={() => { setQueryDraft(""); setQuery(""); searchRef.current?.focus(); }}><X aria-hidden="true" /></button> : <kbd>/</kbd>}
          </label>
        </form>
        <div className="memory-atlas-actions">
          {shellMode === "mobile" ? null : <div className="memory-workspace-mode-selector" role="group" aria-label="Memory mode switcher">
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
            <button
              type="button"
              className={`memory-mode-pill ${workspaceMode === "review" ? "is-active" : ""}`}
              aria-pressed={workspaceMode === "review"}
              onClick={() => { setWorkspaceMode("review"); closeDetail(); }}
            >
              <ClipboardCheck aria-hidden="true" /> Review
            </button>
          </div>}
          {workspaceMode === "atlas" ? (
            <div className="memory-atlas-view-controls" aria-label="Memory view controls">
              <button type="button" aria-label="Toggle 3D memory view" aria-pressed={view3D} onClick={() => setView3D(value => !value)}><span aria-hidden="true">◇</span> {view3D ? "2D" : "3D"}</button>
              <button type="button" aria-label="Toggle memory titles" aria-pressed={showTitles} onClick={() => setShowTitles(value => !value)}>Aa <span>Titles</span></button>
              {view3D ? <button type="button" aria-label="Reset 3D memory view" onClick={() => setReset3D(value => value + 1)}>↺</button> : null}
              {view3D && isDemoRuntime ? (
                <>
                  {([
                    { label: "2k", size: 2_000 },
                    { label: "10k", size: 10_000 },
                    { label: "50k", size: 50_000 }
                  ] as const).map(preset => (
                    <button
                      key={preset.size}
                      type="button"
                      aria-label={`Load ${preset.label} synthetic memory graph`}
                      aria-pressed={requestedLimit === preset.size}
                      onClick={() => setRequestedLimit(current => (current === preset.size ? null : preset.size))}
                    >
                      {preset.label}
                    </button>
                  ))}
                </>
              ) : null}
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
        ) : workspaceMode === "review" ? (
          <MemoryReviewView onOpenRecord={selectNode} />
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
              <div className="memory-atlas-2d" hidden={view3D}><MemoryGraphErrorBoundary>
                <Suspense fallback={<div className="memory-graph-loading" role="status">Connecting your memories…</div>}>
                  <DesktopMemoryGraph nodes={view3D ? [] : atlas.nodes} edges={view3D ? [] : atlas.edges} displayMode="SEMANTIC" relationMode="RELATIONS" selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} error={error} totalNodes={graph?.data.totalMatchingNodes ?? 0} totalEdges={graph?.data.totalMatchingEdges ?? 0} truncated={graph?.data.truncated ?? false} atlasPositions={atlasPositions} showTitles={showTitles} />
                </Suspense>
              </MemoryGraphErrorBoundary></div>
              {view3D ? <MemoryGraph3D nodes={atlas.nodes} edges={atlas.edges} positions={atlasPositions} coordinates={layout?.atlas === atlas ? layout.depth : new Map()} showTitles={showTitles} selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending3D} resetToken={reset3D} /> : null}
            </div>
            {graph?.data.truncated ? (
              <div className="memory-atlas-truncated-banner" role="status">
                <span>
                  Showing {atlas.nodes.length.toLocaleString()} of {(graph.data.totalMatchingNodes ?? atlas.nodes.length).toLocaleString()} nodes
                </span>
                <button
                  type="button"
                  aria-label="Load full memory graph"
                  onClick={() => setRequestedLimit(MAX_MEMORY_GRAPH_OVERVIEW_NODES)}
                >
                  Load full graph
                </button>
              </div>
            ) : null}
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
