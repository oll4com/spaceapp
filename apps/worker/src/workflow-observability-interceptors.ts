import {
  ContinueAsNew, isCancellation, proxySinks, workflowInfo,
  type Sinks, type WorkflowInterceptorsFactory
} from "@temporalio/workflow";
import { categorizeFailureCode, isSafeErrorCode } from "@space/contracts";
import {
  correlationSpanAttributes, headersWithSpanContext, resolveWorkflowSpanContext, spanCorrelation,
  type WorkflowSpanReport
} from "./workflow-span-context.js";

export interface WorkflowSpanSinks extends Sinks {
  workerTracing: { finish(report: WorkflowSpanReport): void };
}

/** No I/O here: the worker's non-replay sink owns the exporter. */
export const interceptors: WorkflowInterceptorsFactory = () => {
  const { workerTracing } = proxySinks<WorkflowSpanSinks>();
  let report: WorkflowSpanReport | null = null;
  return {
    inbound: [{
      async execute(input, next) {
        const info = workflowInfo();
        report = {
          ...resolveWorkflowSpanContext({ ...input, workflowId: info.workflowId, runId: info.runId, memo: info.memo }),
          startedAt: info.runStartTime.getTime(), finishedAt: 0, outcome: "COMPLETED",
          attributes: correlationSpanAttributes(spanCorrelation(input.args))
        };
        try { return await next(input); }
        catch (error) {
          if (error instanceof ContinueAsNew) report.outcome = "CONTINUED_AS_NEW";
          else if (isCancellation(error)) report.outcome = "CANCELLED";
          else {
            report.outcome = "FAILED";
            const code = (error as { code?: unknown; type?: unknown } | null)?.code
              ?? (error as { type?: unknown } | null)?.type;
            report.reasonCode = isSafeErrorCode(code) ? code : "WORKFLOW_ERROR";
          }
          throw error;
        } finally {
          report.finishedAt = Date.now();
          if (report.reasonCode) report.attributes["space.category"] = categorizeFailureCode(report.reasonCode);
          workerTracing.finish(report);
        }
      }
    }],
    outbound: [{
      scheduleActivity: (input, next) => next(report ? { ...input, headers: headersWithSpanContext(input.headers, report.context) } : input),
      scheduleLocalActivity: (input, next) => next(report ? { ...input, headers: headersWithSpanContext(input.headers, report.context) } : input),
      startChildWorkflowExecution: (input, next) => next(report ? { ...input, headers: headersWithSpanContext(input.headers, report.context) } : input),
      continueAsNew: (input, next) => next(report ? {
        ...input, headers: headersWithSpanContext(input.headers, { ...report.context, link: true })
      } : input)
    }]
  };
};
