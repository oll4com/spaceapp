import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { MemoryGraphCanvas3D } from "./MemoryGraphCanvas3D.js";
import { createMemoryRenderModel, MEMORY_CANVAS_LIMIT, memoryLabelCandidates, type MemoryRenderModel } from "./memory-3d-model.js";
import { MemoryWebGLRenderer } from "./memory-3d-webgl.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, projectMemoryPoint } from "./memory-3d.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { MemoryBenchmarkSession } from "./memory-3d-benchmark.js";

type Props = ComponentProps<typeof MemoryGraphCanvas3D> & { frame?: Float32Array; preparedModel?: MemoryRenderModel; benchmark?: boolean };

export function MemoryGraph3D(props: Props) {
  const { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken, frame: streamedFrame } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null), labelsRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MemoryWebGLRenderer | null>(null);
  const contextLossRef = useRef<WEBGL_lose_context | null>(null);
  const cameraRef = useRef({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const resizeRef = useRef<() => void>(() => {});
  const [mode, setMode] = useState<"probing" | "webgl2" | "fallback">("probing");
  const [benchmarkResult, setBenchmarkResult] = useState("");
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkProgress, setBenchmarkProgress] = useState(0);
  const benchmarkRun = useRef<MemoryBenchmarkSession | null>(null);
  const gpuName = useRef("unknown");
  const longTasks = useRef<Array<{ start: number; duration: number }>>([]);
  const loadStarted = useRef(performance.now()), loadFinished = useRef(Number.POSITIVE_INFINITY);
  const model = useMemo(() => props.preparedModel ?? createMemoryRenderModel(nodes, edges, positions, coordinates), [nodes, edges, positions, coordinates, props.preparedModel]);
  const current = useRef({ model, showTitles, selectedNodeId, onSelectNode });
  current.current = { model, showTitles, selectedNodeId, onSelectNode };
  const fallback = useMemo(() => {
    if (mode !== "fallback") return { nodes: [], edges: [], coordinates: new Map() };
    const subset = nodes.slice(0, MEMORY_CANVAS_LIMIT), ids = new Set(subset.map(node => node.id));
    return { nodes: subset, edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).slice(0, 6000),
      coordinates: new Map(subset.map(node => { const i = model.index.get(node.id)! * 3; return [node.id, streamedFrame ? { x: streamedFrame[i]!, y: streamedFrame[i + 1]!, z: streamedFrame[i + 2]! } : coordinates.get(node.id) ?? { x: 0, y: 0, z: 0 }]; })) };
  }, [nodes, edges, coordinates, model, streamedFrame, mode]);
  const volumeRatio = useMemo(() => memory3DVolumeRatio(streamedFrame ?? [...coordinates.values()]), [coordinates, streamedFrame]);
  useEffect(() => {
    if (loading) { loadStarted.current = performance.now(); loadFinished.current = Number.POSITIVE_INFINITY; }
    else loadFinished.current = performance.now();
  }, [loading]);
  useEffect(() => {
    if (!props.benchmark || typeof PerformanceObserver === "undefined") return;
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) longTasks.current.push({ start: entry.startTime, duration: entry.duration });
    });
    try { observer.observe({ type: "longtask", buffered: true }); } catch { return; }
    return () => observer.disconnect();
  }, [props.benchmark]);
  useEffect(() => { cameraRef.current = { ...DEFAULT_MEMORY_CAMERA }; redrawRef.current(); }, [resetToken]);
  useEffect(() => { rendererRef.current?.setModel(model); resizeRef.current(); redrawRef.current(); }, [model]);
  useEffect(() => {
    if (streamedFrame) rendererRef.current?.updatePositions(streamedFrame);
    redrawRef.current();
  }, [streamedFrame]);
  useEffect(() => { redrawRef.current(); }, [showTitles, selectedNodeId]);

  useEffect(() => {
    const canvas = canvasRef.current, labels = labelsRef.current;
    if (!canvas || !labels) return;
    let gl: WebGL2RenderingContext | null = null;
    try { gl = canvas.getContext("webgl2", { alpha: true, antialias: false, preserveDrawingBuffer: false }); } catch { /* Canvas fallback. */ }
    if (!gl) { setMode("fallback"); return; }
    if (props.benchmark) contextLossRef.current = gl.getExtension("WEBGL_lose_context");
    const labelContext = labels.getContext("2d");
    let animation = 0, width = 1, height = 1, hover = -1;
    let hoverModel = current.current.model;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;
    const render = (timestamp: number) => {
      animation = 0;
      const { model, showTitles, selectedNodeId } = current.current;
      // Hover indices belong to a specific model, even when its size is unchanged.
      if (hoverModel !== model) { hoverModel = model; hover = -1; canvas.style.cursor = "grab"; }
      const focus = hover >= 0 ? hover : model.index.get(selectedNodeId ?? "") ?? -1;
      const camera = cameraRef.current;
      benchmarkRun.current?.beforeDraw(timestamp, camera);
      rendererRef.current?.setFocus(focus); rendererRef.current?.draw(camera);
      if (benchmarkRun.current && rendererRef.current) {
        if (benchmarkRun.current.afterDraw(rendererRef.current, width, height, longTasks.current)) { benchmarkRun.current = null; setBenchmarkRunning(false); }
        else schedule();
      }
      canvas.dataset.rotation = camera.yaw.toFixed(3) + "," + camera.pitch.toFixed(3);
      canvas.dataset.zoom = camera.zoom.toFixed(3);
      if (!labelContext) return;
      labelContext.clearRect(0, 0, width, height);
      if (!showTitles) return;
      const scale = Math.min(width, height) * 0.4 / model.extent;
      const boxes: Array<{ x: number; y: number; width: number }> = [];
      labelContext.font = "11px system-ui, sans-serif";
      // Bound both projections and text measurements, irrespective of graph size.
      for (const i of memoryLabelCandidates(model, camera, focus)) {
        const node = model.nodes[i]!, xyz = model.xyz;
        const point = projectMemoryPoint({ x: xyz[i * 3]!, y: xyz[i * 3 + 1]!, z: xyz[i * 3 + 2]! }, camera, scale, width, height);
        const x = point.x + 9, y = point.y;
        if (x < 0 || x > width || y < 14 || y > height - 5) continue;
        const label = node.label.length > 48 ? node.label.slice(0, 45) + "…" : node.label;
        const measured = labelContext.measureText(label).width;
        if (x + measured > width || boxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.width + 5 && x + measured + 5 > box.x)) continue;
        boxes.push({ x, y, width: measured });
        labelContext.fillStyle = "#09111bea"; labelContext.fillRect(x - 3, y - 11, measured + 6, 16);
        labelContext.fillStyle = isMemoryCoreLabel(node.label) ? "#fff0b0" : "#c6dfed"; labelContext.fillText(label, x, y + 1);
      }
    };
    const schedule = () => { if (!animation) animation = requestAnimationFrame(render); };
    redrawRef.current = schedule;
    const resize = () => {
      const rect = canvas.getBoundingClientRect(); width = Math.max(1, rect.width); height = Math.max(1, rect.height);
      const labelDpr = Math.min(window.devicePixelRatio || 1, 2);
      // Dense graph primitives use one device pixel per CSS pixel. Keep labels
      // sharp at the native ratio; small graphs retain their existing resolution.
      const graphDpr = Math.min(labelDpr, current.current.model.nodes.length > 10000 ? 1 : 2);
      canvas.width = Math.round(width * graphDpr); canvas.height = Math.round(height * graphDpr);
      labels.width = Math.round(width * labelDpr); labels.height = Math.round(height * labelDpr);
      labelContext?.setTransform(labelDpr, 0, 0, labelDpr, 0, 0);
      rendererRef.current?.resize(width, height); schedule();
    };
    resizeRef.current = resize;
    const activate = () => {
      try {
        rendererRef.current?.dispose(); rendererRef.current = new MemoryWebGLRenderer(gl!);
        rendererRef.current.setModel(current.current.model); setMode("webgl2"); resize();
        const debug = gl!.getExtension("WEBGL_debug_renderer_info");
        gpuName.current = debug ? String(gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl!.getParameter(gl!.RENDERER));
      } catch { rendererRef.current?.dispose(); rendererRef.current = null; setMode("fallback"); }
    };
    const lost = (event: Event) => {
      event.preventDefault(); cancelAnimationFrame(animation); animation = 0;
      benchmarkRun.current = null; setBenchmarkRunning(false); setBenchmarkResult(""); setMode("fallback");
    };
    const visibility = () => {
      if (document.visibilityState === "hidden" && benchmarkRun.current) {
        benchmarkRun.current = null; setBenchmarkRunning(false);
        setBenchmarkResult("Measurement cancelled because the tab became hidden. Keep it visible and run again.");
      }
    };
    canvas.addEventListener("webglcontextlost", lost); canvas.addEventListener("webglcontextrestored", activate);
    document.addEventListener("visibilitychange", visibility);
    activate();
    const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const hit = (x: number, y: number) => rendererRef.current?.pick(x, y) ?? -1;
    const down = (event: PointerEvent) => {
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const p = local(event); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false; hover = -1;
    };
    const move = (event: PointerEvent) => {
      const p = local(event), previous = pointers.get(event.pointerId), camera = cameraRef.current;
      if (previous) {
        if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 1) camera.zoom = Math.max(0.35, Math.min(5, camera.zoom * after / before));
        } else { camera.yaw += (p.x - previous.x) * 0.009; camera.pitch += (p.y - previous.y) * 0.009; }
        pointers.set(event.pointerId, p);
      } else {
        const next = hit(p.x, p.y); canvas.style.cursor = next >= 0 ? "pointer" : "grab";
        if (next === hover) return;
        hover = next;
      }
      schedule();
    };
    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1) { const i = hit(p.x, p.y); if (i >= 0) current.current.onSelectNode(current.current.model.nodes[i]!.id); }
      pointers.delete(event.pointerId); if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const leave = () => {
      if (pointers.size) return;
      hover = -1; canvas.style.cursor = "grab"; schedule();
    };
    const wheel = (event: WheelEvent) => { event.preventDefault(); cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))); schedule(); };
    const key = (event: KeyboardEvent) => {
      const camera = cameraRef.current;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "_"].includes(event.key)) {
        event.preventDefault(); camera.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        camera.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0;
        if (["+", "=", "-", "_"].includes(event.key)) camera.zoom = Math.max(0.35, Math.min(5, camera.zoom * (["+", "="].includes(event.key) ? 1.1 : 1 / 1.1)));
        schedule();
      } else if (event.key === "Enter") {
        const { model, selectedNodeId, onSelectNode } = current.current;
        const node = model.nodes[model.index.get(selectedNodeId ?? "") ?? model.nodes.findIndex(node => isMemoryCoreLabel(node.label))];
        if (node) onSelectNode(node.id);
      }
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas);
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    return () => {
      observer.disconnect(); cancelAnimationFrame(animation); redrawRef.current = () => {}; resizeRef.current = () => {};
      canvas.removeEventListener("webglcontextlost", lost); canvas.removeEventListener("webglcontextrestored", activate);
      document.removeEventListener("visibilitychange", visibility);
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key);
      rendererRef.current?.dispose(); rendererRef.current = null;
      contextLossRef.current = null;
    };
  }, []);

  const benchmark = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !rendererRef.current || benchmarkRun.current) return;
    setBenchmarkRunning(true); setBenchmarkResult(""); setBenchmarkProgress(0);
    benchmarkRun.current = new MemoryBenchmarkSession({ nodes: model.nodes.length, edges: model.edgeKinds.length, renderer: gpuName.current, viewport: [rect.width, rect.height], dpr: canvasRef.current!.width / rect.width,
      devicePixelRatio: window.devicePixelRatio || 1, labelPixelRatio: labelsRef.current!.width / rect.width,
      loadLongTasksMs: [] }, result => setBenchmarkResult(JSON.stringify({ ...result,
        loadLongTasksMs: longTasks.current.filter(task => task.start >= loadStarted.current && task.start <= loadFinished.current).map(task => task.duration)
      }, null, 2)), setBenchmarkProgress);
    redrawRef.current();
  };

  return <>
    <div className="memory-3d-surface" hidden={mode === "fallback"} data-renderer={mode}>
      <canvas ref={canvasRef} tabIndex={mode === "fallback" ? -1 : 0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll, pinch or use plus and minus to zoom. Click a node to open."
        aria-busy={loading} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} />
      <canvas ref={labelsRef} className="memory-3d-labels" aria-hidden="true" />
      <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    </div>
    {mode === "fallback" ? <>
      <MemoryGraphCanvas3D {...props} {...fallback} />
      <p className="memory-3d-fallback-status" role="status">Graphics acceleration unavailable. Showing {fallback.nodes.length.toLocaleString("en-US")} of {nodes.length.toLocaleString("en-US")} nodes.</p>
    </> : null}
    {props.benchmark ? <aside className="memory-3d-benchmark" aria-label="3D performance benchmark">
      <button type="button" disabled={loading || mode !== "webgl2" || benchmarkRunning} onClick={benchmark}>{benchmarkRunning ? "Measuring 300 frames…" : "Benchmark 3D (300 frames)"}</button>
      <button type="button" disabled={mode !== "webgl2" || benchmarkRunning} onClick={() => contextLossRef.current?.loseContext()}>Lose WebGL context</button>
      <button type="button" disabled={mode !== "fallback"} onClick={() => contextLossRef.current?.restoreContext()}>Restore WebGL context</button>
      {benchmarkRunning ? <output aria-label="3D benchmark progress">{benchmarkProgress} / 300 · {document.visibilityState}</output> : null}
      {benchmarkResult ? <pre tabIndex={0} aria-label="3D benchmark results">{benchmarkResult}</pre> : null}
    </aside> : null}
  </>;
}
