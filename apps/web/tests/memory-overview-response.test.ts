import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamMemoryOverviewResponse, type MemoryOverviewParseMessage, type MemoryOverviewParseRequest } from "../src/features/memory-workspace/memory-overview-parser.js";
import { readMemoryOverviewResponse } from "../src/features/memory-workspace/memory-overview-response.js";
import { api } from "../src/live-api.js";

const core = vi.hoisted(() => ({ reportCoreApiFailure: vi.fn(), reportCoreApiSuccess: vi.fn() }));
vi.mock("../src/core-api-state.js", () => core);

function graphPayload(count = 1101) {
  return { requestId: "request:overview", data: { version: 1, sourceHash: "a".repeat(64), generatedAt: "2026-10-19T00:00:00.000Z",
    nodes: Array.from({ length: count }, (_, index) => ({ id: `memory:${index}`, type: "MEMORY", label: index === 0 ? "[REDACTED]" : `Memory ${index}`, sourcePath: null, recordId: null })),
    edges: Array.from({ length: 4101 }, (_, index) => ({ id: `edge:${index}`, type: "CONTAINS", source: "memory:0", target: `memory:${index % count}` })),
    filters: { q: null }, summary: { nodeCount: count }, totalMatchingNodes: count, totalMatchingEdges: 4101, truncated: false } };
}

const workers: ParserWorker[] = [];
class ParserWorker {
  onmessage: ((event: { data: MemoryOverviewParseMessage }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  messages: MemoryOverviewParseMessage[] = [];
  terminate = vi.fn();
  constructor(readonly url: URL, readonly options: WorkerOptions) { workers.push(this); }
  postMessage(request: MemoryOverviewParseRequest, transfer: ArrayBuffer[]) {
    expect(transfer).toEqual([request.buffer]);
    const received = structuredClone(request, { transfer });
    expect(request.buffer.byteLength).toBe(0);
    void streamMemoryOverviewResponse(received, message => { this.messages.push(message); this.onmessage?.({ data: message }); })
      .catch(error => this.onerror?.({ message: String(error) }));
  }
}

describe("expanded memory overview response", () => {
  beforeEach(() => { workers.length = 0; vi.clearAllMocks(); vi.stubGlobal("Worker", ParserWorker); });
  afterEach(() => vi.unstubAllGlobals());

  it("transfers the response body and reassembles bounded chunks without changing the API URL, credentials or metadata", async () => {
    const payload = graphPayload(), response = new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    const readText = vi.spyOn(response, "text"), readBuffer = vi.spyOn(response, "arrayBuffer");
    const fetchMock = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetchMock);
    expect(await api.memoryGraphOverview({ limit: 50_000, q: "release", month: "all", relationMode: "RELATIONS" })).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/memory/graph/overview?limit=50000&q=release&month=all&relationMode=RELATIONS", expect.objectContaining({ credentials: "include" }));
    expect(readText).not.toHaveBeenCalled(); expect(readBuffer).toHaveBeenCalledOnce();
    expect(workers[0]!.url.pathname).toContain("memory-overview-parser.worker.ts");
    expect(workers[0]!.options).toEqual({ type: "module" });
    expect(workers[0]!.messages.filter(message => message.kind === "nodes").every(message => message.nodes.length <= 500)).toBe(true);
    expect(workers[0]!.messages.filter(message => message.kind === "edges").every(message => message.edges.length <= 2000)).toBe(true);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce(); expect(core.reportCoreApiSuccess).toHaveBeenCalledOnce();
    expect(core.reportCoreApiFailure).not.toHaveBeenCalled();
  });

  it.each([undefined, 2000])("keeps the ordinary response reader for default/small limit %s", async limit => {
    const payload = graphPayload(2), response = new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    const readText = vi.spyOn(response, "text"); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await api.memoryGraphOverview(limit === undefined ? {} : { limit })).toEqual(payload);
    expect(readText).toHaveBeenCalledOnce(); expect(workers).toHaveLength(0);
  });

  it.each([401, 403, 502])("keeps error fields and core API reporting for status %i", async status => {
    const error = { error: { code: status === 502 ? "UPSTREAM_UNAVAILABLE" : "ADMIN_REQUIRED", message: "Request refused.", requestId: "request:denied", details: { check: "authorization" } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(error), { status, headers: { "content-type": "application/json" } })));
    await expect(api.memoryGraphOverview({ limit: 50_000 })).rejects.toMatchObject({ status, code: error.error.code, requestId: error.error.requestId, details: error.error.details });
    expect(workers).toHaveLength(0); expect(core.reportCoreApiSuccess).not.toHaveBeenCalled();
    expect(core.reportCoreApiFailure).toHaveBeenCalledTimes(status === 502 ? 1 : 0);
  });

  it("falls back before consuming the body when workers are unavailable or blocked", async () => {
    for (const unavailable of [undefined, class { constructor() { throw new Error("Worker blocked"); } }]) {
      vi.stubGlobal("Worker", unavailable);
      const fallback = vi.fn().mockResolvedValue({ normal: true });
      const response = new Response("body"); const readBuffer = vi.spyOn(response, "arrayBuffer");
      expect(await readMemoryOverviewResponse("/api/admin/memory/graph/overview?limit=50000", response, fallback)).toEqual({ normal: true });
      expect(fallback).toHaveBeenCalledOnce(); expect(readBuffer).not.toHaveBeenCalled();
    }
  });

  it.each([["", "application/json", null], ["{broken", "application/json", "{broken"], ["123", "text/plain", "123"]])("preserves empty, malformed and non-JSON text responses", async (body, contentType, expected) => {
    const messages: MemoryOverviewParseMessage[] = [];
    const buffer = new TextEncoder().encode(body as string).buffer as ArrayBuffer;
    await streamMemoryOverviewResponse({ buffer, contentType: contentType as string }, message => messages.push(message));
    expect(messages).toEqual([{ kind: "value", value: expected }]);
  });
});
