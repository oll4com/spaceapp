import { layoutMemoryNetwork3D } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

/**
 * The legacy 2D relaxation is grid-bounded and fast for overviews, but archives of
 * tens of thousands of nodes pack its fixed 240x200 simulation box until a step
 * costs seconds. Above this cap the worker streams the archive's own clustered
 * coordinates immediately (deterministic, they are what the 2D view colours by)
 * instead of simulating, so huge graphs never wait on the 2D pass.
 */
const LAYOUT_2D_SIMULATION_CAP = 4000;

const clusteredPositions = (nodes: MemoryGraphNode[]) => {
  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, index) => {
    const clustered = node.position?.clustered;
    positions.set(node.id, clustered ? { x: clustered.x, y: clustered.y } : { x: index % 40, y: Math.floor(index / 40) });
  });
  return positions;
};

/**
 * Layout runs here incrementally: the 2D positions arrive as soon as they are ready,
 * then 3D depth streams to the main thread every few simulation steps so the view
 * stays interactive while the force layout converges. The final message carries the
 * converged 3D result; intermediate frames are only ever partial previews.
 */
self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const { nodes, edges } = event.data;
  const positions = nodes.length > LAYOUT_2D_SIMULATION_CAP ? clusteredPositions(nodes) : layoutMemoryNetwork(nodes, edges);
  self.postMessage({ type: "positions", positions: [...positions] });
  const depth = layoutMemoryNetwork3D(nodes, edges, {
    progressInterval: 15,
    onProgress: (fraction, buffer, count) => {
      if (fraction < 1) self.postMessage({ type: "depth-progress", fraction, depth: buffer.slice(0, count * 3) });
    }
  });
  self.postMessage({ type: "depth", depth: [...depth] });
};
