import { describe, expect, it } from "vitest";
import type { MemoryGraphNode } from "@space/contracts";
import { projectMemoryPoint } from "../src/features/memory-workspace/memory-3d.js";
import { MemoryPickIndex } from "../src/features/memory-workspace/memory-pick-index.js";

const camera = { yaw: 0, pitch: 0, zoom: 1 };
const sceneFor = (points: Array<[number, number, number, number]>, extent = 100) => ({
  nodes: points.map((_, index): MemoryGraphNode => ({
    id: `node:${index}`, type: "MEMORY", label: String(index), recordId: `node:${index}`, sourcePath: null
  })),
  coordinates: new Float32Array(points.flat()), extent
});

describe("indexed memory graph picking", () => {
  it("matches rotated, zoomed perspective projection rather than unrotated world coordinates", () => {
    const scene = sceneFor([[45, -25, 30, 4.6]]);
    const view = { yaw: 0.8, pitch: -0.45, zoom: 1.7 };
    const point = projectMemoryPoint({ x: 45, y: -25, z: 30 }, view, 600 * 0.4 / scene.extent, 800, 600);
    const index = new MemoryPickIndex();
    index.update(scene, view, 800, 600, 0);
    expect(index.pick(point.x, point.y)).toBe(0);
    expect(index.pick(400, 300)).toBe(-1);
  });

  it("uses circular minimum hit targets and expanded focus targets across cell boundaries", () => {
    const index = new MemoryPickIndex(), scene = sceneFor([[0, 0, 0, 10]]);
    index.update(scene, camera, 200, 200, 0);
    expect(index.pick(113, 100)).toBe(0);
    expect(index.pick(114, 100)).toBe(-1);
    expect(index.pick(118, 100, 0)).toBe(0);
    expect(index.pick(118.1, 100, 0)).toBe(-1);
    expect(index.update(scene, camera, 200, 200, 0)).toBe(false);
    const small = sceneFor([[0, 0, 0, 1]]);
    index.update(small, camera, 128, 128, 0); // The disk crosses four grid cells.
    expect(index.pick(57, 64)).toBe(0);
    expect(index.pick(71, 64)).toBe(0);
    expect(index.pick(64, 57)).toBe(0);
    expect(index.pick(64, 71)).toBe(0);
    expect(index.pick(70, 70)).toBe(-1); // Inside the bounding square, outside the disk.
  });

  it("selects frontmost depth, with later instances winning equal or clamped depth", () => {
    const index = new MemoryPickIndex();
    index.update(sceneFor([[0, 0, -20, 2.1], [0, 0, 20, 2.1]]), camera, 200, 200, 0);
    expect(index.pick(100, 100)).toBe(0);
    index.update(sceneFor([[0, 0, 20, 2.1], [0, 0, -20, 2.1], [0, 0, -20, 2.1]]), camera, 200, 200, 0);
    expect(index.pick(100, 100)).toBe(2);
    index.update(sceneFor([[0, 0, -5000, 2.1], [0, 0, -3000, 2.1]]), camera, 200, 200, 0);
    expect(index.pick(100, 100)).toBe(1); // Both depths are clamped to -0.99 by the shader.
  });

  it("includes disks intersecting viewport edges but rejects pointers outside the canvas", () => {
    const index = new MemoryPickIndex();
    index.update(sceneFor([[-130, 0, 0, 2.1], [130, 0, 0, 2.1], [0, 130, 0, 2.1], [0, -130, 0, 2.1]]), camera, 100, 100, 0);
    expect(index.pick(0, 50)).toBe(0);
    expect(index.pick(100, 50)).toBe(1);
    expect(index.pick(50, 0)).toBe(2);
    expect(index.pick(50, 100)).toBe(3);
    for (const [x, y] of [[-0.1, 50], [100.1, 50], [50, -0.1], [50, 100.1], [NaN, 50]]) expect(index.pick(x!, y!)).toBe(-1);
    // Exact tangency at a viewport edge that is also a grid boundary remains hittable.
    index.update(sceneFor([[138.671875, 0, 0, 1], [0, -138.671875, 0, 1]]), camera, 128, 128, 0);
    expect(index.pick(128, 64)).toBe(0);
    expect(index.pick(64, 128)).toBe(1);
  });

  it("invalidates old geometry for scene replacement, coordinate revisions, camera and viewport changes", () => {
    const index = new MemoryPickIndex(), scene = sceneFor([[0, 0, 0, 2.1]]);
    expect(index.update(scene, camera, 200, 200, 0)).toBe(true);
    expect(index.update(scene, { ...camera }, 200, 200, 0)).toBe(false);
    scene.coordinates[0] = 50;
    index.invalidate();
    expect(index.pick(100, 100)).toBe(-1);
    expect(index.update(scene, camera, 200, 200, 1)).toBe(true);
    expect(index.pick(100, 100)).toBe(-1);
    expect(index.pick(140, 100)).toBe(0);
    expect(index.update(scene, { ...camera, yaw: Math.PI }, 200, 200, 1)).toBe(true);
    expect(index.pick(60, 100)).toBe(0);
    expect(index.pick(140, 100)).toBe(-1);
    expect(index.update(scene, camera, 400, 200, 1)).toBe(true);
    expect(index.pick(240, 100)).toBe(0);
    expect(index.pick(140, 100)).toBe(-1);
    expect(index.update(sceneFor([]), camera, 400, 200, 1)).toBe(true);
    expect(index.pick(240, 100)).toBe(-1);
    index.dispose();
    expect(index.pick(240, 100)).toBe(-1);
  });

  it("reuses projected data for repeated 50k pointer queries without rereading graph coordinates", () => {
    const points = Array.from({ length: 50000 }, (_, i): [number, number, number, number] =>
      [(i % 250) - 125, Math.floor(i / 250) - 100, (i % 7) * 2, 2.1]);
    const scene = sceneFor(points, 180), values = scene.coordinates;
    let coordinateReads = 0;
    scene.coordinates = new Proxy(values, { get(target, key) {
      if (typeof key === "string" && /^\d+$/.test(key)) coordinateReads++;
      return Reflect.get(target, key, target);
    } });
    const index = new MemoryPickIndex();
    index.update(scene, camera, 1200, 800, 0);
    expect(coordinateReads).toBeGreaterThanOrEqual(50000 * 4);
    coordinateReads = 0;
    for (let i = 0; i < 100; i++) {
      expect(index.update(scene, camera, 1200, 800, 0)).toBe(false);
      expect(index.pick(600, 400, i)).toBeGreaterThanOrEqual(0);
    }
    expect(coordinateReads).toBe(0);
  });

  it("omits invalid coordinates and never returns stale candidates after a rebuild", () => {
    const index = new MemoryPickIndex(), scene = sceneFor([[0, 0, 0, 2.1], [NaN, 0, 0, 2.1]]);
    index.update(scene, camera, 200, 200, 0);
    expect(index.pick(100, 100)).toBe(0);
    scene.coordinates[0] = Infinity;
    index.update(scene, camera, 200, 200, 1);
    expect(index.pick(100, 100)).toBe(-1);
  });
});
