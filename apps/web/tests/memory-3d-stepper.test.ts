import { describe, expect, it } from "vitest";
import { createMemoryNetworkLayout3D, layoutMemoryNetwork3D } from "../src/features/memory-workspace/memory-3d.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

function fixture() {
  // The pinned root is the agent core file (`space.md` / legacy `gemini.md`), not the
  // `space_memory.md` index — `isMemoryCoreLabel` only matches the former.
  const nodes: MemoryGraphNode[] = [{ id: "root", label: "space.md", type: "SOURCE", sourcePath: "/mem/space.md", recordId: null }];
  const edges: MemoryGraphEdge[] = [];
  for (let file = 0; file < 10; file++) {
    const id = `source-${file}`;
    nodes.push({ id, label: `${id}.md`, type: "SOURCE", sourcePath: `/mem/${id}.md`, recordId: null });
    edges.push({ id: `file-${file}`, type: "DERIVED_FROM", source: "root", target: id });
    for (let item = 0; item < 12; item++) {
      const memory = `${id}-memory-${item}`;
      nodes.push({ id: memory, label: memory, type: "MEMORY", sourcePath: `/mem/${id}.md`, recordId: memory });
      edges.push({ id: memory, type: "CONTAINS", source: id, target: memory });
    }
  }
  return { nodes, edges };
}

describe("incremental 3D layout", () => {
  it("stepping in chunks reaches exactly the same result as one full run", () => {
    const { nodes, edges } = fixture();
    const full = layoutMemoryNetwork3D(nodes, edges);

    const stepper = createMemoryNetworkLayout3D(nodes, edges);
    expect(stepper.totalSteps).toBe(180);
    expect(stepper.completedSteps).toBe(0);

    let guard = 0;
    while (stepper.completedSteps < stepper.totalSteps && guard < 1000) {
      stepper.runSteps(17);          // deliberately not a divisor of 180
      guard += 1;
    }
    expect(stepper.completedSteps).toBe(180);

    const stepped = stepper.snapshot();
    expect(stepped.size).toBe(full.size);
    for (const [id, point] of full) {
      const other = stepped.get(id);
      expect(other).toBeDefined();
      expect(other!.x).toBeCloseTo(point.x, 9);
      expect(other!.y).toBeCloseTo(point.y, 9);
      expect(other!.z).toBeCloseTo(point.z, 9);
    }
  });

  it("yields usable intermediate positions and keeps the root pinned", () => {
    const { nodes, edges } = fixture();
    const stepper = createMemoryNetworkLayout3D(nodes, edges);
    stepper.runSteps(45);
    const mid = stepper.snapshot();
    expect(mid.size).toBe(nodes.length);
    expect(mid.get("root")).toEqual({ x: 0, y: 0, z: 0 });
    // A partial layout must already be spread out, otherwise streaming it would show a dot.
    const radii = [...mid.values()].map(p => Math.hypot(p.x, p.y, p.z));
    expect(Math.max(...radii)).toBeGreaterThan(1);
  });

  it("running past the end is a no-op, not an error", () => {
    const { nodes, edges } = fixture();
    const stepper = createMemoryNetworkLayout3D(nodes, edges);
    stepper.runSteps(500);
    expect(stepper.completedSteps).toBe(180);
    expect(stepper.runSteps(10)).toBe(0);
  });

  it("snapshots are stable between steps when nothing advanced", () => {
    const { nodes, edges } = fixture();
    const stepper = createMemoryNetworkLayout3D(nodes, edges);
    stepper.runSteps(30);
    const first = stepper.snapshot();
    const second = stepper.snapshot();
    expect(second).toBe(first);      // cached: no extra allocation per frame
  });
});
