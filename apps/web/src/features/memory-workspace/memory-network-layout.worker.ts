import { createMemoryLayout3DStream } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const { nodes, edges } = event.data;
  const stream = createMemoryLayout3DStream(nodes, edges);
  self.postMessage({ type: "start", ids: stream.ids });
  // Stream positions while the simulation converges so the 3D view stays usable during layout.
  let sliceStart = performance.now();
  let done = false;
  while (!done) {
    done = stream.step(4);
    if (done || performance.now() - sliceStart > 12) {
      const coords = new Float32Array(stream.coordinates);
      self.postMessage({ type: "progress", coords }, { transfer: [coords.buffer] });
      sliceStart = performance.now();
    }
  }
  // The 2D map keeps its own bounded layout; large archives fall back to the stored positions.
  const positions = nodes.length <= 2000 ? layoutMemoryNetwork(nodes, edges) : new Map<string, { x: number; y: number }>();
  const coords = new Float32Array(stream.coordinates);
  self.postMessage({ type: "done", ids: stream.ids, coords, positions: [...positions] }, { transfer: [coords.buffer] });
};
