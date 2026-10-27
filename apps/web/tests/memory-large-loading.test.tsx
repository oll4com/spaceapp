import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLargeMemoryGraph } from "../src/features/memory-workspace/use-large-memory-graph.js";
import { syntheticMemoryGraph } from "../src/demo/synthetic-memory-graph.js";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";

const overview = vi.hoisted(() => vi.fn());
vi.mock("../src/api.js", () => ({ api: { memoryGraphOverview: overview } }));
class LayoutWorker {
  static instances: LayoutWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    LayoutWorker.instances.push(this);
  }
  stream(graph: ReturnType<typeof syntheticMemoryGraph>, done = false) {
    const {
      nodes,
      edges: _edges,
      ...atlas
    } = createMemoryAtlas(graph.nodes, graph.edges, false);
    void _edges;
    this.onmessage?.({
      data: {
        atlas,
        nodeIds: nodes.map((n) => n.id),
        xyz: new Float32Array(nodes.length * 3).fill(done ? 2 : 1),
        done,
      },
    } as MessageEvent);
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  overview.mockReset();
  LayoutWorker.instances = [];
});

it("shows streamed positions before completion and retains them if the worker fails", async () => {
  vi.stubGlobal("Worker", LayoutWorker);
  const graph = syntheticMemoryGraph(8);
  overview.mockResolvedValue({ data: graph });
  const { result } = renderHook(() => useLargeMemoryGraph(true, "", 50000));
  await waitFor(() => expect(LayoutWorker.instances).toHaveLength(1));
  const worker = LayoutWorker.instances[0]!;
  act(() => worker.stream(graph));
  expect(result.current.state?.done).toBe(false);
  expect(result.current.state?.depth.get(graph.nodes[0]!.id)?.x).toBe(1);
  act(() => worker.onerror?.({ message: "lost worker" } as ErrorEvent));
  expect(result.current.error).toContain("lost worker");
  expect(result.current.state?.atlas.nodes).toHaveLength(8);
  expect(result.current.pending).toBe(false);
  expect(worker.terminate).toHaveBeenCalled();
});

it("ignores late streams after search, renderer-cap or tab changes", async () => {
  vi.stubGlobal("Worker", LayoutWorker);
  const graph = syntheticMemoryGraph(6);
  overview.mockResolvedValue({ data: graph });
  const { result, rerender } = renderHook(
    ({ enabled, query, limit }) => useLargeMemoryGraph(enabled, query, limit),
    { initialProps: { enabled: true, query: "old", limit: 50000 } },
  );
  await waitFor(() => expect(LayoutWorker.instances).toHaveLength(1));
  const old = LayoutWorker.instances[0]!;
  act(() => old.stream(graph));
  rerender({ enabled: true, query: "new", limit: 2000 });
  await waitFor(() => expect(LayoutWorker.instances).toHaveLength(2));
  act(() => old.stream(graph, true));
  expect(result.current.state).toBeNull();
  expect(old.terminate).toHaveBeenCalled();
  act(() => LayoutWorker.instances[1]!.stream(graph, true));
  expect(result.current.state).toMatchObject({
    query: "new",
    limit: 2000,
    done: true,
  });
  rerender({ enabled: false, query: "new", limit: 2000 });
  expect(result.current.state).toBeNull();
});

it("does not start a stale request's worker, and reports request errors", async () => {
  vi.stubGlobal("Worker", LayoutWorker);
  let finish!: (value: unknown) => void;
  overview
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockRejectedValueOnce(new Error("forbidden"));
  const { result, rerender } = renderHook(
    ({ query }) => useLargeMemoryGraph(true, query, 50000),
    { initialProps: { query: "old" } },
  );
  rerender({ query: "new" });
  await waitFor(() => expect(result.current.error).toBe("forbidden"));
  await act(async () => finish({ data: syntheticMemoryGraph(4) }));
  expect(LayoutWorker.instances).toHaveLength(0);
  expect(result.current.pending).toBe(false);
});
