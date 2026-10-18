const { SpanExporter } = require('@opentelemetry/api');

const otlpExporter = new SpanExporter({
  endpoint: process.env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT,
  maxExportBatchSize: 100,
  maxExportIntervalMs: 1000,
  timeout: 1000
});

export function exportSpan(span: Span): void {
  otlpExporter.export([span]);
  otlpExporter.shutdown();
}

module.exports = exportSpan;