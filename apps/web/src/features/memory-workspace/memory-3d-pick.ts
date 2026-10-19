import { projectMemoryPoints, type MemoryCamera3D } from "./memory-3d.js";

const CELL = 32;
const TABLE_BITS = 18;
const TABLE_SIZE = 1 << TABLE_BITS;
const TABLE_MASK = TABLE_SIZE - 1;
const LABEL_SLOTS = 4;

export interface ProjectedMemoryNodes {
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  perspective: Float32Array;
  radius: Float32Array;
}

export function createProjectedMemoryNodes(count: number): ProjectedMemoryNodes {
  return {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    z: new Float32Array(count),
    perspective: new Float32Array(count),
    radius: new Float32Array(count)
  };
}

export function projectMemoryNodes(
  xyz: Float32Array,
  radii: Float32Array,
  camera: MemoryCamera3D,
  scale: number,
  width: number,
  height: number,
  out: ProjectedMemoryNodes
) {
  const count = Math.min(out.count, radii.length, Math.floor(xyz.length / 3));
  projectMemoryPoints(xyz, count, camera, scale, width, height, out.x, out.y, out.z, out.perspective);
  const zoomBoost = Math.sqrt(camera.zoom);
  for (let index = 0; index < count; index++) {
    out.radius[index] = Math.max(1, (radii[index] ?? 2.1) * (out.perspective[index] ?? 1) * zoomBoost);
  }
  return count;
}

const hashCell = (x: number, y: number) => (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1)) >>> 0;
const cellKey = (x: number, y: number) => (x + 1_000_000) * 2_000_003 + (y + 1_000_000);

function considerLabel(best: Int32Array, base: number, index: number, kind: number, kinds: Uint8Array) {
  let place = LABEL_SLOTS;
  for (let slot = 0; slot < LABEL_SLOTS; slot++) {
    const current = best[base + slot] ?? -1;
    if (current < 0) { place = slot; break; }
    const currentKind = kinds[current] ?? 0;
    if (kind > currentKind || (kind === currentKind && index < current)) { place = slot; break; }
  }
  if (place === LABEL_SLOTS) return;
  for (let slot = LABEL_SLOTS - 1; slot > place; slot--) best[base + slot] = best[base + slot - 1] ?? -1;
  best[base + place] = index;
}

/**
 * Screen-space grid. Hover and click inspect a few cells instead of every node.
 * Each cell keeps a few label candidates so title selection stays bounded.
 */
export class SpatialPickIndex {
  private count = 0;
  private heads = new Int32Array(TABLE_SIZE);
  private next = new Int32Array(0);
  private cellX = new Int32Array(0);
  private cellY = new Int32Array(0);
  private labelBase = new Map<number, number>();
  private labelBest = new Int32Array(0);
  private projected: ProjectedMemoryNodes | null = null;

  rebuild(projected: ProjectedMemoryNodes, kinds: Uint8Array, allowed?: Uint32Array) {
    const count = projected.count;
    this.count = count;
    this.projected = projected;
    if (this.next.length < count) {
      this.next = new Int32Array(count);
      this.cellX = new Int32Array(count);
      this.cellY = new Int32Array(count);
    }
    this.heads.fill(-1);
    this.labelBase.clear();
    if (this.labelBest.length < count * LABEL_SLOTS) this.labelBest = new Int32Array(Math.max(LABEL_SLOTS, count * LABEL_SLOTS));
    const members = allowed ? new Uint8Array(count) : null;
    if (members && allowed) {
      for (const index of allowed) if (index >= 0 && index < count) members[index] = 1;
    }
    let slot = 0;
    for (let index = 0; index < count; index++) {
      if (members && members[index] !== 1) continue;
      const x = projected.x[index] ?? 0;
      const y = projected.y[index] ?? 0;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const cx = Math.floor(x / CELL);
      const cy = Math.floor(y / CELL);
      this.cellX[index] = cx;
      this.cellY[index] = cy;
      const hashed = hashCell(cx, cy) & TABLE_MASK;
      this.next[index] = this.heads[hashed] ?? -1;
      this.heads[hashed] = index;
      const key = cellKey(cx, cy);
      let base = this.labelBase.get(key);
      if (base === undefined) {
        base = slot;
        slot += LABEL_SLOTS;
        if (slot > this.labelBest.length) {
          const grown = new Int32Array(Math.max(slot, this.labelBest.length * 2));
          grown.set(this.labelBest);
          this.labelBest = grown;
        }
        this.labelBest.fill(-1, base, base + LABEL_SLOTS);
        this.labelBase.set(key, base);
      }
      considerLabel(this.labelBest, base, index, kinds[index] ?? 0, kinds);
    }
  }

