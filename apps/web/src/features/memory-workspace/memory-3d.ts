import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { createMemoryLayout3D, type MemoryPoint3D } from "./memory-3d-layout.js";
export { createMemoryLayout3D } from "./memory-3d-layout.js";
export type { MemoryPoint3D } from "./memory-3d-layout.js";
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };

/** Synchronous compatibility wrapper for callers that do not need streamed worker snapshots. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const simulation = createMemoryLayout3D(nodes, edges);
  simulation.advance(180);
  return simulation.toMap();
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
export function memory3DVolumeRatio(points: readonly MemoryPoint3D[] | ReadonlyMap<string, MemoryPoint3D>): number {
  const count = "size" in points ? points.size : points.length;
  if (count < 4) return 0;
  // Both collections can be traversed twice without copying streamed coordinates.
  // Divide each term before adding to preserve the original rounding/order.
  let centerX = 0, centerY = 0, centerZ = 0;
  for (const p of points.values()) {
    centerX += p.x / count; centerY += p.y / count; centerZ += p.z / count;
  }
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const p of points.values()) {
    const x = p.x - centerX, y = p.y - centerY, z = p.z - centerZ;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}
