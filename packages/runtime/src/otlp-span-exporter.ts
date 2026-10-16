/**
 * Optional OTLP/HTTP (JSON) export of spans for API server and Temporal workers.
 * Off unless SPACE_OTEL_EXPORTER_OTLP_ENDPOINT names a collector base URL (spans
 * go to `<base>/v1/traces`). No dependency, no collector required.
 *
 * Spans carry only strictly allowlisted identifiers and metrics (IDs, types,
 * status codes, attempts, durations); never URLs with parameters, query strings,
 * headers, bodies, prompts or user data.
 * Export is best effort: a bounded queue drops (and counts) spans instead of
 * growing indefinitely, each POST has a timeout, and a slow or failing collector
 * never blocks or affects business execution.
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
  kind?: number;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Readonly<Record<string, string | number>>;
  error: boolean;
  links?: readonly OtlpSpanLink[];
}

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

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean }>;

export interface OtlpSpanExporterOptions {
  endpoint: string;
  serviceName: string;
  scopeName?: string;
  fetch?: FetchLike;
  batchSize?: number;
  maxQueue?: number;
  flushIntervalMs?: number;
  timeoutMs?: number;
}

const hexId = (length: number) => new RegExp(`^[0-9a-f]{${length}}$`);
export const traceIdPattern = hexId(32);
export const spanIdPattern = hexId(16);

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

export function otlpTraceRequest(spans: readonly OtlpSpan[], serviceName: string, scopeName?: string) {
  const resolvedScope = scopeName ?? (serviceName === "space-api" ? "space-api" : "space-worker");
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: resolvedScope },
        spans: spans.map(span => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: span.kind ?? (serviceName === "space-api" ? 2 : 1),
          startTimeUnixNano: span.startTimeUnixNano.toString(),
          endTimeUnixNano: span.endTimeUnixNano.toString(),
          attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: attributeValue(value) })),
          status: { code: span.error ? 2 : 0 },
          ...(span.links && span.links.length > 0 ? {
            links: span.links.map(link => ({
              traceId: link.traceId,
              spanId: link.spanId,
              ...(link.attributes && Object.keys(link.attributes).length > 0 ? {
                attributes: Object.entries(link.attributes).map(([key, value]) => ({ key, value: attributeValue(value) }))
              } : {})
            }))
          } : {})
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
export function otlpSpanExporterFromEnv(env: NodeJS.ProcessEnv, serviceName: string, scopeName?: string): SpanExporter | null {
  const endpoint = env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT;
  return otlpTracesUrl(endpoint) ? createOtlpSpanExporter({ endpoint: endpoint!, serviceName, scopeName }) : null;
}
