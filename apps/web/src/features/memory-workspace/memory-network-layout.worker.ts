import { layoutMemoryNetwork3DIncremental } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const positions = layoutMemoryNetwork(event.data.nodes, event.data.edges);
  const posEntries = [...positions];
  let first = true;

  layoutMemoryNetwork3DIncremental(
    event.data.nodes,
    event.data.edges,
    (depthMap, step, done) => {
      self.postMessage({
        positions: first ? posEntries : undefined,
        depth: [...depthMap],
        step,
        done
      });
      first = false;
    },
    20
  );
};
