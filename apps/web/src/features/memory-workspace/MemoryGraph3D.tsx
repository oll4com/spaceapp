import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import { MEMORY_FALLBACK_EDGE_LIMIT, MEMORY_FALLBACK_NODE_LIMIT, MemoryWebGLRenderer, memoryFallbackNodes, memoryLabelLayout, memoryProfilePhase, prepareMemoryRenderData, prepareMemoryRenderDataAsync, type MemoryRenderData, type RenderNode } from "./memory-webgl-renderer.js";
import { MemorySpatialIndex } from "./memory-spatial-index.js";

type Props = {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
};
type ScreenNode = { entry: RenderNode; x: number; y: number; z: number; radius: number; perspective: number };

/** Own the interactive camera, cancellable snapshot preparation and WebGL/Canvas lifecycle. */
export function MemoryGraph3D({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken }: Props) {
  const volumeRatio = useMemo(() => {
    const finishProfile = memoryProfilePhase("volume-ratio");
    try { return memory3DVolumeRatio([...coordinates.values()]); } finally { finishProfile(); }
  }, [coordinates]);
  const [prepared, setPrepared] = useState(() => {
    const data = prepareMemoryRenderData([], [], new Map(), new Map());
    return { data, index: new MemorySpatialIndex(data), nodes: null as MemoryGraphNode[] | null, edges: null as MemoryGraphEdge[] | null, positions: null as Map<string, MemoryAtlasPosition> | null, coordinates: null as Map<string, MemoryPoint3D> | null };
  });
  const renderData = prepared.data, spatialIndex = prepared.index;
  const preparing = prepared.nodes !== nodes || prepared.edges !== edges || prepared.positions !== positions || prepared.coordinates !== coordinates;
  const incoming = useRef({ nodes, edges, positions, coordinates });
  incoming.current = { nodes, edges, positions, coordinates };
  const prepareRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false, running = false;
    let previousCoordinates: Map<string, MemoryPoint3D> | null = null, previousPositions: Map<string, MemoryAtlasPosition> | null = null;
    const process = async () => {
      if (running || cancelled) return;
      running = true;
      try {
        while (!cancelled) {
          const snapshot = incoming.current;
          if (snapshot.nodes !== nodes || snapshot.edges !== edges || (snapshot.coordinates === previousCoordinates && snapshot.positions === previousPositions)) break;
          const data = await prepareMemoryRenderDataAsync(snapshot.nodes, snapshot.edges, snapshot.positions, snapshot.coordinates, () => cancelled);
          if (!data || cancelled) break;
          const index = await MemorySpatialIndex.create(data, () => cancelled);
          if (!index || cancelled) break;
          // Commit an intermediate layout even when newer coordinates arrived;
          // continually cancelling snapshots would starve a streamed layout.
          previousCoordinates = snapshot.coordinates; previousPositions = snapshot.positions;
          setPrepared({ data, index, ...snapshot });
        }
      } finally { running = false; }
    };
    prepareRef.current = () => { void process(); };
    prepareRef.current();
    return () => { cancelled = true; prepareRef.current = () => {}; };
  }, [nodes, edges]);
  useEffect(() => { prepareRef.current(); }, [nodes, edges, positions, coordinates]);
  const canvasRef = useRef<HTMLCanvasElement>(null), overlayRef = useRef<HTMLCanvasElement>(null), hintRef = useRef<HTMLSpanElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const current = useRef({ renderData, spatialIndex, showTitles, selectedNodeId, onSelectNode });
  current.current = { renderData, spatialIndex, showTitles, selectedNodeId, onSelectNode };
  useEffect(() => { cameraRef.current = { ...DEFAULT_MEMORY_CAMERA }; redrawRef.current(); }, [resetToken]);
  useEffect(() => {
    const canvas = canvasRef.current, overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const context = overlay.getContext("2d");
    if (!context) return;
    let renderer: MemoryWebGLRenderer | null = null, uploaded: MemoryRenderData | null = null;
    let frame = 0, width = 1, height = 1, dirty = true, disposed = false;
    let initializeTimer: ReturnType<typeof setTimeout> | null = null;
    let hover: string | null = null;
    let points: ScreenNode[] = [], fallbackLinks: MemoryGraphEdge[] = [], fallbackData: MemoryRenderData | null = null, fallbackFocus: string | null = null;
    const fallbackIds = new Set<string>(), hitGrid = new Map<string, ScreenNode[]>();
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;
    const hint = () => {
      if (hintRef.current) hintRef.current.textContent = renderer ? "Drag or arrows to rotate · Scroll, pinch or +/- to zoom · Click to explore" : `Canvas fallback · up to ${MEMORY_FALLBACK_NODE_LIMIT.toLocaleString()} nodes / ${MEMORY_FALLBACK_EDGE_LIMIT.toLocaleString()} edges · Drag or arrows to rotate · +/- to zoom`;
    };
    const initialize = () => {
      delete canvas.dataset.rendererError;
      const finishProfile = memoryProfilePhase("webgl-initialize");
      try {
        const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, depth: true, powerPreference: "low-power", preserveDrawingBuffer: false });
        if (!gl) canvas.dataset.rendererError = "WebGL2 context unavailable";
        if (gl) {
          const info = gl.getExtension("WEBGL_debug_renderer_info");
          canvas.dataset.gpuRenderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
          canvas.dataset.gpuVendor = info ? String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR));
        }
        renderer = gl ? new MemoryWebGLRenderer(gl) : null;
      } catch (error) { renderer = null; canvas.dataset.rendererError = error instanceof Error ? error.message : String(error); }
      finally { finishProfile(); }
      uploaded = null; canvas.dataset.renderer = renderer ? "webgl2" : "canvas2d"; hint();
    };
    // GPU context/shader startup gets its own task, separate from React mount
    // and the first cooperative graph-preparation slice.
    const initializeLater = () => {
      if (initializeTimer !== null) clearTimeout(initializeTimer);
      initializeTimer = setTimeout(() => {
        initializeTimer = null;
        if (disposed) return;
        initialize(); schedule();
      }, 0);
    };
    canvas.dataset.renderer = "canvas2d"; hint();
    const drawFallback = (data: MemoryRenderData, focus: string | null) => {
      if (fallbackData !== data || fallbackFocus !== focus) {
        const subset = memoryFallbackNodes(data, focus); fallbackIds.clear();
        for (const item of subset) fallbackIds.add(item.node.id);
        points = subset.map(entry => ({ entry, x: 0, y: 0, z: 0, radius: 0, perspective: 1 }));
        fallbackLinks = [];
        for (const edge of data.edges) {
          if (fallbackIds.has(edge.source) && fallbackIds.has(edge.target)) fallbackLinks.push(edge);
          if (fallbackLinks.length >= MEMORY_FALLBACK_EDGE_LIMIT) break;
        }
        fallbackData = data; fallbackFocus = focus;
      }
      const scale = Math.min(width, height) * 0.4 / data.extent, projected = new Map<string, ScreenNode>();
      hitGrid.clear();
      for (const item of points) {
        const p = projectMemoryPoint(item.entry.point, cameraRef.current, scale, width, height); Object.assign(item, p);
        item.radius = Math.max(1, item.entry.radius * p.perspective * Math.sqrt(cameraRef.current.zoom)) * (item.entry.node.id === focus ? 1.5 : 1);
        projected.set(item.entry.node.id, item);
        const radius = Math.max(7, item.radius + 3);
        for (let x = Math.floor((p.x - radius) / 32); x <= Math.floor((p.x + radius) / 32); x++) for (let y = Math.floor((p.y - radius) / 32); y <= Math.floor((p.y + radius) / 32); y++) {
          const key = `${x},${y}`; if (!hitGrid.has(key)) hitGrid.set(key, []); hitGrid.get(key)!.push(item);
        }
      }
      for (const edge of fallbackLinks) {
        const a = projected.get(edge.source)!, b = projected.get(edge.target)!, incident = edge.source === focus || edge.target === focus;
        context.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343"; context.lineWidth = incident ? 1.15 : 0.55;
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      }
      const neighbors = focus ? data.adjacency.get(focus) : undefined; points.sort((a, b) => b.z - a.z);
      for (const p of points) {
        const active = p.entry.node.id === focus;
        context.globalAlpha = focus && !active && !neighbors?.has(p.entry.node.id) ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
        context.fillStyle = active ? "#ffffff" : p.entry.color;
        if (isMemoryCoreLabel(p.entry.node.label) || active) { context.shadowColor = context.fillStyle; context.shadowBlur = 13; }
        context.beginPath(); context.arc(p.x, p.y, p.radius, 0, Math.PI * 2); context.fill(); context.shadowBlur = 0;
      }
      context.globalAlpha = 1;
    };
    const hitFallback = (x: number, y: number): string | null => {
      let nearest: ScreenNode | null = null;
      for (const p of hitGrid.get(`${Math.floor(x / 32)},${Math.floor(y / 32)}`) ?? []) if (Math.hypot(p.x - x, p.y - y) <= Math.max(7, p.radius + 3) && (!nearest || p.z <= nearest.z)) nearest = p;
      return nearest?.entry.node.id ?? null;
    };
    const render = () => {
      frame = 0; if (disposed) return;
      const { renderData: data, showTitles, selectedNodeId } = current.current, focus = hover ?? selectedNodeId;
      if (dirty || uploaded !== data) {
        const started = performance.now(); dirty = false; context.clearRect(0, 0, width, height);
        if (renderer) { if (uploaded !== data) { renderer.setData(data); uploaded = data; } renderer.render(cameraRef.current, width, height, focus); }
        else { uploaded = data; drawFallback(data, focus); }
        context.font = "11px system-ui, sans-serif";
        const labels = showTitles ? memoryLabelLayout(data, cameraRef.current, width, height, focus, text => context.measureText(text).width) : [];
        let drawnLabels = 0;
        for (const label of labels) {
          if (!renderer && !fallbackIds.has(label.node.node.id)) continue;
          context.fillStyle = "#09111bea"; context.fillRect(label.x - 3, label.y - 11, label.width + 6, 16);
          context.fillStyle = isMemoryCoreLabel(label.node.node.label) ? "#fff0b0" : "#c6dfed"; context.fillText(label.text, label.x, label.y + 1); drawnLabels++;
        }
        const cpuMs = performance.now() - started;
        canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
        canvas.dataset.nodeCount = String(renderer ? data.nodes.length : points.length); canvas.dataset.edgeCount = String(renderer ? data.edges.length : fallbackLinks.length);
        canvas.dataset.labelCount = String(drawnLabels); canvas.dataset.frameMs = cpuMs.toFixed(3);
        if (renderer?.gpuMs !== null && renderer?.gpuMs !== undefined) canvas.dataset.gpuMs = renderer.gpuMs.toFixed(3);
        window.dispatchEvent(new CustomEvent("memory-graph-frame", { detail: { cpuMs, gpuMs: renderer?.gpuMs ?? null, renderer: renderer ? "webgl2" : "canvas2d", nodes: renderer ? data.nodes.length : points.length, edges: renderer ? data.edges.length : fallbackLinks.length, labels: drawnLabels, drawCalls: renderer ? 2 : null } }));
      }
    };
    const schedule = () => { dirty = true; if (!frame) frame = requestAnimationFrame(render); };
    const queuePick = (x: number, y: number, select: boolean) => {
      const started = performance.now();
      const result = renderer ? current.current.spatialIndex.pick(x, y, cameraRef.current, width, height, hover ?? current.current.selectedNodeId) : { id: hitFallback(x, y), candidates: 0, visited: 0 };
      const durationMs = performance.now() - started;
      canvas.dataset.pickMs = durationMs.toFixed(3); canvas.dataset.pickCandidates = String(result.candidates);
      window.dispatchEvent(new CustomEvent("memory-graph-pick", { detail: { durationMs, latencyMs: durationMs, candidates: result.candidates, visited: result.visited, method: renderer ? "world-bvh" : "screen-grid" } }));
      if (select) { if (result.id) current.current.onSelectNode(result.id); }
      else if (hover !== result.id) { hover = result.id; canvas.style.cursor = hover ? "pointer" : "grab"; schedule(); }
    };
    redrawRef.current = schedule;
    const resize = () => {
      const rect = canvas.getBoundingClientRect(); width = Math.max(1, rect.width); height = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = overlay.width = Math.max(1, Math.round(width * dpr)); canvas.height = overlay.height = Math.max(1, Math.round(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0); schedule();
    };
    const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const down = (event: PointerEvent) => {
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const p = local(event); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false; hover = null; schedule();
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
        pointers.set(event.pointerId, p); schedule();
      } else queuePick(p.x, p.y, false);
    };
    const up = (event: PointerEvent) => {
      const p = local(event), select = !dragged && pointers.size === 1; pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (select) queuePick(p.x, p.y, true);
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const leave = () => { if (!pointers.size) { hover = null; canvas.style.cursor = "grab"; schedule(); } };
    const wheel = (event: WheelEvent) => { event.preventDefault(); cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))); schedule(); };
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0; schedule();
      } else if (["+", "=", "-", "_"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * (event.key === "+" || event.key === "=" ? 1.2 : 1 / 1.2))); schedule();
      } else if (event.key === "Enter") {
        const data = current.current.renderData, node = data.byId.get(current.current.selectedNodeId ?? "") ?? data.labels.find(item => isMemoryCoreLabel(item.node.label));
        if (node) current.current.onSelectNode(node.node.id);
      }
    };
    const lost = (event: Event) => {
      if (initializeTimer !== null) { clearTimeout(initializeTimer); initializeTimer = null; }
      event.preventDefault(); renderer?.dispose(); renderer = null; uploaded = null;
      canvas.dataset.renderer = "canvas2d"; canvas.dataset.contextLost = "true"; hint(); schedule();
    };
    const restored = () => { delete canvas.dataset.contextLost; initializeLater(); };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key); canvas.addEventListener("webglcontextlost", lost); canvas.addEventListener("webglcontextrestored", restored);
    initializeLater();
    return () => {
      if (initializeTimer !== null) clearTimeout(initializeTimer);
      disposed = true; observer.disconnect(); cancelAnimationFrame(frame); renderer?.dispose(); redrawRef.current = () => {};
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key); canvas.removeEventListener("webglcontextlost", lost); canvas.removeEventListener("webglcontextrestored", restored);
    };
  }, []);
  useEffect(() => { redrawRef.current(); }, [renderData, showTitles, selectedNodeId]);
  return <div className="memory-3d-surface">
    <canvas ref={canvasRef} tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll, pinch, or use plus and minus keys to zoom. Click a node or press Enter to open." aria-busy={loading || preparing} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} />
    <canvas ref={overlayRef} aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
    <span ref={hintRef} className="memory-3d-hint">Drag or arrows to rotate · Scroll, pinch or +/- to zoom · Click to explore</span>
  </div>;
}
