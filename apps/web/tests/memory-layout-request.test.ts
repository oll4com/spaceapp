import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { MemoryLayoutRequestAssembler, sendMemoryLayoutRequest } from "../src/features/memory-workspace/memory-layout-request.js";
import type { MemoryLayoutInput, MemoryLayoutRequest } from "../src/features/memory-workspace/memory-layout-protocol.js";

const stream = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/features/memory-workspace/memory-layout-stream.js", () => ({ streamMemoryLayout: stream }));

function fixture(count = 2001): MemoryLayoutRequest {
  const nodes: MemoryGraphNode[] = Array.from({ length: count }, (_, i) => ({
    id: `memory:${count - i}`, label: i % 2 ? "Hidden memory" : `Synthetic memory ${i}`, type: "MEMORY",
    sourcePath: i % 2 ? null : `/synthetic/${i}.md`, recordId: i % 2 ? null : `record:${i}`,
    position: { clustered: { x: i, y: -i }, relations: { x: i / 3, y: i * 7 } }
  }));
  const edges: MemoryGraphEdge[] = nodes.flatMap((node, i) => [1, 2, 3].map(offset => ({
    id: `edge:${i}:${offset}`, source: node.id, target: nodes[(i + offset) % count]!.id,
    type: "SEMANTICALLY_RELATED", origin: "DETERMINISTIC_TFIDF", confidence: 0.75, evidence: `Synthetic evidence ${i}:${offset}`
  })));
  return { kind: "layout", mode: "3d", nodes, edges };
}

const begin = (requestId = 1, nodeCount = 1, edgeCount = 1): MemoryLayoutInput => ({
  kind: "layout-begin", requestId, mode: "3d", nodeCount, edgeCount
});
const sample = fixture(1);
const nodeBatch = (requestId = 1, offset = 0): MemoryLayoutInput => ({ kind: "layout-nodes", requestId, offset, nodes: sample.nodes });
const edgeBatch = (requestId = 1, offset = 0): MemoryLayoutInput => ({ kind: "layout-edges", requestId, offset, edges: sample.edges.slice(0, 1) });
const end = (requestId = 1): MemoryLayoutInput => ({ kind: "layout-end", requestId });

