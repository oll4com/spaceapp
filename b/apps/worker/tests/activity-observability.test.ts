import { Span, trace } from '@opentelemetry/api';
import { Activity, ActivityKind } from '@temporalio/activity';
import { SpanKind } from '@opentelemetry/api/build/trace/trace-api';

describe('activity observability', () => {
  it('should start a span for an activity', async () => {
    const activity = new Activity('testActivity', ActivityKind.CLIENT);
    const span = trace.getTracer('worker').startSpan('testActivity', {
      kind: SpanKind.CLIENT,
      parent: trace.getSpan(context.active().traceparent),
    });

    activity.registerSpan(span);

    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.name).toBe('testActivity');
    expect(span.parent).toBeDefined();

    activity.on('finish', () => {
      span.end();
    });

    activity.finish();

    expect(span.status).toBe(Span.Status.OK);
  });
});
