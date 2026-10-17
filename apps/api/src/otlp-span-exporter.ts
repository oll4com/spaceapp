/**
 * OTLP/HTTP (JSON) span exporter. The implementation is shared between the API
 * and Temporal workers via @space/runtime. Re-exported here so API code and
 * tests keep their existing imports unchanged.
 */

export {
  createOtlpSpanExporter,
  otlpSpanExporterFromEnv,
  otlpTraceRequest,
  otlpTracesUrl,
  type FetchLike,
  type OtlpSpan,
  type OtlpSpanExporterOptions,
  type OtlpSpanLink,
  type ServerSpan,
  type SpanExporter,
  type SpanExporterStats
} from "@space/runtime";
