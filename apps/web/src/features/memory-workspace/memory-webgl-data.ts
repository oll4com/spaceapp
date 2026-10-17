import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

export const MEMORY_LABEL_CANDIDATES = 384;
export const MEMORY_LABEL_LIMIT = 64;
export const MEMORY_FALLBACK_LIMIT = 2000;

/** Run once per graph, never per frame. Priority pools have hard bounds. */
export function memoryLabelCandidates(nodes: MemoryGraphNode[]): number[] {
  const core: number[] = [], sources: number[] = [], other: number[] = [];
  nodes.forEach((node, index) => {
    const pool = isMemoryCoreLabel(node.label) ? core : node.type === "SOURCE" ? sources : other;
    if (pool.length < MEMORY_LABEL_CANDIDATES) pool.push(index);
  });
  return [...core, ...sources, ...other].slice(0, MEMORY_LABEL_CANDIDATES);
}

export function memoryLabelsAtZoom(nodes: MemoryGraphNode[], candidates: number[], zoom: number, focus: number): number[] {
  const result = focus >= 0 ? [focus] : [];
  for (const index of candidates) {
    if (index !== focus && (nodes[index]?.type === "SOURCE" || zoom >= 1.6 || isMemoryCoreLabel(nodes[index]?.label ?? ""))) result.push(index);
    if (result.length >= MEMORY_LABEL_CANDIDATES) break;
  }
  return result;
}

export function prepareMemoryGpuData(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], styles: Map<string, MemoryAtlasPosition>) {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const colors = new Uint8Array(nodes.length * 4);
  const radii = new Float32Array(nodes.length);
  const degrees = new Uint32Array(nodes.length);
  const endpoints: number[] = [];
  const edgeKinds: number[] = [];
  nodes.forEach((node, i) => {
    const rgb = Number.parseInt((styles.get(node.id)?.color ?? "#7395ad").slice(1), 16);
    colors.set([(rgb >>> 16) & 255, (rgb >>> 8) & 255, rgb & 255, 255], i * 4);
    radii[i] = node.type === "SOURCE" ? isMemoryCoreLabel(node.label) ? 10 : 4.6 : 2.1;
  });
  for (const edge of edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined) continue;
    endpoints.push(a, b); edgeKinds.push(edge.type === "DERIVED_FROM" ? 1 : 0);
    degrees[a]!++; degrees[b]!++;
  }
  const offsets = new Uint32Array(nodes.length + 1);
  for (let i = 0; i < nodes.length; i++) offsets[i + 1] = offsets[i]! + degrees[i]!;
  const cursor = offsets.slice();
  const neighbors = new Uint32Array(endpoints.length);
  for (let i = 0; i < endpoints.length; i += 2) {
    const a = endpoints[i]!, b = endpoints[i + 1]!;
    neighbors[cursor[a]!] = b; cursor[a]!++;
    neighbors[cursor[b]!] = a; cursor[b]!++;
  }
  return { index, colors, radii, endpoints: new Uint32Array(endpoints), edgeKinds: new Float32Array(edgeKinds), offsets, neighbors,
    labels: memoryLabelCandidates(nodes) };
}

export function memoryFallbackGraph(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]) {
  const selected = nodes.slice(0, MEMORY_FALLBACK_LIMIT);
  const ids = new Set(selected.map(node => node.id));
  return { nodes: selected, edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).slice(0, MEMORY_FALLBACK_LIMIT * 3) };
}
