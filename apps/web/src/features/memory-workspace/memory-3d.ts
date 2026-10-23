import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };
export const MAX_MEMORY_3D_LABELS = 64;
export const MAX_MEMORY_3D_FALLBACK_NODES = 2000;

/**
 * Generates an independent, pseudo-random float in [0, 1) using bit-avalanching for 3D coordinate distribution.
 *
 * @param seed String identifier.
 * @returns Floating point fraction between 0 (inclusive) and 1 (exclusive).
 */
const unit = (seed: string) => {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

export interface MemoryLayout3DStreamFrame {
  step: number;
  totalSteps: number;
  done: boolean;
  coords3d: Float32Array;
}

export interface MemoryNetwork3DSimulation {
  readonly count: number;
  readonly totalSteps: number;
  readonly currentStep: number;
  step(iterations?: number): boolean;
  packCoordinates(target?: Float32Array): Float32Array;
  toMap(): Map<string, MemoryPoint3D>;
}

/**
 * Stateful incremental 3D force layout stepper.
 * For graphs <= 2,000 nodes, uses the exact deterministic order and constants of layoutMemoryNetwork3D.
 * For larger graphs (up to 50,000 nodes / 150,000 edges), uses flat typed arrays and bounded cell occupancy
 * so batches stream smoothly from the Web Worker.
 */
export function createMemoryNetwork3DSimulation(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[]
): MemoryNetwork3DSimulation {
  const count = nodes.length;
  const isLarge = count > 2000;
  const ordered = isLarge
    ? [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    : [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map<string, number>();
  for (let i = 0; i < count; i++) index.set(ordered[i]!.id, i);
  const inputToOrdered = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    inputToOrdered[i] = index.get(nodes[i]!.id) ?? i;
  }

  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const isSource = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (ordered[i]!.type === "SOURCE") isSource[i] = 1;
  }

  const span = isLarge ? 260 * Math.cbrt(count / 1000) : 260;
  const px = new Float64Array(count);
  const py = new Float64Array(count);
  const pz = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const id = ordered[i]!.id;
    px[i] = (unit(`${id}:x`) - 0.5) * span;
    py[i] = (unit(`${id}:y`) - 0.5) * span;
    pz[i] = (unit(`${id}:z`) - 0.5) * span;
  }
  if (root >= 0) {
    px[root] = 0;
    py[root] = 0;
    pz[root] = 0;
  }

  const sortedEdges = isLarge
    ? [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    : [...edges].sort((a, b) => a.id.localeCompare(b.id));

  const linkA: number[] = [];
  const linkB: number[] = [];
  const linkLength: number[] = [];
  const linkStrength: number[] = [];
  for (const edge of sortedEdges) {
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    const fileLink = isSource[a] === 1 && isSource[b] === 1;
    linkA.push(a);
    linkB.push(b);
    linkLength.push(fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55);
    linkStrength.push(fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004);
  }
  const linkCount = linkA.length;
  const linkATyped = Int32Array.from(linkA);
  const linkBTyped = Int32Array.from(linkB);
  const linkLenTyped = Float64Array.from(linkLength);
  const linkStrTyped = Float64Array.from(linkStrength);

  // Initialize records around their actual file, in a volume rather than a plane.
  for (const edge of edges) {
    if (edge.type !== "CONTAINS") continue;
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    if (a === undefined || b === undefined || ordered[a]!.type !== "SOURCE" || ordered[b]!.type !== "MEMORY") continue;
    const id = ordered[b]!.id;
    px[b] = px[a]! + (unit(`${id}:dx`) - 0.5) * 70;
    py[b] = py[a]! + (unit(`${id}:dy`) - 0.5) * 70;
    pz[b] = pz[a]! + (unit(`${id}:dz`) - 0.5) * 70;
  }

  const fx = new Float64Array(count);
  const fy = new Float64Array(count);
  const fz = new Float64Array(count);
  const totalSteps = isLarge ? 60 : 180;
  const coolingDivisor = isLarge ? 76 : 230;
  let currentStep = 0;

  // Flat hash table for large graphs to avoid per-step Map/Array allocations.
  const tableMask = 65535;
  const cellHead = isLarge ? new Int32Array(tableMask + 1) : null;
  const cellCount = isLarge ? new Uint8Array(tableMask + 1) : null;
  const nextInCell = isLarge ? new Int32Array(count) : null;
  const cellCoordX = isLarge ? new Int16Array(count) : null;
  const cellCoordY = isLarge ? new Int16Array(count) : null;
  const cellCoordZ = isLarge ? new Int16Array(count) : null;
  /**
   * Spatial hash function mapping integer 3D grid coordinates to flat hash table buckets.
   */
  const hashCell = (gx: number, gy: number, gz: number) =>
    ((Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663) ^ Math.imul(gz, 83492791)) >>> 0) & tableMask;

  /**
   * Packs 3D integer coordinates into a unique 32-bit integer key for graphs <= 2,000 nodes.
   */
  const exactGridKey = (x: number, y: number, z: number) =>
    (x + 2048) * 16777216 + (y + 2048) * 4096 + (z + 2048);

  /**
   * Advances the 3D physics layout simulation by the specified number of batch steps.
   *
   * @param iterations Number of iterations to execute in this batch.
   * @returns True if simulation reached totalSteps, false if additional iterations remain.
   */
  const runSteps = (iterations = totalSteps - currentStep): boolean => {
    const targetStep = Math.min(totalSteps, currentStep + Math.max(0, iterations));
    for (; currentStep < targetStep; currentStep++) {
      fx.fill(0);
      fy.fill(0);
      fz.fill(0);

      if (!isLarge) {
        const grid = new Map<number, number[]>();
        for (let i = 0; i < count; i++) {
          const key = exactGridKey(Math.floor(px[i]! / 32), Math.floor(py[i]! / 32), Math.floor(pz[i]! / 32));
          let bucket = grid.get(key);
          if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
          }
          bucket.push(i);
        }
        for (let i = 0; i < count; i++) {
          const pxi = px[i]!, pyi = py[i]!, pzi = pz[i]!;
          const gx = Math.floor(pxi / 32), gy = Math.floor(pyi / 32), gz = Math.floor(pzi / 32);
          const sourceI = isSource[i] === 1;
          for (let x = gx - 1; x <= gx + 1; x++) {
            for (let y = gy - 1; y <= gy + 1; y++) {
              for (let z = gz - 1; z <= gz + 1; z++) {
                const bucket = grid.get(exactGridKey(x, y, z));
                if (!bucket) continue;
                for (let k = 0; k < bucket.length; k++) {
                  const j = bucket[k]!;
                  if (j <= i) continue;
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
      } else {
        cellHead!.fill(-1);
        cellCount!.fill(0);
        for (let i = 0; i < count; i++) {
          const gx = Math.floor(px[i]! / 32);
          const gy = Math.floor(py[i]! / 32);
          const gz = Math.floor(pz[i]! / 32);
          cellCoordX![i] = gx;
          cellCoordY![i] = gy;
          cellCoordZ![i] = gz;
          const h = hashCell(gx, gy, gz);
          if (cellCount![h]! < 6) {
            nextInCell![i] = cellHead![h]!;
            cellHead![h] = i;
            cellCount![h]!++;
          } else {
            nextInCell![i] = -1;
          }
        }
        for (let i = 0; i < count; i++) {
          const pxi = px[i]!, pyi = py[i]!, pzi = pz[i]!;
          const gx = cellCoordX![i]!, gy = cellCoordY![i]!, gz = cellCoordZ![i]!;
          const sourceI = isSource[i] === 1;
          for (let x = gx - 1; x <= gx + 1; x++) {
            for (let y = gy - 1; y <= gy + 1; y++) {
              for (let z = gz - 1; z <= gz + 1; z++) {
                let j = cellHead![hashCell(x, y, z)]!;
                while (j >= 0) {
                  if (j > i && cellCoordX![j] === x && cellCoordY![j] === y && cellCoordZ![j] === z) {
                    const dx = pxi - px[j]!, dy = pyi - py[j]!, dz = pzi - pz[j]!;
                    const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
                    const strength = (sourceI || isSource[j] === 1 ? 28 : 12) / distanceSquared;
                    fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
                    fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
                  }
                  j = nextInCell![j]!;
                }
              }
            }
          }
        }
      }

      for (let k = 0; k < linkCount; k++) {
        const a = linkATyped[k]!, b = linkBTyped[k]!;
        const dx = px[b]! - px[a]!, dy = py[b]! - py[a]!, dz = pz[b]! - pz[a]!;
        const distance = Math.max(0.01, Math.hypot(dx, dy, dz));
        const spring = ((distance - linkLenTyped[k]!) * linkStrTyped[k]!) / distance;
        fx[a]! += dx * spring; fy[a]! += dy * spring; fz[a]! += dz * spring;
        fx[b]! -= dx * spring; fy[b]! -= dy * spring; fz[b]! -= dz * spring;
      }

      const cooling = 1 - currentStep / coolingDivisor;
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
    }
    return currentStep >= totalSteps;
  };

  return {
    count,
    totalSteps,
    get currentStep() {
      return currentStep;
    },
    step: runSteps,
    /**
     * Packs node 3D positions in original input order into a contiguous Float32Array (x, y, z triplets).
     *
     * @param target Optional pre-allocated Float32Array of length count * 3.
     * @returns Contiguous packed coordinates buffer.
     */
    packCoordinates(target?: Float32Array): Float32Array {
      const out = target && target.length === count * 3 ? target : new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const ord = inputToOrdered[i]!;
        const base = i * 3;
        out[base] = px[ord]!;
        out[base + 1] = py[ord]!;
        out[base + 2] = pz[ord]!;
      }
      return out;
    },
    /**
     * Converts current simulation points to a Map of node ID to 3D point coordinates.
     *
     * @returns Map of node ID to MemoryPoint3D.
     */
    toMap(): Map<string, MemoryPoint3D> {
      const result = new Map<string, MemoryPoint3D>();
      for (let i = 0; i < count; i++) {
        result.set(ordered[i]!.id, { x: px[i]!, y: py[i]!, z: pz[i]! });
      }
      return result;
    }
  };
}

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  options?: {
    batchSteps?: number;
    onFrame?: (frame: MemoryLayout3DStreamFrame) => void;
  }
): Map<string, MemoryPoint3D> {
  const sim = createMemoryNetwork3DSimulation(nodes, edges);
  if (options?.onFrame) {
    const batch = Math.max(1, options.batchSteps ?? 15);
    while (!sim.step(batch)) {
      options.onFrame({
        step: sim.currentStep,
        totalSteps: sim.totalSteps,
        done: false,
        coords3d: sim.packCoordinates()
      });
    }
    options.onFrame({
      step: sim.currentStep,
      totalSteps: sim.totalSteps,
      done: true,
      coords3d: sim.packCoordinates()
    });
  } else {
    sim.step(sim.totalSteps);
  }
  return sim.toMap();
}

/**
 * Projects a 3D memory point into 2D viewport coordinates using yaw/pitch rotation and perspective divide.
 *
 * @param point World-space 3D coordinates.
 * @param camera Camera orientation containing yaw, pitch, and zoom.
 * @param scale World-to-view uniform scaling factor.
 * @param width Viewport width in logical pixels.
 * @param height Viewport height in logical pixels.
 * @returns Screen-space coordinates with camera depth Z and perspective scale.
 */
export function projectMemoryPoint(point: MemoryPoint3D, camera: MemoryCamera3D, scale: number, width: number, height: number) {
  const cosYaw = Math.cos(camera.yaw), sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch), sinPitch = Math.sin(camera.pitch);
  const x = point.x * cosYaw + point.z * sinYaw;
  const depth = -point.x * sinYaw + point.z * cosYaw;
  const y = point.y * cosPitch - depth * sinPitch;
  const z = point.y * sinPitch + depth * cosPitch;
  const perspective = 650 / Math.max(120, 650 + z * scale);
  return { x: width / 2 + x * scale * camera.zoom * perspective, y: height / 2 - y * scale * camera.zoom * perspective, z, perspective };
}

/** Stack-safe O(N) extent computation for 3D coordinates. */
export function computeMemory3DExtent(
  coordinates: Map<string, MemoryPoint3D>,
  packedCoordinates?: Float32Array | null
): number {
  let maxRadiusSq = 3600; // 60^2
  if (packedCoordinates && packedCoordinates.length >= 3) {
    for (let i = 0; i < packedCoordinates.length; i += 3) {
      const x = packedCoordinates[i]!, y = packedCoordinates[i + 1]!, z = packedCoordinates[i + 2]!;
      const rSq = x * x + y * y + z * z;
      if (rSq > maxRadiusSq) maxRadiusSq = rSq;
    }
    return Math.sqrt(maxRadiusSq);
  }
  for (const p of coordinates.values()) {
    const rSq = p.x * p.x + p.y * p.y + p.z * p.z;
    if (rSq > maxRadiusSq) maxRadiusSq = rSq;
  }
  return Math.sqrt(maxRadiusSq);
}

/** Normalized covariance determinant: 0 for a plane, 1 for equal spread in XYZ. */
export function memory3DVolumeRatio(points: MemoryPoint3D[] | Float32Array): number {
  if (points instanceof Float32Array) {
    const count = Math.floor(points.length / 3);
    if (count < 4) return 0;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < count * 3; i += 3) {
      cx += points[i]!;
      cy += points[i + 1]!;
      cz += points[i + 2]!;
    }
    cx /= count; cy /= count; cz /= count;
    let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
    for (let i = 0; i < count * 3; i += 3) {
      const x = points[i]! - cx, y = points[i + 1]! - cy, z = points[i + 2]! - cz;
      xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
    }
    const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
    return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
  }
  if (points.length < 4) return 0;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    cx += p.x; cy += p.y; cz += p.z;
  }
  cx /= points.length; cy /= points.length; cz /= points.length;
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const x = p.x - cx, y = p.y - cy, z = p.z - cz;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}

