import { projectMemoryPoint, type MemoryCamera3D } from "./memory-3d.js";
import type { MemoryRenderData, RenderNode } from "./memory-webgl-renderer.js";
import { memoryProfilePhase } from "./memory-webgl-renderer.js";

type Branch = { min: number[]; max: number[]; radius: number; start: number; end: number; left: number; right: number };
type Vector = [number, number, number];
const axisValue = (node: RenderNode, axis: number) => axis === 0 ? node.point.x : axis === 1 ? node.point.y : node.point.z;

/** Median BVH in world space: camera motion does not rebuild or reproject it. */
export class MemorySpatialIndex {
  private order: Uint32Array;
  private branches: Branch[] = [];
  /** Synchronous construction is for small inputs; use create for interactive large graphs. */
  constructor(private data: MemoryRenderData, deferBuild = false) {
    this.order = Uint32Array.from(data.nodes, item => item.index);
    if (!deferBuild) for (const step of this.build()) { void step; /* Synchronous pure helper for small graphs/tests. */ }
  }
  /** Build in cooperative slices, returning null if its graph snapshot becomes obsolete. */
  static async create(data: MemoryRenderData, cancelled: () => boolean): Promise<MemorySpatialIndex | null> {
    if (cancelled()) return null;
    const index = new MemorySpatialIndex(data, true); let deadline = performance.now() + 6;
    const steps = index.build(); let iteration = 0;
    for (;;) {
      if (cancelled()) return null;
      // Sample a bounded fraction of synchronous slices. Whole-branch spans
      // include cooperative yields and therefore measure wall time only.
      const finishProfile = iteration++ % 32 === 0 ? memoryProfilePhase("bvh-build-slice") : null;
      const step = steps.next(); finishProfile?.();
      if (step.done) break;
      if (performance.now() >= deadline) { await new Promise<void>(resolve => setTimeout(resolve, 0)); deadline = performance.now() + 6; }
    }
    return cancelled() ? null : index;
  }
  /** Partition indices around a median without sorting or blocking an entire large branch. */
  private *select(start: number, end: number, middle: number, axis: number): Generator<void> {
    // In-place quickselect avoids sorting/reallocating all nodes at every level.
    let lo = start, hi = end - 1, operations = 0;
    const value = (index: number) => axisValue(this.data.nodes[this.order[index]!]!, axis);
    while (lo < hi) {
      const pivot = value((lo + hi) >>> 1);
      let left = lo, right = hi;
      while (left <= right) {
        while (value(left) < pivot) { left++; if (++operations % 512 === 0) yield; }
        while (value(right) > pivot) { right--; if (++operations % 512 === 0) yield; }
        if (left <= right) { const old = this.order[left]!; this.order[left++] = this.order[right]!; this.order[right--] = old; }
        if (++operations % 512 === 0) yield;
      }
      if (middle <= right) hi = right;
      else if (middle >= left) lo = left;
      else break;
    }
  }
  /** Yield within bounds scans and partitions, including the initial full-graph branch. */
  private *build(): Generator<void> {
    const tasks = this.order.length ? [{ start: 0, end: this.order.length, parent: -1, right: false }] : [];
    while (tasks.length) {
      const { start, end, parent, right } = tasks.pop()!;
      const finishProfile = end - start >= 10_000 ? memoryProfilePhase("bvh-large-branch-wall") : null;
      const branch: Branch = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], radius: 0, start, end, left: -1, right: -1 };
      for (let i = start; i < end; i++) {
        const item = this.data.nodes[this.order[i]!]!;
        for (let axis = 0; axis < 3; axis++) { const value = axisValue(item, axis); branch.min[axis] = Math.min(branch.min[axis]!, value); branch.max[axis] = Math.max(branch.max[axis]!, value); }
        branch.radius = Math.max(branch.radius, item.radius);
        if ((i - start) % 256 === 255) yield;
      }
      const index = this.branches.length; this.branches.push(branch);
      if (parent >= 0) { if (right) this.branches[parent]!.right = index; else this.branches[parent]!.left = index; }
      if (end - start > 16) {
        const spread = branch.max.map((value, axis) => value - branch.min[axis]!);
        const axis = spread[0]! >= spread[1]! && spread[0]! >= spread[2]! ? 0 : spread[1]! >= spread[2]! ? 1 : 2;
        const middle = (start + end) >>> 1; yield* this.select(start, end, middle, axis);
        tasks.push({ start: middle, end, parent: index, right: true }, { start, end: middle, parent: index, right: false });
      }
      finishProfile?.();
      yield;
    }
  }
  /** Resolve CSS-pixel coordinates to the frontmost visible hit; counters support benchmarks. */
  pick(x: number, y: number, camera: MemoryCamera3D, width: number, height: number, focus: string | null) {
    const scale = Math.min(width, height) * 0.4 / this.data.extent;
    const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const unrotate = (a: number, b: number, c: number): Vector => {
      const py = b * cp + c * sp, depth = -b * sp + c * cp;
      return [a * cy - depth * sy, py, a * sy + depth * cy];
    };
    const direction = unrotate((x - width / 2) / (650 * camera.zoom), -(y - height / 2) / (650 * camera.zoom), 1);
    const invert = (vector: Vector): Vector => vector.map(value => Math.abs(value) < 1e-12 ? Infinity : 1 / value) as Vector;
    const rays = [{ origin: unrotate(0, 0, -650 / scale), inverse: invert(direction) }];
    // projectMemoryPoint clamps its near plane at 120px. On very tall 4K
    // surfaces that region is orthographic, so query that ray as well.
    if (this.data.extent * scale > 530) rays.push({ origin: unrotate((x - width / 2) * 120 / (650 * scale * camera.zoom), -(y - height / 2) * 120 / (650 * scale * camera.zoom), -this.data.extent * 2), inverse: invert(unrotate(0, 0, 1)) });
    const pixelWorld = (650 + this.data.extent * scale) / (650 * scale * camera.zoom);
    const radiusWorld = 1.5 / (scale * Math.sqrt(camera.zoom));
    const intersects = (branch: Branch, origin: Vector, inverse: Vector) => {
      // Projected hit slop plus the largest sphere in this subtree. Expansion
      // is conservative; the final candidate test uses exact screen circles.
      const margin = Math.max(7 * pixelWorld, branch.radius * radiusWorld + 3 * pixelWorld) * 1.1;
      let near = -Infinity, far = Infinity;
      for (let axis = 0; axis < 3; axis++) {
        const min = branch.min[axis]! - margin, max = branch.max[axis]! + margin;
        if (!Number.isFinite(inverse[axis]!)) { if (origin[axis]! < min || origin[axis]! > max) return false; continue; }
        const a = (min - origin[axis]!) * inverse[axis]!, b = (max - origin[axis]!) * inverse[axis]!;
        near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b)); if (near > far) return false;
      }
      return far >= 0;
    };
    let id: string | null = null, nearest = Infinity, nearestIndex = -1, candidates = 0, visited = 0;
    for (const ray of rays) {
      const stack = this.branches.length ? [0] : [];
      while (stack.length) {
        const branch = this.branches[stack.pop()!]!; visited++;
        if (!intersects(branch, ray.origin, ray.inverse)) continue;
        if (branch.left >= 0) { stack.push(branch.left, branch.right); continue; }
        for (let i = branch.start; i < branch.end; i++) {
          const item = this.data.nodes[this.order[i]!]!; candidates++;
          const point = projectMemoryPoint(item.point, camera, scale, width, height);
          const radius = Math.max(1, item.radius * point.perspective * Math.sqrt(camera.zoom)) * (item.node.id === focus ? 1.5 : 1);
          if ((point.z < nearest || (point.z === nearest && item.index > nearestIndex)) && Math.hypot(point.x - x, point.y - y) <= Math.max(7, radius + 3)) { nearest = point.z; nearestIndex = item.index; id = item.node.id; }
        }
      }
    }
    return { id, candidates, visited };
  }
}
