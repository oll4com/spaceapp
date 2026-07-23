import { spawn } from "node:child_process";
import {
  cliMaintenanceRequestSchema,
  idSchema,
  type AdminOperationRun,
  type CliMaintenanceRequest
} from "@space/contracts";
import { SpaceNotFoundError, type SpaceStore } from "@space/runtime";

const dispatcherCommand = "/usr/bin/sudo";
const dispatcherExecutable = "/opt/spaceapp/bin/space-cli-maintenance-dispatcher";
const activeStatuses = new Set(["QUEUED", "RUNNING"]);
const cliOperationTypes = new Set(["CLI_MAINTENANCE_CHECK", "CLI_MAINTENANCE_UPDATE"]);

export class CliMaintenanceError extends Error {
  constructor(
    readonly code: "CLI_MAINTENANCE_IN_PROGRESS" | "CLI_MAINTENANCE_DISPATCH_FAILED",
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
    const operationType = parsed.mode === "CHECK" ? "CLI_MAINTENANCE_CHECK" : "CLI_MAINTENANCE_UPDATE";
    const run = await this.options.store.createAdminOperationRun({
      operationType,
      actorUserId: actorId,
      summary: parsed.mode === "CHECK"
        ? "Queued Space and CLI health check."
        : "Queued sequential update for all managed CLI apps."
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
      .filter((run) => cliOperationTypes.has(run.operationType));
  }

  async get(runId: string): Promise<AdminOperationRun> {
    const parsedRunId = idSchema.parse(runId);
    const run = await this.options.store.getAdminOperationRun(parsedRunId);
    if (!run || !cliOperationTypes.has(run.operationType)) {
      throw new SpaceNotFoundError(`CLI maintenance run ${parsedRunId} was not found.`);
    }
    return run;
  }
}
