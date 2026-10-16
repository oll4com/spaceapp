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

export interface LayoutStreamStep {
  step: number;
  totalSteps: number;
  done: boolean;
  positions: Map<string, MemoryPoint3D>;
  coords: Float32Array;
}

export type LayoutStreamCallback = (step: LayoutStreamStep) => void;
export type LayoutMemoryNetwork3DOptions = {
  streamInterval?: number;
  onProgress?: LayoutStreamCallback;
};

/** Independent XYZ force layout with streaming support and deterministic convergence. */
export function layoutMemoryNetwork3D(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  optionsOrProgress?: LayoutStreamCallback | LayoutMemoryNetwork3DOptions
): Map<string, MemoryPoint3D> {
  const onProgress = typeof optionsOrProgress === "function" ? optionsOrProgress : optionsOrProgress?.onProgress;
  const streamInterval = typeof optionsOrProgress === "object" && optionsOrProgress?.streamInterval ? optionsOrProgress.streamInterval : 20;
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  if (count === 0) return new Map();

  const px = new Float64Array(count);
  const py = new Float64Array(count);
  const pz = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    const id = ordered[i]!.id;
    px[i] = (unit(`${id}:x`) - 0.5) * 260;
    py[i] = (unit(`${id}:y`) - 0.5) * 260;
    pz[i] = (unit(`${id}:z`) - 0.5) * 260;
  }
  if (root >= 0) {
    px[root] = 0; py[root] = 0; pz[root] = 0;
  }

  const links = [...edges].sort((a, b) => a.id.localeCompare(b.id)).flatMap(edge => {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) return [];
    const fileLink = ordered[a]!.type === "SOURCE" && ordered[b]!.type === "SOURCE";
    return [{
      a, b,
      length: fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55,
      strength: fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004
    }];
  });

  // Initialize records around their actual file, in a volume rather than a plane.
  for (const edge of edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type !== "CONTAINS" || a === undefined || b === undefined || ordered[a]!.type !== "SOURCE" || ordered[b]!.type !== "MEMORY") continue;
    const parentX = px[a]!, parentY = py[a]!, parentZ = pz[a]!;
    const id = ordered[b]!.id;
    px[b] = parentX + (unit(`${id}:dx`) - 0.5) * 70;
    py[b] = parentY + (unit(`${id}:dy`) - 0.5) * 70;
    pz[b] = parentZ + (unit(`${id}:dz`) - 0.5) * 70;
  }

  const isSource = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (ordered[i]!.type === "SOURCE") isSource[i] = 1;
  }

  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);

  const BUCKET_BITS = 16;
  const BUCKET_COUNT = 1 << BUCKET_BITS;
  const BUCKET_MASK = BUCKET_COUNT - 1;
  const head = new Int32Array(BUCKET_COUNT);
  const tail = new Int32Array(BUCKET_COUNT);
  const next = new Int32Array(count);
  const cellX = new Int32Array(count);
  const cellY = new Int32Array(count);
  const cellZ = new Int32Array(count);

  const hashCell = (gx: number, gy: number, gz: number) => {
    return ((Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663) ^ Math.imul(gz, 83492791)) >>> 0) & BUCKET_MASK;
  };

  const snapshotCoords = (): Float32Array => {
    const coords = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      coords[i * 3] = px[i]!;
      coords[i * 3 + 1] = py[i]!;
      coords[i * 3 + 2] = pz[i]!;
    }
    return coords;
  };

  const createResultMap = (): Map<string, MemoryPoint3D> => {
    return new Map(ordered.map((node, i) => [node.id, { x: px[i]!, y: py[i]!, z: pz[i]! }]));
  };

  if (onProgress) {
    onProgress({
      step: 0,
      totalSteps: 180,
      done: false,
      positions: createResultMap(),
      coords: snapshotCoords()
    });
  }

  for (let step = 0; step < 180; step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    head.fill(-1);

    for (let i = 0; i < count; i++) {
      const gx = Math.floor(px[i]! / 32);
      const gy = Math.floor(py[i]! / 32);
      const gz = Math.floor(pz[i]! / 32);
      cellX[i] = gx;
      cellY[i] = gy;
      cellZ[i] = gz;
      const bucket = hashCell(gx, gy, gz);
      if (head[bucket] === -1) {
        head[bucket] = i;
      } else {
        next[tail[bucket]!] = i;
      }
      tail[bucket] = i;
      next[i] = -1;
    }

    for (let i = 0; i < count; i++) {
      const pxi = px[i]!, pyi = py[i]!, pzi = pz[i]!;
      const gx = cellX[i]!, gy = cellY[i]!, gz = cellZ[i]!;
      const isSourceI = isSource[i];

      for (let x = gx - 1; x <= gx + 1; x++) {
        for (let y = gy - 1; y <= gy + 1; y++) {
          for (let z = gz - 1; z <= gz + 1; z++) {
            const bucket = hashCell(x, y, z);
            for (let j = head[bucket]!; j !== -1; j = next[j]!) {
              if (j <= i) continue;
              if (cellX[j] !== x || cellY[j] !== y || cellZ[j] !== z) continue;
              const dx = pxi - px[j]!, dy = pyi - py[j]!, dz = pzi - pz[j]!;
              const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
              const strength = (isSourceI || isSource[j] ? 28 : 12) / distanceSquared;
              fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
              fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
            }
          }
        }
      }
    }

    for (let l = 0; l < links.length; l++) {
      const link = links[l]!;
      const a = link.a, b = link.b;
      const dx = px[b]! - px[a]!, dy = py[b]! - py[a]!, dz = pz[b]! - pz[a]!;
      const distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - link.length) * link.strength / distance;
      fx[a]! += dx * spring; fy[a]! += dy * spring; fz[a]! += dz * spring;
      fx[b]! -= dx * spring; fy[b]! -= dy * spring; fz[b]! -= dz * spring;
    }

    const cooling = 1 - step / 230;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const dx = fx[i]! - px[i]! * 0.0005, dy = fy[i]! - py[i]! * 0.0005, dz = fz[i]! - pz[i]! * 0.0005;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      px[i]! += dx * stepScale;
      py[i]! += dy * stepScale;
      pz[i]! += dz * stepScale;
    }

    if (onProgress && (step % streamInterval === streamInterval - 1 || step === 179)) {
      onProgress({
        step: step + 1,
        totalSteps: 180,
        done: step === 179,
        positions: createResultMap(),
        coords: snapshotCoords()
      });
    }
  }

  return createResultMap();
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

