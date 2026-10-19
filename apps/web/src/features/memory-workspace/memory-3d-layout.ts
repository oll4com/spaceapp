import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

export type MemoryPoint3D = { x: number; y: number; z: number };

// Avalanche each seed so neighboring IDs have independent coordinates on all axes.
function unit(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
}

/** A deterministic simulation which can yield between steps without changing its result. */
export interface MemoryLayout3DSimulation {
  readonly ids: readonly string[];
  readonly step: number;
  readonly complete: boolean;
  advance(steps?: number): void;
  /** Each call owns a new transferable buffer; transferring it cannot detach simulation state. */
  snapshot(): Float32Array<ArrayBuffer>;
  toMap(): Map<string, MemoryPoint3D>;
}

/**
 * Small graphs retain pairwise local repulsion. Large graphs aggregate each neighboring
 * cell, bounding repulsion to 27 cell visits per node even when every node overlaps.
 * Springs still follow every real graph edge; no artificial edges are introduced.
 */
export function createMemoryLayout3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): MemoryLayout3DSimulation {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const orderedEdges = [...edges].sort((a, b) => a.id.localeCompare(b.id)
    || a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.type.localeCompare(b.type));
  const ids = ordered.map(node => node.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  const aggregate = count > 2000;
  const extent = 260 * (aggregate ? Math.cbrt(count / 2000) : 1);
  const x = new Float64Array(count), y = new Float64Array(count), z = new Float64Array(count);
  const source = Uint8Array.from(ordered, node => Number(node.type === "SOURCE"));
  for (let i = 0; i < count; i++) {
    x[i] = (unit(`${ids[i]}:x`) - 0.5) * extent;
    y[i] = (unit(`${ids[i]}:y`) - 0.5) * extent;
    z[i] = (unit(`${ids[i]}:z`) - 0.5) * extent;
  }
  if (root >= 0) x[root] = y[root] = z[root] = 0;
  const links = orderedEdges.flatMap(edge => {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) return [];
    const fileLink = source[a] && source[b];
    return [{ a, b, length: fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55,
      strength: fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004 }];
  });
  // Stable edge ordering also makes ambiguous multi-parent records order independent.
  for (const edge of orderedEdges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type !== "CONTAINS" || a === undefined || b === undefined || !source[a] || ordered[b]!.type !== "MEMORY") continue;
    x[b] = x[a]! + (unit(`${ids[b]}:dx`) - 0.5) * 70;
    y[b] = y[a]! + (unit(`${ids[b]}:dy`) - 0.5) * 70;
    z[b] = z[a]! + (unit(`${ids[b]}:dz`) - 0.5) * 70;
  }
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  let step = 0;
  const steps = 180;
  function relax(): void {
    fx.fill(0); fy.fill(0); fz.fill(0);
    if (aggregate) {
      const grid = new Map<string, { x: number; y: number; z: number; count: number; sources: number }>();
      for (let i = 0; i < count; i++) {
        const key = `${Math.floor(x[i]! / 32)},${Math.floor(y[i]! / 32)},${Math.floor(z[i]! / 32)}`;
        const cell = grid.get(key);
        if (cell) { cell.x += x[i]!; cell.y += y[i]!; cell.z += z[i]!; cell.count++; cell.sources += source[i]!; }
        else grid.set(key, { x: x[i]!, y: y[i]!, z: z[i]!, count: 1, sources: source[i]! });
      }
      for (let i = 0; i < count; i++) {
        const gx = Math.floor(x[i]! / 32), gy = Math.floor(y[i]! / 32), gz = Math.floor(z[i]! / 32);
        for (let cx = gx - 1; cx <= gx + 1; cx++) for (let cy = gy - 1; cy <= gy + 1; cy++) for (let cz = gz - 1; cz <= gz + 1; cz++) {
          const cell = grid.get(`${cx},${cy},${cz}`);
          if (!cell) continue;
          const same = Number(cx === gx && cy === gy && cz === gz);
          const peers = cell.count - same;
          if (!peers) continue;
          const dx = x[i]! - (cell.x - same * x[i]!) / peers;
          const dy = y[i]! - (cell.y - same * y[i]!) / peers;
          const dz = z[i]! - (cell.z - same * z[i]!) / peers;
          const strength = (source[i] ? 28 * peers : 12 * peers + 16 * (cell.sources - same * source[i]!))
            / Math.max(1, dx * dx + dy * dy + dz * dz);
          fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
        }
      }
    } else {
      const grid = new Map<string, number[]>();
      for (let i = 0; i < count; i++) {
        const key = `${Math.floor(x[i]! / 32)},${Math.floor(y[i]! / 32)},${Math.floor(z[i]! / 32)}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key)!.push(i);
      }
      for (let i = 0; i < count; i++) {
        const gx = Math.floor(x[i]! / 32), gy = Math.floor(y[i]! / 32), gz = Math.floor(z[i]! / 32);
        for (let cx = gx - 1; cx <= gx + 1; cx++) for (let cy = gy - 1; cy <= gy + 1; cy++) for (let cz = gz - 1; cz <= gz + 1; cz++) {
          for (const j of grid.get(`${cx},${cy},${cz}`) ?? []) {
            if (j <= i) continue;
            const dx = x[i]! - x[j]!, dy = y[i]! - y[j]!, dz = z[i]! - z[j]!;
            const strength = (source[i] || source[j] ? 28 : 12) / Math.max(1, dx * dx + dy * dy + dz * dz);
            fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
            fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
          }
        }
      }
    }
    for (const link of links) {
      const dx = x[link.b]! - x[link.a]!, dy = y[link.b]! - y[link.a]!, dz = z[link.b]! - z[link.a]!;
      const distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - link.length) * link.strength / distance;
      fx[link.a]! += dx * spring; fy[link.a]! += dy * spring; fz[link.a]! += dz * spring;
      fx[link.b]! -= dx * spring; fy[link.b]! -= dy * spring; fz[link.b]! -= dz * spring;
    }
    const cooling = 1 - step / 230;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const dx = fx[i]! - x[i]! * 0.0005, dy = fy[i]! - y[i]! * 0.0005, dz = fz[i]! - z[i]! * 0.0005;
      const scale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      x[i]! += dx * scale; y[i]! += dy * scale; z[i]! += dz * scale;
    }
    step++;
  }
  return {
    ids,
    get step() { return step; },
    get complete() { return count === 0 || step >= steps; },
    advance(iterations = 1) {
      if (!Number.isInteger(iterations) || iterations < 0) throw new RangeError("Layout steps must be a nonnegative integer");
      for (let i = 0; i < iterations && count > 0 && step < steps; i++) relax();
    },
    snapshot() {
      const packed = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) { packed[i * 3] = x[i]!; packed[i * 3 + 1] = y[i]!; packed[i * 3 + 2] = z[i]!; }
      return packed;
    },
    toMap() { return new Map(ids.map((id, i) => [id, { x: x[i]!, y: y[i]!, z: z[i]! }])); }
  };
}
