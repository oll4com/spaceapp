import { useEffect, useMemo, useRef } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, buildStreamedMemoryPositions, collectMemoryLabelCandidates, memory3DVolumeRatio, projectMemoryPoint, selectMemoryLabels, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import { MemoryGraphWebGLRenderer, hexToRgb, type MemoryWebGLScene } from "./memory-graph-webgl.js";

/** The Canvas 2D fallback keeps the historical cap from the overview endpoint. */
const CANVAS_2D_NODE_CAP = 2000;

interface SceneData {
  scene: MemoryWebGLScene;
  ids: string[];
  /** Node objects aligned with `ids` (and with the projected points). */
  orderedNodes: MemoryGraphNode[];
  indexById: Map<string, number>;
  neighborsByIndex: Array<Set<number>>;
}

/**
 * Pack nodes, edges, and their positions into the flat typed-array scene the
 * WebGL renderer consumes. Returns null until layout coordinates exist.
 * @param nodes All graph nodes.
 * @param edges All graph edges.
 * @param coordinates 3D layout coordinates keyed by node id.
 * @param positions 2D atlas positions keyed by node id (source of colors/sizes).
 * @returns The packed scene, or null when no coordinates are ready.
 */
function buildScene(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], coordinates: Map<string, MemoryPoint3D>, positions: Map<string, MemoryAtlasPosition>): SceneData | null {
  const ids: string[] = [];
  const indexById = new Map<string, number>();
  for (const node of nodes) {
    if (!coordinates.has(node.id)) continue;
    indexById.set(node.id, ids.length);
    ids.push(node.id);
  }
  if (!ids.length) return null;
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const scenePositions = new Float32Array(ids.length * 3);
  const colors = new Float32Array(ids.length * 3);
  const baseSizes = new Float32Array(ids.length);
  let extent = 60;
  ids.forEach((id, index) => {
    const point = coordinates.get(id)!;
    scenePositions[index * 3] = point.x;
    scenePositions[index * 3 + 1] = point.y;
    scenePositions[index * 3 + 2] = point.z;
    extent = Math.max(extent, Math.hypot(point.x, point.y, point.z));
    const [r, g, b] = hexToRgb(positions.get(id)?.color ?? "#7395ad");
    colors[index * 3] = r;
    colors[index * 3 + 1] = g;
    colors[index * 3 + 2] = b;
    const node = nodeById.get(id)!;
    baseSizes[index] = node.type === "SOURCE" && isMemoryCoreLabel(node.label) ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
  });
  const visibleEdges = edges.filter(edge => indexById.has(edge.source) && indexById.has(edge.target));
  const edgePositions = new Float32Array(visibleEdges.length * 6);
  const edgeColors = new Float32Array(visibleEdges.length * 6);
  const edgeNodeIndices = new Float32Array(visibleEdges.length * 2);
  const neighborsByIndex: Array<Set<number>> = ids.map(() => new Set<number>());
  visibleEdges.forEach((edge, edgeIndex) => {
    const a = indexById.get(edge.source)!, b = indexById.get(edge.target)!;
    neighborsByIndex[a]!.add(b);
    neighborsByIndex[b]!.add(a);
    const [r, g, bl] = hexToRgb(edge.type === "DERIVED_FROM" ? "#385068" : "#203343");
    for (const [slot, index] of [[0, a], [1, b]] as const) {
      edgePositions[edgeIndex * 6 + slot * 3] = scenePositions[index * 3]!;
      edgePositions[edgeIndex * 6 + slot * 3 + 1] = scenePositions[index * 3 + 1]!;
      edgePositions[edgeIndex * 6 + slot * 3 + 2] = scenePositions[index * 3 + 2]!;
      edgeColors[edgeIndex * 6 + slot * 3] = r;
      edgeColors[edgeIndex * 6 + slot * 3 + 1] = g;
      edgeColors[edgeIndex * 6 + slot * 3 + 2] = bl;
      edgeNodeIndices[edgeIndex * 2 + slot] = index;
    }
  });
  return {
    scene: { positions: scenePositions, colors, baseSizes, edgePositions, edgeColors, edgeNodeIndices, extent },
    ids,
    orderedNodes: ids.map(id => nodeById.get(id)!),
    indexById,
    neighborsByIndex
  };
}

