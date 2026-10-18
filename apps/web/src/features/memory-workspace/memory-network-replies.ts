import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { createMemoryAtlas, MemoryAtlasPosition } from "./memory-atlas.js";
import type { MemoryPoint3D } from "./memory-3d.js";
import type { MemoryNetworkLayoutMessage, PackedMemoryAtlas } from "./memory-network-layout-protocol.js";

type Atlas = ReturnType<typeof createMemoryAtlas>;
export type MemoryNetworkViewState = {
  atlas: Atlas; positions: Map<string, MemoryAtlasPosition>; depth: Map<string, MemoryPoint3D>;
  done: boolean; progress: number;
};

/** Allocate transferable XYZ triples in raw node order, rejecting incomplete coordinate maps. */
export function packMemoryDepth(nodes: MemoryGraphNode[], points: Map<string, MemoryPoint3D>): Float32Array {
  const packed = new Float32Array(nodes.length * 3);
  nodes.forEach((node, index) => {
    const point = points.get(node.id);
    if (!point) throw new Error(`Missing memory coordinate: ${node.id}`);
    packed.set([point.x, point.y, point.z], index * 3);
  });
  return packed;
}

/**
 * Allocate atlas columns in raw node order and encode repeated labels once.
 * Month index zero means absent; present months use their dictionary index plus one.
 */
export function packMemoryAtlas(nodes: MemoryGraphNode[], positions: Map<string, MemoryAtlasPosition>): PackedMemoryAtlas {
  const packed: PackedMemoryAtlas = { xy: new Float32Array(nodes.length * 2), groupIndices: new Uint16Array(nodes.length),
    colorIndices: new Uint16Array(nodes.length), hubs: new Uint8Array(nodes.length), monthIndices: new Uint16Array(nodes.length),
    groupIds: [], colors: [], months: [] };
  const groups = new Map<string, number>(), colors = new Map<string, number>(), months = new Map<string, number>();
  /** Reuse the first assigned dictionary index so every packed column shares stable string references. */
  const dictionaryIndex = (value: string, dictionary: Map<string, number>, values: string[]) => {
    let index = dictionary.get(value);
    if (index === undefined) { index = values.length; dictionary.set(value, index); values.push(value); }
    return index;
  };
  nodes.forEach((node, index) => {
    const point = positions.get(node.id);
    if (!point) throw new Error(`Missing memory atlas metadata: ${node.id}`);
    packed.xy.set([point.x, point.y], index * 2);
    packed.groupIndices[index] = dictionaryIndex(point.groupId, groups, packed.groupIds);
    packed.colorIndices[index] = dictionaryIndex(point.color, colors, packed.colors);
    packed.hubs[index] = Number(point.hub);
    if (point.monthLabel) packed.monthIndices[index] = dictionaryIndex(point.monthLabel, months, packed.months) + 1;
  });
  return packed;
}

/** Every buffer is freshly allocated by the worker, so transfer never detaches simulation state. */
export function memoryReplyTransferables(message: MemoryNetworkLayoutMessage): ArrayBuffer[] {
  const arrays = [message.packedDepth, message.packedPositions, ...(message.packedAtlas
    ? [message.packedAtlas.xy, message.packedAtlas.groupIndices, message.packedAtlas.colorIndices, message.packedAtlas.hubs, message.packedAtlas.monthIndices] : [])];
  return arrays.flatMap(array => array ? [array.buffer as ArrayBuffer] : []);
}

/** Validate and decode packed or legacy frames into fresh maps, yielding after bounded record batches. */
function* applyReplySteps(
  nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], message: MemoryNetworkLayoutMessage, previous: MemoryNetworkViewState | null
): Generator<void, MemoryNetworkViewState | null> {
  let atlas = message.atlas ? message.rawGraph ? { ...message.atlas, nodes, edges } : message.atlas : previous?.atlas;
  if (!atlas) return null;
  let positions = message.atlas ? atlas.positions : previous?.positions ?? atlas.positions;
  const metadata = message.packedAtlas;
  if (metadata) {
    if (metadata.xy.length !== nodes.length * 2 || [metadata.groupIndices, metadata.colorIndices, metadata.hubs, metadata.monthIndices].some(array => array.length !== nodes.length)) {
      throw new Error("Memory atlas buffer length does not match its topology.");
    }
    positions = new Map();
    for (let index = 0; index < nodes.length; index++) {
      const month = metadata.monthIndices[index]!;
      positions.set(nodes[index]!.id, { x: metadata.xy[index * 2]!, y: metadata.xy[index * 2 + 1]!,
        groupId: metadata.groupIds[metadata.groupIndices[index]!]!, color: metadata.colors[metadata.colorIndices[index]!]!,
        hub: Boolean(metadata.hubs[index]), ...(month ? { monthLabel: metadata.months[month - 1]! } : {}) });
      if (index % 256 === 255) yield;
    }
    atlas = { ...atlas, positions };
  }
  if (message.packedPositions) {
    if (message.packedPositions.length !== nodes.length * 2) throw new Error("Memory position buffer length does not match its topology.");
    const updated = new Map<string, MemoryAtlasPosition>();
    for (let index = 0; index < nodes.length; index++) {
      const id = nodes[index]!.id, point = positions.get(id);
      if (point) updated.set(id, { ...point, x: message.packedPositions[index * 2]!, y: message.packedPositions[index * 2 + 1]! });
      if (index % 256 === 255) yield;
    }
    positions = updated;
  } else if (message.positions) {
    const coordinates = new Map(message.positions), updated = new Map<string, MemoryAtlasPosition>();
    let index = 0;
    for (const [id, position] of positions) {
      updated.set(id, { ...position, ...coordinates.get(id) });
      if (++index % 256 === 0) yield;
    }
    positions = updated;
  }
  let depth = previous?.depth ?? new Map<string, MemoryPoint3D>();
  if (message.packedDepth) {
    if (message.packedDepth.length !== nodes.length * 3) throw new Error("Memory depth buffer length does not match its topology.");
    depth = new Map();
    for (let index = 0; index < nodes.length; index++) {
      depth.set(nodes[index]!.id, { x: message.packedDepth[index * 3]!, y: message.packedDepth[index * 3 + 1]!, z: message.packedDepth[index * 3 + 2]! });
      if (index % 256 === 255) yield;
    }
  } else if (message.depth) {
    depth = new Map();
    let index = 0;
    for (const [id, point] of message.depth) { depth.set(id, point); if (++index % 256 === 0) yield; }
  }
  return { atlas, positions, depth, done: message.done, progress: message.progress };
}

/**
 * Build immutable view maps in short slices, returning null before an initial atlas or on cancellation.
 * The previous displayed state remains usable until a complete reply has been decoded.
 */
export async function applyMemoryNetworkReply(
  nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], message: MemoryNetworkLayoutMessage,
  previous: MemoryNetworkViewState | null, cancelled: () => boolean = () => false
): Promise<MemoryNetworkViewState | null> {
  const steps = applyReplySteps(nodes, edges, message, previous);
  let deadline = performance.now() + 6;
  for (;;) {
    if (cancelled()) return null;
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() >= deadline) { await new Promise<void>(resolve => setTimeout(resolve, 0)); deadline = performance.now() + 6; }
  }
}
