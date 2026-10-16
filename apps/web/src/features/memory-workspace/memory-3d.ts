import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };
export const FALLBACK_CANVAS_2D_NODE_CAP = 2000;
export const FALLBACK_CANVAS_2D_EDGE_CAP = 6000;
export const MAX_MEMORY_3D_LABELS_MEASURED = 96;
export const MAX_MEMORY_3D_LABELS_DRAWN = 40;

// Avalanche each seed so the three axes are independent even for similar file IDs.
const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

/**
 * Map-compatible 3D coordinate store backed by a contiguous typed array so 50k-node
 * worker updates and WebGL uploads avoid per-node heap allocations on the main thread.
 */
export class PackedMemoryCoordinates3D extends Map<string, MemoryPoint3D> {
  readonly ids: readonly string[];
  readonly xyz: Float32Array;
  readonly indexById: ReadonlyMap<string, number>;
  private cachedMaxExtent: number | null = null;
  private cachedVolumeRatio: number | null = null;

  constructor(
    ids: readonly string[],
    xyz: Float32Array | Float64Array,
    indexById?: ReadonlyMap<string, number>
  ) {
    super();
    this.ids = ids;
    this.xyz = xyz instanceof Float32Array ? xyz : new Float32Array(xyz);
    this.indexById = indexById ?? new Map(ids.map((id, index) => [id, index]));
  }

  override get size(): number {
    return this.ids.length;
  }

  override has(key: string): boolean {
    return this.indexById.has(key);
  }

  override get(key: string): MemoryPoint3D | undefined {
    const index = this.indexById.get(key);
    if (index === undefined) return undefined;
    const offset = index * 3;
    return {
      x: this.xyz[offset]!,
      y: this.xyz[offset + 1]!,
      z: this.xyz[offset + 2]!
    };
  }

  pointAt(index: number): MemoryPoint3D {
    const offset = index * 3;
    return {
      x: this.xyz[offset]!,
      y: this.xyz[offset + 1]!,
      z: this.xyz[offset + 2]!
    };
  }

  get maxExtent(): number {
    if (this.cachedMaxExtent !== null) return this.cachedMaxExtent;
    let maxSq = 60 * 60;
    const xyz = this.xyz;
    for (let offset = 0; offset < xyz.length; offset += 3) {
      const x = xyz[offset]!, y = xyz[offset + 1]!, z = xyz[offset + 2]!;
      const sq = x * x + y * y + z * z;
      if (sq > maxSq) maxSq = sq;
    }
    this.cachedMaxExtent = Math.sqrt(maxSq);
    return this.cachedMaxExtent;
  }

  get volumeRatio(): number {
    if (this.cachedVolumeRatio !== null) return this.cachedVolumeRatio;
    this.cachedVolumeRatio = computePackedVolumeRatio(this.xyz);
    return this.cachedVolumeRatio;
  }

  override *keys(): MapIterator<string> {
    for (let i = 0; i < this.ids.length; i++) yield this.ids[i]!;
  }

  override *values(): MapIterator<MemoryPoint3D> {
    for (let i = 0; i < this.ids.length; i++) yield this.pointAt(i);
  }

  override *entries(): MapIterator<[string, MemoryPoint3D]> {
    for (let i = 0; i < this.ids.length; i++) yield [this.ids[i]!, this.pointAt(i)];
  }

  override [Symbol.iterator](): MapIterator<[string, MemoryPoint3D]> {
    return this.entries();
  }

  override forEach(callbackfn: (value: MemoryPoint3D, key: string, map: Map<string, MemoryPoint3D>) => void, thisArg?: unknown): void {
    for (let i = 0; i < this.ids.length; i++) {
      callbackfn.call(thisArg, this.pointAt(i), this.ids[i]!, this);
    }
  }
}

