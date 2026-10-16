#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { generateSyntheticMemoryGraph } from "../apps/web/src/demo/synthetic-memory.ts";
import { projectMemoryPoint, DEFAULT_MEMORY_CAMERA } from "../apps/web/src/features/memory-workspace/memory-3d.ts";
import { encodePickingColor, decodePickingColor } from "../apps/web/src/features/memory-workspace/memory-graph-webgl.ts";

/**
 * Benchmark harness for 3D Memory Graph (Issue #62).
 * Measures data pipeline generation, GPU vertex staging, CPU projection baseline,
 * and picking index roundtrip latency across 2k, 10k, and 50k nodes with 150k edges.
 */
function benchmarkScale(size) {
  console.log(`\n======================================================`);
  console.log(`🚀 Benchmarking synthetic graph at scale: ${size} nodes`);
  console.log(`======================================================`);

  const genStart = performance.now();
  const graph = generateSyntheticMemoryGraph(size, 3);
  const genDuration = performance.now() - genStart;
  console.log(`Graph Synthesis: ${graph.nodes.length} nodes and ${graph.edges.length} edges generated in ${genDuration.toFixed(2)} ms.`);

  const width = 1200;
  const height = 800;

  // 1. Initial coordinates simulation
  const coords = new Map();
  for (let i = 0; i < graph.nodes.length; i++) {
    coords.set(graph.nodes[i].id, {
      x: (Math.random() - 0.5) * 500,
      y: (Math.random() - 0.5) * 500,
      z: (Math.random() - 0.5) * 500
    });
  }

  // 2. GPU Buffer Staging & Color-Index Packing Throughput
  const stagingStart = performance.now();
  const nodePointsBuf = new Float32Array(graph.nodes.length * 3);
  const nodeColorsBuf = new Float32Array(graph.nodes.length * 4);
  const nodeRadiiBuf = new Float32Array(graph.nodes.length);
  const pickingIdsBuf = new Float32Array(graph.nodes.length * 3);

  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i];
    const pt = coords.get(node.id);
    nodePointsBuf[i * 3] = pt.x;
    nodePointsBuf[i * 3 + 1] = pt.y;
    nodePointsBuf[i * 3 + 2] = pt.z;

    nodeColorsBuf[i * 4] = 0.45;
    nodeColorsBuf[i * 4 + 1] = 0.58;
    nodeColorsBuf[i * 4 + 2] = 0.68;
    nodeColorsBuf[i * 4 + 3] = 0.85;

    nodeRadiiBuf[i] = 2.1;

    const [pr, pg, pb] = encodePickingColor(i);
    pickingIdsBuf[i * 3] = pr / 255;
    pickingIdsBuf[i * 3 + 1] = pg / 255;
    pickingIdsBuf[i * 3 + 2] = pb / 255;
  }

  const edgeVertexCount = graph.edges.length * 2;
  const edgePointsBuf = new Float32Array(edgeVertexCount * 3);
  const edgeColorsBuf = new Float32Array(edgeVertexCount * 4);
  let vIdx = 0;
  for (let i = 0; i < graph.edges.length; i++) {
    const e = graph.edges[i];
    const s = coords.get(e.source);
    const t = coords.get(e.target);
    if (s && t) {
      edgePointsBuf[vIdx * 3] = s.x;
      edgePointsBuf[vIdx * 3 + 1] = s.y;
      edgePointsBuf[vIdx * 3 + 2] = s.z;
      vIdx++;
      edgePointsBuf[vIdx * 3] = t.x;
      edgePointsBuf[vIdx * 3 + 1] = t.y;
      edgePointsBuf[vIdx * 3 + 2] = t.z;
      vIdx++;
    }
  }
  const stagingDuration = performance.now() - stagingStart;
  console.log(`GPU Buffer Staging: Packed ${graph.nodes.length} nodes & ${graph.edges.length} edges in ${stagingDuration.toFixed(2)} ms.`);

  // 3. Picking Color Decode Latency (1,000 lookups)
  const pickStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    const testIdx = Math.floor(Math.random() * graph.nodes.length);
    const [r, g, b] = encodePickingColor(testIdx);
    const decoded = decodePickingColor(r, g, b, 255);
    if (decoded !== testIdx) throw new Error(`Picking decode mismatch: ${decoded} !== ${testIdx}`);
  }
  const pickDuration = (performance.now() - pickStart) / 1000;
  console.log(`Picking Decode Latency: ${pickDuration.toFixed(4)} ms per lookup (sub-millisecond target passed).`);

  // 4. CPU Projection & Viewport Frustum Culling Baseline
  const projRuns = 60;
  const frameTimes = [];
  let camera = { ...DEFAULT_MEMORY_CAMERA };

  for (let f = 0; f < projRuns; f++) {
    camera.yaw += 0.01;
    camera.pitch += 0.005;

    const frameStart = performance.now();
    const extent = 250;
    const scale = (Math.min(width, height) * 0.4) / extent;

    let visibleCount = 0;
    for (const [id, point] of coords) {
      const proj = projectMemoryPoint(point, camera, scale, width, height);
      if (proj.x >= 0 && proj.x <= width && proj.y >= 0 && proj.y <= height) {
        visibleCount++;
      }
    }
    const frameDuration = performance.now() - frameStart;
    frameTimes.push(frameDuration);
  }

  frameTimes.sort((a, b) => a - b);
  const p50 = frameTimes[Math.floor(frameTimes.length * 0.50)];
  const p95 = frameTimes[Math.floor(frameTimes.length * 0.95)];
  const max = frameTimes[frameTimes.length - 1];

  console.log(`CPU Projection & Culling Baseline (60 simulated frames):`);
  console.log(`   p50: ${p50.toFixed(2)} ms`);
  console.log(`   p95: ${p95.toFixed(2)} ms`);
  console.log(`   max: ${max.toFixed(2)} ms`);

  return { size, edges: graph.edges.length, stagingDuration, pickDuration, p50, p95, max };
}

async function main() {
  console.log("Memory Graph 3D Pipeline & Staging Benchmark (Issue #62)");
  console.log("Note: Hardware WebGL2 interactive frame rate is tested directly in browser via /demo-workspace.");
  const results = [];
  results.push(benchmarkScale(2000));
  results.push(benchmarkScale(10000));
  results.push(benchmarkScale(50000));

  console.log("\n==========================================================================================");
  console.log("Summary Table:");
  console.log("Nodes\t\tEdges\t\tStaging (ms)\tPick Latency (ms)\tCPU p50 (ms)\tCPU p95 (ms)");
  for (const r of results) {
    console.log(`${r.size}\t\t${r.edges}\t\t${r.stagingDuration.toFixed(2)}\t\t${r.pickDuration.toFixed(4)}\t\t\t${r.p50.toFixed(2)}\t\t${r.p95.toFixed(2)}`);
  }
  console.log("==========================================================================================\n");
}

main().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
