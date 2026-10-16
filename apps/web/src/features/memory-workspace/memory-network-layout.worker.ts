/**
 * Web Worker for asynchronous force-directed 2D and 3D memory graph layout.
 * Computes 2D planar projection and streams incremental 3D coordinates back to the main thread.
 */
import { layoutMemoryNetwork3D } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const { nodes, edges } = event.data;
  const positions = layoutMemoryNetwork(nodes, edges);
  const positionEntries = [...positions];

  layoutMemoryNetwork3D(nodes, edges, (depthMap, done) => {
    self.postMessage({
      positions: positionEntries,
      depth: [...depthMap],
      done
    });
  });
};
