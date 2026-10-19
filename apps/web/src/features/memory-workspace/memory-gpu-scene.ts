import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";
import { projectMemoryPoint } from "./memory-3d.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

export const MEMORY_TEXTURE_WIDTH = 256;
export const MEMORY_LABEL_CANDIDATES = 256;
export const MEMORY_LABEL_LIMIT = 64;
export type MemoryGpuScene = {
  nodes: MemoryGraphNode[];
  index: Map<string, number>;
  coordinates: Float32Array;
  colors: Float32Array;
  neighbors: Uint8Array;
  edges: Float32Array;
  edgeCount: number;
  offsets: Uint32Array;
  adjacency: Uint32Array;
  labelCandidates: number[];
  extent: number;
};

/** Yield between bounded batches; building a large graph must not monopolize input. */
const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const colorChannels = (color: string) => {
  const hex = /^#[\da-f]{6}$/i.test(color) ? color.slice(1) : "7395ad";
  return [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
};

export async function buildMemoryGpuScene(
  nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], positions: Map<string, MemoryAtlasPosition>,
  points: Map<string, MemoryPoint3D>, cancelled: () => boolean = () => false,
): Promise<MemoryGpuScene | null> {
  const size = Math.max(MEMORY_TEXTURE_WIDTH, Math.ceil(nodes.length / MEMORY_TEXTURE_WIDTH) * MEMORY_TEXTURE_WIDTH);
  const coordinates = new Float32Array(size * 4), colors = new Float32Array(size * 4);
  const index = new Map<string, number>();
  const core: number[] = [], source: number[] = [], other: number[] = [];
  let extent = 60;
  for (let start = 0; start < nodes.length; start += 2048) {
    if (cancelled()) return null;
    for (let i = start; i < Math.min(start + 2048, nodes.length); i++) {
      const node = nodes[i]!, point = points.get(node.id) ?? { x: 0, y: 0, z: 0 };
      index.set(node.id, i);
      const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
      coordinates.set([point.x, point.y, point.z, root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1], i * 4);
      colors.set([...colorChannels(positions.get(node.id)?.color ?? "#7395ad"), root ? 1 : 0], i * 4);
      extent = Math.max(extent, Math.hypot(point.x, point.y, point.z));
      const bucket = isMemoryCoreLabel(node.label) ? core : node.type === "SOURCE" ? source : other;
      // Priority buckets are bounded while indexing; there is no per-frame graph scan.
      if (bucket.length < MEMORY_LABEL_CANDIDATES) bucket.push(i);
    }
    if (nodes.length > 2048) await nextTask();
  }
  const links = new Float32Array(edges.length * 3), counts = new Uint32Array(nodes.length);
  let edgeCount = 0;
  for (let start = 0; start < edges.length; start += 8192) {
    if (cancelled()) return null;
    for (let i = start; i < Math.min(start + 8192, edges.length); i++) {
      const edge = edges[i]!, a = index.get(edge.source), b = index.get(edge.target);
      if (a === undefined || b === undefined) continue;
      links.set([a, b, edge.type === "DERIVED_FROM" ? 1 : 0], edgeCount++ * 3);
      counts[a]!++; counts[b]!++;
    }
    if (edges.length > 8192) await nextTask();
  }
  const offsets = new Uint32Array(nodes.length + 1);
  for (let i = 0; i < nodes.length; i++) offsets[i + 1] = offsets[i]! + counts[i]!;
  const cursors = offsets.slice(), adjacency = new Uint32Array(edgeCount * 2);
  for (let start = 0; start < edgeCount; start += 8192) {
    if (cancelled()) return null;
    for (let i = start; i < Math.min(start + 8192, edgeCount); i++) {
      const a = links[i * 3]!, b = links[i * 3 + 1]!;
      adjacency[cursors[a]!] = b; cursors[a]!++;
      adjacency[cursors[b]!] = a; cursors[b]!++;
    }
    if (edgeCount > 8192) await nextTask();
  }
  return { nodes, index, coordinates, colors, neighbors: new Uint8Array(size), edges: links,
    edgeCount, offsets, adjacency, labelCandidates: [...core, ...source, ...other].slice(0, MEMORY_LABEL_CANDIDATES), extent };
}

