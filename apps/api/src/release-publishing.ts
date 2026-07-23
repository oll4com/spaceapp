import { spawn } from "node:child_process";
import { z } from "zod";
import {
  createReleasePreviewInputSchema,
  createReleaseRequestSchema,
  idSchema,
  releasePreviewSchema,
  type AdminOperationRun,
  type CreateReleasePreviewInput,
  type CreateReleaseRequest
} from "@space/contracts";
import type {
  ReleasePreviewRecord,
  SourceControlConnectionRecord,
  SpaceStore
} from "@space/runtime";

const controlCommand = "/usr/bin/sudo";
const controlExecutable = "/opt/spaceapp/bin/space-release-control";
const secretReferenceSchema = z.string().regex(/^source_control_(?:gitea|github)_[A-Za-z0-9_-]{8,96}$/);
const previewStateSchema = releasePreviewSchema.omit({ id: true, createdAt: true });
const activeStatuses = new Set(["QUEUED", "RUNNING"]);

function sameReleaseIdentity(
  run: AdminOperationRun,
  actorUserId: string,
  preview: ReleasePreviewRecord
): boolean {
  return run.operationType === "SPACE_RELEASE" &&
    run.actorUserId === actorUserId &&
    run.result.previewId === preview.id &&
    run.result.tag === preview.tag &&
    run.result.sourceCommit === preview.sourceCommit;
}

function partialRetryFromRuns(
  runs: AdminOperationRun[],
  actorUserId: string,
  preview: ReleasePreviewRecord
): AdminOperationRun | null {
  const previousRun = runs.find((run) => sameReleaseIdentity(run, actorUserId, preview));
  if (previousRun?.status === "PARTIAL") return previousRun;
  if (previousRun?.status !== "FAILED" || typeof previousRun.result.retryOfRunId !== "string") return null;
  return runs.find((run) =>
    run.id === previousRun.result.retryOfRunId &&
    run.status === "PARTIAL" &&
    sameReleaseIdentity(run, actorUserId, preview)
  ) ?? null;
}

export class ReleasePublishingError extends Error {
  constructor(
    readonly code:
      | "NOT_CONNECTED"
      | "CONTROL_FAILED"
      | "PREVIEW_NOT_FOUND"
      | "PREVIEW_ACTOR_MISMATCH"
      | "PREVIEW_EXPIRED"
      | "PREVIEW_MISMATCH"
      | "RELEASE_IN_PROGRESS"
      | "DISPATCH_FAILED",
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "ReleasePublishingError";
  }
}

export interface ReleasePreviewState {
  tag: string;
  notes: string;
  sourceCommit: string;
  previousTag: string | null;
  remoteMainCommits: { gitea: string; github: string };
  expiresAt: string;
}

export interface ReleaseControl {
  preview(
    connections: SourceControlConnectionRecord[],
    input: CreateReleasePreviewInput
  ): Promise<ReleasePreviewState>;
  dispatch(runId: string): Promise<void>;
}

export type ReleaseControlExecutor = (
  command: string,
  args: string[],
  stdin: string
) => Promise<string>;

function executeReleaseControl(command: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8"
      },
      windowsHide: true
    });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, args[2] === "preview" ? 90_000 : 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 64 * 1024) stdout += chunk.slice(0, 64 * 1024 - stdout.length);
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new ReleasePublishingError("CONTROL_FAILED", "The protected release control could not start.", 503));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ReleasePublishingError("CONTROL_FAILED", "The protected release control timed out.", 502));
      } else if (code !== 0) {
        reject(new ReleasePublishingError("CONTROL_FAILED", "The protected release control rejected the request.", 502));
      } else {
        resolve(stdout);
      }
    });
    child.stdin.end(stdin);
  });
}

function connectedReferences(connections: SourceControlConnectionRecord[]): [string, string] {
  const byProvider = new Map(connections.map((connection) => [connection.provider, connection]));
  return (["gitea", "github"] as const).map((provider) => {
    const connection = byProvider.get(provider);
    if (
      !connection ||
      connection.status !== "CONNECTED" ||
      connection.lastVerificationCode !== "VERIFIED" ||
      !connection.secretRef
    ) {
      throw new ReleasePublishingError(
        "NOT_CONNECTED",
        `Connect and verify ${provider} publishing credentials first.`,
        409
      );
    }
    return secretReferenceSchema.parse(connection.secretRef);
  }) as [string, string];
}

