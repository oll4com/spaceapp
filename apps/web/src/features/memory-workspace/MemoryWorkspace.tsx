import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Calendar as CalendarIcon, Network, Search, X } from "../ui-theme/app-icons.js";
import type { MemoryGraphNodeDetail } from "@space/contracts";
import { api, type MemoryGraphOverviewResponse } from "../../api.js";
import { getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";
import { MemoryGraphErrorBoundary } from "./MemoryGraphErrorBoundary.js";
import { MemoryNodeDetail } from "./MemoryNodeDetail.js";
import { createMemoryAtlas, type MemoryAtlasGroup, type MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { MemoryGraph3D, type MemoryGraph3DHandle } from "./MemoryGraph3D.js";
import type { MemoryPoint3D } from "./memory-3d.js";
import type { PackedMemoryGraph } from "./memory-3d-buffers.js";
import { readMemoryGraphLaunch, type MemoryGraphLaunchSize } from "./memory-graph-launch.js";
import { MemoryCalendarView } from "./MemoryCalendarView.js";
import "./memory-atlas.css";

const DesktopMemoryGraph = lazy(() => import("./DesktopMemoryGraph.js"));
const emptyCoordinates = new Map<string, MemoryPoint3D>();

type GraphSize = "workspace" | MemoryGraphLaunchSize;

interface CompactGraph {
  memoryCount: number;
  sourceCount: number;
  semanticCount: number;
  edgeCount: number;
  nodeCount: number;
  groups: MemoryAtlasGroup[];
  truncated: boolean;
  totalMatchingNodes: number;
  totalMatchingEdges: number;
  isStale: boolean;
  recordCount: number;
}

type LayoutWorkerMessage =
  | { type: "packed"; packed: PackedMemoryGraph; loadMs?: number; prepareMs?: number }
  | { type: "positions"; step: number; done: boolean; xyz: ArrayBuffer }
  | { type: "plan"; positions: Array<[string, { x: number; y: number }]> }
  | { type: "error"; message: string };

function compactFrom(packed: PackedMemoryGraph): CompactGraph {
  return {
    memoryCount: packed.memoryCount,
    sourceCount: packed.sourceCount,
    semanticCount: packed.semanticCount,
    edgeCount: packed.edgeCount,
    nodeCount: packed.count,
    groups: packed.groups,
    truncated: packed.truncated,
    totalMatchingNodes: packed.totalMatchingNodes,
    totalMatchingEdges: packed.totalMatchingEdges,
    isStale: packed.isStale,
    recordCount: packed.recordCount
  };
}

export function MemoryWorkspace({ shellMode, onClose, initialMode = "calendar" }: {
  shellMode: "desktop" | "tablet" | "mobile";
  activeRoomId: string | null;
  onClose: () => void;
  initialMode?: "atlas" | "calendar";
}) {
  const launch = useMemo(() => readMemoryGraphLaunch(), []);
  const demo = getSpaceRuntimeKind() === "demo";
  const [workspaceMode, setWorkspaceMode] = useState<"atlas" | "calendar">(launch ? "atlas" : initialMode);
  const [view3D, setView3D] = useState(Boolean(launch));
  const [sizeChoice, setSizeChoice] = useState<GraphSize>(() => {
    if (!launch) return "workspace";
    if (getSpaceRuntimeKind() !== "demo" && launch.nodes === 2_000) return "workspace";
    return launch.nodes;
  });
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
  const graphRef = useRef<MemoryGraph3DHandle>(null);
  const streamRef = useRef<PackedMemoryGraph | null>(null);
  const pendingPositions = useRef<Float32Array | null>(null);
  const layoutDoneRef = useRef(false);
  const [stream, setStream] = useState<PackedMemoryGraph | null>(null);
  const [layoutDone, setLayoutDone] = useState(false);
  const [compact, setCompact] = useState<CompactGraph | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
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
    if (!launch?.benchmark || typeof window === "undefined") return;
    window.__spaceMemoryBenchmark = { status: "waiting" };
    window.__spaceMemoryLongTaskMs = 0;
    window.__spaceMemoryLongTasks = [];
    if (typeof PerformanceObserver === "undefined") return;
    const startedAt = performance.now();
    let max = 0;
    const observer = new PerformanceObserver(list => {
      if (window.__spaceMemorySampling) return;
      for (const entry of list.getEntries()) {
        if (entry.startTime < startedAt) continue;
        const attribution = "attribution" in entry && Array.isArray(entry.attribution)
          ? entry.attribution.slice(0, 4).map(item => ({
            name: String(item.name ?? ""),
            containerType: String(item.containerType ?? ""),
            containerName: String(item.containerName ?? ""),
            containerSrc: String(item.containerSrc ?? "")
          }))
          : [];
        const record = { duration: entry.duration, startTime: entry.startTime, name: entry.name, attribution };
        if (entry.duration >= 50) window.__spaceMemoryLongTasks?.push(record);
        if (entry.duration >= max) {
          max = entry.duration;
          window.__spaceMemoryLongTask = record;
        }
      }
      window.__spaceMemoryLongTaskMs = max;
    });
    try { observer.observe({ type: "longtask", buffered: true }); } catch { /* Long tasks are not exposed in every browser. */ }
    let frames: PerformanceObserver | null = null;
    try {
      frames = new PerformanceObserver(list => {
        if (window.__spaceMemorySampling) return;
        const records = window.__spaceMemoryLongFrames ?? [];
        for (const entry of list.getEntries()) {
          const timing = entry as PerformanceEntry & { scripts?: Array<{ sourceURL?: string; duration?: number; invoker?: string; name?: string }> };
          records.push({
            duration: entry.duration,
            startTime: entry.startTime,
            scripts: (timing.scripts ?? []).slice(0, 6).map(script => ({
              source: script.sourceURL ?? "",
              duration: script.duration ?? 0,
              invoker: script.invoker ?? "",
              name: script.name ?? ""
            }))
          });
        }
        window.__spaceMemoryLongFrames = records.slice(-8);
      });
      frames.observe({ type: "long-animation-frame", buffered: true });
    } catch { /* Long animation frames are not exposed in every browser. */ }
    return () => {
      observer.disconnect();
      frames?.disconnect();
    };
  }, [launch]);

  useEffect(() => {
    if (workspaceMode !== "atlas") return;
    let active = true;
    setLoading(true);
    setError(null);
    closeDetail();
    const synthetic = demo && typeof sizeChoice === "number";
    const remoteLimit = !demo && typeof sizeChoice === "number" && sizeChoice > 2_000;
    if (!synthetic && !remoteLimit) {
      // Search covers the entire archive; removing the month picker must not hide old memories.
      // The default request omits `limit`, which keeps the 2,000-node overview.
      setCompact(null);
      streamRef.current = null;
      setStream(null);
      pendingPositions.current = null;
      layoutDoneRef.current = false;
      setLayoutDone(false);
      void api.memoryGraphOverview({ q: query || undefined, month: "all", relationMode: "RELATIONS" })
        .then(payload => { if (active) setGraph(payload); })
        .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "Memory could not be loaded."); })
        .finally(() => { if (active) setLoading(false); });
      return () => { active = false; };
    }
    setGraph(null);
    setCompact(null);
    streamRef.current = null;
    setStream(null);
    pendingPositions.current = null;
    layoutDoneRef.current = false;
    setLayoutDone(false);
    if (typeof Worker === "undefined") {
      setError("Memory layout could not be calculated: worker unavailable");
      setLoading(false);
      return () => { active = false; };
    }
    const worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<LayoutWorkerMessage>) => {
      if (!active) return;
      const data = event.data;
      if (data.type === "packed") {
        const started = performance.now();
        window.__spaceMemoryMarks = [...(window.__spaceMemoryMarks ?? []), ["packed", Math.round(started)], ["workerLoadMs", Math.round(data.loadMs ?? 0)], ["workerPrepareMs", Math.round(data.prepareMs ?? 0)]];
        streamRef.current = data.packed;
        setStream(data.packed);
        setCompact(compactFrom(data.packed));
        graphRef.current?.applyPacked(data.packed);
        setLoading(false);
        window.__spaceMemoryHandlerMs = performance.now() - started;
        window.__spaceMemoryMarks?.push(["packed-done", Math.round(performance.now())]);
      } else if (data.type === "positions") {
        const xyz = new Float32Array(data.xyz);
        pendingPositions.current = xyz;
        if (streamRef.current) streamRef.current.xyz = xyz;
        graphRef.current?.applyPositions(xyz, data.done);
        if (data.done) {
          layoutDoneRef.current = true;
          setLayoutDone(true);
        }
      } else if (data.type === "error") {
        setError(data.message);
        setLoading(false);
        if (launch?.benchmark) window.__spaceMemoryBenchmark = { status: "error", message: data.message };
      }
    };
    worker.onerror = event => {
      if (!active) return;
      const message = `Memory layout could not be calculated: ${event.message || "worker unavailable"}`;
      setError(message);
      setLoading(false);
      if (launch?.benchmark) window.__spaceMemoryBenchmark = { status: "error", message };
      worker.terminate();
    };
    if (synthetic) {
      const edges = launch && launch.nodes === sizeChoice ? launch.edges : Math.min(150_000, sizeChoice * 3);
      worker.postMessage({ mode: "generate", nodeCount: sizeChoice, edgeCount: edges });
    } else {
      const params = new URLSearchParams({ month: "all", relationMode: "RELATIONS", limit: String(sizeChoice) });
      if (query) params.set("q", query);
      worker.postMessage({ mode: "fetch", url: `/api/admin/memory/graph/overview?${params.toString()}` });
    }
    return () => { active = false; worker.terminate(); };
  }, [workspaceMode, query, closeDetail, sizeChoice, demo, launch, reloadToken]);

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
    if (!view3D || !streamRef.current) return;
    graphRef.current?.applyPacked(streamRef.current);
    if (pendingPositions.current) graphRef.current?.applyPositions(pendingPositions.current, layoutDoneRef.current);
  }, [view3D, stream]);
  useEffect(() => {
    if (workspaceMode !== "atlas" || compact || !atlas.nodes.length || typeof Worker === "undefined") return;
    const worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    layoutDoneRef.current = false;
    setLayoutDone(false);
    pendingPositions.current = null;
    worker.onmessage = (event: MessageEvent<LayoutWorkerMessage>) => {
      const data = event.data;
      if (data.type === "packed") {
        streamRef.current = data.packed;
        setStream(data.packed);
        graphRef.current?.applyPacked(data.packed);
      } else if (data.type === "positions") {
        const xyz = new Float32Array(data.xyz);
        pendingPositions.current = xyz;
        if (streamRef.current) streamRef.current.xyz = xyz;
        graphRef.current?.applyPositions(xyz, data.done);
        if (data.done) {
          layoutDoneRef.current = true;
          setLayoutDone(true);
        }
      } else if (data.type === "plan") {
        const coordinates = new Map(data.positions);
        setLayout({
          atlas,
          positions: new Map([...atlas.positions].map(([id, position]) => [id, { ...position, ...coordinates.get(id) }]))
        });
        worker.terminate();
      } else if (data.type === "error") {
        setError(data.message);
      }
    };
    worker.onerror = event => { setError(`Memory layout could not be calculated: ${event.message || "worker unavailable"}`); worker.terminate(); };
    worker.postMessage({ mode: "layout", nodes: atlas.nodes, edges: atlas.edges });
    return () => worker.terminate();
  }, [workspaceMode, atlas, compact, reloadToken]);
  const twoDReady = Boolean(atlas.nodes.length) && layout?.atlas === atlas;
  const layoutReady = compact ? layoutDone : twoDReady;
  const layoutPending = !compact && typeof Worker !== "undefined" && atlas.nodes.length > 0 && !twoDReady;
  const atlasPositions = layout?.atlas === atlas ? layout.positions : atlas.positions;
  const summary = graph?.data.summary;
  const memoryCount = compact?.memoryCount ?? atlas.nodes.filter(node => node.type === "MEMORY").length;
  const connectionCount = compact?.edgeCount ?? atlas.edges.length;
  const visibleNodeCount = compact?.nodeCount ?? atlas.nodes.length;
  const sourceCount = compact?.sourceCount ?? atlas.nodes.filter(node => node.type === "SOURCE").length;
  const semanticCount = compact?.semanticCount ?? atlas.semanticCount;
  const recordCount = compact?.recordCount ?? summary?.recordCount;
  const truncated = compact?.truncated ?? graph?.data.truncated ?? false;
  const totalMatchingNodes = compact?.totalMatchingNodes ?? graph?.data.totalMatchingNodes ?? 0;
  const totalMatchingEdges = compact?.totalMatchingEdges ?? graph?.data.totalMatchingEdges ?? 0;
  const stale = compact?.isStale ?? graph?.data.isStale ?? false;
  const displayGroups = useMemo(
    () => (compact?.groups ?? atlas.groups).filter(group => group.kind !== "tag" || group.count >= 10),
    [atlas.groups, compact]
  );
  const sizeValue = !demo && sizeChoice === "workspace" ? "2000" : String(sizeChoice);
  const benchmarkActive = Boolean(launch?.benchmark) && view3D && (sizeChoice === launch?.nodes || (sizeChoice === "workspace" && launch?.nodes === 2_000));
  return (
    <section id="memory-atlas" className="memory-workspace memory-atlas" aria-label="Memory workspace" data-shell-mode={shellMode} data-workspace-mode={workspaceMode} data-view-mode={view3D ? "3D" : "2D"} data-titles-visible={showTitles} data-atlas-layout="network" data-layout-ready={layoutReady} data-layout-root-x={atlasPositions.get(atlas.nodes.find(node => isMemoryCoreLabel(node.label))?.id ?? "")?.x} data-atlas-group-count={displayGroups.length} data-atlas-color-count={new Set(displayGroups.map(group => group.color)).size}>
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
              <button type="button" aria-label="Toggle 3D memory view" aria-pressed={view3D} onClick={() => { setView3D(current => !current); if (view3D) setSizeChoice("workspace"); }}><span aria-hidden="true">◇</span> {view3D ? "2D" : "3D"}</button>
              <button type="button" aria-label="Toggle memory titles" aria-pressed={showTitles} onClick={() => setShowTitles(value => !value)}>Aa <span>Titles</span></button>
              {view3D ? <select className="memory-3d-size" aria-label="3D graph size" value={sizeValue} onChange={event => {
                const raw = event.currentTarget.value;
                if (raw === "workspace") setSizeChoice("workspace");
                else {
                  const numeric = Number(raw) as MemoryGraphLaunchSize;
                  setSizeChoice(!demo && numeric === 2_000 ? "workspace" : numeric);
                }
              }}>
                {demo ? <option value="workspace">Workspace</option> : null}
                <option value="2000">2,000</option>
                <option value="10000">10,000</option>
                <option value="50000">50,000</option>
              </select> : null}
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
                <div><dt>Memories</dt><dd>{recordCount?.toLocaleString() ?? "—"}</dd></div>
                <div><dt>In this map</dt><dd>{memoryCount.toLocaleString()}</dd></div>
                <div><dt>Connections</dt><dd>{connectionCount.toLocaleString()}</dd></div>
              </dl>
            </div>
            <div className="memory-graph-layout" data-detail-open={Boolean(selectedNodeId)} data-graph-mode="ATLAS" data-source-count={sourceCount} data-source-link-count={atlas.edges.filter(edge => edge.type === "CONTAINS" || edge.type === "DERIVED_FROM").length} data-root-visible={compact ? sourceCount > 0 : atlas.nodes.some(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label))} data-raw-node-count={compact?.nodeCount ?? graph?.data.nodes.length ?? 0} data-visible-node-count={visibleNodeCount} data-visible-edge-count={connectionCount}>
              {view3D ? null : <div className="memory-atlas-2d"><MemoryGraphErrorBoundary>
                <Suspense fallback={<div className="memory-graph-loading" role="status">Connecting your memories…</div>}>
                  <DesktopMemoryGraph nodes={atlas.nodes} edges={atlas.edges} displayMode="SEMANTIC" relationMode="RELATIONS" selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || layoutPending} error={error} totalNodes={totalMatchingNodes} totalEdges={totalMatchingEdges} truncated={truncated} atlasPositions={atlasPositions} showTitles={showTitles} />
                </Suspense>
              </MemoryGraphErrorBoundary></div>}
              {view3D ? <MemoryGraph3D ref={graphRef} nodes={compact ? [] : atlas.nodes} edges={compact ? [] : atlas.edges} positions={atlasPositions} coordinates={emptyCoordinates} showTitles={showTitles} selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || (compact ? !layoutDone : layoutPending)} resetToken={reset3D} layoutDone={layoutDone} benchmark={benchmarkActive} stream={stream} /> : null}
              {view3D && error ? <div className="memory-workspace-error memory-atlas-load-error" role="alert"><AlertTriangle aria-hidden="true" /><span>{error}</span><button type="button" onClick={() => setReloadToken(token => token + 1)}>Retry</button></div> : null}
            </div>
            {!selectedNodeId && displayGroups.length > 0 ? <aside className="memory-atlas-topics" aria-label="Map topics">
              <span className="memory-atlas-eyebrow">COLOR GUIDE</span>
              <p>Tags, themes & archive months</p>
              <ul>{displayGroups.map(group => <li key={group.id}><i style={{ background: group.color }} /><span title={group.label}>{group.label}</span><small>{group.kind}</small><b>{group.count}</b></li>)}</ul>
            </aside> : null}
            {!selectedNodeId ? <aside className="memory-atlas-insight"><span className="memory-atlas-eyebrow">THE BIGGER PICTURE</span><strong>{semanticCount.toLocaleString()}</strong><p>semantic connections</p><small>Explore the links between your memories.</small><div className="memory-atlas-spectrum" /></aside> : null}
            {stale ? <div className="memory-atlas-stale" role="status"><AlertTriangle aria-hidden="true" /> Snapshot awaiting refresh</div> : null}
            {query && !loading && !error ? <div className="memory-atlas-search-status" role="status">{visibleNodeCount ? `${visibleNodeCount.toLocaleString()} matching nodes` : "No memories found. Try another search."}</div> : null}
          </>
        )}
        {selectedNodeId ? <div className="memory-atlas-detail">
          {detailError ? <div className="memory-workspace-error" role="alert"><AlertTriangle /><span>{detailError}</span><button onClick={closeDetail}>Close</button></div> : <MemoryNodeDetail detail={detail} loading={detailLoading} onClose={closeDetail} onSelectNode={selectNode} backLabel={workspaceMode === "calendar" ? "Back to day memories" : undefined} />}
        </div> : null}
      </div>
    </section>
  );
}
