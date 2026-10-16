import { sanitizeSpanAttributes, type SpanLink } from "@space/contracts";

/**
 * Optional OTLP/HTTP (JSON) export of API, workflow and worker activity spans.
 * Off unless SPACE_OTEL_EXPORTER_OTLP_ENDPOINT names a collector base URL
 * (spans go to `<base>/v1/traces`). No dependency, no collector required:
 * Space logs stay joinable by W3C trace id without it.
 *
 * Spans carry only allowlisted identifiers, route templates, status/outcome
 * codes and numeric durations; never URLs with parameters, headers, bodies,
 * prompts, file paths or user data. Export is best effort: a bounded queue
 * drops (and counts) spans instead of growing, each POST has a timeout, and a
 * failing collector never affects request, workflow or activity execution.
 */

export type OtlpSpanKind = 1 | 2 | 3 | 4 | 5;

export interface ServerSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  /** OTLP span kind; SERVER (2) unless given. Worker workflows and activities use INTERNAL (1). */
  kind?: OtlpSpanKind;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Readonly<Record<string, string | number>>;
  links?: readonly SpanLink[];
  error: boolean;
}

export type OtlpSpan = ServerSpan;
export type { SpanLink };

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

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ ok: boolean }>;

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

function isValidHexId(value: string | null | undefined, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value) && !/^0+$/.test(value);
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

function sanitizeLinks(links: readonly SpanLink[] | undefined) {
  if (!links?.length) return undefined;
  const valid = links
    .filter((link) => isValidHexId(link.traceId, traceIdPattern) && isValidHexId(link.spanId, spanIdPattern))
    .map((link) => {
      const attrs = link.attributes ? sanitizeSpanAttributes(link.attributes) : {};
      const entries = Object.entries(attrs).map(([key, value]) => ({ key, value: attributeValue(value) }));
      return {
        traceId: link.traceId,
        spanId: link.spanId,
        ...(entries.length ? { attributes: entries } : {})
      };
    });
  return valid.length ? valid : undefined;
}

export function otlpTraceRequest(spans: readonly ServerSpan[], serviceName: string, scopeName = serviceName) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: scopeName },
        spans: spans.map((span) => {
          const attributes = sanitizeSpanAttributes(span.attributes);
          const links = sanitizeLinks(span.links);
          return {
            traceId: span.traceId,
            spanId: span.spanId,
            ...(isValidHexId(span.parentSpanId, spanIdPattern) ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            // Defaults to SPAN_KIND_SERVER (2) for API compatibility; worker spans pass 1 (INTERNAL).
            kind: span.kind ?? 2,
            startTimeUnixNano: span.startTimeUnixNano.toString(),
            endTimeUnixNano: span.endTimeUnixNano.toString(),
            attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: attributeValue(value) })),
            ...(links ? { links } : {}),
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
  const scopeName = options.scopeName ?? options.serviceName;
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
        body: JSON.stringify(otlpTraceRequest(batch, options.serviceName, scopeName)),
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
      if (!isValidHexId(span.traceId, traceIdPattern) || !isValidHexId(span.spanId, spanIdPattern)) return;
      if (queue.length >= maxQueue) {
        stats.dropped += 1;
        return;
      }
      queue.push({
        ...span,
        parentSpanId: isValidHexId(span.parentSpanId, spanIdPattern) ? span.parentSpanId : null,
        attributes: sanitizeSpanAttributes(span.attributes)
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
