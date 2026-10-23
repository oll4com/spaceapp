import { describe, expect, it } from "vitest";
import {
  MemoryLayout3DSimulation,
  MemoryPickIndex,
  collectMemoryLabelCandidates,
  memoryNodeRadius,
  projectMemoryPoints,
  selectMemoryLabels,
  DEFAULT_MEMORY_CAMERA
} from "../src/features/memory-workspace/memory-3d.js";
import { generateSyntheticMemoryGraph } from "../src/demo/synthetic-memory-graph.js";

/**
 * Frame-time harness for the 3D memory graph acceptance criteria. It
 * measures the renderer's full CPU-side share of a frame — batch projection,
 * radius computation, pick-index rebuild, and label LOD selection — over
 * simulated rotating/zooming frames, plus picking latency and layout time.
 * The label step runs the component's real path: collectMemoryLabelCandidates
 * scans every node of the frame (the same helper drawLabels uses), so the
 * numbers cover candidate construction as well as selection.
 * GPU rasterization itself is two draw calls (instanced nodes, batched
 * edges); on an integrated-GPU laptop the CPU share measured here is the
 * part that must stay well inside the 33 ms p95 budget.
 *
 * Run with: npm test -w @space/web -- memory-3d-benchmark
 * Hardware: whatever machine runs the suite — recorded in the PR.
 */

const SIZES = [2_000, 10_000, 50_000];
const WIDTH = 1440;
const HEIGHT = 900;

/**
 * Nearest-rank percentile of a sorted sample set (p50/p95 frame-time math).
 * @param samples Frame-time samples in milliseconds.
 * @param ratio Percentile as a 0..1 fraction.
 * @returns The sample at that percentile.
 */
function percentile(samples: number[], ratio: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]!;
}

describe("3D memory graph frame-time harness", () => {
  for (const size of SIZES) {
    it(`measures CPU frame cost and picking at ${size.toLocaleString()} nodes`, () => {
      const { nodes, edges } = generateSyntheticMemoryGraph(size);
      const layoutStart = performance.now();
      const simulation = new MemoryLayout3DSimulation(nodes, edges);
      simulation.step(Number.POSITIVE_INFINITY);
      const layoutMs = performance.now() - layoutStart;
      const positions = simulation.positionsArray();
      // Label candidates are collected from the nodes in simulation order,
      // aligned with the projected points, exactly as the component does.
      const nodeById = new Map(nodes.map(node => [node.id, node]));
      const alignedNodes = simulation.nodeIds.map(id => nodeById.get(id)!);
      const extent = Math.max(60, ...Array.from({ length: size }, (_, i) =>
        Math.hypot(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!)));
      const scale = Math.min(WIDTH, HEIGHT) * 0.4 / extent;
      const frameSamples: number[] = [];
      const pickSamples: number[] = [];
      const frames = 40;
      let projected: Float32Array<ArrayBufferLike> = new Float32Array(0);
      const pickIndex = new MemoryPickIndex();
      for (let frame = 0; frame < frames; frame++) {
        const camera = {
          yaw: DEFAULT_MEMORY_CAMERA.yaw + frame * 0.05,
          pitch: DEFAULT_MEMORY_CAMERA.pitch + Math.sin(frame * 0.1) * 0.1,
          zoom: 1 + (frame % 10) * 0.08
        };
        const start = performance.now();
        projected = projectMemoryPoints(positions, camera, scale, WIDTH, HEIGHT);
        const radii = new Float32Array(size);
        for (let i = 0; i < size; i++) {
          radii[i] = memoryNodeRadius(2.1, projected[i * 4 + 3]!, camera.zoom, false);
        }
        pickIndex.rebuild(projected, radii);
        const labelCandidates = collectMemoryLabelCandidates(alignedNodes, projected, { zoom: camera.zoom });
        selectMemoryLabels(labelCandidates, {
          zoom: camera.zoom, width: WIDTH, height: HEIGHT, measure: text => text.length * 6
        });
        frameSamples.push(performance.now() - start);
        const pickStart = performance.now();
        pickIndex.pick(WIDTH / 2 + (frame % 7) * 13, HEIGHT / 2 + (frame % 5) * 17, projected, radii);
        pickSamples.push(performance.now() - pickStart);
      }
      const frameP95 = percentile(frameSamples, 0.95);
      const pickP95 = percentile(pickSamples, 0.95);
      console.info(
        `[memory-3d-benchmark] nodes=${size} edges=${edges.length} layoutMs=${layoutMs.toFixed(1)} ` +
        `cpuFrameP95Ms=${frameP95.toFixed(3)} pickP95Ms=${pickP95.toFixed(3)}`
      );
      // Acceptance: picking at most 4 ms; frame budget 33 ms p95 at 50k
      // (16.7 ms at 2k) for the full frame — the CPU share must leave the
      // GPU ample headroom inside it.
      expect(pickP95).toBeLessThan(4);
      if (size === 50_000) expect(frameP95).toBeLessThan(33);
      if (size === 2_000) expect(frameP95).toBeLessThan(16.7);
    }, 300_000);
  }
});
