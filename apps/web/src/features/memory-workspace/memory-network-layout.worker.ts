import { layoutMemoryNetwork3D, layoutMemoryNetwork3DStream } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

type LayoutRequest =
  | { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }
  | { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; stream: "3d" };

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { nodes, edges } = event.data;
  if ("stream" in event.data && event.data.stream === "3d") {
    // Incremental 3D layout: positions stream to the main thread while the
    // simulation converges, so the view stays usable during layout.
    // The returned Map equals layoutMemoryNetwork3D for the same input.
    const depth = layoutMemoryNetwork3DStream(nodes, edges, chunk => {
      self.postMessage(
        { type: "layout-3d-chunk", step: chunk.step, totalSteps: chunk.totalSteps, order: chunk.order, positions: chunk.positions },
        { transfer: [chunk.positions.buffer] }
      );
    });
    const positions = layoutMemoryNetwork(nodes, edges);
    self.postMessage({ type: "layout-done", depth: [...depth], positions: [...positions] });
    return;
  }
  const positions = layoutMemoryNetwork(nodes, edges);
  self.postMessage({ positions: [...positions], depth: [...layoutMemoryNetwork3D(nodes, edges)] });
};