export interface Memory3DSpatialIndex {
  readonly nodes: MemoryGraphNode[];
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly screenX: Float32Array;
  readonly screenY: Float32Array;
  readonly depthZ: Float32Array;
  readonly perspective: Float32Array;
  readonly radii: Float32Array;
  readonly visible: Uint8Array;
  readonly isCoreSource: Uint8Array;
  readonly isSource: Uint8Array;
  readonly cellHead: Int32Array;
  readonly nextInCell: Int32Array;
}

export interface Memory3DSpatialBuffers {
  screenX: Float32Array;
  screenY: Float32Array;
  depthZ: Float32Array;
  perspective: Float32Array;
  radii: Float32Array;
  visible: Uint8Array;
  isCoreSource: Uint8Array;
  isSource: Uint8Array;
  cellHead: Int32Array;
  nextInCell: Int32Array;
}

/**
 * Projects 3D nodes onto the screen and buckets them into a flat 2D screen-space grid
 * for O(1) hover and click hit-testing (<= 4 ms even at 50,000 nodes).
 */
export function buildMemory3DSpatialIndex(input: {
  nodes: MemoryGraphNode[];
  coordinates: Map<string, MemoryPoint3D>;
  packedCoordinates?: Float32Array | null;
  camera: MemoryCamera3D;
  scale?: number;
  width: number;
  height: number;
  focusId?: string | null;
  buffers?: Memory3DSpatialBuffers;
}): Memory3DSpatialIndex {
  const { nodes, coordinates, packedCoordinates, camera, width, height, focusId } = input;
  const count = nodes.length;
  const cellSize = 32;
  const cols = Math.max(1, Math.ceil(Math.max(1, width) / cellSize));
  const rows = Math.max(1, Math.ceil(Math.max(1, height) / cellSize));
  const totalCells = cols * rows;

  const extent = input.scale !== undefined ? 0 : computeMemory3DExtent(coordinates, packedCoordinates);
  const scale = input.scale ?? (Math.min(width, height) * 0.4) / extent;

  const existing = input.buffers;
  const screenX = existing && existing.screenX.length === count ? existing.screenX : new Float32Array(count);
  const screenY = existing && existing.screenY.length === count ? existing.screenY : new Float32Array(count);
  const depthZ = existing && existing.depthZ.length === count ? existing.depthZ : new Float32Array(count);
  const perspective = existing && existing.perspective.length === count ? existing.perspective : new Float32Array(count);
  const radii = existing && existing.radii.length === count ? existing.radii : new Float32Array(count);
  const visible = existing && existing.visible.length === count ? existing.visible : new Uint8Array(count);
  const isCoreSource = existing && existing.isCoreSource.length === count ? existing.isCoreSource : new Uint8Array(count);
  const isSource = existing && existing.isSource.length === count ? existing.isSource : new Uint8Array(count);
  const cellHead = existing && existing.cellHead.length >= totalCells ? existing.cellHead : new Int32Array(totalCells);
  const nextInCell = existing && existing.nextInCell.length === count ? existing.nextInCell : new Int32Array(count);

  if (existing) {
    existing.screenX = screenX;
    existing.screenY = screenY;
    existing.depthZ = depthZ;
    existing.perspective = perspective;
    existing.radii = radii;
    existing.visible = visible;
    existing.isCoreSource = isCoreSource;
    existing.isSource = isSource;
    existing.cellHead = cellHead;
    existing.nextInCell = nextInCell;
  }

  cellHead.fill(-1, 0, totalCells);
  nextInCell.fill(-1);

  const cosYaw = Math.cos(camera.yaw), sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch), sinPitch = Math.sin(camera.pitch);
  const zoom = camera.zoom;
  const sqrtZoom = Math.sqrt(zoom);
  const halfW = width * 0.5, halfH = height * 0.5;
  const hasPacked = Boolean(packedCoordinates && packedCoordinates.length >= count * 3);

  for (let i = 0; i < count; i++) {
    const node = nodes[i]!;
    let px = 0, py = 0, pz = 0;
    if (hasPacked) {
      const base = i * 3;
      px = packedCoordinates![base]!;
      py = packedCoordinates![base + 1]!;
      pz = packedCoordinates![base + 2]!;
      visible[i] = 1;
    } else {
      const point = coordinates.get(node.id);
      if (!point) {
        visible[i] = 0;
        continue;
      }
      px = point.x;
      py = point.y;
      pz = point.z;
      visible[i] = 1;
    }

    const x = px * cosYaw + pz * sinYaw;
    const depth = -px * sinYaw + pz * cosYaw;
    const y = py * cosPitch - depth * sinPitch;
    const z = py * sinPitch + depth * cosPitch;
    const persp = 650 / Math.max(120, 650 + z * scale);
    const sx = halfW + x * scale * zoom * persp;
    const sy = halfH - y * scale * zoom * persp;

    const sourceFlag = node.type === "SOURCE" ? 1 : 0;
    const coreFlag = sourceFlag === 1 && isMemoryCoreLabel(node.label) ? 1 : 0;
    isSource[i] = sourceFlag;
    isCoreSource[i] = coreFlag;

    const baseR = coreFlag ? 10 : sourceFlag ? 4.6 : 2.1;
    const highlighted = focusId !== undefined && focusId !== null && node.id === focusId;
    const r = Math.max(1, baseR * persp * sqrtZoom) * (highlighted ? 1.5 : 1);

    screenX[i] = sx;
    screenY[i] = sy;
    depthZ[i] = z;
    perspective[i] = persp;
    radii[i] = r;

    const gx = Math.floor(sx / cellSize);
    const gy = Math.floor(sy / cellSize);
    if (gx >= 0 && gx < cols && gy >= 0 && gy < rows) {
      const cellIdx = gy * cols + gx;
      nextInCell[i] = cellHead[cellIdx]!;
      cellHead[cellIdx] = i;
    }
  }

  return {
    nodes,
    width,
    height,
    scale,
    cellSize,
    cols,
    rows,
    screenX,
    screenY,
    depthZ,
    perspective,
    radii,
    visible,
    isCoreSource,
    isSource,
    cellHead,
    nextInCell
  };
}

