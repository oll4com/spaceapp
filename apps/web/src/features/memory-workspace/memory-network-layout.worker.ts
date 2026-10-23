import { streamLayoutMemoryNetwork3D, layoutMemoryNetwork3D } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const { nodes, edges } = event.data;
  const positions = layoutMemoryNetwork(nodes.length > 2000 ? nodes.slice(0, 2000) : nodes, edges);

  if (nodes.length <= 2000) {
    const depth = layoutMemoryNetwork3D(nodes, edges);
    self.postMessage({
      positions: [...positions],
      depth: [...depth],
      done: true
    });
    return;
  }

  // Stream progressive simulation snapshots for 50,000 nodes without locking main thread
  const streamer = streamLayoutMemoryNetwork3D(nodes, edges, 30);
  for (const snapshot of streamer) {
    self.postMessage({
      positions: [...positions],
      depth: [...snapshot.coordinates],
      step: snapshot.step,
      totalSteps: snapshot.totalSteps,
      done: snapshot.done
    });
  }
};
