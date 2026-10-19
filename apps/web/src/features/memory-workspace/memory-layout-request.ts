import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryLayoutInput, MemoryLayoutRequest } from "./memory-layout-protocol.js";

const MAX_NODES = 50_000, MAX_EDGES = 150_000;
const NODE_BATCH = 500, EDGE_BATCH = 1500;
let nextRequestId = 0;
const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function validCount(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
}

function validateRequest(request: MemoryLayoutRequest) {
  if ((request.mode !== "2d" && request.mode !== "3d") || !Array.isArray(request.nodes) || !Array.isArray(request.edges) ||
      !validCount(request.nodes.length, MAX_NODES) || !validCount(request.edges.length, MAX_EDGES)) {
    throw new Error("Memory layout request exceeds the supported graph limits or has an invalid shape.");
  }
}

/** postMessage itself clones synchronously: yield between bounded copies, not after a full graph copy. */
export async function sendMemoryLayoutRequest(
  worker: { postMessage(message: MemoryLayoutInput): void },
  request: MemoryLayoutRequest,
  isCancelled: () => boolean,
  yieldControl: () => Promise<void> = yieldToBrowser
): Promise<void> {
  if (isCancelled()) return;
  validateRequest(request);
  if (request.mode !== "3d" || (request.nodes.length <= 2000 && request.edges.length <= 6000)) {
    if (!isCancelled()) worker.postMessage(request);
    return;
  }
  const requestId = ++nextRequestId;
  if (isCancelled()) return;
  worker.postMessage({ kind: "layout-begin", requestId, mode: "3d", nodeCount: request.nodes.length, edgeCount: request.edges.length });
  for (let offset = 0; offset < request.nodes.length; offset += NODE_BATCH) {
    await yieldControl();
    if (isCancelled()) return;
    worker.postMessage({ kind: "layout-nodes", requestId, offset, nodes: request.nodes.slice(offset, offset + NODE_BATCH) });
  }
  for (let offset = 0; offset < request.edges.length; offset += EDGE_BATCH) {
    await yieldControl();
    if (isCancelled()) return;
    worker.postMessage({ kind: "layout-edges", requestId, offset, edges: request.edges.slice(offset, offset + EDGE_BATCH) });
  }
  await yieldControl();
  if (!isCancelled()) worker.postMessage({ kind: "layout-end", requestId });
}

type PendingRequest = {
  requestId: number;
  nodeCount: number;
  edgeCount: number;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
};

/** Owns at most one capped graph. A malformed or abandoned generation never yields a partial request. */
export class MemoryLayoutRequestAssembler {
  private pending: PendingRequest | null = null;
  private lastRequestId = 0;

  accept(input: unknown): MemoryLayoutRequest | null {
    try {
      return this.receive(input);
    } catch (error) {
      this.pending = null;
      throw error;
    }
  }

  private receive(input: unknown): MemoryLayoutRequest | null {
    if (!input || typeof input !== "object" || !("kind" in input)) throw new Error("Invalid memory layout message.");
    const message = input as MemoryLayoutInput;
    if (message.kind === "layout") {
      validateRequest(message);
      this.pending = null;
      return message;
    }
    if (!("requestId" in message) || !Number.isSafeInteger(message.requestId) || message.requestId <= 0) {
      throw new Error("Invalid memory layout request ID.");
    }
    if (message.kind === "layout-begin") {
      if (message.requestId <= this.lastRequestId || message.mode !== "3d" ||
          !validCount(message.nodeCount, MAX_NODES) || !validCount(message.edgeCount, MAX_EDGES)) {
        throw new Error("Invalid memory layout batch declaration.");
      }
      this.lastRequestId = message.requestId;
      this.pending = { requestId: message.requestId, nodeCount: message.nodeCount, edgeCount: message.edgeCount, nodes: [], edges: [] };
      return null;
    }
    const pending = this.pending;
    if (!pending || message.requestId !== pending.requestId) throw new Error("Unexpected memory layout batch generation.");
    if (message.kind === "layout-nodes") {
      if (pending.edges.length || message.offset !== pending.nodes.length || !Array.isArray(message.nodes) ||
          !message.nodes.length || message.nodes.length > NODE_BATCH || pending.nodes.length + message.nodes.length > pending.nodeCount) {
        throw new Error("Invalid memory layout node batch order or size.");
      }
      pending.nodes.push(...message.nodes);
      return null;
    }
    if (message.kind === "layout-edges") {
      if (pending.nodes.length !== pending.nodeCount || message.offset !== pending.edges.length || !Array.isArray(message.edges) ||
          !message.edges.length || message.edges.length > EDGE_BATCH || pending.edges.length + message.edges.length > pending.edgeCount) {
        throw new Error("Invalid memory layout edge batch order or size.");
      }
      pending.edges.push(...message.edges);
      return null;
    }
    if (message.kind !== "layout-end" || pending.nodes.length !== pending.nodeCount || pending.edges.length !== pending.edgeCount) {
      throw new Error("Incomplete memory layout request or invalid final message.");
    }
    this.pending = null;
    return { kind: "layout", mode: "3d", nodes: pending.nodes, edges: pending.edges };
  }
}
