import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";

export const MEMORY_ZOOM_MIN = 0.35;
export const MEMORY_ZOOM_MAX = 5;
export const clampMemoryZoom = (zoom: number) => Math.max(MEMORY_ZOOM_MIN, Math.min(MEMORY_ZOOM_MAX, zoom));
/** The Canvas 2D fallback keeps the original node cap. */
export const MEMORY_CANVAS_FALLBACK_MAX_NODES = 2000;

/** Largest distance from the origin in packed x,y,z coordinates (at least 60, as before). */
export function memoryViewExtent(coordinates: ArrayLike<number>): number {
  let max = 60 * 60;
  for (let i = 0; i + 2 < coordinates.length; i += 3) {
    const x = coordinates[i]!, y = coordinates[i + 1]!, z = coordinates[i + 2]!;
    max = Math.max(max, x * x + y * y + z * z);
  }
  return Math.sqrt(max);
}

export type MemoryCameraUniforms = {
  cosYaw: number; sinYaw: number; cosPitch: number; sinPitch: number;
  scale: number; zoom: number; halfWidth: number; halfHeight: number; depthRange: number;
};

/** Everything the vertex shader needs to reproduce `projectMemoryPoint` on the GPU. */
export function memoryCameraUniforms(camera: MemoryCamera3D, extent: number, width: number, height: number): MemoryCameraUniforms {
  return {
    cosYaw: Math.cos(camera.yaw), sinYaw: Math.sin(camera.yaw), cosPitch: Math.cos(camera.pitch), sinPitch: Math.sin(camera.pitch),
    scale: Math.min(width, height) * 0.4 / extent, zoom: camera.zoom,
    halfWidth: width / 2, halfHeight: height / 2, depthRange: extent * 1.05
  };
}

/** CPU mirror of the vertex shader: clip-space position, perspective factor and camera depth. */
export function projectMemoryClip(point: MemoryPoint3D, u: MemoryCameraUniforms) {
  const x = point.x * u.cosYaw + point.z * u.sinYaw;
  const depth = -point.x * u.sinYaw + point.z * u.cosYaw;
  const y = point.y * u.cosPitch - depth * u.sinPitch;
  const z = point.y * u.sinPitch + depth * u.cosPitch;
  const perspective = 650 / Math.max(120, 650 + z * u.scale);
  return {
    x: x * u.scale * u.zoom * perspective / u.halfWidth,
    y: y * u.scale * u.zoom * perspective / u.halfHeight,
    depth: Math.max(-1, Math.min(1, z / u.depthRange)),
    perspective
  };
}

export const memoryNodeRadius = (kind: "root" | "source" | "other", perspective: number, zoom: number, highlighted: boolean) =>
  Math.max(1, (kind === "root" ? 10 : kind === "source" ? 4.6 : 2.1) * perspective * Math.sqrt(zoom)) * (highlighted ? 1.5 : 1);

/** Hit area for a drawn node: at least 7 px, as in the Canvas 2D renderer. */
export const memoryPickRadius = (radius: number) => Math.max(7, radius + 3);

/** GPU picking ids: node index + 1 in RGB (alpha 255), so that 0 means "nothing". */
export function encodeMemoryPickId(index: number): [number, number, number, number] {
  const id = index + 1;
  return [id & 255, (id >> 8) & 255, (id >> 16) & 255, 255];
}
export function decodeMemoryPickId(pixel: ArrayLike<number>): number {
  return (pixel[0]! | (pixel[1]! << 8) | (pixel[2]! << 16)) - 1;
}

/** The node under (x, y) given screen-space circles, front-most first. Used by the Canvas 2D fallback. */
export function pickMemoryCircle(circles: Array<{ x: number; y: number; z: number; radius: number }>, x: number, y: number): number {
  let best = -1, bestDepth = Infinity;
  for (let i = 0; i < circles.length; i++) {
    const c = circles[i]!;
    if (c.z < bestDepth && Math.hypot(c.x - x, c.y - y) < memoryPickRadius(c.radius)) { best = i; bestDepth = c.z; }
  }
  return best;
}

