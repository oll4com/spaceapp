import { spawn } from "node:child_process";
import { z } from "zod";
import {
  codexHistoryPurgePreviewResponseSchema,
  codexHistoryPurgeResponseSchema,
  type CodexHistoryPurgePreviewResponse,
  type CodexHistoryPurgeResponse
} from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";

const defaultCommand = "/opt/spaceapp/bin/codex-vscode-parity";
const maxOutputBytes = 32_000;
const maxErrorBytes = 8_000;
const previewTimeoutMs = 120_000;
const mutationTimeoutMs = 330_000;
const unavailableMessage = "History purge is unavailable.";
const executeFailureMessage = "History purge did not complete. No success was confirmed; refresh the preview before retrying.";

const rollbackResponseSchema = z.object({
  status: z.literal("ROLLED_BACK"),
  previewId: z.string().uuid(),
  backupId: z.string().uuid(),
  rolledBackAt: z.string().datetime({ offset: true })
}).strict();

export interface CodexHistoryPurgePreviewInput {
  actorId: string;
  protectedThreadIds: string[];
}

export interface CodexHistoryPurgeExecuteInput extends CodexHistoryPurgePreviewInput {
  previewId: string;
}

export interface CodexHistoryPurgeRollbackInput {
  actorId: string;
  previewId: string;
  backupId: string;
}

export interface CodexHistoryPurgeService {
  preview(input: CodexHistoryPurgePreviewInput): Promise<CodexHistoryPurgePreviewResponse>;
  execute(input: CodexHistoryPurgeExecuteInput): Promise<CodexHistoryPurgeResponse>;
  rollback(input: CodexHistoryPurgeRollbackInput): Promise<void>;
}

export interface CodexHistoryAccessCoordinator {
  withHistoryAttachment<T>(operation: () => Promise<T>): Promise<T>;
  withExclusivePurge<T>(operation: () => Promise<T>): Promise<T>;
}

export type CodexHistoryPurgeCommandRunner = (
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
      finish(() => reject(new Error("Codex history purge command timed out.")));
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
      else reject(new Error("Codex history purge command failed."));
    }));
    child.stdin.on("error", (error) => finish(() => reject(error)));
    child.stdin.end(input);
  });
}

export function createCodexHistoryPurgeService(options: {
  command?: string;
  runCommand?: CodexHistoryPurgeCommandRunner;
} = {}): CodexHistoryPurgeService {
  const command = options.command ?? defaultCommand;
  const runCommand = options.runCommand ?? runFixedCommand;

  async function run<T>(
    action: string,
    input: object,
    parse: (value: unknown) => T,
    options: { timeoutMs: number; failureMessage?: string }
  ): Promise<T> {
    try {
      const output = await runCommand(command, [action], JSON.stringify(input), { timeoutMs: options.timeoutMs });
      return parse(JSON.parse(output));
    } catch {
      throw new SpaceConflictError(options.failureMessage ?? unavailableMessage);
    }
  }

  return {
    preview: (input) => run(
      "history-purge-preview",
      input,
      (value) => codexHistoryPurgePreviewResponseSchema.parse(value),
      { timeoutMs: previewTimeoutMs }
    ),
    execute: (input) => run(
      "history-purge-execute",
      input,
      (value) => codexHistoryPurgeResponseSchema.parse(value),
      { timeoutMs: mutationTimeoutMs, failureMessage: executeFailureMessage }
    ),
    rollback: async (input) => {
      await run(
        "history-purge-rollback",
        input,
        (value) => rollbackResponseSchema.parse(value),
        { timeoutMs: mutationTimeoutMs }
      );
    }
  };
}

export function createCodexHistoryAccessCoordinator(): CodexHistoryAccessCoordinator {
  let queue: Promise<void> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    withHistoryAttachment: serialize,
    withExclusivePurge: serialize
  };
}
