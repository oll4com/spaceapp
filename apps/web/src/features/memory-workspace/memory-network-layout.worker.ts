import { createMemoryNetwork3DLayout } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

/**
 * Layout protocol:
 * - `{ type: "layout", positions }` — the finished 2D network layout, sent
 *   as soon as it is ready so the atlas can render.
 * - `{ type: "depth", order, positions, done }` — 3D positions as flat xyz
 *   triplets in `order` sequence. The first message carries the seeded
 *   positions, further messages stream in while the force simulation runs,
 *   and the final one has `done: true`. The simulation is the same step
 *   sequence as the batch layout, so the final positions are identical.
 */
self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const positions = layoutMemoryNetwork(event.data.nodes, event.data.edges);
  self.postMessage({ type: "layout", positions: [...positions] });
  const layout = createMemoryNetwork3DLayout(event.data.nodes, event.data.edges);
  const sendDepth = (done: boolean) => {
    const flat = layout.flatPositions();
    self.postMessage({ type: "depth", order: layout.order, positions: flat, done }, { transfer: [flat.buffer] });
  };
  sendDepth(false);
  let lastSentAt = performance.now();
  while (!layout.step()) {
    if (performance.now() - lastSentAt >= 200) {
      sendDepth(false);
      lastSentAt = performance.now();
    }
  }
  sendDepth(true);
};
