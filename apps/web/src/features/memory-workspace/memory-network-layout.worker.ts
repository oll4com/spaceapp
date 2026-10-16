import { streamMemoryNetwork3D } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; skip2D?: boolean }>) => {
  const { nodes, edges, skip2D } = event.data;
  const includeLegacyEntries = nodes.length <= 2500;
  let lastIds: string[] = [];
  let lastXyz: Float32Array<ArrayBufferLike> = new Float32Array(0);

  const final3D = streamMemoryNetwork3D(nodes, edges, frame => {
    lastIds = frame.ids;
    lastXyz = frame.xyz;
    if (!frame.done) {
      const snapshotBuffer = new Float32Array(frame.xyz);
      self.postMessage(
        {
          type: "frame",
          done: false,
          step: frame.step,
          totalSteps: frame.totalSteps,
          ids: frame.ids,
          xyz: snapshotBuffer
        },
        { transfer: [snapshotBuffer.buffer] }
      );
    }
  });

  const positions = skip2D && nodes.length > 2500 ? new Map<string, { x: number; y: number }>() : layoutMemoryNetwork(nodes, edges);
  const finalBuffer = new Float32Array(lastXyz);
  self.postMessage(
    {
      type: "frame",
      done: true,
      ids: lastIds,
      xyz: finalBuffer,
      positions: [...positions],
      depth: includeLegacyEntries ? [...final3D] : []
    },
    { transfer: [finalBuffer.buffer] }
  );
};
