import { createMemoryAtlas } from "./memory-atlas.js";
import { createMemoryLayout3D } from "./memory-3d-layout.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryAtlas, MemoryLayoutMessage, MemoryLayoutRequest, ReferencedMemoryAtlas } from "./memory-layout-protocol.js";

/** Atlas filters retain graph object identity; indices preserve their exact output order. */
export function referenceMemoryAtlas(atlas: MemoryAtlas, request: Pick<MemoryLayoutRequest, "nodes" | "edges">) {
  const nodeLookup = new Map(request.nodes.map((node, index) => [node, index]));
  const edgeLookup = new Map(request.edges.map((edge, index) => [edge, index]));
  const reference = <T>(lookup: Map<T, number>, value: T) => {
    const index = lookup.get(value);
    if (index === undefined) throw new Error("Atlas references a graph object that is unavailable.");
    return index;
  };
  const nodeIndices = Uint32Array.from(atlas.nodes, node => reference(nodeLookup, node));
  const edgeIndices = Uint32Array.from(atlas.edges, edge => reference(edgeLookup, edge));
  const nodeIds = new Map(request.nodes.map((node, index) => [node.id, index]));
  const count = atlas.positions.size;
  const positionNodeIndices = new Uint32Array(count), positionCoordinates = new Float64Array(count * 2);
  const positionColorIndices = new Uint32Array(count), positionGroupIndices = new Uint32Array(count);
  const positionMonthIndices = new Uint32Array(count), positionHubs = new Uint8Array(count);
  // Colors/groups are bounded by atlas taxonomy; formatted months come from the
  // finite source-month range. Per-node strings/objects are never cloned back.
  const colors: string[] = [], groupIds: string[] = [], monthLabels: string[] = [];
  const colorLookup = new Map<string, number>(), groupLookup = new Map<string, number>(), monthLookup = new Map<string, number>();
  const intern = (value: string, values: string[], lookup: Map<string, number>) => {
    const existing = lookup.get(value);
    if (existing !== undefined) return existing;
    const index = values.length; values.push(value); lookup.set(value, index); return index;
  };
  let index = 0;
  for (const [id, position] of atlas.positions) {
    positionNodeIndices[index] = reference(nodeIds, id);
    positionCoordinates[index * 2] = position.x; positionCoordinates[index * 2 + 1] = position.y;
    positionColorIndices[index] = intern(position.color, colors, colorLookup);
    positionGroupIndices[index] = intern(position.groupId, groupIds, groupLookup);
    // Zero preserves absence; present month labels use one-based dictionary indices.
    positionMonthIndices[index] = position.monthLabel === undefined ? 0 : intern(position.monthLabel, monthLabels, monthLookup) + 1;
    positionHubs[index] = Number(position.hub);
    index++;
  }
  const packed: ReferencedMemoryAtlas = {
    nodeIndices, edgeIndices, positionNodeIndices, positionCoordinates, positionColorIndices,
    positionGroupIndices, positionMonthIndices, positionHubs, colors, groupIds, monthLabels,
    groups: atlas.groups, topics: atlas.topics, explicitCount: atlas.explicitCount, semanticCount: atlas.semanticCount
  };
  return { atlas: packed, transfer: [nodeIndices.buffer, edgeIndices.buffer, positionNodeIndices.buffer,
    positionCoordinates.buffer, positionColorIndices.buffer, positionGroupIndices.buffer, positionMonthIndices.buffer, positionHubs.buffer] };
}

/** Run in the existing worker. Yielding changes delivery times, never simulation order. */
export async function streamMemoryLayout(
  request: MemoryLayoutRequest,
  emit: (message: MemoryLayoutMessage, transfer?: Transferable[]) => void,
  options: { yieldControl?: () => Promise<void>; isCancelled?: () => boolean } = {}
): Promise<void> {
  const cancelled = options.isCancelled ?? (() => false);
  const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  if (cancelled()) return;
  // The unchanged 2D view is always bounded, including a caller switching from a full 3D graph.
  const nodes = request.mode === "2d" ? request.nodes.slice(0, 2000) : request.nodes;
  const ids = new Set(nodes.map(node => node.id));
  const edges = request.mode === "2d"
    ? request.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).slice(0, 6000)
    : request.edges;
  const atlas = createMemoryAtlas(nodes, edges, false);
  if (request.mode === "3d" && (nodes.length > 2000 || edges.length > 6000)) {
    const referenced = referenceMemoryAtlas(atlas, request);
    emit({ kind: "atlas-references", atlas: referenced.atlas }, referenced.transfer);
  } else {
    emit({ kind: "atlas", atlas: { ...atlas, positions: [...atlas.positions] } });
  }
  await yieldControl();
  if (cancelled()) return;
  if (request.mode === "2d") {
    emit({ kind: "positions", positions: [...layoutMemoryNetwork(atlas.nodes, atlas.edges)], complete: true });
    return;
  }
  // Large 3D graphs never pay for the unrelated 2D force simulation first.
  const simulation = createMemoryLayout3D(atlas.nodes, atlas.edges);
  const initial = simulation.snapshot();
  emit({ kind: "depth", ids: [...simulation.ids], coordinates: initial, complete: simulation.complete, step: 0 }, [initial.buffer]);
  await yieldControl();
  while (!simulation.complete && !cancelled()) {
    const started = performance.now();
    do { simulation.advance(); } while (!simulation.complete && performance.now() - started < 12);
    if (cancelled()) return;
    const coordinates = simulation.snapshot();
    emit({ kind: "depth", coordinates, complete: simulation.complete, step: simulation.step }, [coordinates.buffer]);
    if (!simulation.complete) await yieldControl();
  }
}
