import { execFile } from "./safe-child-process.js";
import { createHash } from "node:crypto";
import { VAULT_BROKER_BUNDLE_PATH } from "./vault/broker-report.js";
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

/** The Vault broker's reinstall unit (scripts/space-vault-broker-reinstall.mjs); started only on the operator's yes. */
export const VAULT_BROKER_REINSTALL_COMMAND = {
  command: "/usr/bin/sudo",
  args: ["-n", "/usr/bin/systemctl", "start", "space-vault-broker-reinstall.service"]
} as const;

const VAULT_BROKER_REINSTALL_OUTCOMES: Record<string, string> = {
  "0": "Rebuilt the Vault broker from stable's code and restarted it; the previous one is kept. Agents keep filling under the current delegation; no unlock is needed.",
  "3": "The installed Vault broker already matches stable's code; nothing changed.",
  "2": "Refused before any change: stable's checkout has local changes or the build failed.",
  "1": "The new Vault broker did not start; the previous one was restored and runs again.",
  "4": "The Vault broker is down: neither the new nor the previous one started."
};

/** Runs the reinstall unit and says what happened; its JSON report is in `journalctl -u space-vault-broker-reinstall`. */
export async function reinstallVaultBroker(run: (command: string, args: readonly string[], options: { timeout: number; windowsHide: boolean }) => Promise<{ stdout: string }> = execFileAsync,
  bundlePath = VAULT_BROKER_BUNDLE_PATH): Promise<string> {
  const unit = (): Promise<Record<string, string>> => run("/usr/bin/systemctl", ["show", "space-vault-broker-reinstall.service",
    "--property=InvocationID,ExecMainStatus"], { timeout: 5000, windowsHide: true })
    .then(({ stdout }) => Object.fromEntries(stdout.trim().split("\n").map((line) => line.split("=", 2))), () => ({}));
  const bundle = () => readFile(bundlePath).then((bytes) => createHash("sha256").update(bytes).digest("hex"), () => null);
  const [before, bundleBefore] = [await unit(), await bundle()];
  const failed = await run(VAULT_BROKER_REINSTALL_COMMAND.command, VAULT_BROKER_REINSTALL_COMMAND.args, { timeout: 320_000, windowsHide: true })
    .then(() => null, (error: { stderr?: string; message: string }) => error);
  const after = await unit();
  // A new invocation proves the unit ran: sudo refuses on dev and before the deploy that installs it. A run that succeeded (0 or 3)
  // leaves no invocation: systemd unloads the inactive oneshot at once (30/10 the reinstall worked and read "did not run"), so
  // `systemctl start` succeeding is the proof and the installed bundle tells a rebuild (0) from one already current (3).
  const status = after.InvocationID && after.InvocationID !== before.InvocationID ? after.ExecMainStatus
    : failed ? undefined : (await bundle()) === bundleBefore && bundleBefore !== null ? "3" : "0";
  const outcome = VAULT_BROKER_REINSTALL_OUTCOMES[status ?? ""];
  if (!outcome) throw new Error(`The reinstall did not run (the operator installs its unit once, ADR-012 "Enablement"): ${(failed?.stderr || failed?.message || "no exit status").trim().slice(0, 300)}`);
  if (status === "0" || status === "3") return outcome;
  throw new Error(`${outcome} See journalctl -u space-vault-broker-reinstall.`);
}

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