/**
 * Picks the front-most node at screen coordinates (x, y) using the 2D screen-space grid.
 */
export function pickMemory3DNode(index: Memory3DSpatialIndex, x: number, y: number): string | null {
  const { cols, rows, cellSize, cellHead, nextInCell, screenX, screenY, depthZ, radii, nodes } = index;
  const centerCol = Math.floor(x / cellSize);
  const centerRow = Math.floor(y / cellSize);
  const minCol = Math.max(0, centerCol - 1);
  const maxCol = Math.min(cols - 1, centerCol + 1);
  const minRow = Math.max(0, centerRow - 1);
  const maxRow = Math.min(rows - 1, centerRow + 1);

  let bestIndex = -1;
  let bestZ = Infinity;

  for (let row = minRow; row <= maxRow; row++) {
    const rowOffset = row * cols;
    for (let col = minCol; col <= maxCol; col++) {
      let i = cellHead[rowOffset + col]!;
      while (i >= 0) {
        const threshold = Math.max(7, radii[i]! + 3);
        const dx = screenX[i]! - x;
        const dy = screenY[i]! - y;
        if (dx * dx + dy * dy < threshold * threshold) {
          const z = depthZ[i]!;
          if (z < bestZ || (z === bestZ && i > bestIndex)) {
            bestZ = z;
            bestIndex = i;
          }
        }
        i = nextInCell[i]!;
      }
    }
  }

  return bestIndex >= 0 ? nodes[bestIndex]!.id : null;
}

