import { useEffect, useMemo, useRef } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import { MemoryGraphWebGLRenderer, memoryGraphP95, selectMemoryGraphLabels } from "./memory-webgl-renderer.js";

type CurrentGraph = {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>;
  coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  layoutProgress: number;
};

type ProjectedPoint = { id: string; x: number; y: number; z: number; radius: number };

export function MemoryGraph3D({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken, layoutProgress = 1 }: {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number; layoutProgress?: number;
}) {
  const volumeRatio = useMemo(() => {
    if (coordinates.size <= 2_048) return memory3DVolumeRatio([...coordinates.values()]);
    const sample: MemoryPoint3D[] = [];
    const stride = Math.max(1, Math.floor(coordinates.size / 1_024));
    let index = 0;
    for (const point of coordinates.values()) {
      if (index % stride === 0) sample.push(point);
      if (sample.length >= 1_024) break;
      index++;
    }
    return memory3DVolumeRatio(sample);
  }, [coordinates]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const current = useRef<CurrentGraph>({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, layoutProgress });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, layoutProgress };

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const fallbackCanvas = fallbackRef.current;
    const labelsCanvas = labelsRef.current;
    if (!canvas || !fallbackCanvas || !labelsCanvas) return;
    const fallbackContext = fallbackCanvas.getContext("2d");
    const labelsContext = labelsCanvas.getContext("2d");
    if (!fallbackContext || !labelsContext) return;

    const queryParameters = new URLSearchParams(window.location.search);
    const forceCanvas = queryParameters.get("memoryGraphForceCanvas") === "1";
    let renderer: MemoryGraphWebGLRenderer | null = null;
    let contextLost = false;
    try { renderer = forceCanvas ? null : new MemoryGraphWebGLRenderer(canvas); } catch { renderer = null; }
    canvas.dataset.renderer = renderer ? "webgl2" : "canvas2d";
    let frame = 0;
    let pickFrame = 0;
    let benchmarkFrame = 0;
    let adjacencyTimer = 0;
    let warmupStage = 0;
    let width = 1;
    let height = 1;
    let dpr = 1;
    let hover: string | null = null;
    let fallbackPoints: ProjectedPoint[] = [];
    let graphNodes: MemoryGraphNode[] | null = null;
    let graphEdges: MemoryGraphEdge[] | null = null;
    let graphPositions: Map<string, MemoryAtlasPosition> | null = null;
    let graphCoordinates: Map<string, MemoryPoint3D> | null = null;
    let fallbackNodeSource: MemoryGraphNode[] | null = null;
    let fallbackEdgeSource: MemoryGraphEdge[] | null = null;
    let fallbackNodes: MemoryGraphNode[] = [];
    let fallbackEdges: MemoryGraphEdge[] = [];
    let fallbackAllowed = new Set<string>();
    let focused: string | null | undefined;
    let scale = 1;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false;
    let downX = 0;
    let downY = 0;
    let pendingPick: { x: number; y: number } | null = null;
    const benchmarkEnabled = queryParameters.get("memoryGraphBenchmark") === "1";
    const benchmarkDurations: number[] = [];
    const benchmarkPickDurations: number[] = [];
    const benchmarkPickCandidateCounts: number[] = [];
    let benchmarkWarmup = 30;
    let benchmarkNodeCount = 0;
    let benchmarkPhase: "frames" | "picks" = "frames";
    let longestLongTask = 0;
    let longTaskCount = 0;
    const longTaskTimeline: string[] = [];
    let synchronizeGpu = false;
    let longTaskObserver: PerformanceObserver | null = null;
    let longTaskObservationStarted = false;
    let longTaskObservationRequested = false;
    let longTaskObserverTimer = 0;
    const startLongTaskObservation = () => {
      if (longTaskObservationStarted || !benchmarkEnabled || typeof PerformanceObserver === "undefined") return;
      longTaskObservationStarted = true;
      try {
        longTaskObserver = new PerformanceObserver(entries => {
          for (const entry of entries.getEntries()) {
            longestLongTask = Math.max(longestLongTask, entry.duration);
            longTaskCount++;
            if (longTaskTimeline.length < 32) longTaskTimeline.push(`${entry.startTime.toFixed(0)}:${entry.duration.toFixed(0)}`);
          }
          canvas.dataset.longTaskMaxMs = longestLongTask.toFixed(2);
          canvas.dataset.longTaskCount = String(longTaskCount);
          canvas.dataset.longTaskTimeline = longTaskTimeline.join(",");
        });
        longTaskObserver.observe({ type: "longtask" });
        canvas.dataset.longTaskObservation = "incremental-layout-and-interaction";
      } catch { longTaskObserver = null; }
    };
    const requestLongTaskObservation = () => {
      if (longTaskObservationRequested) return;
      longTaskObservationRequested = true;
      longTaskObserverTimer = window.setTimeout(startLongTaskObservation, 0);
    };

    const extentOf = (values: Iterable<MemoryPoint3D>) => {
      let extent = 60;
      for (const point of values) extent = Math.max(extent, Math.hypot(point.x, point.y, point.z));
      return extent;
    };

    const drawLabels = (focus: string | null, renderScale: number, labelNodes: MemoryGraphNode[]) => {
      labelsContext.clearRect(0, 0, width, height);
      if (!current.current.showTitles) return;
      labelsContext.font = "11px system-ui, sans-serif";
      const labels = selectMemoryGraphLabels(
        labelNodes,
        current.current.coordinates,
        cameraRef.current,
        renderScale,
        width,
        height,
        focus,
        label => labelsContext.measureText(label).width
      );
      for (const label of labels) {
        labelsContext.fillStyle = "#09111bea";
        labelsContext.fillRect(label.x - 3, label.y - 11, label.width + 6, 16);
        labelsContext.fillStyle = label.core ? "#fff0b0" : "#c6dfed";
        labelsContext.fillText(label.label, label.x, label.y + 1);
      }
      canvas.dataset.labelCount = String(labels.length);
    };

    const drawFallback = (focus: string | null, renderScale: number) => {
      fallbackContext.clearRect(0, 0, width, height);
      if (fallbackNodeSource !== current.current.nodes || fallbackEdgeSource !== current.current.edges) {
        fallbackNodes = current.current.nodes.slice(0, 2_000);
        fallbackAllowed = new Set(fallbackNodes.map(node => node.id));
        fallbackEdges = current.current.edges
          .filter(edge => fallbackAllowed.has(edge.source) && fallbackAllowed.has(edge.target))
          .slice(0, 6_000);
        fallbackNodeSource = current.current.nodes;
        fallbackEdgeSource = current.current.edges;
        canvas.dataset.fallbackNodeCount = String(fallbackNodes.length);
        canvas.dataset.fallbackEdgeCount = String(fallbackEdges.length);
      }
      const projected = new Map(fallbackNodes.flatMap(node => {
        const point = current.current.coordinates.get(node.id);
        return point ? [[node.id, projectMemoryPoint(point, cameraRef.current, renderScale, width, height)] as const] : [];
      }));
      const focusNeighbors = new Set<string>();
      if (focus) for (const edge of fallbackEdges) {
        if (edge.source === focus) focusNeighbors.add(edge.target);
        if (edge.target === focus) focusNeighbors.add(edge.source);
      }
      fallbackContext.lineWidth = 0.55;
      for (const edge of fallbackEdges) {
        const source = projected.get(edge.source);
        const target = projected.get(edge.target);
        if (!source || !target) continue;
        const incident = edge.source === focus || edge.target === focus;
        fallbackContext.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
        fallbackContext.lineWidth = incident ? 1.15 : 0.55;
        fallbackContext.beginPath();
        fallbackContext.moveTo(source.x, source.y);
        fallbackContext.lineTo(target.x, target.y);
        fallbackContext.stroke();
      }
      fallbackPoints = [];
      const ordered = fallbackNodes.filter(node => projected.has(node.id)).sort((left, right) => projected.get(right.id)!.z - projected.get(left.id)!.z);
      for (const node of ordered) {
        const point = projected.get(node.id)!;
        const highlighted = node.id === focus;
        const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * point.perspective * Math.sqrt(cameraRef.current.zoom)) * (highlighted ? 1.5 : 1);
        fallbackPoints.push({ id: node.id, ...point, radius });
        fallbackContext.globalAlpha = focus && !highlighted && !focusNeighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, point.perspective));
        fallbackContext.fillStyle = highlighted ? "#ffffff" : current.current.positions.get(node.id)?.color ?? "#7395ad";
        if (root || highlighted) { fallbackContext.shadowColor = fallbackContext.fillStyle; fallbackContext.shadowBlur = 13; }
        fallbackContext.beginPath();
        fallbackContext.arc(point.x, point.y, radius, 0, Math.PI * 2);
        fallbackContext.fill();
        fallbackContext.shadowBlur = 0;
      }
      fallbackContext.globalAlpha = 1;
    };

    const render = (): boolean => {
      frame = 0;
      const graph = current.current;
      const focus = hover ?? graph.selectedNodeId;
      const useWebGL = Boolean(renderer && !contextLost);
      fallbackCanvas.hidden = useWebGL;
      if (renderer && useWebGL) {
        const rebuild = graphNodes !== graph.nodes || graphEdges !== graph.edges || graphPositions !== graph.positions || (graphCoordinates?.size === 0 && graph.coordinates.size > 0);
        if (rebuild) {
          const graphUploadStarted = performance.now();
          renderer.setGraph(graph.nodes, graph.edges, graph.positions, graph.coordinates);
          canvas.dataset.graphUploadWindow = `${graphUploadStarted.toFixed(0)}-${performance.now().toFixed(0)}`;
          canvas.dataset.graphUploadMs = renderer.lastGraphUploadDurationMs.toFixed(2);
          canvas.dataset.coordinateUploadMs = renderer.lastCoordinateUploadDurationMs.toFixed(2);
          canvas.dataset.pickIndexBuildMs = renderer.lastPickIndexBuildDurationMs.toFixed(2);
          if (adjacencyTimer) window.clearTimeout(adjacencyTimer);
          const adjacencyRenderer = renderer;
          const adjacencyNodes = graph.nodes;
          adjacencyTimer = window.setTimeout(() => {
            adjacencyTimer = 0;
            if (renderer !== adjacencyRenderer || current.current.nodes !== adjacencyNodes) return;
            adjacencyRenderer.buildAdjacency();
            canvas.dataset.adjacencyBuildMs = adjacencyRenderer.lastAdjacencyBuildDurationMs.toFixed(2);
            focused = undefined;
            schedule();
          }, 0);
          graphNodes = graph.nodes;
          graphEdges = graph.edges;
          graphPositions = graph.positions;
          focused = undefined;
          warmupStage = graph.nodes.length > 5_000 ? 1 : 0;
        } else if (graphCoordinates !== graph.coordinates) {
          renderer.updateCoordinates(graph.coordinates);
          canvas.dataset.coordinateUploadMs = renderer.lastCoordinateUploadDurationMs.toFixed(2);
          canvas.dataset.pickIndexBuildMs = renderer.lastPickIndexBuildDurationMs.toFixed(2);
        }
        graphCoordinates = graph.coordinates;
        scale = Math.min(width, height) * 0.4 / renderer.extent;
        if (focused !== focus) {
          renderer.setFocus(focus);
          focused = focus;
        }
        if (rebuild) {
          schedule();
          return false;
        }
        if (warmupStage === 1) {
          renderer.render(cameraRef.current, scale, false, "nodes");
          warmupStage = 2;
          schedule();
          return false;
        }
        if (warmupStage >= 2) {
          renderer.renderEdgeChunk(cameraRef.current, scale, warmupStage - 2, 4);
          warmupStage = warmupStage === 5 ? 0 : warmupStage + 1;
          schedule();
          return false;
        }
        renderer.render(cameraRef.current, scale, synchronizeGpu);
      } else {
        scale = Math.min(width, height) * 0.4 / extentOf(graph.coordinates.values());
        drawFallback(focus, scale);
      }
      drawLabels(focus, scale, useWebGL ? graph.nodes : fallbackNodes);
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
      return true;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    redrawRef.current = schedule;

    const benchmark = () => {
      benchmarkFrame = 0;
      const graph = current.current;
      if (graph.nodes.length !== benchmarkNodeCount) {
        longTaskObserver?.disconnect();
        longTaskObserver = null;
        if (longTaskObserverTimer) window.clearTimeout(longTaskObserverTimer);
        longTaskObserverTimer = 0;
        longTaskObservationRequested = false;
        longTaskObservationStarted = false;
        longestLongTask = 0;
        longTaskCount = 0;
        longTaskTimeline.length = 0;
        benchmarkNodeCount = graph.nodes.length;
        benchmarkDurations.length = 0;
        benchmarkPickDurations.length = 0;
        benchmarkPickCandidateCounts.length = 0;
        benchmarkWarmup = 30;
        benchmarkPhase = "frames";
        canvas.dataset.benchmarkState = "waiting";
        canvas.dataset.benchmarkNodes = String(benchmarkNodeCount);
      }
      if (graph.layoutProgress > 0) requestLongTaskObservation();
      if (!renderer || contextLost || graph.nodes.length === 0 || graph.coordinates.size === 0 || graph.layoutProgress < 1) {
        benchmarkFrame = requestAnimationFrame(benchmark);
        return;
      }
      canvas.dataset.benchmarkState = benchmarkPhase;
      if (benchmarkPhase === "picks") {
        const index = benchmarkPickDurations.length;
        const x = width * (0.2 + (index % 5) * 0.15);
        const y = height * (0.25 + (index % 4) * 0.16);
        cameraRef.current.yaw += 0.004;
        renderer.pick(x, y, cameraRef.current, scale);
        benchmarkPickDurations.push(renderer.lastPickDurationMs);
        benchmarkPickCandidateCounts.push(renderer.lastPickCandidateClusters);
        if (benchmarkPickDurations.length >= 20) {
          canvas.dataset.benchmarkState = "complete";
          canvas.dataset.frameP95Ms = memoryGraphP95(benchmarkDurations).toFixed(2);
          canvas.dataset.frameSamples = String(benchmarkDurations.length);
          canvas.dataset.pickP95Ms = memoryGraphP95(benchmarkPickDurations).toFixed(2);
          canvas.dataset.pickMaxMs = Math.max(...benchmarkPickDurations).toFixed(2);
          canvas.dataset.pickMetric = "clustered-cpu-projection";
          canvas.dataset.pickSamples = String(benchmarkPickDurations.length);
          canvas.dataset.pickCandidateClustersMax = String(Math.max(...benchmarkPickCandidateCounts));
          canvas.dataset.longTaskMaxMs = longestLongTask.toFixed(2);
          canvas.dataset.longTaskCount = String(longTaskCount);
          canvas.dispatchEvent(new CustomEvent("memorygraphbenchmarkcomplete", { bubbles: true }));
          return;
        }
        benchmarkFrame = requestAnimationFrame(benchmark);
        return;
      }
      const step = benchmarkDurations.length;
      cameraRef.current.yaw += 0.012;
      cameraRef.current.pitch = DEFAULT_MEMORY_CAMERA.pitch + Math.sin(step / 38) * 0.22;
      cameraRef.current.zoom = 1 + Math.sin(step / 29) * 0.28;
      const renderStarted = performance.now();
      synchronizeGpu = true;
      const rendered = render();
      synchronizeGpu = false;
      if (!rendered) {
        benchmarkFrame = requestAnimationFrame(benchmark);
        return;
      }
      const renderDuration = performance.now() - renderStarted;
      if (benchmarkWarmup > 0) benchmarkWarmup--;
      else benchmarkDurations.push(renderDuration);
      if (benchmarkDurations.length >= 240) {
        benchmarkPhase = "picks";
        canvas.dataset.benchmarkState = "picks";
        canvas.dataset.frameMetric = "gpu-synchronized-render-and-labels";
      }
      benchmarkFrame = requestAnimationFrame(benchmark);
    };

    const resizeCanvas2D = (target: HTMLCanvasElement, context: CanvasRenderingContext2D) => {
      target.width = Math.round(width * dpr);
      target.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      resizeCanvas2D(fallbackCanvas, fallbackContext);
      resizeCanvas2D(labelsCanvas, labelsContext);
      renderer?.resize(width, height, dpr);
      schedule();
    };

    const fallbackHit = (x: number, y: number) => [...fallbackPoints].reverse().find(point => Math.hypot(point.x - x, point.y - y) < Math.max(7, point.radius + 3))?.id ?? null;
    const hit = (x: number, y: number) => renderer && !contextLost ? renderer.pick(x, y, cameraRef.current, scale) : fallbackHit(x, y);
    const local = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const flushPick = () => {
      pickFrame = 0;
      if (!pendingPick || pointers.size) return;
      const next = hit(pendingPick.x, pendingPick.y);
      pendingPick = null;
      if (renderer) canvas.dataset.pickMs = renderer.lastPickDurationMs.toFixed(2);
      if (next !== hover) { hover = next; canvas.style.cursor = hover ? "pointer" : "grab"; schedule(); }
    };
    const queuePick = (point: { x: number; y: number }) => {
      pendingPick = point;
      if (!pickFrame) pickFrame = requestAnimationFrame(flushPick);
    };
    const down = (event: PointerEvent) => {
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
      const point = local(event);
      pointers.set(event.pointerId, point);
      downX = point.x;
      downY = point.y;
      dragged = false;
      hover = null;
    };
    const move = (event: PointerEvent) => {
      const point = local(event);
      const previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(point.x - downX, point.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y);
          const after = Math.hypot(point.x - other.x, point.y - other.y);
          if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
        } else {
          cameraRef.current.yaw += (point.x - previous.x) * 0.009;
          cameraRef.current.pitch += (point.y - previous.y) * 0.009;
        }
        pointers.set(event.pointerId, point);
        schedule();
      } else queuePick(point);
    };
    const up = (event: PointerEvent) => {
      const point = local(event);
      if (!dragged && pointers.size === 1) {
        const id = hit(point.x, point.y);
        if (id) current.current.onSelectNode(id);
      }
      pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001)));
      schedule();
    };
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0;
        schedule();
      } else if (event.key === "Enter") {
        const node = current.current.nodes.find(candidate => candidate.id === current.current.selectedNodeId) ?? current.current.nodes.find(candidate => isMemoryCoreLabel(candidate.label));
        if (node) current.current.onSelectNode(node.id);
      }
    };
    const lost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      canvas.dataset.renderer = "canvas2d";
      schedule();
    };
    const restored = () => {
      try {
        renderer?.destroy();
        renderer = new MemoryGraphWebGLRenderer(canvas);
        renderer.resize(width, height, dpr);
        graphNodes = null;
        contextLost = false;
        canvas.dataset.renderer = "webgl2";
      } catch {
        renderer = null;
        contextLost = true;
      }
      schedule();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    if (benchmarkEnabled) {
      canvas.dataset.benchmarkState = "waiting";
      benchmarkFrame = requestAnimationFrame(benchmark);
    }
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("keydown", key);
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(pickFrame);
      cancelAnimationFrame(benchmarkFrame);
      if (adjacencyTimer) window.clearTimeout(adjacencyTimer);
      if (longTaskObserverTimer) window.clearTimeout(longTaskObserverTimer);
      longTaskObserver?.disconnect();
      renderer?.destroy();
      redrawRef.current = () => {};
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", key);
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
    };
  }, []);

  useEffect(() => { redrawRef.current(); }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);
  return (
    <div className="memory-3d-surface">
      <canvas
        ref={canvasRef}
        className="memory-3d-interaction-canvas"
        tabIndex={0}
        role="application"
        aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open."
        aria-busy={loading}
        data-titles-visible={showTitles}
        data-layout-volume={volumeRatio.toFixed(4)}
      />
      <canvas ref={fallbackRef} className="memory-3d-fallback-canvas" aria-hidden="true" />
      <canvas ref={labelsRef} className="memory-3d-label-canvas" aria-hidden="true" />
      <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    </div>
  );
}
