import type { MemoryCamera3D } from "./memory-3d.js";
import type { MemoryGpuScene } from "./memory-gpu-scene.js";

type PickScene = Pick<MemoryGpuScene, "coordinates" | "nodes" | "extent">;
const CELL_SIZE = 32;

/**
 * CSS-pixel hit disks indexed by viewport cell. Rebuilds are O(nodes + cell
 * memberships) on camera/geometry changes; a pointer query visits only its cell.
 * Dense overlapping disks can still share a cell: candidates must not be capped,
 * otherwise a legitimate frontmost hit could disappear.
 */
export class MemoryPickIndex {
  private scene: PickScene | null = null;
  private coordinates: Float32Array | null = null;
  private revision = -1;
  private extent = 0;
  private count = 0;
  private width = 0;
  private height = 0;
  private yaw = NaN;
  private pitch = NaN;
  private zoom = NaN;
  private columns = 0;
  private rows = 0;
  private heads = new Int32Array(0);
  private next = new Int32Array(0);
  private members = new Int32Array(0);
  // x, y, clamped shader depth, unfocused rendered radius, per node.
  private projected = new Float32Array(0);
  private valid = false;

  invalidate() { this.valid = false; }

  /** Focus is deliberately absent: cells include the maximum focused radius. */
  update(scene: PickScene, camera: MemoryCamera3D, width: number, height: number, revision: number): boolean {
    if (this.valid && this.scene === scene && this.coordinates === scene.coordinates && this.revision === revision
      && this.extent === scene.extent && this.count === scene.nodes.length && this.width === width && this.height === height
      && this.yaw === camera.yaw && this.pitch === camera.pitch && this.zoom === camera.zoom) return false;
    this.valid = false;
    this.scene = scene; this.coordinates = scene.coordinates; this.revision = revision;
    this.extent = scene.extent; this.count = scene.nodes.length; this.width = width; this.height = height;
    this.yaw = camera.yaw; this.pitch = camera.pitch; this.zoom = camera.zoom;
    if (!(width > 0 && height > 0 && scene.extent > 0 && camera.zoom > 0)
      || !Number.isFinite(width + height + scene.extent + camera.yaw + camera.pitch + camera.zoom)) return true;
    this.columns = Math.ceil(width / CELL_SIZE); this.rows = Math.ceil(height / CELL_SIZE);
    const cells = this.columns * this.rows;
    if (this.heads.length !== cells) this.heads = new Int32Array(cells);
    this.heads.fill(-1);
    if (this.projected.length < this.count * 4) this.projected = new Float32Array(this.count * 4);
    this.reserveMembers(Math.max(1024, this.count * 4));
    const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const scale = Math.min(width, height) * 0.4 / scene.extent, zoomRadius = Math.sqrt(camera.zoom);
    const depthScale = scale / (650 + Math.max(width, height));
    const coordinates = scene.coordinates;
    let entry = 0;
    for (let index = 0; index < this.count; index++) {
      const offset = index * 4, px = coordinates[offset]!, py = coordinates[offset + 1]!, pz = coordinates[offset + 2]!;
      // Same rotation, perspective and depth clamp as memory-webgl-renderer GLSL
      // and projectMemoryPoint; trig is shared by the entire rebuild.
      const x = px * cy + pz * sy, d = -px * sy + pz * cy;
      const y = py * cp - d * sp, z = py * sp + d * cp;
      const perspective = 650 / Math.max(120, 650 + z * scale);
      const screenX = width * 0.5 + x * scale * camera.zoom * perspective;
      const screenY = height * 0.5 - y * scale * camera.zoom * perspective;
      const radius = Math.max(1, coordinates[offset + 3]! * perspective * zoomRadius);
      const hitExtent = Math.max(7, radius * 1.5 + 3);
      if (!Number.isFinite(screenX + screenY + radius + z)
        || screenX + hitExtent < 0 || screenX - hitExtent > width
        || screenY + hitExtent < 0 || screenY - hitExtent > height) continue;
      this.projected[offset] = screenX; this.projected[offset + 1] = screenY;
      this.projected[offset + 2] = Math.max(-0.99, Math.min(0.99, z * depthScale));
      this.projected[offset + 3] = radius;
      const left = Math.min(this.columns - 1, Math.max(0, Math.floor((screenX - hitExtent) / CELL_SIZE)));
      const right = Math.min(this.columns - 1, Math.floor((screenX + hitExtent) / CELL_SIZE));
      const top = Math.min(this.rows - 1, Math.max(0, Math.floor((screenY - hitExtent) / CELL_SIZE)));
      const bottom = Math.min(this.rows - 1, Math.floor((screenY + hitExtent) / CELL_SIZE));
      this.reserveMembers(entry + (right - left + 1) * (bottom - top + 1));
      for (let row = top; row <= bottom; row++) {
        for (let column = left; column <= right; column++) {
          const cell = row * this.columns + column;
          this.members[entry] = index; this.next[entry] = this.heads[cell]!; this.heads[cell] = entry++;
        }
      }
    }
    this.valid = true;
    return true;
  }

  private reserveMembers(required: number) {
    if (required <= this.members.length) return;
    const capacity = Math.max(required, this.members.length * 2);
    const members = new Int32Array(capacity), next = new Int32Array(capacity);
    members.set(this.members); next.set(this.next); this.members = members; this.next = next;
  }

  pick(x: number, y: number, focus = -1): number {
    if (!this.valid || !Number.isFinite(x + y) || x < 0 || y < 0 || x > this.width || y > this.height) return -1;
    const column = Math.min(this.columns - 1, Math.floor(x / CELL_SIZE));
    const row = Math.min(this.rows - 1, Math.floor(y / CELL_SIZE));
    let best = -1, bestDepth = Infinity;
    for (let entry = this.heads[row * this.columns + column]!; entry !== -1; entry = this.next[entry]!) {
      const index = this.members[entry]!, offset = index * 4, depth = this.projected[offset + 2]!;
      // LEQUAL and instance draw order make the later node win an exact depth tie.
      if (depth > bestDepth || (depth === bestDepth && index < best)) continue;
      const radius = Math.max(7, this.projected[offset + 3]! * (index === focus ? 1.5 : 1) + 3);
      const dx = x - this.projected[offset]!, dy = y - this.projected[offset + 1]!;
      if (dx * dx + dy * dy <= radius * radius) { best = index; bestDepth = depth; }
    }
    return best;
  }

  dispose() {
    this.valid = false; this.scene = null; this.coordinates = null;
    this.heads = new Int32Array(0); this.next = new Int32Array(0);
    this.members = new Int32Array(0); this.projected = new Float32Array(0);
  }
}
