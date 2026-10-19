import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlas, ReferencedMemoryAtlas } from "./memory-layout-protocol.js";

/** Build a fresh map in short tasks so transferred geometry cannot monopolize input. */
export async function hydrateMemoryMap<T>(
  length: number,
  entry: (index: number) => [string, T],
  isCancelled: () => boolean,
  yieldControl: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0))
): Promise<Map<string, T> | null> {
  const result = new Map<string, T>();
  let start = performance.now();
  for (let index = 0; index < length; index++) {
    if (isCancelled()) return null;
    const [id, value] = entry(index);
    result.set(id, value);
    if (index % 1024 === 1023 && performance.now() - start >= 4) {
      await yieldControl();
      if (isCancelled()) return null;
      start = performance.now();
    }
  }
  return isCancelled() ? null : result;
}

async function hydrateMemoryArray<T>(
  length: number, entry: (index: number) => T, isCancelled: () => boolean,
  yieldControl: () => Promise<void>
): Promise<T[] | null> {
  const result: T[] = [];
  let start = performance.now();
  for (let index = 0; index < length; index++) {
    if (isCancelled()) return null;
    result.push(entry(index));
    if (index % 1024 === 1023 && performance.now() - start >= 4) {
      await yieldControl();
      if (isCancelled()) return null;
      start = performance.now();
    }
  }
  return isCancelled() ? null : result;
}

/** Reconstruct privately and publish once; superseded graphs never expose partial arrays. */
export async function hydrateReferencedMemoryAtlas(
  packed: ReferencedMemoryAtlas,
  graph: { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] },
  isCancelled: () => boolean,
  yieldControl: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0))
): Promise<MemoryAtlas | null> {
  const nodes = await hydrateMemoryArray(packed.nodeIndices.length, index => graph.nodes[packed.nodeIndices[index]!]!, isCancelled, yieldControl);
  if (!nodes) return null;
  const edges = await hydrateMemoryArray(packed.edgeIndices.length, index => graph.edges[packed.edgeIndices[index]!]!, isCancelled, yieldControl);
  if (!edges) return null;
  const positions = await hydrateMemoryMap(packed.positionNodeIndices.length, index => {
    const node = graph.nodes[packed.positionNodeIndices[index]!]!;
    const month = packed.positionMonthIndices[index]!;
    return [node.id, {
      x: packed.positionCoordinates[index * 2]!, y: packed.positionCoordinates[index * 2 + 1]!,
      color: packed.colors[packed.positionColorIndices[index]!]!, hub: Boolean(packed.positionHubs[index]),
      groupId: packed.groupIds[packed.positionGroupIndices[index]!]!,
      ...(month ? { monthLabel: packed.monthLabels[month - 1]! } : {})
    }];
  }, isCancelled, yieldControl);
  if (!positions) return null;
  return { nodes, edges, positions, groups: packed.groups, topics: packed.topics,
    explicitCount: packed.explicitCount, semanticCount: packed.semanticCount };
}
