import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export type MemoryCoordinateMap3D = Map<string, MemoryPoint3D> & {
  packed?: Float32Array;
  orderedIds?: string[];
  version?: number;
  points?: MemoryPoint3D[];
  backingMap?: Map<string, MemoryPoint3D>;
};

export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };
export const MAX_MEASURED_MEMORY_LABELS = 96;
export const MAX_DRAWN_MEMORY_LABELS = 42;
export const FALLBACK_CANVAS_2D_NODE_CAP = 2_000;
export const FALLBACK_CANVAS_2D_EDGE_CAP = 6_000;

// Avalanche each seed so the three axes are independent even for similar file IDs.
const unit = (seed: string) => {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

const compareIds = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export interface MemoryNetwork3DSimulation {
  readonly orderedIds: string[];
  readonly count: number;
  readonly totalSteps: number;
  currentStep(): number;
  step(batchSteps?: number): boolean;
  packedPositions(target?: Float32Array): Float32Array;
  snapshot(): Map<string, MemoryPoint3D>;
}

/**
 * Deterministic, allocation-free 3D force layout simulation using a typed-array
 * chained spatial hash grid. Scales from small graphs to 50,000 nodes / 150,000 edges.
 */
export function createMemoryNetwork3DSimulation(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[]
): MemoryNetwork3DSimulation {
  const ordered = [...nodes].sort(compareIds);
  const count = ordered.length;
  const orderedIds = ordered.map(node => node.id);
  if (count === 0) {
    return {
      orderedIds,
      count: 0,
      totalSteps: 0,
      currentStep: () => 0,
      step: () => true,
      packedPositions: (target) => target ?? new Float32Array(0),
      snapshot: () => new Map()
    };
  }

  const index = new Map<string, number>();
  for (let i = 0; i < count; i++) index.set(ordered[i]!.id, i);
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));

  // Scale initial volume with cube root of node count above 500 so per-cell 3D density stays O(1).
  const volumeScale = count > 500 ? Math.cbrt(count / 500) : 1;
  const initialSpan = 260 * volumeScale;
  const px = new Float64Array(count);
  const py = new Float64Array(count);
  const pz = new Float64Array(count);
  const isSource = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const node = ordered[i]!;
    const id = node.id;
    px[i] = (unit(`${id}:x`) - 0.5) * initialSpan;
    py[i] = (unit(`${id}:y`) - 0.5) * initialSpan;
    pz[i] = (unit(`${id}:z`) - 0.5) * initialSpan;
    if (node.type === "SOURCE") isSource[i] = 1;
  }
  if (root >= 0) {
    px[root] = 0;
    py[root] = 0;
    pz[root] = 0;
  }

  const sortedEdges = [...edges].sort(compareIds);
  const maxLinks = sortedEdges.length;
  const linkA = new Int32Array(maxLinks);
  const linkB = new Int32Array(maxLinks);
  const linkLength = new Float64Array(maxLinks);
  const linkStrength = new Float64Array(maxLinks);
  let linkCount = 0;

  for (let e = 0; e < maxLinks; e++) {
    const edge = sortedEdges[e]!;
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    const fileLink = isSource[a] === 1 && isSource[b] === 1;
    linkA[linkCount] = a;
    linkB[linkCount] = b;
    linkLength[linkCount] = fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55;
    linkStrength[linkCount] = fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004;
    linkCount++;
  }

  // Initialize records around their actual file, in a volume rather than a plane.
  for (let e = 0; e < maxLinks; e++) {
    const edge = sortedEdges[e]!;
    if (edge.type !== "CONTAINS") continue;
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || isSource[a] !== 1 || ordered[b]!.type !== "MEMORY") continue;
    const id = ordered[b]!.id;
    px[b] = px[a]! + (unit(`${id}:dx`) - 0.5) * 70;
    py[b] = py[a]! + (unit(`${id}:dy`) - 0.5) * 70;
    pz[b] = pz[a]! + (unit(`${id}:dz`) - 0.5) * 70;
  }
  if (root >= 0) {
    px[root] = 0;
    py[root] = 0;
    pz[root] = 0;
  }

  const fx = new Float64Array(count);
  const fy = new Float64Array(count);
  const fz = new Float64Array(count);

  let bucketSize = 64;
  while (bucketSize < count * 2) bucketSize <<= 1;
  const bucketMask = bucketSize - 1;
  const bucketHead = new Int32Array(bucketSize);
  const cellX = new Int32Array(count);
  const cellY = new Int32Array(count);
  const cellZ = new Int32Array(count);
  const cellNext = new Int32Array(count);
  const cellNodeHead = new Int32Array(count);
  const cellNodeTail = new Int32Array(count);
  const cellNodeCount = new Int32Array(count);
  const nodeNext = new Int32Array(count);

  const maxCellOccupants = count > 2000 ? 10 : 64;
  const totalSteps = count > 20000 ? 45 : count > 5000 ? 64 : count > 2000 ? 96 : 180;
  const coolingDenom = totalSteps === 180 ? 230 : totalSteps * 1.2777777777777777;
  let stepIndex = 0;

  const hashCell3D = (gx: number, gy: number, gz: number) =>
    (Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663) ^ Math.imul(gz, 83492791)) & bucketMask;

  const runSingleStep = (step: number) => {
    fx.fill(0);
    fy.fill(0);
    fz.fill(0);
    bucketHead.fill(-1);
    let numCells = 0;

    for (let i = 0; i < count; i++) {
      const gx = Math.floor(px[i]! / 32);
      const gy = Math.floor(py[i]! / 32);
      const gz = Math.floor(pz[i]! / 32);
      const h = hashCell3D(gx, gy, gz);
      let c = bucketHead[h]!;
      while (c !== -1 && (cellX[c] !== gx || cellY[c] !== gy || cellZ[c] !== gz)) {
        c = cellNext[c]!;
      }
      if (c === -1) {
        c = numCells++;
        cellX[c] = gx;
        cellY[c] = gy;
        cellZ[c] = gz;
        cellNext[c] = bucketHead[h]!;
        bucketHead[h] = c;
        cellNodeHead[c] = i;
        cellNodeTail[c] = i;
        cellNodeCount[c] = 1;
        nodeNext[i] = -1;
      } else if (cellNodeCount[c]! < maxCellOccupants) {
        nodeNext[cellNodeTail[c]!] = i;
        cellNodeTail[c] = i;
        cellNodeCount[c]!++;
        nodeNext[i] = -1;
      }
    }

    for (let i = 0; i < count; i++) {
      const pxi = px[i]!, pyi = py[i]!, pzi = pz[i]!;
      const srcI = isSource[i] === 1;
      const gx = Math.floor(pxi / 32);
      const gy = Math.floor(pyi / 32);
      const gz = Math.floor(pzi / 32);
      for (let x = gx - 1; x <= gx + 1; x++) {
        for (let y = gy - 1; y <= gy + 1; y++) {
          for (let z = gz - 1; z <= gz + 1; z++) {
            const h = hashCell3D(x, y, z);
            let c = bucketHead[h]!;
            while (c !== -1 && (cellX[c] !== x || cellY[c] !== y || cellZ[c] !== z)) {
              c = cellNext[c]!;
            }
            if (c === -1) continue;
            for (let j = cellNodeHead[c]!; j !== -1; j = nodeNext[j]!) {
              if (j <= i) continue;
              const dx = pxi - px[j]!, dy = pyi - py[j]!, dz = pzi - pz[j]!;
              const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
              const strength = (srcI || isSource[j] === 1 ? 28 : 12) / distanceSquared;
              const sdx = dx * strength, sdy = dy * strength, sdz = dz * strength;
              fx[i]! += sdx; fy[i]! += sdy; fz[i]! += sdz;
              fx[j]! -= sdx; fy[j]! -= sdy; fz[j]! -= sdz;
            }
          }
        }
      }
    }

    for (let l = 0; l < linkCount; l++) {
      const a = linkA[l]!, b = linkB[l]!;
      const dx = px[b]! - px[a]!, dy = py[b]! - py[a]!, dz = pz[b]! - pz[a]!;
      const distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - linkLength[l]!) * linkStrength[l]! / distance;
      const sdx = dx * spring, sdy = dy * spring, sdz = dz * spring;
      fx[a]! += sdx; fy[a]! += sdy; fz[a]! += sdz;
      fx[b]! -= sdx; fy[b]! -= sdy; fz[b]! -= sdz;
    }

    const cooling = 1 - step / coolingDenom;
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
  };

  return {
    orderedIds,
    count,
    totalSteps,
    currentStep: () => stepIndex,
    step(batchSteps = 15) {
      const targetStep = Math.min(totalSteps, stepIndex + Math.max(1, batchSteps));
      while (stepIndex < targetStep) {
        runSingleStep(stepIndex);
        stepIndex++;
      }
      return stepIndex >= totalSteps;
    },
    packedPositions(target?: Float32Array) {
      const out = target && target.length === count * 3 ? target : new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const base = i * 3;
        out[base] = px[i]!;
        out[base + 1] = py[i]!;
        out[base + 2] = pz[i]!;
      }
      return out;
    },
    snapshot() {
      const map: MemoryCoordinateMap3D = new Map();
      const packed = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const x = px[i]!, y = py[i]!, z = pz[i]!;
        const base = i * 3;
        packed[base] = x;
        packed[base + 1] = y;
        packed[base + 2] = z;
        map.set(orderedIds[i]!, { x, y, z });
      }
      map.packed = packed;
      map.orderedIds = orderedIds;
      map.version = stepIndex;
      return map;
    }
  };
}

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const simulation = createMemoryNetwork3DSimulation(nodes, edges);
  if (simulation.totalSteps > 0) simulation.step(simulation.totalSteps);
  return simulation.snapshot();
}

