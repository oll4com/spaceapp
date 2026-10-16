import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { createMemoryAtlas, type MemoryAtlasGroup } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { createMemoryNetwork3DLayout, type MemoryNetwork3DSimulation } from "./memory-3d.js";

export interface PackedMemoryGraph {
  count: number;
  edgeCount: number;
  ids: Uint8Array;
  idOffsets: Uint32Array;
  labels: Uint8Array;
  labelOffsets: Uint32Array;
  colors: Uint8Array;
  radii: Float32Array;
  kinds: Uint8Array;
  edgePairs: Uint32Array;
  edgeTypes: Uint8Array;
  xyz: Float32Array;
  memoryCount: number;
  sourceCount: number;
  semanticCount: number;
  groups: MemoryAtlasGroup[];
  truncated: boolean;
  totalMatchingNodes: number;
  totalMatchingEdges: number;
  isStale: boolean;
  recordCount: number;
  issueCount: number;
}

export interface PreparedMemoryGraph {
  packed: PackedMemoryGraph;
  simulation: MemoryNetwork3DSimulation;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function packStrings(values: readonly string[]): { bytes: Uint8Array; offsets: Uint32Array } {
  const parts: Uint8Array[] = new Array(values.length);
  const offsets = new Uint32Array(values.length + 1);
  let total = 0;
  for (let index = 0; index < values.length; index++) {
    const part = encoder.encode(values[index] ?? "");
    parts[index] = part;
    offsets[index] = total;
    total += part.length;
  }
  offsets[values.length] = total;
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    bytes.set(part!, cursor);
    cursor += part!.length;
  }
  return { bytes, offsets };
}

export function packedText(bytes: Uint8Array, offsets: Uint32Array, index: number): string {
  if (index < 0 || index + 1 >= offsets.length) return "";
  return decoder.decode(bytes.subarray(offsets[index] ?? 0, offsets[index + 1] ?? 0));
}

export function findPackedText(bytes: Uint8Array, offsets: Uint32Array, value: string): number {
  const encoded = encoder.encode(value);
  const count = offsets.length - 1;
  for (let index = 0; index < count; index++) {
    const start = offsets[index] ?? 0;
    const end = offsets[index + 1] ?? start;
    if (end - start !== encoded.length) continue;
    let matches = true;
    for (let cursor = 0; cursor < encoded.length; cursor++) {
      if (bytes[start + cursor] !== encoded[cursor]) { matches = false; break; }
    }
    if (matches) return index;
  }
  return -1;
}

function writeColor(colors: Uint8Array, index: number, hex: string) {
  const cursor = index * 3;
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  if (value.length < 6) {
    colors[cursor] = 0x73;
    colors[cursor + 1] = 0x95;
    colors[cursor + 2] = 0xad;
    return;
  }
  colors[cursor] = Number.parseInt(value.slice(0, 2), 16);
  colors[cursor + 1] = Number.parseInt(value.slice(2, 4), 16);
  colors[cursor + 2] = Number.parseInt(value.slice(4, 6), 16);
}

export function prepareMemoryGraph(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  meta: Partial<Pick<PackedMemoryGraph, "truncated" | "totalMatchingNodes" | "totalMatchingEdges" | "isStale" | "recordCount" | "issueCount">> = {}
): PreparedMemoryGraph {
  const atlas = createMemoryAtlas(nodes, edges, false);
  const simulation = createMemoryNetwork3DLayout(atlas.nodes, atlas.edges);
  const byId = new Map(atlas.nodes.map(node => [node.id, node]));
  const index = new Map(simulation.ids.map((id, position) => [id, position]));
  const count = simulation.ids.length;
  const colors = new Uint8Array(count * 3);
  const radii = new Float32Array(count);
  const kinds = new Uint8Array(count);
  const labels: string[] = new Array(count);
  let memoryCount = 0;
  let sourceCount = 0;
  for (let position = 0; position < count; position++) {
    const id = simulation.ids[position]!;
    const node = byId.get(id);
    const core = Boolean(node && node.type === "SOURCE" && isMemoryCoreLabel(node.label));
    const source = node?.type === "SOURCE";
    if (node?.type === "MEMORY") memoryCount += 1;
    if (source) sourceCount += 1;
    kinds[position] = core ? 2 : source ? 1 : 0;
    radii[position] = core ? 10 : source ? 4.6 : 2.1;
    labels[position] = node?.label ?? id;
    writeColor(colors, position, atlas.positions.get(id)?.color ?? "#7395ad");
  }
  const pairs: number[] = [];
  const types: number[] = [];
  for (const edge of atlas.edges) {
    const source = index.get(edge.source);
    const target = index.get(edge.target);
    if (source === undefined || target === undefined || source === target) continue;
    pairs.push(source, target);
    types.push(edge.type === "DERIVED_FROM" ? 1 : 0);
  }
  const xyz = new Float32Array(count * 3);
  simulation.writePositions(xyz);
  const packedIds = packStrings(simulation.ids);
  const packedLabels = packStrings(labels);
  return {
    simulation,
    packed: {
      count,
      edgeCount: types.length,
      ids: packedIds.bytes,
      idOffsets: packedIds.offsets,
      labels: packedLabels.bytes,
      labelOffsets: packedLabels.offsets,
      colors,
      radii,
      kinds,
      edgePairs: Uint32Array.from(pairs),
      edgeTypes: Uint8Array.from(types),
      xyz,
      memoryCount,
      sourceCount,
      semanticCount: atlas.semanticCount,
      groups: atlas.groups,
      truncated: meta.truncated ?? false,
      totalMatchingNodes: meta.totalMatchingNodes ?? count,
      totalMatchingEdges: meta.totalMatchingEdges ?? types.length,
      isStale: meta.isStale ?? false,
      recordCount: meta.recordCount ?? memoryCount,
      issueCount: meta.issueCount ?? 0
    }
  };
}

export function copyPackedPositions(simulation: MemoryNetwork3DSimulation, count: number): Float32Array {
  const xyz = new Float32Array(count * 3);
  simulation.writePositions(xyz);
  return xyz;
}

export function packedTransferables(packed: PackedMemoryGraph): ArrayBuffer[] {
  return [
    packed.ids.buffer,
    packed.idOffsets.buffer,
    packed.labels.buffer,
    packed.labelOffsets.buffer,
    packed.colors.buffer,
    packed.radii.buffer,
    packed.kinds.buffer,
    packed.edgePairs.buffer,
    packed.edgeTypes.buffer,
    packed.xyz.buffer
  ] as ArrayBuffer[];
}