export function createReleaseControlClient(
  execute: ReleaseControlExecutor = executeReleaseControl
): ReleaseControl {
  return {
    async preview(connections, input) {
      const parsed = createReleasePreviewInputSchema.parse(input);
      const [giteaRef, githubRef] = connectedReferences(connections);
      const output = await execute(
        controlCommand,
        ["-n", controlExecutable, "preview", giteaRef, githubRef],
        `${JSON.stringify(parsed)}\n`
      );
      let payload: unknown;
      try {
        payload = JSON.parse(output);
      } catch {
        throw new ReleasePublishingError("CONTROL_FAILED", "Release preview returned invalid data.", 502);
      }
      return previewStateSchema.parse(payload);
    },
    async dispatch(runId) {
      const parsedRunId = idSchema.parse(runId);
      await execute(
        controlCommand,
        ["-n", controlExecutable, "publish", parsedRunId],
        ""
      );
    }
  };
}

export interface ReleasePublishingManagerOptions {
  store: SpaceStore;
  control?: ReleaseControl;
  now?: () => Date;
}

export class ReleasePublishingManager {
  private readonly control: ReleaseControl;
  private readonly now: () => Date;
  private admissionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ReleasePublishingManagerOptions) {
    this.control = options.control ?? createReleaseControlClient();
    this.now = options.now ?? (() => new Date());
  }

  async createPreview(input: CreateReleasePreviewInput, actorUserId: string): Promise<ReleasePreviewRecord> {
    const parsed = createReleasePreviewInputSchema.parse(input);
    const actorId = idSchema.parse(actorUserId);
    const connections = await this.options.store.listSourceControlConnections();
    const state = await this.control.preview(connections, parsed);
    return this.options.store.createReleasePreview(state, actorId);
  }

  publish(input: CreateReleaseRequest, actorUserId: string): Promise<AdminOperationRun> {
    const operation = this.admissionQueue.then(
      () => this.publishExclusive(input, actorUserId),
      () => this.publishExclusive(input, actorUserId)
    );
    this.admissionQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async publishExclusive(input: CreateReleaseRequest, actorUserId: string): Promise<AdminOperationRun> {
    const parsed = createReleaseRequestSchema.parse(input);
    const actorId = idSchema.parse(actorUserId);
    const preview = await this.options.store.getReleasePreview(parsed.previewId);
    if (!preview) {
      throw new ReleasePublishingError("PREVIEW_NOT_FOUND", "The release preview was not found.", 404);
    }
    if (preview.actorUserId !== actorId) {
      throw new ReleasePublishingError(
        "PREVIEW_ACTOR_MISMATCH",
        "Create a fresh release preview with the current admin account.",
        409
      );
    }
    if (parsed.tag !== preview.tag || parsed.notes !== preview.notes) {
      throw new ReleasePublishingError(
        "PREVIEW_MISMATCH",
        "The release request no longer matches its preview.",
        409
      );
    }
    const runs = await this.options.store.listAdminOperationRuns(500);
    const active = runs.find(
      (run) => run.operationType === "SPACE_RELEASE" && activeStatuses.has(run.status)
    );
    if (active) {
      throw new ReleasePublishingError(
        "RELEASE_IN_PROGRESS",
        `Space release ${active.id} is already ${active.status.toLowerCase()}.`,
        409
      );
    }
    const partialRetry = partialRetryFromRuns(runs, actorId, preview);
    if (Date.parse(preview.expiresAt) <= this.now().getTime() && !partialRetry) {
      throw new ReleasePublishingError("PREVIEW_EXPIRED", "The release preview has expired.", 409);
    }
    const run = await this.options.store.createAdminOperationRun({
      operationType: "SPACE_RELEASE",
      actorUserId: actorId,
      summary: `Queued Space release ${preview.tag} for Gitea and GitHub.`,
      result: {
        previewId: preview.id,
        tag: preview.tag,
        sourceCommit: preview.sourceCommit,
        notes: preview.notes,
        ...(partialRetry ? { retryOfRunId: partialRetry.id } : {})
      }
    });
    try {
      await this.control.dispatch(run.id);
      return run;
    } catch {
      await this.options.store.updateAdminOperationRun(run.id, {
        status: "FAILED",
        summary: `Space release ${preview.tag} could not be dispatched.`,
        result: {
          previewId: preview.id,
          tag: preview.tag,
          sourceCommit: preview.sourceCommit,
          notes: preview.notes,
          ...(partialRetry ? { retryOfRunId: partialRetry.id } : {}),
          code: "DISPATCH_FAILED"
        },
        finishedAt: this.now().toISOString()
      });
      throw new ReleasePublishingError("DISPATCH_FAILED", "The Space release could not be started.", 503);
    }
  }

  async listRuns(): Promise<AdminOperationRun[]> {
    return (await this.options.store.listAdminOperationRuns(100))
      .filter((run) => run.operationType === "SPACE_RELEASE");
  }

  async getRun(runId: string): Promise<AdminOperationRun> {
    const parsedRunId = idSchema.parse(runId);
    const run = await this.options.store.getAdminOperationRun(parsedRunId);
    if (!run || run.operationType !== "SPACE_RELEASE") {
      throw new ReleasePublishingError("PREVIEW_NOT_FOUND", "The Space release run was not found.", 404);
    }
    return run;
  }
}
