import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };

/** Hash a node/axis seed into a stable unit interval without shared random state. */
const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

export const MEMORY_3D_LAYOUT_STEPS = 180;
export type MemoryNetwork3DSimulation = {
  readonly progress: number;
  readonly done: boolean;
  advance: (iterations?: number) => void;
  snapshot: () => Map<string, MemoryPoint3D>;
};

/** Create deterministic XYZ force relaxation with bounded advances and independent snapshot copies. */
export function createMemoryNetwork3DSimulation(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): MemoryNetwork3DSimulation {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  const px = new Float64Array(count), py = new Float64Array(count), pz = new Float64Array(count);
  const source = new Uint8Array(count);
  // Keep initial density bounded as the archive grows. The springs still determine
  // the final geometry; a larger archive must not start as 50k coincident particles.
  const spread = Math.max(1, Math.cbrt(count / 2000));
  ordered.forEach((node, i) => {
    px[i] = (unit(`${node.id}:x`) - 0.5) * 260 * spread;
    py[i] = (unit(`${node.id}:y`) - 0.5) * 260 * spread;
    pz[i] = (unit(`${node.id}:z`) - 0.5) * 260 * spread;
    source[i] = Number(node.type === "SOURCE");
  });
  if (root >= 0) px[root] = py[root] = pz[root] = 0;
  const sortedEdges = [...edges].sort((a, b) => a.id.localeCompare(b.id));
  const links = sortedEdges.flatMap(edge => {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) return [];
    const fileLink = ordered[a]!.type === "SOURCE" && ordered[b]!.type === "SOURCE";
    return [{ a, b, length: fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55,
      strength: fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004 }];
  });
  // Initialize records around their actual file, in a volume rather than a plane.
  for (const edge of sortedEdges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type !== "CONTAINS" || a === undefined || b === undefined || ordered[a]!.type !== "SOURCE" || ordered[b]!.type !== "MEMORY") continue;
    const id = ordered[b]!.id;
    px[b] = px[a]! + (unit(`${id}:dx`) - 0.5) * 70 * spread;
    py[b] = py[a]! + (unit(`${id}:dy`) - 0.5) * 70 * spread;
    pz[b] = pz[a]! + (unit(`${id}:dz`) - 0.5) * 70 * spread;
  }
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  // An open-addressed grid avoids millions of temporary coordinate strings and
  // arrays per iteration. Dense cells use their center of mass for large graphs,
  // bounding local repulsion work even when thousands of records share one file.
  let gridSize = 16;
  while (gridSize < count * 2) gridSize *= 2;
  const mask = gridSize - 1;
  const stamps = new Uint32Array(gridSize), head = new Int32Array(gridSize);
  const cellX = new Int32Array(gridSize), cellY = new Int32Array(gridSize), cellZ = new Int32Array(gridSize);
  const cellCount = new Int32Array(gridSize), cellSources = new Int32Array(gridSize);
  const sumX = new Float64Array(gridSize), sumY = new Float64Array(gridSize), sumZ = new Float64Array(gridSize);
  const next = new Int32Array(count);
  let step = 0;
  /** Find this iteration's cell or an empty slot without clearing the reusable hash table. */
  const slotFor = (x: number, y: number, z: number, stamp: number) => {
    let slot = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
    while (stamps[slot] === stamp && (cellX[slot] !== x || cellY[slot] !== y || cellZ[slot] !== z)) slot = (slot + 1) & mask;
    return slot;
  };
  /** Apply one cooled spring/repulsion step while keeping the actual core node fixed. */
  const iterate = () => {
    fx.fill(0); fy.fill(0); fz.fill(0);
    const stamp = step + 1;
    for (let i = 0; i < count; i++) {
      const x = Math.floor(px[i]! / 32), y = Math.floor(py[i]! / 32), z = Math.floor(pz[i]! / 32);
      const slot = slotFor(x, y, z, stamp);
      if (stamps[slot] !== stamp) {
        stamps[slot] = stamp; cellX[slot] = x; cellY[slot] = y; cellZ[slot] = z;
        head[slot] = -1; cellCount[slot] = 0; cellSources[slot] = 0;
        sumX[slot] = sumY[slot] = sumZ[slot] = 0;
      }
      next[i] = head[slot]!; head[slot] = i;
      cellCount[slot]!++; cellSources[slot]! += source[i]!;
      sumX[slot]! += px[i]!; sumY[slot]! += py[i]!; sumZ[slot]! += pz[i]!;
    }
    for (let i = 0; i < count; i++) {
      const gx = Math.floor(px[i]! / 32), gy = Math.floor(py[i]! / 32), gz = Math.floor(pz[i]! / 32);
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
        const slot = slotFor(x, y, z, stamp);
        if (stamps[slot] !== stamp) continue;
        if (count > 2000 && cellCount[slot]! > 8) {
          const ownCell = gx === x && gy === y && gz === z;
          const population = cellCount[slot]! - Number(ownCell);
          if (!population) continue;
          const dx = px[i]! - (sumX[slot]! - (ownCell ? px[i]! : 0)) / population;
          const dy = py[i]! - (sumY[slot]! - (ownCell ? py[i]! : 0)) / population;
          const dz = pz[i]! - (sumZ[slot]! - (ownCell ? pz[i]! : 0)) / population;
          const sources = cellSources[slot]! - (ownCell ? source[i]! : 0);
          const strength = (source[i] ? 28 : 12 + 16 * sources / population) * population / Math.max(1, dx * dx + dy * dy + dz * dz);
          fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
          continue;
        }
        for (let j = head[slot]!; j !== -1; j = next[j]!) {
          if (count <= 2000 ? j <= i : j === i) continue;
          const dx = px[i]! - px[j]!, dy = py[i]! - py[j]!, dz = pz[i]! - pz[j]!;
          const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
          const strength = (source[i] || source[j] ? 28 : 12) / distanceSquared;
          fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
          if (count <= 2000) { fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength; }
        }
      }
    }
    for (const link of links) {
      const dx = px[link.b]! - px[link.a]!, dy = py[link.b]! - py[link.a]!, dz = pz[link.b]! - pz[link.a]!, distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - link.length) * link.strength / distance;
      fx[link.a]! += dx * spring; fy[link.a]! += dy * spring; fz[link.a]! += dz * spring;
      fx[link.b]! -= dx * spring; fy[link.b]! -= dy * spring; fz[link.b]! -= dz * spring;
    }
    const cooling = 1 - step / 230;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const dx = fx[i]! - px[i]! * 0.0005, dy = fy[i]! - py[i]! * 0.0005, dz = fz[i]! - pz[i]! * 0.0005;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      px[i]! += dx * stepScale; py[i]! += dy * stepScale; pz[i]! += dz * stepScale;
    }
    step++;
  };
  return {
    /** Fraction of the fixed relaxation budget consumed; an empty graph is already complete. */
    get progress() { return count ? step / MEMORY_3D_LAYOUT_STEPS : 1; },
    /** Whether further advances would leave the current coordinates unchanged. */
    get done() { return !count || step >= MEMORY_3D_LAYOUT_STEPS; },
    /** Consume at most this many whole iterations, stopping at the shared layout budget. */
    advance(iterations = 1) {
      const end = Math.min(MEMORY_3D_LAYOUT_STEPS, step + Math.max(0, Math.floor(iterations)));
      while (count && step < end) iterate();
    },
    /** Copy coordinates so later iterations cannot mutate an already published frame. */
    snapshot: () => new Map(ordered.map((node, i) => [node.id, { x: px[i]!, y: py[i]!, z: pz[i]! }]))
  };
}

