/**
 * Optional OTLP/HTTP (JSON) span export, shared by the API and the Temporal
 * workers. Off unless SPACE_OTEL_EXPORTER_OTLP_ENDPOINT names a collector base
 * URL (spans go to `<base>/v1/traces`). No dependency, no collector required:
 * Space logs stay joinable by W3C trace id without it.
 *
 * Spans carry allowlisted attributes only (ids, types, attempt, status and
 * stable error codes); never prompts, model output, file paths, URLs, error
 * messages or user text. Export is best effort: a bounded queue drops (and
 * counts) spans instead of growing, each POST has a timeout, and a slow or
 * failing collector never delays or fails request, workflow or activity work.
 */

export interface OtlpSpanLink {
  traceId: string;
  spanId: string;
  attributes?: Readonly<Record<string, string | number>>;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  /** OTLP span kind. Defaults to 2 (SPAN_KIND_SERVER), the API request span kind. */
  kind?: number;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Readonly<Record<string, string | number>>;
  error: boolean;
  /** Links to spans in the same or another trace (continue-as-new, background continuations). */
  links?: readonly OtlpSpanLink[];
}

/** The original API span shape; identical to OtlpSpan. */
export type ServerSpan = OtlpSpan;

export interface SpanExporterStats {
  exported: number;
  dropped: number;
  failed: number;
}

export interface SpanExporter {
  record(span: OtlpSpan): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  stats(): SpanExporterStats;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean }>;

export interface OtlpSpanExporterOptions {
  endpoint: string;
  serviceName: string;
  /** Instrumentation scope name in the export payload. Defaults to "space-api". */
  scopeName?: string;
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
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/v1/traces`;
}

function attributeValue(value: string | number) {
  return typeof value === "number" && Number.isInteger(value) ? { intValue: String(value) } : { stringValue: String(value) };
}

function attributesPayload(attributes: Readonly<Record<string, string | number>>) {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: attributeValue(value) }));
}

export function otlpTraceRequest(spans: readonly OtlpSpan[], serviceName: string, scopeName = "space-api") {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: scopeName },
        spans: spans.map(span => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          // span.kind when set (worker spans use 1, SPAN_KIND_INTERNAL);
          // SPAN_KIND_SERVER by default so API output is unchanged.
          kind: span.kind ?? 2,
          startTimeUnixNano: span.startTimeUnixNano.toString(),
          endTimeUnixNano: span.endTimeUnixNano.toString(),
          attributes: attributesPayload(span.attributes),
          ...(span.links?.length ? {
            links: span.links
              .filter(link => traceIdPattern.test(link.traceId) && spanIdPattern.test(link.spanId))
              .map(link => ({
                traceId: link.traceId,
                spanId: link.spanId,
                ...(link.attributes ? { attributes: attributesPayload(link.attributes) } : {})
              }))
          } : {}),
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
  const queue: OtlpSpan[] = [];
  const stats: SpanExporterStats = { exported: 0, dropped: 0, failed: 0 };
  let inFlight: Promise<void> | null = null;

  const flushOnce = async () => {
    const batch = queue.splice(0, batchSize);
    if (!batch.length) return;
    try {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(otlpTraceRequest(batch, options.serviceName, options.scopeName)),
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
      // Defer the drain to a microtask: with an empty queue an async body
      // would otherwise run to completion (including the finally that clears
      // inFlight) before the assignment below stores the promise, wedging
      // inFlight non-null forever and silently disabling every later flush.
      inFlight = Promise.resolve().then(async () => {
        try {
          while (queue.length) await flushOnce();
        } finally {
          inFlight = null;
        }
      });
    }
    return inFlight;
  };
  const timer = setInterval(() => void flush(), options.flushIntervalMs ?? 5000);
  timer.unref?.();

  return {
    record(span) {
      if (!traceIdPattern.test(span.traceId) || !spanIdPattern.test(span.spanId)) return;
      if (span.parentSpanId !== null && !spanIdPattern.test(span.parentSpanId)) return;
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
export function otlpSpanExporterFromEnv(env: NodeJS.ProcessEnv, serviceName: string, scopeName?: string): SpanExporter | null {
  const endpoint = env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT;
  return otlpTracesUrl(endpoint) ? createOtlpSpanExporter({ endpoint: endpoint!, serviceName, scopeName }) : null;
}
