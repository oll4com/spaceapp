import {
  idSchema,
  setupConnectionCheckReplaySchema,
  type SetupConnection,
  type SetupConnectionCheckReplay,
  type SetupConnectionCheckRun,
  type SetupConnectionCheckStage,
  type SetupOverview
} from "@space/contracts";
import {
  SpaceNotFoundError,
  type SpaceStore
} from "@space/runtime";
import { cliRuntimeDescriptors } from "./cli-runtime-descriptors.js";
import {
  summarizeSetupConnections,
  type SetupConnectionsService
} from "./setup-connections.js";

const setupConnectionIds = cliRuntimeDescriptors.map((descriptor) => descriptor.id);
const setupConnectionIdSet = new Set<string>(setupConnectionIds);
const terminalStages = new Set<SetupConnectionCheckStage>([
  "Verified",
  "Quota limited",
  "Timed out",
  "Needs setup",
  "Provider failed",
  "Credential changed",
  "CLI unavailable"
]);

export interface SetupConnectionCheckRunAdmission {
  run: SetupConnectionCheckRun;
  reused: boolean;
}

export interface SetupConnectionCheckRunManagerOptions {
  store: SpaceStore;
  setupConnections: SetupConnectionsService;
  now?: () => Date;
}

function terminalStageFor(connection: SetupConnection): SetupConnectionCheckStage {
  if (connection.functionalState === "NEEDS_SETUP") return "Needs setup";
  if (connection.functionalState === "UNAVAILABLE") return "CLI unavailable";
  if (connection.liveVerificationState === "VERIFIED") return "Verified";
  if (connection.liveVerificationState === "QUOTA_LIMITED") return "Quota limited";
  if (connection.liveVerificationState === "TIMED_OUT") return "Timed out";
  if (connection.liveVerificationState === "CREDENTIAL_CHANGED") return "Credential changed";
  return "Provider failed";
}

export class SetupConnectionCheckRunManager {
  private readonly now: () => Date;
  private admissionQueue: Promise<void> = Promise.resolve();
  private readonly running = new Map<string, Promise<void>>();
  private readonly completionQueues = new Map<string, Promise<void>>();
  private readonly connectionResults = new Map<string, Map<string, SetupConnection>>();
  private readonly overviewSnapshots = new Map<string, SetupOverview>();
  private readonly overviewLoads = new Map<string, Promise<SetupOverview>>();

