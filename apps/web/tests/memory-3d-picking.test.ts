import { describe, expect, it } from "vitest";
import type { MemoryGraphNode } from "@space/contracts";
import { createMemoryRenderModel, memoryNodeRadius } from "../src/features/memory-workspace/memory-3d-model.js";
import { MemorySpatialIndex } from "../src/features/memory-workspace/memory-3d-picking.js";
import { DEFAULT_MEMORY_CAMERA, projectMemoryPoint } from "../src/features/memory-workspace/memory-3d.js";

const node = (id: string): MemoryGraphNode => ({ id, type: "MEMORY", label: id, sourcePath: null, recordId: null });
describe("screen-space memory picking", () => {
  it("matches a depth-aware reference at multiple camera angles and cell boundaries", () => {
    const nodes = Array.from({ length: 512 }, (_, i) => node(String(i)));
    const coordinates = new Map(nodes.map((n, i) => [n.id, { x: Math.sin(i * 13.7) * 200, y: Math.cos(i * 3.1) * 200, z: Math.sin(i * 1.3) * 200 }]));
    const model = createMemoryRenderModel(nodes, [], new Map(), coordinates), index = new MemorySpatialIndex();
    for (const yaw of [0, 0.3, Math.PI / 2]) {
      const camera = { ...DEFAULT_MEMORY_CAMERA, yaw, zoom: 1.7 };
      index.rebuild(model, camera, 1000, 700, 12);
      const points = nodes.map((n, i) => ({ ...projectMemoryPoint(coordinates.get(n.id)!, camera, 700 * 0.4 / model.extent, 1000, 700), i, radius: memoryNodeRadius(n) }));
      for (let y = 3; y < 700; y += 17) for (let x = 3; x < 1000; x += 19) {
        let best = -1, depth = Infinity;
        for (const point of points) {
          const radius = Math.max(7, Math.max(1, point.radius * point.perspective * Math.sqrt(camera.zoom)) * (point.i === 12 ? 1.5 : 1) + 3);
          if ((point.x - x) ** 2 + (point.y - y) ** 2 <= radius ** 2 && point.z <= depth) { best = point.i; depth = point.z; }
        }
        expect(index.pick(x, y)).toBe(best);
      }
      expect(index.pick(-1, 10)).toBe(-1);
      expect(index.pick(1000, 10)).toBe(-1);
    }
  });
  it("finds the frontmost node among coincident points and refreshes changed geometry", () => {
    const model = createMemoryRenderModel([node("far"), node("near")], [], new Map(), new Map([["far", { x: 0, y: 0, z: 20 }], ["near", { x: 0, y: 0, z: -20 }]]));
    const index = new MemorySpatialIndex(), camera = { yaw: 0, pitch: 0, zoom: 1 };
    index.rebuild(model, camera, 1000, 700, -1);
    expect(index.pick(500, 350)).toBe(1);
    model.xyz[3] = 60; index.invalidate(); index.rebuild(model, camera, 1000, 700, -1);
    expect(index.pick(500, 350)).toBe(0);
    expect(index.pick(500, 350)).toBe(0);
  });
});
