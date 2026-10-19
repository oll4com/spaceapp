import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };
export const MEMORY_3D_LAYOUT_STEPS = 180;
/** Above this size the worker uses deterministic centroid repulsion so a step stays short. */
export const MEMORY_3D_FAST_LAYOUT_MIN_NODES = 2_500;
const CELL = 32;

export type Memory3DLayoutMode = "exact" | "fast";

export interface MemoryNetwork3DSimulation {
  readonly ids: readonly string[];
  readonly mode: Memory3DLayoutMode;
  readonly step: number;
  readonly steps: number;
  readonly done: boolean;
  advance(stepCount?: number): { step: number; done: boolean };
  writePositions(target: Float32Array): void;
}

// Avalanche each seed so the three axes are independent even for similar file IDs.
const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

type PreparedLayout = {
  ids: string[];
  points: MemoryPoint3D[];
  root: number;
  links: Array<{ a: number; b: number; length: number; strength: number }>;
  source: Uint8Array;
};

function prepareLayout(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): PreparedLayout {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
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
  const source = new Uint8Array(ordered.length);
  ordered.forEach((node, i) => { if (node.type === "SOURCE") source[i] = 1; });
  return { ids: ordered.map(node => node.id), points, root, links, source };
}

function integrate(points: MemoryPoint3D[], fx: Float64Array, fy: Float64Array, fz: Float64Array, root: number, step: number) {
  const cooling = 1 - step / 230;
  for (let i = 0; i < points.length; i++) {
    if (i === root) continue;
    const p = points[i]!;
    const dx = fx[i]! - p.x * 0.0005, dy = fy[i]! - p.y * 0.0005, dz = fz[i]! - p.z * 0.0005;
    const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
    p.x += dx * stepScale; p.y += dy * stepScale; p.z += dz * stepScale;
  }
}

function applySprings(points: MemoryPoint3D[], links: PreparedLayout["links"], fx: Float64Array, fy: Float64Array, fz: Float64Array) {
  for (const link of links) {
    const a = points[link.a]!, b = points[link.b]!;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, distance = Math.max(0.01, Math.hypot(dx, dy, dz));
    const spring = (distance - link.length) * link.strength / distance;
    fx[link.a]! += dx * spring; fy[link.a]! += dy * spring; fz[link.a]! += dz * spring;
    fx[link.b]! -= dx * spring; fy[link.b]! -= dy * spring; fz[link.b]! -= dz * spring;
  }
}

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const simulation = createMemoryNetwork3DLayout(nodes, edges);
  simulation.advance(simulation.steps);
  return new Map(simulation.ids.map((id, index) => {
    const point = (simulation as ExactSimulation).pointAt(index);
    return [id, { x: point.x, y: point.y, z: point.z }];
  }));
}

interface ExactSimulation extends MemoryNetwork3DSimulation {
  pointAt(index: number): MemoryPoint3D;
}

