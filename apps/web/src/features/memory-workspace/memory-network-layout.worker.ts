import { createMemory3DLayoutStepper } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

/** Depth positions stream to the main thread after every chunk of steps so
 * the 3D view is live and interactive while the simulation converges. */
const DEPTH_STREAM_EVERY_STEPS = 10;

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const { nodes, edges } = event.data;
  const depthStepper = createMemory3DLayoutStepper(nodes, edges);
  while (!depthStepper.done) {
    depthStepper.step(DEPTH_STREAM_EVERY_STEPS);
    if (!depthStepper.done) {
      self.postMessage({ type: "depth-progress", depth: [...depthStepper.positions()] });
    }
  }
  const positions = layoutMemoryNetwork(nodes, edges);
  self.postMessage({ positions: [...positions], depth: [...depthStepper.positions()] });
};
