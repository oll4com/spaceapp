import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

export const MEMORY_LAYOUT_STEPS = 180;
const CELL = 32;
// Same ordering as String.prototype.localeCompare, without re-resolving the locale per comparison.
const compareIds = new Intl.Collator().compare;

// Avalanche each seed so the three axes are independent even for similar file IDs.
const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

/**
 * Independent XYZ force layout that can be advanced a few steps at a time. Repulsion uses an
 * integer-hashed spatial grid in typed arrays, so a step allocates nothing and 50k nodes stay
 * tractable. The result depends only on node and edge ids, never on input order.
 */
export class MemoryLayout3DSimulation {
  readonly count: number;
  step = 0;
  /** Sorted position -> input position. */
  private readonly order: Int32Array;
  readonly ids: string[];
  private readonly pos: Float64Array;
  private readonly force: Float64Array;
  private readonly isSource: Uint8Array;
  private readonly root: number;
  private readonly linkA: Int32Array;
  private readonly linkB: Int32Array;
  private readonly linkLength: Float64Array;
  private readonly linkStrength: Float64Array;
  private readonly cell: Int32Array;
  private readonly bucket: Int32Array;
  private readonly sorted: Int32Array;
  private readonly bucketStart: Int32Array;
  private readonly mask: number;

  constructor(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]) {
    const count = this.count = nodes.length;
    const inputOrder = nodes.map((_, i) => i).sort((a, b) => compareIds(nodes[a]!.id, nodes[b]!.id));
    this.order = Int32Array.from(inputOrder);
    const ordered = inputOrder.map(i => nodes[i]!);
    this.ids = ordered.map(node => node.id);
    const index = new Map(ordered.map((node, i) => [node.id, i]));
    this.isSource = Uint8Array.from(ordered, node => node.type === "SOURCE" ? 1 : 0);
    this.root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
    // Large graphs start spread over a proportionally larger volume so the grid stays sparse.
    const spread = 260 * Math.max(1, Math.cbrt(count / 1500));
    const pos = this.pos = new Float64Array(count * 3);
    ordered.forEach((node, i) => {
      pos[i * 3] = (unit(`${node.id}:x`) - 0.5) * spread;
      pos[i * 3 + 1] = (unit(`${node.id}:y`) - 0.5) * spread;
      pos[i * 3 + 2] = (unit(`${node.id}:z`) - 0.5) * spread;
    });
    if (this.root >= 0) pos.fill(0, this.root * 3, this.root * 3 + 3);
    const sortedEdges = [...edges].sort((a, b) => compareIds(a.id, b.id));
    const linkA: number[] = [], linkB: number[] = [], length: number[] = [], strength: number[] = [], contains: boolean[] = [];
    for (const edge of sortedEdges) {
      const a = index.get(edge.source), b = index.get(edge.target);
      if (a === undefined || b === undefined || a === b) continue;
      const fileLink = this.isSource[a] === 1 && this.isSource[b] === 1;
      linkA.push(a); linkB.push(b); contains.push(edge.type === "CONTAINS");
      length.push(fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55);
      strength.push(fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004);
    }
    this.linkA = Int32Array.from(linkA); this.linkB = Int32Array.from(linkB);
    this.linkLength = Float64Array.from(length); this.linkStrength = Float64Array.from(strength);
    // Initialize records around their actual file, in a volume rather than a plane.
    for (let l = 0; l < linkA.length; l++) {
      const a = linkA[l]!, b = linkB[l]!;
      if (!contains[l] || this.isSource[a] !== 1 || ordered[b]!.type !== "MEMORY") continue;
      const id = ordered[b]!.id;
      pos[b * 3] = pos[a * 3]! + (unit(`${id}:dx`) - 0.5) * 70;
      pos[b * 3 + 1] = pos[a * 3 + 1]! + (unit(`${id}:dy`) - 0.5) * 70;
      pos[b * 3 + 2] = pos[a * 3 + 2]! + (unit(`${id}:dz`) - 0.5) * 70;
    }
    this.force = new Float64Array(count * 3);
    this.cell = new Int32Array(count * 3);
    this.bucket = new Int32Array(count);
    this.sorted = new Int32Array(count);
    let size = 16;
    while (size < count * 2) size *= 2;
    this.mask = size - 1;
    this.bucketStart = new Int32Array(size + 1);
  }

  get done() { return this.step >= MEMORY_LAYOUT_STEPS; }

  advance(steps: number) {
    for (let i = 0; i < steps && !this.done; i++) this.iterate();
  }

  /** Positions as x,y,z triples in the caller's original node order. */
  snapshot(): Float32Array {
    const out = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      const target = this.order[i]! * 3;
      out[target] = this.pos[i * 3]!; out[target + 1] = this.pos[i * 3 + 1]!; out[target + 2] = this.pos[i * 3 + 2]!;
    }
    return out;
  }

  /** Full-precision positions keyed by id, in id order. */
  toMap(): Map<string, { x: number; y: number; z: number }> {
    return new Map(this.ids.map((id, i) => [id, { x: this.pos[i * 3]!, y: this.pos[i * 3 + 1]!, z: this.pos[i * 3 + 2]! }]));
  }

  private hash(x: number, y: number, z: number) {
    return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & this.mask;
  }

  private iterate() {
    const { count, pos, force, cell, bucket, sorted, bucketStart, isSource } = this;
    force.fill(0);
    bucketStart.fill(0);
    for (let i = 0; i < count; i++) {
      const x = Math.floor(pos[i * 3]! / CELL), y = Math.floor(pos[i * 3 + 1]! / CELL), z = Math.floor(pos[i * 3 + 2]! / CELL);
      cell[i * 3] = x; cell[i * 3 + 1] = y; cell[i * 3 + 2] = z;
      const b = bucket[i] = this.hash(x, y, z);
      bucketStart[b + 1]! += 1;
    }
    for (let b = 0; b < bucketStart.length - 1; b++) bucketStart[b + 1]! += bucketStart[b]!;
    // Stable counting sort keeps every bucket in ascending node order.
    const cursor = bucketStart.slice(0, bucketStart.length - 1);
    for (let i = 0; i < count; i++) {
      const b = bucket[i]!;
      sorted[cursor[b]!] = i;
      cursor[b]! += 1;
    }
    for (let i = 0; i < count; i++) {
      const px = pos[i * 3]!, py = pos[i * 3 + 1]!, pz = pos[i * 3 + 2]!;
      const gx = cell[i * 3]!, gy = cell[i * 3 + 1]!, gz = cell[i * 3 + 2]!;
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
        const b = this.hash(x, y, z);
        for (let k = bucketStart[b]!; k < bucketStart[b + 1]!; k++) {
          const j = sorted[k]!;
          // Hash buckets can mix cells; only the exact neighbor cell counts, and only once.
          if (j <= i || cell[j * 3] !== x || cell[j * 3 + 1] !== y || cell[j * 3 + 2] !== z) continue;
          const dx = px - pos[j * 3]!, dy = py - pos[j * 3 + 1]!, dz = pz - pos[j * 3 + 2]!;
          const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
          const strength = (isSource[i] === 1 || isSource[j] === 1 ? 28 : 12) / distanceSquared;
          force[i * 3]! += dx * strength; force[i * 3 + 1]! += dy * strength; force[i * 3 + 2]! += dz * strength;
          force[j * 3]! -= dx * strength; force[j * 3 + 1]! -= dy * strength; force[j * 3 + 2]! -= dz * strength;
        }
      }
    }
    for (let l = 0; l < this.linkA.length; l++) {
      const a = this.linkA[l]!, b = this.linkB[l]!;
      const dx = pos[b * 3]! - pos[a * 3]!, dy = pos[b * 3 + 1]! - pos[a * 3 + 1]!, dz = pos[b * 3 + 2]! - pos[a * 3 + 2]!;
      const distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - this.linkLength[l]!) * this.linkStrength[l]! / distance;
      force[a * 3]! += dx * spring; force[a * 3 + 1]! += dy * spring; force[a * 3 + 2]! += dz * spring;
      force[b * 3]! -= dx * spring; force[b * 3 + 1]! -= dy * spring; force[b * 3 + 2]! -= dz * spring;
    }
    const cooling = 1 - this.step / 230;
    for (let i = 0; i < count; i++) {
      if (i === this.root) continue;
      const dx = force[i * 3]! - pos[i * 3]! * 0.0005, dy = force[i * 3 + 1]! - pos[i * 3 + 1]! * 0.0005, dz = force[i * 3 + 2]! - pos[i * 3 + 2]! * 0.0005;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      pos[i * 3]! += dx * stepScale; pos[i * 3 + 1]! += dy * stepScale; pos[i * 3 + 2]! += dz * stepScale;
    }
    this.step++;
  }
}

export type MemoryLayoutProgress = { step: number; steps: number; done: boolean; positions: Float32Array };

/**
 * Runs the layout and reports intermediate positions (initial state first, converged state last)
 * whenever `intervalMs` has elapsed, so a view can be used while the simulation converges.
 */
export function streamMemoryLayout3D(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  emit: (progress: MemoryLayoutProgress) => void,
  options: { intervalMs?: number; now?: () => number } = {}
): MemoryLayout3DSimulation {
  const intervalMs = options.intervalMs ?? 120;
  const now = options.now ?? (() => performance.now());
  const simulation = new MemoryLayout3DSimulation(nodes, edges);
  const report = () => emit({ step: simulation.step, steps: MEMORY_LAYOUT_STEPS, done: simulation.done, positions: simulation.snapshot() });
  let last = now();
  report();
  while (!simulation.done) {
    simulation.advance(1);
    if (simulation.done || now() - last >= intervalMs) { report(); last = now(); }
  }
  return simulation;
}
