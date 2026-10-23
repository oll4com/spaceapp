import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };

// The hidden Canvas 2D fallback keeps the overview caps; the WebGL2 view scales beyond them.
export const MEMORY_3D_CANVAS_NODE_LIMIT = 2000;
export const MEMORY_3D_CANVAS_EDGE_LIMIT = 6000;
// Label level of detail: measured and drawn labels are bounded whatever the graph size.
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

export type MemoryLayout3DStream = {
  /** Node ids in the deterministic processing order, aligned with `coordinates`. */
  ids: string[];
  /** Packed xyz triples for the ordered nodes, updated in place by `step`. */
  coordinates: Float64Array;
  /** Runs at most `batch` relaxation steps; returns true once the simulation has finished. */
  step(batch?: number): boolean;
  /** Deterministic final layout, identical to running all steps to completion. */
  finish(): Map<string, MemoryPoint3D>;
};

/**
 * Incremental force layout for the streaming worker: every step is a self-contained
 * pass, so the caller can yield between steps and post snapshots while it converges.
 * The cell size grows with the archive so the bounded-grid repulsion keeps a near
 * constant candidate count per node instead of degrading on 50k-node volumes.
 */
export function createMemoryLayout3DStream(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): MemoryLayout3DStream {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  const coordinates = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const node = ordered[i]!;
    coordinates[i * 3] = (unit(`${node.id}:x`) - 0.5) * 260;
    coordinates[i * 3 + 1] = (unit(`${node.id}:y`) - 0.5) * 260;
    coordinates[i * 3 + 2] = (unit(`${node.id}:z`) - 0.5) * 260;
  }
  if (root >= 0) { coordinates[root * 3] = 0; coordinates[root * 3 + 1] = 0; coordinates[root * 3 + 2] = 0; }
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
    const id = ordered[b]!.id;
    coordinates[b * 3] = coordinates[a * 3]! + (unit(`${id}:dx`) - 0.5) * 70;
    coordinates[b * 3 + 1] = coordinates[a * 3 + 1]! + (unit(`${id}:dy`) - 0.5) * 70;
    coordinates[b * 3 + 2] = coordinates[a * 3 + 2]! + (unit(`${id}:dz`) - 0.5) * 70;
  }
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  // Bounded spatial-grid repulsion and link springs act equally on all three axes.
  const steps = count > 10000 ? 120 : 180;
  const candidateCap = count > 20000 ? 48 : Number.POSITIVE_INFINITY;
  const clampCell = (value: number) => Math.max(-512, Math.min(511, Math.floor(value)));
  let stepIndex = 0;
  const step = () => {
    fx.fill(0); fy.fill(0); fz.fill(0);
    let extent = 60;
    for (let i = 0; i < count; i++) {
      const spread = Math.hypot(coordinates[i * 3]!, coordinates[i * 3 + 1]!, coordinates[i * 3 + 2]!);
      if (spread > extent) extent = spread;
    }
    const cell = Math.max(32, Math.cbrt(16.8 * extent ** 3 / Math.max(8, count)));
    const grid = new Map<number, number[]>();
    for (let i = 0; i < count; i++) {
      const key = ((clampCell(coordinates[i * 3]! / cell) + 512) * 1024 + (clampCell(coordinates[i * 3 + 1]! / cell) + 512)) * 1024 + (clampCell(coordinates[i * 3 + 2]! / cell) + 512);
      const members = grid.get(key);
      if (members) members.push(i); else grid.set(key, [i]);
    }
    const neighborCell = (gx: number, gy: number, gz: number) => grid.get(((gx + 512) * 1024 + (gy + 512)) * 1024 + (gz + 512));
    for (let i = 0; i < count; i++) {
      const p = { x: coordinates[i * 3]!, y: coordinates[i * 3 + 1]!, z: coordinates[i * 3 + 2]! };
      const gx = clampCell(p.x / cell), gy = clampCell(p.y / cell), gz = clampCell(p.z / cell);
      let candidates = 0;
      for (let x = gx - 1; x <= gx + 1; x++) {
        for (let y = gy - 1; y <= gy + 1; y++) {
          for (let z = gz - 1; z <= gz + 1; z++) {
            const members = neighborCell(x, y, z);
            if (!members) continue;
            for (const j of members) {
              if (j <= i || candidates >= candidateCap) continue;
              candidates++;
              const dx = p.x - coordinates[j * 3]!, dy = p.y - coordinates[j * 3 + 1]!, dz = p.z - coordinates[j * 3 + 2]!;
              const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
              const strength = (ordered[i]!.type === "SOURCE" || ordered[j]!.type === "SOURCE" ? 28 : 12) / distanceSquared;
              fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
              fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
            }
          }
          if (candidates >= candidateCap) break;
        }
        if (candidates >= candidateCap) break;
      }
    }
    for (const link of links) {
      const a = link.a * 3, b = link.b * 3;
      const dx = coordinates[b]! - coordinates[a]!, dy = coordinates[b + 1]! - coordinates[a + 1]!, dz = coordinates[b + 2]! - coordinates[a + 2]!;
      const distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - link.length) * link.strength / distance;
      fx[link.a]! += dx * spring; fy[link.a]! += dy * spring; fz[link.a]! += dz * spring;
      fx[link.b]! -= dx * spring; fy[link.b]! -= dy * spring; fz[link.b]! -= dz * spring;
    }
    const cooling = 1 - stepIndex / 230;
    let movement = 0;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const dx = fx[i]! - coordinates[i * 3]! * 0.0005, dy = fy[i]! - coordinates[i * 3 + 1]! * 0.0005, dz = fz[i]! - coordinates[i * 3 + 2]! * 0.0005;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      coordinates[i * 3]! += dx * stepScale; coordinates[i * 3 + 1]! += dy * stepScale; coordinates[i * 3 + 2]! += dz * stepScale;
      movement += Math.abs(dx * stepScale) + Math.abs(dy * stepScale) + Math.abs(dz * stepScale);
    }
    stepIndex++;
    return movement < 0.1;
  };
  return {
    ids: ordered.map(node => node.id),
    coordinates,
    step(batch = 1) {
      for (let batchIndex = 0; batchIndex < batch; batchIndex++) if (stepIndex < steps && step()) { stepIndex = steps; break; }
      return stepIndex >= steps;
    },
    finish() {
      while (!this.step(64)) continue;
      return new Map(ordered.map((node, i) => [node.id, { x: coordinates[i * 3]!, y: coordinates[i * 3 + 1]!, z: coordinates[i * 3 + 2]! }]));
    }
  };
}

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  return createMemoryLayout3DStream(nodes, edges).finish();
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