export interface MemoryLayout3DStreamFrame {
  step: number;
  totalSteps: number;
  done: boolean;
  ids: string[];
  xyz: Float32Array;
  coordinates: PackedMemoryCoordinates3D;
}

export interface StreamMemoryNetwork3DOptions {
  frames?: number;
  steps?: number;
}

/**
 * Incremental deterministic 3D force layout. Streams snapshots via `onFrame` while converging
 * and returns the final coordinate map.
 */
export function streamMemoryNetwork3D(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  onFrame?: (frame: MemoryLayout3DStreamFrame) => void,
  options: StreamMemoryNetwork3DOptions = {}
): PackedMemoryCoordinates3D {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const ids = ordered.map(node => node.id);
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  const px = new Float64Array(count);
  const py = new Float64Array(count);
  const pz = new Float64Array(count);
  const isSource = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const node = ordered[i]!;
    px[i] = (unit(`${node.id}:x`) - 0.5) * 260;
    py[i] = (unit(`${node.id}:y`) - 0.5) * 260;
    pz[i] = (unit(`${node.id}:z`) - 0.5) * 260;
    isSource[i] = node.type === "SOURCE" ? 1 : 0;
  }
  if (root >= 0) {
    px[root] = 0;
    py[root] = 0;
    pz[root] = 0;
  }

  const sortedEdges = [...edges].sort((a, b) => a.id.localeCompare(b.id));
  const linkA: number[] = [];
  const linkB: number[] = [];
  const linkLength: number[] = [];
  const linkStrength: number[] = [];

  for (let e = 0; e < sortedEdges.length; e++) {
    const edge = sortedEdges[e]!;
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    const fileLink = isSource[a] === 1 && isSource[b] === 1;
    linkA.push(a);
    linkB.push(b);
    linkLength.push(fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55);
    linkStrength.push(fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004);
  }

  // Initialize records around their actual file, in a volume rather than a plane.
  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e]!;
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type !== "CONTAINS" || a === undefined || b === undefined || isSource[a] !== 1 || ordered[b]!.type !== "MEMORY") continue;
    const id = ordered[b]!.id;
    px[b] = px[a]! + (unit(`${id}:dx`) - 0.5) * 70;
    py[b] = py[a]! + (unit(`${id}:dy`) - 0.5) * 70;
    pz[b] = pz[a]! + (unit(`${id}:dz`) - 0.5) * 70;
  }

  const linkCount = linkA.length;
  const linkAArr = Int32Array.from(linkA);
  const linkBArr = Int32Array.from(linkB);
  const linkLenArr = Float64Array.from(linkLength);
  const linkStrArr = Float64Array.from(linkStrength);

  const totalSteps = options.steps ?? (count > 20000 ? 36 : count > 5000 ? 60 : count > 2500 ? 90 : 180);
  const coolingDenominator = totalSteps === 180 ? 230 : totalSteps * (230 / 180);
  const maxCellNeighbors = count > 2500 ? 20 : 0x7fffffff;
  const targetFrames = Math.max(1, options.frames ?? (count > 2500 ? 6 : 4));
  const frameStride = Math.max(1, Math.floor(totalSteps / targetFrames));

  const packSnapshot = (): PackedMemoryCoordinates3D => {
    const xyz = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const offset = i * 3;
      xyz[offset] = px[i]!;
      xyz[offset + 1] = py[i]!;
      xyz[offset + 2] = pz[i]!;
    }
    return new PackedMemoryCoordinates3D(ids, xyz, index);
  };

  if (count === 0) {
    const empty = packSnapshot();
    onFrame?.({ step: 0, totalSteps: 0, done: true, ids, xyz: empty.xyz, coordinates: empty });
    return empty;
  }

  if (onFrame && totalSteps > 0) {
    const initial = packSnapshot();
    onFrame({ step: 0, totalSteps, done: false, ids, xyz: initial.xyz, coordinates: initial });
  }

  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  const gxArr = new Int32Array(count), gyArr = new Int32Array(count), gzArr = new Int32Array(count);
  const cellNext = new Int32Array(count);

  // Bounded spatial-grid repulsion and link springs act equally on all three axes.
  for (let step = 0; step < totalSteps; step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    cellNext.fill(-1);
    const cellHead = new Map<number, number>();
    const cellTail = new Map<number, number>();

    for (let i = 0; i < count; i++) {
      const gx = Math.floor(px[i]! / 32);
      const gy = Math.floor(py[i]! / 32);
      const gz = Math.floor(pz[i]! / 32);
      gxArr[i] = gx;
      gyArr[i] = gy;
      gzArr[i] = gz;
      const key = (gx + 1024) + (gy + 1024) * 2048 + (gz + 1024) * 4194304;
      const prevTail = cellTail.get(key);
      if (prevTail === undefined) {
        cellHead.set(key, i);
      } else {
        cellNext[prevTail] = i;
      }
      cellTail.set(key, i);
    }

    for (let i = 0; i < count; i++) {
      const pxi = px[i]!, pyi = py[i]!, pzi = pz[i]!;
      const gx = gxArr[i]!, gy = gyArr[i]!, gz = gzArr[i]!;
      const sourceI = isSource[i] === 1;
      let checked = 0;
      for (let x = gx - 1; x <= gx + 1 && checked < maxCellNeighbors; x++) {
        for (let y = gy - 1; y <= gy + 1 && checked < maxCellNeighbors; y++) {
          for (let z = gz - 1; z <= gz + 1 && checked < maxCellNeighbors; z++) {
            const key = (x + 1024) + (y + 1024) * 2048 + (z + 1024) * 4194304;
            for (let j = cellHead.get(key) ?? -1; j !== -1 && checked < maxCellNeighbors; j = cellNext[j]!) {
              if (j <= i) continue;
              checked++;
              const dx = pxi - px[j]!, dy = pyi - py[j]!, dz = pzi - pz[j]!;
              const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
              const strength = (sourceI || isSource[j] === 1 ? 28 : 12) / distanceSquared;
              fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
              fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
            }
          }
        }
      }
    }

    for (let l = 0; l < linkCount; l++) {
      const a = linkAArr[l]!, b = linkBArr[l]!;
      const dx = px[b]! - px[a]!, dy = py[b]! - py[a]!, dz = pz[b]! - pz[a]!;
      const distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - linkLenArr[l]!) * linkStrArr[l]! / distance;
      fx[a]! += dx * spring; fy[a]! += dy * spring; fz[a]! += dz * spring;
      fx[b]! -= dx * spring; fy[b]! -= dy * spring; fz[b]! -= dz * spring;
    }

    const cooling = 1 - step / coolingDenominator;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const dx = fx[i]! - px[i]! * 0.0005;
      const dy = fy[i]! - py[i]! * 0.0005;
      const dz = fz[i]! - pz[i]! * 0.0005;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      px[i]! += dx * stepScale;
      py[i]! += dy * stepScale;
      pz[i]! += dz * stepScale;
    }

    const completedStep = step + 1;
    if (onFrame && completedStep < totalSteps && completedStep % frameStride === 0) {
      const snapshot = packSnapshot();
      onFrame({ step: completedStep, totalSteps, done: false, ids, xyz: snapshot.xyz, coordinates: snapshot });
    }
  }

  const finalCoordinates = packSnapshot();
  onFrame?.({ step: totalSteps, totalSteps, done: true, ids, xyz: finalCoordinates.xyz, coordinates: finalCoordinates });
  return finalCoordinates;
}

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  if (count > 2500) {
    return streamMemoryNetwork3D(nodes, edges);
  }
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
  const cellNext = new Int32Array(count);
  // Bounded spatial-grid repulsion and link springs act equally on all three axes.
  for (let step = 0; step < 180; step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    cellNext.fill(-1);
    const cellHead = new Map<number, number>();
    const cellTail = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      const key = (Math.floor(p.x / 32) + 1024) + (Math.floor(p.y / 32) + 1024) * 2048 + (Math.floor(p.z / 32) + 1024) * 4194304;
      const prevTail = cellTail.get(key);
      if (prevTail === undefined) cellHead.set(key, i);
      else cellNext[prevTail] = i;
      cellTail.set(key, i);
    }
    for (let i = 0; i < count; i++) {
      const p = points[i]!, gx = Math.floor(p.x / 32), gy = Math.floor(p.y / 32), gz = Math.floor(p.z / 32);
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
        const key = (x + 1024) + (y + 1024) * 2048 + (z + 1024) * 4194304;
        for (let j = cellHead.get(key) ?? -1; j !== -1; j = cellNext[j]!) {
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
  }
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

function computePackedVolumeRatio(xyz: Float32Array | Float64Array): number {
  const count = Math.floor(xyz.length / 3);
  if (count < 4) return 0;
  let cx = 0, cy = 0, cz = 0;
  for (let offset = 0; offset < count * 3; offset += 3) {
    cx += xyz[offset]!;
    cy += xyz[offset + 1]!;
    cz += xyz[offset + 2]!;
  }
  cx /= count; cy /= count; cz /= count;
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let offset = 0; offset < count * 3; offset += 3) {
    const x = xyz[offset]! - cx, y = xyz[offset + 1]! - cy, z = xyz[offset + 2]! - cz;
    xx += x * x; yy += y * y; zz += z * z;
    xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}

/** Normalized covariance determinant: 0 for a plane, 1 for equal spread in XYZ. */
export function memory3DVolumeRatio(points: MemoryPoint3D[] | PackedMemoryCoordinates3D): number {
  if (points instanceof PackedMemoryCoordinates3D) return points.volumeRatio;
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

export function nodeBaseRadius3D(node: MemoryGraphNode): number {
  if (node.type === "SOURCE" && isMemoryCoreLabel(node.label)) return 10;
  if (node.type === "SOURCE") return 4.6;
  return 2.1;
}

const PICK_GRID_COLS = 64;
const PICK_GRID_ROWS = 64;
const PICK_GRID_CELLS = PICK_GRID_COLS * PICK_GRID_ROWS;

/**
 * Spatial index for 3D memory graph hit-testing and viewport LOD queries.
 * Projects nodes into a flat 64x64 screen-space cell grid with Int32Array linked lists
 * so hover and click picking runs in < 1 ms even at 50,000 nodes.
 */
export class MemorySpatialPicker3D {
  private nodeIds: string[] = [];
  private nodeTypes: MemoryGraphNode["type"][] = [];
  private nodeLabels: string[] = [];
  private isCoreNode = new Uint8Array(0);
  private baseRadii = new Float32Array(0);
  private worldXyz = new Float32Array(0);
  private validMask = new Uint8Array(0);
  private maxExtent = 60;
  private priorityIndices: number[] = [];

  private screenX = new Float32Array(0);
  private screenY = new Float32Array(0);
  private screenZ = new Float32Array(0);
  private screenPerspective = new Float32Array(0);
  private screenBaseRadius = new Float32Array(0);
  private cellHead = new Int32Array(PICK_GRID_CELLS);
  private cellNext = new Int32Array(0);
  private indexById = new Map<string, number>();

  private syncedYaw = NaN;
  private syncedPitch = NaN;
  private syncedZoom = NaN;
  private syncedWidth = NaN;
  private syncedHeight = NaN;
  private syncedRevision = -1;
  private revision = 0;

  setGraph(nodes: readonly MemoryGraphNode[], coordinates: Map<string, MemoryPoint3D>): void {
    const count = nodes.length;
    this.nodeIds = new Array(count);
    this.nodeTypes = new Array(count);
    this.nodeLabels = new Array(count);
    this.indexById.clear();
    if (this.baseRadii.length !== count) {
      this.isCoreNode = new Uint8Array(count);
      this.baseRadii = new Float32Array(count);
      this.worldXyz = new Float32Array(count * 3);
      this.validMask = new Uint8Array(count);
      this.screenX = new Float32Array(count);
      this.screenY = new Float32Array(count);
      this.screenZ = new Float32Array(count);
      this.screenPerspective = new Float32Array(count);
      this.screenBaseRadius = new Float32Array(count);
      this.cellNext = new Int32Array(count);
    }

    const priority: number[] = [];
    let maxSq = 60 * 60;
    const packed = coordinates instanceof PackedMemoryCoordinates3D ? coordinates : null;

    for (let i = 0; i < count; i++) {
      const node = nodes[i]!;
      this.nodeIds[i] = node.id;
      this.nodeTypes[i] = node.type;
      this.nodeLabels[i] = node.label;
      this.indexById.set(node.id, i);
      const core = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
      this.isCoreNode[i] = core ? 1 : 0;
      this.baseRadii[i] = core ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
      if (node.type === "SOURCE" || node.type === "TOPIC") {
        priority.push(i);
      }

      const outOffset = i * 3;
      if (packed) {
        const srcIdx = packed.indexById.get(node.id);
        if (srcIdx !== undefined) {
          const srcOffset = srcIdx * 3;
          const x = packed.xyz[srcOffset]!, y = packed.xyz[srcOffset + 1]!, z = packed.xyz[srcOffset + 2]!;
          this.worldXyz[outOffset] = x;
          this.worldXyz[outOffset + 1] = y;
          this.worldXyz[outOffset + 2] = z;
          this.validMask[i] = 1;
          const sq = x * x + y * y + z * z;
          if (sq > maxSq) maxSq = sq;
        } else {
          this.validMask[i] = 0;
        }
      } else {
        const point = coordinates.get(node.id);
        if (point) {
          this.worldXyz[outOffset] = point.x;
          this.worldXyz[outOffset + 1] = point.y;
          this.worldXyz[outOffset + 2] = point.z;
          this.validMask[i] = 1;
          const sq = point.x * point.x + point.y * point.y + point.z * point.z;
          if (sq > maxSq) maxSq = sq;
        } else {
          this.validMask[i] = 0;
        }
      }
    }

    this.maxExtent = packed ? Math.max(60, packed.maxExtent) : Math.sqrt(maxSq);
    this.priorityIndices = priority;
    this.revision++;
  }

  get extent(): number {
    return this.maxExtent;
  }

  get coordinatesArray(): Float32Array {
    return this.worldXyz;
  }

  syncProjection(camera: MemoryCamera3D, width: number, height: number): void {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    if (
      this.syncedRevision === this.revision &&
      this.syncedYaw === camera.yaw &&
      this.syncedPitch === camera.pitch &&
      this.syncedZoom === camera.zoom &&
      this.syncedWidth === safeWidth &&
      this.syncedHeight === safeHeight
    ) {
      return;
    }

    this.syncedRevision = this.revision;
    this.syncedYaw = camera.yaw;
    this.syncedPitch = camera.pitch;
    this.syncedZoom = camera.zoom;
    this.syncedWidth = safeWidth;
    this.syncedHeight = safeHeight;

    this.cellHead.fill(-1);
    const count = this.nodeIds.length;
    if (count === 0) return;

    const scale = Math.min(safeWidth, safeHeight) * 0.4 / this.maxExtent;
    const cosYaw = Math.cos(camera.yaw), sinYaw = Math.sin(camera.yaw);
    const cosPitch = Math.cos(camera.pitch), sinPitch = Math.sin(camera.pitch);
    const zoom = camera.zoom;
    const sqrtZoom = Math.sqrt(zoom);
    const halfW = safeWidth * 0.5;
    const halfH = safeHeight * 0.5;
    const cellScaleX = PICK_GRID_COLS / safeWidth;
    const cellScaleY = PICK_GRID_ROWS / safeHeight;

    const xyz = this.worldXyz;
    const valid = this.validMask;
    const baseRadii = this.baseRadii;
    const sxArr = this.screenX;
    const syArr = this.screenY;
    const szArr = this.screenZ;
    const spArr = this.screenPerspective;
    const srArr = this.screenBaseRadius;
    const cellHead = this.cellHead;
    const cellNext = this.cellNext;

    for (let i = 0; i < count; i++) {
      if (valid[i] === 0) {
        cellNext[i] = -1;
        continue;
      }
      const offset = i * 3;
      const px = xyz[offset]!, py = xyz[offset + 1]!, pz = xyz[offset + 2]!;
      const rx = px * cosYaw + pz * sinYaw;
      const depth = -px * sinYaw + pz * cosYaw;
      const ry = py * cosPitch - depth * sinPitch;
      const rz = py * sinPitch + depth * cosPitch;
      const perspective = 650 / Math.max(120, 650 + rz * scale);
      const sx = halfW + rx * scale * zoom * perspective;
      const sy = halfH - ry * scale * zoom * perspective;
      const radius = Math.max(1, baseRadii[i]! * perspective * sqrtZoom);

      sxArr[i] = sx;
      syArr[i] = sy;
      szArr[i] = rz;
      spArr[i] = perspective;
      srArr[i] = radius;

      const cx = Math.floor(sx * cellScaleX);
      const cy = Math.floor(sy * cellScaleY);
      if (cx >= 0 && cx < PICK_GRID_COLS && cy >= 0 && cy < PICK_GRID_ROWS) {
        const cellIndex = cy * PICK_GRID_COLS + cx;
        cellNext[i] = cellHead[cellIndex]!;
        cellHead[cellIndex] = i;
      } else {
        cellNext[i] = -1;
      }
    }
  }

  pick(
    x: number,
    y: number,
    camera: MemoryCamera3D,
    width: number,
    height: number,
    focusId: string | null = null
  ): string | null {
    const count = this.nodeIds.length;
    if (count === 0) return null;
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    this.syncProjection(camera, safeWidth, safeHeight);

    const maxPossibleRadius = Math.max(7, 10 * (650 / 120) * Math.sqrt(camera.zoom) * 1.5 + 3);
    const cellWidth = safeWidth / PICK_GRID_COLS;
    const cellHeight = safeHeight / PICK_GRID_ROWS;
    const minCx = Math.max(0, Math.floor((x - maxPossibleRadius) / cellWidth));
    const maxCx = Math.min(PICK_GRID_COLS - 1, Math.floor((x + maxPossibleRadius) / cellWidth));
    const minCy = Math.max(0, Math.floor((y - maxPossibleRadius) / cellHeight));
    const maxCy = Math.min(PICK_GRID_ROWS - 1, Math.floor((y + maxPossibleRadius) / cellHeight));

    const focusIndex = focusId ? (this.indexById.get(focusId) ?? -1) : -1;
    let bestIndex = -1;
    let bestZ = Infinity;

    for (let cy = minCy; cy <= maxCy; cy++) {
      const rowOffset = cy * PICK_GRID_COLS;
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let i = this.cellHead[rowOffset + cx]!; i !== -1; i = this.cellNext[i]!) {
          const radius = this.screenBaseRadius[i]! * (i === focusIndex ? 1.5 : 1);
          const hitRadius = Math.max(7, radius + 3);
          const dx = this.screenX[i]! - x;
          const dy = this.screenY[i]! - y;
          if (dx * dx + dy * dy < hitRadius * hitRadius) {
            const z = this.screenZ[i]!;
            if (z < bestZ || (z === bestZ && i > bestIndex)) {
              bestZ = z;
              bestIndex = i;
            }
          }
        }
      }
    }

    return bestIndex >= 0 ? this.nodeIds[bestIndex]! : null;
  }

  selectLabels(options: {
    camera: MemoryCamera3D;
    width: number;
    height: number;
    showTitles: boolean;
    focusId: string | null;
    measureWidth?: (text: string) => number;
    maxMeasured?: number;
    maxDrawn?: number;
  }): { measuredCount: number; labels: Memory3DLabelPlacement[] } {
    const {
      camera,
      width,
      height,
      showTitles,
      focusId,
      measureWidth = defaultEstimateLabelWidth,
      maxMeasured = MAX_MEMORY_3D_LABELS_MEASURED,
      maxDrawn = MAX_MEMORY_3D_LABELS_DRAWN
    } = options;
    if (!showTitles || this.nodeIds.length === 0) {
      return { measuredCount: 0, labels: [] };
    }
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    this.syncProjection(camera, safeWidth, safeHeight);

    const candidateIndices: number[] = [];
    const seen = new Set<number>();
    const addCandidate = (idx: number) => {
      if (idx < 0 || seen.has(idx) || this.validMask[idx] === 0) return;
      const sx = this.screenX[idx]!, sy = this.screenY[idx]!;
      if (sx + 9 >= safeWidth || sx < -16 || sy < 14 || sy > safeHeight - 5) return;
      seen.add(idx);
      candidateIndices.push(idx);
    };

    const focusIdx = focusId ? (this.indexById.get(focusId) ?? -1) : -1;
    if (focusIdx >= 0) addCandidate(focusIdx);

    // Priority 1: Core and SOURCE nodes (and TOPIC anchors when zoomed in)
    for (let p = 0; p < this.priorityIndices.length; p++) {
      const idx = this.priorityIndices[p]!;
      if (this.nodeTypes[idx] !== "SOURCE" && camera.zoom < 1.6) continue;
      addCandidate(idx);
    }

    // Priority 2: Level-of-detail viewport nodes when zoomed in (zoom >= 1.6)
    if (camera.zoom >= 1.6 && candidateIndices.length < maxMeasured) {
      // Sample visible cells closest to the camera without sorting all 50,000 nodes
      const minPerspective = camera.zoom >= 2.8 ? 0.55 : camera.zoom >= 2.1 ? 0.72 : 0.88;
      const lodPool: number[] = [];
      const maxPool = maxMeasured * 2;
      const count = this.nodeIds.length;
      const stride = Math.max(1, Math.floor(count / 600));
      for (let i = 0; i < count && lodPool.length < maxPool; i += stride) {
        if (this.validMask[i] === 0 || seen.has(i)) continue;
        if (this.screenPerspective[i]! < minPerspective) continue;
        const sx = this.screenX[i]!, sy = this.screenY[i]!;
        if (sx + 9 >= safeWidth || sx < 0 || sy < 14 || sy > safeHeight - 5) continue;
        lodPool.push(i);
      }
      lodPool.sort((a, b) => this.screenZ[a]! - this.screenZ[b]!);
      for (let i = 0; i < lodPool.length && candidateIndices.length < maxMeasured * 2; i++) {
        addCandidate(lodPool[i]!);
      }
    }

    candidateIndices.sort((a, b) =>
      Number(b === focusIdx) - Number(a === focusIdx) ||
      Number(this.isCoreNode[b]!) - Number(this.isCoreNode[a]!) ||
      Number(this.nodeTypes[b] === "SOURCE") - Number(this.nodeTypes[a] === "SOURCE") ||
      this.screenZ[a]! - this.screenZ[b]!
    );

    const boundedCandidates = candidateIndices.slice(0, maxMeasured);
    const labelBoxes: Array<{ x: number; y: number; w: number }> = [];
    const labels: Memory3DLabelPlacement[] = [];
    let measuredCount = 0;

    for (let c = 0; c < boundedCandidates.length && labels.length < maxDrawn; c++) {
      const idx = boundedCandidates[c]!;
      const rawLabel = this.nodeLabels[idx]!;
      const text = rawLabel.length > 48 ? `${rawLabel.slice(0, 45)}…` : rawLabel;
      const x = this.screenX[idx]! + 9;
      const y = this.screenY[idx]!;
      measuredCount++;
      const w = measureWidth(text);
      if (
        x + w > safeWidth ||
        y < 14 ||
        y > safeHeight - 5 ||
        labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)
      ) {
        continue;
      }
      labelBoxes.push({ x, y, w });
      labels.push({
        id: this.nodeIds[idx]!,
        text,
        x,
        y,
        width: w,
        isCore: this.isCoreNode[idx] === 1
      });
    }

    return { measuredCount, labels };
  }
}

