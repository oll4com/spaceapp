/**
 * Frame-time benchmark harness for the 3D memory graph (issue #62 acceptance criteria).
 * Only active when the page is opened with the "bench=1" URL parameter; the normal
 * app and demo entries never run it.
 */

export interface BenchParams {
  enabled: boolean;
  frames: number;
}

export interface FrameBenchResult {
  frames: number;
  durationMs: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

const BENCH_MIN_FRAMES = 60;
const BENCH_MAX_FRAMES = 3000;
const BENCH_DEFAULT_FRAMES = 600;

export function parseBenchParams(search: string): BenchParams {
  const params = new URLSearchParams(search);
  const requested = Number(params.get("benchFrames"));
  const frames = Number.isFinite(requested) && requested > 0 ? Math.round(requested) : BENCH_DEFAULT_FRAMES;
  return {
    enabled: params.get("bench") === "1",
    frames: Math.max(BENCH_MIN_FRAMES, Math.min(BENCH_MAX_FRAMES, frames)),
  };
}

/**
 * Runs `tick` once per animation frame and measures the wall-clock interval between
 * frames, so the result reflects real frame cost (render + GPU raster) rather than raw
 * JavaScript time. Resolves with null when `isCancelled` becomes true first.
 */
export function runFrameBench(frames: number, tick: () => void, isCancelled: () => boolean = () => false): Promise<FrameBenchResult | null> {
  return new Promise(resolve => {
    const deltas: number[] = [];
    let last = 0;
    let index = 0;
    const step = () => {
      if (isCancelled()) { resolve(null); return; }
      const now = performance.now();
      if (index > 0) deltas.push(now - last);
      last = now;
      tick();
      index += 1;
      if (index > frames) {
        deltas.sort((a, b) => a - b);
        const count = deltas.length;
        const quantile = (q: number) => deltas[Math.min(count - 1, Math.floor(q * count))]!;
        const total = deltas.reduce((sum, value) => sum + value, 0);
        resolve({
          frames: count,
          durationMs: Math.round(total * 10) / 10,
          p50: Math.round(quantile(0.5) * 10) / 10,
          p95: Math.round(quantile(0.95) * 10) / 10,
          max: Math.round(deltas[count - 1]! * 10) / 10,
          mean: Math.round((total / Math.max(count, 1)) * 10) / 10,
        });
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Publishes the result where the headless driver can read it: document title + console. */
export function publishBenchResult(result: FrameBenchResult): void {
  document.title = "BENCH:" + JSON.stringify(result);
  console.log("BENCH_RESULT " + JSON.stringify(result));
}
