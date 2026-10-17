import { spawn } from "./safe-child-process.js";
import { randomUUID } from "node:crypto";
import {
  cliSessionCleanupPreviewResponseSchema,
  cliSessionCleanupResponseSchema,
  type CliSessionCleanupCodexPreview,
  type CliSessionCleanupCodexCleaned,
  type CliSessionCleanupCounts,
  type CliSessionCleanupPreviewResponse,
  type CliSessionCleanupResponse
} from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";

const defaultCommand = "/opt/spaceapp/bin/space-cli-session-cleanup";
const maxOutputBytes = 32_000;
const maxErrorBytes = 8_000;
const previewTimeoutMs = 250_000;
const mutationTimeoutMs = 920_000;
const unavailableMessage = "CLI session cleanup is unavailable.";
const executeFailureMessage = "CLI session cleanup did not complete. Refresh the preview before retrying.";

export interface CliSessionCleanupPreviewInput {
  actorId: string;
  protectedThreadIds: string[];
  codexEnabled: boolean;
}

export interface CliSessionCleanupExecuteInput extends CliSessionCleanupPreviewInput {
  previewId: string;
}

export interface CliSessionCleanupService {
  preview(input: CliSessionCleanupPreviewInput): Promise<CliSessionCleanupPreviewResponse>;
  execute(input: CliSessionCleanupExecuteInput): Promise<CliSessionCleanupResponse>;
}

export type CliSessionCleanupCommandRunner = (
  command: string,
  args: string[],
  input: string,
  options: { timeoutMs: number }
) => Promise<string>;

function runFixedCommand(
  command: string,
  args: string[],
  input: string,
  options: { timeoutMs: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutExceeded = false;
    let stderrExceeded = false;
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("CLI session cleanup command timed out.")));
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const remaining = maxOutputBytes - stdout.length;
      if (remaining > 0) stdout += chunk.slice(0, remaining);
      if (chunk.length > remaining) stdoutExceeded = true;
    });
    child.stderr.on("data", (chunk: string) => {
      const remaining = maxErrorBytes - stderr.length;
      if (remaining > 0) stderr += chunk.slice(0, remaining);
      if (chunk.length > remaining) stderrExceeded = true;
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      if (code === 0 && !stdoutExceeded && !stderrExceeded) resolve(stdout);
      else {
        const stderrDetail = stderr.trim().slice(0, 2_000);
        const detail = `exit code ${code ?? "unknown"}${stderrDetail ? `: ${stderrDetail}` : ""}`;
        reject(new Error(`CLI session cleanup command failed (${detail}).`));
      }
    }));
    child.stdin.on("error", (error) => finish(() => reject(error)));
    child.stdin.end(input);
  });
}

const noopCodexPreview = (): CliSessionCleanupCodexPreview => ({
  status: "NOOP",
  previewId: null,
  threads: 0,
  indexEntries: 0,
  rolloutFiles: 0,
  shellSnapshots: 0
});

const skippedCodexCleaned = (): CliSessionCleanupCodexCleaned => ({
  status: "SKIPPED",
  threads: 0,
  indexEntries: 0,
  rolloutFiles: 0,
  shellSnapshots: 0
});

/**
 * Safe cleanup: empty sessions, orphaned rollouts and pane homes, temp files.
 * It never runs the Codex history purge, which removes every inactive Codex
 * thread with its full history; that stays in "Purge inactive history".
 */
