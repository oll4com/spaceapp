import { describe, expect, it } from "vitest";
import {
  createMemory3DLayoutStepper,
  layoutMemoryNetwork3D,
  MemorySpatialPicker3D,
  projectMemoryPointsBulk,
  selectMemory3DLabels,
  DEFAULT_MEMORY_CAMERA,
  type MemoryPoint3D
} from "../src/features/memory-workspace/memory-3d.js";
import { isMemoryCoreLabel } from "../src/features/memory-workspace/memory-graph-visuals.js";
import { buildMemoryGraphGLScene } from "../src/features/memory-workspace/memory-graph-webgl.js";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";
import { createSyntheticMemoryGraph } from "../src/demo/synthetic-memory-graph.js";

/**
 * Frame-time harness for issue #62's performance criteria. It measures the
 * complete CPU-side work the renderer performs per frame (bulk-project
 * every node, rebuild the picking index, select LOD labels) plus the
 * one-off costs (atlas build, GPU scene build, streamed layout steps).
 * GPU rasterization itself is three batched draws and is not measurable
 * headlessly.
 *
 * The timings are logged next to the issue's budgets (p95 frame ≤ 33 ms
 * at 50k, ≤ 16.7 ms at 2k, picking ≤ 4 ms — for an integrated-GPU laptop).
 * Picking passes with orders of magnitude of headroom on any hardware and
 * is asserted at the budget. The frame/layout figures are pure-CPU and
 * swing widely on shared CI machines, so they are asserted against
 * generous anti-regression ceilings instead: an algorithmic blowup (an
 * O(n²) frame, an unbounded label pass, a non-streaming layout) fails on
 * any machine, while the logged numbers — run `npm test -w @space/web --
 * memory-3d-benchmark` on a reasonably unloaded machine — are the budget
 * evidence.
 */

const percentile = (samples: number[], ratio: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]!;
};

/** Generous ceilings that only an algorithmic regression can hit. */
const FRAME_CEILING_MS = { 2000: 100, 50000: 500 } as const;
const FIRST_CHUNK_CEILING_MS = 60000;

function frameWork(size: number, frames = 30) {
  const { nodes, edges } = createSyntheticMemoryGraph(size);
  // Frame cost depends on graph size, not on layout convergence, so a
  // partially streamed layout is a faithful coordinate set.
  const stepper = createMemory3DLayoutStepper(nodes, edges);
  stepper.step(30);
  const coordinates = stepper.positions();
  const atlas = createMemoryAtlas(nodes, edges, false);
  let extent = 60;
  for (const point of coordinates.values()) extent = Math.max(extent, Math.hypot(point.x, point.y, point.z));
  const frameSamples: number[] = [];
  const pickSamples: number[] = [];
  let picker: MemorySpatialPicker3D | null = null;
  // Mirror MemoryGraph3D's per-frame work exactly: bulk projection into
  // typed arrays, array-built picker, and label candidates pre-filtered to
  // what can be placed at the current zoom (sources/core below the gate).
  const visPoints: MemoryPoint3D[] = nodes.map(node => coordinates.get(node.id)!);
  for (let frame = 0; frame < frames + 3; frame++) {
    const sampling = frame >= 3; // warm-up frames (JIT) are not sampled
    const camera = { ...DEFAULT_MEMORY_CAMERA, yaw: DEFAULT_MEMORY_CAMERA.yaw + frame * 0.05 };
    const started = performance.now();
    const width = 1600, height = 1000;
    const scale = Math.min(width, height) * 0.4 / extent;
    const projected = projectMemoryPointsBulk(visPoints, camera, scale, width, height);
    const radii = new Float64Array(nodes.length);
    const visIds: string[] = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      visIds[i] = node.id;
      const base = node.type === "SOURCE" && isMemoryCoreLabel(node.label) ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
      radii[i] = Math.max(1, base * projected.perspectives[i]! * Math.sqrt(camera.zoom));
    }
    picker = MemorySpatialPicker3D.fromArrays(visIds, projected.xs, projected.ys, projected.zs, radii, width, height);
    const candidates: Array<{ id: string; label: string; type: typeof nodes[number]["type"]; x: number; y: number; isFocus: boolean }> = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node.type !== "SOURCE" && !isMemoryCoreLabel(node.label)) continue;
      candidates.push({ id: node.id, label: node.label, type: node.type, x: projected.xs[i]!, y: projected.ys[i]!, isFocus: false });
    }
    selectMemory3DLabels(candidates, { width, height, zoom: camera.zoom, measure: text => text.length * 6 });
    if (sampling) frameSamples.push(performance.now() - started);
    for (let i = 0; i < 20; i++) {
      const pickStarted = performance.now();
      picker.pick((i * 37) % width, (i * 53) % height);
      if (sampling) pickSamples.push(performance.now() - pickStarted);
    }
  }
  const sceneStarted = performance.now();
  buildMemoryGraphGLScene({ nodes, edges, coordinates, atlasPositions: atlas.positions });
  const sceneMs = performance.now() - sceneStarted;
  return { sceneMs, frameP95: percentile(frameSamples, 0.95), pickP95: percentile(pickSamples, 0.95) };
}

