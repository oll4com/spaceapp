import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import { buildMemoryGpuScene, memoryVisibleLabels, updateMemoryCoordinates, prepareMemoryCoordinates, type PreparedMemoryCoordinates, type MemoryGpuScene } from "./memory-gpu-scene.js";
import { MemoryWebGLRenderer } from "./memory-webgl-renderer.js";
import { MemoryGraphCanvasFallback } from "./MemoryGraphCanvasFallback.js";

type Props = {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number; layoutComplete?: boolean;
};
type BenchmarkMode = "NORMAL_INTERACTION" | "WEBGL_COMPLETION_DIAGNOSTIC";
type Benchmark = {
  mode: BenchmarkMode; frameIntervals: number[]; submissionTimes: number[]; completionTimes: number[]; fenceTimes: number[]; pickTimes: number[];
  frame: number; previous: number; started: number; visibility: DocumentVisibilityState; documentHasFocus: boolean; lostDocumentFocus: boolean; camera: MemoryCamera3D; hover: number; focus: number;
  inputs: Pick<Props, "coordinates" | "showTitles" | "selectedNodeId">;
};
const BENCHMARK_WARMUP = 30, BENCHMARK_SAMPLES = 180;
type PreRedrawBenchmark = { pickTimes: number[]; camera: MemoryCamera3D; started: number };
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;