export type Memory3DPicker = {
  /** Projects every node and rebuilds the uniform screen-space index; O(n), called only when the camera or coordinates moved. */
  update(nodes: MemoryGraphNode[], coordinates: Map<string, MemoryPoint3D>, camera: MemoryCamera3D, scale: number, width: number, height: number): void;
  /** Nearest node under the pointer with the drawn-radius hit rule; no linear scan. */
  pick(x: number, y: number): string | null;
};

/** Uniform screen-space index for hover and click hit-testing: cell lookup instead of a per-pointer linear scan. */
export function createMemory3DPicker(): Memory3DPicker {
  let cell = 48, columns = 1, rows = 1, starts = new Int32Array(1), items = new Int32Array(0);
  let sx = new Float64Array(0), sy = new Float64Array(0), sr = new Float64Array(0), sz = new Float64Array(0);
  let ids: string[] = [];
  const update: Memory3DPicker["update"] = (nodes, coordinates, camera, scale, width, height) => {
    const total = nodes.length;
    sx = new Float64Array(total); sy = new Float64Array(total); sr = new Float64Array(total); sz = new Float64Array(total);
    ids = [];
    let maxRadius = 7;
    for (let slot = 0; slot < total; slot++) {
      const node = nodes[slot]!, point = coordinates.get(node.id);
      if (!point) continue;
      const p = projectMemoryPoint(point, camera, scale, width, height);
      const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
      const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * p.perspective * Math.sqrt(camera.zoom));
      sx[slot] = p.x; sy[slot] = p.y; sr[slot] = radius; sz[slot] = p.z;
      ids.push(node.id);
      const reach = radius + 3;
      if (reach > maxRadius) maxRadius = reach;
    }
    cell = Math.max(48, maxRadius + 8);
    columns = Math.max(1, Math.ceil(width / cell)); rows = Math.max(1, Math.ceil(height / cell));
    const cells = columns * rows;
    const counts = new Int32Array(cells + 1);
    const cellOf = (slot: number) => Math.min(cells - 1, Math.max(0, Math.floor(sy[slot]! / cell) * columns + Math.floor(sx[slot]! / cell)));
    for (let slot = 0; slot < ids.length; slot++) counts[cellOf(slot) + 1] = counts[cellOf(slot) + 1]! + 1;
    for (let index = 0; index < cells; index++) counts[index + 1] = counts[index + 1]! + counts[index]!;
    starts = counts;
    items = new Int32Array(ids.length);
    const cursor = new Int32Array(cells);
    for (let slot = 0; slot < ids.length; slot++) {
      const target = starts[cellOf(slot)]! + cursor[cellOf(slot)]!;
      cursor[cellOf(slot)] = cursor[cellOf(slot)]! + 1;
      items[target] = slot;
    }
  };
  const pick: Memory3DPicker["pick"] = (x, y) => {
    const column = Math.floor(x / cell), row = Math.floor(y / cell);
    let best: string | null = null, bestZ = Number.POSITIVE_INFINITY;
    for (let ry = row - 1; ry <= row + 1; ry++) {
      for (let rx = column - 1; rx <= column + 1; rx++) {
        if (rx < 0 || ry < 0 || rx >= columns || ry >= rows) continue;
        for (let at = starts[ry * columns + rx]!; at < starts[ry * columns + rx + 1]!; at++) {
          const slot = items[at]!, reach = Math.max(7, sr[slot]! + 3);
          if (Math.hypot(sx[slot]! - x, sy[slot]! - y) >= reach) continue;
          // The canvas draws far nodes first, so the closest one wins the pointer.
          if (sz[slot]! < bestZ) { bestZ = sz[slot]!; best = ids[slot]!; }
        }
      }
    }
    return best;
  };
  return { update, pick };
}

