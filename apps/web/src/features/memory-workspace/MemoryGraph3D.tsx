import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import {
  DEFAULT_MEMORY_CAMERA,
  MemorySpatialPicker3D,
  memory3DVolumeRatio,
  projectMemoryPointsBulk,
  selectMemory3DLabels,
  type MemoryCamera3D,
  type MemoryPoint3D
} from "./memory-3d.js";
import {
  buildMemoryGraphFocusEdges,
  buildMemoryGraphGLScene,
  buildMemoryGraphNodeStates,
  MEMORY_GRAPH_GL_FOCUSED_EDGE_BRIGHTNESS,
  MemoryGraphWebGLRenderer
} from "./memory-graph-webgl.js";

/**
 * The Canvas 2D fallback keeps the historical 2,000-node budget — it strokes
 * every edge and arcs every node individually, so larger graphs belong to
 * the WebGL renderer. The WebGL path itself has no node cap: the data layer
 * can serve up to 50,000 nodes.
 */
export const MEMORY_GRAPH_3D_FALLBACK_NODE_LIMIT = 2000;

type RendererMode = "webgl" | "canvas";

/**
 * True 3D memory graph. Rendering prefers WebGL2 — instanced nodes, one
 * batched edge draw, GPU depth — and falls back to the original Canvas 2D
 * renderer when WebGL2 is unavailable or its context is lost; a restored
 * context returns the view to WebGL automatically. Both paths share the
 * camera, the bulk projection, the spatial-index picker, the bounded
 * level-of-detail labels and the same accessibility surface (focusable
 * canvas, aria-label, aria-busy, data-* attributes).
 */
