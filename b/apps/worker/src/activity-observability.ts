import { Span, trace } from '@opentelemetry/api';
import { Activity, ActivityKind } from '@temporalio/activity';
import { SpanKind } from '@opentelemetry/api/build/trace/trace-api';

export function startActivitySpan(activity: Activity): void {
  const span = trace.getTracer('worker').startSpan(`${activity.type}`, {
    kind: SpanKind.CLIENT,
    parent: trace.getSpan(context.active().traceparent),
  });

  activity.registerSpan(span);

  activity.on('finish', () => {
    span.end();
  });
