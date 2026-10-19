import type { Sinks } from "@temporalio/workflow";

export type WorkflowSpanOutcome = "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW";
export type WorkflowSpanLinkReason = "continue_as_new" | "background_continuation";

export interface WorkflowSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  startTimeMs: number;
  endTimeMs: number;
  outcome: WorkflowSpanOutcome;
  errorCode: string | null;
  correlation: { spaceTraceId?: string; roomId?: string; paneId?: string; missionId?: string; goalId?: string };
  links: Array<{ traceId: string; spanId: string; reason: WorkflowSpanLinkReason }>;
}

export interface SpaceTracingSinks extends Sinks {
  spaceTracing: { workflowSpan(record: WorkflowSpanRecord): void };
}