export interface Memory3DLabelItem {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  isCore: boolean;
}

/**
 * Selects a bounded Level-of-Detail (LOD) set of non-overlapping labels to draw on the 2D overlay.
 * Priority: focused node -> core memory source -> source files -> closer depth.
 */
export function selectMemory3DLabels(input: {
  spatial: Memory3DSpatialIndex;
  showTitles: boolean;
  camera: MemoryCamera3D;
  focusId: string | null;
  maxLabels?: number;
  measureTextWidth?: (text: string) => number;
}): Memory3DLabelItem[] {
  const { spatial, showTitles, camera, focusId } = input;
  if (!showTitles) return [];
  const maxLabels = Math.max(1, input.maxLabels ?? MAX_MEMORY_3D_LABELS);
  const measure = input.measureTextWidth ?? ((text: string) => text.length * 6.2);
  const { nodes, width, height, screenX, screenY, depthZ, visible, isCoreSource, isSource } = spatial;
  const zoomEligibleAll = camera.zoom >= 1.6;

  // Collect eligible visible candidates without sorting all 50,000 nodes when zoomed out.
  const highPriority: number[] = [];
  const regularCandidates: number[] = [];
  const count = nodes.length;

  for (let i = 0; i < count; i++) {
    if (visible[i] === 0) continue;
    const node = nodes[i]!;
    const isFocus = focusId !== null && node.id === focusId;
    const source = isSource[i] === 1;
    if (!source && !isFocus && !zoomEligibleAll) continue;
    const sx = screenX[i]! + 9;
    const sy = screenY[i]!;
    if (sx < 0 || sx >= width || sy < 14 || sy > height - 5) continue;
    if (isFocus || isCoreSource[i] === 1 || source) {
      highPriority.push(i);
    } else {
      regularCandidates.push(i);
    }
  }

  /**
   * Sorts candidate node indices by label rendering priority: focused node > core source > general source > depth proximity.
   */
  const comparePriority = (a: number, b: number) => {
    const nodeA = nodes[a]!, nodeB = nodes[b]!;
    const focusDiff = Number(nodeB.id === focusId) - Number(nodeA.id === focusId);
    if (focusDiff !== 0) return focusDiff;
    const coreDiff = isCoreSource[b]! - isCoreSource[a]!;
    if (coreDiff !== 0) return coreDiff;
    const sourceDiff = isSource[b]! - isSource[a]!;
    if (sourceDiff !== 0) return sourceDiff;
    // Closer to camera (smaller z) has higher LOD priority; for exact parity on small graphs,
    // wait: in original code, ordered was sorted by z descending (back-to-front) and labeled kept that relative order.
    // For large graphs (>2000), prefer closer nodes (smaller z); for <=2000, preserve back-to-front tie-break.
    return count > 2000 ? depthZ[a]! - depthZ[b]! : depthZ[b]! - depthZ[a]!;
  };

  highPriority.sort(comparePriority);

  const candidateIndices = [...highPriority];
  if (regularCandidates.length > 0 && candidateIndices.length < maxLabels * 3) {
    // Keep candidate pool bounded so we never sort 50k items on every frame when zoomed in.
    const maxRegularPool = Math.min(regularCandidates.length, 240);
    if (regularCandidates.length <= 2000) {
      regularCandidates.sort(comparePriority);
      for (let i = 0; i < Math.min(regularCandidates.length, maxRegularPool); i++) {
        candidateIndices.push(regularCandidates[i]!);
      }
    } else {
      // Stride-sample across depth-eligible candidates and sort the bounded pool.
      const step = Math.max(1, Math.floor(regularCandidates.length / maxRegularPool));
      const sampled: number[] = [];
      for (let i = 0; i < regularCandidates.length && sampled.length < maxRegularPool; i += step) {
        sampled.push(regularCandidates[i]!);
      }
      sampled.sort(comparePriority);
      candidateIndices.push(...sampled);
    }
  }

  const labelBoxes: Array<{ x: number; y: number; w: number }> = [];
  const selected: Memory3DLabelItem[] = [];

  for (let idx = 0; idx < candidateIndices.length; idx++) {
    if (selected.length >= maxLabels) break;
    const i = candidateIndices[idx]!;
    const node = nodes[i]!;
    const text = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
    const x = screenX[i]! + 9;
    const y = screenY[i]!;
    const w = measure(text);
    if (x + w > width || y < 14 || y > height - 5) continue;
    let collides = false;
    for (let b = 0; b < labelBoxes.length; b++) {
      const box = labelBoxes[b]!;
      if (Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x) {
        collides = true;
        break;
      }
    }
    if (collides) continue;
    labelBoxes.push({ x, y, w });
    selected.push({
      id: node.id,
      text,
      x,
      y,
      width: w,
      isCore: isCoreSource[i] === 1
    });
  }

  return selected;
}

