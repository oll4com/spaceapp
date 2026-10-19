import { useEffect, useState } from "react";
import type { MemoryGraphOverviewResponse } from "../../api.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import type { MemoryRenderModel } from "./memory-3d-model.js";
import type { MemoryArchiveAtlas, MemoryArchiveMessage, MemoryArchiveRequest } from "./memory-archive-protocol.js";

interface ArchiveState {
  key: string;
  graph: MemoryGraphOverviewResponse;
  atlas: MemoryArchiveAtlas;
  model: MemoryRenderModel;
  frame?: Float32Array;
  complete: boolean;
}

export function useMemoryArchive(enabled: boolean, demo: boolean, count: number, query: string) {
  const [state, setState] = useState<ArchiveState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([demo, count, query]);
  useEffect(() => {
    if (!enabled || typeof Worker === "undefined") return;
    setError(null);
    const worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    let header: Extract<MemoryArchiveMessage, { kind: "header" }> | null = null;
    const nodes: MemoryGraphNode[] = [], edges: MemoryGraphEdge[] = [];
    const positions = new Map<string, MemoryAtlasPosition>(), index = new Map<string, number>();
    worker.onmessage = (event: MessageEvent<MemoryArchiveMessage>) => {
      const message = event.data;
      if (message.kind === "header") header = message;
      else if (message.kind === "nodes") { for (const node of message.nodes) { index.set(node.id, nodes.length); nodes.push(node); } }
      else if (message.kind === "edges") { for (const edge of message.edges) edges.push(edge); }
      else if (message.kind === "positions") { for (const [id, position] of message.positions) positions.set(id, position); }
      else if (message.kind === "ready" && header) {
        setState({ key, graph: { data: { ...header.data, nodes, edges } }, atlas: { ...header.atlas, nodes, edges, positions },
          model: { ...message.model, nodes, index, neighbors: new Map() }, complete: false });
      } else if (message.kind === "frame") {
        setState(previous => previous?.key === key ? { ...previous, frame: message.xyz, complete: message.done } : previous);
        if (message.done) worker.terminate();
      } else if (message.kind === "error") { setError(message.message); worker.terminate(); }
    };
    worker.onerror = event => { setError(event.message || "Memory archive worker unavailable."); worker.terminate(); };
    worker.postMessage({ kind: "archive", demo, count, query } satisfies MemoryArchiveRequest);
    return () => worker.terminate();
  }, [enabled, demo, count, query, key]);
  return { state: enabled && state?.key === key ? state : null, error: enabled ? error : null };
}
