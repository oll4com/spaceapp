/**
 * Optional OTLP/HTTP (JSON) export of API server spans and worker activity spans. Off unless
 * SPACE_OTEL_EXPORTER_OTLP_ENDPOINT names a collector base URL (spans go to
 * `<base>/v1/traces`). No dependency, no collector required: Space logs stay
 * joinable by W3C trace id without it.
 *
 * Spans carry only the method, route template, status code, service name and
 * Space request id; never URLs with parameters, headers, bodies or user data.
 * Export is best effort: a bounded queue drops (and counts) spans instead of
 * growing, each POST has a timeout, and a failing collector never affects a
 * request.
 */

export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes?: Readonly<Record<string, string | number>>;
}

export interface ServerSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Readonly<Record<string, string | number>>;
  error: boolean;
  /** OTLP span kind; SERVER (2) unless given. Worker activities and workflows use INTERNAL (1). */
  kind?: number;
  /** Optional OTLP span links (for continue-as-new and background continuations). */
  links?: readonly SpanLink[];
}

export interface SpanExporterStats {
  exported: number;
  dropped: number;
  failed: number;
}

export interface SpanExporter {
  record(span: ServerSpan): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  stats(): SpanExporterStats;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean }>;

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
const safeIdentifierValuePattern = /^[A-Za-z0-9:._-]{1,240}$/;
const safeRouteTemplatePattern = /^[A-Za-z0-9:._/*-]{1,240}$/;
const forbiddenSecretValuePattern = /(?:^|[^A-Za-z0-9])(sk-[A-Za-z0-9_-]{6,}|Bearer\s+)/i;

export const ALLOWED_SPAN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set<string>([
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "space.request_id",
  "space.trace_id",
  "space.parent_trace_id",
  "space.workflow_type",
  "space.workflow_id",
  "space.run_id",
  "space.parent_workflow_id",
  "space.parent_run_id",
  "space.continued_from_run_id",
  "space.source_run_id",
  "space.activity_type",
  "space.activity_id",
  "space.attempt",
  "space.outcome",
  "space.status",
  "space.reason_code",
  "space.error_code",
  "space.category",
  "space.failure_category",
  "space.duration_ms",
  "space.queue_ms",
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
  "space.change_set_id",
  "space.link_kind"
]);

/** Filters span attributes against the strict key and identifier allowlist. */
export function sanitizeSpanAttributes(
  attributes: Readonly<Record<string, string | number>> | undefined
): Record<string, string | number> {
  if (!attributes) return {};
  const cleaned: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED_SPAN_ATTRIBUTE_KEYS.has(key)) continue;
    if (typeof value === "number") {
      if (Number.isFinite(value)) cleaned[key] = value;
      continue;
    }
    if (typeof value === "string") {
      if (forbiddenSecretValuePattern.test(value)) continue;
      const pattern = key === "http.route" ? safeRouteTemplatePattern : safeIdentifierValuePattern;
      if (pattern.test(value)) cleaned[key] = value;
    }
  }
  return cleaned;
}

/** The collector base URL, or null when export is off or the value is unsafe. */
export function otlpTracesUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/v1/traces`;
}

function attributeValue(value: string | number) {
  return typeof value === "number" && Number.isInteger(value) ? { intValue: String(value) } : { stringValue: String(value) };
}

export function otlpTraceRequest(spans: readonly ServerSpan[], serviceName: string) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: serviceName },
        spans: spans.map(span => {
          const safeAttrs = sanitizeSpanAttributes(span.attributes);
          const validLinks = (span.links ?? []).filter(
            link => traceIdPattern.test(link.traceId) && spanIdPattern.test(link.spanId)
          );
          return {
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId && spanIdPattern.test(span.parentSpanId) ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            kind: span.kind ?? 2,
            startTimeUnixNano: span.startTimeUnixNano.toString(),
            endTimeUnixNano: span.endTimeUnixNano.toString(),
            attributes: Object.entries(safeAttrs).map(([key, value]) => ({ key, value: attributeValue(value) })),
            ...(validLinks.length
              ? {
                  links: validLinks.map(link => {
                    const linkAttrs = sanitizeSpanAttributes(link.attributes);
                    return {
                      traceId: link.traceId,
                      spanId: link.spanId,
                      ...(Object.keys(linkAttrs).length
                        ? { attributes: Object.entries(linkAttrs).map(([key, value]) => ({ key, value: attributeValue(value) })) }
                        : {})
                    };
                  })
                }
              : {}),
            // STATUS_CODE_ERROR or STATUS_CODE_UNSET
            status: { code: span.error ? 2 : 0 }
          };
        })
      }]
    }]
  };
}

export function createOtlpSpanExporter(options: OtlpSpanExporterOptions): SpanExporter {
  const url = otlpTracesUrl(options.endpoint);
  if (!url) throw new Error("Invalid OTLP endpoint.");
  const send: FetchLike = options.fetch ?? ((target, init) => fetch(target, init));
  const batchSize = options.batchSize ?? 256;
  const maxQueue = options.maxQueue ?? 4096;
  const timeoutMs = options.timeoutMs ?? 3000;
  const queue: ServerSpan[] = [];
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
  const flush = (): Promise<void> => {
    if (!inFlight) {
      inFlight = (async () => {
        try {
          while (queue.length) await flushOnce();
        } finally {
          inFlight = null;
        }
      })();
    }
    return inFlight;
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
      queue.push({
        ...span,
        attributes: sanitizeSpanAttributes(span.attributes),
        ...(span.links
          ? {
              links: span.links
                .filter(link => traceIdPattern.test(link.traceId) && spanIdPattern.test(link.spanId))
                .map(link => ({
                  traceId: link.traceId,
                  spanId: link.spanId,
                  ...(link.attributes ? { attributes: sanitizeSpanAttributes(link.attributes) } : {})
                }))
            }
          : {})
      });
      if (queue.length >= batchSize) void flush();
    },
    flush,
    async close() {
      clearInterval(timer);
      await flush();
    },
    stats: () => ({ ...stats })
  };
}

/** The exporter configured by SPACE_OTEL_EXPORTER_OTLP_ENDPOINT, or null when export is off. */
export function otlpSpanExporterFromEnv(env: NodeJS.ProcessEnv, serviceName: string): SpanExporter | null {
  const endpoint = env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT;
  return otlpTracesUrl(endpoint) ? createOtlpSpanExporter({ endpoint: endpoint!, serviceName }) : null;
}
