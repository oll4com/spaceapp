import { describe, expect, it } from "vitest";
import { MetricsRegistry, createProcessMetricsCollector, safeMetricLabelValue } from "../src/metrics-registry.js";

describe("MetricsRegistry", () => {
  it("renders counters, gauges and cumulative histograms in Prometheus text format", () => {
    const registry = new MetricsRegistry();
    const requests = registry.counter("space_test_total", "Test counter.", ["code"]);
    const queue = registry.gauge("space_test_queue", "Test gauge.", ["queue_type"]);
    const duration = registry.histogram("space_test_seconds", "Test histogram.", ["kind"], [0.1, 1]);
    requests.inc({ code: "TIMEOUT" });
    requests.inc({ code: "TIMEOUT" }, 2);
    queue.set({ queue_type: "activity" }, 4);
    duration.observe({ kind: "a" }, 0.05);
    duration.observe({ kind: "a" }, 0.5);
    duration.observe({ kind: "a" }, 5);

    const text = registry.render();
    expect(text).toContain("# TYPE space_test_total counter");
    expect(text).toContain('space_test_total{code="TIMEOUT"} 3');
    expect(text).toContain('space_test_queue{queue_type="activity"} 4');
    expect(text).toContain('space_test_seconds_bucket{kind="a",le="0.1"} 1');
    expect(text).toContain('space_test_seconds_bucket{kind="a",le="1"} 2');
    expect(text).toContain('space_test_seconds_bucket{kind="a",le="+Inf"} 3');
    expect(text).toContain('space_test_seconds_count{kind="a"} 3');
    expect(requests.get({ code: "TIMEOUT" })).toBe(3);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("replaces unsafe label values and caps series instead of exporting user content", () => {
    const registry = new MetricsRegistry({ maxSeriesPerMetric: 3 });
    const counter = registry.counter("space_test_unsafe_total", "Unsafe input test.", ["value"]);
    const unsafe = [
      "my prompt has spaces",
      "Bearer sk-live-0123456789",
      "token=abc",
      'quote"break',
      "line\nbreak",
      "user@example.com",
      "a".repeat(161)
    ];
    for (const value of unsafe) counter.inc({ value });
    for (let index = 0; index < 20; index += 1) counter.inc({ value: `ROUTE_${index}` });

    const text = registry.render();
    for (const value of unsafe) expect(text).not.toContain(value);
    expect(text).toContain('space_test_unsafe_total{value="other"} 7');
    expect(text.split("\n").filter((line) => line.startsWith("space_test_unsafe_total{"))).toHaveLength(3);
    expect(text).toContain('space_metrics_series_dropped_total{metric="space_test_unsafe_total"} 18');
    expect(registry.droppedSeries()).toBe(18);
  });

  it("rejects invalid or duplicate metric definitions and ignores invalid observations", () => {
    const registry = new MetricsRegistry();
    expect(() => registry.counter("bad name", "x")).toThrow();
    expect(() => registry.counter("space_ok_total", "x", ["le"])).toThrow();
    registry.counter("space_dup_total", "x");
    expect(() => registry.gauge("space_dup_total", "x")).toThrow();
    const histogram = registry.histogram("space_neg_seconds", "x");
    histogram.observe(undefined, -1);
    histogram.observe(undefined, Number.NaN);
    expect(registry.render()).not.toContain("space_neg_seconds_count");
    expect(safeMetricLabelValue("/api/rooms/:id")).toBe("/api/rooms/:id");
    expect(safeMetricLabelValue(undefined, "none")).toBe("none");
  });
});

describe("createProcessMetricsCollector", () => {
  it("reports uptime, memory, CPU and event-loop delay", async () => {
    const collector = createProcessMetricsCollector({ eventLoopResolutionMs: 10 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const text = collector.renderLines().join("\n");
      expect(text).toContain('space_process_memory_bytes{type="rss"}');
      expect(text).toContain('space_process_memory_bytes{type="heap_used"}');
      expect(text).toMatch(/space_process_cpu_seconds_total\{mode="user"\} \d/);
      expect(text).toMatch(/space_process_event_loop_lag_seconds\{stat="p99"\} \d/);
      expect(text).toMatch(/space_process_uptime_seconds \d/);
    } finally {
      collector.close();
    }
  });
});
