import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/**
 * A deliberately tiny in-process metrics registry with Prometheus text
 * exposition (format 0.0.4). It exists so the API and the worker can expose
 * local metrics without an external collector or a new dependency.
 *
 * Privacy rule: label values must come from bounded, code-defined sets (route
 * templates, error codes, enum values, activity types). Every value is also
 * checked against a conservative character allowlist and every metric has a
 * series cap, so a mistake degrades to `other`/dropped series instead of
 * exporting user content or growing without bound.
 */

const metricNamePattern = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const labelNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const safeLabelValuePattern = /^[A-Za-z0-9_.:/{}*+-]{1,160}$/;

export const defaultDurationBucketsSeconds = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800] as const;

/** Returns the value when it is a safe label value, otherwise `fallback`. */
export function safeMetricLabelValue(value: unknown, fallback = "other"): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && safeLabelValuePattern.test(value) ? value : fallback;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

type LabelInput = Readonly<Record<string, unknown>>;

interface Series<T> {
  labels: string[];
  value: T;
}

export abstract class MetricFamily<T> {
  protected readonly series = new Map<string, Series<T>>();

  constructor(
    protected readonly registry: MetricsRegistry,
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
    readonly type: "counter" | "gauge" | "histogram"
  ) {}

  protected seriesFor(labels: LabelInput | undefined, create: () => T): Series<T> | null {
    const values = this.labelNames.map((labelName) => safeMetricLabelValue(labels?.[labelName]));
    const key = values.join("\u0000");
    const existing = this.series.get(key);
    if (existing) return existing;
    if (this.series.size >= this.registry.maxSeriesPerMetric) {
      this.registry.recordDroppedSeries(this.name);
      return null;
    }
    const created = { labels: values, value: create() };
    this.series.set(key, created);
    return created;
  }

  protected labelText(values: readonly string[], extra: Readonly<Record<string, string>> = {}): string {
    const pairs = this.labelNames.map((labelName, index) => `${labelName}="${escapeLabelValue(values[index] ?? "")}"`);
    for (const [key, value] of Object.entries(extra)) pairs.push(`${key}="${escapeLabelValue(value)}"`);
    return pairs.length ? `{${pairs.join(",")}}` : "";
  }

  header(): string[] {
    return [`# HELP ${this.name} ${this.help.replace(/\n/g, " ")}`, `# TYPE ${this.name} ${this.type}`];
  }

  abstract render(): string[];

  reset(): void {
    this.series.clear();
  }
}

export class MetricCounter extends MetricFamily<{ value: number }> {
  inc(labels?: LabelInput, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) return;
    const series = this.seriesFor(labels, () => ({ value: 0 }));
    if (series) series.value.value += amount;
  }

  get(labels?: LabelInput): number {
    const key = this.labelNames.map((labelName) => safeMetricLabelValue(labels?.[labelName])).join("\u0000");
    return this.series.get(key)?.value.value ?? 0;
  }

  render(): string[] {
    return [...this.series.values()].map((series) => `${this.name}${this.labelText(series.labels)} ${formatNumber(series.value.value)}`);
  }
}

export class MetricGauge extends MetricFamily<{ value: number }> {
  set(labels: LabelInput | undefined, value: number): void {
    if (!Number.isFinite(value)) return;
    const series = this.seriesFor(labels, () => ({ value: 0 }));
    if (series) series.value.value = value;
  }

  inc(labels?: LabelInput, amount = 1): void {
    const series = this.seriesFor(labels, () => ({ value: 0 }));
    if (series && Number.isFinite(amount)) series.value.value += amount;
  }

  render(): string[] {
    return [...this.series.values()].map((series) => `${this.name}${this.labelText(series.labels)} ${formatNumber(series.value.value)}`);
  }
}

interface HistogramValue {
  bucketCounts: number[];
  sum: number;
  count: number;
}

