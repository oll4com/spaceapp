const { Span, SpanKind } = require('@opentelemetry/api');
const { SpanExporter } = require('@opentelemetry/api');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-otlp-trace');

const otlpExporter = new OTLPTraceExporter({
  endpoint: process.env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT,
});
const spanExporter = new SpanExporter(otlpExporter);

function workflowCorrelationMemo(traceparent: string): any {
  const span = new Span({
    name: 'workflow',
    kind: SpanKind.SERVER,
    traceparent: traceparent
  });
  spanExporter.export([span]);
  return {
    traceparent: traceparent
  };
}

module.exports = workflowCorrelationMemo;