/**
 * Caps nodes to MAX_MEMORY_3D_FALLBACK_NODES (2,000) when falling back to Canvas 2D
 * without WebGL2 or after WebGL context loss.
 */
export function selectMemory3DFallbackNodes(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  selectedNodeId: string | null = null,
  maxNodes = MAX_MEMORY_3D_FALLBACK_NODES
): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const limit = Math.max(1, Math.min(MAX_MEMORY_3D_FALLBACK_NODES, maxNodes));
  if (nodes.length <= limit) return { nodes, edges };
  const chosen = new Map<string, MemoryGraphNode>();
  const byId = new Map<string, MemoryGraphNode>();
  for (const node of nodes) byId.set(node.id, node);

  if (selectedNodeId && byId.has(selectedNodeId)) {
    chosen.set(selectedNodeId, byId.get(selectedNodeId)!);
  }
  for (const node of nodes) {
    if (chosen.size >= limit) break;
    if (node.type === "SOURCE" && isMemoryCoreLabel(node.label)) chosen.set(node.id, node);
  }
  for (const node of nodes) {
    if (chosen.size >= limit) break;
    if (node.type === "SOURCE" || node.type === "TOPIC") chosen.set(node.id, node);
  }
  for (const node of nodes) {
    if (chosen.size >= limit) break;
    chosen.set(node.id, node);
  }
  const fallbackNodes = [...chosen.values()];
  const fallbackEdges = edges.filter(edge => chosen.has(edge.source) && chosen.has(edge.target)).slice(0, limit * 3);
  return { nodes: fallbackNodes, edges: fallbackEdges };
}

