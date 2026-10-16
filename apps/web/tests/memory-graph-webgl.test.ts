import { describe, expect, it, vi } from "vitest";
import { baseScaleFor, isWebGL2Supported, normalizePosition, shouldShowLabel } from "../src/features/memory-workspace/memory-graph-webgl.js";
import { MAX_GRAPH_LABELS_PER_FRAME, buildHitGrid, hitTest, selectLabelNodes } from "../src/features/memory-workspace/memory-graph-gl-attach.js";
import type { MemoryGraphNode } from "@space/contracts";

describe("WebGL memory graph pure helpers (issue #62)", () => {
  it("normalizes model positions into shader aPosition space", () => {
    expect(normalizePosition({ x: 0, y: 0, z: 0 }, 120)).toEqual([0, 0, 0]);
    expect(normalizePosition({ x: 60, y: -30, z: 120 }, 120)).toEqual([0.5, -0.25, 1]);
    expect(normalizePosition({ x: 3, y: 4, z: 5 }, 0)).toEqual([3000000, 4000000, 5000000]);
  });

  it("derives the pixels-per-model-unit scale and clamps tiny extents", () => {
    expect(baseScaleFor(800, 240)).toBeCloseTo((800 * 0.4) / 240);
    expect(baseScaleFor(800, 0)).toBeCloseTo((800 * 0.4) / 60);
    expect(baseScaleFor(800, 1200)).toBeCloseTo((800 * 0.4) / 1200);
  });

  it("keeps the 2D label LOD rules: sources, focus, core and deep zoom", () => {
    expect(shouldShowLabel("SOURCE", false, false, 0.5)).toBe(true);
    expect(shouldShowLabel("MEMORY", false, false, 1)).toBe(false);
    expect(shouldShowLabel("MEMORY", true, false, 0.5)).toBe(true);
    expect(shouldShowLabel("MEMORY", false, true, 0.5)).toBe(true);
    expect(shouldShowLabel("MEMORY", false, false, 1.6)).toBe(true);
    expect(shouldShowLabel("MEMORY", false, false, 1.59)).toBe(false);
  });

  it("probes WebGL2 on a throwaway canvas, never on the render canvas", () => {
    const originalCreate = document.createElement.bind(document);
    const probes: Array<{ getContext: (type: string) => unknown }> = [];
    const spy = vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (String(tag).toLowerCase() === "canvas") {
        const fake = { getContext: (type: string) => (type === "webgl2" ? { getExtension: () => null } : null) };
        probes.push(fake);
        return fake as unknown as HTMLCanvasElement;
      }
      return originalCreate(tag);
    }) as typeof document.createElement);
    try {
      expect(isWebGL2Supported()).toBe(true);
      expect(probes).toHaveLength(1);
      expect(isWebGL2Supported()).toBe(true); // repeated probes stay safe
    } finally {
      spy.mockRestore();
    }
    // jsdom canvases have no WebGL2: the fallback gate stays closed there.
    expect(isWebGL2Supported()).toBe(false);
  });

  it("picks the nearest node from the spatial grid in bounded time at 50k nodes", () => {
    const count = 50000;
    const nodes = Array.from({ length: count }, (_, index) => ({ id: `node:${index}` }));
    const screenX = new Float32Array(count);
    const screenY = new Float32Array(count);
    const screenRadius = new Float32Array(count);
    const screenValid = new Uint8Array(count).fill(1);
    for (let index = 0; index < count; index += 1) {
      screenX[index] = (index % 250) * 4 + 2;
      screenY[index] = Math.floor(index / 250) * 4 + 2;
      screenRadius[index] = 2.1;
    }
    const grid = buildHitGrid(screenX, screenY, screenValid);
    expect(hitTest(grid, nodes, screenX, screenY, screenRadius, screenValid, screenX[0]! + 1, screenY[0]!)).toBe("node:0");
    expect(hitTest(grid, nodes, screenX, screenY, screenRadius, screenValid, -10000, -10000)).toBeNull();
    const queries = Array.from({ length: 200 }, (_, index) => ({ x: (index * 37) % 1000 + 0.5, y: (index * 53) % 800 + 0.5 }));
    const started = performance.now();
    for (const point of queries) hitTest(grid, nodes, screenX, screenY, screenRadius, screenValid, point.x, point.y);
    const perPickMs = (performance.now() - started) / queries.length;
    expect(perPickMs).toBeLessThan(4); // acceptance: at most 4 ms per pick at 50k
  });

  it("bounds and prioritizes label candidates per frame", () => {
    const nodes: MemoryGraphNode[] = Array.from({ length: 50000 }, (_, index) => ({
      id: `mem:${index}`,
      type: "MEMORY",
      label: `Memory ${index}`,
      sourcePath: null,
      recordId: null
    }));
    const screenValid = new Uint8Array(50000).fill(1);
    const selected = selectLabelNodes(nodes, screenValid, "mem:7", 5);
    expect(selected).toHaveLength(MAX_GRAPH_LABELS_PER_FRAME);
    expect(selected[0]?.node.id).toBe("mem:7");
    const sources: MemoryGraphNode[] = Array.from({ length: 3 }, (_, index) => ({
      id: `source:${index}`,
      type: "SOURCE",
      label: `source-${index}.md`,
      sourcePath: null,
      recordId: null
    }));
    const valid = new Uint8Array(sources.length + nodes.length).fill(1);
    const quiet = selectLabelNodes([...sources, ...nodes], valid, null, 0.5);
    expect(quiet.map((entry) => entry.node.type)).toEqual(["SOURCE", "SOURCE", "SOURCE"]);
  });
});
