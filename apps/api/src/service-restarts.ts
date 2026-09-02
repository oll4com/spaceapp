import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const CORE_RESTART_SERVICES = ["space-worker.service", "space-api.service", "space-web.service"] as const;
export const CORE_SERVICE_RESTART_COMMAND = {
  command: "/usr/bin/sudo",
  args: ["-n", "/usr/bin/systemctl", "--no-block", "start", "space-core-restart.service"]
} as const;

/**
 * Restarts the shared OpenCode server so it re-reads the active OpenCode config
 * (provider/model changes). Used by the CLI runtime restart flow for `cli:opencode`
 * so a runtime restart also refreshes the shared server's model catalog.
 */
export const OPENCODE_SHARED_SERVER_RESTART_COMMAND = {
  command: "/usr/bin/sudo",
  args: ["-n", "/usr/bin/systemctl", "--no-block", "restart", "space-opencode-shared.service"]
} as const;

export const DEEPSEEK_HARNESS_RESTART_COMMAND = {
  command: "/usr/bin/sudo",
  args: ["-n", "/usr/bin/systemctl", "restart", "space-deepseek-harness.service"]
} as const;

export const DEEPSEEK_HARNESS_ENABLE_COMMAND = {
  command: "/usr/bin/sudo",
  args: ["-n", "/usr/bin/systemctl", "enable", "--now", "space-deepseek-harness.service"]
} as const;

export const DEEPSEEK_HARNESS_DISABLE_COMMAND = {
  command: "/usr/bin/sudo",
  args: ["-n", "/usr/bin/systemctl", "disable", "--now", "space-deepseek-harness.service"]
} as const;

export const DEEPSEEK_HARNESS_MAIN_PID_COMMAND = {
  command: "/usr/bin/systemctl",
  args: ["show", "space-deepseek-harness.service", "--property=MainPID", "--value"]
} as const;

export interface DeepSeekHarnessServiceController {
  mainPid(): Promise<number | null>;
  restart(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
}

export function createDeepSeekHarnessServiceController(): DeepSeekHarnessServiceController {
  return {
    async mainPid() {
      const { stdout } = await execFileAsync(
        DEEPSEEK_HARNESS_MAIN_PID_COMMAND.command,
        DEEPSEEK_HARNESS_MAIN_PID_COMMAND.args,
        { timeout: 5000, windowsHide: true }
      );
      const pid = Number.parseInt(stdout.trim(), 10);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    },
    async restart() {
      await execFileAsync(
        DEEPSEEK_HARNESS_RESTART_COMMAND.command,
        DEEPSEEK_HARNESS_RESTART_COMMAND.args,
        { timeout: 30_000, windowsHide: true }
      );
    },
    async setEnabled(enabled) {
      const command = enabled ? DEEPSEEK_HARNESS_ENABLE_COMMAND : DEEPSEEK_HARNESS_DISABLE_COMMAND;
      await execFileAsync(command.command, command.args, {
        timeout: 30_000,
        windowsHide: true
      });
    }
  };
}

export type OpenCodeSharedServerRestartCommand = typeof OPENCODE_SHARED_SERVER_RESTART_COMMAND;

export async function restartOpenCodeSharedServer(
  command: OpenCodeSharedServerRestartCommand = OPENCODE_SHARED_SERVER_RESTART_COMMAND
): Promise<void> {
  await execFileAsync(command.command, command.args, {
    timeout: 5000,
    windowsHide: true
  });
}

export type CoreServiceRestartCommand = typeof CORE_SERVICE_RESTART_COMMAND;
export type CoreServiceRestarter = (command: CoreServiceRestartCommand) => Promise<void>;

const cooldownSchema = z.object({
  scope: z.literal("CORE"),
  requestedAt: z.string().datetime({ offset: true }),
  cooldownUntil: z.string().datetime({ offset: true }),
  apiStartedAt: z.string().datetime({ offset: true }),
  actorUserId: z.string().nullable()
});

export type ServiceRestartCooldown = z.infer<typeof cooldownSchema>;

export async function runCoreServiceRestart(command: CoreServiceRestartCommand = CORE_SERVICE_RESTART_COMMAND): Promise<void> {
  await execFileAsync(command.command, command.args, {
    timeout: 5000,
    windowsHide: true
  });
}

export async function readServiceRestartCooldown(path: string): Promise<ServiceRestartCooldown | null> {
  try {
    return cooldownSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export async function writeServiceRestartCooldown(path: string, record: ServiceRestartCooldown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cooldownSchema.parse(record), null, 2)}\n`, { mode: 0o644 });
}