  constructor(private readonly options: SetupConnectionCheckRunManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  startAll(actorUserId: string): Promise<SetupConnectionCheckRunAdmission> {
    return this.admit("ALL", setupConnectionIds, actorUserId);
  }

  startSingle(
    connectionId: string,
    actorUserId: string
  ): Promise<SetupConnectionCheckRunAdmission> {
    if (!setupConnectionIdSet.has(connectionId)) {
      throw new SpaceNotFoundError(`Setup connection ${connectionId} was not found.`);
    }
    return this.admit("SINGLE", [connectionId], actorUserId);
  }

  private admit(
    scope: SetupConnectionCheckRun["scope"],
    connectionIds: string[],
    actorUserId: string
  ): Promise<SetupConnectionCheckRunAdmission> {
    const operation = this.admissionQueue.then(
      () => this.admitExclusive(scope, connectionIds, actorUserId),
      () => this.admitExclusive(scope, connectionIds, actorUserId)
    );
    this.admissionQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async admitExclusive(
    scope: SetupConnectionCheckRun["scope"],
    connectionIds: string[],
    actorUserId: string
  ): Promise<SetupConnectionCheckRunAdmission> {
    const actorId = idSchema.parse(actorUserId);
    const active = (await this.options.store.listSetupConnectionCheckRuns(500)).find((run) =>
      run.status === "RUNNING" &&
      (scope === "ALL"
        ? run.scope === "ALL"
        : run.connectionIds.includes(connectionIds[0]!))
    );
    if (active) return { run: active, reused: true };

    const run = await this.options.store.createSetupConnectionCheckRun({
      scope,
      connectionIds,
      actorUserId: actorId
    });
    const execution = this.execute(run).finally(() => {
      this.running.delete(run.id);
      this.completionQueues.delete(run.id);
    });
    this.running.set(run.id, execution);
    return { run, reused: false };
  }

  private async execute(run: SetupConnectionCheckRun): Promise<void> {
    if (run.scope === "ALL") {
      await this.executeAllConnections(run);
    } else {
      await Promise.all(run.connectionIds.map((connectionId) =>
        this.executeConnection(run, connectionId)
      ));
    }
    const current = await this.requireRun(run.id);
    await this.options.store.updateSetupConnectionCheckRun(run.id, {
      status: "COMPLETED",
      completedCount: current.totalCount,
      finishedAt: this.now().toISOString()
    });
  }

  private async executeAllConnections(run: SetupConnectionCheckRun): Promise<void> {
    const completedConnectionIds = new Set<string>();
    let returnedConnections: SetupConnection[] = [];
    try {
      returnedConnections = await this.options.setupConnections.verifyAll(
        async (connectionId, stage) => {
          if (!run.connectionIds.includes(connectionId) || terminalStages.has(stage)) return;
          await this.appendRunningEvent(run.id, connectionId, stage);
        },
        async (connectionId, connection) => {
          if (!run.connectionIds.includes(connectionId) || completedConnectionIds.has(connectionId)) {
            return;
          }
          await this.completeConnection(run.id, connectionId, connection);
          completedConnectionIds.add(connectionId);
        }
      );
    } catch {
      // Missing results are finalized below with a safe reason code.
    }

    const returnedById = new Map(
      returnedConnections.map((connection) => [connection.id, connection])
    );
    for (const connectionId of run.connectionIds) {
      if (completedConnectionIds.has(connectionId)) continue;
      await this.completeConnection(
        run.id,
        connectionId,
        returnedById.get(connectionId) ?? null
      );
      completedConnectionIds.add(connectionId);
    }
  }

  private async executeConnection(
    run: SetupConnectionCheckRun,
    connectionId: string
  ): Promise<void> {
    let connection: SetupConnection;
    try {
      connection = await this.options.setupConnections.verify(connectionId, async (stage) => {
        if (terminalStages.has(stage)) return;
        await this.appendRunningEvent(run.id, connectionId, stage);
      });
    } catch {
      await this.completeConnection(run.id, connectionId, null);
      return;
    }
    await this.completeConnection(run.id, connectionId, connection);
  }

  private async appendRunningEvent(
    runId: string,
    connectionId: string,
    stage: SetupConnectionCheckStage
  ): Promise<void> {
    await this.options.store.appendSetupConnectionCheckEvent({
      runId,
      connectionId,
      stage,
      state: "RUNNING",
      functionalState: null,
      liveVerificationState: null,
      reasonCode: null
    });
  }

  private async completeConnection(
    runId: string,
    connectionId: string,
    connection: SetupConnection | null
  ): Promise<void> {
    const knownConnection = connection ?? await this.currentConnection(runId, connectionId);
    const failedConnection = connection
      ? null
      : knownConnection?.functionalState === "FUNCTIONAL"
        ? {
            ...knownConnection,
            liveVerificationState: "PROVIDER_FAILED" as const,
            reasonCode: "CHECK_EXECUTION_FAILED",
            verifiedAt: null,
            staleAt: null
          }
        : knownConnection;
    const overviewConnection = connection ?? failedConnection;
    await this.options.store.appendSetupConnectionCheckEvent({
      runId,
      connectionId,
      stage: connection ? terminalStageFor(connection) : "Provider failed",
      state: "COMPLETED",
      functionalState: knownConnection?.functionalState ?? null,
      liveVerificationState:
        connection?.liveVerificationState ??
        (knownConnection?.functionalState === "FUNCTIONAL"
          ? "PROVIDER_FAILED"
          : knownConnection?.liveVerificationState ?? null),
      reasonCode: connection?.reasonCode ?? "CHECK_EXECUTION_FAILED"
    });
    if (overviewConnection) {
      this.rememberConnectionResult(runId, overviewConnection);
    }
    await this.recordCompletion(runId);
  }

  private async currentConnection(
    runId: string,
    connectionId: string
  ): Promise<SetupConnection | null> {
    const completed = this.connectionResults.get(runId)?.get(connectionId);
    if (completed) return completed;
    try {
      return (await this.getRunOverview(runId)).connections
        .find((connection) => connection.id === connectionId) ?? null;
    } catch {
      return null;
    }
  }

  private rememberConnectionResult(runId: string, connection: SetupConnection): void {
    let results = this.connectionResults.get(runId);
    if (!results) {
      results = new Map();
      this.connectionResults.set(runId, results);
      this.pruneRunCaches(runId);
    }
    results.set(connection.id, connection);
    const overview = this.overviewSnapshots.get(runId);
    if (!overview) return;
    const connections = overview.connections.map((candidate) =>
      candidate.id === connection.id ? connection : candidate
    );
    this.overviewSnapshots.set(runId, {
      ...overview,
      summary: summarizeSetupConnections(connections),
      connections
    });
  }

  private getRunOverview(runId: string): Promise<SetupOverview> {
    const snapshot = this.overviewSnapshots.get(runId);
    if (snapshot) return Promise.resolve(snapshot);
    const loading = this.overviewLoads.get(runId);
    if (loading) return loading;
    const operation = Promise.all([
      this.options.store.getOwnerOnboarding(),
      this.options.setupConnections.overview()
    ]).then(([onboarding, observedConnections]) => {
      let completed = this.connectionResults.get(runId);
      if (!completed) {
        completed = new Map();
        this.connectionResults.set(runId, completed);
      }
      const connections = observedConnections.map((connection) =>
        completed.get(connection.id) ?? connection
      );
      const overview = {
        ...onboarding,
        summary: summarizeSetupConnections(connections),
        connections
      };
      this.overviewSnapshots.set(runId, overview);
      this.pruneRunCaches(runId);
      return overview;
    }).finally(() => {
      this.overviewLoads.delete(runId);
    });
    this.overviewLoads.set(runId, operation);
    return operation;
  }

  private pruneRunCaches(currentRunId: string): void {
    while (this.connectionResults.size > 100) {
      const oldestRunId = this.connectionResults.keys().next().value as string | undefined;
      if (!oldestRunId) break;
      if (oldestRunId === currentRunId) {
        const currentResults = this.connectionResults.get(oldestRunId)!;
        this.connectionResults.delete(oldestRunId);
        this.connectionResults.set(oldestRunId, currentResults);
        continue;
      }
      this.connectionResults.delete(oldestRunId);
      this.overviewSnapshots.delete(oldestRunId);
      this.overviewLoads.delete(oldestRunId);
    }
  }

  private recordCompletion(runId: string): Promise<void> {
    const previous = this.completionQueues.get(runId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const run = await this.requireRun(runId);
      if (run.status !== "RUNNING") return;
      await this.options.store.updateSetupConnectionCheckRun(run.id, {
        completedCount: Math.min(run.totalCount, run.completedCount + 1)
      });
    });
    this.completionQueues.set(runId, operation.then(() => undefined, () => undefined));
    return operation;
  }

  async replay(runId: string, afterSequence = 0): Promise<SetupConnectionCheckReplay> {
    const parsedRunId = idSchema.parse(runId);
    if (!Number.isInteger(afterSequence) || afterSequence < 0 || afterSequence > 1_000_000_000) {
      throw new Error("Setup connection check replay cursor is invalid.");
    }
    const run = await this.requireRun(parsedRunId);
    const [events, overview] = await Promise.all([
      this.options.store.listSetupConnectionCheckEvents(run.id, afterSequence, 1_000),
      this.getRunOverview(run.id)
    ]);
    return setupConnectionCheckReplaySchema.parse({
      run,
      events,
      overview
    });
  }

  async whenSettled(runId: string): Promise<void> {
    const parsedRunId = idSchema.parse(runId);
    const execution = this.running.get(parsedRunId);
    if (execution) await execution;
  }

  isStreamTerminal(replay: SetupConnectionCheckReplay): boolean {
    return replay.run.status === "COMPLETED";
  }

  private async requireRun(runId: string): Promise<SetupConnectionCheckRun> {
    const run = await this.options.store.getSetupConnectionCheckRun(runId);
    if (!run) {
      throw new SpaceNotFoundError(`Setup connection check run ${runId} was not found.`);
    }
    return run;
  }
}