export interface Memory3DLabelPlacement {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  isCore: boolean;
}

function defaultEstimateLabelWidth(text: string): number {
  return text.length * 6.2;
}

export function pickMemoryNode3D(
  nodes: readonly MemoryGraphNode[],
  coordinates: Map<string, MemoryPoint3D>,
  x: number,
  y: number,
  camera: MemoryCamera3D,
  width: number,
  height: number,
  focusId: string | null = null
): string | null {
  const picker = new MemorySpatialPicker3D();
  picker.setGraph(nodes, coordinates);
  return picker.pick(x, y, camera, width, height, focusId);
}

export function selectMemory3DLabels(options: {
  nodes: readonly MemoryGraphNode[];
  coordinates: Map<string, MemoryPoint3D>;
  camera: MemoryCamera3D;
  width: number;
  height: number;
  showTitles: boolean;
  focusId?: string | null;
  measureWidth?: (text: string) => number;
  maxMeasured?: number;
  maxDrawn?: number;
}): { measuredCount: number; labels: Memory3DLabelPlacement[] } {
  const picker = new MemorySpatialPicker3D();
  picker.setGraph(options.nodes, options.coordinates);
  return picker.selectLabels({
    camera: options.camera,
    width: options.width,
    height: options.height,
    showTitles: options.showTitles,
    focusId: options.focusId ?? null,
    measureWidth: options.measureWidth,
    maxMeasured: options.maxMeasured,
    maxDrawn: options.maxDrawn
  });
}

