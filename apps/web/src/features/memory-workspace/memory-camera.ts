import { DEFAULT_MEMORY_CAMERA, type MemoryCamera3D } from "./memory-3d.js";

export const MIN_ZOOM = 0.35, MAX_ZOOM = 5;
export const clampZoom = (zoom: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

/** Node radius classes: ordinary record, source file, and the core rules file (the root). */
export const KIND_MEMORY = 0, KIND_SOURCE = 1, KIND_ROOT = 2;
/** Highlight state per node: normal, dimmed by a focus elsewhere, the focused node, or a neighbour of it. */
export const STATE_NORMAL = 0, STATE_DIM = 1, STATE_FOCUS = 2, STATE_NEIGHBOR = 3;

export interface Projection { cy: number; sy: number; cp: number; sp: number; scale: number; zoom: number; width: number; height: number; extent: number }

/** The model-to-view radius used once: `scale` normalizes the layout extent to 40% of the short side. */
export const layoutExtent = (x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>, count: number): number => {
  let max = 60 * 60;
  for (let i = 0; i < count; i++) { const d = x[i]! * x[i]! + y[i]! * y[i]! + z[i]! * z[i]!; if (d > max) max = d; }
  return Math.sqrt(max);
};

export function makeProjection(camera: MemoryCamera3D, width: number, height: number, extent: number): Projection {
  return { cy: Math.cos(camera.yaw), sy: Math.sin(camera.yaw), cp: Math.cos(camera.pitch), sp: Math.sin(camera.pitch), scale: Math.min(width, height) * 0.4 / extent, zoom: camera.zoom, width, height, extent };
}

/**
 * CPU mirror of the node vertex shader (and of projectMemoryPoint). Writes screen x, screen y,
 * rotated depth (model units) and the perspective factor to `out`. Zoom is applied exactly once, here.
 */
export function projectInto(p: Projection, x: number, y: number, z: number, out: Float64Array | number[], at = 0): void {
  const px = x * p.cy + z * p.sy;
  const depth = -x * p.sy + z * p.cy;
  const py = y * p.cp - depth * p.sp;
  const pz = y * p.sp + depth * p.cp;
  const perspective = 650 / Math.max(120, 650 + pz * p.scale);
  out[at] = p.width / 2 + px * p.scale * p.zoom * perspective;
  out[at + 1] = p.height / 2 - py * p.scale * p.zoom * perspective;
  out[at + 2] = pz;
  out[at + 3] = perspective;
}

/** Normalized depth written to gl_Position.z: nearer is smaller, and the whole extent fits inside (-1, 1). */
export const depthNdc = (rotatedZ: number, extent: number) => Math.max(-1, Math.min(1, rotatedZ / extent)) * 0.98;

export const nodeRadius = (kind: number, perspective: number, zoom: number, highlighted: boolean) =>
  Math.max(1, (kind === KIND_ROOT ? 10 : kind === KIND_SOURCE ? 4.6 : 2.1) * perspective * Math.sqrt(zoom)) * (highlighted ? 1.5 : 1);

export const nodeAlpha = (state: number, hasFocus: boolean, perspective: number) =>
  hasFocus && state === STATE_DIM ? 0.2 : Math.max(0.4, Math.min(1, perspective));

export const hitRadius = (radius: number) => Math.max(7, radius + 3);

export const rotateByKey = (camera: MemoryCamera3D, key: string): boolean => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return false;
  camera.yaw += key === "ArrowLeft" ? -0.15 : key === "ArrowRight" ? 0.15 : 0;
  camera.pitch += key === "ArrowUp" ? -0.15 : key === "ArrowDown" ? 0.15 : 0;
  return true;
};
export const wheelZoom = (camera: MemoryCamera3D, deltaY: number) => { camera.zoom = clampZoom(camera.zoom * Math.exp(-deltaY * 0.001)); };

export interface CameraControlOptions {
  canvas: HTMLCanvasElement;
  camera: () => MemoryCamera3D;
  /** Node id under a canvas-local point, or null. */
  hit: (x: number, y: number) => string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  /** Enter key: select the current node, or the core file when none is selected. */
  onEnter: () => void;
  onChange: () => void;
}

/** Pointer, wheel and keyboard handling shared by the WebGL and Canvas 2D renderers. Returns a detach function. */
export function attachCameraControls({ canvas, camera, hit, onHover, onSelect, onEnter, onChange }: CameraControlOptions): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let dragged = false, downX = 0, downY = 0;
  const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const down = (event: PointerEvent) => {
    canvas.focus(); canvas.setPointerCapture(event.pointerId);
    const p = local(event); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false; onHover(null);
  };
  const move = (event: PointerEvent) => {
    const p = local(event), previous = pointers.get(event.pointerId), view = camera();
    if (previous) {
      if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
      if (pointers.size === 2) {
        const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
        const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(p.x - other.x, p.y - other.y);
        if (before > 1) view.zoom = clampZoom(view.zoom * after / before);
      } else { view.yaw += (p.x - previous.x) * 0.009; view.pitch += (p.y - previous.y) * 0.009; }
      pointers.set(event.pointerId, p);
    } else { const id = hit(p.x, p.y); onHover(id); canvas.style.cursor = id ? "pointer" : "grab"; }
    onChange();
  };
  const up = (event: PointerEvent) => {
    const p = local(event);
    if (!dragged && pointers.size === 1) { const id = hit(p.x, p.y); if (id) onSelect(id); }
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
  const wheel = (event: WheelEvent) => { event.preventDefault(); wheelZoom(camera(), event.deltaY); onChange(); };
  const key = (event: KeyboardEvent) => {
    if (rotateByKey(camera(), event.key)) { event.preventDefault(); onChange(); }
    else if (event.key === "Enter") onEnter();
  };
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
  return () => {
    canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key);
  };
}

export { DEFAULT_MEMORY_CAMERA };
