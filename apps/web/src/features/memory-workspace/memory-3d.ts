import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };
export const MAX_VISIBLE_LABELS_3D = 64;

export interface ProjectedMemoryNode {
  id: string;
  x: number;
  y: number;
  z: number;
  perspective: number;
  radius: number;
}

export interface SpatialPickIndex2D {
  cellSize: number;
  buckets: Map<string, ProjectedMemoryNode[]>;
}

// Avalanche each seed so the three axes are independent even for similar file IDs.
const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

/** Independent XYZ force layout. Supports incremental streaming callbacks for 50k+ node graphs. */
export function layoutMemoryNetwork3D(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  options?: {
    steps?: number;
    streamIntervalSteps?: number;
    onProgress?: (positions: Map<string, MemoryPoint3D>, step: number) => void;
  }
): Map<string, MemoryPoint3D> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  const points = ordered.map(node => ({
    x: (unit(`${node.id}:x`) - 0.5) * 260,
    y: (unit(`${node.id}:y`) - 0.5) * 260,
    z: (unit(`${node.id}:z`) - 0.5) * 260
  }));
  if (root >= 0) points[root] = { x: 0, y: 0, z: 0 };
  const links = [...edges].sort((a, b) => a.id.localeCompare(b.id)).flatMap(edge => {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) return [];
    const fileLink = ordered[a]!.type === "SOURCE" && ordered[b]!.type === "SOURCE";
    return [{ a, b, length: fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55,
      strength: fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004 }];
  });
  // Initialize records around their actual file, in a volume rather than a plane.
  for (const edge of edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type !== "CONTAINS" || a === undefined || b === undefined || ordered[a]!.type !== "SOURCE" || ordered[b]!.type !== "MEMORY") continue;
    const parent = points[a]!, id = ordered[b]!.id;
    points[b] = { x: parent.x + (unit(`${id}:dx`) - 0.5) * 70,
      y: parent.y + (unit(`${id}:dy`) - 0.5) * 70, z: parent.z + (unit(`${id}:dz`) - 0.5) * 70 };
  }
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  const totalSteps = options?.steps ?? (count > 10_000 ? 36 : 180);
  const streamEvery = options?.streamIntervalSteps ?? 12;
  // Bounded spatial-grid repulsion and link springs act equally on all three axes.
  for (let step = 0; step < totalSteps; step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    const grid = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const p = points[i]!, key = `${Math.floor(p.x / 32)},${Math.floor(p.y / 32)},${Math.floor(p.z / 32)}`;
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      if (bucket.length < 24) bucket.push(i);
    }
    for (let i = 0; i < count; i++) {
      const p = points[i]!, gx = Math.floor(p.x / 32), gy = Math.floor(p.y / 32), gz = Math.floor(p.z / 32);
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
        for (const j of grid.get(`${x},${y},${z}`) ?? []) {
          if (j <= i) continue;
          const q = points[j]!, dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
          const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
          const strength = (ordered[i]!.type === "SOURCE" || ordered[j]!.type === "SOURCE" ? 28 : 12) / distanceSquared;
          fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
          fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
        }
      }
    }
    for (const link of links) {
      const a = points[link.a]!, b = points[link.b]!;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - link.length) * link.strength / distance;
      fx[link.a]! += dx * spring; fy[link.a]! += dy * spring; fz[link.a]! += dz * spring;
      fx[link.b]! -= dx * spring; fy[link.b]! -= dy * spring; fz[link.b]! -= dz * spring;
    }
    const cooling = 1 - step / 230;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const p = points[i]!;
      const dx = fx[i]! - p.x * 0.0005, dy = fy[i]! - p.y * 0.0005, dz = fz[i]! - p.z * 0.0005;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      p.x += dx * stepScale; p.y += dy * stepScale; p.z += dz * stepScale;
    }
    if (options?.onProgress && (step + 1) % streamEvery === 0 && step + 1 < totalSteps) {
      options.onProgress(new Map(ordered.map((node, i) => [node.id, { ...points[i]! }])), step + 1);
    }
  }
  const finalMap = new Map(ordered.map((node, i) => [node.id, points[i]!]));
  options?.onProgress?.(finalMap, totalSteps);
  return finalMap;
}

export function projectMemoryPoint(point: MemoryPoint3D, camera: MemoryCamera3D, scale: number, width: number, height: number) {
  const x = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const depth = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const y = point.y * Math.cos(camera.pitch) - depth * Math.sin(camera.pitch);
  const z = point.y * Math.sin(camera.pitch) + depth * Math.cos(camera.pitch);
  const perspective = 650 / Math.max(120, 650 + z * scale);
  return { x: width / 2 + x * scale * camera.zoom * perspective, y: height / 2 - y * scale * camera.zoom * perspective, z, perspective };
}

/** O(1) cell-bucketed spatial index for sub-millisecond hover/click picking at 50,000+ nodes. */
export function buildProjectedSpatialIndex(points: ProjectedMemoryNode[], cellSize = 24): SpatialPickIndex2D {
  const buckets = new Map<string, ProjectedMemoryNode[]>();
  for (const pt of points) {
    const cx = Math.floor(pt.x / cellSize);
    const cy = Math.floor(pt.y / cellSize);
    const key = `${cx},${cy}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(pt);
  }
  return { cellSize, buckets };
}

/** Picks the front-most (smallest z) node within hit radius using the 2D spatial index (< 1 ms at 50k nodes). */
export function pickMemoryNodeAt(index: SpatialPickIndex2D, x: number, y: number): string | null {
  const cx = Math.floor(x / index.cellSize);
  const cy = Math.floor(y / index.cellSize);
  let best: ProjectedMemoryNode | null = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = index.buckets.get(`${cx + dx},${cy + dy}`);
      if (!bucket) continue;
      for (const candidate of bucket) {
        const hitRadius = Math.max(7, candidate.radius + 3);
        if (Math.hypot(candidate.x - x, candidate.y - y) < hitRadius) {
          if (!best || candidate.z < best.z) {
            best = candidate;
          }
        }
      }
    }
  }
  return best?.id ?? null;
}

/** Selects at most maxLabels candidate nodes for label measurement/rendering per frame (core & source first). */
export function selectVisibleMemoryLabelsLOD(
  nodes: MemoryGraphNode[],
  focusNodeId: string | null,
  zoom: number,
  maxLabels = MAX_VISIBLE_LABELS_3D
): MemoryGraphNode[] {
  const eligible = nodes.filter(
    node => node.id === focusNodeId || node.type === "SOURCE" || zoom >= 1.6
  );
  eligible.sort(
    (a, b) =>
      Number(b.id === focusNodeId) - Number(a.id === focusNodeId) ||
      Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) ||
      Number(b.type === "SOURCE") - Number(a.type === "SOURCE") ||
      a.id.localeCompare(b.id)
  );
  return eligible.slice(0, maxLabels);
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
