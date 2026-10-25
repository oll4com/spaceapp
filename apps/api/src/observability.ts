import type { FastifyReply, FastifyRequest } from "fastify";
import { RecentRequestWindow } from "./recent-request-window.js";
import { apiDomainMetrics } from "./api-metrics.js";
import {
  categorizeFailureCode,
  isSafeErrorCode,
  type CliTerminalTelemetryOutcome,
  type CliTerminalTelemetryReason,
  type FailureCategory,
  type ObservabilitySnapshot,
  type WorkerReadiness
} from "@space/contracts";
import { MetricsRegistry, createProcessMetricsCollector, otlpSpanExporterFromEnv, renderDroppedSeries, type SpanExporter } from "@space/runtime";
import { traceContextForRawRequest } from "./trace-context.js";

const bucketsSeconds = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
const maxSamplesPerEndpoint = 240;
const maxCliTerminalMetricSeries = 128;

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

export interface CliTerminalTelemetryObservation {
  source: "CLIENT" | "SERVER";
  event: string;
  outcome: CliTerminalTelemetryOutcome;
  reason: CliTerminalTelemetryReason;
}

function statusClass(statusCode: number): StatusClass {
  if (statusCode >= 500) return "5xx";
  if (statusCode >= 400) return "4xx";
  if (statusCode >= 300) return "3xx";
  if (statusCode >= 200) return "2xx";
  return "1xx";
}

function routeLabel(request: FastifyRequest): string {
  // Raw unmatched paths are untrusted/high-cardinality input and may contain
  // secrets. Only registered templates may become metric labels.
  const route = request.routeOptions.url ?? "unmatched";
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

/**
 * Error code of a JSON error response (`{ error: { code } }` or `{ code }`).
 * Only upper-case identifiers are returned; messages are never inspected.
 */
export function errorCodeFromPayload(payload: unknown): string | null {
  if (typeof payload !== "string" || payload.length > 16_384 || !payload.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(payload) as { error?: unknown; code?: unknown };
    const nested = parsed.error && typeof parsed.error === "object" ? (parsed.error as { code?: unknown }).code : undefined;
    const code = nested ?? parsed.code;
    return isSafeErrorCode(code) ? code : null;
  } catch {
    return null;
  }
}

function categoryForStatus(statusCode: number): FailureCategory {
  if (statusCode === 401 || statusCode === 403) return "PERMISSION_DENIED";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 409 || statusCode === 412) return "CONFLICT";
  if (statusCode === 429) return "RATE_LIMITED";
  if (statusCode === 400 || statusCode === 413 || statusCode === 415 || statusCode === 422) return "INVALID_INPUT";
  if (statusCode === 501) return "DISABLED";
  if (statusCode === 502 || statusCode === 503) return "UPSTREAM_UNAVAILABLE";
  if (statusCode === 504 || statusCode === 408) return "TIMEOUT";
  return "INTERNAL";
}

/** Category of an HTTP failure: from its code when specific, otherwise from the status. */
export function categorizeHttpFailure(code: string | null, statusCode: number): FailureCategory {
  const fromCode = code ? categorizeFailureCode(code) : "INTERNAL";
  return fromCode !== "INTERNAL" ? fromCode : categoryForStatus(statusCode);
}

const cliDisconnectEvents = new Set(["SOCKET_DISCONNECTED", "SOCKET_DETACHED"]);
const cliReconnectOutcomes: Readonly<Record<string, string>> = {
  RECONNECT_SCHEDULED: "SCHEDULED",
  RECONNECT_GRACE_STARTED: "GRACE_STARTED",
  RECONNECT_SUCCEEDED: "SUCCEEDED",
  SESSION_RECOVERED: "SESSION_RECOVERED",
  RECONNECT_STOPPED: "STOPPED"
};

