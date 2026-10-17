/**
 * Optional OTLP/HTTP (JSON) export of API server spans and worker workflow/activity
 * spans. Off unless SPACE_OTEL_EXPORTER_OTLP_ENDPOINT names a collector base URL
 * (spans go to `<base>/v1/traces`). No dependency, no collector required: Space logs
 * stay joinable by W3C trace id without it.
 *
 * Spans carry only allowlisted correlation ids, HTTP route templates, status codes,
 * workflow/activity types, attempts, bounded outcomes, bounded error codes and
 * failure categories; never prompts, model output, file paths, URLs with parameters,
 * headers, bodies, error messages or user text.
 * Export is best effort: a bounded queue drops (and counts) spans instead of
 * growing, each POST has a timeout, and a failing collector never affects a
 * request or workflow.
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
  /** OTLP span kind; SERVER (2) unless given. Worker workflows and activities use INTERNAL (1). */
  kind?: number;
  /** Optional OTLP span links (for continueAsNew or background continuation traces). */
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

const httpMethodPattern = /^[A-Z]{3,12}$/;
const httpRoutePattern = /^\/[A-Za-z0-9/_:.*-]{0,239}$/;
const boundedCodePattern = /^[A-Z][A-Z0-9_]{1,95}$/;
const boundedTypePattern = /^[A-Za-z][A-Za-z0-9_:-]{1,127}$/;
const correlationIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,239}$/;
const forbiddenTokenPattern = /^(?:https?:|file:|ws:|wss:|ftp:|sk-[A-Za-z0-9_-]{6,})/i;

type AttributeKind = "int" | "http_method" | "http_route" | "code" | "type" | "id";

const spanAttributeRules: Readonly<Record<string, AttributeKind>> = {
  "http.request.method": "http_method",
  "http.route": "http_route",
  "http.response.status_code": "int",
  "space.request_id": "id",
  "space.trace_id": "id",
  "space.parent_trace_id": "id",
  "space.workflow_id": "id",
  "space.run_id": "id",
  "space.parent_workflow_id": "id",
  "space.parent_run_id": "id",
  "space.continued_from_run_id": "id",
  "space.room_id": "id",
  "space.pane_id": "id",
  "space.mission_id": "id",
  "space.agent_run_id": "id",
  "space.continuation_of_run_id": "id",
  "space.continuation_generation": "int",
  "space.action_id": "id",
  "space.goal_id": "id",
  "space.dot_id": "id",
  "space.turn_id": "id",
  "space.change_set_id": "id",
  "space.consolidation_run_id": "id",
  "space.workflow_type": "type",
  "space.activity_type": "type",
  "space.task_queue": "type",
  "space.attempt": "int",
  "space.outcome": "code",
  "space.error_code": "code",
  "space.reason_code": "code",
  "space.category": "code",
  "space.duration_ms": "int",
  "space.queue_ms": "int"
};

const spanLinkAttributeRules: Readonly<Record<string, AttributeKind>> = {
  "space.link_type": "type",
  "space.source_run_id": "id",
  "space.source_trace_id": "id",
  "space.continuation_generation": "int"
};

export const ALLOWED_SPAN_ATTRIBUTE_KEYS = Object.freeze(Object.keys(spanAttributeRules));
export const ALLOWED_SPAN_LINK_ATTRIBUTE_KEYS = Object.freeze(Object.keys(spanLinkAttributeRules));

function isAllowedAttributeValue(kind: AttributeKind, value: unknown): value is string | number {
  if (kind === "int") {
    return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
  }
  if (typeof value !== "string" || forbiddenTokenPattern.test(value)) return false;
  switch (kind) {
    case "http_method":
      return httpMethodPattern.test(value);
    case "http_route":
      return httpRoutePattern.test(value);
    case "code":
      return boundedCodePattern.test(value);
    case "type":
      return boundedTypePattern.test(value);
    case "id":
      return correlationIdPattern.test(value);
  }
}

/** Filters span attributes against the explicit allowlist and value formats. */
export function sanitizeSpanAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
  rules: Readonly<Record<string, AttributeKind>> = spanAttributeRules
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!attributes) return out;
  for (const [key, value] of Object.entries(attributes)) {
    const kind = rules[key];
    if (kind && isAllowedAttributeValue(kind, value)) {
      out[key] = value;
    }
  }
  return out;
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

function serializeSpanLinks(links: readonly SpanLink[] | undefined) {
  if (!links?.length) return [];
  const out: Array<{ traceId: string; spanId: string; attributes?: Array<{ key: string; value: { intValue: string } | { stringValue: string } }> }> = [];
  for (const link of links) {
    if (!traceIdPattern.test(link.traceId) || !spanIdPattern.test(link.spanId)) continue;
    const sanitized = sanitizeSpanAttributes(link.attributes, spanLinkAttributeRules);
    const attrs = Object.entries(sanitized).map(([key, value]) => ({ key, value: attributeValue(value) }));
    out.push({
      traceId: link.traceId,
      spanId: link.spanId,
      ...(attrs.length ? { attributes: attrs } : {})
    });
  }
  return out;
}

export function otlpTraceRequest(spans: readonly ServerSpan[], serviceName: string) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: serviceName },
        spans: spans.map(span => {
          const sanitized = sanitizeSpanAttributes(span.attributes);
          const validLinks = serializeSpanLinks(span.links);
          return {
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId && spanIdPattern.test(span.parentSpanId) ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            kind: span.kind ?? 2,
            startTimeUnixNano: span.startTimeUnixNano.toString(),
            endTimeUnixNano: span.endTimeUnixNano.toString(),
            attributes: Object.entries(sanitized).map(([key, value]) => ({ key, value: attributeValue(value) })),
            ...(validLinks.length ? { links: validLinks } : {}),
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
      queue.push(span);
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