export type Memory3DLabelInput = {
  nodes: Array<{ id: string; label: string; type: MemoryGraphNode["type"] }>;
  /** Screen-space position of a node; only the bounded candidate set is ever projected. */
  project: (id: string) => { x: number; y: number } | undefined;
  focus: string | null;
  zoom: number;
  width: number;
  height: number;
  measure: (label: string) => number;
  maxMeasured?: number;
  maxDrawn?: number;
};

/**
 * Bounded label selection with the current rules (core and source labels first,
 * collision avoidance) plus level of detail: at most `maxMeasured` labels are
 * measured and `maxDrawn` drawn per frame, whatever the graph size.
 */
export function selectMemory3DLabels(input: Memory3DLabelInput): Array<{ id: string; label: string; x: number; y: number; w: number }> {
  const maxMeasured = input.maxMeasured ?? MAX_MEMORY_3D_LABELS_MEASURED;
  const maxDrawn = input.maxDrawn ?? MAX_MEMORY_3D_LABELS_DRAWN;
  // Priority buckets instead of a per-frame sort — the exact comparator classes:
  // focus, then core labels (sources among core first), then the remaining sources,
  // with each group keeping its input order. At 50k nodes a full sort with the
  // localeCompare id tiebreak ran every frame once zoom >= 1.6, while the layout
  // order is already deterministic, so the buckets are enough.
  const focusNodes: Memory3DLabelInput["nodes"] = [], coreSourceNodes: Memory3DLabelInput["nodes"] = [], coreNodes: Memory3DLabelInput["nodes"] = [], sourceNodes: Memory3DLabelInput["nodes"] = [], restNodes: Memory3DLabelInput["nodes"] = [];
  for (const node of input.nodes) {
    if (node.type !== "SOURCE" && node.id !== input.focus && input.zoom < 1.6) continue;
    if (node.id === input.focus) focusNodes.push(node);
    else if (isMemoryCoreLabel(node.label)) {
      if (node.type === "SOURCE") coreSourceNodes.push(node); else coreNodes.push(node);
    }
    else if (node.type === "SOURCE") sourceNodes.push(node);
    else restNodes.push(node);
  }
  const candidates = [...focusNodes, ...coreSourceNodes, ...coreNodes, ...sourceNodes, ...restNodes];
  const boxes: Array<{ x: number; y: number; w: number }> = [];
  const drawn: Array<{ id: string; label: string; x: number; y: number; w: number }> = [];
  let measured = 0;
  for (const node of candidates) {
    if (drawn.length >= maxDrawn || measured >= maxMeasured) break;
    const p = input.project(node.id);
    if (!p) continue;
    measured++;
    const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
    const w = input.measure(label);
    const x = p.x + 9, y = p.y;
    if (x + w > input.width || y < 14 || y > input.height - 5 || boxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
    boxes.push({ x, y, w });
    drawn.push({ id: node.id, label, x, y, w });
  }
  return drawn;
}
