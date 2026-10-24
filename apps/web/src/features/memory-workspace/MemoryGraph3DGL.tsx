import { useEffect, useRef, type MutableRefObject } from "react";
import { DEFAULT_MEMORY_CAMERA, type MemoryCamera3D } from "./memory-3d.js";
import { attachCameraControls, clampZoom, makeProjection } from "./memory-camera.js";
import { benchmarkCamera, summarizeFrameTimes, type FrameStats } from "./memory-frame-stats.js";
import { MemoryGLRenderer } from "./memory-gl-renderer.js";
import { createTextMeasurer, labelPriority, selectLabels } from "./memory-labels.js";
import { renderKindsOf, ScreenPicker } from "./memory-picking.js";
import { FLAG_CORE, type MemoryScene } from "./memory-scene.js";
import type { MemorySceneStream } from "./memory-layout-stream.js";
import { memory3DCanvasProps } from "./memory-3d-canvas-props.js";

export interface MemoryGLStatus { failed: boolean; lost: boolean }
export interface MemoryGLBenchmarkApi {
  /** `raf`: requestAnimationFrame deltas (capped by the display refresh). `work`: CPU submit plus GPU completion per frame, no vsync. */
  runBenchmark(frames?: number): Promise<{ raf: FrameStats; work: FrameStats }>;
  /** Milliseconds for one full pick at a canvas point, including a rebuild of the screen grid. */
  timePick(x: number, y: number): { ms: number; id: string | null };
  loseContext(): boolean; restoreContext(): boolean;
}