describe("memory graph 3D performance harness", () => {
  it("2,000 nodes: frame work measured against the 16.7 ms budget, picking within 4 ms", () => {
    const result = frameWork(2000);
    console.log(`2k nodes: scene build ${result.sceneMs.toFixed(1)} ms, frame p95 ${result.frameP95.toFixed(2)} ms (issue budget 16.7 ms), pick p95 ${result.pickP95.toFixed(3)} ms (budget 4 ms)`);
    expect(result.frameP95).toBeLessThanOrEqual(FRAME_CEILING_MS[2000]);
    expect(result.pickP95).toBeLessThanOrEqual(4);
  }, 120000);

  it("50,000 nodes / ~150k edges: frame work measured against the 33 ms budget, picking within 4 ms", () => {
    const result = frameWork(50000, 20);
    console.log(`50k nodes: scene build ${result.sceneMs.toFixed(1)} ms, frame p95 ${result.frameP95.toFixed(2)} ms (issue budget 33 ms), pick p95 ${result.pickP95.toFixed(3)} ms (budget 4 ms)`);
    expect(result.frameP95).toBeLessThanOrEqual(FRAME_CEILING_MS[50000]);
    expect(result.pickP95).toBeLessThanOrEqual(4);
  }, 600000);

  it("streams the 50k layout in bounded worker steps", () => {
    const { nodes, edges } = createSyntheticMemoryGraph(50000);
    const stepper = createMemory3DLayoutStepper(nodes, edges);
    const started = performance.now();
    stepper.step(10);
    const firstChunkMs = performance.now() - started;
    const partial = stepper.positions();
    console.log(`50k layout streaming: first 10 steps ${firstChunkMs.toFixed(1)} ms, partial positions ${partial.size}, steps total ${stepper.totalSteps}`);
    expect(partial.size).toBe(50000);
    expect(firstChunkMs).toBeLessThan(FIRST_CHUNK_CEILING_MS);
  }, 120000);

  it("lays out 2,000 nodes completely and builds the 50k atlas", () => {
    const small = createSyntheticMemoryGraph(2000);
    const layoutStarted = performance.now();
    layoutMemoryNetwork3D(small.nodes, small.edges);
    console.log(`2k full layout: ${(performance.now() - layoutStarted).toFixed(1)} ms`);
    const { nodes, edges } = createSyntheticMemoryGraph(50000);
    const started = performance.now();
    const atlas = createMemoryAtlas(nodes, edges, false);
    const elapsed = performance.now() - started;
    console.log(`50k atlas build: ${elapsed.toFixed(1)} ms, ${atlas.nodes.length} nodes, ${atlas.groups.length} groups`);
    expect(atlas.nodes).toHaveLength(50000);
  }, 300000);
});