/**
 * Caps the graph to the 2,000-node / 6,000-edge Canvas 2D budget when WebGL2 is unavailable
 * or while a lost WebGL context is awaiting restoration.
 */
export function selectFallback2DGraph(
  nodes: readonly MemoryGraphNode[],
  edges: readonly MemoryGraphEdge[],
  selectedNodeId: string | null = null,
  nodeCap = FALLBACK_CANVAS_2D_NODE_CAP,
  edgeCap = FALLBACK_CANVAS_2D_EDGE_CAP
): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  if (nodes.length <= nodeCap && edges.length <= edgeCap) {
    return { nodes: [...nodes], edges: [...edges] };
  }
  const prioritized = [...nodes].sort((a, b) =>
    Number(b.id === selectedNodeId) - Number(a.id === selectedNodeId) ||
    Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) ||
    Number(b.type === "SOURCE") - Number(a.type === "SOURCE") ||
    Number(b.type === "TOPIC") - Number(a.type === "TOPIC") ||
    a.id.localeCompare(b.id)
  );
  const cappedNodes = prioritized.slice(0, nodeCap);
  const allowedIds = new Set(cappedNodes.map(node => node.id));
  const cappedEdges: MemoryGraphEdge[] = [];
  for (let i = 0; i < edges.length && cappedEdges.length < edgeCap; i++) {
    const edge = edges[i]!;
    if (allowedIds.has(edge.source) && allowedIds.has(edge.target)) {
      cappedEdges.push(edge);
    }
  }
  return { nodes: cappedNodes, edges: cappedEdges };
}
