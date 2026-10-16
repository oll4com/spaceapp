import { layoutMemoryNetwork3DStream } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const { nodes, edges } = event.data;
  // Issue #62: stream 3D layout progress so large graphs report incremental
  // steps instead of blocking the worker for the whole simulation. Every third
  // tick also carries a positions snapshot so the main thread can refine the
  // view while the simulation converges. The final message keeps the original
  // shape (positions + depth) for the consumer.
  const iterator = layoutMemoryNetwork3DStream(nodes, edges);
  let result = iterator.next();
  let tick = 0;
  while (!result.done) {
    tick += 1;
    const value = result.value;
    self.postMessage(tick % 3 === 0
      ? { type: "layout-progress", step: value.step, totalSteps: value.totalSteps, coordinates: [...value.positions] }
      : { type: "layout-progress", step: value.step, totalSteps: value.totalSteps });
    result = iterator.next();
  }
  const depth = result.value;
  const positions = layoutMemoryNetwork(nodes, edges);
  self.postMessage({ positions: [...positions], depth: [...depth] });
};
