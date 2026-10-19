import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { findPackedText, packedText, prepareMemoryGraph, type PackedMemoryGraph } from "./memory-3d-buffers.js";
import { paintMemoryGraphCanvas } from "./memory-3d-canvas.js";
import { chooseMemoryGraphRenderer, openMemoryGraphGL, type MemoryGraphGLClient } from "./memory-3d-gl-client.js";
import { MAX_LABEL_CANDIDATES, selectMemoryLabels } from "./memory-3d-labels.js";
import {
  DEFAULT_MEMORY_CAMERA,
  memory3DExtent,
  memory3DVolumeRatio,
  projectMemoryPoint,
  type MemoryCamera3D,
  type MemoryPoint3D
} from "./memory-3d.js";
import { canvasFallbackEdgeIndexes, canvasFallbackIndexes, createProjectedMemoryNodes, projectMemoryNodes, SpatialPickIndex } from "./memory-3d-pick.js";

export interface MemoryGraph3DHandle {
  applyPacked(packed: PackedMemoryGraph): void;
  applyPositions(xyz: Float32Array, done: boolean): void;
}

export interface MemoryGraphFrameSample {
  status: "done";
  nodes: number;
  edges: number;
  renderer: "webgl2" | "canvas2d";
  hardwareRenderer: string;
  frames: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

declare global {
  interface Window {
    __spaceMemoryBenchmark?: MemoryGraphFrameSample | { status: "running" | "error" | "waiting"; message?: string };
    __spaceMemoryFrameSamples?: number[];
    __spaceMemoryLongTaskMs?: number;
    __spaceMemoryFrames?: number;
    __spaceMemorySplit?: { preparedMs: number; drawMs: number; labelMs: number; nodes: number; edges: number };
    __spaceMemoryUploadMs?: number;
    __spaceMemoryHandlerMs?: number;
    __spaceMemoryPositionMs?: number;
    __spaceMemoryWarmMs?: number;
    __spaceMemoryGLError?: string;
    __spaceMemoryDraw?: { ms: number; drew: boolean; count: number; uploaded: number; bufferWidth: number; bufferHeight: number; gpuMs: number | null; gpuNanos: number; wallMs: number };
    __spaceMemorySampling?: boolean;
    __spaceMemoryLongTask?: { duration: number; startTime: number; name: string; attribution?: Array<{ name: string; containerType: string; containerName: string; containerSrc: string }> };
    __spaceMemoryLongTasks?: Array<{ duration: number; startTime: number; name: string; attribution?: Array<{ name: string; containerType: string; containerName: string; containerSrc: string }> }>;
    __spaceMemoryMarks?: Array<[string, number]>;
    __spaceMemoryLongFrames?: Array<{ duration: number; startTime: number; scripts: Array<{ source: string; duration: number; invoker: string; name: string }> }>;
  }
}

const CANVAS_LABEL = "3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open.";

export const MemoryGraph3D = forwardRef<MemoryGraph3DHandle, {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>;
  coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  loading: boolean;
  resetToken: number;
  layoutDone?: boolean;
  benchmark?: boolean;
  stream?: PackedMemoryGraph | null;
}>(function MemoryGraph3D(props, ref) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const fallbackRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const propsRef = useRef(props);
  propsRef.current = props;
  const packedRef = useRef<PackedMemoryGraph | null>(props.stream ?? null);
  const rendererRef = useRef<MemoryGraphGLClient | null>(null);
  const modeRef = useRef<"webgl2" | "canvas2d">("canvas2d");
  const redrawRef = useRef<() => void>(() => {});
  const refreshLabelsRef = useRef<() => void>(() => {});
  const sampleRef = useRef<(() => Promise<MemoryGraphFrameSample>) | null>(null);
  const samplingRef = useRef(false);
  const projectedRef = useRef(createProjectedMemoryNodes(0));
  const pickRef = useRef(new SpatialPickIndex());
  const pickDirtyRef = useRef(true);
  const labelIndexesRef = useRef<number[]>([]);
  const hoverRef = useRef(-1);
  const focusRef = useRef(-1);
  const fallbackIndexesRef = useRef<Uint32Array>(new Uint32Array());
  const fallbackEdgesRef = useRef<Uint32Array>(new Uint32Array());
  const pumpRef = useRef<() => void>(() => {});
  const glBootRef = useRef<Promise<MemoryGraphGLClient | null> | null>(null);
  const glEpochRef = useRef(0);
  const glActiveRef = useRef(0);
  const glFailedRef = useRef(false);

  const syncFocus = (index: number) => {
    focusRef.current = index;
    rendererRef.current?.setFocus(index);
    refreshLabelsRef.current();
    redrawRef.current();
  };

  useImperativeHandle(ref, () => ({
    applyPacked(packed) {
      packedRef.current = packed;
      fallbackIndexesRef.current = canvasFallbackIndexes(packed.kinds);
      fallbackEdgesRef.current = canvasFallbackEdgeIndexes(packed.edgePairs, fallbackIndexesRef.current, packed.count);
      pickDirtyRef.current = true;
      rendererRef.current?.setGraph(packed);
      pumpRef.current();
      const selected = propsRef.current.selectedNodeId
        ? findPackedText(packed.ids, packed.idOffsets, propsRef.current.selectedNodeId)
        : -1;
      syncFocus(selected);
      refreshLabelsRef.current();
      redrawRef.current();
    },
    applyPositions(xyz, done) {
      const packed = packedRef.current;
      if (!packed) return;
      packed.xyz = xyz;
      pickDirtyRef.current = true;
      rendererRef.current?.setPositions(xyz);
      pumpRef.current();
      if (done) refreshLabelsRef.current();
      redrawRef.current();
      if (done && propsRef.current.benchmark && !samplingRef.current) {
        samplingRef.current = true;
        void sampleRef.current?.();
      }
    }
  }), []);

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    pickDirtyRef.current = true;
    refreshLabelsRef.current();
    redrawRef.current();
  }, [props.resetToken]);

  useEffect(() => {
    const surface = surfaceRef.current;
    const glCanvas = glCanvasRef.current;
    const overlay = overlayRef.current;
    const fallback = fallbackRef.current;
    if (!surface || !glCanvas || !overlay || !fallback) return;
    const epoch = ++glEpochRef.current;
    glActiveRef.current = epoch;
    const setMode = (next: "webgl2" | "canvas2d") => {
      if (modeRef.current !== next) pickDirtyRef.current = true;
      modeRef.current = next;
      glCanvas.hidden = next !== "webgl2";
      fallback.hidden = next !== "canvas2d";
      overlay.hidden = next !== "webgl2";
      const active = next === "webgl2" ? glCanvas : fallback;
      const inactive = next === "webgl2" ? fallback : glCanvas;
      active.tabIndex = 0;
      active.setAttribute("role", "application");
      active.setAttribute("aria-label", CANVAS_LABEL);
      inactive.removeAttribute("role");
      inactive.removeAttribute("aria-label");
      inactive.tabIndex = -1;
      surface.dataset.renderer = next;
    };
    if (!glBootRef.current) {
      glBootRef.current = openMemoryGraphGL(glCanvas, window.devicePixelRatio || 1, {
        onLost: () => {
          setMode("canvas2d");
          redrawRef.current();
        },
        onRestored: () => {
          const packed = packedRef.current;
          if (packed) rendererRef.current?.setGraph(packed);
          rendererRef.current?.setFocus(focusRef.current);
          setMode("webgl2");
          refreshLabelsRef.current();
          redrawRef.current();
        }
      });
    }
    void glBootRef.current.then(renderer => {
      if (glActiveRef.current !== epoch) return;
      rendererRef.current = renderer;
      glFailedRef.current = !renderer;
      setMode(chooseMemoryGraphRenderer({ webgl2: Boolean(renderer), contextLost: false }));
      if (renderer && packedRef.current) renderer.setGraph(packedRef.current);
      redrawRef.current();
    });
    let frame = 0;
    let width = 1;
    let height = 1;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false;
    let downX = 0;
    let downY = 0;
    let labelZoomBand = cameraRef.current.zoom >= 1.6;
    let wheelTimer = 0;
    const activeCanvas = () => modeRef.current === "webgl2" ? glCanvas : fallback;
    const resizeCanvases = () => {
      const rect = surface.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const canvas of [overlay, fallback]) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        const context = canvas.getContext("2d");
        context?.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };
    const projectPacked = () => {
      const packed = packedRef.current;
      if (!packed) return null;
      if (projectedRef.current.count !== packed.count) projectedRef.current = createProjectedMemoryNodes(packed.count);
      const extent = memory3DExtent(packed.xyz);
      const scale = Math.min(width, height) * 0.4 / extent;
      projectMemoryNodes(packed.xyz, packed.radii, cameraRef.current, scale, width, height, projectedRef.current);
      return { packed, scale, extent };
    };
    const rebuildPick = (packed: PackedMemoryGraph) => {
      const allowed = modeRef.current === "canvas2d" ? fallbackIndexesRef.current : undefined;
      pickRef.current.rebuild(projectedRef.current, packed.kinds, allowed);
    };
    const refreshLabels = () => {
      const projected = projectPacked();
      if (!projected) { labelIndexesRef.current = []; return; }
      rebuildPick(projected.packed);
      pickDirtyRef.current = false;
      labelIndexesRef.current = pickRef.current.labelCandidates(width, height, MAX_LABEL_CANDIDATES);
      labelZoomBand = cameraRef.current.zoom >= 1.6;
    };
    refreshLabelsRef.current = refreshLabels;
    const drawLabels = (packed: PackedMemoryGraph) => {
      const context = overlay.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, width, height);
      if (!propsRef.current.showTitles || modeRef.current !== "webgl2") return;
      const extent = memory3DExtent(packed.xyz);
      const scale = Math.min(width, height) * 0.4 / extent;
      context.font = "11px system-ui, sans-serif";
      const labels = selectMemoryLabels({
        showTitles: true,
        zoom: cameraRef.current.zoom,
        focus: focusRef.current,
        width,
        height,
        measure: text => context.measureText(text).width,
        candidates: labelIndexesRef.current.map(index => {
          const cursor = index * 3;
          const screen = projectMemoryPoint({
            x: packed.xyz[cursor] ?? 0,
            y: packed.xyz[cursor + 1] ?? 0,
            z: packed.xyz[cursor + 2] ?? 0
          }, cameraRef.current, scale, width, height);
          return {
            index,
            x: screen.x,
            y: screen.y,
            kind: packed.kinds[index] ?? 0,
            text: packedText(packed.labels, packed.labelOffsets, index)
          };
        })
      });
      for (const label of labels) {
        context.fillStyle = "#09111bea";
        context.fillRect(label.x - 3, label.y - 11, label.width + 6, 16);
        context.fillStyle = (packed.kinds[label.index] ?? 0) === 2 ? "#fff0b0" : "#c6dfed";
        context.fillText(label.text, label.x, label.y + 1);
      }
    };
    const render = (sync = false) => {
      frame = 0;
      const packed = packedRef.current;
      const active = activeCanvas();
      active.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
      active.dataset.titlesVisible = String(propsRef.current.showTitles);
      if (!packed || packed.count === 0) {
        const context = fallback.getContext("2d");
        context?.clearRect(0, 0, width, height);
        overlay.getContext("2d")?.clearRect(0, 0, width, height);
        active.dataset.layoutVolume = "0.0000";
        return;
      }
      const extentStarted = performance.now();
      const extent = memory3DExtent(packed.xyz);
      const scale = Math.min(width, height) * 0.4 / extent;
      active.dataset.layoutVolume = (packed.count < 4 ? 0 : sampleVolume(packed.xyz, packed.count)).toFixed(4);
      const preparedMs = performance.now() - extentStarted;
      if (modeRef.current === "webgl2" && rendererRef.current && !rendererRef.current.contextLost) {
        const drawStarted = performance.now();
        rendererRef.current.render(cameraRef.current, scale, width, height, sync);
        const drawMs = performance.now() - drawStarted;
        const labelStarted = performance.now();
        drawLabels(packed);
        window.__spaceMemorySplit = { preparedMs, drawMs, labelMs: performance.now() - labelStarted, nodes: packed.count, edges: packed.edgeCount };
      } else if (glFailedRef.current || rendererRef.current?.contextLost || !glBootRef.current) {
        const context = fallback.getContext("2d");
        if (context) {
          paintMemoryGraphCanvas(context, packed, fallbackIndexesRef.current, cameraRef.current, scale, width, height, focusRef.current, propsRef.current.showTitles, rendererStates(packed, focusRef.current), fallbackEdgesRef.current);
        }
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => render()); };
    redrawRef.current = schedule;
    const pickAt = (x: number, y: number) => {
      const packed = packedRef.current;
      if (!packed || packed.count === 0) return -1;
      if (pickDirtyRef.current) {
        projectPacked();
        rebuildPick(packed);
        pickDirtyRef.current = false;
      }
      return pickRef.current.find(x, y);
    };
    const local = (event: PointerEvent) => {
      const rect = surface.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const down = (event: PointerEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("button, a, input, select")) return;
      activeCanvas().focus();
      surface.setPointerCapture?.(event.pointerId);
      const point = local(event);
      pointers.set(event.pointerId, point);
      downX = point.x;
      downY = point.y;
      dragged = false;
      hoverRef.current = -1;
    };
    const move = (event: PointerEvent) => {
      const point = local(event);
      const previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(point.x - downX, point.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1];
          if (other) {
            const before = Math.hypot(previous.x - other.x, previous.y - other.y);
            const after = Math.hypot(point.x - other.x, point.y - other.y);
            if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
          }
        } else {
          cameraRef.current.yaw += (point.x - previous.x) * 0.009;
          cameraRef.current.pitch += (point.y - previous.y) * 0.009;
        }
        pointers.set(event.pointerId, point);
        pickDirtyRef.current = true;
      } else if (!dragged && pointers.size === 0) {
        const hit = pickAt(point.x, point.y);
        if (hit !== hoverRef.current) {
          hoverRef.current = hit;
          syncFocus(hit >= 0 ? hit : selectedIndex());
        }
        surface.style.cursor = hit >= 0 ? "pointer" : "grab";
      }
      schedule();
    };
    const selectedIndex = () => {
      const packed = packedRef.current;
      const selected = propsRef.current.selectedNodeId;
      if (!packed || !selected) return -1;
      return findPackedText(packed.ids, packed.idOffsets, selected);
    };
    const up = (event: PointerEvent) => {
      const point = local(event);
      if (!dragged && pointers.size <= 1) {
        const hit = pickAt(point.x, point.y);
        const packed = packedRef.current;
        if (hit >= 0 && packed) propsRef.current.onSelectNode(packedText(packed.ids, packed.idOffsets, hit));
      }
      pointers.delete(event.pointerId);
      if (surface.hasPointerCapture?.(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      if (pointers.size === 0 && dragged) {
        dragged = false;
        refreshLabels();
        schedule();
      }
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001)));
      pickDirtyRef.current = true;
      const nextBand = cameraRef.current.zoom >= 1.6;
      if (nextBand !== labelZoomBand) refreshLabels();
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => { refreshLabels(); schedule(); }, 140);
      schedule();
    };
    const key = (event: KeyboardEvent) => {
      if (event.target !== glCanvas && event.target !== fallback) return;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0;
        pickDirtyRef.current = true;
        schedule();
      } else if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_") {
        event.preventDefault();
        const zoomOut = event.key === "-" || event.key === "_";
        cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * (zoomOut ? 0.9 : 1.1)));
        pickDirtyRef.current = true;
        const nextBand = cameraRef.current.zoom >= 1.6;
        if (nextBand !== labelZoomBand) refreshLabels();
        schedule();
      } else if (event.key === "Enter") {
        const packed = packedRef.current;
        if (!packed) return;
        const selected = selectedIndex();
        const core = selected >= 0 ? selected : findCore(packed);
        if (core >= 0) propsRef.current.onSelectNode(packedText(packed.ids, packed.idOffsets, core));
      }
    };
    sampleRef.current = async () => {
      const samples: number[] = [];
      window.__spaceMemoryBenchmark = { status: "running" };
      const channel = new MessageChannel();
      const yieldFrame = () => new Promise<void>(resolve => {
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      });
      const flushDeadline = performance.now() + 30_000;
      while (performance.now() < flushDeadline) {
        const renderer = rendererRef.current;
        if (renderer?.contextLost) break;
        if (renderer && modeRef.current === "webgl2" && renderer.idle()) break;
        await yieldFrame();
      }
      window.__spaceMemorySampling = true;
      for (let index = 0; index < 100; index++) {
        cameraRef.current.yaw += 0.03;
        cameraRef.current.pitch = Math.sin(index / 18) * 0.25;
        cameraRef.current.zoom = 0.8 + (index % 36) / 30;
        const renderer = rendererRef.current;
        let renderMs = 0;
        if (renderer && modeRef.current === "webgl2" && !renderer.contextLost) {
          const packed = packedRef.current;
          const extent = packed ? memory3DExtent(packed.xyz) : 1;
          const scale = Math.min(width, height) * 0.4 / extent;
          renderMs = await renderer.renderFrame(cameraRef.current, scale, width, height);
        } else {
          const renderStarted = performance.now();
          render(false);
          renderMs = performance.now() - renderStarted;
        }
        if (index >= 10) samples.push(renderMs);
        window.__spaceMemoryFrames = index + 1;
        await yieldFrame();
      }
      window.__spaceMemorySampling = false;
      refreshLabels();
      samples.sort((left, right) => left - right);
      const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
      const packed = packedRef.current;
      const result: MemoryGraphFrameSample = {
        status: "done",
        nodes: packed?.count ?? 0,
        edges: packed?.edgeCount ?? 0,
        renderer: modeRef.current,
        hardwareRenderer: rendererRef.current?.hardwareRenderer || "canvas-2d",
        frames: samples.length,
        p50: samples[Math.floor(samples.length * 0.5)] ?? 0,
        p95: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? 0,
        max: samples[samples.length - 1] ?? 0,
        mean
      };
      window.__spaceMemoryFrameSamples = samples;
      window.__spaceMemoryBenchmark = result;
      return result;
    };
    const observer = new ResizeObserver(() => { resizeCanvases(); pickDirtyRef.current = true; schedule(); });
    observer.observe(surface);
    resizeCanvases();
    refreshLabels();
    schedule();
    surface.addEventListener("pointerdown", down);
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerup", up);
    surface.addEventListener("pointercancel", cancel);
    surface.addEventListener("wheel", wheel, { passive: false });
    surface.addEventListener("keydown", key);
    return () => {
      if (glActiveRef.current === epoch) glActiveRef.current = 0;
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(wheelTimer);
      redrawRef.current = () => {};
      refreshLabelsRef.current = () => {};
      pumpRef.current = () => {};
      const closing = epoch;
      queueMicrotask(() => {
        if (glEpochRef.current !== closing) return;
        void glBootRef.current?.then(renderer => renderer?.dispose());
        glBootRef.current = null;
        rendererRef.current = null;
      });
      surface.removeEventListener("pointerdown", down);
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", up);
      surface.removeEventListener("pointercancel", cancel);
      surface.removeEventListener("wheel", wheel);
      surface.removeEventListener("keydown", key);
    };
  }, []);

  useEffect(() => {
    const packed = packedRef.current;
    if (!packed) return;
    const selected = props.selectedNodeId ? findPackedText(packed.ids, packed.idOffsets, props.selectedNodeId) : -1;
    if (selected !== focusRef.current && hoverRef.current < 0) syncFocus(selected);
    else refreshLabelsRef.current();
    redrawRef.current();
  }, [props.selectedNodeId, props.showTitles, props.loading]);

  useEffect(() => {
    if (!props.benchmark || !props.layoutDone || samplingRef.current) return;
    samplingRef.current = true;
    void sampleRef.current?.();
  }, [props.benchmark, props.layoutDone]);

  useEffect(() => {
    if (!props.stream) {
      if (!packedRef.current && fallbackIndexesRef.current.length === 0) return;
      packedRef.current = null;
      fallbackIndexesRef.current = new Uint32Array();
      fallbackEdgesRef.current = new Uint32Array();
      labelIndexesRef.current = [];
      focusRef.current = -1;
      hoverRef.current = -1;
      pickDirtyRef.current = true;
      rendererRef.current?.clearGraph();
      redrawRef.current();
      return;
    }
    if (props.stream === packedRef.current) return;
    packedRef.current = props.stream;
    fallbackIndexesRef.current = canvasFallbackIndexes(props.stream.kinds);
    fallbackEdgesRef.current = canvasFallbackEdgeIndexes(props.stream.edgePairs, fallbackIndexesRef.current, props.stream.count);
    pickDirtyRef.current = true;
    rendererRef.current?.setGraph(props.stream);
    pumpRef.current();
    refreshLabelsRef.current();
    redrawRef.current();
  }, [props.stream]);

  useEffect(() => {
    if (typeof Worker !== "undefined" || !props.nodes.length || packedRef.current) return;
    const prepared = prepareMemoryGraph(props.nodes, props.edges);
    for (const [id, point] of props.coordinates) {
      const index = findPackedText(prepared.packed.ids, prepared.packed.idOffsets, id);
      if (index < 0) continue;
      prepared.packed.xyz[index * 3] = point.x;
      prepared.packed.xyz[index * 3 + 1] = point.y;
      prepared.packed.xyz[index * 3 + 2] = point.z;
    }
    packedRef.current = prepared.packed;
    fallbackIndexesRef.current = canvasFallbackIndexes(prepared.packed.kinds);
    fallbackEdgesRef.current = canvasFallbackEdgeIndexes(prepared.packed.edgePairs, fallbackIndexesRef.current, prepared.packed.count);
    rendererRef.current?.setGraph(prepared.packed);
    pumpRef.current();
    refreshLabelsRef.current();
    redrawRef.current();
  }, [props.nodes, props.edges, props.coordinates]);

  const mode = modeRef.current;
  return <div ref={surfaceRef} className="memory-3d-surface" data-renderer={mode} tabIndex={-1}>
    <canvas ref={glCanvasRef} tabIndex={0} role="application" aria-label={CANVAS_LABEL} data-titles-visible={props.showTitles} aria-busy={props.loading} />
    <canvas ref={overlayRef} className="memory-3d-overlay" aria-hidden="true" />
    <canvas ref={fallbackRef} hidden data-titles-visible={props.showTitles} aria-busy={props.loading} />
    <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
  </div>;
});

function findCore(packed: PackedMemoryGraph) {
  for (let index = 0; index < packed.count; index++) if ((packed.kinds[index] ?? 0) === 2) return index;
  return packed.count ? 0 : -1;
}

function sampleVolume(xyz: Float32Array, count: number) {
  const stride = Math.max(1, Math.floor(count / 256));
  const points = [];
  for (let index = 0; index < count; index += stride) {
    points.push({ x: xyz[index * 3] ?? 0, y: xyz[index * 3 + 1] ?? 0, z: xyz[index * 3 + 2] ?? 0 });
  }
  return memory3DVolumeRatio(points);
}

function rendererStates(packed: PackedMemoryGraph, focus: number) {
  const states = new Uint8Array(packed.count);
  if (focus < 0) return states;
  states[focus] = 2;
  for (let cursor = 0; cursor < packed.edgePairs.length; cursor += 2) {
    const source = packed.edgePairs[cursor] ?? -1;
    const target = packed.edgePairs[cursor + 1] ?? -1;
    if (source === focus && target >= 0 && states[target] === 0) states[target] = 1;
    else if (target === focus && source >= 0 && states[source] === 0) states[source] = 1;
  }
  return states;
}
