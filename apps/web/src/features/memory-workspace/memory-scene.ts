import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { createMemoryAtlas, type MemoryAtlasGroup } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { compareMemoryIds } from "./memory-order.js";

export const NODE_KIND = { SOURCE: 0, TOPIC: 1, ROOM: 2, MEMORY: 3, SECTION: 4, PROVENANCE: 5, CACHE_RECORD: 6 } as const;
export const FLAG_CORE = 1, FLAG_HUB = 2;
export const EDGE_OTHER = 0, EDGE_DERIVED = 1, EDGE_CONTAINS = 2;
export const FALLBACK_MAX_NODES = 2000, FALLBACK_MAX_EDGES = 6000;

export interface MemoryScene {
  count: number; edgeCount: number;
  ids: string[]; labels: string[];
  kind: Uint8Array; flags: Uint8Array; rgb: Uint8Array;
  edgeSource: Uint32Array; edgeTarget: Uint32Array; edgeKind: Uint8Array;
  root: number;
  stats: MemorySceneStats;
}
export interface MemorySceneStats {
  nodeCount: number; edgeCount: number; memoryCount: number; sourceCount: number; sourceLinkCount: number;
  rootVisible: boolean; semanticCount: number; groups: MemoryAtlasGroup[];
}

const hexToRgb = (hex: string): [number, number, number] => {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return Number.isFinite(value) ? [(value >> 16) & 255, (value >> 8) & 255, value & 255] : [0x73, 0x95, 0xad];
};

/** Compact, transferable description of the 3D view. Node index i matches layout state index i (ids ascending). */
export function buildMemoryScene(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): { scene: MemoryScene; sortedNodes: MemoryGraphNode[]; sortedEdges: MemoryGraphEdge[] } {
  const atlas = createMemoryAtlas(nodes, edges, false);
  const sortedNodes = [...atlas.nodes].sort((a, b) => compareMemoryIds(a.id, b.id)); // same order the layout uses
  const index = new Map(sortedNodes.map((node, i) => [node.id, i]));
  const count = sortedNodes.length;
  const kind = new Uint8Array(count), flags = new Uint8Array(count), rgb = new Uint8Array(count * 3);
  const ids: string[] = new Array(count), labels: string[] = new Array(count);
  let root = -1, memoryCount = 0, sourceCount = 0;
  const colorCache = new Map<string, [number, number, number]>();
  sortedNodes.forEach((node, i) => {
    ids[i] = node.id; labels[i] = node.label; kind[i] = NODE_KIND[node.type];
    const position = atlas.positions.get(node.id);
    const core = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
    if (core && root < 0) root = i;
    flags[i] = (core ? FLAG_CORE : 0) | (position?.hub ? FLAG_HUB : 0);
    const hex = position?.color ?? "#7395ad";
    let color = colorCache.get(hex);
    if (!color) colorCache.set(hex, color = hexToRgb(hex));
    rgb[i * 3] = color[0]; rgb[i * 3 + 1] = color[1]; rgb[i * 3 + 2] = color[2];
    if (node.type === "MEMORY") memoryCount++;
    if (node.type === "SOURCE") sourceCount++;
  });
  const sortedEdges = atlas.edges;
  const edgeSource = new Uint32Array(sortedEdges.length), edgeTarget = new Uint32Array(sortedEdges.length), edgeKind = new Uint8Array(sortedEdges.length);
  let sourceLinkCount = 0;
  sortedEdges.forEach((edge, i) => {
    edgeSource[i] = index.get(edge.source)!; edgeTarget[i] = index.get(edge.target)!;
    edgeKind[i] = edge.type === "DERIVED_FROM" ? EDGE_DERIVED : edge.type === "CONTAINS" ? EDGE_CONTAINS : EDGE_OTHER;
    if (edge.type === "CONTAINS" || edge.type === "DERIVED_FROM") sourceLinkCount++;
  });
  return {
    sortedNodes, sortedEdges,
    scene: {
      count, edgeCount: sortedEdges.length, ids, labels, kind, flags, rgb, edgeSource, edgeTarget, edgeKind, root,
      stats: { nodeCount: count, edgeCount: sortedEdges.length, memoryCount, sourceCount, sourceLinkCount, rootVisible: root >= 0, semanticCount: atlas.semanticCount, groups: atlas.groups }
    }
  };
}

