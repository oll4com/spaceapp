import { describe, expect, it, vi } from "vitest";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { createMemoryLayout3D } from "../src/features/memory-workspace/memory-3d-layout.js";
import { referenceMemoryAtlas, streamMemoryLayout } from "../src/features/memory-workspace/memory-layout-stream.js";
import type { MemoryLayoutMessage } from "../src/features/memory-workspace/memory-layout-protocol.js";
import { hydrateMemoryMap, hydrateReferencedMemoryAtlas } from "../src/features/memory-workspace/memory-layout-hydration.js";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";

function fixture(count: number) {
  const nodes: MemoryGraphNode[] = Array.from({ length: count }, (_, i) => ({
    id: `n-${i.toString().padStart(6, "0")}`, label: i === 0 ? "space.md" : `Memory ${i}`,
    type: i % 50 === 0 ? "SOURCE" : "MEMORY", sourcePath: "/memory/2026-10.md", recordId: i % 50 === 0 ? null : `record-${i}`
  }));
  const edges: MemoryGraphEdge[] = nodes.flatMap((node, i) => i % 50 === 0 ? [] : [{
    id: `edge-${i}`, source: nodes[Math.floor(i / 50) * 50]!.id, target: node.id, type: "CONTAINS" as const
  }]);
  return { nodes, edges };
}

