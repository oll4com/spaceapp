import { categorizeFailureCode, traceIdFromTraceparent, type DummyTurnInput, type TurnWorkflowResult } from "@space/contracts";
import { buildCodexAppServerTurnWorkflowId } from "./ids.js";
import { failureReasonScope } from "./activity-observability.js";

type TurnAdapter = "CODEX_APP_SERVER" | "OPENCODE_HTTP" | "CLI_BROKER";
const identifier = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9:._-]{1,512}$/.test(value) ? value : null;

/** Deliberately allowlisted: never spread input, result or Error into a log. */
function identity(input: DummyTurnInput, adapter: TurnAdapter) {
  return {
    schemaVersion: 1, service: "space-worker", event: "turn.activity", adapter,
    traceId: identifier(input.traceId), workflowId: identifier(buildCodexAppServerTurnWorkflowId(input)),
    roomId: identifier(input.roomId), paneId: identifier(input.paneId),
    sessionId: identifier(input.agentSessionId), runId: identifier(input.agentRunId),
    runtimeId: identifier(input.providerId),
    missionId: identifier(input.roomAgentMissionId), w3cTraceId: traceIdFromTraceparent(input.traceparent)
  };
}

function emit(record: Record<string, unknown>) {
  // Logging must not change the execution result when an output sink fails.
  try { console.info(JSON.stringify(record)); } catch {}
}

export function recordTurnStatePersistenceFailure(input: DummyTurnInput) {
  emit({ ...identity(input, "CLI_BROKER"), phase: "STATE_RECORD_FAILED" });
}

/** One local activity span; the persisted trace ID links back to API/audit. */
export async function observeTurnActivity(
  input: DummyTurnInput,
  adapter: TurnAdapter,
  execute: () => Promise<TurnWorkflowResult>,
  signal?: AbortSignal
): Promise<TurnWorkflowResult> {
  const context = identity(input, adapter);
  const started = performance.now();
  emit({ ...context, phase: "STARTED" });
  const metrics = () => ({ elapsedMs: Math.max(0, Math.round(performance.now() - started)), rssBytes: process.memoryUsage().rss });
  const scope = failureReasonScope(execute);
  try {
    const result = await scope.promise;
    // Classified failures are returned, not thrown. The failure recorder noted
    // the reason code, which is the causal error for this trace.
    const reasonCode = result.status === "FAILED" ? scope.reasonCode() : null;
    emit({
      ...context, phase: "FINISHED", status: result.status,
      ...(reasonCode ? { reasonCode, category: categorizeFailureCode(reasonCode) } : {}),
      ...metrics()
    });
    return result;
  } catch (error) {
    emit({ ...context, phase: signal?.aborted ? "CANCELLED" : "FAILED", ...metrics() });
    throw error;
  }
}
