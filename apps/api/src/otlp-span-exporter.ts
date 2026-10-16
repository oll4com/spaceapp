/**
 * The OTLP span exporter lives in @space/runtime so the API and the Temporal
 * workers share one implementation (bounded queue, per-POST timeout, drop
 * counting). This module re-exports it to keep the API's import path stable.
 */
export {
  createOtlpSpanExporter,
  otlpSpanExporterFromEnv,
  otlpTraceRequest,
  otlpTracesUrl,
  type OtlpSpan,
  type OtlpSpanExporterOptions,
  type OtlpSpanLink,
  type ServerSpan,
  type SpanExporter,
  type SpanExporterStats
} from "@space/runtime";
