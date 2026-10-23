/**
 * Minimal render-cost harness for the 3D memory graph (#62).
 *
 * Enabled with `?graphperf` in the URL. Records the CPU cost of each render
 * (not the idle gap between frames) and exposes p50/p95/max on
 * `window.__memoryGraphPerf`, e.g.:
 *
 *   open http://127.0.0.1:4911/demo-workspace?graphperf, switch Memory to 3D,
 *   rotate/zoom for a while, then read `window.__memoryGraphPerf.snapshot()`.
 */

export type GraphPerfSnapshot = {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  nodeCount: number;
  edgeCount: number;
  renderer: string;
  picks: number;
  pickP50: number;
  pickP95: number;
  pickMax: number;
};

const percentile = (sorted: number[], q: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

export class GraphPerfRecorder {
  private deltas: number[] = [];
  private renderer = "unknown";
  private nodeCount = 0;
  private edgeCount = 0;
  private pickDeltas: number[] = [];

  configure(renderer: string, nodeCount: number, edgeCount: number) {
    this.renderer = renderer;
    this.nodeCount = nodeCount;
    this.edgeCount = edgeCount;
  }

  /** Record one render's CPU cost in ms (measured around the render body). */
  frame(durationMs: number) {
    this.deltas.push(durationMs);
    if (this.deltas.length > 3600) this.deltas.shift();
  }

  snapshot(): GraphPerfSnapshot {
    const sorted = [...this.deltas].sort((a, b) => a - b);
    const pickSorted = [...this.pickDeltas].sort((a, b) => a - b);
    return {
      frames: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted.length ? sorted[sorted.length - 1]! : 0,
      nodeCount: this.nodeCount,
      edgeCount: this.edgeCount,
      renderer: this.renderer,
      picks: pickSorted.length,
      pickP50: percentile(pickSorted, 0.5),
      pickP95: percentile(pickSorted, 0.95),
      pickMax: pickSorted.length ? pickSorted[pickSorted.length - 1]! : 0,
    };
  }

  pick(ms: number) {
    this.pickDeltas.push(ms);
    if (this.pickDeltas.length > 600) this.pickDeltas.shift();
  }

  reset() {
    this.deltas = [];
    this.pickDeltas = [];
  }
}

export function graphPerfEnabled(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("graphperf");
  } catch {
    return false;
  }
}

declare global {
  interface Window {
    __memoryGraphPerf?: { recorder: GraphPerfRecorder; snapshot: () => GraphPerfSnapshot };
  }
}

export function installGraphPerf(recorder: GraphPerfRecorder) {
  if (typeof window === "undefined" || !graphPerfEnabled()) return;
  window.__memoryGraphPerf = { recorder, snapshot: () => recorder.snapshot() };
  console.info("[memory-graph] perf harness enabled: window.__memoryGraphPerf.snapshot()");
}