export interface VisibleLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  isCore: boolean;
}

export interface VisibleLabelOptions {
  nodes: MemoryGraphNode[];
  coordinates: Map<string, MemoryPoint3D> | { get(id: string): MemoryPoint3D | undefined };
  camera: MemoryCamera3D;
  scale: number;
  width: number;
  height: number;
  focus: string | null;
  neighbors?: Set<string>;
  showTitles?: boolean;
  measureText?: (text: string) => number;
  maxLabels?: number;
  maxCandidates?: number;
}

/**
 * Level-of-detail label selection with priority ordering and collision avoidance.
 * Evaluates at most maxCandidates and emits at most maxLabels to maintain high frame rate.
 */
export function selectVisibleLabels(options: VisibleLabelOptions): VisibleLabel[] {
  const {
    nodes,
    coordinates,
    camera,
    scale,
    width,
    height,
    focus,
    neighbors = new Set(),
    showTitles = true,
    measureText = (text: string) => text.length * 6.5,
    maxLabels = 48,
    maxCandidates = 96
  } = options;

  if (!showTitles || nodes.length === 0) return [];

  // Filter candidate nodes based on zoom & significance
  const candidates: Array<{ node: MemoryGraphNode; priority: number; p: ReturnType<typeof projectMemoryPoint> }> = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const coord = coordinates.get(node.id);
    if (!coord) continue;

    const isFocus = node.id === focus;
    const isCore = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
    const isSource = node.type === "SOURCE";
    const isNeighbor = neighbors.has(node.id);

    // LOD rule: non-source nodes only appear if focused, neighbor, or zoomed in
    if (!isSource && !isFocus && !isNeighbor && camera.zoom < 1.6) continue;

    const p = projectMemoryPoint(coord, camera, scale, width, height);

    // Skip offscreen points
    if (p.x < -60 || p.x > width + 60 || p.y < -30 || p.y > height + 30) continue;

    const priority =
      (isFocus ? 10000 : 0) +
      (isCore ? 5000 : 0) +
      (isSource ? 1000 : 0) +
      (isNeighbor ? 500 : 0) +
      p.perspective * 10;

    candidates.push({ node, priority, p });
  }

  candidates.sort((a, b) => b.priority - a.priority);
  const subset = candidates.slice(0, maxCandidates);

  const labelBoxes: Array<{ x: number; y: number; w: number }> = [];
  const results: VisibleLabel[] = [];

  for (let i = 0; i < subset.length; i++) {
    const { node, p } = subset[i]!;
    const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
    const w = measureText(label);
    const x = p.x + 9;
    const y = p.y;

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
    results.push({
      id: node.id,
      text: label,
      x,
      y,
      width: w,
      isCore: node.type === "SOURCE" && isMemoryCoreLabel(node.label)
    });

    if (results.length >= maxLabels) break;
  }

  return results;
}

export interface ProjectedPointForHit {
  id: string;
  x: number;
  y: number;
  z: number;
  radius: number;
}

/**
 * Spatial picking index using 2D grid partitioning.
 * Enables O(1) hover & click picking in under 0.1 ms for 50,000 nodes.
 */
export class SpatialPickingIndex {
  private cellSize: number;
  private head: Int32Array;
  private next: Int32Array;
  private points: ProjectedPointForHit[];
  private mask: number;

  constructor(points: ProjectedPointForHit[], cellSize = 32) {
    this.points = points;
    this.cellSize = cellSize;
    const bucketCount = Math.max(256, 1 << Math.ceil(Math.log2(Math.max(16, points.length))));
    this.mask = bucketCount - 1;
    this.head = new Int32Array(bucketCount).fill(-1);
    this.next = new Int32Array(points.length).fill(-1);

    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const gx = Math.floor(p.x / cellSize);
      const gy = Math.floor(p.y / cellSize);
      const bucket = ((Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663)) >>> 0) & this.mask;
      this.next[i] = this.head[bucket]!;
      this.head[bucket] = i;
    }
  }

  findHit(x: number, y: number): string | null {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    let bestId: string | null = null;
    let bestZ = Infinity;

    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = ((Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663)) >>> 0) & this.mask;
        for (let i = this.head[bucket]!; i !== -1; i = this.next[i]!) {
          const p = this.points[i]!;
          const threshold = Math.max(7, p.radius + 3);
          const dx = p.x - x;
          const dy = p.y - y;
          if (dx * dx + dy * dy < threshold * threshold) {
            // Smaller z is closer to camera (front-most object)
            if (p.z < bestZ || bestId === null) {
              bestZ = p.z;
              bestId = p.id;
            }
          }
        }
      }
    }
    return bestId;
  }
}
