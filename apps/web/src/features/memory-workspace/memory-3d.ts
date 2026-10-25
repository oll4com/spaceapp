import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { MEMORY_LAYOUT_STEPS, MemoryLayout3DSimulation } from "./memory-3d-layout.js";
export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const simulation = new MemoryLayout3DSimulation(nodes, edges);
  simulation.advance(MEMORY_LAYOUT_STEPS);
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
export function memory3DVolumeRatio(points: MemoryPoint3D[]): number {
  const flat = new Float64Array(points.length * 3);
  points.forEach((p, i) => { flat[i * 3] = p.x; flat[i * 3 + 1] = p.y; flat[i * 3 + 2] = p.z; });
  return memory3DVolumeRatioFlat(flat);
}

/** Same ratio for x,y,z triples packed in a typed array. */
export function memory3DVolumeRatioFlat(coordinates: ArrayLike<number>): number {
  const count = Math.floor(coordinates.length / 3);
  if (count < 4) return 0;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < count; i++) { cx += coordinates[i * 3]! / count; cy += coordinates[i * 3 + 1]! / count; cz += coordinates[i * 3 + 2]! / count; }
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let i = 0; i < count; i++) {
    const x = coordinates[i * 3]! - cx, y = coordinates[i * 3 + 1]! - cy, z = coordinates[i * 3 + 2]! - cz;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}
