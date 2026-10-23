import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };

// Avalanche each seed so the three axes are independent even for similar file IDs.
const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

export const MEMORY_LAYOUT_3D_STEPS = 180;

export interface MemoryLayout3DOptions {
  /**
   * Incremental layout: called every `progressInterval` steps and once at the end with
   * fraction 1, carrying a packed XYZ buffer of the current positions. The simulation
   * itself is unchanged, so the final result stays deterministic for the same input.
   */
  onProgress?: (fraction: number, positions: Float32Array, count: number) => void;
  progressInterval?: number;
}

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], options: MemoryLayout3DOptions = {}): Map<string, MemoryPoint3D> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  // Scale the initial cloud with archive size: the repulsion grid stays sparse for
  // 50k nodes instead of packing them into the 2k-sized box (deterministic: a pure
  // function of the node count; archives at or below 2000 nodes are unchanged).
  const spread = 260 * Math.max(1, Math.cbrt(count / 2000));
  const points = ordered.map(node => ({
    x: (unit(`${node.id}:x`) - 0.5) * spread,
    y: (unit(`${node.id}:y`) - 0.5) * spread,
    z: (unit(`${node.id}:z`) - 0.5) * spread
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
  // Bounded spatial-grid repulsion and link springs act equally on all three axes.
  const progressInterval = options.progressInterval ?? 15;
  const progressBuffer = options.onProgress ? new Float32Array(count * 3) : null;
  const reportProgress = (step: number) => {
    if (!options.onProgress || !progressBuffer) return;
    for (let i = 0; i < count; i++) { progressBuffer[i * 3] = points[i]!.x; progressBuffer[i * 3 + 1] = points[i]!.y; progressBuffer[i * 3 + 2] = points[i]!.z; }
    options.onProgress(Math.min(1, (step + 1) / 180), progressBuffer, count);
  };
  for (let step = 0; step < MEMORY_LAYOUT_3D_STEPS; step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    const grid = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const p = points[i]!, key = `${Math.floor(p.x / 32)},${Math.floor(p.y / 32)},${Math.floor(p.z / 32)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push(i);
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
    if ((step + 1) % progressInterval === 0) reportProgress(step);
  }
  if (options.onProgress && (180 % progressInterval !== 0)) reportProgress(179);
  return new Map(ordered.map((node, i) => [node.id, points[i]!]));
}

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
