import { createHash } from "node:crypto";
import type { InjectedSinks } from "@temporalio/worker";
import { formatTraceparent, isSafeErrorCode, parseTraceparent } from "@space/contracts";
import type { SpanExporter, SpanLink } from "@space/runtime";

export interface WorkflowSpanRecordInput {
  workflowType: string;
  workflowId: string;
  runId: string;
  traceparent: string | null | undefined;
  traceId?: string | null;
  roomId?: string | null;
  paneId?: string | null;
  missionId?: string | null;
  turnId?: string | null;
  goalId?: string | null;
  parentWorkflowId?: string | null;
  parentRunId?: string | null;
  continuationOfRunId?: string | null;
  linkedTraceparent?: string | null;
  startedAtMs: number;
  endedAtMs: number;
  outcome: "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW";
  reasonCode?: string | null;
  category?: string | null;
}

export interface WorkflowObservabilitySink {
  recordWorkflowSpan(input: WorkflowSpanRecordInput): void;
}

const activeWorkflowSpanIds = new Map<string, string>();

export function deriveWorkflowSpanId(traceId: string, workflowId: string, runId: string): string {
  const digest = createHash("sha256")
    .update(`${traceId}:${workflowId}:${runId}`)
    .digest("hex")
    .slice(0, 16);
  return /^0+$/.test(digest) ? "0000000000000001" : digest;
}

export function registerWorkflowSpanId(workflowId: string, runId: string, spanId: string): void {
  activeWorkflowSpanIds.set(`${workflowId}::${runId}`, spanId);
  while (activeWorkflowSpanIds.size > 4096) {
    const oldest = activeWorkflowSpanIds.keys().next().value;
    if (oldest === undefined) break;
    activeWorkflowSpanIds.delete(oldest);
  }
}

export function lookupRegisteredWorkflowSpanId(workflowId: string | null | undefined, runId: string | null | undefined): string | null {
  if (!workflowId || !runId) return null;
  return activeWorkflowSpanIds.get(`${workflowId}::${runId}`) ?? null;
}

export function childWorkflowTraceparent(
  parentTraceparent: string | null | undefined,
  parentWorkflowId: string,
  parentRunId: string
): string | null {
  const parsed = parseTraceparent(parentTraceparent);
  if (!parsed) return null;
  const wfSpanId = deriveWorkflowSpanId(parsed.traceId, parentWorkflowId, parentRunId);
  registerWorkflowSpanId(parentWorkflowId, parentRunId, wfSpanId);
  return formatTraceparent(parsed.traceId, wfSpanId, parsed.flags);
}

export function createWorkflowObservabilitySinks(options: {
  spans?: SpanExporter | null;
} = {}): InjectedSinks<{ observability: WorkflowObservabilitySink }> {
  return {
    observability: {
      recordWorkflowSpan: {
        // Never emit duplicate spans when Temporal replays workflow history.
        callDuringReplay: false,
        fn(workflowInfo, input: WorkflowSpanRecordInput) {
          if (!options.spans) return;
          const parsed = parseTraceparent(input.traceparent);
          if (!parsed) return;
          const wfId = input.workflowId || workflowInfo.workflowId;
          const rId = input.runId || workflowInfo.runId;
          const wfType = input.workflowType || workflowInfo.workflowType;
          const spanId = deriveWorkflowSpanId(parsed.traceId, wfId, rId);
          registerWorkflowSpanId(wfId, rId, spanId);

          const attributes: Record<string, string | number> = {
            "space.workflow_type": wfType,
            "space.workflow_id": wfId,
            "space.run_id": rId,
            "space.outcome": input.outcome,
            "space.duration_ms": Math.max(0, input.endedAtMs - input.startedAtMs)
          };
          if (input.traceId) attributes["space.trace_id"] = input.traceId;
          if (input.roomId) attributes["space.room_id"] = input.roomId;
          if (input.paneId) attributes["space.pane_id"] = input.paneId;
          if (input.missionId) attributes["space.mission_id"] = input.missionId;
          if (input.turnId) attributes["space.turn_id"] = input.turnId;
          if (input.goalId) attributes["space.goal_id"] = input.goalId;
          if (input.parentWorkflowId) attributes["space.parent_workflow_id"] = input.parentWorkflowId;
          if (input.parentRunId) attributes["space.parent_run_id"] = input.parentRunId;
          if (input.continuationOfRunId) attributes["space.continuation_of"] = input.continuationOfRunId;
          if (input.reasonCode && isSafeErrorCode(input.reasonCode)) {
            attributes["space.reason_code"] = input.reasonCode;
          }
          if (input.category) {
            attributes["space.category"] = input.category;
          }

          const links: SpanLink[] = [];
          const linked = parseTraceparent(input.linkedTraceparent);
          if (linked) {
            links.push({
              traceId: linked.traceId,
              spanId: linked.parentId,
              ...(input.continuationOfRunId
                ? { attributes: { "space.continuation_of": input.continuationOfRunId } }
                : {})
            });
          }

          options.spans.record({
            traceId: parsed.traceId,
            spanId,
            parentSpanId: parsed.parentId,
            name: `workflow ${wfType}`,
            startTimeUnixNano: BigInt(input.startedAtMs) * 1_000_000n,
            endTimeUnixNano: BigInt(Math.max(input.startedAtMs, input.endedAtMs)) * 1_000_000n,
            attributes,
            error: input.outcome === "FAILED",
            kind: 1,
            ...(links.length > 0 ? { links } : {})
          });
        }
      }
    }
  };
}
