import { hitRadius, KIND_MEMORY, KIND_ROOT, KIND_SOURCE, nodeRadius, projectInto, type Projection } from "./memory-camera.js";
import { FLAG_CORE, NODE_KIND, type MemoryScene } from "./memory-scene.js";

/** Radius class per node, for the shaders, picking and labels. */
export function renderKindsOf(scene: MemoryScene): Uint8Array {
  const kinds = new Uint8Array(scene.count);
  for (let i = 0; i < scene.count; i++) kinds[i] = scene.kind[i] === NODE_KIND.SOURCE ? (scene.flags[i]! & FLAG_CORE ? KIND_ROOT : KIND_SOURCE) : KIND_MEMORY;
  return kinds;
}

const CELL = 32;

/**
 * Screen-space uniform grid. `build` projects every node once with the same math as the vertex shader and bins it
 * (counting sort, no per-node objects); `pick` then only inspects the few cells around the pointer. Callers rebuild
 * lazily, after the camera or positions changed, never per pointer move.
 */
export class ScreenPicker {
  private sx = new Float32Array(0); private sy = new Float32Array(0); private depth = new Float32Array(0); private reach = new Float32Array(0);
  private cellOf = new Int32Array(0); private items = new Int32Array(0); private start = new Int32Array(0);
  private cols = 0; private rows = 0; private range = 1;
  private tmp = new Float64Array(4);

  build(p: Projection, x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>, count: number, kinds: Uint8Array, focus = -1): void {
    if (this.sx.length < count) {
      this.sx = new Float32Array(count); this.sy = new Float32Array(count); this.depth = new Float32Array(count);
      this.reach = new Float32Array(count); this.cellOf = new Int32Array(count); this.items = new Int32Array(count);
    }
    this.cols = Math.ceil(p.width / CELL) + 1; this.rows = Math.ceil(p.height / CELL) + 1;
    const cells = this.cols * this.rows;
    if (this.start.length < cells + 1) this.start = new Int32Array(cells + 1);
    this.start.fill(0, 0, cells + 1);
    const { tmp, sx, sy, depth, reach, cellOf, start } = this;
    let maxReach = 7;
    for (let i = 0; i < count; i++) {
      projectInto(p, x[i]!, y[i]!, z[i]!, tmp);
      const r = hitRadius(nodeRadius(kinds[i]!, tmp[3]!, p.zoom, i === focus));
      sx[i] = tmp[0]!; sy[i] = tmp[1]!; depth[i] = tmp[2]!; reach[i] = r;
      if (r > maxReach) maxReach = r;
    }
    this.range = Math.ceil(maxReach / CELL);
    for (let i = 0; i < count; i++) {
      const cx = Math.floor(sx[i]! / CELL), cy = Math.floor(sy[i]! / CELL);
      if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) { cellOf[i] = -1; continue; } // off screen: unreachable by a pointer
      const cell = cy * this.cols + cx;
      cellOf[i] = cell; start[cell + 1]!++;
    }
    for (let c = 0; c < cells; c++) start[c + 1]! += start[c]!;
    const cursor = start.slice(0, cells);
    for (let i = 0; i < count; i++) if (cellOf[i]! >= 0) this.items[cursor[cellOf[i]!]!++] = i;
  }

  /** Nearest-to-camera node whose hit disc contains the point, or -1. Ties go to the lower index. */
  pick(px: number, py: number): number {
    const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL);
    let best = -1, bestDepth = Infinity;
    for (let gy = Math.max(0, cy - this.range); gy <= Math.min(this.rows - 1, cy + this.range); gy++) {
      for (let gx = Math.max(0, cx - this.range); gx <= Math.min(this.cols - 1, cx + this.range); gx++) {
        const cell = gy * this.cols + gx;
        for (let m = this.start[cell]!, end = this.start[cell + 1]!; m < end; m++) {
          const i = this.items[m]!;
          if (Math.hypot(this.sx[i]! - px, this.sy[i]! - py) >= this.reach[i]!) continue;
          const d = this.depth[i]!;
          if (d < bestDepth || (d === bestDepth && i < best)) { best = i; bestDepth = d; }
        }
      }
    }
    return best;
  }
}
