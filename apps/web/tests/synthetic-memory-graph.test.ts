import { describe, expect, it } from "vitest";
import { memoryGraphNodeDetailSchema, memoryGraphOverviewPayloadSchema } from "@space/contracts";
import { DemoStore } from "../src/demo/DemoStore.js";
import { generateSyntheticMemoryGraph, generateSyntheticMemoryGraphAsync, mulberry32, SyntheticGraphBuilder, SYNTHETIC_MEMORY_SIZES, syntheticNodeDetail } from "../src/demo/synthetic-memory-graph.js";

describe("synthetic memory graph", () => {
  it("is deterministic and never uses Math.random", () => {
    const random = Math.random;
    Math.random = () => { throw new Error("Math.random must not be used"); };
    try {
      expect(generateSyntheticMemoryGraph(2000)).toEqual(generateSyntheticMemoryGraph(2000));
    } finally { Math.random = random; }
    const a = mulberry32(7), b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it.each(SYNTHETIC_MEMORY_SIZES)("has exactly %i nodes, three edges per node, a core source and valid references", size => {
    const graph = generateSyntheticMemoryGraph(size);
    expect(graph.nodes).toHaveLength(size);
    expect(graph.edges).toHaveLength(size * 3);
    const ids = new Set(graph.nodes.map(node => node.id));
    expect(ids.size).toBe(size);
    expect(new Set(graph.edges.map(edge => edge.id)).size).toBe(graph.edges.length);
    for (const edge of graph.edges) { expect(ids.has(edge.source)).toBe(true); expect(ids.has(edge.target)).toBe(true); expect(edge.source).not.toBe(edge.target); }
    const sources = graph.nodes.filter(node => node.type === "SOURCE");
    expect(sources.filter(node => node.label === "space.md")).toHaveLength(1);
    expect(new Set(sources.map(node => node.sourcePath)).size).toBe(sources.length);
    expect(graph.summary.sourceCount).toBeLessThanOrEqual(24);
    expect(graph.nodes.every(node => node.id.includes(`synthetic-${size}-`))).toBe(true);
    expect(graph.nodes.filter(node => node.type === "MEMORY").length).toBe(graph.summary.recordCount);
  });

  it("serves schema-valid overviews at 2k, 10k and 50k through the demo store, with size-specific node details", async () => {
    const store = new DemoStore();
    const ids: string[] = [];
    for (const size of SYNTHETIC_MEMORY_SIZES) {
      const { data } = await store.api.memoryGraphOverview({ limit: size });
      expect(memoryGraphOverviewPayloadSchema.parse(data)).toEqual(data);
      expect(data.nodes).toHaveLength(size);
      expect(data.edges).toHaveLength(size * 3);
      const memory = data.nodes.find(node => node.type === "MEMORY")!;
      ids.push(memory.id);
      const detail = await store.api.memoryGraphNode(memory.id);
      expect(memoryGraphNodeDetailSchema.parse(detail).node.id).toBe(memory.id);
    }
    expect(new Set(ids).size).toBe(3);
    await expect(store.api.memoryGraphOverview({ limit: 99 })).rejects.toThrow();
    await expect(store.api.memoryGraphNode("memory:synthetic-2000-999999")).rejects.toThrow();
    expect(syntheticNodeDetail(generateSyntheticMemoryGraph(2000), "missing:node-id", "2026-07-18T12:00:00.000Z")).toBeNull();
  }, 120_000);

  it("keeps the default demo overview unchanged without a limit", async () => {
    const { data } = await new DemoStore().api.memoryGraphOverview();
    expect(data.nodes.length).toBeLessThan(20);
  });
});

describe("sliced synthetic graph generation", () => {
  // A fake clock that advances one tick per read makes the slice count depend only on the budget, not on machine speed.
  const tickClock = () => { let t = 0; return () => t++; };

  it.each([200, 777, 2000, 10_000])("equals the synchronous result at %i nodes whatever the slice budget", async size => {
    const expected = generateSyntheticMemoryGraph(size);
    for (const sliceMs of [0, 1, 3, 50]) {
      let yields = 0;
      const sliced = await generateSyntheticMemoryGraphAsync(size, { sliceMs, now: tickClock(), yieldToEvents: async () => { yields++; } });
      expect(sliced, `sliceMs ${sliceMs}`).toEqual(expected);
      expect(Object.keys(sliced)).toEqual(Object.keys(expected));
      if (sliceMs === 0 && size >= 2000) expect(yields).toBeGreaterThan(5);
    }
  });

  it("keeps node and edge order identical (ids in the same sequence) when sliced", () => {
    const sync = generateSyntheticMemoryGraph(2000);
    const builder = new SyntheticGraphBuilder(2000);
    while (!builder.step(0, tickClock())) { /* one batch per slice */ }
    const sliced = builder.result();
    expect(sliced.nodes.map(node => node.id)).toEqual(sync.nodes.map(node => node.id));
    expect(sliced.edges.map(edge => edge.id)).toEqual(sync.edges.map(edge => edge.id));
    expect(sliced.edges.map(edge => edge.confidence)).toEqual(sync.edges.map(edge => edge.confidence));
  });

  it("splits the work into bounded slices that each make progress, and finishes in one slice for an unlimited budget", () => {
    const small = new SyntheticGraphBuilder(50_000);
    expect(small.step(Infinity)).toBe(true);
    expect(small.sliceCount).toBe(1);
    const builder = new SyntheticGraphBuilder(50_000);
    let slices = 0, last = 0;
    while (!builder.step(0, tickClock())) { slices++; expect(builder.done).toBe(false); expect(slices).toBeLessThan(2000); last = builder.sliceCount; }
    // 50k nodes need ~200 memory batches and ~600 related-edge batches of 256 iterations; each slice is exactly one batch here.
    expect(slices).toBeGreaterThan(300);
    expect(builder.sliceCount).toBe(last + 1);
    expect(() => new SyntheticGraphBuilder(50_000).result()).toThrow("not finished");
  });

  it("is deterministic when sliced and never uses Math.random", async () => {
    const random = Math.random;
    Math.random = () => { throw new Error("Math.random must not be used"); };
    try {
      const a = await generateSyntheticMemoryGraphAsync(2000, { sliceMs: 0, yieldToEvents: async () => {} });
      const b = await generateSyntheticMemoryGraphAsync(2000, { sliceMs: 2, now: tickClock(), yieldToEvents: async () => {} });
      expect(a).toEqual(b);
    } finally { Math.random = random; }
  });

  it("rejects an invalid size like the synchronous generator", async () => {
    await expect(generateSyntheticMemoryGraphAsync(199)).rejects.toThrow("at least 200");
    expect(() => new SyntheticGraphBuilder(1.5)).toThrow("at least 200");
  });

  it("yields to the event loop between slices by default so timers can run", async () => {
    let timerRan = false;
    setTimeout(() => { timerRan = true; }, 0);
    let ranBeforeFinish = false;
    const graph = await generateSyntheticMemoryGraphAsync(10_000, { sliceMs: 0, now: tickClock() });
    ranBeforeFinish = timerRan;
    expect(ranBeforeFinish).toBe(true);
    expect(graph.nodes).toHaveLength(10_000);
  });

  it("builds one graph per size for concurrent demo requests and keeps node details consistent", async () => {
    const store = new DemoStore();
    const [overview, other] = await Promise.all([store.api.memoryGraphOverview({ limit: 2000 }), store.api.memoryGraphOverview({ limit: 2000 })]);
    expect(overview.data.nodes).toBe(other.data.nodes);
    const memory = overview.data.nodes.find(node => node.type === "MEMORY")!;
    expect((await store.api.memoryGraphNode(memory.id)).node).toEqual(memory);
  });
});