/**
 * Parses a 6-character hex color string into normalized [r, g, b] float values in the range [0, 1].
 * Defaults to `#7395ad` when the input is malformed.
 *
 * @param hex Hex color string with optional leading `#`.
 * @returns Normalized RGB triplet.
 */
export function parseHexColorRgb(hex: string): [number, number, number] {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (clean.length === 6) {
    const num = Number.parseInt(clean, 16);
    if (Number.isFinite(num)) {
      return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
    }
  }
  return [0x73 / 255, 0x95 / 255, 0xad / 255];
}

export interface Memory3DWebGLBuffers {
  readonly nodeCount: number;
  readonly edgeVertexCount: number;
  readonly nodeIndexById: Map<string, number>;
  readonly neighborsByNodeIndex: Int32Array[];
  readonly instancePositions: Float32Array;
  readonly instanceStyles: Float32Array;
  readonly instanceFocusState: Uint8Array;
  readonly edgePositions: Float32Array;
  readonly edgeMeta: Float32Array;
  focusedIndex: number;
}

/**
 * Builds typed GPU buffers for instanced WebGL2 nodes and batched WebGL2 edges.
 */
export function buildMemory3DWebGLBuffers(input: {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>;
  coordinates: Map<string, MemoryPoint3D>;
  packedCoordinates?: Float32Array | null;
}): Memory3DWebGLBuffers {
  const { nodes, edges, positions, coordinates, packedCoordinates } = input;
  const nodeCount = nodes.length;
  const nodeIndexById = new Map<string, number>();
  for (let i = 0; i < nodeCount; i++) {
    nodeIndexById.set(nodes[i]!.id, i);
  }

  const instancePositions = new Float32Array(nodeCount * 3);
  const instanceStyles = new Float32Array(nodeCount * 4);
  const instanceFocusState = new Uint8Array(nodeCount);
  const hasPacked = Boolean(packedCoordinates && packedCoordinates.length >= nodeCount * 3);
  const colorCache = new Map<string, [number, number, number]>();

  for (let i = 0; i < nodeCount; i++) {
    const node = nodes[i]!;
    const posBase = i * 3;
    if (hasPacked) {
      instancePositions[posBase] = packedCoordinates![posBase]!;
      instancePositions[posBase + 1] = packedCoordinates![posBase + 1]!;
      instancePositions[posBase + 2] = packedCoordinates![posBase + 2]!;
    } else {
      const p = coordinates.get(node.id);
      instancePositions[posBase] = p?.x ?? 0;
      instancePositions[posBase + 1] = p?.y ?? 0;
      instancePositions[posBase + 2] = p?.z ?? 0;
    }

    const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
    const baseRadius = root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
    const hex = positions.get(node.id)?.color ?? (root ? "#fff0b0" : "#7395ad");
    let rgb = colorCache.get(hex);
    if (!rgb) {
      rgb = parseHexColorRgb(hex);
      colorCache.set(hex, rgb);
    }
    const styleBase = i * 4;
    instanceStyles[styleBase] = rgb[0];
    instanceStyles[styleBase + 1] = rgb[1];
    instanceStyles[styleBase + 2] = rgb[2];
    instanceStyles[styleBase + 3] = baseRadius;
  }

  const neighborSets: number[][] = Array.from({ length: nodeCount }, () => []);
  let validEdges = 0;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    const a = nodeIndexById.get(edge.source);
    const b = nodeIndexById.get(edge.target);
    if (a === undefined || b === undefined) continue;
    validEdges++;
    neighborSets[a]!.push(b);
    neighborSets[b]!.push(a);
  }
  const neighborsByNodeIndex = neighborSets.map(list => Int32Array.from(list));

  const edgeVertexCount = validEdges * 2;
  const edgePositions = new Float32Array(edgeVertexCount * 3);
  const edgeMeta = new Float32Array(edgeVertexCount * 3);
  let writeIdx = 0;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    const a = nodeIndexById.get(edge.source);
    const b = nodeIndexById.get(edge.target);
    if (a === undefined || b === undefined) continue;
    const aBase = a * 3, bBase = b * 3;
    const vBase = writeIdx * 6;
    edgePositions[vBase] = instancePositions[aBase]!;
    edgePositions[vBase + 1] = instancePositions[aBase + 1]!;
    edgePositions[vBase + 2] = instancePositions[aBase + 2]!;
    edgePositions[vBase + 3] = instancePositions[bBase]!;
    edgePositions[vBase + 4] = instancePositions[bBase + 1]!;
    edgePositions[vBase + 5] = instancePositions[bBase + 2]!;

    const derived = edge.type === "DERIVED_FROM" ? 1 : 0;
    edgeMeta[vBase] = a;
    edgeMeta[vBase + 1] = b;
    edgeMeta[vBase + 2] = derived;
    edgeMeta[vBase + 3] = a;
    edgeMeta[vBase + 4] = b;
    edgeMeta[vBase + 5] = derived;
    writeIdx++;
  }

  return {
    nodeCount,
    edgeVertexCount,
    nodeIndexById,
    neighborsByNodeIndex,
    instancePositions,
    instanceStyles,
    instanceFocusState,
    edgePositions,
    edgeMeta,
    focusedIndex: -1
  };
}

