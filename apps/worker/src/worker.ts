const { SpanProcessor } = require('@opentelemetry/api');
const { SimpleSpanProcessor } = require('@opentelemetry/tracing');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-otlp-trace');
const { SpanKind } = require('@opentelemetry/api');

const otlpExporter = new OTLPTraceExporter({
  endpoint: process.env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT,
  headers: {
    'x-otlp-endpoint': 'http://localhost:4317',
  },
});
const spanProcessor = new SimpleSpanProcessor(otlpExporter);

const traceProvider = require('@opentelemetry/tracing').traceProvider;
traceProvider.addSpanProcessor(spanProcessor);

// ... rest of worker code ...