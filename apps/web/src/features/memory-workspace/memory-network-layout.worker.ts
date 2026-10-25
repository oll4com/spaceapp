import { streamMemoryLayout3D, type MemoryLayoutProgress } from "./memory-3d-layout.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

/** The 2D map keeps its original 2,000-node cap, so only graphs up to that size get a 2D layout. */
const MEMORY_2D_LAYOUT_MAX_NODES = 2000;

export type MemoryLayoutWorkerMessage =
  | ({ type: "progress" } & MemoryLayoutProgress)
  | { type: "done"; positions: Array<[string, { x: number; y: number }]> };

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const { nodes, edges } = event.data;
  // 3D positions stream to the main thread while the simulation converges (buffers are transferred).
  streamMemoryLayout3D(nodes, edges, progress => {
    const message: MemoryLayoutWorkerMessage = { type: "progress", ...progress };
    (self as unknown as Worker).postMessage(message, [progress.positions.buffer]);
  });
  const positions = nodes.length <= MEMORY_2D_LAYOUT_MAX_NODES ? [...layoutMemoryNetwork(nodes, edges)] : [];
  (self as unknown as Worker).postMessage({ type: "done", positions } satisfies MemoryLayoutWorkerMessage);
};
