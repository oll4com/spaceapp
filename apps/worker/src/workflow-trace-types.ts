import type { Sinks } from "@temporalio/workflow";
import type { TraceLink } from "./trace-carrier.js";

/** JSON-safe wire data only; nanoseconds and exporter I/O stay outside the sandbox. */
export interface WorkflowSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  attributes: Record<string, string | number>;
  error: boolean;
  links?: readonly TraceLink[];
}
export interface WorkflowTraceSinks extends Sinks {
  spaceOtel: { record(span: WorkflowSpan): void };
}