/**
 * Interactive 3D memory graph: WebGL2 instanced rendering with a Canvas 2D
 * fallback, rotation/zoom/pan, hover and click picking, and node labels.
 */
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
  const current = useRef({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode };
  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const labelCanvas = labelCanvasRef.current;
    if (!canvas || !labelCanvas) return;
    let frame = 0, width = 1, height = 1, dpr = 1;
    let hover: string | null = null;
    let points: Array<{ id: string; x: number; y: number; z: number; radius: number }> = [];
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;

    // --- Renderer selection: WebGL2 first, Canvas 2D as the fallback. ---
    let renderer: MemoryGraphWebGLRenderer | null = null;
    let sceneData: SceneData | null = null;
    let sceneNodes: MemoryGraphNode[] | null = null;
    let sceneEdges: MemoryGraphEdge[] | null = null;
    let scenePositions: Map<string, MemoryAtlasPosition> | null = null;
    let sceneCoordinates: Map<string, MemoryPoint3D> | null = null;
    let focusIndex = -2; // -2 = focus uniforms not yet pushed
    if (MemoryGraphWebGLRenderer.isSupported()) {
      try {
        renderer = new MemoryGraphWebGLRenderer(canvas);
      } catch {
        renderer = null;
      }
    }
    /** 2D context for drawing; when WebGL is active labels go on the overlay, otherwise the canvas itself. */
    const fallbackContext = (): CanvasRenderingContext2D | null => {
      if (renderer) return labelCanvas.getContext("2d");
      return canvas.getContext("2d") ?? labelCanvas.getContext("2d");
    };
    let labelContext: CanvasRenderingContext2D | null = null;

    /** Rebuild or stream-update the GPU scene when nodes, edges, or coordinates change. */
    const syncScene = () => {
      if (!renderer) return;
      const { nodes, edges, positions, coordinates } = current.current;
      if (sceneData && nodes === sceneNodes && edges === sceneEdges && positions === scenePositions && coordinates === sceneCoordinates) return;
      if (sceneData && nodes === sceneNodes && edges === sceneEdges && positions === scenePositions) {
        // Layout streaming: only the coordinates moved. Repacking the full
        // scene per snapshot (colors, sizes, neighbor sets, edge colors)
        // costs ~200 ms at 50,000 nodes on the main thread, so rebuild only
        // the position arrays and push them into the existing GPU buffers.
        const streamed = buildStreamedMemoryPositions(sceneData.ids, sceneData.scene.edgeNodeIndices, coordinates);
        if (streamed) {
          renderer.updatePositions(streamed.positions, streamed.edgePositions, streamed.extent);
          sceneData = { ...sceneData, scene: { ...sceneData.scene, positions: streamed.positions, edgePositions: streamed.edgePositions, extent: streamed.extent } };
          sceneCoordinates = coordinates;
          return;
        }
      }
      const next = buildScene(nodes, edges, coordinates, positions);
      if (!next) {
        if (sceneData) {
          // The scene became empty (e.g. an empty search): clear the WebGL
          // canvas and the picking/focus state. The fallback path draws on
          // the label canvas only, so without this the last WebGL frame
          // would stay visible underneath it indefinitely.
          renderer.clear();
          sceneData = null;
          focusIndex = -2;
          hover = null;
          points = [];
        }
        return;
      }
      // Anything reaching here changed more than the coordinates (the pure
      // streaming case is handled above), so derived arrays such as colors
      // and neighbor sets may differ — upload the full scene.
      renderer.setScene(next.scene);
      sceneData = next;
      focusIndex = -2;
      sceneNodes = nodes;
      sceneEdges = edges;
      scenePositions = positions;
      sceneCoordinates = coordinates;
    };

    /** Dim non-neighbors and highlight the hovered/selected node. */
    const applyFocus = () => {
      if (!renderer || !sceneData) return;
      const focusId = hover ?? current.current.selectedNodeId;
      const index = focusId ? sceneData.indexById.get(focusId) ?? -1 : -1;
      if (index === focusIndex) return;
      focusIndex = index;
      renderer.setFocus(index, index >= 0 ? sceneData.neighborsByIndex[index]! : null);
    };

    /**
     * Draw node labels on the overlay from the last projected frame.
     * @param projected [x, y, depth, perspective] quads from the renderer.
     */
    const drawLabels = (projected: Float32Array) => {
      if (!labelContext) labelContext = labelCanvas.getContext("2d");
      if (!labelContext) return;
      const { showTitles } = current.current;
      labelContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      labelContext.clearRect(0, 0, width, height);
      if (!showTitles || !sceneData) return;
      const candidates = collectMemoryLabelCandidates(sceneData.orderedNodes, projected, {
        focusId: hover ?? current.current.selectedNodeId,
        zoom: cameraRef.current.zoom
      });
      labelContext.font = "11px system-ui, sans-serif";
      const placements = selectMemoryLabels(candidates, {
        focusId: hover ?? current.current.selectedNodeId,
        zoom: cameraRef.current.zoom,
        width,
        height,
        measure: text => labelContext!.measureText(text).width
      });
      for (const placement of placements) {
        labelContext.fillStyle = "#09111bea";
        labelContext.fillRect(placement.x - 3, placement.y - 11, placement.width + 6, 16);
        labelContext.fillStyle = placement.core ? "#fff0b0" : "#c6dfed";
        labelContext.fillText(placement.text, placement.x, placement.y + 1);
      }
    };

    /** One WebGL frame: focus, GPU draw, labels, and rotation state for tests. */
    const renderWebGL = () => {
      if (!renderer || !sceneData) return;
      const scale = Math.min(width, height) * 0.4 / sceneData.scene.extent;
      applyFocus();
      renderer.render(cameraRef.current, scale, width, height);
      drawLabels(renderer.projectedPoints());
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };

    /** One Canvas 2D frame (fallback for no-WebGL / lost context), capped at CANVAS_2D_NODE_CAP nodes. */
    const renderCanvas2D = () => {
      const context = fallbackContext();
      if (!context) return;
      // A resize resets the context transform, and after a WebGL context
      // loss nothing reapplies it to the fallback context — set it on every
      // draw so the fallback renders at CSS-pixel scale on any display.
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const all = current.current;
      const cappedNodes = all.nodes.length > CANVAS_2D_NODE_CAP ? all.nodes.slice(0, CANVAS_2D_NODE_CAP) : all.nodes;
      const cappedIds = new Set(cappedNodes.map(node => node.id));
      const nodes = cappedNodes;
      const edges = all.nodes.length > CANVAS_2D_NODE_CAP ? all.edges.filter(edge => cappedIds.has(edge.source) && cappedIds.has(edge.target)) : all.edges;
      const { positions, coordinates, showTitles, selectedNodeId } = all;
      context.clearRect(0, 0, width, height);
      // Extent over the drawn (capped) nodes only: spreading the full
      // coordinates map into Math.max would walk all 50,000 entries and
      // allocate an array on every fallback frame.
      let extent = 60;
      for (const node of nodes) {
        const point = coordinates.get(node.id);
        if (point) extent = Math.max(extent, Math.hypot(point.x, point.y, point.z));
      }
      const scale = Math.min(width, height) * 0.4 / extent;
      const projected = new Map(nodes.flatMap(node => {
        const p = coordinates.get(node.id);
        return p ? [[node.id, projectMemoryPoint(p, cameraRef.current, scale, width, height)] as const] : [];
      }));
      const focus = hover ?? selectedNodeId;
      const neighbors = new Set<string>();
      if (focus) for (const edge of edges) { if (edge.source === focus) neighbors.add(edge.target); if (edge.target === focus) neighbors.add(edge.source); }
      context.lineWidth = 0.55;
      for (const edge of edges) {
        const a = projected.get(edge.source), b = projected.get(edge.target);
        if (!a || !b) continue;
        const incident = edge.source === focus || edge.target === focus;
        context.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
        context.lineWidth = incident ? 1.15 : 0.55;
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      }
      points = [];
      const ordered = nodes.filter(node => projected.has(node.id)).sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
      const labelBoxes: Array<{ x: number; y: number; w: number }> = [];
      for (const node of ordered) {
        const p = projected.get(node.id)!;
        const highlighted = node.id === focus;
        const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * p.perspective * Math.sqrt(cameraRef.current.zoom)) * (highlighted ? 1.5 : 1);
        points.push({ id: node.id, ...p, radius });
        context.globalAlpha = focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
        context.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
        if (root || highlighted) { context.shadowColor = context.fillStyle; context.shadowBlur = 13; }
        context.beginPath(); context.arc(p.x, p.y, radius, 0, Math.PI * 2); context.fill(); context.shadowBlur = 0;
      }
      context.globalAlpha = 1;
      if (showTitles) {
        const labeled = [...ordered].sort((a, b) => Number(b.id === focus) - Number(a.id === focus) || Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) || Number(b.type === "SOURCE") - Number(a.type === "SOURCE"));
        context.font = "11px system-ui, sans-serif";
        for (const node of labeled) {
          if (node.type !== "SOURCE" && node.id !== focus && cameraRef.current.zoom < 1.6) continue;
          const p = projected.get(node.id)!;
          const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
          const x = p.x + 9, y = p.y, w = context.measureText(label).width;
          if (x + w > width || y < 14 || y > height - 5 || labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
          labelBoxes.push({ x, y, w });
          context.fillStyle = "#09111bea"; context.fillRect(x - 3, y - 11, w + 6, 16);
          context.fillStyle = isMemoryCoreLabel(node.label) ? "#fff0b0" : "#c6dfed"; context.fillText(label, x, y + 1);
        }
      }
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };

    /** Sync the scene, then draw the next frame on whichever renderer is live. */
    const render = () => {
      frame = 0;
      syncScene();
      if (renderer && sceneData) renderWebGL();
      else renderCanvas2D();
    };
    /** Request one animation frame of rendering, coalescing duplicate requests. */
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    redrawRef.current = schedule;
    /** Resize both canvases to the CSS box (capped at 2x DPR) and redraw. */
    const resize = () => {
      const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const target of [canvas, labelCanvas]) {
        target.width = Math.round(width * dpr); target.height = Math.round(height * dpr);
      }
      labelContext?.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!renderer) canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
      schedule();
    };
    /**
     * Node id under a CSS-pixel pointer position, via GPU pick index or the
     * Canvas 2D fallback's reverse z-order scan.
     * @param x Pointer x in CSS pixels.
     * @param y Pointer y in CSS pixels.
     * @returns The hit node id, or null.
     */
    const hit = (x: number, y: number) => {
      if (renderer && sceneData) {
        const index = renderer.pick(x, y);
        return index >= 0 ? sceneData.ids[index] ?? null : null;
      }
      return [...points].reverse().find(p => Math.hypot(p.x - x, p.y - y) < Math.max(7, p.radius + 3))?.id ?? null;
    };
    /** Pointer position in canvas-local CSS pixels. */
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
    /** Fall back to Canvas 2D on WebGL context loss, keeping the view alive. */
    const contextLost = (event: Event) => {
      // Keep the view alive on the Canvas 2D fallback; allow the browser to restore.
      event.preventDefault();
      renderer?.dispose();
      renderer = null;
      sceneData = null;
      labelContext = null;
      schedule();
    };
    /** Re-create the WebGL renderer when the browser restores the context. */
    const contextRestored = () => {
      if (!renderer && MemoryGraphWebGLRenderer.isSupported()) {
        try {
          renderer = new MemoryGraphWebGLRenderer(canvas);
          sceneData = null;
          sceneNodes = null;
          focusIndex = -2;
        } catch {
          renderer = null;
        }
      }
      schedule();
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    canvas.addEventListener("webglcontextlost", contextLost); canvas.addEventListener("webglcontextrestored", contextRestored);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); redrawRef.current = () => {}; renderer?.dispose(); canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key); canvas.removeEventListener("webglcontextlost", contextLost); canvas.removeEventListener("webglcontextrestored", contextRestored); };
  }, []);
  useEffect(() => { redrawRef.current(); }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);
  return <div className="memory-3d-surface"><canvas ref={canvasRef} tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open." aria-busy={loading} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} /><canvas ref={labelCanvasRef} className="memory-3d-labels" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} /><span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span></div>;
}