describe("incremental 3D memory layout", () => {
  it("yields usable initial geometry before advancing, then completes in the same stable order", async () => {
    const graph = fixture(81);
    const messages: MemoryLayoutMessage[] = [];
    const checkpoints: number[] = [];
    await streamMemoryLayout({ kind: "layout", mode: "3d", ...graph }, (message, transfer) => {
      messages.push(structuredClone(message, { transfer: transfer ?? [] }));
    }, { yieldControl: async () => { checkpoints.push(messages.length); } });
    expect(messages[0]?.kind).toBe("atlas");
    const depths = messages.filter(message => message.kind === "depth");
    expect(depths[0]).toMatchObject({ step: 0, complete: false });
    expect(depths[0]!.ids).toEqual(graph.nodes.map(node => node.id));
    expect(depths[0]!.coordinates.length).toBe(graph.nodes.length * 3);
    expect(checkpoints).toContain(2);
    expect(depths.at(-1)).toMatchObject({ step: 180, complete: true });
    expect(depths.slice(1).every(message => message.ids === undefined)).toBe(true);
    expect(messages.some(message => message.kind === "positions")).toBe(false);
    const simulation = createMemoryLayout3D(graph.nodes, graph.edges);
    simulation.advance(180);
    // Node structuredClone returns a typed array from a different realm than jsdom.
    // Compare every numeric coordinate, retaining the separate transfer assertions below.
    expect(Array.from(depths.at(-1)!.coordinates)).toEqual(Array.from(simulation.snapshot()));
    expect(Array.from(depths[0]!.coordinates)).not.toEqual(Array.from(depths.at(-1)!.coordinates));
  });

  it("preserves deterministic large-graph output across reordering and different yield boundaries", () => {
    const graph = fixture(2001);
    // A record with two source parents must not depend on incoming edge order.
    graph.edges.push({ id: "z-second-parent", source: graph.nodes[50]!.id, target: graph.nodes[1]!.id, type: "CONTAINS" });
    const a = createMemoryLayout3D(graph.nodes, graph.edges);
    const b = createMemoryLayout3D([...graph.nodes].reverse(), [...graph.edges].reverse());
    a.advance(180);
    for (let i = 0; i < 60; i++) b.advance(3);
    expect(b.ids).toEqual(a.ids);
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(a.complete).toBe(true);
    expect([...a.snapshot()].every(Number.isFinite)).toBe(true);
    expect(a.toMap().get(graph.nodes[0]!.id)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("does not retain a detached snapshot or mutate a previous snapshot", () => {
    const graph = fixture(40);
    const simulation = createMemoryLayout3D(graph.nodes, graph.edges);
    const first = simulation.snapshot();
    const original = first.slice();
    const transferred = structuredClone(first, { transfer: [first.buffer] });
    expect(first.byteLength).toBe(0);
    simulation.advance();
    expect(Array.from(transferred)).toEqual(Array.from(original));
    expect(Array.from(simulation.snapshot())).not.toEqual(Array.from(original));
  });

  it("honors cancellation before and after its initial transferable positions", async () => {
    const graph = fixture(80);
    const messages: MemoryLayoutMessage[] = [];
    let cancelled = false;
    await streamMemoryLayout({ kind: "layout", mode: "3d", ...graph }, message => {
      messages.push(message);
      if (message.kind === "depth") cancelled = true;
    }, { isCancelled: () => cancelled, yieldControl: async () => {} });
    expect(messages.map(message => message.kind)).toEqual(["atlas", "depth"]);
    expect(messages[1]).toMatchObject({ step: 0, complete: false });
    const emit = vi.fn();
    await streamMemoryLayout({ kind: "layout", mode: "3d", ...graph }, emit, { isCancelled: () => true });
    expect(emit).not.toHaveBeenCalled();
  });

  it("handles empty input and preserves the separate capped 2D protocol", async () => {
    const messages: MemoryLayoutMessage[] = [];
    await streamMemoryLayout({ kind: "layout", mode: "3d", nodes: [], edges: [] }, message => messages.push(message), { yieldControl: async () => {} });
    expect(messages[1]).toMatchObject({ kind: "depth", step: 0, complete: true, ids: [] });
    messages.length = 0;
    // Cancel after atlas so this test checks the 2D cap without running a 2k-node relaxation.
    const graph = fixture(2001);
    await streamMemoryLayout({ kind: "layout", mode: "2d", ...graph }, message => messages.push(message), {
      yieldControl: async () => {}, isCancelled: () => messages.length > 0
    });
    const atlas = messages[0];
    expect(atlas?.kind).toBe("atlas");
    if (atlas?.kind !== "atlas") throw new Error("Missing atlas");
    expect(atlas.atlas.nodes.length).toBe(2000);
    expect(atlas.atlas.edges.every(edge => edge.source !== graph.nodes[2000]!.id && edge.target !== graph.nodes[2000]!.id)).toBe(true);
    const small: MemoryLayoutMessage[] = [];
    await streamMemoryLayout({ kind: "layout", mode: "2d", ...fixture(8) }, message => small.push(message), { yieldControl: async () => {} });
    expect(small.map(message => message.kind)).toEqual(["atlas", "positions"]);
  });

  it("formats a shared source month once instead of invoking Intl for every memory", () => {
    const format = vi.spyOn(Date.prototype, "toLocaleDateString");
    const graph = fixture(2001);
    try {
      const atlas = createMemoryAtlas(graph.nodes, graph.edges, false);
      expect(format).toHaveBeenCalledTimes(1);
      expect(atlas.positions.get(graph.nodes[1]!.id)?.monthLabel).toBe("Oct 2026");
    } finally { format.mockRestore(); }
  });

  it("transfers large atlas references without cloning graph objects and preserves filtered order and metadata", async () => {
    const graph = fixture(2050);
    const tagged = graph.nodes.slice(1, 21);
    graph.nodes[1]!.position = { clustered: { x: 0, y: 0 }, relations: { x: Math.PI, y: Math.E } };
    graph.nodes[2]!.sourcePath = null;
    const topic: MemoryGraphNode = { id: "topic:explicit", label: "Shared tag", type: "TOPIC", sourcePath: null, recordId: null };
    const weak: MemoryGraphNode = { ...topic, id: "topic:weak", label: "Hidden singleton" };
    graph.nodes.push(topic, weak);
    graph.edges.push(...tagged.map((node, index) => ({ id: `tag:${index}`, source: node.id, target: topic.id, type: "TAGGED_WITH" as const, origin: "EXPLICIT_TAG" as const })));
    graph.edges.push({ id: "weak-tag", source: tagged[0]!.id, target: weak.id, type: "TAGGED_WITH" });
    graph.nodes.reverse(); graph.edges.reverse();
    const expected = createMemoryAtlas(graph.nodes, graph.edges, false);
    const messages: MemoryLayoutMessage[] = [];
    let buffersDetached = false;
    await streamMemoryLayout({ kind: "layout", mode: "3d", ...graph }, (message, transfer) => {
      messages.push(structuredClone(message, { transfer: transfer ?? [] }));
      buffersDetached = Boolean(transfer?.length && transfer.every(buffer => (buffer as ArrayBuffer).byteLength === 0));
    }, { yieldControl: async () => {}, isCancelled: () => messages.length > 0 });
    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (message?.kind !== "atlas-references") throw new Error("Expected transferred atlas references");
    expect(buffersDetached).toBe(true);
    expect(message.atlas).not.toHaveProperty("nodes");
    expect(message.atlas).not.toHaveProperty("edges");
    expect(message.atlas).not.toHaveProperty("positions");
    expect(message.atlas.positionCoordinates.byteLength).toBe(expected.positions.size * 2 * Float64Array.BYTES_PER_ELEMENT);
    const hydrated = await hydrateReferencedMemoryAtlas(message.atlas, graph, () => false, async () => {});
    expect(hydrated).toEqual(expected);
    expect([...hydrated!.positions]).toEqual([...expected.positions]);
    expect(hydrated!.nodes.every((node, index) => node === expected.nodes[index])).toBe(true);
    expect(hydrated!.edges.every((edge, index) => edge === expected.edges[index])).toBe(true);
    expect(hydrated!.nodes.some(node => node.id === weak.id)).toBe(false);
    expect(hydrated!.positions.get(tagged[0]!.id)).toMatchObject({ x: Math.PI, y: Math.E });
    expect(hydrated!.topics).toHaveLength(1);
    expect(hydrated!.topics[0]).toMatchObject({ id: topic.id, count: 20, explicit: true });
  });
});


describe("transferred coordinate hydration", () => {
  it("yields during a large map and abandons a superseded graph without publishing a partial map", async () => {
    let clock = 0;
    const timer = vi.spyOn(performance, "now").mockImplementation(() => clock += 5);
    let yields = 0;
    try {
      const map = await hydrateMemoryMap(4096, i => [`node:${i}`, i], () => false, async () => { yields++; });
      expect(map?.size).toBe(4096);
      expect(map?.get("node:4095")).toBe(4095);
      expect(yields).toBe(4);
      let cancelled = false;
      const stale = await hydrateMemoryMap(4096, i => [`node:${i}`, i], () => cancelled, async () => { cancelled = true; });
      expect(stale).toBeNull();
    } finally { timer.mockRestore(); }
  });

  it("abandons referenced atlas reconstruction between batches without publishing partial arrays", async () => {
    const graph = fixture(2050);
    const packed = referenceMemoryAtlas(createMemoryAtlas(graph.nodes, graph.edges, false), graph).atlas;
    let clock = 0, cancelled = false, yields = 0;
    const timer = vi.spyOn(performance, "now").mockImplementation(() => clock += 5);
    try {
      const hydrated = await hydrateReferencedMemoryAtlas(packed, graph, () => cancelled, async () => { yields++; cancelled = true; });
      expect(hydrated).toBeNull();
      expect(yields).toBe(1);
    } finally { timer.mockRestore(); }
  });
});
