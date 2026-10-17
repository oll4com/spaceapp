import type { Sinks } from "@temporalio/workflow";
import type { InjectedSinks } from "@temporalio/worker";
import type { SpanExporter, SpanLink } from "@space/runtime";

export interface WorkflowSpanData {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeUnixNano: string | number | bigint;
  endTimeUnixNano: string | number | bigint;
  attributes: Readonly<Record<string, string | number>>;
  error: boolean;
  kind?: number;
  links?: readonly SpanLink[];
}

export interface WorkflowTracingSinks extends Sinks {
  observability: {
    recordWorkflowSpan(span: WorkflowSpanData): void;
  };
}

/**
 * Temporal Worker sink for exporting workflow spans.
 * With callDuringReplay: false (the default and enforced here), Temporal's isolate
 * runtime suppresses calls to this sink during history replay.
 */
export function createWorkflowTracingSink(spans: SpanExporter | null | undefined): InjectedSinks<WorkflowTracingSinks> {
  return {
    observability: {
      recordWorkflowSpan: {
        fn(_info, span) {
          if (!spans) return;
          spans.record({
            ...span,
            startTimeUnixNano: typeof span.startTimeUnixNano === "bigint" ? span.startTimeUnixNano : BigInt(span.startTimeUnixNano),
            endTimeUnixNano: typeof span.endTimeUnixNano === "bigint" ? span.endTimeUnixNano : BigInt(span.endTimeUnixNano)
          });
        },
        callDuringReplay: false
      }
    }
  };
}
