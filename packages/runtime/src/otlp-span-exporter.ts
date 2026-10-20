/**
 * Optional OTLP/HTTP JSON export of API, workflow and activity spans. Off unless
 * SPACE_OTEL_EXPORTER_OTLP_ENDPOINT names a collector base URL (spans go to
 * `<base>/v1/traces`). No dependency, no collector required: Space logs stay
 * joinable by W3C trace id without it.
 *
 * Spans carry allowlisted protocol metadata, identifiers, stable outcome/error
 * codes and durations; never prompts, outputs, URLs, paths or error messages.
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
  /** OTLP span kind; SERVER (2) unless given. Worker activities use INTERNAL (1). */
  kind?: number;
  /** Causal relationships across continue-as-new or background trace boundaries. */
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

const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;
const identifierAttributes = new Set([
  "space.request_id", "space.trace_id", "space.workflow_id", "space.workflow_run_id", "space.workflow_type",
  "space.activity_id", "space.activity_type", "space.room_id", "space.pane_id", "space.mission_id",
  "space.agent_run_id", "space.turn_id", "space.outcome", "space.reason_code", "space.category",
  "space.continued_run_id", "space.continued_agent_run_id"
]);
const numericAttributes = new Set(["http.response.status_code", "space.attempt", "space.duration_ms"]);

/** Export only protocol metadata; unknown keys (including user content) are discarded. */
export function spanAttributes(attributes: Readonly<Record<string, string | number>> | undefined): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  if (!attributes) return result;
  // Preserve the API exporter's original attribute order while filtering.
  for (const [key, value] of Object.entries(attributes)) {
    if (identifierAttributes.has(key) && typeof value === "string" && identifierPattern.test(value)) result[key] = value;
    else if (numericAttributes.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
    else if (key === "http.request.method" && typeof value === "string" && /^[A-Z]{1,20}$/.test(value)) result[key] = value;
    else if (key === "http.route" && typeof value === "string" && value.length <= 200 && /^(?:\/[A-Za-z0-9_:{}/.*-]*|UNMATCHED)$/.test(value)) result[key] = value;
  }
  return result;
}

function nonZeroHex(value: string, pattern: RegExp): boolean {
  return pattern.test(value) && !/^0+$/.test(value);
}

function spanLinks(links: readonly SpanLink[] | undefined): SpanLink[] {
  const result: SpanLink[] = [];
  const seen = new Set<string>();
  // Bound work and payload size even if a caller accidentally supplies a large list.
  for (const link of links?.slice(0, 8) ?? []) {
    if (!nonZeroHex(link.traceId, traceIdPattern) || !nonZeroHex(link.spanId, spanIdPattern)) continue;
    const key = `${link.traceId}:${link.spanId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ traceId: link.traceId, spanId: link.spanId, attributes: spanAttributes(link.attributes) });
  }
  return result;
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
  return typeof value === "number"
    ? Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
    : { stringValue: value };
}

export function otlpTraceRequest(spans: readonly ServerSpan[], serviceName: string) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: serviceName },
        spans: spans.map(span => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: span.kind ?? 2,
          startTimeUnixNano: span.startTimeUnixNano.toString(),
          endTimeUnixNano: span.endTimeUnixNano.toString(),
          attributes: Object.entries(spanAttributes(span.attributes)).map(([key, value]) => ({ key, value: attributeValue(value) })),
          ...(span.links?.length ? { links: spanLinks(span.links).map(link => ({
            traceId: link.traceId,
            spanId: link.spanId,
            attributes: Object.entries(link.attributes ?? {}).map(([key, value]) => ({ key, value: attributeValue(value) }))
          })) } : {}),
          // STATUS_CODE_ERROR or STATUS_CODE_UNSET
          status: { code: span.error ? 2 : 0 }
        }))
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
      if (!nonZeroHex(span.traceId, traceIdPattern) || !nonZeroHex(span.spanId, spanIdPattern)) return;
      if (queue.length >= maxQueue) {
        stats.dropped += 1;
        return;
      }
      // Snapshot only the DTO fields. A later caller mutation cannot add content or
      // retain an unbounded attributes object inside the otherwise bounded queue.
      queue.push({
        traceId: span.traceId, spanId: span.spanId,
        parentSpanId: span.parentSpanId && nonZeroHex(span.parentSpanId, spanIdPattern) ? span.parentSpanId : null,
        name: span.name,
        startTimeUnixNano: span.startTimeUnixNano, endTimeUnixNano: span.endTimeUnixNano,
        attributes: spanAttributes(span.attributes), error: span.error,
        kind: span.kind, links: spanLinks(span.links)
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
