import { describe, expect, it } from "vitest";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { layoutMemoryNetwork3D } from "../src/features/memory-workspace/memory-3d.js";
import { MemorySceneStream, runSceneJob, type GraphSource, type StreamIo, type WorkerLike, type WorkerMessage, type WorkerRequest } from "../src/features/memory-workspace/memory-layout-stream.js";
import { generateSyntheticMemoryGraph } from "../src/demo/synthetic-memory-graph.js";
import { capSceneForFallback } from "../src/features/memory-workspace/memory-scene.js";

const harness = (cancelAfterPosts = Infinity) => {
  const messages: WorkerMessage[] = [];
  let clock = 0, cancelled = false, yields = 0;
  const io: StreamIo = {
    now: () => (clock += 5), // every call advances 5 ms, so slices end deterministically
    yieldToEvents: async () => { yields++; },
    isCancelled: () => cancelled,
    post: message => { messages.push(message); if (messages.filter(m => m.type === "positions").length >= cancelAfterPosts) cancelled = true; }
  };
  return { io, messages, yields: () => yields, cancel: () => { cancelled = true; } };
};
const synthetic = (size: number): GraphSource => ({ kind: "synthetic", size });

describe("layout streaming protocol", () => {
  it("posts the scene first, then ordered snapshots; the final one equals the synchronous layout", async () => {
    const h = harness();
    await runSceneJob(1, synthetic(300), h.io);
    expect(h.messages[0]!.type).toBe("scene");
    const snapshots = h.messages.filter((m): m is Extract<WorkerMessage, { type: "positions" }> => m.type === "positions");
    expect(snapshots.length).toBeGreaterThan(2);
    expect(snapshots.map(s => s.seq)).toEqual(snapshots.map((_, i) => i));
    expect(snapshots[0]!.step).toBe(0);
    for (let i = 1; i < snapshots.length; i++) expect(snapshots[i]!.step).toBeGreaterThan(snapshots[i - 1]!.step); // never repeats unchanged data
    expect(snapshots.filter(s => s.done)).toHaveLength(1);
    const last = snapshots.at(-1)!;
    expect(last.done && last.step === last.totalSteps).toBe(true);
    const scene = (h.messages[0] as Extract<WorkerMessage, { type: "scene" }>).scene;
    const graph = generateSyntheticMemoryGraph(300);
    const expected = layoutMemoryNetwork3D(graph.nodes, graph.edges);
    expect(scene.count).toBe(300);
    scene.ids.forEach((id, i) => expect({ x: last.x[i], y: last.y[i], z: last.z[i] }).toEqual(expected.get(id)));
    expect(h.yields()).toBeGreaterThan(0);
  });

  it("is deterministic across runs and under input reordering", async () => {
    const run = async (source: GraphSource) => {
      const h = harness(); await runSceneJob(1, source, h.io);
      const last = h.messages.filter(m => m.type === "positions").at(-1) as Extract<WorkerMessage, { type: "positions" }>;
      const scene = (h.messages[0] as Extract<WorkerMessage, { type: "scene" }>).scene;
      return { ids: scene.ids, x: [...last.x], y: [...last.y], z: [...last.z] };
    };
    const graph = generateSyntheticMemoryGraph(250);
    const meta = { recordCount: null, totalMatchingNodes: 250, totalMatchingEdges: 750, truncated: false, isStale: false, rawNodeCount: 250 };
    const a = await run({ kind: "inline", nodes: graph.nodes, edges: graph.edges, meta });
    const b = await run({ kind: "inline", nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse(), meta });
    expect(b).toEqual(a);
  });

  it("stops posting once cancelled", async () => {
    const h = harness(2);
    await runSceneJob(1, synthetic(300), h.io);
    expect(h.messages.filter(m => m.type === "positions")).toHaveLength(2);
    expect(h.messages.some(m => m.type === "error")).toBe(false);
  });

  it("reports load failures as an error message, not an exception", async () => {
    const h = harness(); h.io.fetchJson = async () => { throw new Error("boom"); };
    await runSceneJob(3, { kind: "url", url: "/api/x" }, h.io);
    expect(h.messages).toEqual([{ type: "error", id: 3, message: "boom" }]);
  });

  it("loads a url source from data.nodes / data.edges and keeps response meta", async () => {
    const graph = generateSyntheticMemoryGraph(250);
    const h = harness(); h.io.fetchJson = async () => ({ data: { nodes: graph.nodes, edges: graph.edges, totalMatchingNodes: 9999, truncated: true, summary: { recordCount: 42 } } });
    await runSceneJob(1, { kind: "url", url: "/api/x" }, h.io);
    expect((h.messages[0] as Extract<WorkerMessage, { type: "scene" }>).meta).toMatchObject({ recordCount: 42, totalMatchingNodes: 9999, truncated: true, rawNodeCount: 250 });
  });
});

