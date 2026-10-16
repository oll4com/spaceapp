// Synthetic benchmark for the 3D memory graph (issue #62).
// CPU-only: no backend, no embeddings provider, no GPU required.
// Measures synthetic graph generation, layout streaming, picking from the
// spatial hash (acceptance gate: <= 4 ms per pick at 50k), the per-frame CPU
// cost of the WebGL path (projection + grid rebuild + bounded labels), and
// the overview payload size. Run: npx tsx scripts/benchmark-memory-graph.mjs
import { performance } from "node:perf_hooks";
import os from "node:os";
import { createSyntheticMemoryGraph } from "../apps/web/src/demo/synthetic-memory.js";
import { DEFAULT_MEMORY_CAMERA, layoutMemoryNetwork3DStream } from "../apps/web/src/features/memory-workspace/memory-3d.js";
import { buildHitGrid, hitTest, selectLabelNodes } from "../apps/web/src/features/memory-workspace/memory-graph-gl-attach.js";

const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

const results = [];
let failed = false;

for (const size of [2000, 10000, 50000]) {
  const t0 = performance.now();
  const graph = createSyntheticMemoryGraph(size);
  const genMs = performance.now() - t0;

  const nodes = graph.nodes;
  const edges = graph.edges;

  const t1 = performance.now();
  const iterator = layoutMemoryNetwork3DStream(nodes, edges);
  let result = iterator.next();
  let steps = 0;
  while (!result.done) {
    steps += 1;
    result = iterator.next();
  }
  const layoutMs = performance.now() - t1;
  const depth = result.value;

  const width = 1600;
  const height = 900;
  const screenX = new Float32Array(nodes.length);
  const screenY = new Float32Array(nodes.length);
  const screenRadius = new Float32Array(nodes.length);
  const screenValid = new Uint8Array(nodes.length);
  const extent = Math.max(60, ...[...depth.values()].map((p) => Math.hypot(p.x, p.y, p.z)));
  const scale = (Math.min(width, height) * 0.4) / extent;
  const validIndexes = [];
  const pointList = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const point = depth.get(nodes[index].id);
    if (!point) { screenValid[index] = 0; continue; }
    validIndexes.push(index);
    pointList.push(point);
  }
  // Mirrors the WebGL path exactly: extraction once per data change, then a
  // hoisted-trig projection loop per measured frame (no intermediate arrays).
  const cosYaw = Math.cos(DEFAULT_MEMORY_CAMERA.yaw), sinYaw = Math.sin(DEFAULT_MEMORY_CAMERA.yaw);
  const cosPitch = Math.cos(DEFAULT_MEMORY_CAMERA.pitch), sinPitch = Math.sin(DEFAULT_MEMORY_CAMERA.pitch);
  const zoomScale = scale * DEFAULT_MEMORY_CAMERA.zoom;
  let gridFresh = buildHitGrid(screenX, screenY, screenValid);
  void gridFresh;
  const projectAll = () => {
    for (let k = 0; k < validIndexes.length; k += 1) {
      const point = pointList[k];
      const x = point.x * cosYaw + point.z * sinYaw;
      const rotatedDepth = -point.x * sinYaw + point.z * cosYaw;
      const y = point.y * cosPitch - rotatedDepth * sinPitch;
      const z = point.y * sinPitch + rotatedDepth * cosPitch;
      const perspective = 650 / Math.max(120, 650 + z * scale);
      screenX[validIndexes[k]] = width / 2 + x * zoomScale * perspective;
      screenY[validIndexes[k]] = height / 2 - y * zoomScale * perspective;
      screenRadius[validIndexes[k]] = 2.1;
      screenValid[validIndexes[k]] = 1;
    }
  };
  projectAll();
  const grid = buildHitGrid(screenX, screenY, screenValid);

  // Picking gate: at most 4 ms per query at 50k nodes (issue #62).
  const pickSamples = [];
  for (let sample = 0; sample < 200; sample += 1) {
    const x = (sample * 977) % width;
    const y = (sample * 613) % height;
    const started = performance.now();
    hitTest(grid, nodes, screenX, screenY, screenRadius, screenValid, x, y);
    pickSamples.push(performance.now() - started);
  }
  const pickP95 = percentile(pickSamples, 0.95);

  // Per-frame CPU cost of the WebGL path: projection + spatial grid + bounded labels.
  const frameSamples = [];
  for (let frame = 0; frame < 30; frame += 1) {
    const started = performance.now();
    // Mirrors the live rotation frame: projection + bounded label selection.
    // The spatial hash is built lazily on hit queries, not per frame.
    projectAll();
    selectLabelNodes(nodes, screenValid, null, 1);
    frameSamples.push(performance.now() - started);
  }
  const frameP95 = percentile(frameSamples, 0.95);

  const t2 = performance.now();
  const payload = JSON.stringify({ nodes, edges });
  const payloadMs = performance.now() - t2;

  const row = {
    size,
    nodes: nodes.length,
    edges: edges.length,
    genMs: +genMs.toFixed(1),
    layoutMs: +layoutMs.toFixed(1),
    layoutSteps: steps,
    avgStepMs: +(layoutMs / 180).toFixed(3),
    pickP95Ms: +pickP95.toFixed(3),
    frameCpuP95Ms: +frameP95.toFixed(2),
    overviewPayloadKB: Math.round(payload.length / 1024),
    payloadStringifyMs: +payloadMs.toFixed(1)
  };
  results.push(row);
  console.log(JSON.stringify(row));
  if (size === 50000 && pickP95 > 4) {
    failed = true;
    console.log(`FAIL: pick p95 ${pickP95.toFixed(2)}ms exceeds the 4ms acceptance gate at 50k nodes`);
  }
  if (size === 50000 && frameP95 > 16.7) {
    failed = true;
    console.log(`FAIL: WebGL-path frame CPU p95 ${frameP95.toFixed(2)}ms exceeds the 16.7ms (60 fps) budget at 50k nodes`);
  }
}

console.log("");
console.log("Hardware (CPU): " + (os.cpus()[0]?.model ?? "n/a") + " x" + os.cpus().length + ", Node " + process.version);
if (failed) process.exit(1);