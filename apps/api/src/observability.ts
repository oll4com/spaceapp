import type { FastifyReply, FastifyRequest } from "fastify";
import type { ObservabilitySnapshot } from "@space/contracts";

const bucketsSeconds = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
const maxSamplesPerEndpoint = 240;

type StatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx";
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

interface EndpointStats {
  method: HttpMethod;
  route: string;
  statusClass: StatusClass;
  requestCount: number;
  errorCount: number;
  durationSumMs: number;
  bucketCounts: number[];
  samplesMs: number[];
  minDurationMs: number | null;
  maxDurationMs: number | null;
  lastSeenAt: string | null;
}

function statusClass(statusCode: number): StatusClass {
  if (statusCode >= 500) return "5xx";
  if (statusCode >= 400) return "4xx";
  if (statusCode >= 300) return "3xx";
  if (statusCode >= 200) return "2xx";
  return "1xx";
}

function routeLabel(request: FastifyRequest): string {
  const route = request.routeOptions.url ?? request.url.split("?")[0] ?? "unknown";
  return route.slice(0, 240);
}

function httpMethod(method: string): HttpMethod {
  const upper = method.toUpperCase();
  if (upper === "POST" || upper === "PUT" || upper === "PATCH" || upper === "DELETE" || upper === "HEAD" || upper === "OPTIONS") {
    return upper;
  }
  return "GET";
}

function labelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function percentile(samples: number[], p: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? null;
}

