import { memoryGraphOverviewPayloadSchema } from "@space/contracts";
import { createSyntheticMemoryGraph } from "../../demo/demo-memory-graph.js";
import { createMemoryAtlas } from "./memory-atlas.js";
import { createMemoryRenderModel } from "./memory-3d-model.js";
import { streamMemoryNetwork3D } from "./memory-3d.js";
import type { MemoryArchiveMessage, MemoryArchiveRequest } from "./memory-archive-protocol.js";

const tick = () => new Promise<void>(resolve => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
  channel.port2.postMessage(null);
});
const post = (message: MemoryArchiveMessage, transfer: ArrayBuffer[] = []) => self.postMessage(message, { transfer });

/** Fetch/JSON/schema, atlas preparation and force layout all stay off the UI thread. */
export async function loadMemoryArchive(request: MemoryArchiveRequest) {
  try {
    const count = Math.max(1, Math.min(50000, Math.floor(request.count)));
    let graph;
    if (request.demo) graph = createSyntheticMemoryGraph(count);
    else {
      const params = new URLSearchParams({ month: "all", relationMode: "RELATIONS", limit: String(count) });
      if (request.query) params.set("q", request.query);
      const response = await fetch(`/api/admin/memory/graph/overview?${params}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(`Memory graph request failed (${response.status}).`);
      const envelope = await response.json() as { data: unknown };
      graph = memoryGraphOverviewPayloadSchema.parse(envelope.data);
    }
    if (request.demo && request.query) {
      const needle = request.query.toLowerCase();
      graph.nodes = graph.nodes.filter(node => node.label.toLowerCase().includes(needle) || node.sourcePath?.toLowerCase().includes(needle));
      const ids = new Set(graph.nodes.map(node => node.id));
      graph.edges = graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
      graph.totalMatchingNodes = graph.nodes.length; graph.totalMatchingEdges = graph.edges.length;
    }
    const atlas = createMemoryAtlas(graph.nodes, graph.edges, false);
    const model = createMemoryRenderModel(atlas.nodes, atlas.edges, atlas.positions, new Map());
    // CSR adjacency travels as two transferable arrays, not 50k cloned Map entries.
    const neighborOffsets = new Uint32Array(model.nodes.length + 1);
    for (let i = 0; i < model.nodes.length; i++) neighborOffsets[i + 1] = neighborOffsets[i]! + (model.neighbors.get(i)?.length ?? 0);
    const neighborIndices = new Uint32Array(neighborOffsets.at(-1)!);
    for (let i = 0; i < model.nodes.length; i++) neighborIndices.set(model.neighbors.get(i) ?? [], neighborOffsets[i]!);
    const { nodes: _nodes, edges: _edges, ...data } = graph;
    const { nodes: _atlasNodes, edges: _atlasEdges, positions: _positions, ...atlasHeader } = atlas;
    post({ kind: "header", data, atlas: atlasHeader });
    // Small messages avoid a single main-thread structured-clone long task.
    for (let start = 0; start < atlas.nodes.length; start += 1000) { post({ kind: "nodes", nodes: atlas.nodes.slice(start, start + 1000) }); await tick(); }
    for (let start = 0; start < atlas.edges.length; start += 3000) { post({ kind: "edges", edges: atlas.edges.slice(start, start + 3000) }); await tick(); }
    const positions = [...atlas.positions];
    for (let start = 0; start < positions.length; start += 1000) { post({ kind: "positions", positions: positions.slice(start, start + 1000) }); await tick(); }
    post({ kind: "ready", model: { xyz: model.xyz, styles: model.styles, edgeIndices: model.edgeIndices, edgeKinds: model.edgeKinds,
      labelCandidates: model.labelCandidates, extent: model.extent, neighborOffsets, neighborIndices } },
    [model.xyz.buffer, model.styles.buffer, model.edgeIndices.buffer, model.edgeKinds.buffer, neighborOffsets.buffer, neighborIndices.buffer] as ArrayBuffer[]);
    for (const frame of streamMemoryNetwork3D(atlas.nodes, atlas.edges)) {
      const xyz = new Float32Array(atlas.nodes.length * 3);
      atlas.nodes.forEach((node, i) => { const point = frame.positions.get(node.id)!; xyz.set([point.x, point.y, point.z], i * 3); });
      post({ kind: "frame", xyz, step: frame.step, done: frame.step === 180 }, [xyz.buffer]);
      await tick();
    }
  } catch (error) { post({ kind: "error", message: error instanceof Error ? error.message : "Memory archive could not be loaded." }); }
}