export function updateMemoryCoordinates(scene: MemoryGpuScene, points: Map<string, MemoryPoint3D>) {
  let extent = 60;
  for (let i = 0; i < scene.nodes.length; i++) {
    const p = points.get(scene.nodes[i]!.id);
    if (p) { scene.coordinates[i * 4] = p.x; scene.coordinates[i * 4 + 1] = p.y; scene.coordinates[i * 4 + 2] = p.z; }
    extent = Math.max(extent, Math.hypot(scene.coordinates[i * 4]!, scene.coordinates[i * 4 + 1]!, scene.coordinates[i * 4 + 2]!));
  }
  scene.extent = extent;
}

export type PreparedMemoryCoordinates = Pick<MemoryGpuScene, "coordinates" | "extent">;

/** Prepare a complete snapshot without mutating the currently displayed scene. */
export async function prepareMemoryCoordinates(
  scene: MemoryGpuScene, points: Map<string, MemoryPoint3D>, cancelled: () => boolean = () => false,
): Promise<PreparedMemoryCoordinates | null> {
  if (cancelled()) return null;
  const previous = scene.coordinates, coordinates = new Float32Array(previous.length);
  let extent = 60, index = 0;
  while (index < scene.nodes.length) {
    if (cancelled()) return null;
    const started = performance.now(), end = Math.min(index + 2048, scene.nodes.length);
    for (; index < end; index++) {
      const offset = index * 4, point = points.get(scene.nodes[index]!.id);
      coordinates[offset] = point?.x ?? previous[offset]!;
      coordinates[offset + 1] = point?.y ?? previous[offset + 1]!;
      coordinates[offset + 2] = point?.z ?? previous[offset + 2]!;
      coordinates[offset + 3] = previous[offset + 3]!;
      extent = Math.max(extent, Math.hypot(coordinates[offset]!, coordinates[offset + 1]!, coordinates[offset + 2]!));
      // Check the clock every 64 nodes, while retaining a hard batch-size bound.
      if ((index & 63) === 63 && performance.now() - started >= 4) { index++; break; }
    }
    if (index < scene.nodes.length) await nextTask();
  }
  return cancelled() ? null : { coordinates, extent };
}

export function markMemoryNeighbors(scene: MemoryGpuScene, focus: number) {
  scene.neighbors.fill(0);
  if (focus < 0 || focus >= scene.nodes.length) return;
  for (let i = scene.offsets[focus]!; i < scene.offsets[focus + 1]!; i++) scene.neighbors[scene.adjacency[i]!] = 255;
}

/** Bounded label work, with focus/core/source priority and screen-space collisions. */
export function memoryVisibleLabels(scene: MemoryGpuScene, camera: MemoryCamera3D, width: number, height: number,
  focus: number, measure: (text: string) => number) {
  const candidates = focus >= 0 ? [focus, ...scene.labelCandidates.filter(i => i !== focus)] : scene.labelCandidates;
  const labels: Array<{ index: number; text: string; x: number; y: number; width: number; core: boolean }> = [];
  const scale = Math.min(width, height) * 0.4 / scene.extent;
  let measured = 0;
  for (const index of candidates) {
    if (labels.length >= MEMORY_LABEL_LIMIT || measured >= MEMORY_LABEL_CANDIDATES) break;
    const node = scene.nodes[index];
    if (!node || (node.type !== "SOURCE" && index !== focus && camera.zoom < 1.6)) continue;
    const offset = index * 4;
    const p = projectMemoryPoint({ x: scene.coordinates[offset]!, y: scene.coordinates[offset + 1]!, z: scene.coordinates[offset + 2]! }, camera, scale, width, height);
    const x = p.x + 9, y = p.y;
    if (x < 0 || x >= width || y < 14 || y > height - 5) continue;
    const text = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
    const textWidth = measure(text); measured++;
    if (x + textWidth > width || labels.some(label => Math.abs(label.y - y) < 16 && x < label.x + label.width + 5 && x + textWidth + 5 > label.x)) continue;
    labels.push({ index, text, x, y, width: textWidth, core: isMemoryCoreLabel(node.label) });
  }
  return labels;
}

/** RGB picking reserves zero for the background and supports the full 50k range. */
export function memoryPickId(pixel: Uint8Array, nodeCount: number) {
  const id = pixel[0]! + pixel[1]! * 256 + pixel[2]! * 65536 - 1;
  return id >= 0 && id < nodeCount ? id : -1;
}
