import {
  CODEX_APP_SERVER_TURN_WORKFLOW_TYPE,
  DUMMY_TURN_WORKFLOW_TYPE,
  buildCodexAppServerTurnWorkflowId,
  buildDummyTurnWorkflowId,
  dummyTurnInputSchema,
  turnStartResultSchema,
  type DummyTurnInput,
  type TurnStartResult
} from "@space/contracts";
import { recordWorkflowStart } from "./api-metrics.js";
import { connectTemporalClient, type TemporalClientFactory } from "./temporal-client.js";
import { withTurnTraceparent, workflowCorrelationMemo } from "./trace-context.js";

interface TemporalStarterOptions {
  address: string;
  namespace: string;
  taskQueue: string;
  clientFactory?: TemporalClientFactory;
}

/**
 * Starts one turn workflow. The Space request id (traceId) and the request's
 * W3C traceparent travel in the workflow input and in the Temporal memo, so a
 * workflow found in Temporal leads back to the API request and vice versa.
 */
async function startTurnWorkflow(
  workflowType: string,
  options: TemporalStarterOptions,
  input: DummyTurnInput,
  workflowId: string
): Promise<{ workflowId: string; firstExecutionRunId: string }> {
  let lease;
  try {
    lease = await (options.clientFactory ?? connectTemporalClient)(options);
  } catch (error) {
    recordWorkflowStart(workflowType, "FAILED", error);
    throw error;
  }
  try {
    const handle = await lease.client.workflow.start(workflowType, {
      args: [input],
      taskQueue: options.taskQueue,
      workflowId,
      memo: workflowCorrelationMemo({ traceId: input.traceId, traceparent: input.traceparent })
    });
    recordWorkflowStart(workflowType, "STARTED");
    return { workflowId: handle.workflowId, firstExecutionRunId: handle.firstExecutionRunId };
  } catch (error) {
    recordWorkflowStart(workflowType, "FAILED", error);
    throw error;
  } finally {
    await lease.close();
  }
}

export class TurnStarterDisabledError extends Error {
  constructor(message = "Temporal dummy turns are disabled.") {
    super(message);
    this.name = "TurnStarterDisabledError";
  }
}

export interface TurnStarter {
  plan(input: DummyTurnInput): TurnStartResult;
  start(input: DummyTurnInput): Promise<TurnStartResult>;
}

export class DisabledTurnStarter implements TurnStarter {
  plan(): TurnStartResult {
    throw new TurnStarterDisabledError(
      "Temporal dummy turns are disabled. Set SPACE_ENABLE_DUMMY_TURNS=true and run the Temporal worker before starting turns."
    );
  }

  async start(): Promise<TurnStartResult> {
    recordWorkflowStart(DUMMY_TURN_WORKFLOW_TYPE, "DISABLED");
    throw new TurnStarterDisabledError(
      "Temporal dummy turns are disabled. Set SPACE_ENABLE_DUMMY_TURNS=true and run the Temporal worker before starting turns."
    );
  }
}

export class TemporalTurnStarter implements TurnStarter {
  constructor(private readonly options: TemporalStarterOptions) {}

  plan(input: DummyTurnInput): TurnStartResult {
    const parsed = dummyTurnInputSchema.parse(input);
    const workflowId = buildDummyTurnWorkflowId(parsed);
    return turnStartResultSchema.parse({
      workflowId,
      runId: null,
      roomId: parsed.roomId,
      paneId: parsed.paneId,
      traceId: parsed.traceId,
      status: "QUEUED",
      runtime: "DUMMY_TEMPORAL",
      artifactIds: parsed.artifactIds
    });
  }

  async start(input: DummyTurnInput): Promise<TurnStartResult> {
    const parsed = withTurnTraceparent(dummyTurnInputSchema.parse(input));
    const planned = this.plan(parsed);
    const handle = await startTurnWorkflow(DUMMY_TURN_WORKFLOW_TYPE, this.options, parsed, planned.workflowId);
    return turnStartResultSchema.parse({
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
      roomId: parsed.roomId,
      paneId: parsed.paneId,
      traceId: parsed.traceId,
      status: "QUEUED",
      runtime: "DUMMY_TEMPORAL",
      artifactIds: parsed.artifactIds
    });
  }
}

export class DisabledCodexAppServerTurnStarter implements TurnStarter {
  plan(): TurnStartResult {
    throw new TurnStarterDisabledError(
      "Codex App Server turns are disabled. Set SPACE_ENABLE_CODEX_TURNS=true only after the real Codex turn workflow is ready and approved."
    );
  }

  async start(): Promise<TurnStartResult> {
    recordWorkflowStart(CODEX_APP_SERVER_TURN_WORKFLOW_TYPE, "DISABLED");
    throw new TurnStarterDisabledError(
      "Codex App Server turns are disabled. Set SPACE_ENABLE_CODEX_TURNS=true only after the real Codex turn workflow is ready and approved."
    );
  }
}

export class TemporalCodexAppServerTurnStarter implements TurnStarter {
  constructor(private readonly options: TemporalStarterOptions) {}

  plan(input: DummyTurnInput): TurnStartResult {
    const parsed = dummyTurnInputSchema.parse(input);
    const workflowId = buildCodexAppServerTurnWorkflowId(parsed);
    return turnStartResultSchema.parse({
      workflowId,
      runId: null,
      roomId: parsed.roomId,
      paneId: parsed.paneId,
      traceId: parsed.traceId,
      status: "QUEUED",
      runtime: "CODEX_APP_SERVER",
      artifactIds: parsed.artifactIds
    });
  }

  async start(input: DummyTurnInput): Promise<TurnStartResult> {
    const parsed = withTurnTraceparent(dummyTurnInputSchema.parse(input));
    const planned = this.plan(parsed);
    const handle = await startTurnWorkflow(CODEX_APP_SERVER_TURN_WORKFLOW_TYPE, this.options, parsed, planned.workflowId);
    return turnStartResultSchema.parse({
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
      roomId: parsed.roomId,
      paneId: parsed.paneId,
      traceId: parsed.traceId,
      status: "QUEUED",
      runtime: "CODEX_APP_SERVER",
      artifactIds: parsed.artifactIds
    });
  }
}

interface StarterFactoryOptions extends TemporalStarterOptions {
  enabled: boolean;
}

export function createTurnStarter(options: StarterFactoryOptions): TurnStarter {
  if (!options.enabled) {
    return new DisabledTurnStarter();
  }
  return new TemporalTurnStarter(options);
}

export function createCodexAppServerTurnStarter(options: StarterFactoryOptions): TurnStarter {
  if (!options.enabled) {
    return new DisabledCodexAppServerTurnStarter();
  }
  return new TemporalCodexAppServerTurnStarter(options);
}