export function MemoryGraph3D(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null), labelsRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const syncRef = useRef<() => void>(() => {}), resetRef = useRef<() => void>(() => {});
  const benchmarkRef = useRef<(mode: BenchmarkMode) => void>(() => {}), lossRef = useRef<(restore: boolean) => void>(() => {});
  const preRedrawBenchmarkRef = useRef<() => void>(() => {});
  const current = useRef(props); current.current = props;
  const [fallback, setFallback] = useState(false), [preparing, setPreparing] = useState(true);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [reports, setReports] = useState<Partial<Record<BenchmarkMode, string>>>({});
  const [preRedrawRunning, setPreRedrawRunning] = useState(false), [preRedrawReport, setPreRedrawReport] = useState<string | null>(null);
  const benchmarkEnabled = typeof window !== "undefined" && window.location.pathname === "/demo-workspace"
    && new URLSearchParams(window.location.search).get("memoryGraphBenchmark") === "1";
  const volumeRatio = useMemo(() => memory3DVolumeRatio(props.coordinates), [props.coordinates]);
  const fallbackGraph = useMemo(() => {
    if (!fallback) return null;
    const nodes = props.nodes.slice(0, 2000), ids = new Set(nodes.map(node => node.id));
    const edges: MemoryGraphEdge[] = [];
    for (const edge of props.edges) {
      if (ids.has(edge.source) && ids.has(edge.target)) edges.push(edge);
      if (edges.length === 6000) break;
    }
    return { nodes, edges, coordinates: new Map([...props.coordinates].filter(([id]) => ids.has(id))) };
  }, [fallback, props.nodes, props.edges, props.coordinates]);

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    resetRef.current();
  }, [props.resetToken]);
  useEffect(() => {
    const canvas = canvasRef.current, labels = labelsRef.current;
    if (!canvas || !labels) return;
    const labelContext = labels.getContext("2d");
    let renderer: MemoryWebGLRenderer | null = null, scene: MemoryGpuScene | null = null;
    let disposed = false, generation = 0, width = 1, height = 1, dpr = 1, frame = 0, hover = -1;
    let loadedNodes: MemoryGraphNode[] | null = null, loadedEdges: MemoryGraphEdge[] | null = null;
    let loadedColors: Map<string, MemoryAtlasPosition> | null = null, loadedCoordinates: Map<string, MemoryPoint3D> | null = null;
    let coordinateJob: object | null = null, drawnCoordinates: Map<string, MemoryPoint3D> | null = null;
    let pendingPointer: { x: number; y: number } | null = null;
    let benchmark: Benchmark | null = null, lossExtension: WEBGL_lose_context | null = null;
    let preRedrawBenchmark: PreRedrawBenchmark | null = null;
    let initialLoad: { start: number; settled: number | null } | null = null;
    const longTasks: Array<{ start: number; duration: number }> = [];
    let longTaskObserver: PerformanceObserver | null = null;
    if (benchmarkEnabled && typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      longTaskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration });
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
    }
    const stopPreRedrawBenchmark = (restoreCamera = true) => {
      if (!preRedrawBenchmark) return;
      if (restoreCamera) cameraRef.current = { ...preRedrawBenchmark.camera };
      preRedrawBenchmark = null; setPreRedrawRunning(false); setBenchmarkRunning(false);
    };
    const stopBenchmark = (restoreCamera = true) => {
      if (!benchmark) return;
      if (restoreCamera) cameraRef.current = { ...benchmark.camera };
      hover = benchmark.hover; pendingPointer = null; benchmark = null;
      setBenchmarkRunning(false); schedule();
    };
    const draw = () => {
      if (!renderer || !scene) return;
      const selected = current.current.selectedNodeId;
      const focus = benchmark ? benchmark.focus : hover >= 0 ? hover : selected ? scene.index.get(selected) ?? -1 : -1;
      renderer.draw(cameraRef.current, focus);
      if (labelContext) {
        labelContext.clearRect(0, 0, width, height);
        if (current.current.showTitles) {
          labelContext.font = "11px system-ui, sans-serif";
          for (const label of memoryVisibleLabels(scene, cameraRef.current, width, height, focus, text => labelContext.measureText(text).width)) {
            labelContext.fillStyle = "#09111bea"; labelContext.fillRect(label.x - 3, label.y - 11, label.width + 6, 16);
            labelContext.fillStyle = label.core ? "#fff0b0" : "#c6dfed"; labelContext.fillText(label.text, label.x, label.y + 1);
          }
        }
      }
      drawnCoordinates = loadedCoordinates;
      if (!coordinateJob && loadedCoordinates === current.current.coordinates) setPreparing(false);
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
      canvas.dataset.nodeCount = String(scene.nodes.length);
      canvas.dataset.edgeCount = String(scene.edgeCount);
      if (initialLoad && initialLoad.settled === null && !current.current.loading && current.current.layoutComplete !== false
        && loadedCoordinates === current.current.coordinates && loadedNodes === current.current.nodes && loadedColors === current.current.positions) {
        initialLoad.settled = performance.now(); // Bound initial load before later interaction or diagnostics.
      }
    };
    const render = (time: number) => {
      frame = 0;
      if (disposed) return;
      const preRedraw = preRedrawBenchmark;
      if (preRedraw && renderer && scene) {
        const sample = preRedraw.pickTimes.length + 1;
        cameraRef.current = { ...preRedraw.camera, yaw: preRedraw.camera.yaw + sample * 0.007, pitch: preRedraw.camera.pitch + sample * 0.003 };
        // Input still targets the displayed frame while this camera change awaits draw.
        const started = performance.now();
        renderer.pick(width * (0.2 + (sample % 7) * 0.1), height * (0.2 + (sample % 5) * 0.15));
        preRedraw.pickTimes.push(performance.now() - started);
        draw();
        if (sample === 20) {
          const gl = renderer.gl, debug = gl.getExtension("WEBGL_debug_renderer_info");
          setPreRedrawReport(JSON.stringify({
            mode: "DISPLAYED_FRAME_PICK_WITH_PENDING_CAMERA", recordedAt: new Date().toISOString(), userAgent: navigator.userAgent,
            hardwareConcurrency: navigator.hardwareConcurrency,
            gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
            viewport: { width, height, dpr }, nodes: scene.nodes.length, edges: scene.edgeCount,
            samples: sample, displayedFramePickP95Ms: percentile(preRedraw.pickTimes, 0.95),
            displayedFramePickMaxMs: Math.max(...preRedraw.pickTimes), displayedFramePickingMs: preRedraw.pickTimes,
            originalCamera: preRedraw.camera, cameraStep: { yaw: 0.007, pitch: 0.003 },
            note: "One pick per animation frame, with a small camera change pending before redraw. Input queries the index of the last displayed frame; rebuilding happens only in draw and is not part of picking. No warm-up samples are discarded. These samples are separate from the steady-state benchmark; the original camera is restored afterward."
          }, null, 2));
          stopPreRedrawBenchmark();
        }
        schedule(); // Also redraw the restored camera after the final sample.
        return;
      }
      if (!benchmark && pendingPointer && renderer && scene) {
        hover = renderer.pick(pendingPointer.x, pendingPointer.y);
        canvas.style.cursor = hover >= 0 ? "pointer" : "grab"; pendingPointer = null;
      }
      const run = benchmark;
      if (!run || !renderer || !scene) { draw(); return; }
      // An interval follows its draw. The trailing callback captures the final draw's
      // interval without adding an extra measured draw or the last warm-up interval.
      if (run.frame > BENCHMARK_WARMUP) run.frameIntervals.push(time - run.previous);
      if (run.frame === BENCHMARK_WARMUP + BENCHMARK_SAMPLES) {
        const ended = performance.now(), gl = renderer.gl, debug = gl.getExtension("WEBGL_debug_renderer_info");
        for (const entry of longTaskObserver?.takeRecords() ?? []) longTasks.push({ start: entry.startTime, duration: entry.duration });
        const overlapping = (start: number, end: number) => longTasks.filter(task => task.start < end && task.start + task.duration > start);
        const interactionTasks = overlapping(run.started, ended);
        const load = initialLoad;
        const loadTasks = load && load.settled !== null ? overlapping(load.start, load.settled) : null;
        const result = JSON.stringify({
          schemaVersion: 2, mode: run.mode, recordedAt: new Date().toISOString(), userAgent: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency,
          gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          contextAttributes: gl.getContextAttributes(),
          viewport: { width, height, dpr }, nodes: scene.nodes.length, edges: scene.edgeCount,
          warmupFrames: BENCHMARK_WARMUP, samples: run.submissionTimes.length, titles: run.inputs.showTitles,
          initialCamera: DEFAULT_MEMORY_CAMERA, initialFocus: -1,
          trajectory: { yawStep: 0.012, pitchAmplitude: 0.4, pitchStep: 0.025, zoomCenter: 1.4, zoomAmplitude: 0.8, zoomStep: 0.03 },
          rafIntervalP95Ms: percentile(run.frameIntervals, 0.95), cpuWorkAndSubmissionP95Ms: percentile(run.submissionTimes, 0.95),
          rafIntervalsMs: run.frameIntervals, cpuWorkAndSubmissionMs: run.submissionTimes,
          ...(run.mode === "WEBGL_COMPLETION_DIAGNOSTIC" ? {
            webglCompletedDrawP95Ms: percentile(run.completionTimes, 0.95), webglCompletedDrawMs: run.completionTimes,
            webglFenceWaitP95Ms: percentile(run.fenceTimes, 0.95), webglFenceWaitMs: run.fenceTimes,
          } : {}),
          pickP95Ms: percentile(run.pickTimes, 0.95), pickMaxMs: Math.max(0, ...run.pickTimes), pickingMs: run.pickTimes,
          benchmarkStartMs: run.started, benchmarkEndMs: ended,
          visibilityAtStart: run.visibility, visibilityAtEnd: document.visibilityState,
          documentHasFocusAtStart: run.documentHasFocus, documentHasFocusAtEnd: document.hasFocus(), lostDocumentFocus: run.lostDocumentFocus,
          longTaskApiSupported: longTaskObserver !== null,
          maxInteractionLongTaskMs: longTaskObserver ? Math.max(0, ...interactionTasks.map(task => task.duration)) : null,
          interactionLongTasks: longTaskObserver ? interactionTasks : null,
          initialLoad: load && loadTasks ? {
            startMs: load.start, settledAtMs: load.settled,
            maxLongTaskMs: longTaskObserver ? Math.max(0, ...loadTasks.map(task => task.duration)) : null,
            longTasks: longTaskObserver ? loadTasks : null,
          } : null,
          note: "RAF intervals measure foreground callback pacing, not proof that every frame was presented. CPU work/submission includes camera-index rebuilding and 2D label drawing calls; it is not GPU time. Only WEBGL_COMPLETION_DIAGNOSTIC waits for WebGL completion after each draw; its completed-draw duration also includes CPU work and does not separately fence the 2D label surface. NORMAL_INTERACTION uses the production draw path without a completion fence. Picking queries the last displayed-frame index. Initial-load tasks overlap the graph-load mark through the first settled draw; later diagnostics are excluded from that window. No network/provider is used by the demo."
        }, null, 2);
        setReports(previous => ({ ...previous, [run.mode]: result }));
        stopBenchmark();
        return;
      }
      cameraRef.current = {
        yaw: DEFAULT_MEMORY_CAMERA.yaw + 0.012 * (run.frame + 1),
        pitch: Math.sin(run.frame * 0.025) * 0.4,
        zoom: 1.4 + 0.8 * Math.sin(run.frame * 0.03),
      };
      const started = performance.now(); draw();
      const submitted = performance.now();
      if (run.mode === "WEBGL_COMPLETION_DIAGNOSTIC") renderer.finish();
      const completed = performance.now();
      if (run.frame >= BENCHMARK_WARMUP) {
        run.submissionTimes.push(submitted - started);
        if (run.mode === "WEBGL_COMPLETION_DIAGNOSTIC") {
          run.completionTimes.push(completed - started); run.fenceTimes.push(completed - submitted);
        }
        const pickStart = performance.now();
        run.focus = renderer.pick(width * (0.2 + (run.frame % 7) * 0.1), height * (0.2 + (run.frame % 5) * 0.15));
        run.pickTimes.push(performance.now() - pickStart);
      }
      run.previous = time; run.frame++; schedule();
    };
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(render); };
    const updateCoordinates = (target: MemoryGpuScene, activeRenderer: MemoryWebGLRenderer, version: number, install = false) => {
      const coordinates = current.current.coordinates, job = {};
      coordinateJob = job; setPreparing(true);
      const cancelled = () => disposed || version !== generation || activeRenderer !== renderer || coordinateJob !== job;
      const publish = (prepared: PreparedMemoryCoordinates | null) => {
        if (cancelled()) return;
        coordinateJob = null;
        if (prepared) { target.coordinates = prepared.coordinates; target.extent = prepared.extent; }
        loadedCoordinates = coordinates;
        if (install) { scene = target; hover = -1; activeRenderer.setScene(target); }
        else activeRenderer.updateCoordinates();
        schedule();
        // Finish the current snapshot, then take only the newest one. Repeated
        // worker updates must neither starve publication nor drop the final Map.
        sync();
      };
      if (target.nodes.length <= 2048) {
        updateMemoryCoordinates(target, coordinates); publish(null);
      } else {
        void prepareMemoryCoordinates(target, coordinates, cancelled).then(prepared => {
          if (prepared) publish(prepared);
        }).catch(() => { if (!cancelled()) useFallback(); });
      }
    };
    const sync = () => {
      const activeRenderer = renderer;
      if (!activeRenderer || disposed) return;
      const data = current.current;
      if (benchmark && (benchmark.inputs.coordinates !== data.coordinates || benchmark.inputs.showTitles !== data.showTitles
        || benchmark.inputs.selectedNodeId !== data.selectedNodeId || data.loading || data.layoutComplete === false)) stopBenchmark();
      if (loadedNodes !== data.nodes || loadedEdges !== data.edges || loadedColors !== data.positions) {
        loadedNodes = data.nodes; loadedEdges = data.edges; loadedColors = data.positions;
        const version = ++generation;
        // A result must describe one graph, never samples from before and after a reload.
        stopPreRedrawBenchmark(); setPreRedrawReport(null);
        stopBenchmark(); setReports({});
        const loadStart = benchmarkEnabled ? performance.getEntriesByName("memory-graph-load-start").at(-1)?.startTime : undefined;
        if (loadStart !== undefined && initialLoad?.start !== loadStart) initialLoad = { start: loadStart, settled: null };
        scene = null; loadedCoordinates = null; drawnCoordinates = null; coordinateJob = null; hover = -1;
        setPreparing(true);
        void buildMemoryGpuScene(data.nodes, data.edges, data.positions, data.coordinates, () => disposed || version !== generation)
          .then(next => {
            if (!next || disposed || version !== generation || activeRenderer !== renderer) return;
            updateCoordinates(next, activeRenderer, version, true);
          }).catch(() => { if (!disposed && version === generation) useFallback(); });
      } else if (scene && loadedCoordinates !== data.coordinates) {
        stopPreRedrawBenchmark(); setPreRedrawReport(null);
        if (!coordinateJob) updateCoordinates(scene, activeRenderer, generation);
        else schedule();
      } else schedule();
    };
    const resize = () => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      if (width !== Math.max(1, rect.width) || height !== Math.max(1, rect.height) || dpr !== Math.min(window.devicePixelRatio || 1, 2)) {
        stopPreRedrawBenchmark(); stopBenchmark();
      }
      width = Math.max(1, rect.width); height = Math.max(1, rect.height); dpr = Math.min(window.devicePixelRatio || 1, 2);
      renderer?.resize(width, height, dpr);
      labels.width = Math.round(width * dpr); labels.height = Math.round(height * dpr);
      labelContext?.setTransform(dpr, 0, 0, dpr, 0, 0); schedule();
    };
    const useFallback = () => {
      stopPreRedrawBenchmark(); setPreRedrawReport(null); stopBenchmark();
      generation++; coordinateJob = null; drawnCoordinates = null; renderer?.dispose(); renderer = null; scene = null;
      loadedNodes = null; loadedCoordinates = null; benchmark = null;
      setBenchmarkRunning(false); setPreparing(false); setFallback(true);
      labelContext?.clearRect(0, 0, width, height);
    };
    const initialize = () => {
      try {
        renderer = new MemoryWebGLRenderer(canvas);
        lossExtension = renderer.gl.getExtension("WEBGL_lose_context");
        setFallback(false); resize(); sync();
      } catch { useFallback(); }
    };
    const lost = (event: Event) => { event.preventDefault(); useFallback(); };
    const restored = () => { if (!disposed) initialize(); };
    canvas.addEventListener("webglcontextlost", lost); canvas.addEventListener("webglcontextrestored", restored);
    syncRef.current = sync; resetRef.current = () => { stopPreRedrawBenchmark(false); stopBenchmark(false); schedule(); };
    benchmarkRef.current = mode => {
      if (!renderer || !scene || coordinateJob || loadedCoordinates !== current.current.coordinates || drawnCoordinates !== loadedCoordinates
        || benchmark || preRedrawBenchmark || current.current.loading || current.current.layoutComplete === false || document.visibilityState === "hidden") return;
      benchmark = { mode, frameIntervals: [], submissionTimes: [], completionTimes: [], fenceTimes: [], pickTimes: [],
        frame: 0, previous: 0, started: performance.now(), visibility: document.visibilityState,
        documentHasFocus: document.hasFocus(), lostDocumentFocus: false, camera: { ...cameraRef.current }, hover, focus: -1,
        inputs: { coordinates: current.current.coordinates, showTitles: current.current.showTitles, selectedNodeId: current.current.selectedNodeId } };
      cameraRef.current = { ...DEFAULT_MEMORY_CAMERA }; pendingPointer = null;
      setReports(previous => ({ ...previous, [mode]: undefined })); setBenchmarkRunning(true); schedule();
    };
    preRedrawBenchmarkRef.current = () => {
      if (!renderer || !scene || coordinateJob || loadedCoordinates !== current.current.coordinates || drawnCoordinates !== loadedCoordinates
        || benchmark || preRedrawBenchmark || current.current.loading || current.current.layoutComplete === false) return;
      preRedrawBenchmark = { pickTimes: [], camera: { ...cameraRef.current }, started: performance.now() };
      pendingPointer = null; setPreRedrawReport(null); setPreRedrawRunning(true); setBenchmarkRunning(true); schedule();
    };
    lossRef.current = restore => { if (restore) lossExtension?.restoreContext(); else lossExtension?.loseContext(); };
    initialize();
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;
    const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const down = (event: PointerEvent) => {
      stopPreRedrawBenchmark(); stopBenchmark();
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const p = local(event);
      if (!pointers.size) { downX = p.x; downY = p.y; dragged = false; }
      else dragged = true;
      pointers.set(event.pointerId, p); hover = -1; pendingPointer = null;
    };
    const move = (event: PointerEvent) => {
      if (preRedrawBenchmark || benchmark) return;
      const p = local(event), previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
        } else { cameraRef.current.yaw += (p.x - previous.x) * 0.009; cameraRef.current.pitch += (p.y - previous.y) * 0.009; }
        pointers.set(event.pointerId, p);
      } else { pendingPointer = p; }
      schedule();
    };
    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1 && renderer && scene) {
        const index = renderer.pick(p.x, p.y), node = scene.nodes[index];
        if (node) current.current.onSelectNode(node.id);
      }
      pointers.delete(event.pointerId); if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const leave = () => { if (!benchmark && !preRedrawBenchmark && !pointers.size) { hover = -1; pendingPointer = null; schedule(); } };
    const wheel = (event: WheelEvent) => { event.preventDefault(); stopPreRedrawBenchmark(); stopBenchmark(); cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))); schedule(); };
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "_", "Enter"].includes(event.key)) { stopPreRedrawBenchmark(); stopBenchmark(); }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0; schedule();
      } else if (["+", "=", "-", "_"].includes(event.key)) {
        event.preventDefault(); cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * (["+", "="].includes(event.key) ? 1.15 : 1 / 1.15))); schedule();
      } else if (event.key === "Enter") {
        const node = current.current.nodes.find(node => node.id === current.current.selectedNodeId) ?? current.current.nodes.find(node => isMemoryCoreLabel(node.label));
        if (node) current.current.onSelectNode(node.id);
      }
    };
    const visibilityChanged = () => { if (document.visibilityState === "hidden") { stopPreRedrawBenchmark(); stopBenchmark(); } };
    const focusLost = () => { if (benchmark) benchmark.lostDocumentFocus = true; };
    document.addEventListener("visibilitychange", visibilityChanged); window.addEventListener("blur", focusLost);
    const observer = new ResizeObserver(resize); observer.observe(canvas.parentElement!);
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("pointerleave", leave); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    return () => {
      if (preRedrawBenchmark) cameraRef.current = { ...preRedrawBenchmark.camera };
      preRedrawBenchmark = null;
      if (benchmark) cameraRef.current = { ...benchmark.camera };
      benchmark = null;
      document.removeEventListener("visibilitychange", visibilityChanged); window.removeEventListener("blur", focusLost);
      disposed = true; generation++; cancelAnimationFrame(frame); observer.disconnect(); longTaskObserver?.disconnect(); renderer?.dispose();
      syncRef.current = () => {}; resetRef.current = () => {}; benchmarkRef.current = () => {}; lossRef.current = () => {};
      preRedrawBenchmarkRef.current = () => {};
      canvas.removeEventListener("webglcontextlost", lost); canvas.removeEventListener("webglcontextrestored", restored);
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("pointerleave", leave); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key);
    };
  }, [benchmarkEnabled]);
  useEffect(() => { syncRef.current(); }, [props.nodes, props.edges, props.positions, props.coordinates, props.showTitles, props.selectedNodeId, props.loading, props.layoutComplete]);
  return <>
    <div className="memory-3d-surface" data-renderer={fallback ? "canvas2d" : "webgl2"}>
      <canvas ref={canvasRef} hidden={fallback} tabIndex={fallback ? -1 : 0} role="application" aria-hidden={fallback}
        aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll, pinch, or press plus/minus to zoom. Click a node to open."
        aria-busy={props.loading || preparing} data-titles-visible={props.showTitles} data-layout-volume={volumeRatio.toFixed(4)} />
      <canvas ref={labelsRef} hidden={fallback} className="memory-3d-labels" aria-hidden="true" />
      {!fallback && <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>}
    </div>
    {fallbackGraph && <><MemoryGraphCanvasFallback {...props} {...fallbackGraph} /><span className="memory-3d-fallback" role="status">Canvas view · showing up to 2,000 nodes while WebGL2 is unavailable</span></>}
    {benchmarkEnabled && <div className="memory-3d-benchmark">
      <button type="button" onClick={() => benchmarkRef.current("NORMAL_INTERACTION")} disabled={fallback || preparing || props.loading || props.layoutComplete === false || benchmarkRunning}>Run graph benchmark</button>
      <button type="button" onClick={() => benchmarkRef.current("WEBGL_COMPLETION_DIAGNOSTIC")} disabled={fallback || preparing || props.loading || props.layoutComplete === false || benchmarkRunning}>Measure WebGL completion</button>
      <button type="button" onClick={() => preRedrawBenchmarkRef.current()} disabled={fallback || preparing || props.loading || props.layoutComplete === false || benchmarkRunning}>Measure picks before redraw</button>
      <button type="button" onClick={() => lossRef.current(fallback)}>{fallback ? "Restore WebGL context" : "Test context loss"}</button>
      {benchmarkRunning && <span role="status">{preRedrawRunning ? "Measuring picks after camera changes, before redraw…" : "Measuring rotation, zoom and picking…"}</span>}
      {!benchmarkRunning && reports.NORMAL_INTERACTION && <pre aria-label="Graph benchmark results">{reports.NORMAL_INTERACTION}</pre>}
      {!benchmarkRunning && reports.WEBGL_COMPLETION_DIAGNOSTIC && <pre aria-label="WebGL completion diagnostic results">{reports.WEBGL_COMPLETION_DIAGNOSTIC}</pre>}
      {!benchmarkRunning && preRedrawReport && <pre aria-label="Picking before redraw results">{preRedrawReport}</pre>}
    </div>}
  </>;
}
