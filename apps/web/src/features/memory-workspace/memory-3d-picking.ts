import type { MemoryCamera3D } from "./memory-3d.js";
import type { MemoryRenderModel } from "./memory-3d-model.js";

/** A screen-space index rebuilt on camera/geometry changes; no scan on pointer moves. */
export class MemorySpatialIndex {
  private readonly cellSize = 16;
  private columns = 1;
  private width = 1;
  private height = 1;
  private heads = new Int32Array(0);
  private next = new Int32Array(0);
  private entries = new Uint32Array(0);
  private screen = new Float32Array(0);
  private cacheKey = "";
  private coordinates: Float32Array | null = null;

  invalidate() { this.coordinates = null; }

  rebuild(model: MemoryRenderModel, camera: MemoryCamera3D, width: number, height: number, focus: number) {
    const key = [camera.yaw, camera.pitch, camera.zoom, width, height, model.extent, focus].join(":");
    if (key === this.cacheKey && model.xyz === this.coordinates) return;
    this.cacheKey = key; this.coordinates = model.xyz;
    this.width = width; this.height = height;
    this.columns = Math.max(1, Math.ceil(width / this.cellSize));
    const rows = Math.max(1, Math.ceil(height / this.cellSize));
    if (this.heads.length !== rows * this.columns) this.heads = new Int32Array(rows * this.columns);
    this.heads.fill(-1);
    if (this.screen.length !== model.nodes.length * 4) this.screen = new Float32Array(model.nodes.length * 4);
    const capacity = Math.max(1024, model.nodes.length * 8);
    if (this.next.length < capacity) { this.next = new Int32Array(capacity); this.entries = new Uint32Array(capacity); }
    const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const scale = Math.min(width, height) * 0.4 / model.extent, zoom = camera.zoom, rootZoom = Math.sqrt(zoom);
    let entry = 0;
    for (let i = 0; i < model.nodes.length; i++) {
      const offset = i * 3, px = model.xyz[offset]!, py = model.xyz[offset + 1]!, pz = model.xyz[offset + 2]!;
      const x = px * cy + pz * sy, depth = -px * sy + pz * cy;
      const y = py * cp - depth * sp, z = py * sp + depth * cp;
      const perspective = 650 / Math.max(120, 650 + z * scale);
      const sx = width / 2 + x * scale * zoom * perspective, syScreen = height / 2 - y * scale * zoom * perspective;
      const radius = Math.max(7, Math.max(1, model.styles[i * 4 + 3]! * perspective * rootZoom) * (i === focus ? 1.5 : 1) + 3);
      this.screen[i * 4] = sx; this.screen[i * 4 + 1] = syScreen; this.screen[i * 4 + 2] = z; this.screen[i * 4 + 3] = radius * radius;
      if (sx + radius < 0 || syScreen + radius < 0 || sx - radius >= width || syScreen - radius >= height) continue;
      const left = Math.max(0, Math.floor((sx - radius) / this.cellSize)), right = Math.min(this.columns - 1, Math.floor((sx + radius) / this.cellSize));
      const top = Math.max(0, Math.floor((syScreen - radius) / this.cellSize)), bottom = Math.min(rows - 1, Math.floor((syScreen + radius) / this.cellSize));
      for (let row = top; row <= bottom; row++) for (let column = left; column <= right; column++) {
        if (entry === this.next.length) {
          const largerNext = new Int32Array(this.next.length * 2), largerEntries = new Uint32Array(this.entries.length * 2);
          largerNext.set(this.next); largerEntries.set(this.entries); this.next = largerNext; this.entries = largerEntries;
        }
        const cell = row * this.columns + column;
        this.entries[entry] = i; this.next[entry] = this.heads[cell]!; this.heads[cell] = entry++;
      }
    }
  }

  pick(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || !this.heads.length) return -1;
    const cell = Math.floor(y / this.cellSize) * this.columns + Math.floor(x / this.cellSize);
    let best = -1, nearest = Number.POSITIVE_INFINITY;
    for (let link = this.heads[cell]!; link >= 0; link = this.next[link]!) {
      const index = this.entries[link]!, offset = index * 4;
      const dx = this.screen[offset]! - x, dy = this.screen[offset + 1]! - y, z = this.screen[offset + 2]!;
      if (dx * dx + dy * dy <= this.screen[offset + 3]! && (z < nearest || (z === nearest && index > best))) { best = index; nearest = z; }
    }
    return best;
  }
}
