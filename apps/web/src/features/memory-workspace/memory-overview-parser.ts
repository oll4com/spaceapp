import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

export type MemoryOverviewParseRequest = { buffer: ArrayBuffer; contentType: string };
export type MemoryOverviewEnvelope = Record<string, unknown> & {
  data: Record<string, unknown> & { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] };
};
export type MemoryOverviewParseMessage =
  | { kind: "begin"; envelope: MemoryOverviewEnvelope }
  | { kind: "nodes"; nodes: MemoryGraphNode[] }
  | { kind: "edges"; edges: MemoryGraphEdge[] }
  | { kind: "finish" }
  | { kind: "value"; value: unknown }
  | { kind: "error"; message: string };

/**
 * Decode response bytes inside a worker, then stream graph nodes/edges in bounded messages.
 * Empty bodies remain null and malformed/non-graph bodies retain the ordinary reader's value semantics.
 */
export async function streamMemoryOverviewResponse(request: MemoryOverviewParseRequest, post: (message: MemoryOverviewParseMessage) => void): Promise<void> {
  const raw = new TextDecoder().decode(request.buffer);
  if (!raw) { post({ kind: "value", value: null }); return; }
  const trimmed = raw.trim();
  let payload: unknown = raw;
  if (request.contentType.includes("application/json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { payload = JSON.parse(raw) as unknown; } catch { /* Keep malformed bodies readable, as the normal reader does. */ }
  }
  if (typeof payload !== "object" || payload === null || !("data" in payload) ||
    typeof payload.data !== "object" || payload.data === null || !("nodes" in payload.data) || !("edges" in payload.data) ||
    !Array.isArray(payload.data.nodes) || !Array.isArray(payload.data.edges)) {
    post({ kind: "value", value: payload });
    return;
  }
  const { nodes, edges, ...metadata } = payload.data;
  post({ kind: "begin", envelope: { ...payload, data: { ...metadata, nodes: [], edges: [] } } });
  for (let offset = 0; offset < nodes.length; offset += 500) {
    post({ kind: "nodes", nodes: nodes.slice(offset, offset + 500) as MemoryGraphNode[] });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  for (let offset = 0; offset < edges.length; offset += 2000) {
    post({ kind: "edges", edges: edges.slice(offset, offset + 2000) as MemoryGraphEdge[] });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  post({ kind: "finish" });
}
