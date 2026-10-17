/// <reference lib="webworker" />
import { createMemoryNetworkLayout3D } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

/**
 * Layout worker.
 *
 * The 3D force layout used to run all 180 steps before posting anything, so the 3D view stayed
 * empty until the whole simulation finished. It now streams: the node id order is posted once, then
 * positions arrive as flat Float32Arrays while the simulation converges, and the final message
 * carries the same `{ positions, depth }` payload as before so existing consumers keep working.
 *
 * Flat arrays rather than arrays of tuples: at 50,000 nodes a tuple-per-node message is tens of
 * megabytes of structured clones, which defeats the point of streaming.
 */
type Request = { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] };

const CHUNK_STEPS = 12;

// Typed as the dedicated-worker scope so the transfer-list overload is available; the DOM lib
// otherwise resolves `self` to Window, where postMessage's second argument is a targetOrigin string.
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<Request>) => {
  const { nodes, edges } = event.data;
  const stepper = createMemoryNetworkLayout3D(nodes, edges);
  const ids = [...stepper.snapshot().keys()];
  scope.postMessage({ type: "ids", ids });

  while (stepper.completedSteps < stepper.totalSteps) {
    stepper.runSteps(CHUNK_STEPS);
    const snapshot = stepper.snapshot();
    const xyz = new Float32Array(ids.length * 3);
    for (let i = 0; i < ids.length; i += 1) {
      const point = snapshot.get(ids[i]!);
      if (!point) continue;
      xyz[i * 3] = point.x;
      xyz[i * 3 + 1] = point.y;
      xyz[i * 3 + 2] = point.z;
    }
    scope.postMessage({ type: "progress", completed: stepper.completedSteps, total: stepper.totalSteps, xyz }, [xyz.buffer]);
  }

  scope.postMessage({ positions: [...layoutMemoryNetwork(nodes, edges)], depth: [...stepper.snapshot()] });
};
