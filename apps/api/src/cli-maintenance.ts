import { spawn } from "node:child_process";
import {
  cliMaintenanceRequestSchema,
  cliToggleRuntimeIdSchema,
  idSchema,
  type AdminOperationRun,
  type CliMaintenanceAuthHandoff,
  type CliMaintenanceEvent,
  type CliMaintenanceRequest
} from "@space/contracts";
import {
  SpaceNotFoundError,
  redactCliMaintenanceDiagnostics,
  type SpaceStore
} from "@space/runtime";

const dispatcherCommand = "/usr/bin/sudo";
const dispatcherExecutable = "/opt/spaceapp/bin/space-cli-maintenance-dispatcher";
const activeStatuses = new Set(["QUEUED", "RUNNING"]);
const cliOperationTypes = new Set([
  "CLI_MAINTENANCE_CHECK",
  "CLI_MAINTENANCE_UPDATE",
  "CLI_MAINTENANCE_REPAIR"
]);

export interface CliMaintenanceReplay {
  run: AdminOperationRun;
  events: CliMaintenanceEvent[];
  authHandoffs: CliMaintenanceAuthHandoff[];
}

export interface CliMaintenanceExport extends CliMaintenanceReplay {
  schemaVersion: "space.cli-maintenance.export.v1";
  exportedAt: string;
}

function redactExportString(value: string): string {
  const redacted = redactCliMaintenanceDiagnostics({ value });
  return typeof redacted.value === "string" ? redacted.value : "[REDACTED]";
}

function redactRun(run: AdminOperationRun): AdminOperationRun {
  return {
    ...run,
    summary: redactExportString(run.summary),
    result: redactCliMaintenanceDiagnostics(run.result)
  };
}

function redactEvent(event: CliMaintenanceEvent): CliMaintenanceEvent {
  return {
    ...event,
    message: redactExportString(event.message),
    rollback: event.rollback
      ? { ...event.rollback, summary: redactExportString(event.rollback.summary) }
      : null,
    diagnostics: redactCliMaintenanceDiagnostics(event.diagnostics)
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalVersion(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class CliMaintenanceError extends Error {
  constructor(
    readonly code:
      | "CLI_MAINTENANCE_IN_PROGRESS"
      | "CLI_MAINTENANCE_DISPATCH_FAILED"
      | "CLI_MAINTENANCE_REPAIR_DISABLED",
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "CliMaintenanceError";
  }
}

export interface CliMaintenanceDispatcher {
  dispatch(runId: string): Promise<void>;
}

export type CliMaintenanceDispatcherExecutor = (command: string, args: string[]) => Promise<void>;

function executeDispatcher(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8"
      },
      windowsHide: true
    });
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("CLI maintenance dispatcher timed out.")));
    }, 20_000);
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      if (code === 0) resolve();
      else reject(new Error("CLI maintenance dispatcher rejected the run."));
    }));
  });
}

export function createCliMaintenanceDispatcherClient(
  execute: CliMaintenanceDispatcherExecutor = executeDispatcher
): CliMaintenanceDispatcher {
  return {
    async dispatch(runId: string) {
      const parsedRunId = idSchema.parse(runId);
      await execute(dispatcherCommand, ["-n", dispatcherExecutable, parsedRunId]);
    }
  };
}

export interface CliMaintenanceManagerOptions {
  store: SpaceStore;
  dispatcher?: CliMaintenanceDispatcher;
  repairEnabled?: boolean;
  now?: () => Date;
}

