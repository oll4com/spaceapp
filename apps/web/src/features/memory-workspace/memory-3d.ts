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

type Memory3DLink = { a: number; b: number; length: number; strength: number };

export type Memory3DLayoutState = {
  ids: string[];
  nodeTypes: Uint8Array;
  points: MemoryPoint3D[];
  links: Memory3DLink[];
  root: number;
  fx: Float64Array;
  fy: Float64Array;
  fz: Float64Array;
  step: number;
  totalSteps: number;
};

export type CompactMemory3DLayoutInput = {
  ids: string[];
  nodeTypes: Uint8Array;
  root: number;
  edgeEndpoints: Uint32Array;
  edgeKinds: Uint8Array;
};

function createMemory3DLayoutState(
  ids: string[],
  nodeTypes: Uint8Array,
  root: number,
  edgeEndpoints: Uint32Array,
  edgeKinds: Uint8Array,
  totalSteps: number
): Memory3DLayoutState {
  const count = ids.length;
  const points = ids.map(id => ({
    x: (unit(`${id}:x`) - 0.5) * 260,
    y: (unit(`${id}:y`) - 0.5) * 260,
    z: (unit(`${id}:z`) - 0.5) * 260
  }));
  if (root >= 0) points[root] = { x: 0, y: 0, z: 0 };
  const links: Memory3DLink[] = [];
  for (let index = 0; index < edgeKinds.length; index++) {
    const a = edgeEndpoints[index * 2]!;
    const b = edgeEndpoints[index * 2 + 1]!;
    if (a === b || a >= count || b >= count) continue;
    const fileLink = nodeTypes[a] === 1 && nodeTypes[b] === 1;
    const contains = edgeKinds[index] === 1;
    links.push({ a, b, length: fileLink ? 110 : contains ? 34 : 55,
      strength: fileLink ? 0.035 : contains ? 0.028 : 0.004 });
    if (contains && nodeTypes[a] === 1 && nodeTypes[b] !== 1) {
      const parent = points[a]!, id = ids[b]!;
      points[b] = { x: parent.x + (unit(`${id}:dx`) - 0.5) * 70,
        y: parent.y + (unit(`${id}:dy`) - 0.5) * 70, z: parent.z + (unit(`${id}:dz`) - 0.5) * 70 };
    }
  }
  return {
    ids, nodeTypes, points, links, root,
    fx: new Float64Array(count), fy: new Float64Array(count), fz: new Float64Array(count),
    step: 0, totalSteps
  };
}

/** Creates the deterministic layout state without blocking on force relaxation. */
export function createMemoryNetwork3DLayout(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], totalSteps = 180): Memory3DLayoutState {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const nodeTypes = Uint8Array.from(ordered, node => node.type === "SOURCE" ? 1 : 0);
  const sortedEdges = [...edges].sort((a, b) => a.id.localeCompare(b.id));
  const edgeEndpoints = new Uint32Array(sortedEdges.length * 2);
  const edgeKinds = new Uint8Array(sortedEdges.length);
  let edgeCount = 0;
  for (const edge of sortedEdges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    edgeEndpoints[edgeCount * 2] = a;
    edgeEndpoints[edgeCount * 2 + 1] = b;
    edgeKinds[edgeCount] = edge.type === "CONTAINS" ? 1 : 0;
    edgeCount++;
  }
  return createMemory3DLayoutState(
    ordered.map(node => node.id), nodeTypes, root,
    edgeEndpoints.slice(0, edgeCount * 2), edgeKinds.slice(0, edgeCount), totalSteps
  );
}

/** Creates the same deterministic force state from a compact transferable payload. */
export function createMemoryNetwork3DLayoutFromCompact(input: CompactMemory3DLayoutInput, totalSteps = 180): Memory3DLayoutState {
  return createMemory3DLayoutState(input.ids, input.nodeTypes, input.root, input.edgeEndpoints, input.edgeKinds, totalSteps);
}

/** Advances a bounded number of deterministic force steps for incremental worker delivery. */
export function stepMemoryNetwork3DLayout(state: Memory3DLayoutState, stepCount: number): boolean {
  const { nodeTypes, points, links, root, fx, fy, fz } = state;
  const count = points.length;
  const aggregateRepulsion = count > 5_000;
  const stop = Math.min(state.totalSteps, state.step + Math.max(0, stepCount));
  // Bounded spatial-grid repulsion and link springs act equally on all three axes.
  for (; state.step < stop; state.step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    if (aggregateRepulsion) {
      type Cell = { count: number; sourceCount: number; x: number; y: number; z: number };
      const grid = new Map<string, Cell>();
      for (let i = 0; i < count; i++) {
        const p = points[i]!, key = `${Math.floor(p.x / 32)},${Math.floor(p.y / 32)},${Math.floor(p.z / 32)}`;
        const cell = grid.get(key) ?? { count: 0, sourceCount: 0, x: 0, y: 0, z: 0 };
        cell.count++; cell.x += p.x; cell.y += p.y; cell.z += p.z;
        if (nodeTypes[i] === 1) cell.sourceCount++;
        grid.set(key, cell);
      }
      for (let i = 0; i < count; i++) {
        const p = points[i]!, gx = Math.floor(p.x / 32), gy = Math.floor(p.y / 32), gz = Math.floor(p.z / 32);
        for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
          const cell = grid.get(`${x},${y},${z}`);
          if (!cell) continue;
          const sameCell = x === gx && y === gy && z === gz;
          const peers = cell.count - (sameCell ? 1 : 0);
          if (peers <= 0) continue;
          const qx = (cell.x - (sameCell ? p.x : 0)) / peers;
          const qy = (cell.y - (sameCell ? p.y : 0)) / peers;
          const qz = (cell.z - (sameCell ? p.z : 0)) / peers;
          const dx = p.x - qx, dy = p.y - qy, dz = p.z - qz;
          const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
          const peerSources = cell.sourceCount - (sameCell && nodeTypes[i] === 1 ? 1 : 0);
          const strength = (nodeTypes[i] === 1 || peerSources > 0 ? 28 : 12) * peers / distanceSquared;
          fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
        }
      }
    } else {
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
            const strength = (nodeTypes[i] === 1 || nodeTypes[j] === 1 ? 28 : 12) / distanceSquared;
            fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
            fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
          }
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
    const cooling = 1 - state.step / 230;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const p = points[i]!;
      const dx = fx[i]! - p.x * 0.0005, dy = fy[i]! - p.y * 0.0005, dz = fz[i]! - p.z * 0.0005;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      p.x += dx * stepScale; p.y += dy * stepScale; p.z += dz * stepScale;
    }
  }
  return state.step >= state.totalSteps;
}

export function memoryNetwork3DLayoutSnapshot(state: Memory3DLayoutState): Map<string, MemoryPoint3D> {
  return new Map(state.ids.map((id, index) => [id, { ...state.points[index]! }]));
}

export function memoryNetwork3DLayoutCoordinates(state: Memory3DLayoutState): Float32Array {
  const coordinates = new Float32Array(state.points.length * 3);
  for (let index = 0; index < state.points.length; index++) {
    const point = state.points[index]!;
    coordinates[index * 3] = point.x;
    coordinates[index * 3 + 1] = point.y;
    coordinates[index * 3 + 2] = point.z;
  }
  return coordinates;
}

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const state = createMemoryNetwork3DLayout(nodes, edges);
  stepMemoryNetwork3DLayout(state, state.totalSteps);
  return memoryNetwork3DLayoutSnapshot(state);
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