export class MetricHistogram extends MetricFamily<HistogramValue> {
  constructor(
    registry: MetricsRegistry,
    name: string,
    help: string,
    labelNames: readonly string[],
    readonly buckets: readonly number[]
  ) {
    super(registry, name, help, labelNames, "histogram");
  }

  observe(labels: LabelInput | undefined, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const series = this.seriesFor(labels, () => ({ bucketCounts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    if (!series) return;
    const index = this.buckets.findIndex((bucket) => value <= bucket);
    if (index !== -1) series.value.bucketCounts[index] = (series.value.bucketCounts[index] ?? 0) + 1;
    series.value.sum += value;
    series.value.count += 1;
  }

  render(): string[] {
    const lines: string[] = [];
    for (const series of this.series.values()) {
      let cumulative = 0;
      this.buckets.forEach((bucket, index) => {
        cumulative += series.value.bucketCounts[index] ?? 0;
        lines.push(`${this.name}_bucket${this.labelText(series.labels, { le: String(bucket) })} ${cumulative}`);
      });
      lines.push(`${this.name}_bucket${this.labelText(series.labels, { le: "+Inf" })} ${series.value.count}`);
      lines.push(`${this.name}_sum${this.labelText(series.labels)} ${formatNumber(series.value.sum)}`);
      lines.push(`${this.name}_count${this.labelText(series.labels)} ${series.value.count}`);
    }
    return lines;
  }
}

export interface MetricsRegistryOptions {
  /** Hard cap on label combinations per metric. Excess observations are dropped and counted. */
  maxSeriesPerMetric?: number;
}

export class MetricsRegistry {
  readonly maxSeriesPerMetric: number;
  private readonly metrics = new Map<string, MetricFamily<unknown>>();
  private readonly dropped = new Map<string, number>();

  constructor(options: MetricsRegistryOptions = {}) {
    this.maxSeriesPerMetric = Math.max(1, Math.min(options.maxSeriesPerMetric ?? 200, 10_000));
  }

  private register<T extends MetricFamily<unknown>>(metric: T): T {
    if (!metricNamePattern.test(metric.name)) throw new Error(`Invalid metric name: ${metric.name}`);
    for (const labelName of metric.labelNames) {
      if (!labelNamePattern.test(labelName) || labelName === "le") throw new Error(`Invalid label name: ${labelName}`);
    }
    if (this.metrics.has(metric.name)) throw new Error(`Metric already registered: ${metric.name}`);
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): MetricCounter {
    return this.register(new MetricCounter(this, name, help, labelNames, "counter"));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): MetricGauge {
    return this.register(new MetricGauge(this, name, help, labelNames, "gauge"));
  }

  histogram(name: string, help: string, labelNames: readonly string[] = [], buckets: readonly number[] = defaultDurationBucketsSeconds): MetricHistogram {
    const sorted = [...buckets].filter((bucket) => Number.isFinite(bucket)).sort((left, right) => left - right);
    return this.register(new MetricHistogram(this, name, help, labelNames, sorted));
  }

  recordDroppedSeries(metricName: string): void {
    this.dropped.set(metricName, (this.dropped.get(metricName) ?? 0) + 1);
  }

  droppedSeries(metricName?: string): number {
    if (metricName) return this.dropped.get(metricName) ?? 0;
    let total = 0;
    for (const value of this.dropped.values()) total += value;
    return total;
  }

  droppedSeriesByMetric(): Array<[string, number]> {
    return [...this.dropped.entries()];
  }

  /**
   * Renders every metric, including families without samples, in registration
   * order. Pass `includeDropped: false` when several registries are rendered
   * into one exposition; then render their drops once with renderDroppedSeries.
   */
  renderLines(options: { includeDropped?: boolean } = {}): string[] {
    const lines: string[] = [];
    for (const metric of this.metrics.values()) lines.push(...metric.header(), ...metric.render());
    if (options.includeDropped !== false) lines.push(...renderDroppedSeries([this]));
    return lines;
  }

  render(): string {
    return `${this.renderLines().join("\n")}\n`;
  }
}

/** One `space_metrics_series_dropped_total` family for several registries. */
export function renderDroppedSeries(registries: readonly MetricsRegistry[]): string[] {
  const totals = new Map<string, number>();
  for (const registry of registries) {
    for (const [metricName, count] of registry.droppedSeriesByMetric()) totals.set(metricName, (totals.get(metricName) ?? 0) + count);
  }
  const lines = [
    "# HELP space_metrics_series_dropped_total Observations dropped because a metric reached its series limit.",
    "# TYPE space_metrics_series_dropped_total counter"
  ];
  for (const [metricName, count] of totals) lines.push(`space_metrics_series_dropped_total{metric="${escapeLabelValue(metricName)}"} ${count}`);
  return lines;
}

export interface ProcessMetricsCollector {
  /** Prometheus lines for process uptime, memory, CPU and event-loop delay. */
  renderLines(): string[];
  close(): void;
}

/**
 * Process-level metrics. Event-loop delay is sampled by Node's built-in
 * histogram and reset after each render, so each scrape reports the window
 * since the previous scrape (the same approach as common Prometheus clients).
 */
export function createProcessMetricsCollector(options: { eventLoopResolutionMs?: number } = {}): ProcessMetricsCollector {
  let eventLoop: IntervalHistogram | null = null;
  try {
    eventLoop = monitorEventLoopDelay({ resolution: Math.max(10, options.eventLoopResolutionMs ?? 20) });
    eventLoop.enable();
  } catch {
    eventLoop = null;
  }
  return {
    renderLines() {
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      const lines = [
        "# HELP space_process_uptime_seconds Process uptime in seconds.",
        "# TYPE space_process_uptime_seconds gauge",
        `space_process_uptime_seconds ${process.uptime()}`,
        "# HELP space_process_memory_bytes Process memory usage in bytes.",
        "# TYPE space_process_memory_bytes gauge",
        `space_process_memory_bytes{type="rss"} ${memory.rss}`,
        `space_process_memory_bytes{type="heap_used"} ${memory.heapUsed}`,
        `space_process_memory_bytes{type="heap_total"} ${memory.heapTotal}`,
        `space_process_memory_bytes{type="external"} ${memory.external}`,
        `space_process_memory_bytes{type="array_buffers"} ${memory.arrayBuffers}`,
        "# HELP space_process_cpu_seconds_total Process CPU time in seconds.",
        "# TYPE space_process_cpu_seconds_total counter",
        `space_process_cpu_seconds_total{mode="user"} ${cpu.user / 1_000_000}`,
        `space_process_cpu_seconds_total{mode="system"} ${cpu.system / 1_000_000}`
      ];
      if (eventLoop) {
        const seconds = (nanoseconds: number) => (Number.isFinite(nanoseconds) ? nanoseconds / 1e9 : 0);
        const sampled = eventLoop.count > 0;
        lines.push(
          "# HELP space_process_event_loop_lag_seconds Event-loop delay since the previous scrape.",
          "# TYPE space_process_event_loop_lag_seconds gauge",
          `space_process_event_loop_lag_seconds{stat="p50"} ${sampled ? seconds(eventLoop.percentile(50)) : 0}`,
          `space_process_event_loop_lag_seconds{stat="p90"} ${sampled ? seconds(eventLoop.percentile(90)) : 0}`,
          `space_process_event_loop_lag_seconds{stat="p99"} ${sampled ? seconds(eventLoop.percentile(99)) : 0}`,
          `space_process_event_loop_lag_seconds{stat="max"} ${sampled ? seconds(eventLoop.max) : 0}`,
          `space_process_event_loop_lag_seconds{stat="mean"} ${sampled ? seconds(eventLoop.mean) : 0}`
        );
        eventLoop.reset();
      }
      return lines;
    },
    close() {
      eventLoop?.disable();
      eventLoop = null;
    }
  };
}
