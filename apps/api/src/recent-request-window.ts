import type { SystemHealthRequests } from "@space/contracts";

type Bucket = {
  at: number;
  count: number;
  errors: number;
  histogram: number[];
};
/** Bounded 5-minute histogram: exact request counts, p95 within 8% above the sample. */
export class RecentRequestWindow {
  private buckets = new Map<number, Bucket>();
  constructor(private now = Date.now) {}
  observe(status: number, durationMs: number) {
    const now = this.now();
    this.sweep(now);
    const at = Math.floor(now / 1000) * 1000;
    const b = this.buckets.get(at) ?? {
      at,
      count: 0,
      errors: 0,
      histogram: Array<number>(180).fill(0),
    };
    b.count++;
    if (status >= 500) b.errors++;
    const bin = Math.max(
      0,
      Math.min(
        179,
        Math.ceil(Math.log(Math.max(1, durationMs)) / Math.log(1.08)),
      ),
    );
    b.histogram[bin] = (b.histogram[bin] ?? 0) + 1;
    this.buckets.set(at, b);
  }
  private sweep(now: number) {
    for (const at of this.buckets.keys())
      if (at <= now - 300_000) this.buckets.delete(at);
  }
  snapshot(): SystemHealthRequests {
    const now = this.now();
    this.sweep(now);
    const histogram = Array<number>(180).fill(0);
    let count = 0,
      errors = 0;
    for (const b of this.buckets.values()) {
      count += b.count;
      errors += b.errors;
      b.histogram.forEach((n, i) => {
        histogram[i] = (histogram[i] ?? 0) + n;
      });
    }
    let cumulative = 0;
    let p95: number | null = null;
    if (count)
      for (const [i, n] of histogram.entries()) {
        cumulative += n;
        if (cumulative >= Math.ceil(count * 0.95)) {
          p95 = Math.round(1.08 ** i);
          break;
        }
      }
    return {
      windowSeconds: 300,
      requestCount: count,
      errorCount: errors,
      errorRatePercent: count >= 20 ? (errors / count) * 100 : null,
      p95Ms: count >= 20 ? p95 : null,
      sampledAt: new Date(now).toISOString(),
    };
  }
}
