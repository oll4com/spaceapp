import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatioFlat, projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import {
  MEMORY_CANVAS_FALLBACK_MAX_NODES, buildMemoryScene, clampMemoryZoom, memoryCameraUniforms, memoryFocusFlags, memoryNodeRadius,
  memoryPercentile, memoryViewExtent, pickMemoryCircle, projectMemoryClip, selectMemoryLabels, type MemoryCameraUniforms
} from "./memory-3d-view.js";
import { MemoryWebGLRenderer } from "./memory-3d-webgl.js";

/** How long a lost WebGL context may take to come back before the Canvas 2D renderer takes over. */
const CONTEXT_RESTORE_GRACE_MS = 2500;
const labelText = (label: string) => label.length > 48 ? `${label.slice(0, 45)}…` : label;

export function MemoryGraph3D({ nodes, edges, positions, coordinates, layoutBuffer, showTitles, selectedNodeId, onSelectNode, onRendererFallback, loading, resetToken }: {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  /** x,y,z per node in `nodes` order, streamed from the layout worker; takes precedence over `coordinates`. */
  layoutBuffer?: Float32Array | null;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  /** Called when the view drops to the Canvas 2D renderer (no WebGL2, or the context was not restored). */
  onRendererFallback?: () => void;
  loading: boolean; resetToken: number;
}) {
  const [renderer, setRenderer] = useState<"webgl2" | "canvas2d">("webgl2");
  // The Canvas 2D fallback keeps its original node cap.
  const capped = renderer === "canvas2d" && nodes.length > MEMORY_CANVAS_FALLBACK_MAX_NODES;
  const drawNodes = useMemo(() => capped ? nodes.slice(0, MEMORY_CANVAS_FALLBACK_MAX_NODES) : nodes, [capped, nodes]);
  const drawEdges = useMemo(() => {
    if (!capped) return edges;
    const ids = new Set(drawNodes.map(node => node.id));
    return edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
  }, [capped, edges, drawNodes]);
  const scene = useMemo(() => buildMemoryScene(drawNodes, drawEdges, id => positions.get(id)?.color), [drawNodes, drawEdges, positions]);
  const layout = useMemo(() => {
    const length = drawNodes.length * 3;
    if (layoutBuffer) return { flat: layoutBuffer.subarray(0, length), ready: length > 0 && layoutBuffer.length >= length };
    const flat = new Float32Array(length);
    drawNodes.forEach((node, i) => {
      const p = coordinates.get(node.id);
      if (p) { flat[i * 3] = p.x; flat[i * 3 + 1] = p.y; flat[i * 3 + 2] = p.z; }
    });
    return { flat, ready: coordinates.size > 0 };
    // `coordinates` is irrelevant while a streamed buffer is in use.
  }, [drawNodes, layoutBuffer, layoutBuffer ? null : coordinates]);
  const extent = useMemo(() => memoryViewExtent(layout.flat), [layout]);
  const volumeRatio = useMemo(() => memory3DVolumeRatioFlat(layout.flat), [layout]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const current = useRef({ nodes: drawNodes, scene, layout, extent, positions, showTitles, selectedNodeId, onSelectNode, onRendererFallback });
  current.current = { nodes: drawNodes, scene, layout, extent, positions, showTitles, selectedNodeId, onSelectNode, onRendererFallback };
  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let gl: MemoryWebGLRenderer | null = null;
    let context: CanvasRenderingContext2D | null = null;
    if (renderer === "webgl2") {
      gl = MemoryWebGLRenderer.create(canvas);
      if (!gl) { setRenderer("canvas2d"); current.current.onRendererFallback?.(); return; }
    } else {
      context = canvas.getContext("2d");
      if (!context) return;
    }
    const labelContext = renderer === "webgl2" ? labelRef.current?.getContext("2d") ?? null : null;
    let frame = 0, width = 1, height = 1, dpr = 1, lostTimer = 0;
    let hover: string | null = null;
    let pendingHover: { x: number; y: number } | null = null;
    let circles: Array<{ x: number; y: number; z: number; radius: number }> = [];
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;
    // GL bookkeeping: what is currently uploaded, so a frame only re-uploads what changed.
    let uploadedScene: unknown = null, uploadedFlat: unknown = null, appliedFocus = -2;
    let flags = new Uint8Array(0);
    const frameTimes: number[] = [];
    let lastFrameAt = 0;
    const widths = new Map<string, number>();
    const view = (): MemoryCameraUniforms => memoryCameraUniforms({ ...cameraRef.current }, current.current.extent, width, height);
    const focusIndex = () => {
      const { scene, selectedNodeId } = current.current;
      const id = hover ?? selectedNodeId;
      return id ? scene.index.get(id) ?? -1 : -1;
    };
    const drawLabels = (target: CanvasRenderingContext2D, uniforms: MemoryCameraUniforms, focus: number) => {
      const { nodes, scene, layout } = current.current;
      target.font = "11px system-ui, sans-serif";
      const placements = selectMemoryLabels({
        order: scene.labelOrder, focus, zoom: uniforms.zoom, width, height,
        isSource: i => scene.kinds[i]! > 0,
        project: i => {
          const c = projectMemoryClip({ x: layout.flat[i * 3]!, y: layout.flat[i * 3 + 1]!, z: layout.flat[i * 3 + 2]! }, uniforms);
          return { x: uniforms.halfWidth + c.x * uniforms.halfWidth, y: uniforms.halfHeight - c.y * uniforms.halfHeight };
        },
        measure: i => {
          const text = labelText(nodes[i]!.label);
          let w = widths.get(text);
          if (w === undefined) { if (widths.size > 4000) widths.clear(); w = target.measureText(text).width; widths.set(text, w); }
          return w;
        }
      });
      for (const { index, x, y, width: w } of placements) {
        const label = nodes[index]!.label;
        target.fillStyle = "#09111bea"; target.fillRect(x - 3, y - 11, w + 6, 16);
        target.fillStyle = isMemoryCoreLabel(label) ? "#fff0b0" : "#c6dfed"; target.fillText(labelText(label), x, y + 1);
      }
    };
    const renderGL = () => {
      const { scene, layout, nodes, showTitles } = current.current;
      if (uploadedScene !== scene) {
        gl!.setGraph(scene); flags = new Uint8Array(scene.count);
        uploadedScene = scene; uploadedFlat = null; appliedFocus = -2;
      }
      if (uploadedFlat !== layout.flat) {
        gl!.setPositions(layout.flat.length === scene.count * 3 ? layout.flat : new Float32Array(scene.count * 3));
        uploadedFlat = layout.flat;
      }
      gl!.hidden = !layout.ready;
      const uniforms = view();
      if (pendingHover) {
        const started = performance.now();
        const index = gl!.pick(uniforms, pendingHover.x, pendingHover.y, height);
        hover = index >= 0 ? nodes[index]?.id ?? null : null;
        canvas.style.cursor = hover ? "pointer" : "grab";
        canvas.dataset.pickMs = (performance.now() - started).toFixed(2);
        pendingHover = null;
      }
      const focus = focusIndex();
      if (focus !== appliedFocus) { gl!.setFlags(memoryFocusFlags(scene, focus, flags)); appliedFocus = focus; }
      gl!.draw(uniforms, focus);
      if (labelContext) {
        labelContext.setTransform(dpr, 0, 0, dpr, 0, 0);
        labelContext.clearRect(0, 0, width, height);
        if (showTitles && layout.ready) drawLabels(labelContext, uniforms, focus);
      }
    };
    const renderCanvas = () => {
      const { scene, layout, nodes, positions, showTitles } = current.current;
      const target = context!;
      target.clearRect(0, 0, width, height);
      circles = [];
      if (!layout.ready) return;
      const scale = Math.min(width, height) * 0.4 / current.current.extent;
      const camera = cameraRef.current, flat = layout.flat;
      const projected = nodes.map((_, i) => projectMemoryPoint({ x: flat[i * 3]!, y: flat[i * 3 + 1]!, z: flat[i * 3 + 2]! }, camera, scale, width, height));
      const focus = focusIndex();
      const highlight = memoryFocusFlags(scene, focus);
      const ends = scene.edgeEnds;
      target.lineWidth = 0.55;
      for (let e = 0; e < ends.length; e += 2) {
        const a = projected[ends[e]!]!, b = projected[ends[e + 1]!]!;
        const incident = ends[e] === focus || ends[e + 1] === focus;
        target.strokeStyle = incident ? "#98dafa" : focus >= 0 ? "#14202b" : scene.edgeKinds[e / 2] ? "#385068" : "#203343";
        target.lineWidth = incident ? 1.15 : 0.55;
        target.beginPath(); target.moveTo(a.x, a.y); target.lineTo(b.x, b.y); target.stroke();
      }
      circles = nodes.map(() => ({ x: 0, y: 0, z: 0, radius: 0 }));
      const ordered = nodes.map((_, i) => i).sort((a, b) => projected[b]!.z - projected[a]!.z);
      for (const i of ordered) {
        const p = projected[i]!, highlighted = i === focus, kind = scene.kinds[i]!;
        const radius = memoryNodeRadius(kind === 2 ? "root" : kind === 1 ? "source" : "other", p.perspective, camera.zoom, highlighted);
        circles[i] = { x: p.x, y: p.y, z: p.z, radius };
        target.globalAlpha = focus >= 0 && !highlighted && highlight[i] !== 1 ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
        target.fillStyle = highlighted ? "#ffffff" : positions.get(nodes[i]!.id)?.color ?? "#7395ad";
        if (kind === 2 || highlighted) { target.shadowColor = target.fillStyle; target.shadowBlur = 13; }
        target.beginPath(); target.arc(p.x, p.y, radius, 0, Math.PI * 2); target.fill(); target.shadowBlur = 0;
      }
      target.globalAlpha = 1;
      if (showTitles) drawLabels(target, memoryCameraUniforms(camera, current.current.extent, width, height), focus);
    };
    const render = (timestamp: number) => {
      frame = 0;
      if (lastFrameAt && timestamp - lastFrameAt < 100) {
        frameTimes.push(timestamp - lastFrameAt);
        if (frameTimes.length > 120) frameTimes.shift();
        canvas.dataset.frameP95 = memoryPercentile(frameTimes, 0.95).toFixed(1);
      }
      lastFrameAt = timestamp;
      if (gl) renderGL(); else renderCanvas();
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    redrawRef.current = schedule;
    if (gl) {
      gl.onContextLost = () => {
        window.clearTimeout(lostTimer);
        lostTimer = window.setTimeout(() => { setRenderer("canvas2d"); current.current.onRendererFallback?.(); }, CONTEXT_RESTORE_GRACE_MS);
      };
      gl.onContextRestored = () => { window.clearTimeout(lostTimer); schedule(); };
    }
    const resize = () => {
      const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (gl) {
        gl.resize(width, height, dpr);
        const labels = labelRef.current;
        if (labels) { labels.width = Math.round(width * dpr); labels.height = Math.round(height * dpr); }
      } else {
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
        context!.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      schedule();
    };
    const hit = (x: number, y: number) => {
      const { nodes } = current.current;
      const index = gl ? gl.pick(view(), x, y, height) : pickMemoryCircle(circles, x, y);
      return index >= 0 ? nodes[index]?.id ?? null : null;
    };
    const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const down = (event: PointerEvent) => {
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const p = local(event); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false; hover = null; pendingHover = null;
    };
    const move = (event: PointerEvent) => {
      const p = local(event), previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 1) cameraRef.current.zoom = clampMemoryZoom(cameraRef.current.zoom * after / before);
        } else { cameraRef.current.yaw += (p.x - previous.x) * 0.009; cameraRef.current.pitch += (p.y - previous.y) * 0.009; }
        pointers.set(event.pointerId, p);
      } else if (gl) {
        // GPU picking runs at most once per frame, however many pointer events arrive.
        pendingHover = p;
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
    const wheel = (event: WheelEvent) => { event.preventDefault(); cameraRef.current.zoom = clampMemoryZoom(cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001)); schedule(); };
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0; schedule();
      } else if (event.key === "Enter") { const node = current.current.nodes.find(node => node.id === current.current.selectedNodeId) ?? current.current.nodes.find(node => isMemoryCoreLabel(node.label)); if (node) current.current.onSelectNode(node.id); }
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame); window.clearTimeout(lostTimer); redrawRef.current = () => {}; gl?.dispose();
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key);
    };
  }, [renderer]);
  useEffect(() => { redrawRef.current(); }, [scene, layout, extent, positions, showTitles, selectedNodeId]);
  return <div className="memory-3d-surface"><canvas key={renderer} ref={canvasRef} tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open." aria-busy={loading} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} data-renderer={renderer} />{renderer === "webgl2" ? <canvas ref={labelRef} className="memory-3d-labels" aria-hidden="true" /> : null}<span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span></div>;
}
