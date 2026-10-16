import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { compareMemoryIds } from "./memory-order.js";
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

export const LAYOUT_STEPS_3D = 180;
const CELL = 32;

/** Incremental state of the 3D force layout. Positions are structure-of-arrays in model units. */
export interface MemoryLayoutState3D {
  ids: string[];
  count: number;
  root: number;
  step: number;
  x: Float64Array; y: Float64Array; z: Float64Array;
  fx: Float64Array; fy: Float64Array; fz: Float64Array;
  isSource: Uint8Array;
  linkA: Int32Array; linkB: Int32Array; linkLength: Float64Array; linkStrength: Float64Array;
  cell: Int32Array; // scratch: cell index of every node for the current step
  cellStart: Int32Array; // scratch: counting-sort offsets, grown on demand
  members: Int32Array; // scratch: node indices grouped by cell, ascending within a cell
}

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function createLayoutState(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], presorted = false): MemoryLayoutState3D {
  // `presorted` lets a caller that already ordered the nodes by id skip a second 50k-element sort.
  const ordered = presorted ? nodes : [...nodes].sort((a, b) => compareMemoryIds(a.id, b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  const x = new Float64Array(count), y = new Float64Array(count), z = new Float64Array(count);
  ordered.forEach((node, i) => {
    x[i] = (unit(`${node.id}:x`) - 0.5) * 260;
    y[i] = (unit(`${node.id}:y`) - 0.5) * 260;
    z[i] = (unit(`${node.id}:z`) - 0.5) * 260;
  });
  if (root >= 0) { x[root] = 0; y[root] = 0; z[root] = 0; }
  const sortedEdges = [...edges].sort((a, b) => compareMemoryIds(a.id, b.id));
  const linkA: number[] = [], linkB: number[] = [], linkLength: number[] = [], linkStrength: number[] = [];
  for (const edge of sortedEdges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    const fileLink = ordered[a]!.type === "SOURCE" && ordered[b]!.type === "SOURCE";
    linkA.push(a); linkB.push(b);
    linkLength.push(fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55);
    linkStrength.push(fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004);
  }
  // Initialize records around their actual file, in a volume rather than a plane.
  // Sorted edge order keeps a record with several parents independent of input order.
  for (const edge of sortedEdges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type !== "CONTAINS" || a === undefined || b === undefined || ordered[a]!.type !== "SOURCE" || ordered[b]!.type !== "MEMORY") continue;
    const px = x[a]!, py = y[a]!, pz = z[a]!, id = ordered[b]!.id;
    x[b] = px + (unit(`${id}:dx`) - 0.5) * 70;
    y[b] = py + (unit(`${id}:dy`) - 0.5) * 70;
    z[b] = pz + (unit(`${id}:dz`) - 0.5) * 70;
  }
  return {
    ids: ordered.map(node => node.id), count, root, step: 0, x, y, z,
    fx: new Float64Array(count), fy: new Float64Array(count), fz: new Float64Array(count),
    isSource: Uint8Array.from(ordered, node => node.type === "SOURCE" ? 1 : 0),
    linkA: Int32Array.from(linkA), linkB: Int32Array.from(linkB),
    linkLength: Float64Array.from(linkLength), linkStrength: Float64Array.from(linkStrength),
    cell: new Int32Array(count), cellStart: new Int32Array(0), members: new Int32Array(count)
  };
}

/**
 * Advance the layout by up to `steps` steps; returns true when all steps are done.
 * Repulsion uses a dense uniform grid (counting sort by cell). Cells are visited in the same
 * x/y/z order and members ascend by index, so floating-point sums match the original Map grid.
 * A step moves a node by at most 4 units, so the grid extent stays bounded.
 */
export function stepLayout(state: MemoryLayoutState3D, steps: number): boolean {
  const { count, x, y, z, fx, fy, fz, isSource, root, linkA, linkB, linkLength, linkStrength, cell, members } = state;
  const linkCount = linkA.length;
  const target = Math.min(LAYOUT_STEPS_3D, state.step + Math.max(0, steps));
  for (; state.step < target; state.step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const gx = Math.floor(x[i]! / CELL), gy = Math.floor(y[i]! / CELL), gz = Math.floor(z[i]! / CELL);
      if (gx < minX) minX = gx; if (gx > maxX) maxX = gx;
      if (gy < minY) minY = gy; if (gy > maxY) maxY = gy;
      if (gz < minZ) minZ = gz; if (gz > maxZ) maxZ = gz;
    }
    // One cell of padding on every side so the 3x3x3 neighbourhood never leaves the grid.
    const dimX = count ? maxX - minX + 3 : 0, dimY = count ? maxY - minY + 3 : 0, dimZ = count ? maxZ - minZ + 3 : 0;
    const cells = dimX * dimY * dimZ;
    if (state.cellStart.length < cells + 1) state.cellStart = new Int32Array(cells + 1);
    const start = state.cellStart;
    start.fill(0, 0, cells + 1);
    for (let i = 0; i < count; i++) {
      const c = ((Math.floor(x[i]! / CELL) - minX + 1) * dimY + (Math.floor(y[i]! / CELL) - minY + 1)) * dimZ + (Math.floor(z[i]! / CELL) - minZ + 1);
      cell[i] = c; start[c + 1]!++;
    }
    for (let c = 0; c < cells; c++) start[c + 1]! += start[c]!;
    // Placement cursor per cell; ascending i keeps members ascending within each cell.
    const cursor = start.slice(0, cells);
    for (let i = 0; i < count; i++) members[cursor[cell[i]!]!++] = i;
    for (let i = 0; i < count; i++) {
      const px = x[i]!, py = y[i]!, pz = z[i]!;
      const gx = Math.floor(px / CELL) - minX + 1, gy = Math.floor(py / CELL) - minY + 1, gz = Math.floor(pz / CELL) - minZ + 1;
      const si = isSource[i]!;
      for (let cx = gx - 1; cx <= gx + 1; cx++) for (let cy = gy - 1; cy <= gy + 1; cy++) for (let cz = gz - 1; cz <= gz + 1; cz++) {
        const c = (cx * dimY + cy) * dimZ + cz;
        for (let m = start[c]!, end = start[c + 1]!; m < end; m++) {
          const j = members[m]!;
          if (j <= i) continue;
          const dx = px - x[j]!, dy = py - y[j]!, dz = pz - z[j]!;
          const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
          const strength = (si || isSource[j]! ? 28 : 12) / distanceSquared;
          fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
          fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
        }
      }
    }
    for (let l = 0; l < linkCount; l++) {
      const a = linkA[l]!, b = linkB[l]!;
      const dx = x[b]! - x[a]!, dy = y[b]! - y[a]!, dz = z[b]! - z[a]!, distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - linkLength[l]!) * linkStrength[l]! / distance;
      fx[a]! += dx * spring; fy[a]! += dy * spring; fz[a]! += dz * spring;
      fx[b]! -= dx * spring; fy[b]! -= dy * spring; fz[b]! -= dz * spring;
    }
    const cooling = 1 - state.step / 230;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const dx = fx[i]! - x[i]! * 0.0005, dy = fy[i]! - y[i]! * 0.0005, dz = fz[i]! - z[i]! * 0.0005;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      x[i]! += dx * stepScale; y[i]! += dy * stepScale; z[i]! += dz * stepScale;
    }
  }
  return state.step >= LAYOUT_STEPS_3D;
}

export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const state = createLayoutState(nodes, edges);
  stepLayout(state, LAYOUT_STEPS_3D);
  return new Map(state.ids.map((id, i) => [id, { x: state.x[i]!, y: state.y[i]!, z: state.z[i]! }]));
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