function roundMs(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function createHttpObservability(input: { serviceName: "space-api" }) {
  const startedAt = new Date();
  const starts = new WeakMap<FastifyRequest, bigint>();
  const endpoints = new Map<string, EndpointStats>();

  function getEndpoint(method: HttpMethod, route: string, klass: StatusClass): EndpointStats {
    const key = `${method}\u0000${route}\u0000${klass}`;
    const existing = endpoints.get(key);
    if (existing) return existing;
    const created: EndpointStats = {
      method,
      route,
      statusClass: klass,
      requestCount: 0,
      errorCount: 0,
      durationSumMs: 0,
      bucketCounts: bucketsSeconds.map(() => 0),
      samplesMs: [],
      minDurationMs: null,
      maxDurationMs: null,
      lastSeenAt: null
    };
    endpoints.set(key, created);
    return created;
  }

  function observe(request: FastifyRequest, reply: FastifyReply) {
    const start = starts.get(request);
    if (!start) return;
    starts.delete(request);
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const klass = statusClass(reply.statusCode);
    const endpoint = getEndpoint(httpMethod(request.method), routeLabel(request), klass);
    endpoint.requestCount += 1;
    if (reply.statusCode >= 500) endpoint.errorCount += 1;
    endpoint.durationSumMs += durationMs;
    endpoint.samplesMs.push(durationMs);
    if (endpoint.samplesMs.length > maxSamplesPerEndpoint) endpoint.samplesMs.shift();
    endpoint.minDurationMs = endpoint.minDurationMs === null ? durationMs : Math.min(endpoint.minDurationMs, durationMs);
    endpoint.maxDurationMs = endpoint.maxDurationMs === null ? durationMs : Math.max(endpoint.maxDurationMs, durationMs);
    endpoint.lastSeenAt = new Date().toISOString();
    const bucketIndex = bucketsSeconds.findIndex((bucket) => durationMs / 1000 <= bucket);
    if (bucketIndex !== -1) endpoint.bucketCounts[bucketIndex] = (endpoint.bucketCounts[bucketIndex] ?? 0) + 1;
  }

  function snapshot(): ObservabilitySnapshot {
    const endpointMetrics = Array.from(endpoints.values()).map((endpoint) => {
      const p50 = percentile(endpoint.samplesMs, 50);
      const p95 = percentile(endpoint.samplesMs, 95);
      const p99 = percentile(endpoint.samplesMs, 99);
      return {
        method: endpoint.method,
        route: endpoint.route,
        statusClass: endpoint.statusClass,
        requestCount: endpoint.requestCount,
        errorCount: endpoint.errorCount,
        durationMs: {
          count: endpoint.requestCount,
          min: roundMs(endpoint.minDurationMs),
          max: roundMs(endpoint.maxDurationMs),
          average: roundMs(endpoint.requestCount ? endpoint.durationSumMs / endpoint.requestCount : null),
          p50: roundMs(p50),
          p95: roundMs(p95),
          p99: roundMs(p99)
        },
        lastSeenAt: endpoint.lastSeenAt
      };
    });
    endpointMetrics.sort((left, right) => right.requestCount - left.requestCount || left.route.localeCompare(right.route));

    const allSamples = endpointMetrics.flatMap((endpoint) => {
      const source = endpoints.get(`${endpoint.method}\u0000${endpoint.route}\u0000${endpoint.statusClass}`);
      return source?.samplesMs ?? [];
    });
    const memory = process.memoryUsage();
    const totalRequestCount = sum(endpointMetrics.map((endpoint) => endpoint.requestCount));
    const totalErrorCount = sum(endpointMetrics.map((endpoint) => endpoint.errorCount));

    return {
      service: input.serviceName,
      generatedAt: new Date().toISOString(),
      runtime: {
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        pid: process.pid,
        memory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers
        }
      },
      totals: {
        requestCount: totalRequestCount,
        errorCount: totalErrorCount,
        errorRate: totalRequestCount ? Math.round((totalErrorCount / totalRequestCount) * 10_000) / 10_000 : 0,
        p50Ms: roundMs(percentile(allSamples, 50)),
        p95Ms: roundMs(percentile(allSamples, 95)),
        p99Ms: roundMs(percentile(allSamples, 99))
      },
      endpoints: endpointMetrics.slice(0, 50)
    };
  }

  function renderPrometheus(): string {
    const lines = [
      "# HELP space_http_requests_total Total HTTP requests by method, route template and status class.",
      "# TYPE space_http_requests_total counter"
    ];
    for (const endpoint of endpoints.values()) {
      const labels = `method="${labelValue(endpoint.method)}",route="${labelValue(endpoint.route)}",status_class="${endpoint.statusClass}"`;
      lines.push(`space_http_requests_total{${labels}} ${endpoint.requestCount}`);
    }

    lines.push(
      "# HELP space_http_request_errors_total HTTP 5xx responses by method, route template and status class.",
      "# TYPE space_http_request_errors_total counter"
    );
    for (const endpoint of endpoints.values()) {
      const labels = `method="${labelValue(endpoint.method)}",route="${labelValue(endpoint.route)}",status_class="${endpoint.statusClass}"`;
      lines.push(`space_http_request_errors_total{${labels}} ${endpoint.errorCount}`);
    }

    lines.push(
      "# HELP space_http_request_duration_seconds HTTP request duration histogram.",
      "# TYPE space_http_request_duration_seconds histogram"
    );
    for (const endpoint of endpoints.values()) {
      const labels = `method="${labelValue(endpoint.method)}",route="${labelValue(endpoint.route)}",status_class="${endpoint.statusClass}"`;
      let cumulative = 0;
      endpoint.bucketCounts.forEach((count, index) => {
        cumulative += count;
        lines.push(`space_http_request_duration_seconds_bucket{${labels},le="${bucketsSeconds[index]}"} ${cumulative}`);
      });
      lines.push(`space_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${endpoint.requestCount}`);
      lines.push(`space_http_request_duration_seconds_sum{${labels}} ${endpoint.durationSumMs / 1000}`);
      lines.push(`space_http_request_duration_seconds_count{${labels}} ${endpoint.requestCount}`);
    }

    const memory = process.memoryUsage();
    lines.push(
      "# HELP space_process_uptime_seconds Process uptime in seconds.",
      "# TYPE space_process_uptime_seconds gauge",
      `space_process_uptime_seconds ${process.uptime()}`,
      "# HELP space_process_memory_bytes Process memory usage in bytes.",
      "# TYPE space_process_memory_bytes gauge",
      `space_process_memory_bytes{type="rss"} ${memory.rss}`,
      `space_process_memory_bytes{type="heap_used"} ${memory.heapUsed}`,
      `space_process_memory_bytes{type="heap_total"} ${memory.heapTotal}`,
      `space_process_memory_bytes{type="external"} ${memory.external}`,
      `space_process_memory_bytes{type="array_buffers"} ${memory.arrayBuffers}`
    );

    return `${lines.join("\n")}\n`;
  }

  return {
    onRequest(request: FastifyRequest) {
      starts.set(request, process.hrtime.bigint());
    },
    onResponse: observe,
    snapshot,
    renderPrometheus
  };
}
