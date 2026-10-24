import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { projectMemoryPoint, DEFAULT_MEMORY_CAMERA } from "../src/features/memory-workspace/memory-3d.js";
import { depthNdc, hitRadius, layoutExtent, makeProjection, nodeAlpha, nodeRadius, projectInto, rotateByKey, wheelZoom, KIND_MEMORY, KIND_ROOT, KIND_SOURCE, STATE_DIM, STATE_NORMAL } from "../src/features/memory-workspace/memory-camera.js";
import { renderKindsOf, ScreenPicker } from "../src/features/memory-workspace/memory-picking.js";
import { createTextMeasurer, labelPriority, selectLabels, MAX_LABELS_DRAWN, MAX_LABEL_CANDIDATES } from "../src/features/memory-workspace/memory-labels.js";
import { buildAdjacency, buildMemoryScene, fillFocusStates, type MemoryScene } from "../src/features/memory-workspace/memory-scene.js";
import { chooseRenderer, probeWebGL2 } from "../src/features/memory-workspace/memory-renderer-select.js";
import { summarizeFrameTimes } from "../src/features/memory-workspace/memory-frame-stats.js";
import { volumeRatioFromArrays } from "../src/features/memory-workspace/memory-volume.js";
import { memory3DVolumeRatio } from "../src/features/memory-workspace/memory-3d.js";
import { MemoryGraph3D } from "../src/features/memory-workspace/MemoryGraph3D.js";
import { MemoryGraph3DStatic } from "../src/features/memory-workspace/MemoryGraph3DCanvas2D.js";
import { generateSyntheticMemoryGraph } from "../src/demo/synthetic-memory-graph.js";

const sceneOf = (size: number) => { const g = generateSyntheticMemoryGraph(size); return buildMemoryScene(g.nodes, g.edges).scene; };
const randomPositions = (count: number, seed = 1) => {
  let s = seed; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  return { x: Float64Array.from({ length: count }, () => r() * 200), y: Float64Array.from({ length: count }, () => r() * 200), z: Float64Array.from({ length: count }, () => r() * 200) };
};

describe("camera projection", () => {
  it("matches projectMemoryPoint exactly, applying zoom once", () => {
    const camera = { yaw: 0.8, pitch: -0.4, zoom: 2.3 };
    const projection = makeProjection(camera, 1000, 700, 150);
    const out = new Float64Array(4), point = { x: 45, y: -20, z: 60 };
    projectInto(projection, point.x, point.y, point.z, out);
    const expected = projectMemoryPoint(point, camera, projection.scale, 1000, 700);
    expect(out[0]).toBe(expected.x); expect(out[1]).toBe(expected.y); expect(out[2]).toBe(expected.z); expect(out[3]).toBe(expected.perspective);
    // doubling zoom doubles the offset from the center: it is not applied twice
    projectInto(makeProjection({ ...camera, zoom: camera.zoom * 2 }, 1000, 700, 150), point.x, point.y, point.z, out);
    expect(out[0]! - 500).toBeCloseTo((expected.x - 500) * 2, 9);
  });
  it("normalizes the extent once and keeps depth inside the clip range, nearer = smaller", () => {
    expect(layoutExtent([3], [4], [0], 1)).toBe(60);
    expect(layoutExtent([300], [400], [0], 1)).toBe(500);
    expect(depthNdc(-500, 500)).toBeLessThan(depthNdc(500, 500));
    expect(Math.abs(depthNdc(1e9, 500))).toBeLessThan(1);
    const scaleA = makeProjection(DEFAULT_MEMORY_CAMERA, 800, 600, 100).scale, scaleB = makeProjection(DEFAULT_MEMORY_CAMERA, 800, 600, 200).scale;
    expect(scaleA).toBeCloseTo(scaleB * 2, 12);
  });
  it("reproduces the node radius, alpha and hit radius of the Canvas 2D look", () => {
    expect(nodeRadius(KIND_ROOT, 1, 1, false)).toBe(10); expect(nodeRadius(KIND_SOURCE, 1, 4, false)).toBeCloseTo(9.2);
    expect(nodeRadius(KIND_MEMORY, 0.1, 1, false)).toBe(1); expect(nodeRadius(KIND_MEMORY, 1, 1, true)).toBeCloseTo(3.15);
    expect(nodeAlpha(STATE_DIM, true, 1)).toBe(0.2); expect(nodeAlpha(STATE_NORMAL, true, 0.1)).toBe(0.4); expect(nodeAlpha(STATE_DIM, false, 2)).toBe(1);
    expect(hitRadius(2)).toBe(7); expect(hitRadius(10)).toBe(13);
  });
  it("rotates by arrow keys and clamps wheel zoom", () => {
    const camera = { ...DEFAULT_MEMORY_CAMERA };
    expect(rotateByKey(camera, "ArrowLeft")).toBe(true); expect(camera.yaw).toBeCloseTo(DEFAULT_MEMORY_CAMERA.yaw - 0.15);
    rotateByKey(camera, "ArrowDown"); expect(camera.pitch).toBeCloseTo(DEFAULT_MEMORY_CAMERA.pitch + 0.15);
    expect(rotateByKey(camera, "a")).toBe(false);
    for (let i = 0; i < 100; i++) wheelZoom(camera, -500);
    expect(camera.zoom).toBe(5);
    for (let i = 0; i < 100; i++) wheelZoom(camera, 500);
    expect(camera.zoom).toBe(0.35);
  });
});