export function memoryPercentile(values: ArrayLike<number>, fraction: number): number {
  if (!values.length) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

/**
 * Node indices in label priority order: core files, other files, then everything else by
 * connection count. Sources always precede non-sources, which lets the selector stop early.
 */
export function memoryLabelOrder(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Uint32Array {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const degree = new Uint32Array(nodes.length);
  for (const edge of edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a !== undefined) degree[a]! += 1;
    if (b !== undefined) degree[b]! += 1;
  }
  const rank = (i: number) => nodes[i]!.type === "SOURCE" ? (isMemoryCoreLabel(nodes[i]!.label) ? 0 : 1) : 2;
  return Uint32Array.from(nodes.map((_, i) => i).sort((a, b) => rank(a) - rank(b) || degree[b]! - degree[a]! || a - b));
}

export const MAX_LABEL_CANDIDATES = 300;
export const MAX_LABELS_DRAWN = 120;
export type MemoryLabelPlacement = { index: number; x: number; y: number; width: number };

/**
 * Picks the labels to draw. Work is bounded by `maxCandidates` projected nodes and `maxLabels`
 * measured labels, whatever the graph size. The focused node goes first; non-source labels only
 * appear once zoomed in (or when focused). Overlapping labels are dropped.
 */
export function selectMemoryLabels(input: {
  order: ArrayLike<number>; focus: number; zoom: number; width: number; height: number;
  isSource: (index: number) => boolean;
  project: (index: number) => { x: number; y: number } | null;
  measure: (index: number) => number;
  maxCandidates?: number; maxLabels?: number;
}): MemoryLabelPlacement[] {
  const { order, focus, zoom, width, height } = input;
  const maxCandidates = input.maxCandidates ?? MAX_LABEL_CANDIDATES, maxLabels = input.maxLabels ?? MAX_LABELS_DRAWN;
  const placed: MemoryLabelPlacement[] = [];
  let examined = 0;
  const consider = (index: number) => {
    examined++;
    const p = input.project(index);
    if (!p) return;
    const x = p.x + 9, y = p.y;
    if (x > width || y < 14 || y > height - 5) return;
    const labelWidth = input.measure(index);
    if (x + labelWidth > width) return;
    if (placed.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.width + 5 && x + labelWidth + 5 > box.x)) return;
    placed.push({ index, x, y, width: labelWidth });
  };
  if (focus >= 0) consider(focus);
  for (let k = 0; k < order.length && examined < maxCandidates && placed.length < maxLabels; k++) {
    const index = order[k]!;
    if (index === focus) continue;
    if (!input.isSource(index) && zoom < 1.6) break;
    consider(index);
  }
  return placed;
}

const hexCache = new Map<string, [number, number, number]>();
/** "#rrggbb" to bytes; anything else falls back to the default node color. */
export function parseMemoryHexColor(color: string | undefined): [number, number, number] {
  const key = color ?? "";
  let rgb = hexCache.get(key);
  if (!rgb) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(key);
    rgb = match ? [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)] : [0x73, 0x95, 0xad];
    hexCache.set(key, rgb);
  }
  return rgb;
}

export type MemoryScene = {
  count: number;
  index: Map<string, number>;
  colors: Uint8Array;
  /** 0 other, 1 source, 2 core source. */
  kinds: Uint8Array;
  edgeEnds: Uint32Array;
  edgeKinds: Uint8Array;
  labelOrder: Uint32Array;
};

/** Typed-array form of the graph that the WebGL renderer uploads once per data change. */
export function buildMemoryScene(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], colorOf: (id: string) => string | undefined): MemoryScene {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const colors = new Uint8Array(nodes.length * 4), kinds = new Uint8Array(nodes.length);
  nodes.forEach((node, i) => {
    const [r, g, b] = parseMemoryHexColor(colorOf(node.id));
    colors[i * 4] = r; colors[i * 4 + 1] = g; colors[i * 4 + 2] = b; colors[i * 4 + 3] = 255;
    kinds[i] = node.type === "SOURCE" ? (isMemoryCoreLabel(node.label) ? 2 : 1) : 0;
  });
  const ends: number[] = [], edgeKinds: number[] = [];
  for (const edge of edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined) continue;
    ends.push(a, b);
    edgeKinds.push(edge.type === "DERIVED_FROM" ? 1 : 0);
  }
  return { count: nodes.length, index, colors, kinds, edgeEnds: Uint32Array.from(ends), edgeKinds: Uint8Array.from(edgeKinds), labelOrder: memoryLabelOrder(nodes, edges) };
}

/** Per-node highlight state: 2 for the focused node, 1 for its direct neighbors, else 0. */
export function memoryFocusFlags(scene: Pick<MemoryScene, "count" | "edgeEnds">, focus: number, out = new Uint8Array(scene.count)): Uint8Array {
  out.fill(0);
  if (focus < 0 || focus >= scene.count) return out;
  for (let e = 0; e < scene.edgeEnds.length; e += 2) {
    const a = scene.edgeEnds[e]!, b = scene.edgeEnds[e + 1]!;
    if (a === focus) out[b] = 1;
    if (b === focus) out[a] = 1;
  }
  out[focus] = 2;
  return out;
}