function durationSeconds(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function createHttpObservability(input: { serviceName: "space-api"; spanExporter?: SpanExporter | null }) {
  const recentRequests = new RecentRequestWindow();
  const startedAt = new Date();
  const starts = new WeakMap<FastifyRequest, bigint>();
  // Optional OTLP span export (SPACE_OTEL_EXPORTER_OTLP_ENDPOINT); off by default.
  const spanExporter = input.spanExporter === undefined ? otlpSpanExporterFromEnv(process.env, input.serviceName) : input.spanExporter;
  const startWallMs = new WeakMap<FastifyRequest, number>();
  const endpoints = new Map<string, EndpointStats>();
  const cliTerminalEvents = new Map<string, CliTerminalTelemetryObservation & { count: number }>();
  let droppedCliTerminalMetricSeries = 0;
  const processMetrics = createProcessMetricsCollector();
  const registry = new MetricsRegistry({ maxSeriesPerMetric: 256 });
  const errorResponses = registry.counter(
    "space_http_error_responses_total",
    "HTTP 4xx/5xx responses by stable error code, failure category and status class. Codes are upper-case identifiers; messages are never exported.",
    ["code", "category", "status_class"]
  );
  const cliDisconnects = registry.counter(
    "space_cli_terminal_disconnects_total",
    "CLI terminal socket disconnects observed by the browser client or detaches observed by the server.",
    ["source"]
  );
  const cliReconnects = registry.counter(
    "space_cli_terminal_reconnects_total",
    "CLI terminal reconnect lifecycle: scheduled, server grace started, succeeded, session recovered or stopped.",
    ["source", "outcome"]
  );
  const temporalBacklog = registry.gauge(
    "space_temporal_task_queue_backlog",
    "Approximate Temporal task-queue backlog from the latest worker readiness check.",
    ["queue_type"]
  );
  const temporalBacklogAge = registry.gauge(
    "space_temporal_task_queue_backlog_age_seconds",
    "Approximate age of the oldest queued Temporal task from the latest worker readiness check.",
    ["queue_type"]
  );
  const temporalPollers = registry.gauge(
    "space_temporal_task_queue_pollers",
    "Temporal pollers seen on the Space task queue by the latest worker readiness check.",
    ["queue_type"]
  );
  const temporalReachable = registry.gauge(
    "space_temporal_reachable",
    "1 when the latest worker readiness check reached Temporal, otherwise 0."
  );
  const temporalReadinessChecks = registry.counter(
    "space_temporal_readiness_checks_total",
    "Worker readiness checks by resulting status.",
    ["status"]
  );
  const temporalReadinessObservedAt = registry.gauge(
    "space_temporal_readiness_observed_timestamp_seconds",
    "Unix time of the latest worker readiness check. Temporal gauges are as fresh as this value."
  );

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
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (!contentType.includes("text/event-stream") && reply.statusCode !== 101) recentRequests.observe(reply.statusCode, durationMs);
    const klass = statusClass(reply.statusCode);
    const route = routeLabel(request);
    const endpoint = getEndpoint(httpMethod(request.method), route, klass);
    if (spanExporter) exportServerSpan(request, reply.statusCode, route, durationMs);
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

  function exportServerSpan(request: FastifyRequest, statusCode: number, route: string, durationMs: number) {
    const startMs = startWallMs.get(request);
    startWallMs.delete(request);
    if (startMs === undefined || !spanExporter) return;
    const trace = traceContextForRawRequest(request.raw);
    const startNs = BigInt(Math.round(startMs * 1_000_000));
    spanExporter.record({
      traceId: trace.w3cTraceId,
      spanId: trace.spanId,
      parentSpanId: trace.parentSpanId,
      name: `${httpMethod(request.method)} ${route}`,
      startTimeUnixNano: startNs,
      endTimeUnixNano: startNs + BigInt(Math.max(0, Math.round(durationMs * 1_000_000))),
      attributes: {
        "http.request.method": httpMethod(request.method),
        "http.route": route,
        "http.response.status_code": statusCode,
        "space.request_id": String(request.id)
      },
      error: statusCode >= 500
    });
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

  function observeErrorResponse(statusCode: number, payload: unknown): void {
    if (statusCode < 400) return;
    const code = errorCodeFromPayload(payload);
    errorResponses.inc({
      code: code ?? "UNSPECIFIED",
      category: categorizeHttpFailure(code, statusCode),
      status_class: statusClass(statusCode)
    });
  }

  function observeWorkerReadiness(readiness: WorkerReadiness): void {
    temporalReadinessChecks.inc({ status: readiness.status });
    temporalReachable.set(undefined, readiness.reachable ? 1 : 0);
    temporalReadinessObservedAt.set(undefined, Date.now() / 1000);
    temporalPollers.set({ queue_type: "workflow" }, readiness.workflowPollerCount);
    temporalPollers.set({ queue_type: "activity" }, readiness.activityPollerCount);
    if (readiness.workflowBacklogCount !== null) temporalBacklog.set({ queue_type: "workflow" }, readiness.workflowBacklogCount);
    if (readiness.activityBacklogCount !== null) temporalBacklog.set({ queue_type: "activity" }, readiness.activityBacklogCount);
    const workflowAge = durationSeconds(readiness.workflowBacklogAgeSeconds);
    const activityAge = durationSeconds(readiness.activityBacklogAgeSeconds);
    if (workflowAge !== null) temporalBacklogAge.set({ queue_type: "workflow" }, workflowAge);
    if (activityAge !== null) temporalBacklogAge.set({ queue_type: "activity" }, activityAge);
  }

  function observeCliTerminalEvent(input: CliTerminalTelemetryObservation): void {
    if (cliDisconnectEvents.has(input.event)) cliDisconnects.inc({ source: input.source });
    const reconnectOutcome = cliReconnectOutcomes[input.event];
    if (reconnectOutcome) cliReconnects.inc({ source: input.source, outcome: reconnectOutcome });
    if (input.event === "SOCKET_ATTACHED" && input.reason !== "INITIAL_ATTACH") {
      cliReconnects.inc({ source: input.source, outcome: "REATTACHED" });
    }
    const key = `${input.source}\u0000${input.event}\u0000${input.outcome}\u0000${input.reason}`;
    const existing = cliTerminalEvents.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    if (cliTerminalEvents.size >= maxCliTerminalMetricSeries) {
      droppedCliTerminalMetricSeries += 1;
      return;
    }
    cliTerminalEvents.set(key, { ...input, count: 1 });
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

    lines.push(
      "# HELP space_cli_terminal_events_total CLI terminal lifecycle events by bounded source, event, outcome and reason.",
      "# TYPE space_cli_terminal_events_total counter"
    );
    for (const event of cliTerminalEvents.values()) {
      const labels =
        `source="${event.source}",event="${labelValue(event.event)}",` +
        `outcome="${event.outcome}",reason="${event.reason}"`;
      lines.push(`space_cli_terminal_events_total{${labels}} ${event.count}`);
    }
    lines.push(
      "# HELP space_cli_terminal_metric_series_dropped_total CLI terminal telemetry observations dropped after the bounded series limit.",
      "# TYPE space_cli_terminal_metric_series_dropped_total counter",
      `space_cli_terminal_metric_series_dropped_total ${droppedCliTerminalMetricSeries}`
    );

    if (spanExporter) {
      const exported = spanExporter.stats();
      lines.push(
        "# HELP space_otlp_spans_total API server spans handed to the OTLP exporter by outcome (exported, dropped when the queue was full, failed delivery).",
        "# TYPE space_otlp_spans_total counter",
        `space_otlp_spans_total{outcome="exported"} ${exported.exported}`,
        `space_otlp_spans_total{outcome="dropped"} ${exported.dropped}`,
        `space_otlp_spans_total{outcome="failed"} ${exported.failed}`
      );
    }

    lines.push(...processMetrics.renderLines());
    lines.push(...registry.renderLines({ includeDropped: false }));
    lines.push(...apiDomainMetrics.renderLines({ includeDropped: false }));
    lines.push(...renderDroppedSeries([registry, apiDomainMetrics]));

    return `${lines.join("\n")}\n`;
  }

  return {
    onRequest(request: FastifyRequest) {
      starts.set(request, process.hrtime.bigint());
      if (spanExporter) startWallMs.set(request, performance.timeOrigin + performance.now());
    },
    onResponse: observe,
    observeErrorResponse,
    observeWorkerReadiness,
    close: () => {
      processMetrics.close();
      void spanExporter?.close();
    },
    observeCliTerminalEvent,
    snapshot,
    recentSnapshot: () => recentRequests.snapshot(),
    renderPrometheus
  };
}
