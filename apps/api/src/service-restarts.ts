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