export const sceneTransferables = (scene: MemoryScene): ArrayBuffer[] =>
  [scene.kind.buffer, scene.flags.buffer, scene.rgb.buffer, scene.edgeSource.buffer, scene.edgeTarget.buffer, scene.edgeKind.buffer] as ArrayBuffer[];

const TYPE_BY_KIND = Object.keys(NODE_KIND) as Array<MemoryGraphNode["type"]>;

/**
 * Bounded node/edge arrays for the Canvas 2D fallback: the core and sources first, then the lowest indices,
 * and links between kept nodes with source links first. `indices[i]` is the scene index of legacy node i.
 */
export function capSceneForFallback(scene: MemoryScene, maxNodes = FALLBACK_MAX_NODES, maxEdges = FALLBACK_MAX_EDGES) {
  const picked: number[] = [], chosen = new Uint8Array(scene.count);
  const take = (i: number) => { if (!chosen[i] && picked.length < maxNodes) { chosen[i] = 1; picked.push(i); } };
  if (scene.root >= 0) take(scene.root);
  for (let i = 0; i < scene.count; i++) if (scene.kind[i] === NODE_KIND.SOURCE) take(i);
  for (let i = 0; i < scene.count && picked.length < maxNodes; i++) take(i);
  picked.sort((a, b) => a - b);
  const local = new Map(picked.map((scenei, i) => [scenei, i]));
  const nodes: MemoryGraphNode[] = picked.map(i => ({ id: scene.ids[i]!, label: scene.labels[i]!, type: TYPE_BY_KIND[scene.kind[i]!]!, sourcePath: null, recordId: null }));
  const edges: MemoryGraphEdge[] = [];
  for (const priority of [true, false]) {
    for (let e = 0; e < scene.edgeCount && edges.length < maxEdges; e++) {
      if ((scene.edgeKind[e] !== EDGE_OTHER) !== priority || !chosen[scene.edgeSource[e]!] || !chosen[scene.edgeTarget[e]!]) continue;
      edges.push({ id: `edge:${e}`, type: scene.edgeKind[e] === EDGE_DERIVED ? "DERIVED_FROM" : scene.edgeKind[e] === EDGE_CONTAINS ? "CONTAINS" : "SEMANTICALLY_RELATED", source: scene.ids[scene.edgeSource[e]!]!, target: scene.ids[scene.edgeTarget[e]!]! });
    }
  }
  return { indices: picked, local, nodes, edges };
}

export interface MemoryAdjacency { offsets: Uint32Array; neighbors: Uint32Array; edges: Uint32Array }

/** CSR adjacency (neighbour node and edge index per incidence), built once per scene so focus changes touch only a node's links. */
export function buildAdjacency(scene: MemoryScene): MemoryAdjacency {
  const offsets = new Uint32Array(scene.count + 1);
  for (let e = 0; e < scene.edgeCount; e++) { offsets[scene.edgeSource[e]! + 1]!++; offsets[scene.edgeTarget[e]! + 1]!++; }
  for (let i = 0; i < scene.count; i++) offsets[i + 1]! += offsets[i]!;
  const cursor = offsets.slice(0, scene.count), neighbors = new Uint32Array(offsets[scene.count]!), edges = new Uint32Array(offsets[scene.count]!);
  for (let e = 0; e < scene.edgeCount; e++) {
    const a = scene.edgeSource[e]!, b = scene.edgeTarget[e]!;
    neighbors[cursor[a]!] = b; edges[cursor[a]!++] = e;
    neighbors[cursor[b]!] = a; edges[cursor[b]!++] = e;
  }
  return { offsets, neighbors, edges };
}

/** Per-node highlight states for a focus: everything dim, the focus and its neighbours restored. -1 clears the focus. */
export function fillFocusStates(states: Uint8Array, adjacency: MemoryAdjacency, focus: number, dim = 1, focusState = 2, neighbor = 3): void {
  if (focus < 0) { states.fill(0); return; }
  states.fill(dim);
  for (let k = adjacency.offsets[focus]!; k < adjacency.offsets[focus + 1]!; k++) states[adjacency.neighbors[k]!] = neighbor;
  states[focus] = focusState;
}