describe("MemorySceneStream (main-thread client)", () => {
  const fakeWorker = () => {
    const sent: WorkerRequest[] = []; let terminated = false;
    const worker: WorkerLike = { onmessage: null, onerror: null, postMessage: m => { sent.push(m); }, terminate: () => { terminated = true; } };
    return { worker, sent, terminated: () => terminated };
  };
  const snapshot = (id: number, seq: number, step: number, done = false): WorkerMessage => ({ type: "positions", id, seq, step, totalSteps: 180, done, x: new Float64Array(1), y: new Float64Array(1), z: new Float64Array(1) });

  it("sends one scene request, ignores stale ids and replayed snapshots, and notifies subscribers", () => {
    const w = fakeWorker();
    const stream = new MemorySceneStream(synthetic(300), () => w.worker);
    stream.start();
    expect(w.sent).toEqual([{ type: "scene", id: stream.id, source: synthetic(300) }]);
    let notified = 0; stream.subscribe(() => notified++);
    stream.handle(snapshot(stream.id, 0, 0)); stream.handle(snapshot(stream.id + 99, 1, 50)); stream.handle(snapshot(stream.id, 0, 10)); stream.handle(snapshot(stream.id, 1, 60, true));
    expect(notified).toBe(2);
    expect(stream.step).toBe(60); expect(stream.done).toBe(true);
  });

  it("cancels the worker and drops late messages on dispose (component unmount)", () => {
    const w = fakeWorker();
    const stream = new MemorySceneStream(synthetic(300), () => w.worker);
    stream.start(); stream.dispose();
    expect(w.sent.at(-1)).toEqual({ type: "cancel", id: stream.id });
    expect(w.terminated()).toBe(true);
    stream.handle(snapshot(stream.id, 0, 5));
    expect(stream.x).toBeNull();
  });

  it("runs in-process without a Worker and can be disposed mid-flight", async () => {
    const stream = new MemorySceneStream(synthetic(250), null);
    stream.start();
    await new Promise<void>(resolve => { const off = stream.subscribe(() => { if (stream.done) { off(); resolve(); } }); });
    expect(stream.scene?.count).toBe(250);
    const early = new MemorySceneStream(synthetic(250), null);
    early.start(); early.dispose();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(early.done).toBe(false);
  }, 30_000);
});

describe("fallback cap", () => {
  it("keeps the core and sources and never exceeds 2,000 nodes / 6,000 edges", async () => {
    const h = harness(1); await runSceneJob(1, synthetic(10_000), h.io);
    const scene = (h.messages[0] as Extract<WorkerMessage, { type: "scene" }>).scene;
    const capped = capSceneForFallback(scene);
    expect(capped.nodes).toHaveLength(2000);
    expect(capped.edges.length).toBeLessThanOrEqual(6000);
    expect(capped.nodes.some(n => n.label === "space.md")).toBe(true);
    expect(capped.nodes.filter(n => n.type === "SOURCE")).toHaveLength(scene.stats.sourceCount);
    const ids = new Set(capped.nodes.map(n => n.id));
    expect(capped.edges.every(e => ids.has(e.source) && ids.has(e.target))).toBe(true);
  }, 60_000);
});
