/**
 * Optional OTLP/HTTP (JSON) span export. Off unless
 * SPACE_OTEL_EXPORTER_OTLP_ENDPOINT names a collector base URL (spans go to
 * `<base>/v1/traces`). No dependency, no collector required: Space logs stay
 * joinable by W3C trace id without it.
 *
 * Callers select the attributes they are allowed to disclose; this transport
 * preserves those attribute values without applying a service-specific policy.
 * Export is best effort: a bounded queue drops (and counts) spans instead of
 * growing, each POST has a timeout, and a failing collector never affects a
 * request.
 */

export interface SpanLink {
  traceId: string;
  spanId: string;
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
  /** OTLP SpanKind; existing API callers retain SERVER (2) by default. */
  kind?: number;
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
const validId = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value) && !/^0+$/.test(value);
const validTraceId = (value: unknown) => validId(value, traceIdPattern);
const validSpanId = (value: unknown) => validId(value, spanIdPattern);

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

export function otlpTraceRequest(spans: readonly ServerSpan[], serviceName: string, scopeName = serviceName) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: scopeName },
        spans: spans.filter(span => validTraceId(span.traceId) && validSpanId(span.spanId)).map(span => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(validSpanId(span.parentSpanId) ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: Number.isInteger(span.kind) && span.kind! >= 0 && span.kind! <= 5 ? span.kind! : 2,
          startTimeUnixNano: span.startTimeUnixNano.toString(),
          endTimeUnixNano: span.endTimeUnixNano.toString(),
          attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: attributeValue(value) })),
          // STATUS_CODE_ERROR or STATUS_CODE_UNSET
          status: { code: span.error ? 2 : 0 },
          ...(Array.isArray(span.links) && span.links.length ? { links: span.links
            .filter(link => link && validTraceId(link.traceId) && validSpanId(link.spanId))
            .map(link => ({ traceId: link.traceId, spanId: link.spanId })) } : {})
        }))
      }]
    }]
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

export function createOtlpSpanExporter(options: OtlpSpanExporterOptions): SpanExporter {
  const url = otlpTracesUrl(options.endpoint);
  if (!url) throw new Error("Invalid OTLP endpoint.");
  const send: FetchLike = options.fetch ?? ((target, init) => fetch(target, init));
  const batchSize = positiveInteger(options.batchSize ?? 256, "batchSize");
  const maxQueue = positiveInteger(options.maxQueue ?? 4096, "maxQueue");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 3000, "timeoutMs");
  const flushIntervalMs = positiveInteger(options.flushIntervalMs ?? 5000, "flushIntervalMs");
  const queue: ServerSpan[] = [];
  const stats: SpanExporterStats = { exported: 0, dropped: 0, failed: 0 };
  let inFlight: Promise<void> | null = null;
  let closed = false;

  const flushOnce = async () => {
    const batch = queue.splice(0, batchSize);
    if (!batch.length) return;
    const controller = new AbortController();
    let timeout!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<null>((resolve) => {
      timeout = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
      timeout.unref?.();
    });
    try {
      // Bound flush even if an injected transport ignores its AbortSignal.
      const response = await Promise.race([send(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(otlpTraceRequest(batch, options.serviceName, options.scopeName)),
        signal: controller.signal
      }), deadline]);
      if (response?.ok) stats.exported += batch.length;
      else stats.failed += batch.length;
    } catch {
      stats.failed += batch.length;
    } finally {
      clearTimeout(timeout);
    }
  };
  const flush = (): Promise<void> => {
    // Avoid caching an already-resolved promise after a quiet interval, which
    // would otherwise prevent later records from starting a new flush.
    if (!inFlight && !queue.length) return Promise.resolve();
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
  const timer = setInterval(() => void flush(), flushIntervalMs);
  timer.unref?.();

  return {
    record(span) {
      if (!validTraceId(span.traceId) || !validSpanId(span.spanId)) return;
      if (closed || queue.length >= maxQueue) {
        stats.dropped += 1;
        return;
      }
      queue.push(span);
      if (queue.length >= batchSize) void flush();
    },
    flush,
    async close() {
      closed = true;
      clearInterval(timer);
      await flush();
    },
    stats: () => ({ ...stats })
  };
}

/** The exporter configured by SPACE_OTEL_EXPORTER_OTLP_ENDPOINT, or null when export is off. */
export function otlpSpanExporterFromEnv(env: NodeJS.ProcessEnv, serviceName: string, scopeName = serviceName): SpanExporter | null {
  const endpoint = env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT;
  return otlpTracesUrl(endpoint) ? createOtlpSpanExporter({ endpoint: endpoint!, serviceName, scopeName }) : null;
}
