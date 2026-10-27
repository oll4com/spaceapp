import type { MemoryCamera3D, MemoryPoint3D } from "../features/memory-workspace/memory-3d.js";
import { projectMemoryPoint } from "../features/memory-workspace/memory-3d.js";
import { generateSyntheticMemoryDataset, type SyntheticGraphScale } from "./synthetic-memory-graph.js";

export interface FrameBenchmarkResult {
  scale: string;
  nodeCount: number;
  edgeCount: number;
  frameCount: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  fpsMean: number;
  fpsP95: number;
  targetP95Ms: number;
  passed: boolean;
}

export interface FullBenchmarkSuiteReport {
  results: FrameBenchmarkResult[];
  timestamp: string;
  hardwareSummary: string;
  markdownTable: string;
}

/**
 * Calculates percentiles from recorded latency numbers.
 */
export function calculatePercentile(samples: number[], percentile: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index]!;
}

/**
 * Simulates camera motion (continuous 360-degree yaw rotation, pitch oscillation, and zoom oscillation).
 */
export function getBenchmarkCameraForFrame(frameIndex: number, totalFrames: number): MemoryCamera3D {
  const progress = frameIndex / Math.max(1, totalFrames);
  // Full 360 turn
  const yaw = progress * Math.PI * 2;
  // Gentle pitch oscillation between -0.4 and 0.4 rad
  const pitch = Math.sin(progress * Math.PI * 4) * 0.4;
  // Zoom oscillation between 0.8 and 2.2
  const zoom = 1.0 + Math.sin(progress * Math.PI * 2) * 0.6;
  return { yaw, pitch, zoom };
}

/**
 * Runs a reproducible frame-time benchmark for 3D graph projection and rendering.
 * Can be run in Node.js/Vitest tests or directly in the browser canvas.
 */
export function runProjectionBenchmark(
  scale: SyntheticGraphScale,
  frameCount = 120,
  viewport = { width: 1280, height: 800 }
): FrameBenchmarkResult {
  const dataset = generateSyntheticMemoryDataset(scale);
  const { nodes, edges } = dataset.graph;
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const targetP95Ms = nodeCount >= 50000 ? 33.0 : 16.7;

  // Initialize deterministic positions spread in 3D volume
  const coordinates = new Map<string, MemoryPoint3D>();
  for (let i = 0; i < nodeCount; i++) {
    const node = nodes[i]!;
    // Volume distribution
    const hash = (i * 16777619) ^ (nodeCount * 31);
    const x = ((hash & 0xff) / 255 - 0.5) * 500;
    const y = (((hash >> 8) & 0xff) / 255 - 0.5) * 500;
    const z = (((hash >> 16) & 0xff) / 255 - 0.5) * 500;
    coordinates.set(node.id, { x, y, z });
  }

  // Pre-calculate extent and scale (matching MemoryGraph3D optimization)
  const coordsList = [...coordinates.values()];
  let maxDist = 60;
  for (let i = 0; i < coordsList.length; i++) {
    const p = coordsList[i]!;
    const d = Math.hypot(p.x, p.y, p.z);
    if (d > maxDist) maxDist = d;
  }
  const scaleFactor = Math.min(viewport.width, viewport.height) * 0.4 / maxDist;

  // Edge endpoint indices for fast lookup
  const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const edgePairs: Array<[number, number]> = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const a = nodeIndex.get(e.source), b = nodeIndex.get(e.target);
    if (a !== undefined && b !== undefined) edgePairs.push([a, b]);
  }

  // Projected float buffers
  const projX = new Float32Array(nodeCount);
  const projY = new Float32Array(nodeCount);
  const projZ = new Float32Array(nodeCount);
  const projPersp = new Float32Array(nodeCount);

  // Warmup frames
  for (let f = 0; f < 10; f++) {
    const cam = getBenchmarkCameraForFrame(f, frameCount);
    for (let i = 0; i < nodeCount; i++) {
      const p = coordsList[i]!;
      const proj = projectMemoryPoint(p, cam, scaleFactor, viewport.width, viewport.height);
      projX[i] = proj.x;
      projY[i] = proj.y;
      projZ[i] = proj.z;
      projPersp[i] = proj.perspective;
    }
  }

  // Measurement loop
  const frameTimesMs: number[] = [];

  for (let f = 0; f < frameCount; f++) {
    const cam = getBenchmarkCameraForFrame(f, frameCount);
    const start = performance.now();

    // 1. Perspective project all points into buffers
    for (let i = 0; i < nodeCount; i++) {
      const p = coordsList[i]!;
      const proj = projectMemoryPoint(p, cam, scaleFactor, viewport.width, viewport.height);
      projX[i] = proj.x;
      projY[i] = proj.y;
      projZ[i] = proj.z;
      projPersp[i] = proj.perspective;
    }

    // 2. Iterate edge connections (drawing simulation / line segment validation)
    let edgeCheckSum = 0;
    for (let e = 0; e < edgePairs.length; e++) {
      const [a, b] = edgePairs[e]!;
      edgeCheckSum += projX[a]! + projY[b]!;
    }

    const duration = performance.now() - start;
    frameTimesMs.push(duration);
  }

  const minMs = Math.min(...frameTimesMs);
  const maxMs = Math.max(...frameTimesMs);
  const meanMs = frameTimesMs.reduce((a, b) => a + b, 0) / frameTimesMs.length;
  const medianMs = calculatePercentile(frameTimesMs, 50);
  const p95Ms = calculatePercentile(frameTimesMs, 95);
  const p99Ms = calculatePercentile(frameTimesMs, 99);
  const fpsMean = Math.round(1000 / Math.max(0.01, meanMs));
  const fpsP95 = Math.round(1000 / Math.max(0.01, p95Ms));
  const passed = p95Ms <= targetP95Ms;

  return {
    scale: String(scale),
    nodeCount,
    edgeCount,
    frameCount,
    minMs: Number(minMs.toFixed(2)),
    maxMs: Number(maxMs.toFixed(2)),
    meanMs: Number(meanMs.toFixed(2)),
    medianMs: Number(medianMs.toFixed(2)),
    p95Ms: Number(p95Ms.toFixed(2)),
    p99Ms: Number(p99Ms.toFixed(2)),
    fpsMean,
    fpsP95,
    targetP95Ms,
    passed
  };
}

/**
 * Formats a benchmark suite report into markdown for the PR description.
 */
export function formatBenchmarkReportMarkdown(results: FrameBenchmarkResult[]): string {
  let md = "### Memory Graph 3D Performance Benchmark Report\n\n";
  md += "| Scale | Nodes | Edges | Mean Frame Time | Median (p50) | p95 Frame Time | p99 Frame Time | FPS (p95) | Target p95 | Status |\n";
  md += "|---|---|---|---|---|---|---|---|---|---|\n";

  for (const r of results) {
    const status = r.passed ? "✅ PASS" : "❌ FAIL";
    md += `| **${r.scale.toUpperCase()}** | ${r.nodeCount.toLocaleString()} | ${r.edgeCount.toLocaleString()} | ${r.meanMs} ms | ${r.medianMs} ms | **${r.p95Ms} ms** | ${r.p99Ms} ms | **${r.fpsP95} fps** | <= ${r.targetP95Ms} ms | ${status} |\n`;
  }

  return md;
}
