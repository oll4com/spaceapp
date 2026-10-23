import { layoutMemoryNetwork3D, type MemoryPoint3D } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const nodes = event.data.nodes;
  const edges = event.data.edges;

  let current2D = new Map<string, { x: number; y: number }>();
  let current3D = new Map<string, MemoryPoint3D>();

  const final2D = layoutMemoryNetwork(nodes, edges, (pos, step, done) => {
    current2D = pos;
    if (step % 20 === 0 && !done) {
      self.postMessage({ positions: [...current2D], depth: [...current3D], done: false });
    }
  });
  current2D = final2D;

  const final3D = layoutMemoryNetwork3D(nodes, edges, (depth, step, done) => {
    current3D = depth;
    if (step % 20 === 0 && !done) {
      self.postMessage({ positions: [...current2D], depth: [...current3D], done: false });
    }
  });

  self.postMessage({ positions: [...final2D], depth: [...final3D], done: true });
};
