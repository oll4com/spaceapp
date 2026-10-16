import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

type WorkerMessage = {
  type?: string;
  step?: number;
  totalSteps?: number;
  positions?: Array<[string, { x: number; y: number }]>;
  depth?: Array<[string, { x: number; y: number; z: number }]>;
  coordinates?: Array<[string, { x: number; y: number; z: number }]>;
};

const fixture = () => {
  const nodes: MemoryGraphNode[] = [{ id: "root", label: "gemini.md", type: "SOURCE", sourcePath: "/opt/spaceapp/docs/gemini.md", recordId: null }];
  const edges: MemoryGraphEdge[] = [];
  for (let file = 0; file < 4; file += 1) {
    const source = `source-${file}`;
    nodes.push({ id: source, label: `${source}.md`, type: "SOURCE", sourcePath: `/opt/spaceapp/docs/${source}.md`, recordId: null });
    edges.push({ id: `derived-${file}`, type: "DERIVED_FROM", source: "root", target: source });
    for (let item = 0; item < 6; item += 1) {
      const memory = `${source}-memory-${item}`;
      nodes.push({ id: memory, label: memory, type: "MEMORY", sourcePath: `/opt/spaceapp/docs/${source}.md`, recordId: memory });
      edges.push({ id: `contains-${file}-${item}`, type: "CONTAINS", source, target: memory });
    }
  }
  return { nodes, edges };
};

describe("memory layout worker protocol (issue #62)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("streams progress (with periodic position snapshots) and finishes with positions + depth", async () => {
    const posted: WorkerMessage[] = [];
    vi.stubGlobal("self", {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: WorkerMessage) => { posted.push(message); }
    });
    await import("../src/features/memory-workspace/memory-network-layout.worker.js");
    const worker = (globalThis as unknown as { self: { onmessage: ((event: { data: unknown }) => void) | null } }).self;
    expect(typeof worker.onmessage).toBe("function");

    const { nodes, edges } = fixture();
    worker.onmessage!({ data: { nodes, edges } });

    const progress = posted.filter((message) => message.type === "layout-progress");
    expect(progress.length).toBe(8); // 180 steps, snapshot every 24th
    const steps = progress.map((message) => message.step!);
    expect(steps).toEqual([24, 48, 72, 96, 120, 144, 168, 180]);
    expect(progress.every((message) => message.totalSteps === 180)).toBe(true);

    // Position snapshots ride along on every third tick so the view refines
    // while the simulation converges.
    const withCoordinates = progress.filter((message) => message.coordinates);
    expect(withCoordinates.map((message) => message.step)).toEqual([72, 144]);
    for (const message of withCoordinates) expect(message.coordinates!.length).toBe(nodes.length);

    const final = posted[posted.length - 1]!;
    expect(final.type).toBeUndefined();
    expect(final.positions!.length).toBe(nodes.length);
    expect(final.depth!.length).toBe(nodes.length);
    expect(final.positions![0]![1]).not.toHaveProperty("z"); // 2D atlas coordinates
    expect(final.depth![0]![1]).toHaveProperty("z"); // 3D coordinates
  });
});