export function createMemoryNetwork3DLayout(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  options: { mode?: Memory3DLayoutMode } = {}
): ExactSimulation {
  const prepared = prepareLayout(nodes, edges);
  const mode = options.mode ?? (prepared.ids.length > MEMORY_3D_FAST_LAYOUT_MIN_NODES ? "fast" : "exact");
  const count = prepared.ids.length;
  const fx = new Float64Array(count);
  const fy = new Float64Array(count);
  const fz = new Float64Array(count);
  let step = 0;
  const points = prepared.points;

  const runExact = () => {
    fx.fill(0); fy.fill(0); fz.fill(0);
    const grid = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      const key = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)},${Math.floor(p.z / CELL)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    }
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      const gx = Math.floor(p.x / CELL), gy = Math.floor(p.y / CELL), gz = Math.floor(p.z / CELL);
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
        for (const j of grid.get(`${x},${y},${z}`) ?? []) {
          if (j <= i) continue;
          const q = points[j]!;
          const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
          const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
          const strength = (prepared.source[i] || prepared.source[j]) ? 28 : 12;
          const force = strength / distanceSquared;
          fx[i]! += dx * force; fy[i]! += dy * force; fz[i]! += dz * force;
          fx[j]! -= dx * force; fy[j]! -= dy * force; fz[j]! -= dz * force;
        }
      }
    }
    applySprings(points, prepared.links, fx, fy, fz);
    integrate(points, fx, fy, fz, prepared.root, step);
  };

  const linkCount = prepared.links.length;
  const linkA = new Uint32Array(linkCount);
  const linkB = new Uint32Array(linkCount);
  const linkLength = new Float32Array(linkCount);
  const linkStrength = new Float32Array(linkCount);
  for (let index = 0; index < linkCount; index++) {
    const link = prepared.links[index]!;
    linkA[index] = link.a;
    linkB[index] = link.b;
    linkLength[index] = link.length;
    linkStrength[index] = link.strength;
  }
  const GRID_BITS = 18;
  const GRID_SIZE = 1 << GRID_BITS;
  const GRID_MASK = GRID_SIZE - 1;
  const cellHead = new Int32Array(GRID_SIZE);
  const cellNext = new Int32Array(count);
  const cellIX = new Int16Array(count);
  const cellIY = new Int16Array(count);
  const cellIZ = new Int16Array(count);
  const cellN = new Int32Array(count);
  const cellSx = new Float64Array(count);
  const cellSy = new Float64Array(count);
  const cellSz = new Float64Array(count);
  const cellSource = new Uint8Array(count);
  const nodeX = new Int16Array(count);
  const nodeY = new Int16Array(count);
  const nodeZ = new Int16Array(count);
  const hashCoords = (ix: number, iy: number, iz: number) =>
    (Math.imul(ix, 0x9e3779b1) ^ Math.imul(iy, 0x85ebca6b) ^ Math.imul(iz, 0xc2b2ae35)) >>> 0 & GRID_MASK;
  const clampCell = (value: number) => Math.max(-32767, Math.min(32767, value));

  const findCell = (ix: number, iy: number, iz: number) => {
    for (let slot = cellHead[hashCoords(ix, iy, iz)] ?? -1; slot >= 0; slot = cellNext[slot] ?? -1) {
      if (cellIX[slot] === ix && cellIY[slot] === iy && cellIZ[slot] === iz) return slot;
    }
    return -1;
  };

  const runFast = () => {
    fx.fill(0); fy.fill(0); fz.fill(0);
    cellHead.fill(-1);
    let slots = 0;
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      const ix = clampCell(Math.floor(p.x / CELL)), iy = clampCell(Math.floor(p.y / CELL)), iz = clampCell(Math.floor(p.z / CELL));
      nodeX[i] = ix; nodeY[i] = iy; nodeZ[i] = iz;
      const hashed = hashCoords(ix, iy, iz);
      let slot = findCell(ix, iy, iz);
      if (slot < 0) {
        slot = slots;
        slots += 1;
        cellNext[slot] = cellHead[hashed] ?? -1;
        cellHead[hashed] = slot;
        cellIX[slot] = ix;
        cellIY[slot] = iy;
        cellIZ[slot] = iz;
        cellN[slot] = 0;
        cellSx[slot] = 0;
        cellSy[slot] = 0;
        cellSz[slot] = 0;
        cellSource[slot] = 0;
      }
      cellN[slot] = (cellN[slot] ?? 0) + 1;
      cellSx[slot] = (cellSx[slot] ?? 0) + p.x;
      cellSy[slot] = (cellSy[slot] ?? 0) + p.y;
      cellSz[slot] = (cellSz[slot] ?? 0) + p.z;
      if (prepared.source[i]) cellSource[slot] = 1;
    }
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      const ix = nodeX[i] ?? 0, iy = nodeY[i] ?? 0, iz = nodeZ[i] ?? 0;
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
        const neighbor = findCell(ix + ox, iy + oy, iz + oz);
        if (neighbor < 0) continue;
        const population = cellN[neighbor] ?? 0;
        const self = ox === 0 && oy === 0 && oz === 0;
        const others = self ? population - 1 : population;
        if (others <= 0) continue;
        const qx = self ? ((cellSx[neighbor] ?? 0) - p.x) / others : (cellSx[neighbor] ?? 0) / population;
        const qy = self ? ((cellSy[neighbor] ?? 0) - p.y) / others : (cellSy[neighbor] ?? 0) / population;
        const qz = self ? ((cellSz[neighbor] ?? 0) - p.z) / others : (cellSz[neighbor] ?? 0) / population;
        const dx = p.x - qx, dy = p.y - qy, dz = p.z - qz;
        const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
        const strength = (prepared.source[i] || cellSource[neighbor]) ? 28 : 12;
        const force = strength * Math.min(24, others) / distanceSquared;
        fx[i]! += dx * force; fy[i]! += dy * force; fz[i]! += dz * force;
      }
    }
    for (let index = 0; index < linkCount; index++) {
      const a = linkA[index] ?? 0;
      const b = linkB[index] ?? 0;
      const pa = points[a]!, pb = points[b]!;
      const dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
      const distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - (linkLength[index] ?? 0)) * (linkStrength[index] ?? 0) / distance;
      fx[a]! += dx * spring; fy[a]! += dy * spring; fz[a]! += dz * spring;
      fx[b]! -= dx * spring; fy[b]! -= dy * spring; fz[b]! -= dz * spring;
    }
    integrate(points, fx, fy, fz, prepared.root, step);
  };

  const simulation: ExactSimulation = {
    ids: prepared.ids,
    mode,
    get step() { return step; },
    steps: MEMORY_3D_LAYOUT_STEPS,
    get done() { return step >= MEMORY_3D_LAYOUT_STEPS || count === 0; },
    advance(stepCount = 1) {
      const target = Math.min(MEMORY_3D_LAYOUT_STEPS, step + Math.max(0, stepCount));
      const run = mode === "fast" ? runFast : runExact;
      while (step < target) {
        run();
        step += 1;
      }
      if (count === 0) step = MEMORY_3D_LAYOUT_STEPS;
      return { step, done: step >= MEMORY_3D_LAYOUT_STEPS };
    },
    writePositions(target) {
      const length = Math.min(target.length, count * 3);
      for (let i = 0, cursor = 0; cursor < length; i++) {
        const point = points[i]!;
        target[cursor++] = point.x;
        target[cursor++] = point.y;
        target[cursor++] = point.z;
      }
    },
    pointAt(index: number) {
      return points[index] ?? { x: 0, y: 0, z: 0 };
    }
  };
  if (count === 0) step = MEMORY_3D_LAYOUT_STEPS;
  return simulation;
}

