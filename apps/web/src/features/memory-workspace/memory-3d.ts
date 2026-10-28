import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };

export interface PackedMemoryGraph3D {
  nodeIds: string[];
  nodeIndex: Map<string, number>;
  /** Interleaved XYZ coordinates: length = nodeCount * 3 */
  positions: Float32Array;
  /** Interleaved RGB colors [0..1]: length = nodeCount * 3 */
  colors: Float32Array;
  /** Base point sizes in pixels: length = nodeCount */
  sizes: Float32Array;
  /** Node flags (bit 0 = SOURCE, bit 1 = core root): length = nodeCount */
  flags: Uint8Array;
  /** Pairs of node indices for edges: length = edgeCount * 2 */
  edgeIndices: Uint32Array;
  /** Edge endpoints in 3D space: length = edgeCount * 6 */
  edgePositions: Float32Array;
  /** Edge base RGB colors [0..1]: length = edgeCount * 6 */
  edgeColors: Float32Array;
  /** Maximum radial extent from origin (>= 60) */
  extent: number;
  /** Adjacency list per node index */
  neighbors: Map<number, Set<number>>;
}

// Avalanche each seed so the three axes are independent even for similar file IDs.
const unit = (seed: string) => {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

export function parseHexColorRgb(hex: string | undefined): [number, number, number] {
  const clean = (hex ?? "#7395ad").replace(/^#/, "");
  if (clean.length === 3) {
    const r = Number.parseInt(clean[0]! + clean[0]!, 16) / 255;
    const g = Number.parseInt(clean[1]! + clean[1]!, 16) / 255;
    const b = Number.parseInt(clean[2]! + clean[2]!, 16) / 255;
    return [Number.isFinite(r) ? r : 0.45, Number.isFinite(g) ? g : 0.58, Number.isFinite(b) ? b : 0.68];
  }
  const value = Number.parseInt(clean.slice(0, 6), 16);
  if (!Number.isFinite(value)) return [0.45, 0.58, 0.68];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/**
 * Independent XYZ force layout. Scales from small graphs up to 50,000+ nodes:
 * adaptive iteration count and per-cell neighbor cap prevent quadratic blowups
 * while preserving exact cluster volume and deterministic output.
 */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  const spread = count > 5_000 ? 480 : 260;
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
    return [{
      a,
      b,
      length: fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55,
      strength: fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004
    }];
  });
  // Initialize records around their actual file, in a volume rather than a plane.
  for (const edge of edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type !== "CONTAINS" || a === undefined || b === undefined || ordered[a]!.type !== "SOURCE" || ordered[b]!.type !== "MEMORY") continue;
    const parent = points[a]!, id = ordered[b]!.id;
    points[b] = {
      x: parent.x + (unit(`${id}:dx`) - 0.5) * 70,
      y: parent.y + (unit(`${id}:dy`) - 0.5) * 70,
      z: parent.z + (unit(`${id}:dz`) - 0.5) * 70
    };
  }
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  const steps = count > 20_000 ? 12 : count > 5_000 ? 36 : 180;
  const coolingDenominator = count > 20_000 ? 16 : count > 5_000 ? 48 : 230;
  const maxBucketPeers = count > 5_000 ? 12 : 64;
  const cellSize = count > 10_000 ? 48 : 32;

  // Bounded spatial-grid repulsion and link springs act equally on all three axes.
  for (let step = 0; step < steps; step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    const grid = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      const key = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)},${Math.floor(p.z / cellSize)}`;
      let cell = grid.get(key);
      if (!cell) {
        cell = [];
        grid.set(key, cell);
      }
      if (cell.length < maxBucketPeers) cell.push(i);
    }
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      const gx = Math.floor(p.x / cellSize), gy = Math.floor(p.y / cellSize), gz = Math.floor(p.z / cellSize);
      const searchRadius = count > 10_000 ? 0 : 1;
      for (let x = gx - searchRadius; x <= gx + searchRadius; x++) {
        for (let y = gy - searchRadius; y <= gy + searchRadius; y++) {
          for (let z = gz - searchRadius; z <= gz + searchRadius; z++) {
            const bucket = grid.get(`${x},${y},${z}`);
            if (!bucket) continue;
            for (let k = 0; k < bucket.length; k++) {
              const j = bucket[k]!;
              if (j <= i) continue;
              const q = points[j]!, dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
              const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
              const strength = (ordered[i]!.type === "SOURCE" || ordered[j]!.type === "SOURCE" ? 28 : 12) / distanceSquared;
              fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
              fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
            }
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
    const cooling = 1 - step / coolingDenominator;
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

/**
 * Packs nodes, 3D coordinates, colors and edges into contiguous TypedArrays
 * for single-draw-call WebGL buffer upload and fast spatial picking at 50,000+ nodes.
 */
export function packMemoryGraph3DBuffers(
  nodes: readonly MemoryGraphNode[],
  edges: readonly MemoryGraphEdge[],
  coordinates: ReadonlyMap<string, MemoryPoint3D>,
  colorMap?: ReadonlyMap<string, { color?: string }>
): PackedMemoryGraph3D {
  const activeNodes: MemoryGraphNode[] = [];
  const nodeIndex = new Map<string, number>();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (!coordinates.has(node.id)) continue;
    nodeIndex.set(node.id, activeNodes.length);
    activeNodes.push(node);
  }

  const nodeCount = activeNodes.length;
  const positions = new Float32Array(nodeCount * 3);
  const colors = new Float32Array(nodeCount * 3);
  const sizes = new Float32Array(nodeCount);
  const flags = new Uint8Array(nodeCount);
  const nodeIds = new Array<string>(nodeCount);
  const neighbors = new Map<number, Set<number>>();

  let extent = 60;
  for (let i = 0; i < nodeCount; i++) {
    const node = activeNodes[i]!;
    const p = coordinates.get(node.id)!;
    nodeIds[i] = node.id;
    const offset = i * 3;
    positions[offset] = p.x;
    positions[offset + 1] = p.y;
    positions[offset + 2] = p.z;
    const dist = Math.hypot(p.x, p.y, p.z);
    if (dist > extent) extent = dist;

    const isRoot = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
    const isSource = node.type === "SOURCE";
    flags[i] = (isSource ? 1 : 0) | (isRoot ? 2 : 0);
    sizes[i] = isRoot ? 10 : isSource ? 4.6 : 2.1;

    const [r, g, b] = parseHexColorRgb(colorMap?.get(node.id)?.color);
    colors[offset] = r;
    colors[offset + 1] = g;
    colors[offset + 2] = b;
  }

  const validEdges: MemoryGraphEdge[] = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    if (nodeIndex.has(edge.source) && nodeIndex.has(edge.target)) {
      validEdges.push(edge);
    }
  }

  const edgeCount = validEdges.length;
  const edgeIndices = new Uint32Array(edgeCount * 2);
  const edgePositions = new Float32Array(edgeCount * 6);
  const edgeColors = new Float32Array(edgeCount * 6);

  const derivedColor = parseHexColorRgb("#385068");
  const defaultEdgeColor = parseHexColorRgb("#203343");

  for (let i = 0; i < edgeCount; i++) {
    const edge = validEdges[i]!;
    const aIdx = nodeIndex.get(edge.source)!;
    const bIdx = nodeIndex.get(edge.target)!;
    edgeIndices[i * 2] = aIdx;
    edgeIndices[i * 2 + 1] = bIdx;

    let setA = neighbors.get(aIdx);
    if (!setA) { setA = new Set(); neighbors.set(aIdx, setA); }
    setA.add(bIdx);

    let setB = neighbors.get(bIdx);
    if (!setB) { setB = new Set(); neighbors.set(bIdx, setB); }
    setB.add(aIdx);

    const posOffset = i * 6;
    const aOffset = aIdx * 3;
    const bOffset = bIdx * 3;
    edgePositions[posOffset] = positions[aOffset]!;
    edgePositions[posOffset + 1] = positions[aOffset + 1]!;
    edgePositions[posOffset + 2] = positions[aOffset + 2]!;
    edgePositions[posOffset + 3] = positions[bOffset]!;
    edgePositions[posOffset + 4] = positions[bOffset + 1]!;
    edgePositions[posOffset + 5] = positions[bOffset + 2]!;

    const [er, eg, eb] = edge.type === "DERIVED_FROM" ? derivedColor : defaultEdgeColor;
    edgeColors[posOffset] = er;
    edgeColors[posOffset + 1] = eg;
    edgeColors[posOffset + 2] = eb;
    edgeColors[posOffset + 3] = er;
    edgeColors[posOffset + 4] = eg;
    edgeColors[posOffset + 5] = eb;
  }

  return {
    nodeIds,
    nodeIndex,
    positions,
    colors,
    sizes,
    flags,
    edgeIndices,
    edgePositions,
    edgeColors,
    extent,
    neighbors
  };
}

/**
 * Fast allocation-free pointer hit-test over packed Float32Array buffers.
 * Finds the front-most node under `(screenX, screenY)`.
 */
export function pickMemoryNode3D(
  packed: PackedMemoryGraph3D,
  camera: MemoryCamera3D,
  width: number,
  height: number,
  screenX: number,
  screenY: number,
  focusedNodeId?: string | null
): string | null {
  const count = packed.nodeIds.length;
  if (count === 0 || width <= 0 || height <= 0) return null;

  const scale = (Math.min(width, height) * 0.4) / packed.extent;
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const sqrtZoom = Math.sqrt(camera.zoom);
  const halfW = width * 0.5;
  const halfH = height * 0.5;
  const focusedIdx = focusedNodeId ? (packed.nodeIndex.get(focusedNodeId) ?? -1) : -1;

  let bestIdx = -1;
  let bestZ = Infinity;

  const pos = packed.positions;
  const sizes = packed.sizes;

  for (let i = 0; i < count; i++) {
    const offset = i * 3;
    const px = pos[offset]!;
    const py = pos[offset + 1]!;
    const pz = pos[offset + 2]!;

    const rx = px * cosYaw + pz * sinYaw;
    const depth = -px * sinYaw + pz * cosYaw;
    const ry = py * cosPitch - depth * sinPitch;
    const rz = py * sinPitch + depth * cosPitch;
    const perspective = 650 / Math.max(120, 650 + rz * scale);

    const sx = halfW + rx * scale * camera.zoom * perspective;
    const sy = halfH - ry * scale * camera.zoom * perspective;
    const radius = Math.max(1, sizes[i]! * perspective * sqrtZoom) * (i === focusedIdx ? 1.5 : 1);
    const hitRadius = Math.max(7, radius + 3);

    const dx = sx - screenX;
    const dy = sy - screenY;
    if (dx * dx + dy * dy < hitRadius * hitRadius) {
      if (rz <= bestZ) {
        bestZ = rz;
        bestIdx = i;
      }
    }
  }

  return bestIdx >= 0 ? packed.nodeIds[bestIdx]! : null;
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