describe("screen-space picking", () => {
  const setup = (size = 2000) => {
    const scene = sceneOf(size), { x, y, z } = randomPositions(scene.count), kinds = renderKindsOf(scene);
    const projection = makeProjection(DEFAULT_MEMORY_CAMERA, 900, 600, layoutExtent(x, y, z, scene.count));
    const picker = new ScreenPicker(); picker.build(projection, x, y, z, scene.count, kinds);
    return { scene, x, y, z, kinds, projection, picker };
  };
  it("hits exactly the node under its own projected center (aligned with the shader projection)", () => {
    const { scene, x, y, z, projection, picker } = setup();
    const out = new Float64Array(4); let checked = 0;
    for (let i = 0; i < scene.count; i += 37) {
      projectInto(projection, x[i]!, y[i]!, z[i]!, out);
      const [sx, sy, depth] = [out[0]!, out[1]!, out[2]!];
      if (sx < 0 || sx > 900 || sy < 0 || sy > 600) continue;
      const hit = picker.pick(sx, sy);
      expect(hit).toBeGreaterThanOrEqual(0);
      projectInto(projection, x[hit]!, y[hit]!, z[hit]!, out);
      expect(out[2]).toBeLessThanOrEqual(depth); // the node itself, or one in front of it
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
  it("matches a brute-force nearest-to-camera scan", () => {
    const { scene, x, y, z, kinds, projection, picker } = setup();
    const out = new Float64Array(4);
    for (let t = 0; t < 300; t++) {
      const px = (t * 37) % 900, py = (t * 53) % 600;
      let best = -1, bestDepth = Infinity;
      for (let i = 0; i < scene.count; i++) {
        projectInto(projection, x[i]!, y[i]!, z[i]!, out);
        const r = hitRadius(nodeRadius(kinds[i]!, out[3]!, projection.zoom, false));
        if (Math.hypot(out[0]! - px, out[1]! - py) < r && out[2]! < bestDepth) { best = i; bestDepth = out[2]!; }
      }
      expect(picker.pick(px, py)).toBe(best);
    }
  });
  it("returns -1 away from every node and never scans linearly per pick", () => {
    const { picker } = setup(); expect(picker.pick(-500, -500)).toBe(-1);
    const scene = sceneOf(50_000), { x, y, z } = randomPositions(scene.count), kinds = renderKindsOf(scene);
    const projection = makeProjection(DEFAULT_MEMORY_CAMERA, 1200, 800, layoutExtent(x, y, z, scene.count));
    const big = new ScreenPicker(); big.build(projection, x, y, z, scene.count, kinds); // warm
    let start = performance.now(); big.build(projection, x, y, z, scene.count, kinds); const rebuildMs = performance.now() - start;
    start = performance.now(); for (let i = 0; i < 1000; i++) big.pick((i * 7) % 1200, (i * 13) % 800); const perPickMs = (performance.now() - start) / 1000;
    expect(perPickMs).toBeLessThan(0.5);
    expect(rebuildMs).toBeLessThan(40); // generous CI bound; the measured figure is reported separately
  }, 60_000);
});

describe("label level of detail", () => {
  const measure = createTextMeasurer(text => text.length * 6);
  const run = (size: number, zoom: number, extra: Partial<Parameters<typeof selectLabels>[0]> = {}) => {
    const scene = sceneOf(size), { x, y, z } = randomPositions(scene.count, 9);
    const projection = makeProjection({ ...DEFAULT_MEMORY_CAMERA, zoom }, 1200, 800, layoutExtent(x, y, z, scene.count));
    return { scene, ...selectLabels({ scene, priority: labelPriority(scene), projection, x, y, z, focus: -1, showTitles: true, measure, ...extra }) };
  };
  it("measures and draws a bounded number whatever the graph size, core and sources first", () => {
    for (const size of [2000, 50_000]) {
      const { scene, labels, measured } = run(size, 3);
      expect(measured).toBeLessThanOrEqual(MAX_LABEL_CANDIDATES);
      expect(labels.length).toBeLessThanOrEqual(MAX_LABELS_DRAWN);
      expect(labels.length).toBeGreaterThan(5);
      const kinds = labels.map(l => scene.kind[l.index]);
      const firstOrdinary = kinds.findIndex(k => k !== 0);
      if (firstOrdinary >= 0) expect(kinds.slice(firstOrdinary).every(k => k !== 0)).toBe(true); // no source after an ordinary node
    }
  });
  it("shows only sources below zoom 1.6, nothing without titles, and the focus first", () => {
    const low = run(2000, 1);
    expect(low.labels.every(l => low.scene.kind[l.index] === 0)).toBe(true);
    expect(run(2000, 3, { showTitles: false })).toMatchObject({ labels: [], measured: 0 });
    const scene = sceneOf(2000), focus = scene.ids.findIndex(id => id.startsWith("memory:"));
    expect(run(2000, 1, { focus, maxCandidates: 1000 }).labels.length).toBeGreaterThan(0);
  });
  it("never overlaps labels and caches measurements", () => {
    const { labels } = run(2000, 3);
    for (const a of labels) for (const b of labels) if (a !== b && Math.abs(a.y - b.y) < 16) expect(a.x + a.width + 5 <= b.x || b.x + b.width + 5 <= a.x).toBe(true);
    const spy = vi.fn((text: string) => text.length); const cached = createTextMeasurer(spy);
    cached("abc"); cached("abc"); expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("focus and renderer selection", () => {
  it("dims everything but the focus and its neighbours and clears with -1", () => {
    const scene = sceneOf(300), adjacency = buildAdjacency(scene), states = new Uint8Array(scene.count);
    const focus = scene.ids.findIndex(id => id.startsWith("memory:"));
    fillFocusStates(states, adjacency, focus);
    expect(states[focus]).toBe(2);
    const neighbors = new Set(Array.from(adjacency.neighbors.slice(adjacency.offsets[focus], adjacency.offsets[focus + 1])));
    for (let i = 0; i < scene.count; i++) if (i !== focus) expect(states[i]).toBe(neighbors.has(i) ? 3 : 1);
    fillFocusStates(states, adjacency, -1); expect(states.every(s => s === 0)).toBe(true);
  });
  it("falls back to Canvas 2D without support, after shader failure, or while the context is lost", () => {
    expect(chooseRenderer({ webgl2Supported: true, shaderFailed: false, contextLost: false })).toBe("webgl");
    expect(chooseRenderer({ webgl2Supported: false, shaderFailed: false, contextLost: false })).toBe("canvas2d");
    expect(chooseRenderer({ webgl2Supported: true, shaderFailed: true, contextLost: false })).toBe("canvas2d");
    expect(chooseRenderer({ webgl2Supported: true, shaderFailed: false, contextLost: true })).toBe("canvas2d");
  });
  it("probes WebGL2 on a throwaway canvas and releases its context", () => {
    const lose = vi.fn(), canvas = { getContext: vi.fn(() => ({ getExtension: () => ({ loseContext: lose }) })) } as unknown as HTMLCanvasElement;
    expect(probeWebGL2(() => canvas)).toBe(true); expect(lose).toHaveBeenCalled();
    expect(probeWebGL2(() => ({ getContext: () => null }) as unknown as HTMLCanvasElement)).toBe(false);
    expect(probeWebGL2(() => { throw new Error("no canvas"); })).toBe(false);
  });
  it("summarizes frame times and layout volume like the original helpers", () => {
    expect(summarizeFrameTimes(Array.from({ length: 100 }, (_, i) => i + 1))).toEqual({ frames: 100, p50: 50, p95: 95, max: 100 });
    expect(summarizeFrameTimes([])).toEqual({ frames: 0, p50: 0, p95: 0, max: 0 });
    const p = randomPositions(500, 5), points = Array.from({ length: 500 }, (_, i) => ({ x: p.x[i]!, y: p.y[i]!, z: p.z[i]! }));
    expect(volumeRatioFromArrays(p.x, p.y, p.z, 500)).toBeCloseTo(memory3DVolumeRatio(points), 6);
  });
});

describe("canvas attributes", () => {
  it("keeps the aria and data attributes without WebGL2 (jsdom), with the Canvas 2D fallback", () => {
    const { container } = render(<MemoryGraph3D stream={null} scene={null} showTitles selectedNodeId={null} onSelectNode={() => {}} loading resetToken={0} />);
    const canvas = container.querySelector("canvas")!;
    expect(container.querySelector(".memory-3d-surface")?.getAttribute("data-renderer")).toBe("canvas2d");
    expect(canvas.getAttribute("role")).toBe("application");
    expect(canvas.getAttribute("tabindex")).toBe("0");
    expect(canvas.getAttribute("aria-label")).toContain("3D memory graph");
    expect(canvas.getAttribute("aria-busy")).toBe("true");
    expect(canvas.getAttribute("data-titles-visible")).toBe("true");
    expect(canvas.getAttribute("data-layout-volume")).toBe("0.0000");
  });
  it("renders the static Canvas 2D view with the same attributes", () => {
    const { container } = render(<MemoryGraph3DStatic nodes={[]} edges={[]} positions={new Map()} coordinates={new Map()} showTitles={false} selectedNodeId={null} onSelectNode={() => {}} loading={false} resetToken={0} />);
    const canvas = container.querySelector("canvas")!;
    expect(canvas.getAttribute("aria-busy")).toBe("false");
    expect(canvas.getAttribute("data-titles-visible")).toBe("false");
    expect(canvas.getAttribute("data-layout-volume")).toBe("0.0000");
  });
});
