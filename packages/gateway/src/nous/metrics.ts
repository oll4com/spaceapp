/**
 * Prometheus text exposition of the Nous Gateway (plan clipboard:_0qBSFCftZuD step 4, K5-metrics; install plan §3.8), served only on the
 * mTLS admin listener. Counters and the first-token histogram live in the replica's memory (Prometheus sums the replicas); account
 * gauges are read when scraped. No tenant id is ever a label: per-plan series only.
 */
export type Labels = Record<string, string>;
export interface GaugeFamily { name: string; help: string; samples: { labels: Labels; value: number }[] }

const FIRST_TOKEN_BUCKETS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labelText = (labels: Labels) => {
  const entries = Object.entries(labels);
  return entries.length ? `{${entries.map(([key, value]) => `${key}="${escape(value)}"`).join(",")}}` : "";
};

export function createNgwMetrics() {
  const counters = new Map<string, { help: string; values: Map<string, number> }>();
  const firstToken = new Map<string, { buckets: number[]; sum: number; count: number }>();
  const counter = (name: string, help: string) => {
    let family = counters.get(name);
    if (!family) counters.set(name, family = { help, values: new Map() });
    return family;
  };
  return {
    inc(name: string, help: string, labels: Labels, by = 1) {
      const family = counter(name, help), key = labelText(labels);
      family.values.set(key, (family.values.get(key) ?? 0) + by);
    },
    /** Time to the first token of an answered request, in seconds. */
    observeFirstToken(provider: string, seconds: number) {
      const key = labelText({ provider });
      let entry = firstToken.get(key);
      if (!entry) firstToken.set(key, entry = { buckets: FIRST_TOKEN_BUCKETS.map(() => 0), sum: 0, count: 0 });
      FIRST_TOKEN_BUCKETS.forEach((bound, index) => { if (seconds <= bound) entry!.buckets[index]! += 1; });
      entry.sum += seconds;
      entry.count += 1;
    },
    render(gauges: GaugeFamily[] = []): string {
      const lines: string[] = [];
      for (const [name, family] of counters) {
        lines.push(`# HELP ${name} ${family.help}`, `# TYPE ${name} counter`);
        for (const [labels, value] of family.values) lines.push(`${name}${labels} ${value}`);
      }
      if (firstToken.size) {
        lines.push("# HELP ngw_first_token_seconds Time from the request to the first output token.", "# TYPE ngw_first_token_seconds histogram");
        for (const [labels, entry] of firstToken) {
          const inner = labels.slice(1, -1);
          FIRST_TOKEN_BUCKETS.forEach((bound, index) => lines.push(`ngw_first_token_seconds_bucket{${inner},le="${bound}"} ${entry.buckets[index]}`));
          lines.push(`ngw_first_token_seconds_bucket{${inner},le="+Inf"} ${entry.count}`, `ngw_first_token_seconds_sum${labels} ${entry.sum}`,
            `ngw_first_token_seconds_count${labels} ${entry.count}`);
        }
      }
      for (const gauge of gauges) {
        lines.push(`# HELP ${gauge.name} ${gauge.help}`, `# TYPE ${gauge.name} gauge`);
        for (const sample of gauge.samples) lines.push(`${gauge.name}${labelText(sample.labels)} ${sample.value}`);
      }
      return `${lines.join("\n")}\n`;
    }
  };
}

export type NgwMetrics = ReturnType<typeof createNgwMetrics>;