/**
 * Updates only the node focus/neighbor state bytes when hover or selection changes (O(degree)).
 * Returns true if the focus state changed.
 */
export function updateMemory3DFocusAttributes(
  buffers: Memory3DWebGLBuffers,
  focusId: string | null
): boolean {
  const nextIndex = focusId ? (buffers.nodeIndexById.get(focusId) ?? -1) : -1;
  if (nextIndex === buffers.focusedIndex) return false;

  const prevIndex = buffers.focusedIndex;
  if (prevIndex >= 0 && prevIndex < buffers.nodeCount) {
    buffers.instanceFocusState[prevIndex] = 0;
    const prevNeighbors = buffers.neighborsByNodeIndex[prevIndex]!;
    for (let i = 0; i < prevNeighbors.length; i++) {
      buffers.instanceFocusState[prevNeighbors[i]!] = 0;
    }
  }

  buffers.focusedIndex = nextIndex;
  if (nextIndex >= 0 && nextIndex < buffers.nodeCount) {
    const nextNeighbors = buffers.neighborsByNodeIndex[nextIndex]!;
    for (let i = 0; i < nextNeighbors.length; i++) {
      buffers.instanceFocusState[nextNeighbors[i]!] = 1;
    }
    buffers.instanceFocusState[nextIndex] = 2;
  }

  return true;
}

export const MEMORY_3D_EDGE_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aMeta;

uniform vec2 uViewport;
uniform float uScale;
uniform float uYaw;
uniform float uPitch;
uniform float uZoom;
uniform float uFocusIndex;

out vec4 vColor;

