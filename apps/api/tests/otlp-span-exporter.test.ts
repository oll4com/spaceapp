import { SpanExporter } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-otlp-trace';
import { SpanProcessor } from '@opentelemetry/api';
import { SimpleSpanProcessor } from '@opentelemetry/tracing';
import { traceProvider } from '@opentelemetry/tracing';

describe('OTLP Span Exporter', () => {
  it('should export spans to OTLP', async () => {
    const exporter = new OTLPTraceExporter({
      endpoint: 'http://localhost:4317',
    });
    const processor = new SimpleSpanProcessor(exporter);
    traceProvider.addSpanProcessor(processor);

    const span = new Span({
      name: 'test-span',
      kind: SpanKind.SERVER,
    });
    span.end();

    await new Promise(resolve => setTimeout(resolve, 100));

    // TODO: Implement assertion to check if the span was exported to OTLP
  });
});