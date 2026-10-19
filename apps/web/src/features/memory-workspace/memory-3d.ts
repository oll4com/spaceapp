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

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const steps = streamMemoryNetwork3D(nodes, edges);
  for (;;) { const next = steps.next(); if (next.done) return next.value; }
}

export function* streamMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Generator<{ step: number; positions: Map<string, MemoryPoint3D> }, Map<string, MemoryPoint3D>> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
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
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type !== "CONTAINS" || a === undefined || b === undefined || ordered[a]!.type !== "SOURCE" || ordered[b]!.type !== "MEMORY") continue;
    const parent = points[a]!, id = ordered[b]!.id;
    points[b] = { x: parent.x + (unit(`${id}:dx`) - 0.5) * 70,
      y: parent.y + (unit(`${id}:dy`) - 0.5) * 70, z: parent.z + (unit(`${id}:dz`) - 0.5) * 70 };
  }
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  // With <=50k nodes and <=4 units per step for 180 steps, all cells stay
  // within [-512, 511]. Exact numeric keys avoid millions of string allocations.
  const cellKey = (x: number, y: number, z: number): string | number => count > 2000
    ? (x + 512) * 1048576 + (y + 512) * 1024 + z + 512 : `${x},${y},${z}`;
  const snapshot = () => new Map(ordered.map((node, i) => [node.id, { ...points[i]! }]));
  yield { step: 0, positions: snapshot() };
  // Bounded spatial-grid repulsion and link springs act equally on all three axes.
  for (let step = 0; step < 180; step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    const grid = new Map<string | number, number[]>();
    for (let i = 0; i < count; i++) {
      const p = points[i]!, key = cellKey(Math.floor(p.x / 32), Math.floor(p.y / 32), Math.floor(p.z / 32));
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push(i);
    }
    // Dense archive cells use their centroid rather than quadratic all-pairs work.
    // Small graphs retain the existing force law exactly.
    const centers = new Map<string | number, { x: number; y: number; z: number; count: number }>();
    if (count > 2000) for (const [key, bucket] of grid) {
      if (bucket.length <= 32) continue;
      const center = { x: 0, y: 0, z: 0, count: bucket.length };
      for (const j of bucket) { center.x += points[j]!.x; center.y += points[j]!.y; center.z += points[j]!.z; }
      centers.set(key, center);
    }
    for (let i = 0; i < count; i++) {
      const p = points[i]!, gx = Math.floor(p.x / 32), gy = Math.floor(p.y / 32), gz = Math.floor(p.z / 32);
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
        const key = cellKey(x, y, z), center = centers.get(key);
        if (center) {
          const own = Number(x === gx && y === gy && z === gz), weight = center.count - own;
          if (!weight) continue;
          const dx = p.x - (center.x - own * p.x) / weight, dy = p.y - (center.y - own * p.y) / weight, dz = p.z - (center.z - own * p.z) / weight;
          const strength = 12 * weight / Math.max(1, dx * dx + dy * dy + dz * dz);
          fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
          continue;
        }
        for (const j of grid.get(key) ?? []) {
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
    if ((step + 1) % 12 === 0) yield { step: step + 1, positions: snapshot() };
  }
  return snapshot();
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
export function memory3DVolumeRatio(points: MemoryPoint3D[] | Float32Array): number {
  if (points instanceof Float32Array) {
    const count = points.length / 3;
    if (count < 4) return 0;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < points.length; i += 3) { cx += points[i]! / count; cy += points[i + 1]! / count; cz += points[i + 2]! / count; }
    let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
    for (let i = 0; i < points.length; i += 3) {
      const x = points[i]! - cx, y = points[i + 1]! - cy, z = points[i + 2]! - cz;
      xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
    }
    return Math.max(0, (xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy) / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
  }
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
