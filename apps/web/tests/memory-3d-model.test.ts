import { describe, expect, it } from "vitest";
import type { MemoryGraphNode } from "@space/contracts";
import { createMemoryRenderModel, memoryLabelCandidates, MEMORY_LABEL_LIMIT, MEMORY_LABEL_CANDIDATES } from "../src/features/memory-workspace/memory-3d-model.js";
import { DEFAULT_MEMORY_CAMERA } from "../src/features/memory-workspace/memory-3d.js";

const node = (id: string, type: MemoryGraphNode["type"] = "MEMORY", label = id): MemoryGraphNode => ({ id, type, label, sourcePath: null, recordId: null });

describe("GPU memory graph model", () => {
  it("keeps GPU instance ids aligned with node ids and ignores dangling links", () => {
    const nodes = [node("a"), node("b")];
    const model = createMemoryRenderModel(nodes, [
      { id: "ab", source: "a", target: "b", type: "DERIVED_FROM" },
      { id: "missing", source: "a", target: "absent", type: "CONTAINS" }
    ], new Map(), new Map([["a", { x: 1, y: 2, z: 3 }], ["b", { x: -4, y: 5, z: 6 }]]));
    expect([...model.xyz]).toEqual([1, 2, 3, -4, 5, 6]);
    expect([...model.edgeIndices]).toEqual([0, 1]);
    expect([...model.edgeKinds]).toEqual([1]);
    expect(model.neighbors.get(0)).toEqual([1]);
    expect(model.neighbors.get(1)).toEqual([0]);
  });
  it("preserves source/core sizes and the atlas RGB palette", () => {
    const model = createMemoryRenderModel([node("root", "SOURCE", "space.md"), node("file", "SOURCE"), node("record")], [],
      new Map([["root", { x: 0, y: 0, color: "#fff0b0", hub: true, groupId: "core" }]]), new Map());
    expect(model.styles[3]).toBe(10);
    expect(model.styles[7]).toBeCloseTo(4.6);
    expect(model.styles[11]).toBeCloseTo(2.1);
    expect(model.styles[0]).toBe(1);
    expect(model.styles[1]).toBeCloseTo(240 / 255);
    expect(model.styles[2]).toBeCloseTo(176 / 255);
  });
  it("bounds label work at 50k nodes and always prioritizes a focused node", () => {
    const nodes = Array.from({ length: 50000 }, (_, i) => node(String(i), i < 500 ? "SOURCE" : "MEMORY"));
    nodes[49999] = node("core", "SOURCE", "space.md");
    const model = createMemoryRenderModel(nodes, [], new Map(), new Map());
    expect(model.labelCandidates).toHaveLength(MEMORY_LABEL_CANDIDATES);
    expect(model.labelCandidates[0]).toBe(49999);
    for (const zoom of [0.35, 1, 2, 5]) {
      const labels = memoryLabelCandidates(model, { ...DEFAULT_MEMORY_CAMERA, zoom }, 40000);
      expect(labels[0]).toBe(40000);
      expect(labels.length).toBeLessThanOrEqual(MEMORY_LABEL_LIMIT);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});