/** Synchronous convenience API for small graphs and pure layout tests. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const simulation = createMemoryNetwork3DSimulation(nodes, edges);
  simulation.advance(MEMORY_3D_LAYOUT_STEPS);
  return simulation.snapshot();
}

/** Project rotated XYZ into CSS pixels, retaining depth and the near-plane clamp shared by GPU rendering and picking. */
export function projectMemoryPoint(point: MemoryPoint3D, camera: MemoryCamera3D, scale: number, width: number, height: number) {
  const x = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const depth = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const y = point.y * Math.cos(camera.pitch) - depth * Math.sin(camera.pitch);
  const z = point.y * Math.sin(camera.pitch) + depth * Math.cos(camera.pitch);
  const perspective = 650 / Math.max(120, 650 + z * scale);
  return { x: width / 2 + x * scale * camera.zoom * perspective, y: height / 2 - y * scale * camera.zoom * perspective, z, perspective };
}

/** Normalized covariance determinant: 0 for a plane, 1 for equal spread in XYZ. */
export function memory3DVolumeRatio(points: MemoryPoint3D[]): number {
  if (points.length < 4) return 0;
  const center = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length, z: sum.z + p.z / points.length }), { x: 0, y: 0, z: 0 });
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const p of points) {
    const x = p.x - center.x, y = p.y - center.y, z = p.z - center.z;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}