/**
 * Runs the 3D force layout in incremental batches, invoking `onFrame` after the initial
 * placement and after each batch so workers can stream live converging coordinates.
 */
export function streamLayoutMemoryNetwork3D(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  onFrame: (frame: {
    step: number;
    totalSteps: number;
    done: boolean;
    orderedIds: string[];
    packed: Float32Array;
  }) => void,
  batchSteps = 18
): Map<string, MemoryPoint3D> {
  const simulation = createMemoryNetwork3DSimulation(nodes, edges);
  onFrame({
    step: 0,
    totalSteps: simulation.totalSteps,
    done: simulation.totalSteps === 0,
    orderedIds: simulation.orderedIds,
    packed: simulation.packedPositions()
  });
  while (simulation.currentStep() < simulation.totalSteps) {
    const done = simulation.step(batchSteps);
    onFrame({
      step: simulation.currentStep(),
      totalSteps: simulation.totalSteps,
      done,
      orderedIds: simulation.orderedIds,
      packed: simulation.packedPositions()
    });
  }
  return simulation.snapshot();
}

export function unpackMemoryCoordinates3D(
  orderedIds: string[],
  packed: Float32Array,
  version = 0,
  existing?: MemoryCoordinateMap3D
): MemoryCoordinateMap3D {
  const count = Math.min(orderedIds.length, Math.floor(packed.length / 3));
  let backingMap = existing?.backingMap ?? (existing instanceof Map ? existing : undefined);
  let points = existing?.points;
  const canReuse =
    backingMap !== undefined &&
    points !== undefined &&
    points.length === count &&
    existing?.orderedIds !== undefined &&
    existing.orderedIds.length === count;

  if (!canReuse) {
    backingMap = new Map<string, MemoryPoint3D>();
    points = new Array<MemoryPoint3D>(count);
    for (let i = 0; i < count; i++) {
      const base = i * 3;
      const point: MemoryPoint3D = {
        x: packed[base]!,
        y: packed[base + 1]!,
        z: packed[base + 2]!
      };
      points[i] = point;
      backingMap.set(orderedIds[i]!, point);
    }
  } else {
    for (let i = 0; i < count; i++) {
      const base = i * 3;
      const point = points![i]!;
      point.x = packed[base]!;
      point.y = packed[base + 1]!;
      point.z = packed[base + 2]!;
    }
  }

  const target = backingMap!;
  const resolvedPoints = points!;
  return new Proxy(target, {
    get(mapTarget, prop) {
      if (prop === "packed") return packed;
      if (prop === "orderedIds") return orderedIds;
      if (prop === "version") return version;
      if (prop === "points") return resolvedPoints;
      if (prop === "backingMap") return mapTarget;
      const value = Reflect.get(mapTarget, prop, mapTarget);
      return typeof value === "function" ? value.bind(mapTarget) : value;
    }
  }) as MemoryCoordinateMap3D;
}

