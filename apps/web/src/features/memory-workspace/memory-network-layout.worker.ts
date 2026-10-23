import { createMemoryNetwork3DLayout, createMemoryNetwork3DLayoutFromCompact, memoryNetwork3DLayoutCoordinates, stepMemoryNetwork3DLayout, type CompactMemory3DLayoutInput } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
type FullLayoutMessage = { kind?: "full"; nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; include2D?: boolean };
type CompactLayoutMessage = { kind: "compact"; input: CompactMemory3DLayoutInput };

self.onmessage = (event: MessageEvent<FullLayoutMessage | CompactLayoutMessage>) => {
  const compact = event.data.kind === "compact";
  const nodeCount = compact ? event.data.input.ids.length : event.data.nodes.length;
  if (!compact && event.data.include2D !== false) {
    const { nodes, edges } = event.data;
    const positions = layoutMemoryNetwork(nodes, edges);
    self.postMessage({ kind: "positions", positions: [...positions] });
  }

  // Large graphs converge in fewer, broader passes. Each pass yields to the worker
  // event loop and transfers a compact typed snapshot so the view becomes useful
  // immediately instead of waiting for the final simulation step.
  const totalSteps = nodeCount > 10_000 ? 24 : 180;
  const batchSize = nodeCount > 10_000 ? 1 : 12;
  const layout = compact
    ? createMemoryNetwork3DLayoutFromCompact(event.data.input, totalSteps)
    : createMemoryNetwork3DLayout(event.data.nodes, event.data.edges, totalSteps);
  let first = true;
  const publish = (complete: boolean) => {
    const coordinates = memoryNetwork3DLayoutCoordinates(layout);
    self.postMessage({
      kind: "depth",
      ids: first ? layout.ids : undefined,
      coordinates,
      progress: layout.totalSteps ? layout.step / layout.totalSteps : 1,
      complete
    }, { transfer: [coordinates.buffer] });
    first = false;
  };
  publish(layout.totalSteps === 0);
  const advance = () => {
    const complete = stepMemoryNetwork3DLayout(layout, batchSize);
    if (complete || nodeCount <= 10_000 || layout.step % 4 === 0) publish(complete);
    if (!complete) setTimeout(advance, 0);
  };
  if (layout.totalSteps > 0) setTimeout(advance, 0);
};
