// @vitest-environment node
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postMemoryNetworkLayoutRequest } from "../src/features/memory-workspace/memory-network-transport.js";
import type { MemoryNetworkLayoutMessage, MemoryNetworkLayoutWorkerRequest } from "../src/features/memory-workspace/memory-network-layout-protocol.js";

const simulation = vi.hoisted(() => vi.fn((nodes: Array<{ id: string }>) => ({
  done: true, progress: 1, advance() {},
  snapshot: () => new Map(nodes.map(node => [node.id, { x: 1, y: 2, z: 3 }]))
})));
vi.mock("../src/features/memory-workspace/memory-3d.js", () => ({ createMemoryNetwork3DSimulation: simulation }));

const nodes = (count: number): MemoryGraphNode[] => Array.from({ length: count }, (_, index) => ({
  id: `node:${index}`, type: "MEMORY", label: `Node ${index}`, sourcePath: null, recordId: null
}));
const edges = (count: number): MemoryGraphEdge[] => Array.from({ length: count }, (_, index) => ({
  id: `edge:${index}`, type: "CONTAINS", source: "node:0", target: "node:1"
}));

describe("memory layout worker transport", () => {
  afterEach(() => { vi.unstubAllGlobals(); simulation.mockClear(); });

  it("preserves the direct protocol for small existing requests", async () => {
    const worker = { postMessage: vi.fn() };
    const request = { nodes: nodes(2), edges: edges(1), mode: "3D" as const, prepareAtlas: true };
    await postMemoryNetworkLayoutRequest(worker, request);
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("sends every large graph entry once in bounded batches and yields to input", async () => {
    const received: MemoryNetworkLayoutWorkerRequest[] = [];
    let yielded = false;
    const worker = { postMessage(message: MemoryNetworkLayoutWorkerRequest) { received.push(message); } };
    const request = { nodes: nodes(2101), edges: edges(6101), mode: "3D" as const, prepareAtlas: true };
    setTimeout(() => { yielded = true; }, 0);
    const sending = postMemoryNetworkLayoutRequest(worker, request);
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ kind: "begin", mode: "3D", prepareAtlas: true });
    await sending;
    expect(yielded).toBe(true);
    const nodeChunks = received.filter(message => "kind" in message && message.kind === "nodes");
    const edgeChunks = received.filter(message => "kind" in message && message.kind === "edges");
    expect(nodeChunks.every(message => "nodes" in message && message.nodes.length <= 500)).toBe(true);
    expect(edgeChunks.every(message => "edges" in message && message.edges.length <= 2000)).toBe(true);
    expect(nodeChunks.flatMap(message => "nodes" in message ? message.nodes : [])).toEqual(request.nodes);
    expect(edgeChunks.flatMap(message => "edges" in message ? message.edges : [])).toEqual(request.edges);
    expect(received.at(-1)).toEqual({ kind: "finish" });
  });

  it("stops a cancelled transfer before sending its remaining graph or finish", async () => {
    let active = true;
    const received: MemoryNetworkLayoutWorkerRequest[] = [];
    const worker = { postMessage(message: MemoryNetworkLayoutWorkerRequest) {
      received.push(message);
      if ("kind" in message && message.kind === "nodes") active = false;
    } };
    await postMemoryNetworkLayoutRequest(worker, { nodes: nodes(2101), edges: edges(6101) }, () => active);
    expect(received).toHaveLength(2);
    expect(received.some(message => "kind" in message && message.kind === "finish")).toBe(false);
  });

  it("assembles worker chunks only on finish and discards a superseded begin", async () => {
    const scope = { onmessage: null as null | ((event: { data: MemoryNetworkLayoutWorkerRequest }) => void), postMessage: vi.fn() };
    vi.stubGlobal("self", scope);
    await import("../src/features/memory-workspace/memory-network-layout.worker.js");
    const send = (data: MemoryNetworkLayoutWorkerRequest) => scope.onmessage!({ data });
    send({ kind: "begin", mode: "3D" });
    send({ kind: "nodes", nodes: nodes(3) });
    expect(simulation).not.toHaveBeenCalled();
    send({ kind: "begin", mode: "3D" });
    const finalNodes = nodes(2), finalEdges = edges(1);
    send({ kind: "nodes", nodes: finalNodes });
    send({ kind: "edges", edges: finalEdges });
    send({ kind: "finish" });
    expect(simulation).toHaveBeenCalledExactlyOnceWith(finalNodes, finalEdges);
    await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ done: true, progress: 1 })));

    simulation.mockClear(); scope.postMessage.mockClear();
    const largeNodes = nodes(2101);
    send({ nodes: largeNodes, edges: [], mode: "3D", prepareAtlas: true });
    const [initial, options] = scope.postMessage.mock.calls[0]! as [MemoryNetworkLayoutMessage, { transfer: ArrayBuffer[] }];
    expect(initial.rawGraph).toBe(true);
    expect(initial.atlas!.nodes).toHaveLength(0);
    expect(initial.atlas!.positions.size).toBe(0);
    expect(initial.packedDepth).toBeInstanceOf(Float32Array);
    expect(initial.packedDepth!.length).toBe(largeNodes.length * 3);
    expect(initial.depth).toBeUndefined();
    expect(options.transfer).toHaveLength(6);
    await vi.waitFor(() => expect(scope.postMessage.mock.calls.some(([message]) => message.done && message.packedPositions instanceof Float32Array)).toBe(true));
  });
});