export function computeMemory3DExtent(coordinates: Map<string, MemoryPoint3D> | Iterable<MemoryPoint3D>): number {
  const maybePacked = (coordinates as MemoryCoordinateMap3D).packed;
  if (maybePacked && maybePacked.length > 0) {
    let maxSq = 3600;
    for (let i = 0; i < maybePacked.length; i += 3) {
      const x = maybePacked[i]!, y = maybePacked[i + 1]!, z = maybePacked[i + 2]!;
      const dSq = x * x + y * y + z * z;
      if (dSq > maxSq) maxSq = dSq;
    }
    return Math.sqrt(maxSq);
  }
  let maxSq = 3600;
  const iter = coordinates instanceof Map ? coordinates.values() : coordinates;
  for (const p of iter) {
    const dSq = p.x * p.x + p.y * p.y + p.z * p.z;
    if (dSq > maxSq) maxSq = dSq;
  }
  return Math.sqrt(maxSq);
}

/**
 * Computes normalized WebGL2 clip-space depth in [-0.995, 0.995] from rotated world depth `z`
 * and scene `extent` without double division by extent. Smaller z is closer to the camera.
 */
export function projectMemoryClipZ(z: number, extent: number, depthBias = 0): number {
  const safeExtent = Math.max(60, extent);
  return Math.max(-0.995, Math.min(0.995, z / (safeExtent * 1.5) + depthBias));
}

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

