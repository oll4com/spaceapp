import type { InjectedSinks } from "@temporalio/worker";
import type { SpanExporter } from "@space/runtime";
import type { WorkflowInfo } from "@temporalio/workflow";
import type { WorkflowTraceReport } from "./workflow-otlp-interceptors.js";

/** This sink is disabled during replay by Temporal; no I/O touches Workflow code. */
export function workflowOtlpSinks(spans: SpanExporter | null): InjectedSinks<{
  spaceOtlp: { finished(report: WorkflowTraceReport): void };
}> {
  return {
    spaceOtlp: {
      finished: {
        callDuringReplay: false,
        fn: (_info: WorkflowInfo, report: WorkflowTraceReport) => {
          if (!spans) return;
          spans.record({
            traceId: report.traceId,
            spanId: report.spanId,
            parentSpanId: report.parentSpanId,
            name: `workflow ${report.workflowType}`,
            kind: 1,
            startTimeUnixNano: BigInt(report.startMs) * 1_000_000n,
            endTimeUnixNano: BigInt(Math.max(report.endMs, report.startMs)) * 1_000_000n,
            attributes: {
              "space.workflow_type": report.workflowType,
              "space.workflow_id": report.workflowId,
              "space.run_id": report.runId
            },
            ...((report.continuedFromRunId || report.links?.length) ? {
              links: [
                ...(report.continuedFromRunId ? [{
                  traceId: report.traceId,
                  spanId: (report.continuedFromRunId.replace(/-/g, "").slice(-16) || "0000000000000001")
                }] : []),
                ...(report.links ?? [])
              ]
            } : {}),
            error: report.error
          });
        }
      }
    }
  };
}