void main() {
  float cosYaw = cos(uYaw);
  float sinYaw = sin(uYaw);
  float cosPitch = cos(uPitch);
  float sinPitch = sin(uPitch);

  float x = aPosition.x * cosYaw + aPosition.z * sinYaw;
  float depth = -aPosition.x * sinYaw + aPosition.z * cosYaw;
  float y = aPosition.y * cosPitch - depth * sinPitch;
  float z = aPosition.y * sinPitch + depth * cosPitch;
  float perspective = 650.0 / max(120.0, 650.0 + z * uScale);

  float sx = uViewport.x * 0.5 + x * uScale * uZoom * perspective;
  float sy = uViewport.y * 0.5 - y * uScale * uZoom * perspective;

  float ndcX = (sx / max(1.0, uViewport.x)) * 2.0 - 1.0;
  float ndcY = 1.0 - (sy / max(1.0, uViewport.y)) * 2.0;

  bool hasFocus = uFocusIndex >= 0.0;
  bool incident = hasFocus && (abs(aMeta.x - uFocusIndex) < 0.5 || abs(aMeta.y - uFocusIndex) < 0.5);
  float ndcZ = clamp((z * uScale) / 2000.0, -0.92, 0.96) + (incident ? -0.015 : 0.02);

  gl_Position = vec4(ndcX, ndcY, ndcZ, 1.0);

  vec3 derivedColor = vec3(0.2196, 0.3137, 0.4078); // #385068
  vec3 defaultColor = vec3(0.1255, 0.2000, 0.2627); // #203343
  vec3 dimmedColor = vec3(0.0784, 0.1255, 0.1686);  // #14202b
  vec3 incidentColor = vec3(0.5961, 0.8549, 0.9804); // #98dafa

  if (incident) {
    vColor = vec4(incidentColor, 0.92);
  } else if (hasFocus) {
    vColor = vec4(dimmedColor, 0.35);
  } else if (aMeta.z > 0.5) {
    vColor = vec4(derivedColor, 0.72);
  } else {
    vColor = vec4(defaultColor, 0.62);
  }
}
`;

export const MEMORY_3D_EDGE_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 outColor;

void main() {
  outColor = vColor;
}
`;

export const MEMORY_3D_NODE_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aInstancePos;
layout(location = 2) in vec4 aInstanceStyle;
layout(location = 3) in float aFocusState;

uniform vec2 uViewport;
uniform float uScale;
uniform float uYaw;
uniform float uPitch;
uniform float uZoom;
uniform float uHasFocus;

out vec2 vLocalUv;
out vec4 vColor;
out float vGlow;

void main() {
  float cosYaw = cos(uYaw);
  float sinYaw = sin(uYaw);
  float cosPitch = cos(uPitch);
  float sinPitch = sin(uPitch);

  float x = aInstancePos.x * cosYaw + aInstancePos.z * sinYaw;
  float depth = -aInstancePos.x * sinYaw + aInstancePos.z * cosYaw;
  float y = aInstancePos.y * cosPitch - depth * sinPitch;
  float z = aInstancePos.y * sinPitch + depth * cosPitch;
  float perspective = 650.0 / max(120.0, 650.0 + z * uScale);

  float sx = uViewport.x * 0.5 + x * uScale * uZoom * perspective;
  float sy = uViewport.y * 0.5 - y * uScale * uZoom * perspective;

  bool highlighted = aFocusState > 1.5;
  bool neighbor = aFocusState > 0.5 && !highlighted;
  bool isRoot = aInstanceStyle.w > 8.0;

  float baseRadius = max(1.0, aInstanceStyle.w * perspective * sqrt(uZoom)) * (highlighted ? 1.5 : 1.0);
  float glowFactor = (isRoot || highlighted) ? 1.65 : 1.15;
  float quadRadius = baseRadius * glowFactor;

  vec2 pixelPos = vec2(sx, sy) + aCorner * quadRadius;
  float ndcX = (pixelPos.x / max(1.0, uViewport.x)) * 2.0 - 1.0;
  float ndcY = 1.0 - (pixelPos.y / max(1.0, uViewport.y)) * 2.0;
  float ndcZ = clamp((z * uScale) / 2000.0, -0.95, 0.94) - (highlighted ? 0.03 : 0.0);

  gl_Position = vec4(ndcX, ndcY, ndcZ, 1.0);
  vLocalUv = aCorner * glowFactor;

  float alpha = (uHasFocus > 0.5 && !highlighted && !neighbor)
    ? 0.2
    : clamp(perspective, 0.4, 1.0);
  vec3 rgb = highlighted ? vec3(1.0, 1.0, 1.0) : aInstanceStyle.rgb;
  vColor = vec4(rgb, alpha);
  vGlow = (isRoot || highlighted) ? 1.0 : 0.0;
}
`;

export const MEMORY_3D_NODE_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 vLocalUv;
in vec4 vColor;
in float vGlow;
out vec4 outColor;

void main() {
  float dist = length(vLocalUv);
  if (dist > (vGlow > 0.5 ? 1.65 : 1.05)) {
    discard;
  }
  if (dist <= 1.0) {
    float edgeSoftness = 1.0 - smoothstep(0.82, 1.0, dist);
    outColor = vec4(vColor.rgb, vColor.a * max(0.88, edgeSoftness));
    return;
  }
  float halo = exp(-3.5 * (dist - 1.0)) * 0.42 * vGlow;
  if (halo < 0.02) {
    discard;
  }
  outColor = vec4(vColor.rgb, vColor.a * halo);
}
`;
