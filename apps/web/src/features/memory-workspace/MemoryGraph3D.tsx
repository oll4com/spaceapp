import { useEffect, useMemo, useRef } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import { createProjectionBuffers, pickProjectedNode, projectMemoryPoints, projectionScale, selectFallbackSubgraph, selectGraphLabels, ProjectedPointIndex, type ProjectionBuffers } from "./memory-graph-3d-core.js";
import { buildGraphGeometry, MemoryGraphGlRenderer, writeFocusAttributes, type GraphGeometry } from "./memory-graph-gl.js";
import { parseBenchParams, publishBenchResult, runFrameBench } from "./memory-graph-bench.js";

/** The Canvas 2D fallback keeps the current sample cap; WebGL2 renders the full graph. */
const FALLBACK_NODE_CAP = 2000;

export function MemoryGraph3D({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken }: {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
}) {
  const volumeRatio = useMemo(() => memory3DVolumeRatio([...coordinates.values()]), [coordinates]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const dataVersion = useRef(0);
  const focusVersion = useRef(0);
  const current = useRef({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode };
  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0, width = 1, height = 1, dpr = 1;
    let hover: string | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;
    let glRenderer: MemoryGraphGlRenderer | null = null;
    let fallbackContext: CanvasRenderingContext2D | null = null;
    let contextLost = false;
    let projection = createProjectionBuffers(0);
    let projectedCount = 0;
    let geometryVersion = -1;
    let geometry: GraphGeometry | null = null;
    let focusDirty = false;
    let focusApplied = 0;
    let indexById = new Map<string, number>();
    let projectionDirty = true;
    let lastRebuildAt = 0;
    let renderNodes: MemoryGraphNode[] = [];
    let renderEdges: MemoryGraphEdge[] = [];
    const packed = { positions: new Float32Array(0) };
    const index = new ProjectedPointIndex(28);
    const labelCanvas = labelCanvasRef.current;
    const labelContext = labelCanvas?.getContext("2d") ?? null;
    const startWebGl = () => {
      glRenderer?.dispose();
      glRenderer = MemoryGraphGlRenderer.create(canvas);
      fallbackContext = glRenderer ? null : canvas.getContext("2d");
      geometryVersion = -1;
      projectionDirty = true;
      schedule();
    };
    startWebGl();
    // A canvas that already holds a WebGL context cannot return a 2D context (getContext
    // returns null for a different context type), so after a context loss the fallback
    // draws on the label canvas, which already has a 2D context, the dpr transform and
    // the same size.
    const onContextLost = (event: Event) => { event.preventDefault(); contextLost = true; glRenderer?.dispose(); glRenderer = null; fallbackContext = labelContext; geometryVersion = -1; projectionDirty = true; schedule(); };
    const onContextRestored = () => { contextLost = false; startWebGl(); };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    const radiusOf = (i: number) => {
      const node = renderNodes[i]!;
      const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
      const highlighted = node.id === (hover ?? current.current.selectedNodeId);
      return Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * projection.perspective[i]! * Math.sqrt(cameraRef.current.zoom)) * (highlighted ? 1.5 : 1);
    };
    /** Repacks geometry when the graph, streamed coordinates or focus changed. */
    const rebuild = () => {
      lastRebuildAt = performance.now();
      const data = current.current;
      const focus = hover ?? data.selectedNodeId;
      const gl = glRenderer !== null && !contextLost;
      renderNodes = data.nodes.filter(node => data.coordinates.has(node.id));
      renderEdges = data.edges;
      if (!gl) {
        const capped = selectFallbackSubgraph(renderNodes, renderEdges, FALLBACK_NODE_CAP);
        renderNodes = capped.nodes;
        renderEdges = capped.edges;
      }
      // The fallback edge pass looks both endpoints up per edge per frame; a map keeps that O(1) instead of O(N).
      indexById = new Map(renderNodes.map((node, index) => [node.id, index]));
      if (packed.positions.length < renderNodes.length * 3) packed.positions = new Float32Array(renderNodes.length * 3);
      packed.positions.fill(0);
      for (let i = 0; i < renderNodes.length; i++) {
        const point = data.coordinates.get(renderNodes[i]!.id)!;
        packed.positions[i * 3] = point.x; packed.positions[i * 3 + 1] = point.y; packed.positions[i * 3 + 2] = point.z;
      }
      if (projection.x.length < renderNodes.length) projection = createProjectionBuffers(Math.max(64, renderNodes.length));
      if (glRenderer) { geometry = buildGraphGeometry(renderNodes, renderEdges, data.positions, data.coordinates, focus); glRenderer.setGeometry(geometry); }
      focusDirty = false;
      focusApplied = focusVersion.current;
      projectionDirty = true;
    };
    const render = () => {
      frame = 0;
      const data = current.current;
      if (geometryVersion !== dataVersion.current) { geometryVersion = dataVersion.current; rebuild(); }
      else if (glRenderer && !contextLost && geometry && (focusDirty || focusApplied !== focusVersion.current)) {
        // A hover or selection change only rewrites the focus attribute slices in the
        // existing geometry and re-uploads them; no repack, no GPU reallocation.
        focusDirty = false;
        focusApplied = focusVersion.current;
        writeFocusAttributes(geometry, renderNodes, renderEdges, data.positions, data.coordinates, hover ?? data.selectedNodeId);
        glRenderer.updateFocusAttributes(geometry);
      } else if (!glRenderer || contextLost) {
        focusDirty = false;
      }
      projectedCount = renderNodes.length;
      if (projectionDirty && projectedCount > 0) {
        projectMemoryPoints(packed.positions, projectedCount, cameraRef.current, projectionScale(packed.positions, projectedCount, width, height), width, height, projection);
        index.build(projection.x, projection.y, projectedCount);
        projectionDirty = false;
      }
      const scale = projectionScale(packed.positions, projectedCount, width, height);
      const focus = hover ?? data.selectedNodeId;
      const neighbors = new Set<string>();
      if (focus) for (const edge of renderEdges) { if (edge.source === focus) neighbors.add(edge.target); if (edge.target === focus) neighbors.add(edge.source); }
      const drawLabels = (context: CanvasRenderingContext2D) => {
        const labels = selectGraphLabels({
          xs: projection.x, ys: projection.y, depth: projection.depth, nodes: renderNodes,
          focusIndex: focus ? renderNodes.findIndex(node => node.id === focus) : -1,
          showTitles: data.showTitles, zoom: cameraRef.current.zoom, width, height,
          measure: text => context.measureText(text).width
        });
        context.font = "11px system-ui, sans-serif";
        for (const label of labels) {
          context.fillStyle = "#09111bea"; context.fillRect(label.x - 3, label.y - 11, label.w + 6, 16);
          context.fillStyle = isMemoryCoreLabel(renderNodes[label.index]!.label) ? "#fff0b0" : "#c6dfed";
          context.fillText(label.text, label.x, label.y + 1);
        }
      };
      if (glRenderer && !contextLost) {
        glRenderer.render(cameraRef.current, scale, width, height, dpr, [0, 0, 0, 0]);
        if (labelContext) { labelContext.clearRect(0, 0, width, height); drawLabels(labelContext); }
      } else if (fallbackContext) {
        const context = fallbackContext;
        context.clearRect(0, 0, width, height);
        context.lineWidth = 0.55;
        for (const edge of renderEdges) {
          const a = indexById.get(edge.source), b = indexById.get(edge.target);
          if (a === undefined || b === undefined) continue;
          const incident = edge.source === focus || edge.target === focus;
          context.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
          context.lineWidth = incident ? 1.15 : 0.55;
          context.beginPath(); context.moveTo(projection.x[a]!, projection.y[a]!); context.lineTo(projection.x[b]!, projection.y[b]!); context.stroke();
        }
        context.globalAlpha = 1;
        const order = renderNodes.map((_, i) => i).sort((a, b) => projection.depth[b]! - projection.depth[a]!);
        for (const i of order) {
          const node = renderNodes[i]!;
          const highlighted = node.id === focus;
          context.globalAlpha = focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, projection.perspective[i]!));
          context.fillStyle = highlighted ? "#ffffff" : data.positions.get(node.id)?.color ?? "#7395ad";
          const radius = radiusOf(i);
          if ((node.type === "SOURCE" && isMemoryCoreLabel(node.label)) || highlighted) { context.shadowColor = context.fillStyle; context.shadowBlur = 13; }
          context.beginPath(); context.arc(projection.x[i]!, projection.y[i]!, radius, 0, Math.PI * 2); context.fill(); context.shadowBlur = 0;
        }
        context.globalAlpha = 1;
        drawLabels(context);
      }
      canvas.dataset.rotation = cameraRef.current.yaw.toFixed(3) + "," + cameraRef.current.pitch.toFixed(3);
    };
    function schedule() { if (!frame) frame = requestAnimationFrame(() => render()); }

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width; height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      if (fallbackContext) fallbackContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (labelContext && labelCanvas) { labelCanvas.width = Math.round(width * dpr); labelCanvas.height = Math.round(height * dpr); labelContext.setTransform(dpr, 0, 0, dpr, 0, 0); }
      projectionDirty = true;
      schedule();
    };
    const hit = (x: number, y: number): string | null => {
      if (projectedCount === 0) return null;
      const candidate = pickProjectedNode(index, projection.x, projection.y, projection.depth, x, y, i => Math.max(7, radiusOf(i) + 3));
      return candidate >= 0 ? renderNodes[candidate]?.id ?? null : null;
    };
    const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const down = (event: PointerEvent) => {
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const p = local(event); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false; hover = null;
    };
    const move = (event: PointerEvent) => {
      const p = local(event), previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
        } else { cameraRef.current.yaw += (p.x - previous.x) * 0.009; cameraRef.current.pitch += (p.y - previous.y) * 0.009; }
        pointers.set(event.pointerId, p);
        projectionDirty = true;
      } else {
        const next = hit(p.x, p.y);
        if (next !== hover) { hover = next; focusDirty = true; }
        canvas.style.cursor = hover ? "pointer" : "grab";
      }
      schedule();
    };
    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1) { const id = hit(p.x, p.y); if (id) current.current.onSelectNode(id); }
      pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const wheel = (event: WheelEvent) => { event.preventDefault(); cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))); projectionDirty = true; schedule(); };
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0;
        projectionDirty = true; schedule();
      } else if (event.key === "Enter") { const node = current.current.nodes.find(node => node.id === current.current.selectedNodeId) ?? current.current.nodes.find(node => isMemoryCoreLabel(node.label)); if (node) current.current.onSelectNode(node.id); }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    // Frame-time benchmark (issue #62): ?bench=1&benchFrames=N drives the camera itself
    // and measures the wall-clock frame interval until the result is published.
    let benchCancelled = false;
    const bench = parseBenchParams(window.location.search);
    const startBench = () => {
      if (benchCancelled) return;
      // Wait until the graph has data and the streamed layout has settled.
      if (projectedCount === 0 || performance.now() - lastRebuildAt < 1500) { window.setTimeout(startBench, 100); return; }
      let benchStep = 0;
      runFrameBench(bench.frames, () => {
        benchStep += 1;
        cameraRef.current.yaw += 0.012;
        cameraRef.current.pitch = -0.15 + 0.25 * Math.sin(benchStep * 0.017);
        cameraRef.current.zoom = 1.15 + 0.3 * Math.sin(benchStep * 0.031);
        projectionDirty = true;
        render();
      }, () => benchCancelled).then(result => { if (result) publishBenchResult(result); });
    };
    if (bench.enabled) startBench();
    redrawRef.current = () => schedule();
    return () => {
      benchCancelled = true;
      observer.disconnect(); cancelAnimationFrame(frame);
      redrawRef.current = () => {};
      glRenderer?.dispose(); glRenderer = null;
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key);
      canvas.removeEventListener("webglcontextlost", onContextLost); canvas.removeEventListener("webglcontextrestored", onContextRestored);
    };
  }, []);
  useEffect(() => { dataVersion.current++; redrawRef.current(); }, [nodes, edges, positions, coordinates]);
  // Selection changes only affect focus attributes, and titles only affect labels;
  // neither triggers a geometry repack.
  useEffect(() => { focusVersion.current++; redrawRef.current(); }, [selectedNodeId]);
  useEffect(() => { redrawRef.current(); }, [showTitles]);
  return <div className="memory-3d-surface">
    <canvas ref={canvasRef} tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open." aria-busy={loading} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} />
    <canvas ref={labelCanvasRef} className="memory-3d-labels" aria-hidden="true" />
    <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
  </div>;
}