/** Normalized covariance determinant: 0 for a plane, 1 for equal spread in XYZ. */
export function memory3DVolumeRatio(points: MemoryPoint3D[]): number {
  if (points.length < 4) return 0;
  let cx = 0, cy = 0, cz = 0;
  const invN = 1 / points.length;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    cx += p.x;
    cy += p.y;
    cz += p.z;
  }
  cx *= invN;
  cy *= invN;
  cz *= invN;
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const x = p.x - cx, y = p.y - cy, z = p.z - cz;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}

export function memory3DVolumeRatioFromMap(coordinates: Map<string, MemoryPoint3D>): number {
  const packed = (coordinates as MemoryCoordinateMap3D).packed;
  if (packed) {
    const count = Math.floor(packed.length / 3);
    if (count < 4) return 0;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < packed.length; i += 3) {
      cx += packed[i]!;
      cy += packed[i + 1]!;
      cz += packed[i + 2]!;
    }
    cx /= count;
    cy /= count;
    cz /= count;
    let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
    for (let i = 0; i < packed.length; i += 3) {
      const x = packed[i]! - cx, y = packed[i + 1]! - cy, z = packed[i + 2]! - cz;
      xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
    }
    const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
    return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
  }
  return memory3DVolumeRatio([...coordinates.values()]);
}

export interface MemorySpatialPicker3D {
  update(
    nodes: MemoryGraphNode[],
    coordinates: Map<string, MemoryPoint3D>,
    camera: MemoryCamera3D,
    scale: number,
    width: number,
    height: number,
    focusId: string | null
  ): void;
  pick(x: number, y: number): string | null;
}

const PICK_GRID_CELL_SIZE = 24;

/**
 * Sub-4ms 2D screen-grid spatial index for hover and click picking at 50,000+ nodes.
 * Reuses typed-array buffers across frames to avoid GC pressure.
 */