export function createCliSessionCleanupService(options: {
  command?: string;
  runCommand?: CliSessionCleanupCommandRunner;
  now?: () => Date;
} = {}): CliSessionCleanupService {
  const command = options.command ?? defaultCommand;
  const runCommand = options.runCommand ?? runFixedCommand;
  const now = options.now ?? (() => new Date());

  async function runWorker<T>(
    action: string,
    input: object,
    parse: (value: unknown) => T,
    options: { timeoutMs: number }
  ): Promise<T> {
    try {
      const output = await runCommand(command, [action], JSON.stringify(input), { timeoutMs: options.timeoutMs });
      return parse(JSON.parse(output));
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      throw new SpaceConflictError(`${unavailableMessage}${detail}`);
    }
  }

  return {
    async preview(input: CliSessionCleanupPreviewInput): Promise<CliSessionCleanupPreviewResponse> {
      const workerCounts = await runWorker(
        "preview",
        { actorId: input.actorId, protectedThreadIds: input.protectedThreadIds },
        (value) => {
          const parsed = value as CliSessionCleanupCounts & {
            opencode?: Record<string, unknown>;
            opencodeTmp?: Record<string, unknown>;
            codexOrphans?: Record<string, unknown>;
            codexPaneHomes?: Record<string, unknown>;
            cliStores?: Array<Record<string, unknown>>;
          };
          const strip = <T>(item: T): T => {
            if (item && typeof item === "object") {
              const { hitLimit, ...rest } = item as Record<string, unknown>;
              return rest as T;
            }
            return item;
          };
          return {
            opencode: strip(parsed.opencode),
            opencodeTmp: strip(parsed.opencodeTmp),
            codex: noopCodexPreview(),
            codexOrphans: strip(parsed.codexOrphans),
            codexPaneHomes: strip(parsed.codexPaneHomes),
            cliStores: (parsed.cliStores ?? []).map((store) => strip(store)),
            totalBytes: parsed.totalBytes
          };
        },
        { timeoutMs: previewTimeoutMs }
      );
      const codex = noopCodexPreview();
      const counts: CliSessionCleanupCounts = {
        ...workerCounts,
        codex
      };
      return cliSessionCleanupPreviewResponseSchema.parse({
        status: counts.opencode.sessions > 0 ||
          counts.opencode.mappingFiles > 0 ||
          counts.opencodeTmp.entries > 0 ||
          counts.codex.threads > 0 ||
          counts.codexOrphans.rolloutFiles > 0 ||
          counts.codexPaneHomes.dirs > 0 ||
          counts.cliStores.some((store) => store.entries > 0) ? "READY" : "NOOP",
        previewId: randomUUID(),
        counts,
        checkedAt: now().toISOString()
      });
    },

    async execute(input: CliSessionCleanupExecuteInput): Promise<CliSessionCleanupResponse> {
      const failures: string[] = [];
      const codexCleaned: CliSessionCleanupCodexCleaned = { ...skippedCodexCleaned(), status: "NOOP" };
      const workerResult = await runWorker(
        "execute",
        { actorId: input.actorId, previewId: input.previewId, protectedThreadIds: input.protectedThreadIds },
        (value) => {
          const parsed = value as { cleaned: CliSessionCleanupResponse["cleaned"]; failures?: string[] };
          return {
            cleaned: {
              ...parsed.cleaned,
              codex: skippedCodexCleaned()
            },
            failures: Array.isArray(parsed.failures) ? parsed.failures : []
          };
        },
        { timeoutMs: mutationTimeoutMs }
      );
      const cleaned: CliSessionCleanupResponse["cleaned"] = {
        ...workerResult.cleaned,
        codex: codexCleaned
      };
      for (const failure of workerResult.failures) {
        if (failures.length < 20) failures.push(failure.slice(0, 500));
      }
      const totalBytes =
        cleaned.opencodeTmp.bytes +
        cleaned.codexOrphans.bytes +
        cleaned.codexPaneHomes.bytes +
        cleaned.cliStores.reduce((sum, store) => sum + store.bytes, 0);
      const hasCleanedTargets =
        cleaned.opencode.sessions > 0 ||
        cleaned.opencode.mappingFiles > 0 ||
        cleaned.opencodeTmp.entries > 0 ||
        cleaned.codex.threads > 0 ||
        cleaned.codexOrphans.rolloutFiles > 0 ||
        cleaned.codexPaneHomes.dirs > 0 ||
        cleaned.cliStores.some((store) => store.entries > 0);
      return cliSessionCleanupResponseSchema.parse({
        status: failures.length > 0 ? "PARTIAL" : (hasCleanedTargets ? "COMPLETED" : "NOOP"),
        previewId: input.previewId,
        cleaned,
        totalBytes,
        failures,
        completedAt: now().toISOString()
      });
    }
  };
}