export class CliMaintenanceManager {
  private readonly dispatcher: CliMaintenanceDispatcher;
  private readonly now: () => Date;
  private admissionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: CliMaintenanceManagerOptions) {
    this.dispatcher = options.dispatcher ?? createCliMaintenanceDispatcherClient();
    this.now = options.now ?? (() => new Date());
  }

  start(input: CliMaintenanceRequest, actorUserId: string): Promise<AdminOperationRun> {
    const operation = this.admissionQueue.then(
      () => this.startExclusive(input, actorUserId),
      () => this.startExclusive(input, actorUserId)
    );
    this.admissionQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async startExclusive(input: CliMaintenanceRequest, actorUserId: string): Promise<AdminOperationRun> {
    const parsed = cliMaintenanceRequestSchema.parse(input);
    const actorId = idSchema.parse(actorUserId);
    if (parsed.mode === "REPAIR" && this.options.repairEnabled !== true) {
      throw new CliMaintenanceError(
        "CLI_MAINTENANCE_REPAIR_DISABLED",
        "CLI health and repair is disabled until the compatibility rollout is enabled.",
        503
      );
    }
    const active = (await this.options.store.listAdminOperationRuns(500)).find(
      (run) => cliOperationTypes.has(run.operationType) && activeStatuses.has(run.status)
    );
    if (active) {
      throw new CliMaintenanceError(
        "CLI_MAINTENANCE_IN_PROGRESS",
        `CLI maintenance run ${active.id} is already ${active.status.toLowerCase()}.`,
        409
      );
    }
    const operationType = parsed.mode === "CHECK"
      ? "CLI_MAINTENANCE_CHECK"
      : parsed.mode === "UPDATE"
        ? "CLI_MAINTENANCE_UPDATE"
        : "CLI_MAINTENANCE_REPAIR";
    const run = await this.options.store.createAdminOperationRun({
      operationType,
      actorUserId: actorId,
      summary: parsed.mode === "CHECK"
        ? "Queued Space and CLI health check."
        : parsed.mode === "UPDATE"
          ? "Queued sequential update for all managed CLI apps."
          : "Queued Space and CLI health and repair."
    });
    try {
      await this.dispatcher.dispatch(run.id);
      return run;
    } catch {
      const finishedAt = this.now().toISOString();
      await this.options.store.updateAdminOperationRun(run.id, {
        status: "FAILED",
        summary: "CLI maintenance could not be dispatched.",
        result: { code: "DISPATCH_FAILED" },
        finishedAt
      });
      throw new CliMaintenanceError(
        "CLI_MAINTENANCE_DISPATCH_FAILED",
        "CLI maintenance could not be started.",
        503
      );
    }
  }

  async list(): Promise<AdminOperationRun[]> {
    return (await this.options.store.listAdminOperationRuns(100))
      .filter((run) => cliOperationTypes.has(run.operationType))
      .map(redactRun);
  }

  async get(runId: string): Promise<AdminOperationRun> {
    return redactRun(await this.getStoredRun(runId));
  }

  private async getStoredRun(runId: string): Promise<AdminOperationRun> {
    const parsedRunId = idSchema.parse(runId);
    const run = await this.options.store.getAdminOperationRun(parsedRunId);
    if (!run || !cliOperationTypes.has(run.operationType)) {
      throw new SpaceNotFoundError(`CLI maintenance run ${parsedRunId} was not found.`);
    }
    return run;
  }

  async replay(runId: string, afterSequence = 0): Promise<CliMaintenanceReplay> {
    const run = redactRun(await this.getStoredRun(runId));
    const events = await this.options.store.listCliMaintenanceEvents(run.id, afterSequence, 1_000);
    const authHandoffs = await this.options.store.listCliMaintenanceAuthHandoffs(run.id);
    return { run, events: events.map(redactEvent), authHandoffs };
  }

  async export(runId: string): Promise<CliMaintenanceExport> {
    const replay = await this.replay(runId, 0);
    return {
      schemaVersion: "space.cli-maintenance.export.v1",
      exportedAt: this.now().toISOString(),
      run: replay.run,
      events: replay.events,
      authHandoffs: replay.authHandoffs
    };
  }

  async listAuthHandoffsForRecovery(): Promise<CliMaintenanceAuthHandoff[]> {
    const runs = (await this.options.store.listAdminOperationRuns(500))
      .filter((run) => run.operationType === "CLI_MAINTENANCE_REPAIR");
    const handoffs = (
      await Promise.all(runs.map((run) => this.options.store.listCliMaintenanceAuthHandoffs(run.id)))
    ).flat();
    return handoffs
      .filter((handoff) => ["PENDING", "OPENED", "FAILED"].includes(handoff.status))
      .filter((handoff) => handoff.attemptCount < 10)
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
      );
  }

  async completeAuthHandoffsForRuntime(runtimeId: string): Promise<CliMaintenanceAuthHandoff[]> {
    const parsedRuntimeId = cliToggleRuntimeIdSchema.parse(runtimeId);
    const runs = (await this.options.store.listAdminOperationRuns(500))
      .filter((run) => run.operationType === "CLI_MAINTENANCE_REPAIR");
    const completed: CliMaintenanceAuthHandoff[] = [];

    for (const listedRun of runs) {
      const initialHandoffs = await this.options.store.listCliMaintenanceAuthHandoffs(listedRun.id);
      const matchingHandoffs = initialHandoffs.filter((handoff) =>
        handoff.runtimeId === parsedRuntimeId && handoff.status !== "CANCELLED"
      );
      if (!matchingHandoffs.length) continue;

      for (const handoff of matchingHandoffs) {
        if (!["PENDING", "OPENED", "FAILED"].includes(handoff.status)) continue;
        if (handoff.status === "FAILED") {
          await this.options.store.updateCliMaintenanceAuthHandoff(handoff.id, {
            status: "OPENED",
            safeErrorCode: null
          });
        }
        completed.push(await this.options.store.updateCliMaintenanceAuthHandoff(handoff.id, {
          status: "COMPLETED",
          safeErrorCode: null
        }));
      }

      const run = await this.getStoredRun(listedRun.id);
      const result = recordValue(run.result) ?? {};
      const runtimeResults = Array.isArray(result.runtimes)
        ? result.runtimes.map((value) => recordValue(value)).filter((value): value is Record<string, unknown> => value !== null)
        : [];
      const matchingRuntimeResult = runtimeResults.find((value) => value.runtimeId === parsedRuntimeId) ?? null;
      const existingEvents = await this.options.store.listCliMaintenanceEvents(run.id, 0, 1_000);
      if (!existingEvents.some((event) =>
        event.runtimeId === parsedRuntimeId && event.code === "CLI_AUTH_RECOVERED"
      )) {
        await this.options.store.appendCliMaintenanceEvent({
          runId: run.id,
          runtimeId: parsedRuntimeId,
          phase: "AUTH_HANDOFF",
          state: "SUCCEEDED",
          severity: "INFO",
          code: "CLI_AUTH_RECOVERED",
          message: `${parsedRuntimeId} provider login completed and credentials verified.`,
          attempt: Math.min(10, Math.max(1, matchingHandoffs.at(-1)?.attemptCount ?? 1)),
          installedVersion: optionalVersion(matchingRuntimeResult?.installedVersion),
          availableVersion: optionalVersion(matchingRuntimeResult?.availableVersion),
          targetVersion: optionalVersion(matchingRuntimeResult?.availableVersion),
          durationMs: null,
          outcome: "HEALTHY",
          rollback: null,
          diagnostics: {}
        });
      }

      const nextRuntimeResults = runtimeResults.map((value) => value.runtimeId === parsedRuntimeId
        ? {
            ...value,
            status: "PASS",
            code: "AUTH_RECOVERED",
            summary: "Provider login completed and credentials were verified.",
            outcome: "HEALTHY",
            authRequired: false
          }
        : value
      );
      const handoffs = await this.options.store.listCliMaintenanceAuthHandoffs(run.id);
      const hasUnresolvedHandoff = handoffs.some((handoff) =>
        ["PENDING", "OPENED", "FAILED"].includes(handoff.status)
      );
      const space = recordValue(result.space);
      const spaceStatus = typeof space?.status === "string" ? space.status : "PASS";
      const hasFailedRuntime = nextRuntimeResults.some((value) => value.status === "FAIL");
      const hasWarningRuntime = nextRuntimeResults.some((value) => value.status === "WARN");
      const hasActionRequiredRuntime = nextRuntimeResults.some((value) => value.outcome === "ACTION_REQUIRED");
      const overallStatus = spaceStatus === "FAIL" || hasFailedRuntime
        ? "FAIL"
        : spaceStatus === "WARN" || hasWarningRuntime
          ? "WARN"
          : "PASS";
      const canCompleteRun = !hasUnresolvedHandoff &&
        !hasFailedRuntime &&
        !hasActionRequiredRuntime &&
        spaceStatus !== "FAIL";
      const nextStatus = run.status === "PARTIAL" && canCompleteRun ? "SUCCEEDED" : run.status;
      const nextSummary = nextStatus === "SUCCEEDED" && run.status === "PARTIAL"
        ? overallStatus === "PASS"
          ? "Space and all managed CLI repairs completed successfully after provider login."
          : "Space and managed CLI repairs completed after provider login with warnings."
        : run.summary;

      if (
        nextStatus === "SUCCEEDED" &&
        run.status === "PARTIAL" &&
        !existingEvents.some((event) => event.code === "REPAIR_SUCCEEDED_AFTER_AUTH")
      ) {
        await this.options.store.appendCliMaintenanceEvent({
          runId: run.id,
          runtimeId: null,
          phase: "COMPLETE",
          state: "SUCCEEDED",
          severity: "INFO",
          code: "REPAIR_SUCCEEDED_AFTER_AUTH",
          message: nextSummary,
          attempt: 1,
          installedVersion: null,
          availableVersion: null,
          targetVersion: null,
          durationMs: null,
          outcome: null,
          rollback: null,
          diagnostics: {}
        });
      }
      await this.options.store.updateAdminOperationRun(run.id, {
        status: nextStatus,
        summary: nextSummary,
        result: {
          ...result,
          overallStatus,
          runtimes: nextRuntimeResults
        }
      });
    }
    return completed;
  }

  isStreamTerminal(replay: CliMaintenanceReplay): boolean {
    if (replay.run.status === "SUCCEEDED" || replay.run.status === "FAILED") return true;
    if (replay.run.status !== "PARTIAL") return false;
    return !replay.authHandoffs.some((handoff) =>
      handoff.status === "PENDING" ||
      handoff.status === "OPENED" ||
      (handoff.status === "FAILED" && handoff.attemptCount < 10)
    );
  }
}
