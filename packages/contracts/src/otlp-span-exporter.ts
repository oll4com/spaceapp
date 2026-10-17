/**
 * Optional OTLP/HTTP (JSON) export of spans for API requests, Temporal
 * workflows and activity attempts. Off unless SPACE_OTEL_EXPORTER_OTLP_ENDPOINT
 * names a collector base URL (spans go to `<base>/v1/traces`).
 *
 * No external tracing dependencies: Space traces adhere to W3C Trace Context
 * and OTLP JSON.
 *
 * Spans carry strictly allowlisted attributes; never prompts, model outputs,
 * file paths, URLs or raw error messages. Export is best effort: a bounded
 * queue drops (and counts) spans instead of growing indefinitely, each POST
 * has a timeout, and a failing or slow collector never blocks or fails
 * requests, workflows or activities.
 */

export interface OtlpSpanLink {
  traceId: string;
  spanId: string;
  attributes?: Readonly<Record<string, string | number>>;
}

export interface ExportedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  kind?: number;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Readonly<Record<string, string | number>>;
  error?: boolean;
  links?: readonly OtlpSpanLink[];
}

export type ServerSpan = ExportedSpan;

export interface SpanExporterStats {
  exported: number;
  dropped: number;
  failed: number;
}

export interface SpanExporter {
  record(span: ExportedSpan): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  stats(): SpanExporterStats;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ ok: boolean }>;

export interface OtlpSpanExporterOptions {
  endpoint: string;
  serviceName: string;
  fetch?: FetchLike;
  batchSize?: number;
  maxQueue?: number;
  flushIntervalMs?: number;
  timeoutMs?: number;
}

const hexId = (length: number) => new RegExp(`^[0-9a-f]{${length}}$`);
const traceIdPattern = hexId(32);
const spanIdPattern = hexId(16);

