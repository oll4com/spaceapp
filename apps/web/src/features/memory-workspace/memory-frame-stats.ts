export interface FrameStats { frames: number; p50: number; p95: number; max: number }

/** Nearest-rank percentiles of requestAnimationFrame deltas (ms). */
export function summarizeFrameTimes(deltas: number[]): FrameStats {
  if (!deltas.length) return { frames: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...deltas].sort((a, b) => a - b);
  const rank = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
  return { frames: sorted.length, p50: rank(0.5), p95: rank(0.95), max: sorted[sorted.length - 1]! };
}

/** Camera path of the in-app benchmark: steady rotation while zoom oscillates between 0.6x and 2.2x. */
export const benchmarkCamera = (frame: number) => ({ yawStep: 0.02, zoom: 1.4 + 0.8 * Math.sin(frame / 30) });
