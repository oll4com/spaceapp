import type { InjectedSinks } from "@temporalio/worker";
import type { Sinks, WorkflowInfo } from "@temporalio/workflow";
import type { ServerSpan, SpanExporter } from "@space/runtime";
import { workflowSpanRegistry } from "./workflow-span-registry.js";

export interface WorkflowStartPayload {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  workflowType: string;
  workflowId: string;
  runId: string;
  startedAtMs: number;
}

export interface WorkflowSpanPayload extends WorkflowStartPayload {
  endedAtMs: number;
  status: "COMPLETED" | "FAILED" | "CONTINUED_AS_NEW";
  errorName?: string | null;
  attributes?: Record<string, string | number>;
}

export interface WorkflowTraceSinks extends Sinks {
  trace: {
    recordWorkflowStart(payload: WorkflowStartPayload): void;
    recordWorkflowSpan(payload: WorkflowSpanPayload): void;
  };
}

export function createWorkflowTraceSinks(spans: SpanExporter | null): InjectedSinks<WorkflowTraceSinks> {
  return {
    trace: {
      recordWorkflowStart: {
        fn(_info: WorkflowInfo, payload: WorkflowStartPayload) {
          workflowSpanRegistry.register(payload.runId, {
            traceId: payload.traceId,
            spanId: payload.spanId,
            workflowType: payload.workflowType
          });
        },
        callDuringReplay: false
      },
      recordWorkflowSpan: {
        fn(_info: WorkflowInfo, payload: WorkflowSpanPayload) {
          workflowSpanRegistry.evict(payload.runId);
          if (!spans) return;

          const span: ServerSpan = {
            traceId: payload.traceId,
            spanId: payload.spanId,
            parentSpanId: payload.parentSpanId,
            name: `workflow ${payload.workflowType}`,
            startTimeUnixNano: BigInt(payload.startedAtMs) * 1_000_000n,
            endTimeUnixNano: BigInt(payload.endedAtMs) * 1_000_000n,
            attributes: {
              "space.workflow_type": payload.workflowType,
              "space.workflow_id": payload.workflowId,
              "space.temporal_run_id": payload.runId,
              "space.outcome": payload.status,
              ...(payload.attributes ?? {})
            },
            error: payload.status === "FAILED",
            kind: 1 // INTERNAL
          };

          spans.record(span);
        },
        callDuringReplay: false
      }
    }
  };
}
