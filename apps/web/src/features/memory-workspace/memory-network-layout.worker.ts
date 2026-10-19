import { layoutMemoryNetwork3D } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import { loadMemoryArchive } from "./memory-archive-worker.js";
import type { MemoryArchiveRequest } from "./memory-archive-protocol.js";
self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } | MemoryArchiveRequest>) => {
  if ("kind" in event.data) { void loadMemoryArchive(event.data); return; }
  const positions = layoutMemoryNetwork(event.data.nodes, event.data.edges);
  self.postMessage({ positions: [...positions], depth: [...layoutMemoryNetwork3D(event.data.nodes, event.data.edges)] });
};