  /** Closest node under the pointer, or -1. */
  find(x: number, y: number): number {
    const projected = this.projected;
    if (!projected || this.count === 0) return -1;
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    let best = -1;
    let bestZ = Number.POSITIVE_INFINITY;
    for (let ox = -2; ox <= 2; ox++) for (let oy = -2; oy <= 2; oy++) {
      const hashed = hashCell(cx + ox, cy + oy) & TABLE_MASK;
      for (let index = this.heads[hashed] ?? -1; index >= 0; index = this.next[index] ?? -1) {
        if ((this.cellX[index] ?? 0) !== cx + ox || (this.cellY[index] ?? 0) !== cy + oy) continue;
        const dx = (projected.x[index] ?? 0) - x;
        const dy = (projected.y[index] ?? 0) - y;
        const radius = Math.max(7, (projected.radius[index] ?? 1) + 3);
        if (dx * dx + dy * dy >= radius * radius) continue;
        const depth = projected.z[index] ?? 0;
        if (depth < bestZ || (depth === bestZ && index > best)) {
          best = index;
          bestZ = depth;
        }
      }
    }
    return best;
  }

  /** On-screen label candidates. The result length never exceeds `limit`. */
  labelCandidates(width: number, height: number, limit = 256): number[] {
    if (!this.projected || limit <= 0 || width <= 0 || height <= 0) return [];
    const startX = 0;
    const endX = Math.floor((width - 1) / CELL);
    const startY = 0;
    const endY = Math.floor((height - 1) / CELL);
    const spanX = endX - startX;
    const spanY = endY - startY;
    const strideX = spanX > 80 ? Math.ceil(spanX / 80) : 1;
    const strideY = spanY > 80 ? Math.ceil(spanY / 80) : 1;
    const chosen: number[] = [];
    for (let cy = startY; cy <= endY && chosen.length < limit; cy += strideY) {
      for (let cx = startX; cx <= endX && chosen.length < limit; cx += strideX) {
        const base = this.labelBase.get(cellKey(cx, cy));
        if (base === undefined) continue;
        for (let slotIndex = 0; slotIndex < LABEL_SLOTS && chosen.length < limit; slotIndex++) {
          const index = this.labelBest[base + slotIndex] ?? -1;
          if (index >= 0) chosen.push(index);
        }
      }
    }
    return chosen;
  }
}

export function focusNeighborStates(edgePairs: Uint32Array, focus: number, count: number, out: Uint8Array) {
  out.fill(0, 0, count);
  if (focus < 0 || focus >= count) return out;
  out[focus] = 2;
  for (let cursor = 0; cursor < edgePairs.length; cursor += 2) {
    const source = edgePairs[cursor] ?? -1;
    const target = edgePairs[cursor + 1] ?? -1;
    if (source === focus && target >= 0 && target < count && out[target] === 0) out[target] = 1;
    else if (target === focus && source >= 0 && source < count && out[source] === 0) out[source] = 1;
  }
  return out;
}

/** Edges whose endpoints are both in the capped node set, limited so canvas fallback stays bounded. */
export function canvasFallbackEdgeIndexes(edgePairs: Uint32Array, allowed: Uint32Array, nodeCount: number, cap = 6_000): Uint32Array {
  const members = new Uint8Array(Math.max(0, nodeCount));
  for (const index of allowed) if (index >= 0 && index < members.length) members[index] = 1;
  const limit = Math.max(0, Math.min(cap, edgePairs.length / 2));
  const edges = new Uint32Array(limit);
  let count = 0;
  const edgeCount = edgePairs.length / 2;
  for (let edge = 0; edge < edgeCount && count < limit; edge++) {
    const source = edgePairs[edge * 2] ?? -1;
    const target = edgePairs[edge * 2 + 1] ?? -1;
    if (source < 0 || target < 0 || source >= members.length || target >= members.length) continue;
    if (members[source] && members[target]) edges[count++] = edge;
  }
  return edges.subarray(0, count);
}

/** Prefer the core, then sources, then everyone else, and never return more than `cap` indexes. */
export function canvasFallbackIndexes(kinds: Uint8Array, cap = 2_000): Uint32Array {
  const limit = Math.max(0, Math.min(cap, kinds.length));
  const indexes = new Uint32Array(limit);
  let cursor = 0;
  const take = (kind: number) => {
    for (let index = 0; index < kinds.length && cursor < limit; index++) {
      if ((kinds[index] ?? 0) === kind) indexes[cursor++] = index;
    }
  };
  take(2);
  take(1);
  take(0);
  return indexes.subarray(0, cursor);
}