/** WebGL2 renderer: instanced nodes, batched edges, GPU depth, bounded labels on an overlay canvas, grid picking. */
export function MemoryGraph3DGL({ stream, scene, showTitles, selectedNodeId, onSelectNode, loading, resetToken, volume, hidden, cameraRef, onStatus }: {
  stream: MemorySceneStream | null; scene: MemoryScene | null;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number; volume: string; hidden: boolean;
  cameraRef: MutableRefObject<MemoryCamera3D>; onStatus: (status: MemoryGLStatus) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null), overlayRef = useRef<HTMLCanvasElement>(null);
  const redrawRef = useRef<() => void>(() => {});
  const current = useRef({ stream, scene, showTitles, selectedNodeId, onSelectNode, hidden });
  current.current = { stream, scene, showTitles, selectedNodeId, onSelectNode, hidden };
  useEffect(() => { cameraRef.current = { ...DEFAULT_MEMORY_CAMERA }; redrawRef.current(); }, [resetToken, cameraRef]);
  useEffect(() => {
    const canvas = canvasRef.current, overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const overlayContext = overlay.getContext("2d");
    let renderer: MemoryGLRenderer | null = null, loseExtension: WEBGL_lose_context | null = null;
    let frame = 0, width = 1, height = 1, dpr = 1, hover = -1;
    let uploadedScene: MemoryScene | null = null, uploadedVersion = -1, kinds: Uint8Array = new Uint8Array(0), priority: Int32Array = new Int32Array(0), indexById = new Map<string, number>();
    const picker = new ScreenPicker();
    let pickerKey = "";
    const measure = createTextMeasurer(text => overlayContext?.measureText(text).width ?? text.length * 6);

    const create = () => {
      try { renderer = new MemoryGLRenderer(canvas); loseExtension = renderer.loseContextExtension; uploadedScene = null; uploadedVersion = -1; onStatus({ failed: false, lost: false }); }
      catch { renderer?.dispose(); renderer = null; onStatus({ failed: true, lost: false }); } // shader or context failure: Canvas 2D takes over
    };
    const sync = () => {
      const { scene, stream } = current.current;
      if (!renderer || !scene) return false;
      if (uploadedScene !== scene) {
        renderer.setScene(scene); uploadedScene = scene; uploadedVersion = -1;
        kinds = renderKindsOf(scene); priority = labelPriority(scene); indexById = new Map(scene.ids.map((id, i) => [id, i])); pickerKey = "";
      }
      if (stream?.x && uploadedVersion !== stream.version) { renderer.setPositions(stream.x, stream.y!, stream.z!); uploadedVersion = stream.version; }
      return Boolean(stream?.x);
    };
    const focusIndex = () => hover >= 0 ? hover : current.current.selectedNodeId ? indexById.get(current.current.selectedNodeId) ?? -1 : -1;

    const drawLabels = () => {
      if (!overlayContext) return;
      overlayContext.clearRect(0, 0, width, height);
      const { scene, stream, showTitles } = current.current;
      let measured = 0, drawn = 0;
      if (scene && stream?.x && renderer) {
        overlayContext.font = "11px system-ui, sans-serif";
        const selection = selectLabels({ scene, priority, projection: makeProjection(cameraRef.current, width, height, renderer.extent), x: stream.x, y: stream.y!, z: stream.z!, focus: focusIndex(), showTitles, measure: measure });
        measured = selection.measured; drawn = selection.labels.length;
        for (const label of selection.labels) {
          overlayContext.fillStyle = "#09111bea"; overlayContext.fillRect(label.x - 3, label.y - 11, label.width + 6, 16);
          overlayContext.fillStyle = scene.flags[label.index]! & FLAG_CORE ? "#fff0b0" : "#c6dfed"; overlayContext.fillText(label.text, label.x, label.y + 1);
        }
      }
      canvas.dataset.labelsMeasured = String(measured); canvas.dataset.labelsDrawn = String(drawn);
    };
    const renderNow = () => {
      frame = 0;
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
      if (current.current.hidden || !renderer || !sync()) return;
      renderer.setFocus(focusIndex());
      renderer.render(cameraRef.current, width, height, dpr);
      drawLabels();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(renderNow); };
    redrawRef.current = schedule;

    const hit = (x: number, y: number): string | null => {
      const { scene, stream } = current.current;
      if (!renderer || !scene || !stream?.x) return null;
      const camera = cameraRef.current, key = `${camera.yaw},${camera.pitch},${camera.zoom},${width},${height},${stream.version}`;
      if (key !== pickerKey) { picker.build(makeProjection(camera, width, height, renderer.extent), stream.x, stream.y!, stream.z!, scene.count, kinds); pickerKey = key; } // lazy: only after the view changed
      const index = picker.pick(x, y);
      return index >= 0 ? scene.ids[index]! : null;
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect(); width = Math.max(1, rect.width); height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      overlay.width = Math.round(width * dpr); overlay.height = Math.round(height * dpr);
      overlayContext?.setTransform(dpr, 0, 0, dpr, 0, 0); schedule();
    };

    const lost = (event: Event) => { event.preventDefault(); renderer?.dispose(); renderer = null; onStatus({ failed: false, lost: true }); };
    const restored = () => { create(); schedule(); };
    canvas.addEventListener("webglcontextlost", lost); canvas.addEventListener("webglcontextrestored", restored);
    create();

    const detach = attachCameraControls({
      canvas, camera: () => cameraRef.current, hit,
      onHover: id => { hover = id ? indexById.get(id) ?? -1 : -1; },
      onSelect: id => current.current.onSelectNode(id), onChange: schedule,
      onEnter: () => { const { scene, selectedNodeId } = current.current; const id = selectedNodeId ?? (scene && scene.root >= 0 ? scene.ids[scene.root] : null); if (id) current.current.onSelectNode(id); }
    });
    const unsubscribe = current.current.stream?.subscribe(schedule);
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();

    const api: MemoryGLBenchmarkApi = {
      runBenchmark: (frames = 300) => new Promise(resolve => {
        const deltas: number[] = []; let last = performance.now(), i = 0;
        const tick = (now: number) => {
          deltas.push(now - last); last = now;
          if (i++ >= frames) {
            const work: number[] = [];
            for (let f = 0; f < Math.min(frames, 200); f++) { // synchronous pass: the same camera path, timed to GPU completion
              const step = benchmarkCamera(f);
              cameraRef.current.yaw += step.yawStep; cameraRef.current.zoom = clampZoom(step.zoom);
              const start = performance.now(); renderNow(); renderer?.finish(); work.push(performance.now() - start);
            }
            resolve({ raf: summarizeFrameTimes(deltas.slice(1)), work: summarizeFrameTimes(work) });
            return;
          }
          const step = benchmarkCamera(i);
          cameraRef.current.yaw += step.yawStep; cameraRef.current.zoom = clampZoom(step.zoom);
          renderNow(); requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
      timePick: (x, y) => { sync(); pickerKey = ""; const start = performance.now(); const id = hit(x, y); return { ms: performance.now() - start, id }; },
      loseContext: () => { loseExtension?.loseContext(); return Boolean(loseExtension); },
      restoreContext: () => { loseExtension?.restoreContext(); return Boolean(loseExtension); }
    };
    (canvas as HTMLCanvasElement & { __memory3d?: MemoryGLBenchmarkApi }).__memory3d = api;
    return () => {
      unsubscribe?.(); observer.disconnect(); cancelAnimationFrame(frame); redrawRef.current = () => {}; detach();
      canvas.removeEventListener("webglcontextlost", lost); canvas.removeEventListener("webglcontextrestored", restored);
      renderer?.dispose(); renderer = null; // release GPU resources
    };
  }, [cameraRef, onStatus, stream]);
  useEffect(() => { redrawRef.current(); }, [scene, showTitles, selectedNodeId, hidden]);
  const props = memory3DCanvasProps(loading, showTitles, volume);
  return <>
    <canvas ref={canvasRef} {...props} {...(hidden ? { hidden: true, tabIndex: -1, role: undefined, "aria-label": undefined, "aria-hidden": true } : {})} />
    <canvas ref={overlayRef} className="memory-3d-labels" aria-hidden="true" hidden={hidden} />
  </>;
}
