import { MemoryLayout3DSimulation } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

/** Depth snapshots stream every few steps so the 3D view is usable while a
 * large layout converges; positions arrays are transferred, not copied. */
const DEPTH_STEPS_PER_CHUNK = 6;

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const positions = layoutMemoryNetwork(event.data.nodes, event.data.edges);
  const simulation = new MemoryLayout3DSimulation(event.data.nodes, event.data.edges);
  const ids = simulation.nodeIds;
  const initial = simulation.positionsArray();
  self.postMessage({ positions: [...positions], depthIds: ids, depth: initial, depthDone: false }, { transfer: [initial.buffer as ArrayBuffer] });
  while (!simulation.done) {
    simulation.step(DEPTH_STEPS_PER_CHUNK);
    const snapshot = simulation.positionsArray();
    self.postMessage({ positions: null, depthIds: ids, depth: snapshot, depthDone: simulation.done }, { transfer: [snapshot.buffer as ArrayBuffer] });
  }
};
