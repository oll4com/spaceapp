import { allowlistSpanAttributes } from "./span-attributes.js";
export { allowlistSpanAttributes, SPAN_ATTRIBUTE_ALLOWLIST } from "./span-attributes.js";

/**
 * Optional OTLP/HTTP (JSON) export of API server spans and worker workflow and
 * activity spans. Off unless SPACE_OTEL_EXPORTER_OTLP_ENDPOINT names a collector
 * base URL (spans go to `<base>/v1/traces`). No dependency, no collector
 * required: Space logs stay joinable by W3C trace id without it.
 *
 * API spans carry only the method, route template, status code, service name and
 * Space request id; never URLs with parameters, headers, bodies or user data.
 * Worker spans pass their attributes through `allowlistSpanAttributes`:
 * identifiers, types, attempts, outcomes, stable error codes and durations only.
 * Export is best effort: a bounded queue drops (and counts) spans instead of
 * growing, each POST has a timeout, and a failing collector never affects a
 * request.
 */

/** OTLP span kind: INTERNAL 1, SERVER 2, CLIENT 3, PRODUCER 4, CONSUMER 5. */
export type SpanKind = 1 | 2 | 3 | 4 | 5;

/** A causal link to a span of another run or trace (continue-as-new, background continuation). */
export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface ServerSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Readonly<Record<string, string | number | boolean>>;
  error: boolean;
  /** OTLP span kind; SERVER (2) unless given. Worker workflows and activities use INTERNAL (1). */
  kind?: SpanKind;
  /** Links to the run or trace this span continues; omitted from the request when empty. */
  links?: readonly SpanLink[];
}

export type ExportSpan = ServerSpan;

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

function attributeValue(value: string | number | boolean) {
  if (typeof value === "boolean") return { boolValue: value };
  return typeof value === "number" && Number.isInteger(value) ? { intValue: String(value) } : { stringValue: String(value) };
}

function encodeAttributes(attributes: Readonly<Record<string, string | number | boolean>>) {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: attributeValue(value) }));
}

function encodeLinks(links: readonly SpanLink[] | undefined) {
  return (links ?? [])
    .filter(link => traceIdPattern.test(link.traceId) && !/^0+$/.test(link.traceId) && spanIdPattern.test(link.spanId) && !/^0+$/.test(link.spanId))
    .map(link => ({
      traceId: link.traceId,
      spanId: link.spanId,
      ...(Object.keys(allowlistSpanAttributes(link.attributes ?? {})).length ? { attributes: encodeAttributes(allowlistSpanAttributes(link.attributes ?? {})) } : {})
    }));
}

export function otlpTraceRequest(spans: readonly ServerSpan[], serviceName: string) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: serviceName },
        spans: spans.map(span => {
          const links = encodeLinks(span.links);
          return {
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            kind: span.kind ?? 2,
            startTimeUnixNano: span.startTimeUnixNano.toString(),
            endTimeUnixNano: span.endTimeUnixNano.toString(),
            attributes: encodeAttributes(span.attributes),
            ...(links.length ? { links } : {}),
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
  const timeoutMs = options.timeoutMs ?? 5000;
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
    if (inFlight) return inFlight;
    // With an empty queue the loop below would finish synchronously and clear
    // inFlight before it is assigned, leaving a settled promise that blocks
    // every later flush.
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