export function createMemorySpatialPicker3D(): MemorySpatialPicker3D {
  let capacity = 0;
  let projX = new Float32Array(0);
  let projY = new Float32Array(0);
  let projZ = new Float32Array(0);
  let hitRadii = new Float32Array(0);
  let nodeNext = new Int32Array(0);
  let validMask = new Uint8Array(0);
  let cellHead = new Int32Array(0);
  let cols = 1;
  let rows = 1;
  let maxRadius = 7;
  let currentNodes: MemoryGraphNode[] = [];

  const ensureCapacity = (n: number, cellCount: number) => {
    if (n > capacity) {
      capacity = Math.max(n, capacity * 2, 256);
      projX = new Float32Array(capacity);
      projY = new Float32Array(capacity);
      projZ = new Float32Array(capacity);
      hitRadii = new Float32Array(capacity);
      nodeNext = new Int32Array(capacity);
      validMask = new Uint8Array(capacity);
    }
    if (cellCount > cellHead.length) {
      cellHead = new Int32Array(Math.max(cellCount, cellHead.length * 2, 256));
    }
  };

  return {
    update(nodes, coordinates, camera, scale, width, height, focusId) {
      currentNodes = nodes;
      const count = nodes.length;
      cols = Math.max(1, Math.ceil(Math.max(1, width) / PICK_GRID_CELL_SIZE));
      rows = Math.max(1, Math.ceil(Math.max(1, height) / PICK_GRID_CELL_SIZE));
      const cellCount = cols * rows;
      ensureCapacity(count, cellCount);
      cellHead.fill(-1, 0, cellCount);
      maxRadius = 7;

      const cosYaw = Math.cos(camera.yaw), sinYaw = Math.sin(camera.yaw);
      const cosPitch = Math.cos(camera.pitch), sinPitch = Math.sin(camera.pitch);
      const zoom = camera.zoom;
      const sqrtZoom = Math.sqrt(zoom);
      const halfW = width / 2, halfH = height / 2;
      const coordMap = (coordinates as MemoryCoordinateMap3D).backingMap ?? coordinates;

      for (let i = 0; i < count; i++) {
        const node = nodes[i]!;
        const p = coordMap.get(node.id);
        if (!p) {
          validMask[i] = 0;
          continue;
        }
        const rx = p.x * cosYaw + p.z * sinYaw;
        const depth = -p.x * sinYaw + p.z * cosYaw;
        const ry = p.y * cosPitch - depth * sinPitch;
        const rz = p.y * sinPitch + depth * cosPitch;
        const perspective = 650 / Math.max(120, 650 + rz * scale);
        const sx = halfW + rx * scale * zoom * perspective;
        const sy = halfH - ry * scale * zoom * perspective;

        const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        const highlighted = node.id === focusId;
        const baseRadius = root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
        const radius = Math.max(1, baseRadius * perspective * sqrtZoom) * (highlighted ? 1.5 : 1);
        const hitR = Math.max(7, radius + 3);
        if (hitR > maxRadius) maxRadius = hitR;

        projX[i] = sx;
        projY[i] = sy;
        projZ[i] = rz;
        hitRadii[i] = hitR;

        if (sx < -hitR || sx > width + hitR || sy < -hitR || sy > height + hitR) {
          validMask[i] = 0;
          continue;
        }
        validMask[i] = 1;
        const col = Math.max(0, Math.min(cols - 1, Math.floor(sx / PICK_GRID_CELL_SIZE)));
        const row = Math.max(0, Math.min(rows - 1, Math.floor(sy / PICK_GRID_CELL_SIZE)));
        const cell = row * cols + col;
        nodeNext[i] = cellHead[cell]!;
        cellHead[cell] = i;
      }
    },
    pick(x, y) {
      if (currentNodes.length === 0) return null;
      const centerCol = Math.floor(x / PICK_GRID_CELL_SIZE);
      const centerRow = Math.floor(y / PICK_GRID_CELL_SIZE);
      const cellSpan = Math.max(1, Math.ceil(maxRadius / PICK_GRID_CELL_SIZE));
      const minCol = Math.max(0, centerCol - cellSpan);
      const maxCol = Math.min(cols - 1, centerCol + cellSpan);
      const minRow = Math.max(0, centerRow - cellSpan);
      const maxRow = Math.min(rows - 1, centerRow + cellSpan);

      let bestIndex = -1;
      let bestZ = Infinity;

      for (let row = minRow; row <= maxRow; row++) {
        const rowOffset = row * cols;
        for (let col = minCol; col <= maxCol; col++) {
          for (let i = cellHead[rowOffset + col]!; i !== -1; i = nodeNext[i]!) {
            if (validMask[i] === 0) continue;
            const dx = projX[i]! - x;
            const dy = projY[i]! - y;
            const hitR = hitRadii[i]!;
            if (dx * dx + dy * dy < hitR * hitR) {
              const z = projZ[i]!;
              if (z < bestZ || (z === bestZ && i > bestIndex)) {
                bestZ = z;
                bestIndex = i;
              }
            }
          }
        }
      }
      return bestIndex >= 0 ? currentNodes[bestIndex]!.id : null;
    }
  };
}

