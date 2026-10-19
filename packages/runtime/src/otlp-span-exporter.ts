/**
 * Optional, dependency-free OTLP/HTTP JSON span export. Callers provide only
 * allowlisted attributes; this module never reads request or workflow data.
 *
 * Export is best effort: a bounded queue drops (and counts) spans instead of
 * growing, each POST has a deadline, and collector failures never escape to
 * callers. Import this module only in host code, outside workflow sandboxes.
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
  /** OTLP span kind; SERVER (2) unless given. Worker spans use INTERNAL (1). */
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
  /** Instrumentation scope; defaults to the service name. */
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
const zeroIdPattern = /^0+$/;

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

function validLink(link: SpanLink): boolean {
  return traceIdPattern.test(link.traceId) && spanIdPattern.test(link.spanId)
    && !zeroIdPattern.test(link.traceId) && !zeroIdPattern.test(link.spanId);
}

export function otlpTraceRequest(spans: readonly ServerSpan[], serviceName: string, scopeName = serviceName) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: scopeName },
        spans: spans.map(span => {
          const links = span.links?.filter(validLink).map(link => ({ traceId: link.traceId, spanId: link.spanId }));
          return {
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            kind: span.kind ?? 2,
            startTimeUnixNano: span.startTimeUnixNano.toString(),
            endTimeUnixNano: span.endTimeUnixNano.toString(),
            attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: attributeValue(value) })),
            ...(links?.length ? { links } : {}),
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
  let closed = false;

  const flushOnce = async () => {
    const batch = queue.splice(0, batchSize);
    if (!batch.length) return;
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // Race as well as abort: a custom transport that ignores the signal must
      // not keep close() or subsequent batches waiting indefinitely.
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          const error = new DOMException("OTLP export timed out.", "TimeoutError");
          controller.abort(error);
          reject(error);
        }, timeoutMs);
        deadline.unref?.();
      });
      const response = await Promise.race([send(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(otlpTraceRequest(batch, options.serviceName, options.scopeName)),
        signal: controller.signal
      }), timeout]);
      if (response.ok) stats.exported += batch.length;
      else stats.failed += batch.length;
    } catch {
      stats.failed += batch.length;
    } finally {
      clearTimeout(deadline);
    }
  };
  const flush = (): Promise<void> => {
    if (inFlight) return inFlight;
    // Do not store a completed empty flush: its synchronous finally would run
    // before assignment and leave inFlight permanently pointing at it.
    if (!queue.length) return Promise.resolve();
    inFlight = (async () => {
      try {
        while (queue.length) await flushOnce();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
  const timer = setInterval(() => void flush(), options.flushIntervalMs ?? 5000);
  timer.unref?.();

  return {
    record(span) {
      if (!traceIdPattern.test(span.traceId) || !spanIdPattern.test(span.spanId)) return;
      if (closed || queue.length >= maxQueue) {
        stats.dropped += 1;
        return;
      }
      queue.push(span);
      if (queue.length >= batchSize) void flush();
    },
    flush,
    async close() {
      // Freeze the drain set so producers cannot extend shutdown indefinitely.
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
