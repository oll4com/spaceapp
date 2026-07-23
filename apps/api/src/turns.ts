import { Client, Connection } from "@temporalio/client";
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
    throw new TurnStarterDisabledError(
      "Temporal dummy turns are disabled. Set SPACE_ENABLE_DUMMY_TURNS=true and run the Temporal worker before starting turns."
    );
  }
}

export class TemporalTurnStarter implements TurnStarter {
  constructor(
    private readonly options: {
      address: string;
      namespace: string;
      taskQueue: string;
    }
  ) {}

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
    const parsed = dummyTurnInputSchema.parse(input);
    const planned = this.plan(parsed);
    const connection = await Connection.connect({ address: this.options.address, connectTimeout: "5s" });
    try {
      const client = new Client({ connection, namespace: this.options.namespace });
      const handle = await client.workflow.start(DUMMY_TURN_WORKFLOW_TYPE, {
        args: [parsed],
        taskQueue: this.options.taskQueue,
        workflowId: planned.workflowId
      });
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
    } finally {
      await connection.close();
    }
  }
}

export class DisabledCodexAppServerTurnStarter implements TurnStarter {
  plan(): TurnStartResult {
    throw new TurnStarterDisabledError(
      "Codex App Server turns are disabled. Set SPACE_ENABLE_CODEX_TURNS=true only after the real Codex turn workflow is ready and approved."
    );
  }

  async start(): Promise<TurnStartResult> {
    throw new TurnStarterDisabledError(
      "Codex App Server turns are disabled. Set SPACE_ENABLE_CODEX_TURNS=true only after the real Codex turn workflow is ready and approved."
    );
  }
}

export class TemporalCodexAppServerTurnStarter implements TurnStarter {
  constructor(
    private readonly options: {
      address: string;
      namespace: string;
      taskQueue: string;
    }
  ) {}

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
    const parsed = dummyTurnInputSchema.parse(input);
    const planned = this.plan(parsed);
    const connection = await Connection.connect({ address: this.options.address, connectTimeout: "5s" });
    try {
      const client = new Client({ connection, namespace: this.options.namespace });
      const handle = await client.workflow.start(CODEX_APP_SERVER_TURN_WORKFLOW_TYPE, {
        args: [parsed],
        taskQueue: this.options.taskQueue,
        workflowId: planned.workflowId
      });
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
    } finally {
      await connection.close();
    }
  }
}

interface StarterFactoryOptions {
  enabled: boolean;
  address: string;
  namespace: string;
  taskQueue: string;
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
