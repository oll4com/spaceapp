import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";

export const MEMORY_CANVAS_LIMIT = 2000;
export const MEMORY_LABEL_CANDIDATES = 256;
export const MEMORY_LABEL_LIMIT = 96;

export interface MemoryRenderModel {
  nodes: MemoryGraphNode[];
  index: Map<string, number>;
  xyz: Float32Array;
  styles: Float32Array;
  edgeIndices: Int32Array;
  edgeKinds: Float32Array;
  neighbors: Map<number, number[]>;
  neighborOffsets?: Uint32Array;
  neighborIndices?: Uint32Array;
  labelCandidates: number[];
  extent: number;
}

export function memoryNodeRadius(node: MemoryGraphNode): number {
  return node.type === "SOURCE" ? isMemoryCoreLabel(node.label) ? 10 : 4.6 : 2.1;
}

export function memoryExtent(xyz: Float32Array): number {
  let extent = 60;
  for (let i = 0; i < xyz.length; i += 3) extent = Math.max(extent, Math.hypot(xyz[i]!, xyz[i + 1]!, xyz[i + 2]!));
  return extent;
}

/** Preparation happens once per graph, never once per camera frame. */
export function createMemoryRenderModel(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], positions: Map<string, MemoryAtlasPosition>, coordinates: Map<string, MemoryPoint3D>): MemoryRenderModel {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const xyz = new Float32Array(nodes.length * 3);
  const styles = new Float32Array(nodes.length * 4);
  const priority: number[][] = [[], [], []];
  nodes.forEach((node, i) => {
    const point = coordinates.get(node.id) ?? { x: 0, y: 0, z: 0 };
    xyz.set([point.x, point.y, point.z], i * 3);
    const hex = positions.get(node.id)?.color ?? "#7395ad";
    const color = Number.parseInt(hex.slice(1), 16);
    styles.set([(color >>> 16) / 255, ((color >>> 8) & 255) / 255, (color & 255) / 255, memoryNodeRadius(node)], i * 4);
    const bucket = priority[isMemoryCoreLabel(node.label) ? 0 : node.type === "SOURCE" ? 1 : 2]!;
    if (bucket.length < MEMORY_LABEL_CANDIDATES) bucket.push(i);
  });
  const indices: number[] = [], kinds: number[] = [];
  const neighbors = new Map<number, number[]>();
  for (const edge of edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined) continue;
    indices.push(a, b); kinds.push(edge.type === "DERIVED_FROM" ? 1 : 0);
    if (!neighbors.has(a)) neighbors.set(a, []);
    if (!neighbors.has(b)) neighbors.set(b, []);
    neighbors.get(a)!.push(b); neighbors.get(b)!.push(a);
  }
  return { nodes, index, xyz, styles, edgeIndices: new Int32Array(indices), edgeKinds: new Float32Array(kinds), neighbors,
    labelCandidates: priority.flat().slice(0, MEMORY_LABEL_CANDIDATES), extent: memoryExtent(xyz) };
}

/** Bounded, stable candidates; the selected/hovered node always gets first refusal. */
export function memoryLabelCandidates(model: MemoryRenderModel, camera: MemoryCamera3D, focus: number): number[] {
  const limit = camera.zoom < 0.6 ? 24 : camera.zoom < 1.6 ? 48 : MEMORY_LABEL_LIMIT;
  const candidates = focus >= 0 ? [focus] : [];
  for (const i of model.labelCandidates) {
    if (candidates.length >= limit) break;
    if (i === focus || (model.nodes[i]!.type !== "SOURCE" && camera.zoom < 1.6)) continue;
    candidates.push(i);
  }
  return candidates;
}
