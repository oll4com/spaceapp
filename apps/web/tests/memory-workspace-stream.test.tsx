import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryGraphNode } from "@space/contracts";
import { api, type MemoryGraphOverviewResponse } from "../src/live-api.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { MemoryWorkspace } from "../src/features/memory-workspace/MemoryWorkspace.js";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";
import { referenceMemoryAtlas } from "../src/features/memory-workspace/memory-layout-stream.js";
import type { MemoryLayoutMessage, MemoryLayoutRequest } from "../src/features/memory-workspace/memory-layout-protocol.js";

vi.mock("../src/features/memory-workspace/DesktopMemoryGraph.js", () => ({ default: () => <div data-testid="2d-graph" /> }));
vi.mock("../src/features/memory-workspace/MemoryGraph3D.js", () => ({
  MemoryGraph3D: ({ nodes, coordinates, loading, layoutComplete }: {
    nodes: MemoryGraphNode[]; coordinates: Map<string, { x: number }>; loading: boolean; layoutComplete: boolean;
  }) => <div data-testid="3d-graph" data-nodes={nodes.length} data-loading={loading} data-complete={layoutComplete} data-first-x={coordinates.get("memory:a")?.x} />
}));

class LayoutWorker {
  static instances: LayoutWorker[] = [];
  onmessage: ((event: MessageEvent<MemoryLayoutMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn<(request: MemoryLayoutRequest) => void>();
  terminate = vi.fn();
  constructor() { LayoutWorker.instances.push(this); }
  emit(message: MemoryLayoutMessage) { this.onmessage?.({ data: message } as MessageEvent<MemoryLayoutMessage>); }
}
const nodes: MemoryGraphNode[] = [{ id: "memory:a", label: "A", type: "MEMORY", recordId: "a", sourcePath: null }];
function response(): MemoryGraphOverviewResponse {
  return { data: {
    version: 2, layoutVersion: 2, taxonomyVersion: 1, revisionHash: "c".repeat(64),
    generatedAt: "2026-10-19T00:00:00Z", sourceHash: "a".repeat(64),
    nodes, edges: [], months: [], totalMatchingNodes: 60000, totalMatchingEdges: 0, truncated: true,
    summary: { sourceCount: 0, recordCount: 60000, nodeCount: 1, edgeCount: 0, issueCount: 0 }, isStale: false,
    filters: { q: null, nodeType: null, scope: null, roomId: null, sourcePath: null, lifecycleStatus: null, relationMode: "RELATIONS" }
  } };
}
function atlas(worker: LayoutWorker, referenced = false) {
  const data = createMemoryAtlas(nodes, [], false);
  if (referenced) {
    const packed = referenceMemoryAtlas(data, { nodes, edges: [] });
    worker.emit(structuredClone({ kind: "atlas-references", atlas: packed.atlas }, { transfer: packed.transfer }));
  } else worker.emit({ kind: "atlas", atlas: { ...data, positions: [...data.positions] } });
}

beforeEach(() => {
  installSpaceRuntime(liveRuntime);
  LayoutWorker.instances = [];
  vi.stubGlobal("Worker", LayoutWorker);
  vi.spyOn(api, "memoryGraphOverview").mockImplementation(async () => response());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

describe("MemoryWorkspace streamed graph delivery", () => {
  it.each([false, true])("renders first geometry while relaxation continues and terminates only the completed worker (references=%s)", async referenced => {
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => {}} initialMode="atlas" />);
    await waitFor(() => expect(LayoutWorker.instances).toHaveLength(1));
    const twoD = LayoutWorker.instances[0]!;
    expect(twoD.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "layout", mode: "2d" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle 3D memory view" }));
    await waitFor(() => expect(LayoutWorker.instances).toHaveLength(2));
    const worker = LayoutWorker.instances[1]!;
    expect(twoD.terminate).toHaveBeenCalled();
    expect(screen.queryByTestId("2d-graph")).toBeNull();
    await act(async () => atlas(worker, referenced));
    expect(screen.getByTestId("3d-graph").dataset.loading).toBe("true");
    await act(async () => worker.emit({ kind: "depth", ids: ["memory:a"], coordinates: new Float32Array([1, 2, 3]), complete: false, step: 0 }));
    expect(screen.getByTestId("3d-graph").dataset.loading).toBe("false");
    expect(screen.getByTestId("3d-graph").dataset.firstX).toBe("1");
    expect(worker.terminate).not.toHaveBeenCalled();
    await act(async () => worker.emit({ kind: "depth", coordinates: new Float32Array([4, 5, 6]), complete: true, step: 180 }));
    expect(screen.getByTestId("3d-graph").dataset.firstX).toBe("4");
    expect(screen.getByTestId("3d-graph").dataset.complete).toBe("true");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("loads the full graph only on request in 3D and restores the default API limit in 2D", async () => {
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => {}} initialMode="atlas" />);
    await waitFor(() => expect(LayoutWorker.instances).toHaveLength(1));
    expect(api.memoryGraphOverview).toHaveBeenCalledWith({ q: undefined, month: "all", relationMode: "RELATIONS" });
    expect(screen.queryByRole("button", { name: /Load full graph/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle 3D memory view" }));
    fireEvent.click(screen.getByRole("button", { name: /Load full graph/ }));
    await waitFor(() => expect(api.memoryGraphOverview).toHaveBeenLastCalledWith({ q: undefined, month: "all", relationMode: "RELATIONS", limit: 50000 }));
    const stale = LayoutWorker.instances.at(-1)!;
    fireEvent.click(screen.getByRole("button", { name: "Toggle 3D memory view" }));
    await waitFor(() => expect(api.memoryGraphOverview).toHaveBeenLastCalledWith({ q: undefined, month: "all", relationMode: "RELATIONS" }));
    expect(screen.queryByTestId("3d-graph")).toBeNull();
    expect(stale.terminate).toHaveBeenCalled();
    // A queued message from a terminated old worker cannot replace the active graph.
    await act(async () => atlas(stale, true));
    expect(screen.queryByTestId("3d-graph")).toBeNull();
  });

  it("does not apply synthetic URL controls to a live account", async () => {
    window.history.replaceState({}, "", "/demo-workspace?memoryGraphNodes=50000");
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => {}} initialMode="atlas" />);
    await waitFor(() => expect(LayoutWorker.instances).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Toggle 3D memory view" }).getAttribute("aria-pressed")).toBe("false");
    expect(api.memoryGraphOverview).toHaveBeenCalledWith({ q: undefined, month: "all", relationMode: "RELATIONS" });
  });
});
