/** Primitive-only payload passed from a Temporal Workflow isolate into its
 * Node worker sink; never contains prompts, URLs, paths, or exception text.
 */
export interface WorkflowSpanWire {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  workflowId: string;
  workflowType: string;
  runId: string;
  startMs: number;
  endMs: number;
  status: "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED";
  continuedFromRunId: string | null;
  linkedTraceId: string | null;
  linkedSpanId: string | null;
}
