/**
 * Optional OTLP/HTTP (JSON) export of API server spans, workflow spans and worker activity spans.
 * Shared implementation lives in @space/contracts and is re-exported here.
 */
export {
  ALLOWED_SPAN_ATTRIBUTE_KEYS,
  createOtlpSpanExporter,
  isSafeSpanAttributeValue,
  otlpSpanExporterFromEnv,
  otlpTraceRequest,
  otlpTracesUrl,
  sanitizeSpanAttributes,
  type ExportedSpan,
  type OtlpSpanExporterOptions,
  type OtlpSpanLink,
  type ServerSpan,
  type SpanExporter,
  type SpanExporterStats
} from "@space/contracts";