export function MemoryGraph3D({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken }: {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
}) {
  const volumeRatio = useMemo(() => memory3DVolumeRatio([...coordinates.values()]), [coordinates]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const labelCanvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<RendererMode>("webgl");
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const current = useRef({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode };
  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);
  useEffect(() => {
    const canvas = (mode === "webgl" ? glCanvasRef.current : canvasRef.current) ?? canvasRef.current;
    if (!canvas) return;
    let renderer: MemoryGraphWebGLRenderer | null = null;
    let context: CanvasRenderingContext2D | null = null;
    let sceneInputs: { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D> } | null = null;
    let sceneIndex = new Map<string, number>();
    let appliedFocus: string | null | undefined;
    if (mode === "webgl") {
      renderer = MemoryGraphWebGLRenderer.create(canvas, () => setMode("canvas"), () => {
        sceneInputs = null;
        appliedFocus = undefined;
        redrawRef.current();
      });
      if (!renderer) { setMode("canvas"); return; }
    } else {
      context = canvas.getContext("2d");
      if (!context) return;
    }
    const labelCanvas = mode === "webgl" ? labelCanvasRef.current : null;
    const labelContext = labelCanvas?.getContext("2d") ?? null;
    let frame = 0, width = 1, height = 1, dpr = 1;
    let hover: string | null = null;
    let picker: MemorySpatialPicker3D | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;
    const render = () => {
      frame = 0;
      const { nodes: allNodes, edges: allEdges, positions, coordinates, showTitles, selectedNodeId } = current.current;
      const camera = cameraRef.current;
      // The Canvas fallback keeps the historical node budget; WebGL takes all.
      const nodes = mode === "canvas" ? allNodes.slice(0, MEMORY_GRAPH_3D_FALLBACK_NODE_LIMIT) : allNodes;
      const visibleIds = mode === "canvas" ? new Set(nodes.map(node => node.id)) : null;
      const edges = visibleIds ? allEdges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)) : allEdges;
      let extent = 60;
      for (const point of coordinates.values()) extent = Math.max(extent, Math.hypot(point.x, point.y, point.z));
      const scale = Math.min(width, height) * 0.4 / extent;
      // Visible nodes (those with 3D coordinates), projected in bulk into
      // typed arrays — no per-node objects on the per-frame path.
      const visNodes: MemoryGraphNode[] = [];
      const visPoints: MemoryPoint3D[] = [];
      for (const node of nodes) {
        const point = coordinates.get(node.id);
        if (point) { visNodes.push(node); visPoints.push(point); }
      }
      const projected = projectMemoryPointsBulk(visPoints, camera, scale, width, height);
      const focus = hover ?? selectedNodeId;
      const focusId = focus && visNodes.some(node => node.id === focus) ? focus : null;
      const neighbors = new Set<string>();
      if (focusId) for (const edge of edges) { if (edge.source === focusId) neighbors.add(edge.target); if (edge.target === focusId) neighbors.add(edge.source); }
      const baseRadius = (node: MemoryGraphNode) => node.type === "SOURCE" && isMemoryCoreLabel(node.label) ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
      const radii = new Float64Array(visNodes.length);
      const visIds: string[] = new Array(visNodes.length);
      for (let i = 0; i < visNodes.length; i++) {
        const node = visNodes[i]!;
        visIds[i] = node.id;
        radii[i] = Math.max(1, baseRadius(node) * projected.perspectives[i]! * Math.sqrt(camera.zoom)) * (node.id === focusId ? 1.5 : 1);
      }
      picker = MemorySpatialPicker3D.fromArrays(visIds, projected.xs, projected.ys, projected.zs, radii, width, height);
      const paintLabels = (target: CanvasRenderingContext2D, sequence: number[] | null) => {
        if (!showTitles) return;
        target.font = "11px system-ui, sans-serif";
        // Below the label zoom gate only sources, core labels and the focus
        // can ever be placed, so the candidate list stays tiny at any graph
        // size; at gate zoom every node is a candidate and the selector's
        // own budgets bound the work. `sequence` is the order candidates
        // are considered in: draw order for Canvas, node order for WebGL.
        const zoomedIn = camera.zoom >= 1.6;
        const candidates: Array<{ id: string; label: string; type: MemoryGraphNode["type"]; x: number; y: number; isFocus: boolean }> = [];
        for (let k = 0; k < visNodes.length; k++) {
          const i = sequence ? sequence[k]! : k;
          const node = visNodes[i]!;
          const isFocus = node.id === focusId;
          if (!zoomedIn && !isFocus && node.type !== "SOURCE" && !isMemoryCoreLabel(node.label)) continue;
          candidates.push({ id: node.id, label: node.label, type: node.type, x: projected.xs[i]!, y: projected.ys[i]!, isFocus });
        }
        const placements = selectMemory3DLabels(candidates, { width, height, zoom: camera.zoom, measure: text => target.measureText(text).width });
        for (const placement of placements) {
          target.fillStyle = "#09111bea"; target.fillRect(placement.x - 3, placement.y - 11, placement.width + 6, 16);
          target.fillStyle = placement.isCore ? "#fff0b0" : "#c6dfed"; target.fillText(placement.text, placement.x, placement.y + 1);
        }
      };
      if (renderer) {
        if (sceneInputs?.nodes !== allNodes || sceneInputs?.edges !== allEdges || sceneInputs?.positions !== positions || sceneInputs?.coordinates !== coordinates) {
          sceneInputs = { nodes: allNodes, edges: allEdges, positions, coordinates };
          sceneIndex = new Map(allNodes.map((node, i) => [node.id, i]));
          renderer.setScene(buildMemoryGraphGLScene({ nodes: allNodes, edges: allEdges, coordinates, atlasPositions: positions }));
          appliedFocus = undefined;
        }
        if (appliedFocus !== focusId) {
          appliedFocus = focusId;
          const focusEdges = buildMemoryGraphFocusEdges({ edges: allEdges, coordinates, focusId });
          const neighborIndices = new Set([...focusEdges.neighborIds].map(id => sceneIndex.get(id)).filter((i): i is number => i !== undefined));
          renderer.updateNodeStates(buildMemoryGraphNodeStates(allNodes.length, focusId ? sceneIndex.get(focusId) ?? -1 : -1, neighborIndices));
          renderer.setFocusEdges(focusEdges.positions, focusEdges.colors, focusEdges.count);
        }
        renderer.draw(camera, scale, width, height, focusId ? MEMORY_GRAPH_GL_FOCUSED_EDGE_BRIGHTNESS : 1);
        if (labelContext) {
          labelContext.setTransform(dpr, 0, 0, dpr, 0, 0);
          labelContext.clearRect(0, 0, width, height);
          paintLabels(labelContext, null);
        }
      } else if (context) {
        context.clearRect(0, 0, width, height);
        const slotById = new Map(visNodes.map((node, i) => [node.id, i]));
        context.lineWidth = 0.55;
        for (const edge of edges) {
          const a = slotById.get(edge.source), b = slotById.get(edge.target);
          if (a === undefined || b === undefined) continue;
          const incident = edge.source === focusId || edge.target === focusId;
          context.strokeStyle = incident ? "#98dafa" : focusId ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
          context.lineWidth = incident ? 1.15 : 0.55;
          context.beginPath(); context.moveTo(projected.xs[a]!, projected.ys[a]!); context.lineTo(projected.xs[b]!, projected.ys[b]!); context.stroke();
        }
        const order = visNodes.map((_, i) => i).sort((a, b) => projected.zs[b]! - projected.zs[a]!);
        for (const i of order) {
          const node = visNodes[i]!;
          const highlighted = node.id === focusId;
          const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
          context.globalAlpha = focusId && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, projected.perspectives[i]!));
          context.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
          if (root || highlighted) { context.shadowColor = context.fillStyle as string; context.shadowBlur = 13; }
          context.beginPath(); context.arc(projected.xs[i]!, projected.ys[i]!, radii[i]!, 0, Math.PI * 2); context.fill(); context.shadowBlur = 0;
        }
        context.globalAlpha = 1;
        paintLabels(context, order);
      }
      const rotation = `${camera.yaw.toFixed(3)},${camera.pitch.toFixed(3)}`;
      canvas.dataset.rotation = rotation;
      if (glCanvasRef.current && glCanvasRef.current !== canvas) glCanvasRef.current.dataset.rotation = rotation;
      if (canvasRef.current && canvasRef.current !== canvas) canvasRef.current.dataset.rotation = rotation;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    redrawRef.current = schedule;
    const resize = () => {
      const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      if (labelCanvas) { labelCanvas.width = Math.round(width * dpr); labelCanvas.height = Math.round(height * dpr); }
      if (context) context.setTransform(dpr, 0, 0, dpr, 0, 0);
      schedule();
    };
    const hit = (x: number, y: number) => picker?.pick(x, y) ?? null;
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
      } else { hover = hit(p.x, p.y); canvas.style.cursor = hover ? "pointer" : "grab"; }
      schedule();
    };
    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1) { const id = hit(p.x, p.y); if (id) current.current.onSelectNode(id); }
      pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const wheel = (event: WheelEvent) => { event.preventDefault(); cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))); schedule(); };
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0; schedule();
      } else if (event.key === "Enter") { const node = current.current.nodes.find(node => node.id === current.current.selectedNodeId) ?? current.current.nodes.find(node => isMemoryCoreLabel(node.label)); if (node) current.current.onSelectNode(node.id); }
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); redrawRef.current = () => {}; canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key); renderer?.dispose(); };
  }, [mode]);
  useEffect(() => { redrawRef.current(); }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);
  const canvasProps = {
    "aria-label": "3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open.",
    role: "application" as const,
    "aria-busy": loading,
    "data-titles-visible": showTitles,
    "data-layout-volume": volumeRatio.toFixed(4)
  };
  return (
    <div className="memory-3d-surface">
      <canvas ref={glCanvasRef} className="memory-3d-layer" style={{ display: mode === "webgl" ? "block" : "none" }} tabIndex={mode === "webgl" ? 0 : -1} {...canvasProps} />
      <canvas ref={labelCanvasRef} className="memory-3d-layer memory-3d-labels" style={{ display: mode === "webgl" ? "block" : "none" }} aria-hidden="true" />
      <canvas ref={canvasRef} className="memory-3d-layer" style={{ display: mode === "canvas" ? "block" : "none" }} tabIndex={mode === "canvas" ? 0 : -1} {...canvasProps} />
      <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    </div>
  );
}
