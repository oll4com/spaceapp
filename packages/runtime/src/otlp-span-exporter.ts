/**
 * Optional OTLP/HTTP (JSON) export of API server spans and worker workflow and
 * activity spans. Off unless
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
  /** Spans this one continues or was caused by (continue-as-new, background continuations). */
  links?: readonly SpanLink[];
}

export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes?: Readonly<Record<string, string | number>>;
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

/** Span attributes as OTLP key/value pairs. */
function otlpAttributes(attributes: Readonly<Record<string, string | number>>) {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: attributeValue(value) }));
}

/** True when a link names a well-formed trace id and span id. */
function validLink(link: SpanLink): boolean {
  return traceIdPattern.test(link.traceId) && spanIdPattern.test(link.spanId);
}

/** OTLP/HTTP JSON export request for `spans` from one service; invalid links are dropped. */
export function otlpTraceRequest(spans: readonly ServerSpan[], serviceName: string) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: serviceName },
        spans: spans.map(span => {
          const links = (span.links ?? []).filter(validLink);
          return {
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            kind: span.kind ?? 2,
            startTimeUnixNano: span.startTimeUnixNano.toString(),
            endTimeUnixNano: span.endTimeUnixNano.toString(),
            attributes: otlpAttributes(span.attributes),
            ...(links.length ? { links: links.map(link => ({ traceId: link.traceId, spanId: link.spanId, attributes: otlpAttributes(link.attributes ?? {}) })) } : {}),
            // STATUS_CODE_ERROR or STATUS_CODE_UNSET
            status: { code: span.error ? 2 : 0 }
          };
        })
      }]
    }]
  };
}

/**
 * A bounded, best-effort OTLP/HTTP span exporter shared by the API and the
 * workers. Spans wait in a queue that drops and counts spans when full, are sent
 * in batches on an interval or when a batch fills, and each POST is bounded by
 * `timeoutMs`, so a slow or failing collector never blocks the caller.
 */
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

  /** Sends one batch from the queue and counts it as exported or failed. */
  const flushOnce = async () => {
    const batch = queue.splice(0, batchSize);
    if (!batch.length) return;
    const signal = AbortSignal.timeout(timeoutMs);
    // The timeout also bounds a transport that ignores the abort signal.
    const timedOut = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    timedOut.catch(() => undefined);
    try {
      const response = await Promise.race([
        send(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(otlpTraceRequest(batch, options.serviceName)),
          signal
        }),
        timedOut
      ]);
      if (response.ok) stats.exported += batch.length;
      else stats.failed += batch.length;
    } catch {
      stats.failed += batch.length;
    }
  };
  /** Sends batches until the queue is empty; concurrent calls share one run. */
  const flush = (): Promise<void> => {
    if (inFlight) return inFlight;
    // An empty queue must not leave a settled promise behind as "in flight":
    // every later flush would return it and nothing would be sent again.
    if (!queue.length) return Promise.resolve();
    let running: Promise<void> | null = null;
    running = (async () => {
      try {
        while (queue.length) await flushOnce();
      } finally {
        if (inFlight === running) inFlight = null;
      }
    })();
    inFlight = running;
    return inFlight;
  };
  const timer = setInterval(() => void flush(), options.flushIntervalMs ?? 5000);
  timer.unref?.();

  return {
    /** Queues a span with valid ids; drops and counts it when the queue is full. */
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
    /** Stops the interval and sends everything still queued or in flight. */
    async close() {
      clearInterval(timer);
      // A span recorded while a flush is in flight is sent by the next round.
      while (queue.length || inFlight) await flush();
    },
    stats: () => ({ ...stats })
  };
}

/** The exporter configured by SPACE_OTEL_EXPORTER_OTLP_ENDPOINT, or null when export is off. */
export function otlpSpanExporterFromEnv(env: NodeJS.ProcessEnv, serviceName: string): SpanExporter | null {
  const endpoint = env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT;
  return otlpTracesUrl(endpoint) ? createOtlpSpanExporter({ endpoint: endpoint!, serviceName }) : null;
}
