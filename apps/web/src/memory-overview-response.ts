import type { MemoryGraphOverviewPayload } from "@space/contracts";
type MemoryGraphOverviewResponse = { data: MemoryGraphOverviewPayload };
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

/** Transfer large JSON to the existing layout worker and receive bounded graph batches. */
export async function readMemoryOverviewResponse(response: Response, signal?: AbortSignal): Promise<unknown> {
  const bytes = await response.arrayBuffer();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./features/memory-workspace/memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    const nodes: MemoryGraphNode[] = [], edges: MemoryGraphEdge[] = [];
    const cleanup = () => {
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () => {
      cleanup();
      reject(new Error("Memory overview response could not be decoded."));
    };
    worker.onmessage = (event: MessageEvent<{
      nodes?: MemoryGraphNode[];
      edges?: MemoryGraphEdge[];
      payload?: MemoryGraphOverviewResponse;
      error?: string;
    }>) => {
      const message = event.data;
      if (message.error) {
        cleanup();
        reject(new Error(message.error));
      } else if (message.payload) {
        cleanup();
        resolve({ ...message.payload, data: { ...message.payload.data, nodes, edges } });
      } else {
        nodes.push(...(message.nodes ?? []));
        edges.push(...(message.edges ?? []));
      }
    };
    worker.postMessage({ mode: "parse-overview", bytes }, [bytes]);
  });
}