export function pickMemoryNode3D(
  nodes: MemoryGraphNode[],
  coordinates: Map<string, MemoryPoint3D>,
  camera: MemoryCamera3D,
  scale: number,
  width: number,
  height: number,
  x: number,
  y: number,
  focusId: string | null = null
): string | null {
  const picker = createMemorySpatialPicker3D();
  picker.update(nodes, coordinates, camera, scale, width, height, focusId);
  return picker.pick(x, y);
}

export interface MemoryLabelPlacement3D {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  core: boolean;
}

/**
 * Selects visible 3D node labels with level-of-detail (LOD) and collision avoidance.
 * Guarantees at most `maxMeasured` text measurements and `maxDrawn` drawn labels per frame
 * regardless of graph size (2k, 10k, or 50k nodes).
 */
export function selectMemoryLabelsLOD({
  nodes,
  coordinates,
  camera,
  scale,
  width,
  height,
  focusId,
  neighbors,
  measureTextWidth,
  maxMeasured = MAX_MEASURED_MEMORY_LABELS,
  maxDrawn = MAX_DRAWN_MEMORY_LABELS
}: {
  nodes: MemoryGraphNode[];
  coordinates: Map<string, MemoryPoint3D>;
  camera: MemoryCamera3D;
  scale: number;
  width: number;
  height: number;
  focusId: string | null;
  neighbors?: ReadonlySet<string>;
  measureTextWidth: (text: string) => number;
  maxMeasured?: number;
  maxDrawn?: number;
}): { labels: MemoryLabelPlacement3D[]; measuredCount: number } {
  if (nodes.length === 0 || maxMeasured <= 0 || maxDrawn <= 0) {
    return { labels: [], measuredCount: 0 };
  }

  type Candidate = {
    node: MemoryGraphNode;
    x: number;
    y: number;
    z: number;
    perspective: number;
    priority: number;
    core: boolean;
  };

  const candidates: Candidate[] = [];
  const allowNonSource = camera.zoom >= 1.6;
  const largeGraph = nodes.length > 2_000;
  // At 50k nodes when zoomed in, stride non-priority nodes and require frontmost LOD depth.
  const nonPriorityStride = allowNonSource && largeGraph ? Math.max(1, Math.floor(nodes.length / 400)) : 1;
  const coordMap = (coordinates as MemoryCoordinateMap3D).backingMap ?? coordinates;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const isFocus = node.id === focusId;
    const isSource = node.type === "SOURCE";
    const isNeighbor = Boolean(neighbors?.has(node.id));
    if (!isSource && !isFocus && !allowNonSource) continue;
    if (!isSource && !isFocus && !isNeighbor && nonPriorityStride > 1 && i % nonPriorityStride !== 0) {
      continue;
    }
    const p = coordMap.get(node.id);
    if (!p) continue;
    const proj = projectMemoryPoint(p, camera, scale, width, height);
    if (proj.x < -40 || proj.x > width + 40 || proj.y < 10 || proj.y > height) continue;
    if (!isSource && !isFocus && !isNeighbor && largeGraph && proj.perspective < 0.95) continue;

    const core = isMemoryCoreLabel(node.label);
    const priority = isFocus ? 4 : core ? 3 : isSource ? 2 : isNeighbor ? 1 : 0;
    candidates.push({
      node,
      x: proj.x,
      y: proj.y,
      z: proj.z,
      perspective: proj.perspective,
      priority,
      core
    });
  }

  candidates.sort((a, b) => b.priority - a.priority || a.z - b.z);

  const labelBoxes: Array<{ x: number; y: number; w: number }> = [];
  const labels: MemoryLabelPlacement3D[] = [];
  let measuredCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    if (measuredCount >= maxMeasured || labels.length >= maxDrawn) break;
    const c = candidates[i]!;
    const rawLabel = c.node.label;
    const text = rawLabel.length > 48 ? `${rawLabel.slice(0, 45)}…` : rawLabel;
    const x = c.x + 9;
    const y = c.y;
    measuredCount++;
    const w = measureTextWidth(text);
    if (
      x + w > width ||
      y < 14 ||
      y > height - 5 ||
      labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)
    ) {
      continue;
    }
    labelBoxes.push({ x, y, w });
    labels.push({ id: c.node.id, text, x, y, width: w, core: c.core });
  }

  return { labels, measuredCount };
}
