import type { MemoryGraphOverviewPayload } from "@space/contracts";
type MemoryGraphOverviewResponse = { data: MemoryGraphOverviewPayload };
import { createMemoryLayout3D, layoutMemoryNetwork3D } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import { createMemoryAtlas } from "./memory-atlas.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

let accumulatedNodes: MemoryGraphNode[] = [],
  accumulatedEdges: MemoryGraphEdge[] = [];
/** The caller owns one worker per graph generation and terminates superseded work. */
self.onmessage = (
  event: MessageEvent<{
    nodes: MemoryGraphNode[];
    edges: MemoryGraphEdge[];
    mode?: "3d" | "parse-overview";
    bytes?: ArrayBuffer;
    final?: boolean;
  }>,
) => {
  if (event.data.mode === "parse-overview") {
    void parseOverview(event.data.bytes!);
    return;
  }
  const { nodes, edges, mode } = event.data;
  if (mode !== "3d") {
    const positions = layoutMemoryNetwork(nodes, edges);
    self.postMessage({
      positions: [...positions],
      depth: [...layoutMemoryNetwork3D(nodes, edges)],
    });
    return;
  }
  accumulatedNodes.push(...nodes);
  accumulatedEdges.push(...edges);
  if (!event.data.final) return;
  const {
    nodes: visibleNodes,
    edges: visibleEdges,
    ...atlas
  } = createMemoryAtlas(accumulatedNodes, accumulatedEdges, false);
  accumulatedNodes = [];
  accumulatedEdges = [];
  const layout = createMemoryLayout3D(visibleNodes, visibleEdges);
  const send = (initial: boolean) => {
    const snapshot = layout.snapshot(),
      xyz = new Float32Array(visibleNodes.length * 3);
    visibleNodes.forEach((node, i) => {
      const p = snapshot.get(node.id)!;
      xyz.set([p.x, p.y, p.z], i * 3);
    });
    self.postMessage(
      {
        ...(initial
          ? { atlas, nodeIds: visibleNodes.map((node) => node.id) }
          : {}),
        xyz,
        done: layout.done,
      },
      { transfer: [xyz.buffer] },
    );
  };
  send(true);
  const advance = () => {
    layout.advance(30);
    send(false);
    if (!layout.done) setTimeout(advance, 0);
  };
  setTimeout(advance, 0);
};

/** Decode off-thread; never clone all 50k nodes and 150k edges into one UI task. */
async function parseOverview(bytes: ArrayBuffer) {
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as MemoryGraphOverviewResponse;
    const { nodes, edges } = payload.data;
    if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error("Invalid memory overview");
    for (let offset = 0; offset < Math.max(nodes.length, Math.ceil(edges.length / 3)); offset += 5000) {
      self.postMessage({ nodes: nodes.slice(offset, offset + 5000), edges: edges.slice(offset * 3, (offset + 5000) * 3) });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    self.postMessage({ payload: { ...payload, data: { ...payload.data, nodes: [], edges: [] } } });
  } catch {
    self.postMessage({ error: "Memory overview response could not be decoded." });
  }
}
