import { createServer, type Server } from "node:http";
import { MetricsRegistry, createProcessMetricsCollector, renderDroppedSeries, type ProcessMetricsCollector } from "@space/runtime";

/**
 * Worker-local metrics. Labels are activity type names (code-defined), bounded
 * outcomes, failure categories and stable reason codes; never room, pane,
 * mission, user or trace identifiers. Exposed only on a loopback HTTP port
 * when SPACE_WORKER_METRICS_PORT is set (see docs/quality/observability.md).
 */
export function createWorkerMetrics(registry = new MetricsRegistry({ maxSeriesPerMetric: 300 })) {
  return {
    registry,
    activityExecutions: registry.counter(
      "space_worker_activity_executions_total",
      "Activity executions by activity type and outcome (COMPLETED, FAILED_RESULT, FAILED, CANCELLED).",
      ["activity_type", "outcome"]
    ),
    activityFailures: registry.counter(
      "space_worker_activity_failures_total",
      "Failed activity executions by activity type, failure category and stable reason code.",
      ["activity_type", "category", "code"]
    ),
    activityRetries: registry.counter(
      "space_worker_activity_retries_total",
      "Activity executions that are Temporal retries (attempt > 1).",
      ["activity_type"]
    ),
    activityDuration: registry.histogram(
      "space_worker_activity_duration_seconds",
      "Activity execution duration in seconds.",
      ["activity_type"]
    ),
    activityScheduleToStart: registry.histogram(
      "space_worker_activity_schedule_to_start_seconds",
      "Time an activity attempt waited in the Temporal task queue before this worker started it.",
      ["activity_type"],
      [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300]
    ),
    activitiesInFlight: registry.gauge(
      "space_worker_activities_in_flight",
      "Activities currently executing in this worker.",
      ["activity_type"]
    )
  };
}

export type WorkerMetrics = ReturnType<typeof createWorkerMetrics>;

/** The worker process's metrics, rendered by the optional loopback endpoint. */
export const workerMetrics = createWorkerMetrics();

let processMetrics: ProcessMetricsCollector | null = null;

export function renderWorkerMetrics(metrics: WorkerMetrics = workerMetrics): string {
  processMetrics ??= createProcessMetricsCollector();
  const lines = [
    ...processMetrics.renderLines(),
    ...metrics.registry.renderLines({ includeDropped: false }),
    ...renderDroppedSeries([metrics.registry])
  ];
  return `${lines.join("\n")}\n`;
}

const loopbackHosts = new Set(["127.0.0.1", "::1"]);

export interface WorkerMetricsListen {
  host: string;
  port: number;
}

/**
 * SPACE_WORKER_METRICS_PORT enables the endpoint (unset or 0 = disabled).
 * SPACE_WORKER_METRICS_HOST may only name a loopback address.
 */
export function resolveWorkerMetricsListen(env: NodeJS.ProcessEnv = process.env): WorkerMetricsListen | null {
  const rawPort = env.SPACE_WORKER_METRICS_PORT?.trim();
  if (!rawPort || rawPort === "0") return null;
  if (!/^\d{1,5}$/.test(rawPort)) return null;
  const port = Number(rawPort);
  if (port < 1024 || port > 65_535) return null;
  const host = env.SPACE_WORKER_METRICS_HOST?.trim() || "127.0.0.1";
  return loopbackHosts.has(host) ? { host, port } : null;
}

/**
 * SPACE_WORKER_TEMPORAL_METRICS_BIND (for example 127.0.0.1:9464) enables the
 * Temporal SDK's own Prometheus exporter: workflow-task and activity
 * schedule-to-start latency, poll and slot metrics. Loopback only; off by default.
 */
export function resolveTemporalCoreMetricsBind(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.SPACE_WORKER_TEMPORAL_METRICS_BIND?.trim();
  if (!raw) return null;
  const match = /^(127\.0\.0\.1|\[::1\]):(\d{4,5})$/.exec(raw);
  if (!match) return null;
  const port = Number(match[2]);
  return port >= 1024 && port <= 65_535 ? raw : null;
}

export function startWorkerMetricsServer(
  listen: WorkerMetricsListen,
  render: () => string = () => renderWorkerMetrics()
): Promise<Server | null> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && (request.url === "/metrics" || request.url?.startsWith("/metrics?"))) {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
      response.end(render());
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  });
  return new Promise((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(listen.port, listen.host, () => {
      server.unref();
      resolve(server);
    });
  });
}