export function projectMemoryPoint(point: MemoryPoint3D, camera: MemoryCamera3D, scale: number, width: number, height: number) {
  const x = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const depth = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const y = point.y * Math.cos(camera.pitch) - depth * Math.sin(camera.pitch);
  const z = point.y * Math.sin(camera.pitch) + depth * Math.cos(camera.pitch);
  const perspective = 650 / Math.max(120, 650 + z * scale);
  return { x: width / 2 + x * scale * camera.zoom * perspective, y: height / 2 - y * scale * camera.zoom * perspective, z, perspective };
}

/** Project every node with the same camera math as `projectMemoryPoint`. */
export function projectMemoryPoints(
  xyz: Float32Array,
  count: number,
  camera: MemoryCamera3D,
  scale: number,
  width: number,
  height: number,
  outX: Float32Array,
  outY: Float32Array,
  outZ: Float32Array,
  outPerspective: Float32Array
) {
  const yawCos = Math.cos(camera.yaw), yawSin = Math.sin(camera.yaw);
  const pitchCos = Math.cos(camera.pitch), pitchSin = Math.sin(camera.pitch);
  const zoomScale = scale * camera.zoom;
  const halfWidth = width / 2, halfHeight = height / 2;
  for (let index = 0, cursor = 0; index < count; index++, cursor += 3) {
    const px = xyz[cursor] ?? 0, py = xyz[cursor + 1] ?? 0, pz = xyz[cursor + 2] ?? 0;
    const x = px * yawCos + pz * yawSin;
    const depth = -px * yawSin + pz * yawCos;
    const y = py * pitchCos - depth * pitchSin;
    const z = py * pitchSin + depth * pitchCos;
    const perspective = 650 / Math.max(120, 650 + z * scale);
    outX[index] = halfWidth + x * zoomScale * perspective;
    outY[index] = halfHeight - y * zoomScale * perspective;
    outZ[index] = z;
    outPerspective[index] = perspective;
  }
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

export function memory3DExtent(xyz: ArrayLike<number>): number {
  let max = 60;
  for (let index = 0; index + 2 < xyz.length; index += 3) {
    const span = Math.hypot(xyz[index] ?? 0, xyz[index + 1] ?? 0, xyz[index + 2] ?? 0);
    if (span > max) max = span;
  }
  return max;
}