/** The collector base URL, or null when export is off or the value is unsafe. */
export function otlpTracesUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/v1/traces`;
}

function attributeValue(value: string | number) {
  return typeof value === "number" && Number.isInteger(value)
    ? { intValue: String(value) }
    : { stringValue: String(value) };
}

export function otlpTraceRequest(spans: readonly ExportedSpan[], serviceName: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
        scopeSpans: [
          {
            scope: { name: serviceName },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: span.kind ?? 2,
              startTimeUnixNano: span.startTimeUnixNano.toString(),
              endTimeUnixNano: span.endTimeUnixNano.toString(),
              attributes: Object.entries(span.attributes).map(([key, value]) => ({
                key,
                value: attributeValue(value)
              })),
              status: { code: span.error ? 2 : 0 },
              ...(span.links?.length
                ? {
                    links: span.links.map((link) => ({
                      traceId: link.traceId,
                      spanId: link.spanId,
                      ...(link.attributes && Object.keys(link.attributes).length
                        ? {
                            attributes: Object.entries(link.attributes).map(([k, v]) => ({
                              key: k,
                              value: attributeValue(v)
                            }))
                          }
                        : {})
                    }))
                  }
                : {})
            }))
          }
        ]
      }
    ]
  };
}

export function createOtlpSpanExporter(options: OtlpSpanExporterOptions): SpanExporter {
  const url = otlpTracesUrl(options.endpoint);
  if (!url) throw new Error("Invalid OTLP endpoint.");
  const send: FetchLike = options.fetch ?? ((target, init) => fetch(target, init));
  const batchSize = options.batchSize ?? 256;
  const maxQueue = options.maxQueue ?? 4096;
  const timeoutMs = options.timeoutMs ?? 3000;
  const queue: ExportedSpan[] = [];
  const stats: SpanExporterStats = { exported: 0, dropped: 0, failed: 0 };
  let inFlight: Promise<void> | null = null;

  const flushOnce = async () => {
    const batch = queue.splice(0, batchSize);
    if (!batch.length) return;
    try {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(otlpTraceRequest(batch, options.serviceName)),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.ok) stats.exported += batch.length;
      else stats.failed += batch.length;
    } catch {
      stats.failed += batch.length;
    }
  };

  const flush = async (): Promise<void> => {
    while (inFlight) {
      await inFlight;
    }
    if (queue.length) {
      inFlight = (async () => {
        try {
          while (queue.length) await flushOnce();
        } finally {
          inFlight = null;
        }
      })();
      await inFlight;
    }
  };

  const timer = setInterval(() => void flush(), options.flushIntervalMs ?? 5000);
  timer.unref?.();

  return {
    record(span) {
      if (!traceIdPattern.test(span.traceId) || !spanIdPattern.test(span.spanId)) return;
      if (queue.length >= maxQueue) {
        stats.dropped += 1;
        return;
      }
      queue.push(span);
      if (queue.length >= batchSize) void flush();
    },
    flush,
    async close() {
      clearInterval(timer);
      while (inFlight) {
        await inFlight;
      }
      while (queue.length) {
        await flushOnce();
      }
    },
    stats: () => ({ ...stats })
  };
}

/** The exporter configured by SPACE_OTEL_EXPORTER_OTLP_ENDPOINT, or null when export is off. */
export function otlpSpanExporterFromEnv(env: NodeJS.ProcessEnv, serviceName: string): SpanExporter | null {
  const endpoint = env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT;
  return otlpTracesUrl(endpoint) ? createOtlpSpanExporter({ endpoint: endpoint!, serviceName }) : null;
}

// ── Attribute allowlist and sanitization ─────────────────────────────────

export const ALLOWED_SPAN_ATTRIBUTE_KEYS = new Set<string>([
  // Service
  "service.name",
  // HTTP (API)
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "space.request_id",
  // Temporal Workflow
  "workflow.type",
  "workflow.id",
  "workflow.run_id",
  "workflow.parent_id",
  "workflow.parent_run_id",
  "workflow.status",
  // Temporal Activity
  "activity.type",
  "activity.id",
  "activity.attempt",
  "activity.outcome",
  "space.activity_type",
  "space.outcome",
  "space.attempt",
  "space.source_run_id",
  // Correlation identifiers
  "traceId",
  "w3cTraceId",
  "parentTraceId",
  "space.trace_id",
  "space.room_id",
  "space.pane_id",
  "space.mission_id",
  "space.agent_run_id",
  "space.agent_session_id",
  "space.action_id",
  "space.goal_id",
  "space.dot_id",
  "space.turn_id",
  "space.cli_task_id",
  "space.revision_id",
  "roomId",
  "paneId",
  "missionId",
  "agentRunId",
  "agentSessionId",
  "actionId",
  "goalId",
  "dotId",
  "turnId",
  "cliTaskId",
  "revisionId",
  // Errors and failure categories
  "error.code",
  "error.category",
  "reasonCode",
  "category",
  // Timings and counts
  "duration_ms",
  "queue_ms",
  "attempt"
]);

export function isSafeSpanAttributeValue(key: string, value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "string") return false;
  // Never export URLs
  if (/^https?:\/\//i.test(value)) return false;
  // Never export file paths (except http.route templates like /api/rooms/:roomId)
  if (key !== "http.route" && (/^\/|^\.\/|\\/.test(value) || value.includes("/"))) return false;
  // Never export multi-line text, prompts, JSON objects, or serialized structures
  if (/[\r\n]/.test(value) || value.includes("{") || value.includes("}")) return false;
  // Length cap for safe identifiers/codes
  if (value.length > 256) return false;
  return true;
}

export function sanitizeSpanAttributes(
  attributes: Readonly<Record<string, unknown>>
): Record<string, string | number> {
  const sanitized: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED_SPAN_ATTRIBUTE_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = value;
    } else if (typeof value === "string" && isSafeSpanAttributeValue(key, value)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