describe("bounded layout request transport", () => {
  it("clones bounded batches and assembles exact original order and rich metadata only at end", async () => {
    const request = fixture();
    const assembler = new MemoryLayoutRequestAssembler();
    const messages: MemoryLayoutInput[] = [];
    const results: MemoryLayoutRequest[] = [];
    let yields = 0, lastPostYield = -1;
    await sendMemoryLayoutRequest({ postMessage(message) {
      expect(yields).toBeGreaterThan(lastPostYield);
      lastPostYield = yields;
      const cloned = structuredClone(message);
      messages.push(cloned);
      const result = assembler.accept(cloned);
      if (result) {
        expect(message.kind).toBe("layout-end");
        results.push(result);
      }
    } }, request, () => false, async () => { yields++; });
    expect(messages[0]).toMatchObject({ kind: "layout-begin", nodeCount: 2001, edgeCount: 6003 });
    expect(messages.at(-1)?.kind).toBe("layout-end");
    expect(messages.some(message => message.kind === "layout")).toBe(false);
    const nodes = messages.filter(message => message.kind === "layout-nodes");
    const edges = messages.filter(message => message.kind === "layout-edges");
    expect(nodes.map(message => message.nodes.length)).toEqual([500, 500, 500, 500, 1]);
    expect(edges.map(message => message.edges.length)).toEqual([1500, 1500, 1500, 1500, 3]);
    expect(nodes.map(message => message.offset)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(edges.map(message => message.offset)).toEqual([0, 1500, 3000, 4500, 6000]);
    expect(results).toEqual([request]);
    expect(results[0]!.nodes[0]).not.toBe(request.nodes[0]);
    expect(results[0]!.nodes.map(node => node.id)).toEqual(request.nodes.map(node => node.id));
    expect(results[0]!.edges.map(edge => edge.id)).toEqual(request.edges.map(edge => edge.id));
    expect(() => assembler.accept(end((messages[0] as { requestId: number }).requestId))).toThrow();
  });

  it("preserves the small and 2D direct request protocol without yielding", async () => {
    for (const request of [fixture(2000), { ...fixture(2001), mode: "2d" as const }, fixture(0)]) {
      const postMessage = vi.fn(), yieldControl = vi.fn(async () => {});
      await sendMemoryLayoutRequest({ postMessage }, request, () => false, yieldControl);
      expect(postMessage).toHaveBeenCalledExactlyOnceWith(request);
      expect(yieldControl).not.toHaveBeenCalled();
      expect(new MemoryLayoutRequestAssembler().accept(postMessage.mock.calls[0]![0])).toBe(request);
    }
  });

  it.each([0, 1, 2, 6, 7, 11])("stops before every send when cancelled after %i posts and never publishes partial data", async afterPosts => {
    const messages: MemoryLayoutInput[] = [];
    let cancelled = afterPosts === 0;
    await sendMemoryLayoutRequest({ postMessage(message) {
      expect(cancelled).toBe(false);
      messages.push(message);
    } }, fixture(), () => cancelled, async () => { cancelled = messages.length >= afterPosts; });
    expect(messages).toHaveLength(afterPosts);
    expect(messages.some(message => message.kind === "layout-end" || message.kind === "layout")).toBe(false);
    const assembler = new MemoryLayoutRequestAssembler();
    for (const message of messages) expect(assembler.accept(message)).toBeNull();
  });

  it("uses batching for an edge-heavy small graph and rejects oversized requests before posting", async () => {
    const request = fixture(1);
    request.edges = Array.from({ length: 6001 }, (_, index) => ({ ...request.edges[0]!, id: `edge:${index}` }));
    const postMessage = vi.fn();
    await sendMemoryLayoutRequest({ postMessage }, request, () => false, async () => {});
    expect(postMessage.mock.calls[0]![0].kind).toBe("layout-begin");
    postMessage.mockClear();
    await expect(sendMemoryLayoutRequest({ postMessage }, { ...request, nodes: Array(50_001).fill(request.nodes[0]) }, () => false)).rejects.toThrow();
    await expect(sendMemoryLayoutRequest({ postMessage }, { ...request, edges: Array(150_001).fill(request.edges[0]) }, () => false)).rejects.toThrow();
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("worker request assembly validation", () => {
  const cases: Array<[string, unknown[]]> = [
    ["missing begin", [nodeBatch()]],
    ["invalid input", [null]],
    ["invalid request ID", [{ ...begin(), requestId: 0 }]],
    ["noninteger request ID", [{ ...begin(), requestId: 1.5 }]],
    ["oversized node declaration", [begin(1, 50_001, 0)]],
    ["oversized edge declaration", [begin(1, 0, 150_001)]],
    ["negative declaration", [begin(1, -1, 0)]],
    ["fractional declaration", [begin(1, 1.5, 0)]],
    ["wrong batch mode", [{ ...begin(), mode: "2d" }]],
    ["wrong generation", [begin(), nodeBatch(2)]],
    ["edges before nodes", [begin(), edgeBatch()]],
    ["noncontiguous node offset", [begin(), nodeBatch(1, 1)]],
    ["duplicate node batch", [begin(), nodeBatch(), nodeBatch()]],
    ["oversized node batch", [begin(1, 501, 0), { ...nodeBatch(), nodes: Array(501).fill(sample.nodes[0]) }]],
    ["nodes beyond declaration", [begin(1, 0, 0), nodeBatch()]],
    ["empty node batch", [begin(), { ...nodeBatch(), nodes: [] }]],
    ["invalid node array", [begin(), { ...nodeBatch(), nodes: null }]],
    ["noncontiguous edge offset", [begin(), nodeBatch(), edgeBatch(1, 1)]],
    ["duplicate edge batch", [begin(), nodeBatch(), edgeBatch(), edgeBatch()]],
    ["oversized edge batch", [begin(1, 0, 1501), { ...edgeBatch(), edges: Array(1501).fill(sample.edges[0]) }]],
    ["edges beyond declaration", [begin(1, 0, 0), edgeBatch()]],
    ["empty edge batch", [begin(1, 0, 1), { ...edgeBatch(), edges: [] }]],
    ["premature completion", [begin(), end()]],
    ["missing declared edges", [begin(), nodeBatch(), end()]],
    ["unrecognized batch", [begin(), { kind: "layout-unknown", requestId: 1 }]],
    ["duplicate begin", [begin(), begin()]]
  ];
  it.each(cases)("rejects %s and discards partial assembly", (_name, inputs) => {
    const assembler = new MemoryLayoutRequestAssembler();
    for (const input of inputs.slice(0, -1)) expect(assembler.accept(input)).toBeNull();
    expect(() => assembler.accept(inputs.at(-1))).toThrow();
    expect(() => assembler.accept(end())).toThrow();
    // A valid later generation can recover after an invalid message.
    expect(assembler.accept(begin(2, 0, 0))).toBeNull();
    expect(assembler.accept(end(2))).toEqual({ kind: "layout", mode: "3d", nodes: [], edges: [] });
  });

  it("replaces an abandoned generation and accepts the existing direct request shape", () => {
    const assembler = new MemoryLayoutRequestAssembler();
    assembler.accept(begin(1, 2, 0)); assembler.accept(nodeBatch());
    assembler.accept(begin(2, 0, 0));
    expect(assembler.accept(end(2))).toEqual({ kind: "layout", mode: "3d", nodes: [], edges: [] });
    assembler.accept(begin(3));
    const direct = fixture(1);
    expect(assembler.accept(direct)).toBe(direct);
    expect(() => assembler.accept(end(3))).toThrow();
  });
});

describe("layout worker request dispatch", () => {
  afterEach(() => { vi.unstubAllGlobals(); stream.mockClear(); });
  async function worker() {
    vi.resetModules();
    const scope = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn() };
    vi.stubGlobal("self", scope);
    await import("../src/features/memory-workspace/memory-network-layout.worker.js");
    return { scope, send: (data: unknown) => scope.onmessage!({ data }) };
  }

  it("starts only on complete assembly and cancels an earlier layout when a replacement begins", async () => {
    const { scope, send } = await worker();
    send(begin()); send(nodeBatch()); send(edgeBatch());
    expect(stream).not.toHaveBeenCalled();
    send(end());
    expect(stream).toHaveBeenCalledTimes(1);
    const [request, emit, options] = stream.mock.calls[0] as unknown as [MemoryLayoutRequest, (message: unknown) => void, { isCancelled(): boolean }];
    expect(request).toEqual({ kind: "layout", mode: "3d", nodes: sample.nodes, edges: sample.edges.slice(0, 1) });
    expect(options.isCancelled()).toBe(false);
    send(begin(2, 0, 0));
    expect(options.isCancelled()).toBe(true);
    emit({ kind: "error", message: "obsolete" });
    expect(scope.postMessage).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
    send(end(2));
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("reports malformed messages instead of starting partial layout and recovers on a later request", async () => {
    const { scope, send } = await worker();
    send(begin()); send(end());
    expect(stream).not.toHaveBeenCalled();
    expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
    send(null);
    expect(stream).not.toHaveBeenCalled();
    send(begin(2, 0, 0)); send(end(2));
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
