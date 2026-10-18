import type { MemoryOverviewEnvelope, MemoryOverviewParseMessage } from "./memory-overview-parser.js";

/**
 * Transfer successful expanded-overview bytes to a parser worker and assemble its bounded graph chunks.
 * Other responses or unsupported workers use the existing reader; the worker is terminated on every exit.
 */
export async function readMemoryOverviewResponse(url: string, response: Response, fallback: () => Promise<unknown>): Promise<unknown> {
  const [path, query] = url.split("?");
  const expanded = path === "/api/admin/memory/graph/overview" && Number(new URLSearchParams(query).get("limit")) > 2000;
  if (!expanded || !response.ok || typeof Worker === "undefined" || typeof response.arrayBuffer !== "function") return fallback();
  let worker: Worker;
  try { worker = new Worker(new URL("./memory-overview-parser.worker.ts", import.meta.url), { type: "module" }); }
  catch { return fallback(); } // Worker-disabled browsers retain the ordinary, synchronous parsing fallback.
  try {
    const buffer = await response.arrayBuffer();
    return await new Promise<unknown>((resolve, reject) => {
      let envelope: MemoryOverviewEnvelope | null = null;
      worker.onmessage = (event: MessageEvent<MemoryOverviewParseMessage>) => {
        const message = event.data;
        if (message.kind === "begin") envelope = message.envelope;
        else if (message.kind === "nodes" && envelope) envelope.data.nodes.push(...message.nodes);
        else if (message.kind === "edges" && envelope) envelope.data.edges.push(...message.edges);
        else if (message.kind === "finish") resolve(envelope);
        else if (message.kind === "value") resolve(message.value);
        else if (message.kind === "error") reject(new Error(message.message));
      };
      worker.onerror = event => reject(new Error(event.message || "Memory response worker failed."));
      worker.postMessage({ buffer, contentType: response.headers.get("content-type")?.toLowerCase() ?? "" }, [buffer]);
    });
  } finally { worker.terminate(); }
}
