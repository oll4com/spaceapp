import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { Writable } from "node:stream";
import { PromptController } from "./prompt-controller.mjs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  addUser,
  addWorkspace,
  applyConfigRepairs,
  commitInstallation,
  composeCommand,
  credentialProviders,
  initializeInstallation,
  inspectSystemResources,
  installResourceChecks,
  profileRuntimeSettings,
  loadConfig,
  planConfigRepairs,
  prepareInstallation,
  removeCredential,
  removeUser,
  removeWorkspace,
  resolveInstallAccessMode,
  resolveInstallProfile,
  resolveSpaceAppHome,
  saveConfig,
  selectLatestBackupId,
  SPACEAPP_UPGRADE_POLICY,
  upgradePath,
  userSlug,
  BACKUP_ID_PATTERN,
  writeCredential,
  writeRuntimeFiles,
  writeSetupToken
} from "./index.mjs";
import { inspectStoragePlan, storageChecks } from "./storage.mjs";
import {
  ensureDockerAvailable,
  ensurePodmanAvailable,
  podmanInstallHelp,
  podmanIsReady,
  podmanCliAndComposeAreAvailable,
  checkMacPodmanMachine,
  prepareDockerCliPath,
  windowsPowerShellArgs
} from "./prerequisites.mjs";
import {
  HOST_ROOT_RUNTIME_COMPATIBLE,
  PACKAGE_VERSION,
  RUNTIME_VERSION,
  UNIVERSAL_COMMAND
} from "./package-info.mjs";
import {
  createInstallFunnel,
  installFunnelFacts,
  isInstallPingAllowed
} from "./telemetry.mjs";

const APPLICATION_READY_WAIT_MINUTES = 10;
const APPLICATION_READY_WAIT_MS = APPLICATION_READY_WAIT_MINUTES * 60 * 1_000;
const APPLICATION_READY_POLL_MS = 2_000;
const APPLICATION_READY_ATTEMPT_TIMEOUT_MS = 5_000;
const APPLICATION_READY_MAX_ATTEMPTS = APPLICATION_READY_WAIT_MS / APPLICATION_READY_POLL_MS;
const APPLICATION_READY_PROGRESS_ATTEMPTS = 30_000 / APPLICATION_READY_POLL_MS;
const APPLICATION_READY_LOG_INTERVAL_SECONDS = 120;
const SETUP_STATUS_TIMEOUT_MS = 10_000;
const trustedCommands = new Set([
  "codesign",
  "docker",
  "hdiutil",
  "open",
  "podman",
  "powershell.exe",
  "sg",
  "shutdown.exe",
  "spctl",
  "sudo",
  "winget.exe",
  "wsl.exe",
  "xdg-open"
]);
const trustedEnvironmentNames = new Set([
  "SPACEAPP_DOCKER_INSTALLER_PATH",
  "SPACEAPP_OPEN_URL",
  "SPACEAPP_RESUME_SCRIPT_PATH"
]);

/**
 * Writes troubleshooting guidance to stderr if Docker credential helper fails on Windows.
 *
 * @param {string} platform Operating system platform name.
 * @param {import("node:stream").Writable} stderr Standard error stream.
 */
export function writeWindowsCredentialHint(platform, stderr) {
  if (platform !== "win32") {
    return;
  }
  stderr.write(
    "If the failure above mentions Docker credentials (\"A specified logon session does not exist\"), " +
    "Docker Desktop's credential helper requires an interactive Windows session. " +
    `Run "${UNIVERSAL_COMMAND} install" from your desktop terminal (not SSH/CI), or open Docker Desktop and sign in once, then retry.\n`
  );
}

/**
 * Executes a Docker command within a temporary isolated config directory on Windows.
 *
 * @param {string} platform Operating system platform name.
 * @param {object} spec Command specification object.
 * @param {Function} run Execution callback runner.
 * @returns {Promise<any>} Execution result.
 */
export async function withHeadlessDockerConfig(platform, spec, run) {
  if (platform !== "win32" || spec.command !== "docker") {
    return run(spec);
  }
  const configDir = await mkdtemp(join(tmpdir(), "spaceapp-docker-config-"));
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({ auths: {} }),
    { mode: 0o600 }
  );
  try {
    return await run({
      ...spec,
      args: ["--config", configDir, ...spec.args]
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

/**
 * Checks whether an automated non-interactive installation run was explicitly confirmed.
 *
 * @param {import("node:stream").Readable} stdin Standard input stream with attached prompt controller.
 * @returns {boolean} True if non-interactive mode with confirmation was requested.
 */
function approvedAutomation(stdin) {
  const controller = stdin?._spaceappPromptController;
  return controller?.nonInteractive === true && controller.answers.confirm === true;
}

/**
 * Determines whether the standard input stream supports interactive terminal prompts.
 *
 * @param {import("node:stream").Readable} stdin Standard input stream.
 * @returns {boolean} True if interactive TTY and raw mode are available.
 */
function interactiveAvailable(stdin) {
  return Boolean(stdin?.isTTY && typeof stdin?.setRawMode === "function");
}

/**
 * Prompts the user with a yes/no question and returns a boolean response.
 *
 * @param {import("node:stream").Readable} stdin Standard input stream.
 * @param {import("node:stream").Writable} stdout Standard output stream.
 * @param {string} question Prompt question text.
 * @param {object} [options={}] Options including defaultYes and answerKey.
 * @returns {Promise<boolean>} True for yes, false for no.
 */
async function promptYesNo(stdin, stdout, question, { defaultYes = false, answerKey = null } = {}) {
  for (;;) {
    const answer = (await readSecret(stdin, stdout, `${question} [${defaultYes ? "Y/n" : "y/N"}] `, { mask: false, answerKey, defaultValue: defaultYes ? "y" : "n" })).trim().toLowerCase();
    if (answer === "") {
      return defaultYes;
    }
    if (answer === "y" || answer === "yes" || answer === "true") {
      return true;
    }
    if (answer === "n" || answer === "no" || answer === "false") {
      return false;
    }
    stdout.write("Please answer y or n.\n");
  }
}

/**
 * Prompts the user to select an option from a numbered list of choices.
 *
 * @param {import("node:stream").Readable} stdin Standard input stream.
 * @param {import("node:stream").Writable} stdout Standard output stream.
 * @param {string} question Prompt question text.
 * @param {Array<{ label: string, value: string }>} options Available selectable options.
 * @param {object} [options={}] Options including defaultIndex and answerKey.
 * @returns {Promise<string>} The selected option value.
 */
async function promptChoice(stdin, stdout, question, options, { defaultIndex = 0, answerKey = null } = {}) {
  stdout.write(`${question}\n`);
  options.forEach((option, index) => {
    stdout.write(`  [${index + 1}] ${option.label}\n`);
  });
  for (;;) {
    const answer = (await readSecret(stdin, stdout, `Select 1-${options.length} [${defaultIndex + 1}]: `, { mask: false, answerKey, defaultValue: String(defaultIndex + 1) })).trim();
    if (answer === "") {
      return options[defaultIndex].value;
    }
    const byValue = options.find((option) => option.value === answer);
    if (byValue) return byValue.value;
    const index = /^\d+$/.test(answer) ? Number(answer) : NaN;
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      return options[index - 1].value;
    }
    stdout.write(`Invalid choice. Enter a number between 1 and ${options.length}.\n`);
  }
}

/**
 * Displays the planned installation changes and requests final user confirmation.
 *
 * @param {import("node:stream").Readable} stdin Standard input stream.
 * @param {import("node:stream").Writable} stdout Standard output stream.
 * @param {string[]} lines List of plan summary description lines.
 * @returns {Promise<boolean>} True if confirmed, false if cancelled.
 */
async function finalConfirmation(stdin, stdout, lines) {
  stdout.write("SpaceApp setup plan:\n");
  for (const line of lines) {
    stdout.write(`  - ${line}\n`);
  }
  const approved = await promptYesNo(stdin, stdout, "Apply this plan?", { defaultYes: false, answerKey: "confirm" });
  if (!approved) {
    stdout.write("Cancelled. No changes were made.\n");
  }
  return approved;
}

/**
 * Reads and parses raw configuration JSON from the installation root directory.
 *
 * @param {string} root Installation root directory path.
 * @returns {Promise<object|null>} Parsed raw config object or null if absent/invalid.
 */
async function readRawConfig(root) {
  let raw;
  try {
    raw = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    raw = null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw;
}

const RUNONCE_CONTINUATION_LIFETIME_MS = 24 * 60 * 60 * 1_000;

/**
 * Retrieves the current operating system username from environment or OS userInfo.
 *
 * @param {object} params Parameter object.
 * @param {string} params.platform Operating system platform name.
 * @param {object} params.env Environment variables map.
 * @returns {string} Username string.
 */
function currentOsUsername({ platform, env }) {
  if (platform === "win32") {
    return env.USERNAME || env.USER || userInfo().username;
  }
  return env.USER || userInfo().username;
}

/**
 * Resolves the path to the Windows RunOnce continuation state file.
 *
 * @param {string} root Installation root directory path.
 * @returns {string} File path string.
 */
function runOnceContinuationPath(root) {
  return join(root, "var", "runonce-continuation.json");
}

/**
 * Reads and validates a Windows RunOnce continuation payload.
 *
 * @param {string} root Installation root directory path.
 * @param {object} params Validation parameters.
 * @param {string} params.platform Operating system platform name.
 * @param {string} params.runtimeVersion Expected target runtime version.
 * @returns {Promise<object|null>} Validated continuation payload or null.
 */
async function readRunOnceContinuation(root, { platform, runtimeVersion }) {
  if (platform !== "win32") {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(await readFile(runOnceContinuationPath(root), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    return null;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.targetVersion !== runtimeVersion ||
    typeof payload.nonce !== "string" ||
    payload.nonce.length < 32 ||
    !payload.actions ||
    typeof payload.actions !== "object" ||
    Array.isArray(payload.actions) ||
    payload.installRoot !== root ||
    payload.user !== currentOsUsername({ platform, env: process.env }) ||
    !Number.isFinite(payload.createdAt) ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt - payload.createdAt > RUNONCE_CONTINUATION_LIFETIME_MS ||
    Date.now() > payload.expiresAt
  ) {
    await rm(runOnceContinuationPath(root), { force: true }).catch(() => {});
    return null;
  }
  return payload;
}

/**
 * Removes the Windows RunOnce continuation file after consumption.
 *
 * @param {string} root Installation root directory path.
 * @returns {Promise<void>}
 */
async function consumeRunOnceContinuation(root) {
  await rm(runOnceContinuationPath(root), { force: true }).catch(() => {});
}

/**
 * Writes an approved Windows RunOnce continuation state payload.
 *
 * @param {string} root Installation root directory path.
 * @param {object} params Payload parameters.
 * @param {string} params.runtimeVersion Target runtime version.
 * @param {object} params.actions Approved actions dictionary.
 * @returns {Promise<void>}
 */
async function writeRunOnceContinuation(root, { runtimeVersion, actions }) {
  await mkdir(join(root, "var"), { recursive: true, mode: 0o700 });
  const createdAt = Date.now();
  const payload = {
    user: currentOsUsername({ platform: "win32", env: process.env }),
    installRoot: root,
    targetVersion: runtimeVersion,
    nonce: randomBytes(32).toString("base64url"),
    createdAt,
    expiresAt: createdAt + RUNONCE_CONTINUATION_LIFETIME_MS,
    actions
  };
  await writeFile(runOnceContinuationPath(root), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Main command-line interface entry point for the SpaceApp launcher.
 *
 * @param {string[]} argv Command-line argument vector.
 * @param {object} [options={}] Invocation environment, streams, and system runners.
 * @returns {Promise<number>} Process exit code (0 for success).
 */
export async function run(argv, {
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  execute = executeCommand,
  inspectResources = inspectSystemResources,
  ensureDocker = ensureDockerAvailable,
  prepareDockerPath = prepareDockerCliPath,
  request = globalThis.fetch,
  sleep = wait,
  persistSetupToken = writeSetupToken,
  launcherVersion = PACKAGE_VERSION,
  runtimeVersion = RUNTIME_VERSION,
  hostRootRuntimeCompatible = HOST_ROOT_RUNTIME_COMPATIBLE
} = {}) {
  const globalFlags = {
    localImages: false,
    json: false,
    plan: false,
    nonInteractive: false,
    logFile: null,
    answersFile: null
  };
  const filteredArgv = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local-images") {
      globalFlags.localImages = true;
    } else if (arg === "--json") {
      globalFlags.json = true;
    } else if (arg === "--plan") {
      globalFlags.plan = true;
    } else if (arg === "--non-interactive") {
      globalFlags.nonInteractive = true;
    } else if (arg === "--log-file" && i + 1 < argv.length) {
      globalFlags.logFile = argv[++i];
    } else if (arg.startsWith("--log-file=")) {
      globalFlags.logFile = arg.slice("--log-file=".length);
    } else if (arg === "--answers" && i + 1 < argv.length) {
      globalFlags.answersFile = argv[++i];
    } else if (arg.startsWith("--answers=")) {
      globalFlags.answersFile = arg.slice("--answers=".length);
    } else {
      filteredArgv.push(arg);
    }
  }

  const promptController = new PromptController({
    stdin,
    stdout,
    stderr,
    logFile: globalFlags.logFile,
    nonInteractive: globalFlags.nonInteractive,
    answersFile: globalFlags.answersFile,
    planMode: globalFlags.plan,
    jsonMode: globalFlags.json
  });
  if (stdin) {
    stdin._spaceappPromptController = promptController;
  }

  const [command = "help", ...args] = filteredArgv;
  const root = resolveSpaceAppHome({ env, platform });

  if (["help", "--help", "-h"].includes(command) || args.includes("--help") || args.includes("-h")) {
    stdout.write(helpText());
    return 0;
  }
  if (globalFlags.localImages) {
    const originalExecute = execute;
    execute = async (spec, io) => {
      if ((spec.command === "docker" || spec.command === "podman") && spec.args?.includes("compose")) {
        if (spec.args.at(-1) === "pull") {
          stdout.write("Local images only: skipping registry downloads; missing images will fail startup.\n");
          return 0;
        }
        const index = spec.args.indexOf("up");
        if (index !== -1) spec = {...spec, args: [...spec.args.slice(0,index+1), "--pull", "never", ...spec.args.slice(index+1)]};
      }
      return originalExecute(spec, io);
    };
  }
  if (command !== "install") {
    await prepareDockerPath({ platform, env });
  }
  if (command === "help" || command === "--help" || command === "-h") {
    stdout.write(helpText());
    return 0;
  }
  if (command === "--version" || command === "-v") {
    stdout.write(`${launcherVersion}\n`);
    return 0;
  }
  if (globalFlags.plan) {
    stdout.write(`[PLAN] Preview execution for "${command}" at ${root} (no changes applied).\n`);
    return 0;
  }
  if (command === "install") {
    return installCommand(args, {
      root,
      launcherVersion,
      runtimeVersion,
      hostRootRuntimeCompatible,
      platform,
      arch,
      env,
      stdin,
      stdout,
      stderr,
      execute,
      inspectResources,
      ensureDocker,
      prepareDockerPath,
      request,
      sleep,
      persistSetupToken
    });
  }
  if (command === "init") {
    assertNoArgs(args, "init");
    const approved = await requireChangeApproval(stdin, stdout, stderr, [
      `Create a new SpaceApp installation at ${root}`,
      "This writes configuration, secrets, and runtime files."
    ]);
    if (!approved) {
      return 0;
    }
    const result = await initializeInstallation(root, { version: runtimeVersion });
    stdout.write(`SpaceApp initialized at ${root}\n`);
    if (result.setupToken) {
      stdout.write(`One-time setup token: ${result.setupToken}\n`);
      stdout.write("Store it temporarily; it expires after first owner setup.\n");
    }
    stdout.write(
      `Next: ${UNIVERSAL_COMMAND} doctor && ${UNIVERSAL_COMMAND} up && ${UNIVERSAL_COMMAND} open\n`
    );
    return 0;
  }

  if (command === "doctor" && !args.includes("--fix")) {
    assertNoArgs(args, "doctor");
    return doctor({ root, platform, stdout, stderr, execute, stdin, inspectResources });
  }
  if (command === "repair" || command === "doctor" && args.includes("--fix")) {
    if (args.some((arg) => !["--dry-run", "--fix"].includes(arg))) throw new Error("Usage: repair [--dry-run] or doctor --fix");
    return repairRuntime({ root, config: null, platform, stdin, stdout, stderr, execute, request, sleep, ensureDocker, env, arch, inspectResources, dryRun: args.includes("--dry-run") });
  }
  const config = await loadConfig(root);
  if (commandNeedsRuntimeFiles(command, args)) {
    await writeRuntimeFiles(root, config);
  }
  const runtimeExecute = (spec, io) => executeWithDockerDiagnostics(
    execute,
    spec,
    io,
    { platform, stderr }
  );

  if (["up", "down", "status", "logs"].includes(command)) {
    assertNoArgs(args, command);
    const code = await runtimeExecute(composeCommand(command, root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }), { stdin, stdout, stderr });
    if (code === 0 && command === "up" && config?.volumesPurged) {
      delete config.volumesPurged;
      await saveConfig(root, config);
    }
    return code;
  }
  if (command === "open") {
    assertNoArgs(args, "open");
    const url = `http://${config.bindHost}:${config.port}`;
    const openCode = await openBrowser(url, platform, execute, { stdin, stdout, stderr });
    if (openCode !== 0) {
      stderr.write(`Could not open SpaceApp automatically. Open ${url} manually.\n`);
    }
    return 0;
  }
  if (command === "doctor") {
    assertNoArgs(args, "doctor");
    return doctor({ root, platform, stdout, stderr, execute, stdin, inspectResources });
  }
  if (command === "support-bundle") {
    let outPath = null;
    const outIdx = args.indexOf("--out");
    if (outIdx !== -1 && args[outIdx + 1]) {
      outPath = args[outIdx + 1];
    }
    return supportBundleCommand({ root, config, platform, arch, stdout, stderr, execute: runtimeExecute, request, outPath });
  }
  if (command === "repair") {
    const dryRun = args.includes("--dry-run");
    return repairRuntime({ root, config, platform, stdin, stdout, stderr, execute: runtimeExecute, request, sleep, dryRun });
  }
  if (command === "reinstall") {
    let requestedEngine;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--engine") {
        if (index + 1 < args.length) {
          requestedEngine = args[index + 1];
          index += 1;
        } else {
          requestedEngine = "";
        }
      } else if (argument.startsWith("--engine=")) {
        requestedEngine = argument.slice("--engine=".length);
      }
    }
    if (requestedEngine !== undefined) {
      if (!["docker", "podman"].includes(requestedEngine)) {
        stderr.write('Usage: spaceapp reinstall [--engine docker|podman]\n');
        return 1;
      }
      const savedEngine = config?.engine ?? "docker";
      if (requestedEngine !== savedEngine) {
        stderr.write(
          config?.volumesPurged
            ? `reinstall keeps the saved engine "${savedEngine}". Run "spaceapp install --engine ${requestedEngine}" to switch engines.\n`
            : `Cannot switch container engine from "${savedEngine}" to "${requestedEngine}" on an existing installation. Docker and Podman volumes are not interchangeable. To migrate engines, run "spaceapp backup", uninstall with "spaceapp uninstall --purge-data", install with "--engine ${requestedEngine}", and run "spaceapp restore".\n`
        );
        return 1;
      }
    }
    const keepData = !args.includes("--purge-data");
    return reinstallCommand({ root, config, platform, stdin, stdout, stderr, execute: runtimeExecute, request, sleep, keepData });
  }
  if (command === "factory-reset") {
    assertNoArgs(args, "factory-reset");
    return factoryResetCommand({ root, config, platform, stdin, stdout, stderr, execute: runtimeExecute, runtimeVersion, persistSetupToken });
  }
  if (command === "workspace") {
    return workspaceCommand(args, { root, config, platform, stdin, stdout, stderr, execute: runtimeExecute });
  }
  if (command === "credentials") {
    return credentialsCommand(args, { root, config, stdin, stdout, stderr, execute: runtimeExecute });
  }
  if (command === "user") {
    return userCommand(args, { root, config, stdin, stdout, stderr, execute: runtimeExecute, request, sleep });
  }
  if (command === "provider") {
    return providerCommand(args, { root, config, stdin, stdout, stderr, execute: runtimeExecute });
  }
  if (command === "owner") {
    return ownerCommand(args, { root, config, stdin, stdout, stderr, execute: runtimeExecute });
  }
  if (command === "update") {
    return updateCommand(args, {
      root,
      config,
      version: runtimeVersion,
      platform,
      stdin,
      stdout,
      stderr,
      execute: runtimeExecute,
      request,
      sleep,
      inspectResources, ensureDocker, env, arch
    });
  }
  if (command === "rollback") {
    assertNoArgs(args, "rollback");
    if (!config.previousVersion) {
      throw new Error("No previous SpaceApp version is recorded.");
    }
    const approved = await requireChangeApproval(stdin, stdout, stderr, [
      `Runtime image version: ${config.version} -> ${config.previousVersion}`,
      "Rollback restores the previously recorded runtime images and configuration."
    ]);
    if (!approved) {
      return 0;
    }
    const rollback = {
      ...config,
      version: config.previousVersion,
      previousVersion: config.version
    };
    await writeRuntimeFiles(root, rollback);
    const pullCode = await withHeadlessDockerConfig(
      platform,
      composeCommand("pull", root, { profile: rollback.profile, companionsEnabled: rollback.companionsEnabled, engine: rollback.engine }),
      (pullSpec) => runtimeExecute(pullSpec, { stdin, stdout, stderr })
    );
    if (pullCode !== 0) {
      await writeRuntimeFiles(root, config);
      return pullCode;
    }
    const upCode = await runtimeExecute(composeCommand("up", root, { profile: rollback.profile, companionsEnabled: rollback.companionsEnabled, engine: rollback.engine }), { stdin, stdout, stderr });
    if (upCode !== 0) {
      await writeRuntimeFiles(root, config);
      return upCode;
    }
    await saveConfig(root, rollback);
    stdout.write(`Rolled back to SpaceApp ${rollback.version}.\n`);
    return 0;
  }
  if (command === "backup") {
    assertNoArgs(args, command);
    // A paused, consistent backup first (external review 2026-10-16 #3), then the workspace list and CLI settings (pilot F8).
    const backupCode = await backupWithWritersPaused(runtimeExecute, root, config, { stdin, stdout, stderr });
    if (backupCode !== 0) return backupCode;
    await addBackupExtras({ root, config, stdin, stdout, stderr, execute: runtimeExecute })
      .catch((error) => stderr.write(`The backup was created; its workspace list and CLI settings were not added: ${error.message}\n`));
    return 0;
  }
  if (command === "restore") {
    assertNoArgs(args, command);
    const confirmation = await readSecret(
      stdin,
      stdout,
      "Type RESTORE to replace current SpaceApp data with the latest backup: ",
      { mask: false }
    );
    if (confirmation !== "RESTORE") {
      throw new Error("Restore cancelled.");
    }
    const backupId = await selectLatestBackupId(root);
    const backupCode = await backupWithWritersPaused(runtimeExecute, root, config, { stdin, stdout, stderr });
    if (backupCode !== 0) return backupCode;
    const stopCode = await runtimeExecute(composeCommand("stopForPortableRestore", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }), { stdin, stdout, stderr });
    if (stopCode !== 0) return stopCode;
    const restoreCode = await runtimeExecute(
      composeCommand("restore", root, { backupId, profile: config.profile, engine: config.engine }),
      { stdin, stdout, stderr }
    );
    if (restoreCode !== 0) return restoreCode;
    const upCode = await runtimeExecute(composeCommand("up", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }), { stdin, stdout, stderr });
    if (upCode !== 0) return upCode;
    if (config?.volumesPurged) {
      delete config.volumesPurged;
      await saveConfig(root, config);
    }
    await restoreBackupExtras({ root, config, backupId, stdin, stdout, stderr, execute: runtimeExecute })
      .catch((error) => stderr.write(`The data was restored; the CLI settings of the backup were not: ${error.message}\n`));
    return 0;
  }
  if (command === "uninstall") {
    const engineLabel = config.engine === "podman" ? "Podman" : "Docker";
    if (args.length === 0) {
      const approved = await requireChangeApproval(stdin, stdout, stderr, [
        "Stop and remove SpaceApp containers and network.",
        "Data, configuration, secrets, and backups remain at the installation root.",
        `${engineLabel} volumes are retained; the global SpaceApp CLI remains installed.`
      ]);
      if (!approved) {
        return 0;
      }
      stdout.write("Stopping and removing SpaceApp containers and network...\n");
      const code = await runtimeExecute(
        composeCommand("down", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }),
        { stdin, stdout, stderr }
      );
      if (code === 0) {
        stdout.write("SpaceApp runtime removed successfully. It is safe to run this command again.\n");
        stdout.write(`Data, configuration, secrets, and backups remain at ${root}.\n`);
        stdout.write(`${engineLabel} volumes are retained. The global SpaceApp CLI remains installed.\n`);
        stdout.write("To remove only the global CLI, run: npm uninstall -g run-spaceapp\n");
      } else {
        stderr.write(`Uninstall could not remove the runtime (${engineLabel} exit ${code}).\n`);
        stdout.write(`Data, configuration, secrets, and backups remain at ${root}.\n`);
        stdout.write("The global SpaceApp CLI remains installed.\n");
      }
      return code;
    }
    if (args.length === 1 && args[0] === "--purge-data") {
      const confirmation = await readSecret(stdin, stdout, `Type DELETE to remove ${engineLabel} volumes: `, { mask: false, answerKey: "purgeConfirm" });
      if (confirmation !== "DELETE") {
        throw new Error("Purge cancelled.");
      }
      stdout.write(`Removing SpaceApp containers, network, and ${engineLabel} volumes...\n`);
      const code = await runtimeExecute(
        composeCommand("purge", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }),
        { stdin, stdout, stderr }
      );
      if (code === 0) {
        await saveConfig(root, { ...config, volumesPurged: true });
        stdout.write(`SpaceApp runtime and ${engineLabel} volumes removed successfully.\n`);
        stdout.write(`Host configuration and backups remain at ${root} for manual review.\n`);
        stdout.write("The global SpaceApp CLI remains installed.\n");
        stdout.write("To remove only the global CLI, run: npm uninstall -g run-spaceapp\n");
      } else {
        stderr.write(`SpaceApp ${engineLabel} volume purge failed (${engineLabel} exit ${code}).\n`);
        stdout.write(`Host files and the global SpaceApp CLI remain at ${root}.\n`);
      }
      return code;
    }
    throw new Error(`Usage: ${UNIVERSAL_COMMAND} uninstall [--purge-data]`);
  }

  throw new Error(`Unknown command "${command}". Run "${UNIVERSAL_COMMAND} help".`);
}

/**
 * Executes the install command, guiding setup, provisioning container engine, and starting runtime.
 *
 * @param {string[]} args Command-line arguments passed to install.
 * @param {object} options Options including root, versions, execution environment, streams, and system runners.
 * @returns {Promise<number>} Process exit code (0 for success).
 */
async function installCommand(args, {
  root,
  launcherVersion,
  runtimeVersion,
  hostRootRuntimeCompatible,
  platform,
  arch,
  env,
  stdin,
  stdout,
  stderr,
  execute,
  inspectResources,
  ensureDocker,
  prepareDockerPath,
  request,
  sleep,
  persistSetupToken
}) {
  const wizard = await planInteractiveSetup({
    args,
    root,
    runtimeVersion,
    platform,
    stdin,
    stdout,
    stderr,
    execute,
    inspectResources, request, sleep, ensureDocker, env, arch
  });
  if (wizard.exit !== undefined) {
    return wizard.exit;
  }
  const {
    requestedProfile,
    requestedAccessMode,
    requestedEngine,
    noOpen,
    companionsEnabled,
    telemetryEnabled,
    installId
  } = wizard;
  const existingConfig = await loadExistingInstallation(root);
  const engine = requestedEngine ?? existingConfig?.engine ?? "docker";
  const accessMode = resolveInstallAccessMode(
    requestedAccessMode,
    existingConfig?.accessMode ?? "isolated"
  );
  if (accessMode === "host-root") {
    if (engine === "podman") {
      throw new Error("Host-root access is not supported on Podman.");
    }
    if (platform !== "linux") {
      throw new Error("Host-root access is supported only on Linux.");
    }
    if (!hostRootRuntimeCompatible) {
      throw new Error(
        "Host-root access is disabled for this launcher-only candidate because its runtime images were not rebuilt. Use --access isolated."
      );
    }
  }
  if (engine === "docker") {
    await prepareDockerPath({ platform, env });
  }
  const resources = await inspectResources(root);
  let profile = requestedProfile === "auto" && existingConfig
    ? existingConfig.profile : resolveInstallProfile(requestedProfile, resources);
  if (accessMode === "host-root") {
    stderr.write(
      "WARNING: host-root access lets SpaceApp CLI sessions read and modify the entire Linux host through /host, including credentials and system files.\n"
    );
  }
  const result = await prepareInstallation(root, {
    version: runtimeVersion,
    profile,
    accessMode,
    engine,
    ...(companionsEnabled ? { companionsEnabled } : {})
  });
  // The stored choice also drives the app's first_answer event after later updates, so an explicit
  // SPACEAPP_TELEMETRY at install time is stored like the answer it overrides (as for the install ping).
  if (!existingConfig && isInstallPingAllowed({ consent: telemetryEnabled, env })) {
    result.config = { ...result.config, telemetry: true, installId: installId ?? randomUUID() };
  }
  // The funnel reports the step a fresh install with telemetry on stopped at; an install that never
  // reports completed or failed (interrupted, or an error outside these steps) stays "started".
  const reportFunnel = existingConfig || !result.config.installId ? null : createInstallFunnel({
    installId: result.config.installId, platform, arch, launcherVersion, runtimeVersion, request,
    facts: installFunnelFacts({ platform, resources, profile, accessMode })
  });
  void reportFunnel?.("install_started");
  let stage = "resources";
  const failInstall = async (code) => {
    if (code !== 0) await reportFunnel?.("install_failed", { stage });
    return code;
  };

  const engineLabel = engine === "podman" ? "Podman" : "Docker";
  stdout.write(`Launcher version: ${launcherVersion}\n`);
  stdout.write(
    `Runtime image version: ${existingConfig?.version ?? "not installed"} -> ${result.config.version}\n`
  );
  stdout.write(
    `Profile: ${existingConfig?.profile ?? "not configured"} -> ${result.config.profile}\n`
  );
  stdout.write(
    `Access: ${existingConfig?.accessMode ?? "not configured"} -> ${result.config.accessMode}\n`
  );
  stdout.write(existingConfig && !existingConfig.volumesPurged
    ? `Preserved existing data, workspaces, credentials, secrets, and persistent ${engineLabel} volumes.\n`
    : `Future refreshes preserve data, workspaces, credentials, secrets, and persistent ${engineLabel} volumes.\n`);
  stdout.write(
    `Selected profile: ${profile} (${formatGibibytes(resources.totalMemoryBytes)} GiB system memory detected).\n`
  );
  stdout.write(`SpaceApp installation root: ${root}\n`);
  const operation = existingConfig ? (existingConfig.volumesPurged ? "fresh" : existingConfig.version === runtimeVersion ? "repair" : "upgrade") : "fresh";
  if (installResourceChecks(resources, profile, { operation }).some((check) => !check.ok)) {
    const doctorCode = await doctor({
      root,
      platform,
      stdout,
      stderr,
      execute,
      stdin,
      inspectResources,
      resources,
      profile, operation,
      engine
    });
    stderr.write(
      `Installation stopped before downloading images. Fix the failed checks and run "${UNIVERSAL_COMMAND} install" again.\n`
    );
    return failInstall(doctorCode);
  }

  stage = engine;
  let prerequisiteResult;
  if (engine === "podman") {
    prerequisiteResult = await ensurePodmanAvailable({
      platform,
      arch,
      env,
      stdin,
      stdout,
      stderr,
      execute,
      profile
    });
  } else {
    prerequisiteResult = await ensureDocker({
      platform,
      arch,
      env,
      stdin,
      stdout,
      stderr,
      execute,
      installArgs: { root, requestedProfile, requestedAccessMode, requestedEngine, noOpen, autoConfirm: true }
    });
  }
  if (prerequisiteResult.reexecuted) {
    return prerequisiteResult.code;
  }
  if (prerequisiteResult.code !== 0) {
    stderr.write(
      `Installation stopped before downloading images. Fix the failed checks and run "${UNIVERSAL_COMMAND} install" again.\n`
    );
    return failInstall(prerequisiteResult.code);
  }

  stage = "doctor";

  let storagePlan = await inspectStoragePlan({ root, config: result.config, existingConfig, resources, execute, operation });
  if (requestedProfile === "auto" && !existingConfig) {
    const engineProfile = resolveInstallProfile("auto", storagePlan.resources);
    if (engineProfile !== profile) {
      profile = engineProfile;
      result.config = { ...result.config, profile };
      stdout.write(`${engineLabel} resources select profile: ${profile}.\n`);
      storagePlan = await inspectStoragePlan({ root, config: result.config, resources: storagePlan.resources, execute, operation });
    }
  }
  const doctorCode = await doctor({
    root,
    platform,
    stdout,
    stderr,
    execute,
    stdin,
    inspectResources,
    resources,
    profile,
    dockerReady: engine === "docker",
    podmanReady: engine === "podman",
    engine,
    operation,
    storagePlan
  });
  if (doctorCode !== 0) {
    stderr.write(
      `Installation stopped before downloading images. Fix the failed checks and run "${UNIVERSAL_COMMAND} install" again.\n`
    );
    return failInstall(doctorCode);
  }
  const stagedStateRoot = await mkdtemp(join(tmpdir(), "run-spaceapp-install-"));
  let runtimeMutationAttempted = false;
  let upgradeCheckpoint = null;
  const failAfterRuntimeMutation = async (code) => {
    await failInstall(code);
    if (runtimeMutationAttempted) {
      await reportInstallDiagnostics({
        root,
        stateRoot: stagedStateRoot,
        profile,
        platform,
        stdin,
        stdout,
        stderr,
        execute,
        engine
      });
      if (upgradeCheckpoint) {
        await retainFailedUpgrade(root, upgradeCheckpoint,
          {...result.config,accessMode:existingConfig.accessMode, engine}, {stdin,stdout,stderr,execute});
      } else await restoreRuntimeAfterFailedInstall({
        root,
        stagedStateRoot,
        existingConfig: existingConfig?.volumesPurged ? null : existingConfig,
        attemptedProfile: profile,
        companionsEnabled,
        engine,
        platform,
        stdin,
        stdout,
        stderr,
        execute
      });
      runtimeMutationAttempted = false;
    }
    return code;
  };
  try {
    stage = "pull";
    await commitInstallation(stagedStateRoot, result.config, { projectRoot: root });
    const stagedComposeCommand = (action, options = {}) =>
      composeCommand(action, root, {
        profile,
        stateRoot: stagedStateRoot,
        companionsEnabled,
        engine,
        ...options
      });
    const pullCode = await withHeadlessDockerConfig(
      platform,
      stagedComposeCommand("pull"),
      (pullSpec) => executeWithDockerDiagnostics(
        execute,
        pullSpec,
        { stdin, stdout, stderr },
        { platform, stderr }
      )
    );
    if (pullCode !== 0) return failInstall(pullCode);
    stage = "storage";
    if (await verifyStorage({ root, config: result.config, existingConfig, operation,
      inspectResources, execute, stdout, stderr }) !== 0) return failInstall(1);
    stage = "start";
    if (existingConfig && existingConfig.version !== result.config.version && !existingConfig.volumesPurged) {
      upgradeCheckpoint = await createQuiescedCheckpoint(root, existingConfig, {stdin,stdout,stderr,execute,platform});
    }
    runtimeMutationAttempted = true;
    if (existingConfig && !profileRuntimeSettings(existingConfig.profile).temporalEnabled &&
        profileRuntimeSettings(profile).temporalEnabled) {
      const temporalCode = await executeWithDockerDiagnostics(execute,
        stagedComposeCommand("enableTemporal"), { stdin, stdout, stderr }, { platform, stderr });
      if (temporalCode !== 0) return await failAfterRuntimeMutation(temporalCode);
    }
    const upCode = await executeWithDockerDiagnostics(
      execute,
      stagedComposeCommand("up"),
      { stdin, stdout, stderr },
      { platform, stderr }
    );
    if (upCode !== 0) return await failAfterRuntimeMutation(upCode);

    const url = `http://${result.config.bindHost}:${result.config.port}`;
    stage = "ready";
    stdout.write(
      `Waiting up to ${APPLICATION_READY_WAIT_MINUTES} minutes for SpaceApp services to become ready...\n`
    );
    const ready = await waitForApplicationReady({
      url,
      request,
      sleep,
      attemptTimeoutMs: Number(env.SPACEAPP_READY_ATTEMPT_TIMEOUT_MS) || APPLICATION_READY_ATTEMPT_TIMEOUT_MS,
      onProgress: async ({ elapsedSeconds }) => {
        stdout.write(
          `Still waiting for SpaceApp services (${elapsedSeconds} seconds elapsed; ` +
          `up to ${APPLICATION_READY_WAIT_MINUTES} minutes)...\n`
        );
        try {
          const statusCode = await executeWithDockerDiagnostics(
            execute,
            stagedComposeCommand("status"),
            { stdin, stdout, stderr },
            { platform, stderr }
          );
          if (statusCode !== 0) {
            stderr.write(`SpaceApp service status check failed with ${engineLabel} exit ${statusCode}.\n`);
          }
        } catch (error) {
          stderr.write(
            `SpaceApp could not collect status diagnostics: ${error?.message || String(error)}.\n`
          );
        }
        if (
          elapsedSeconds % APPLICATION_READY_LOG_INTERVAL_SECONDS === 0 &&
          elapsedSeconds < APPLICATION_READY_WAIT_MINUTES * 60
        ) {
          stdout.write(`Showing recent startup logs after ${elapsedSeconds} seconds...\n`);
          try {
            const logsCode = await executeWithDockerDiagnostics(
              execute,
              stagedComposeCommand("logs", { lines: 50 }),
              { stdin, stdout, stderr },
              { platform, stderr }
            );
            if (logsCode !== 0) {
              stderr.write(`SpaceApp startup log check failed with ${engineLabel} exit ${logsCode}.\n`);
            }
          } catch (error) {
            stderr.write(
              `SpaceApp could not collect logs diagnostics: ${error?.message || String(error)}.\n`
            );
          }
        }
      }
    });
    if (!ready) {
      stderr.write(
        `SpaceApp containers started, but the application did not become ready within ` +
        `${APPLICATION_READY_WAIT_MINUTES} minutes.\n`
      );
      return await failAfterRuntimeMutation(1);
    }

    stage = "owner_setup";
    let setupStatus;
    try {
      setupStatus = await requestSetupStatus({ url, request });
    } catch (error) {
      stderr.write(
        `SpaceApp is ready, but owner setup status could not be verified: ${error?.message || String(error)}\n` +
        `Run "${UNIVERSAL_COMMAND} status" and "${UNIVERSAL_COMMAND} logs", then run "${UNIVERSAL_COMMAND} install" again.\n`
      );
      return await failAfterRuntimeMutation(1);
    }

    let setupToken = null;
    if (setupStatus.setupRequired) {
      setupToken = randomBytes(32).toString("base64url");
      const rotateCode = await executeWithDockerDiagnostics(
        execute,
        stagedComposeCommand("rotateOwnerSetupToken"),
        {
          stdin,
          stdout,
          stderr,
          input: `${setupToken}\n`
        },
        { platform, stderr }
      );
      if (rotateCode !== 0) {
        stderr.write(
          `SpaceApp is ready, but a fresh owner setup token could not be created. Run "${UNIVERSAL_COMMAND} owner rotate-setup-token".\n`
        );
        return await failAfterRuntimeMutation(rotateCode);
      }
    }

    stage = "cleanup";
    const cleanupCode = await removeInactiveProfileServices({root, config: result.config,
      stateRoot: stagedStateRoot, execute, stdin, stdout, stderr});
    if (cleanupCode !== 0) return await failAfterRuntimeMutation(cleanupCode);

    if (setupToken) {
      try {
        await persistSetupToken(root, setupToken);
      } catch {
        stderr.write(
          "SpaceApp accepted a new setup token, but it could not be saved locally.\n" +
          `Run "${UNIVERSAL_COMMAND} owner rotate-setup-token" to obtain a usable token.\n`
        );
        return await failAfterRuntimeMutation(1);
      }


    }

    await commitInstallation(root, result.config);
    if(upgradeCheckpoint) await markCheckpointVerified(upgradeCheckpoint);
    runtimeMutationAttempted = false;
    await reportFunnel?.("install_completed", { profile });
    stdout.write(`SpaceApp is ready at ${url}\n`);
    if (setupToken) {
      stdout.write(`One-time setup token: ${setupToken}\n`);
      stdout.write('Paste it into the "One-time setup token" field in the page that opens.\n');
      stdout.write("It expires in 15 minutes and stops working after the first owner is created.\n");
      stdout.write(`If it expires, run: ${UNIVERSAL_COMMAND} owner rotate-setup-token\n`);
    } else {
      stdout.write(
        "\nNotice: Existing SpaceApp database detected with an already registered operator account.\n" +
        "Sign in using your existing email and password.\n" +
        `- Forgot password? Run: "${UNIVERSAL_COMMAND} owner reset-password"\n` +
        `- Clean install from scratch: "${UNIVERSAL_COMMAND} factory-reset"\n\n`
      );
    }
    stdout.write(
      "Next: open the Getting Started room and use OpenCode. A working free model is selected on first launch.\n" +
      `Optional providers: "${UNIVERSAL_COMMAND} credentials set <provider>".\n`
    );
    if (noOpen) return 0;
    const openCode = await openBrowser(url, platform, execute, { stdin, stdout, stderr });
    if (openCode !== 0) {
      stderr.write(`Could not open SpaceApp automatically. Open ${url} manually.\n`);
    }
    return 0;
  } catch (error) {
    await failAfterRuntimeMutation(1);
    throw error;
  } finally {
    await rm(stagedStateRoot, { recursive: true, force: true });
  }
}

/**
 * Removes container services that are disabled in the target profile.
 *
 * @param {object} params Options including root, config, stateRoot, execute, and io streams.
 * @returns {Promise<number>} Exit code from compose removal.
 */
async function removeInactiveProfileServices({root, config, stateRoot = root, execute, stdin, stdout, stderr}) {
  const settings = profileRuntimeSettings(config.profile);
  for (const [enabled, action, profile] of [
    [settings.browserEnabled, "removeBrowser", "standard"],
    [settings.temporalEnabled, "removeTemporal", "medium"]
  ]) {
    if (enabled) continue;
    const code = await execute(composeCommand(action, root, {profile, stateRoot, engine: config?.engine}), {stdin, stdout, stderr});
    if (code !== 0) {
      stderr.write("Inactive service cleanup failed. Data volumes were preserved. Run doctor --fix.\n");
      return code;
    }
  }
  return 0;
}

/**
 * Collects interactive setup options and system resource requirements to formulate an installation plan.
 *
 * @param {object} params Setup parameters including args, root, versions, platform, and runners.
 * @returns {Promise<object>} Planned installation parameters and options.
 */
async function planInteractiveSetup({
  args,
  root,
  runtimeVersion,
  platform,
  stdin,
  stdout,
  stderr,
  execute,
  inspectResources,
  request, sleep, ensureDocker, env, arch
}) {
  const parsed = parseInstallArgs(args);
  const rawExisting = await readRawConfig(root);
  const repairs = planConfigRepairs(rawExisting);
  const path = upgradePath(rawExisting?.version ?? null, runtimeVersion);
  const interactive = interactiveAvailable(stdin);
  const continuation = await readRunOnceContinuation(root, { platform, runtimeVersion });

  if (!interactive && !continuation && !approvedAutomation(stdin)) {
    stderr.write(
      "SpaceApp setup changes require an interactive terminal (TTY). " +
      "Re-run from a terminal, or continue an approved Windows RunOnce plan.\n"
    );
    return { exit: 1 };
  }

  const resources = await inspectResources(root);
  const resolveProfileChoice = (choice) => {
    const resolved = choice === "auto" && rawExisting?.profile
      ? rawExisting.profile : resolveInstallProfile(choice, resources);
    return { resolved, display: choice === "auto" ? `auto (${resolved})` : resolved };
  };

  let requestedEngine = parsed.requestedEngine;
  const answers = stdin?._spaceappPromptController?.answers;
  if (!requestedEngine && answers?.engine !== undefined) {
    if (!["docker", "podman"].includes(answers.engine)) {
      throw new Error(`Unsupported engine "${answers.engine}". Supported engines: docker, podman.`);
    }
    requestedEngine = answers.engine;
    parsed.requestedEngine = requestedEngine;
  }

  if (rawExisting && requestedEngine) {
    const savedEngine = rawExisting.engine ?? "docker";
    if (requestedEngine !== savedEngine && rawExisting.volumesPurged !== true) {
      throw new Error(
        `Cannot switch container engine from "${savedEngine}" to "${requestedEngine}" on an existing installation. Docker and Podman volumes are not interchangeable. To migrate engines, run "spaceapp backup", uninstall with "spaceapp uninstall --purge-data", install with "--engine ${requestedEngine}", and run "spaceapp restore".`
      );
    }
  }

  if (continuation) {
    await consumeRunOnceContinuation(root);
    stdout.write("Continuing the approved unattended SpaceApp setup plan.\n");
    await applyApprovedConfigRepairs(root, rawExisting);
    const actions = continuation.actions ?? {};
    return {
      requestedProfile: actions.profile ?? "auto",
      requestedAccessMode: actions.accessMode,
      requestedEngine: actions.engine ?? requestedEngine,
      noOpen: actions.noOpen !== false,
      companionsEnabled: actions.companionsEnabled ?? false,
      telemetryEnabled: actions.telemetry ?? false,
      installId: actions.installId
    };
  }

  if (path === "fresh") {
    if (!requestedEngine) {
      if (parsed.requestedAccessMode === "host-root" || platform === "win32") {
        requestedEngine = "docker";
      } else {
        let dockerWorking = false;
        try {
          dockerWorking = true;
          for (const spec of [
            { command: "docker", args: ["--version"], timeoutMs: 15000 },
            { command: "docker", args: ["compose", "version"], timeoutMs: 15000 },
            { command: "docker", args: ["info"], timeoutMs: 15000 }
          ]) {
            if (await execute(spec, { stdin: null, stdout: null, stderr: null }) !== 0) {
              dockerWorking = false;
              break;
            }
          }
        } catch {
          dockerWorking = false;
        }

        if (dockerWorking) {
          requestedEngine = "docker";
        } else {
          let podmanWorking = false;
          try {
            podmanWorking = await podmanIsReady(execute);
          } catch {
            podmanWorking = false;
          }

          if (podmanWorking) {
            if (!interactive) {
              requestedEngine = "podman";
            } else {
              requestedEngine = await promptChoice(stdin, stdout, "Which container engine?", [
                { label: "docker (Docker Engine / Docker Desktop)", value: "docker" },
                { label: "podman (Podman rootless)", value: "podman" }
              ], { defaultIndex: 0, answerKey: "engine" });
            }
          } else {
            requestedEngine = "docker";
          }
        }
      }
    }
    const profileChoice = await promptChoice(stdin, stdout, "Which installation profile?", [
      { label: `auto (${resolveProfileChoice("auto").resolved}; ${resources.cpuCount} CPUs, ${formatGibibytes(resources.totalMemoryBytes)} GiB RAM, ${formatGibibytes(resources.freeDiskBytes)} GiB free)`, value: "auto" },
      { label: "small (SpaceApp + OpenCode; no background workflows or managed browser)", value: "small" },
      { label: "medium (background workflows and integration workers)", value: "medium" },
      { label: "large (workflows + managed browser; larger resource limits)", value: "large" },
      { label: "light (legacy compatibility)", value: "light" },
      { label: "standard (legacy compatibility)", value: "standard" }
    ], { defaultIndex: Math.max(0, ["auto", "small", "medium", "large", "light", "standard"].indexOf(parsed.requestedProfile)), answerKey: "profile" });
    const accessChoice = await promptChoice(stdin, stdout, "Which access mode?", [
      { label: "isolated (recommended; no host access)", value: "isolated" },
      { label: "host-root (Linux only; CLI sessions can read and modify the whole host)", value: "host-root" }
    ], { defaultIndex: parsed.requestedAccessMode === "host-root" ? 1 : 0, answerKey: "access" });
    const companionsChoice = await promptYesNo(stdin, stdout, "Enable companion integrations (Claude Code, browser companions)?", { defaultYes: parsed.companionsEnabled, answerKey: "companions" });
    stdout.write(
      "Anonymous telemetry sends spaceapp.dev a random install ID with the OS and its version, CPUs, RAM, profile,\n" +
      "install progress, screen size, browser, language and country (no IP is stored), whether the owner, a CLI and\n" +
      "a first answer were set up, and one 'active' event a day. Never files, prompts, answers, accounts or credentials.\n"
    );
    const telemetryChoice = await promptYesNo(stdin, stdout, "Enable anonymous usage telemetry?", { defaultYes: false, answerKey: "telemetry" });
    // Created at consent so a Windows continuation after the Docker install keeps the same install id.
    const installId = telemetryChoice ? randomUUID() : undefined;
    let dockerChoice = true;
    if (platform === "win32" && requestedEngine === "docker") {
      const dockerProbe = await detectDockerAvailable({ execute });
      if (dockerProbe !== 0) {
        dockerChoice = await promptYesNo(stdin, stdout, "Docker Engine was not detected. Include automatic Docker installation?", { defaultYes: true });
      }
    }
    const openBrowserChoice = await promptYesNo(stdin, stdout, "Open the web application when installation completes?", { defaultYes: !parsed.noOpen, answerKey: "open" });

    const { resolved } = resolveProfileChoice(profileChoice);
    const engineLabel = requestedEngine === "podman" ? "Podman" : "Docker";
    const approved = await finalConfirmation(stdin, stdout, [
      `Installation root: ${root}`,
      `Runtime image version: not installed -> ${runtimeVersion}`,
      `Profile: ${profileChoice === "auto" ? `auto (${resolved})` : profileChoice}`,
      `Access mode: ${accessChoice}`,
      `Companions: ${companionsChoice ? "enabled" : "disabled"}`,
      `Telemetry: ${telemetryChoice ? "enabled" : "disabled"}`,
      ...(requestedEngine === "podman"
        ? ["Container engine: podman (rootless)"]
        : [`Docker installation: ${dockerChoice ? "automatic if missing" : "not included"}`]),
      `Open browser afterwards: ${openBrowserChoice ? "yes" : "no"}`,
      `Future refreshes preserve data, workspaces, credentials, secrets, and persistent ${engineLabel} volumes.`
    ]);
    if (!approved) {
      return { exit: 0 };
    }
    if (platform === "win32") {
      await offerUnattendedContinuation(root, runtimeVersion, stdin, stdout, {
        profile: profileChoice,
        accessMode: accessChoice,
        engine: requestedEngine,
        companionsEnabled: companionsChoice,
        telemetry: telemetryChoice,
        installId,
        noOpen: !openBrowserChoice
      });
    }
    return {
      requestedProfile: profileChoice,
      requestedAccessMode: accessChoice,
      requestedEngine,
      noOpen: !openBrowserChoice,
      companionsEnabled: companionsChoice,
      telemetryEnabled: telemetryChoice,
      installId
    };
  }

  if (path === "same" && !hasRequestedConfigChange(rawExisting, parsed)) {
    const choice = await promptChoice(stdin, stdout, `SpaceApp ${rawExisting.version} is already installed. What would you like to do?`, [
      { label: "Run doctor diagnostics (read-only)", value: "doctor" },
      { label: "Repair the runtime (recreate containers from the current configuration)", value: "repair" },
      { label: "Cancel", value: "cancel" }
    ], {defaultIndex:1, answerKey:"action"});
    if (choice === "cancel") {
      stdout.write("Cancelled. No changes were made.\n");
      return { exit: 0 };
    }
    if (choice === "doctor") {
      return { exit: await doctor({ root, platform, stdout, stderr, execute, stdin, inspectResources, resources }) };
    }
    await applyApprovedConfigRepairs(root, rawExisting);
    const config = await loadExistingInstallation(root);
    const code = await repairRuntime({ root, config, platform, stdin, stdout, stderr, execute, request, sleep, ensureDocker, env, arch, inspectResources });
    if(code === 0 && !parsed.noOpen) await openBrowser(`http://${config.bindHost}:${config.port}`, platform, execute, {stdin,stdout,stderr});
    return {exit:code};
  }

  if (path === "downgrade") {
    stderr.write(
      `WARNING: target ${runtimeVersion} is OLDER than the installed ${rawExisting.version}.\n` +
      "A downgrade can lose data created by the newer version.\n"
    );
    const typed = await readSecret(stdin, stdout, "Type DOWNGRADE to proceed with the controlled rollback: ", { mask: false });
    if (typed !== "DOWNGRADE") {
      stdout.write("Cancelled. No changes were made.\n");
      return { exit: 0 };
    }
  } else if (path === "unsupported") {
    stderr.write(
      `Installed version ${rawExisting.version} is older than the minimum supported upgrade source ` +
      `${SPACEAPP_UPGRADE_POLICY.minSupportedSourceVersion}. Make a backup, then reinstall from scratch.\n`
    );
    return { exit: 1 };
  } else if (path === "unknown") {
    stderr.write(
      `Installed version ${rawExisting.version} cannot be compared with target ${runtimeVersion}. Installation cancelled.\n`
    );
    return { exit: 1 };
  }

  const engineLabel = (parsed.requestedEngine ?? rawExisting?.engine) === "podman" ? "Podman" : "Docker";
  const repairLines = repairs.actions.map((action) => `Config repair: ${action.detail}`);
  const approved = await finalConfirmation(stdin, stdout, [
    `Installation root: ${root}`,
    `Runtime image version: ${rawExisting?.version ?? "not installed"} -> ${runtimeVersion}`,
    `Profile: ${rawExisting?.profile ?? "not configured"} -> ${resolveProfileChoice(parsed.requestedProfile).display}`,
    `Access mode: ${rawExisting?.accessMode ?? "not configured"} -> ${resolveInstallAccessMode(parsed.requestedAccessMode, rawExisting?.accessMode ?? "isolated")}`,
    ...repairLines,
    path === "preserve-recreate"
      ? "Runtime: preserve/recreate (containers are recreated without touching data volumes)."
      : "Runtime: staged upgrade with a verified checkpoint; a failure after cutover preserves current data for recovery with doctor --fix.",
    `Preserved: data, workspaces, credentials, secrets, and persistent ${engineLabel} volumes.`
  ]);
  if (!approved) {
    return { exit: 0 };
  }
  await applyApprovedConfigRepairs(root, rawExisting);
  if (platform === "win32") {
    await offerUnattendedContinuation(root, runtimeVersion, stdin, stdout, {
      profile: parsed.requestedProfile,
      accessMode: parsed.requestedAccessMode,
      engine: parsed.requestedEngine ?? rawExisting?.engine,
      companionsEnabled: parsed.companionsEnabled,
      noOpen: parsed.noOpen
    });
  }
  return {
    requestedProfile: parsed.requestedProfile,
    requestedAccessMode: parsed.requestedAccessMode,
    requestedEngine: parsed.requestedEngine ?? rawExisting?.engine,
    noOpen: parsed.noOpen,
    companionsEnabled: parsed.companionsEnabled,
    telemetryEnabled: false
  };
}

/**
 * Detects whether requested command-line options differ from the existing configuration.
 *
 * @param {object|null} rawExisting Existing configuration object.
 * @param {object} parsed Parsed command-line install arguments.
 * @returns {boolean} True if a configuration change is requested.
 */
function hasRequestedConfigChange(rawExisting, parsed) {
  if (!rawExisting) {
    return false;
  }
  if (
    parsed.requestedEngine !== undefined &&
    rawExisting.engine !== parsed.requestedEngine &&
    (rawExisting.engine ?? "docker") !== parsed.requestedEngine
  ) {
    return true;
  }
  if (
    parsed.requestedAccessMode !== undefined &&
    rawExisting.accessMode !== parsed.requestedAccessMode
  ) {
    return true;
  }
  if (parsed.companionsEnabled && rawExisting.companionsEnabled !== true) {
    return true;
  }
  if (parsed.requestedProfile !== "auto" && rawExisting.profile !== parsed.requestedProfile) {
    return true;
  }
  return false;
}

/**
 * Applies planned configuration repairs to an existing installation config file.
 *
 * @param {string} root Installation root directory path.
 * @param {object|null} rawExisting Raw existing configuration object.
 * @returns {Promise<object|null>} Repaired configuration object or null if no repairs needed.
 */
async function applyApprovedConfigRepairs(root, rawExisting) {
  if (!rawExisting) {
    return null;
  }
  const { actions } = planConfigRepairs(rawExisting);
  if (actions.length === 0) {
    return null;
  }
  const repaired = applyConfigRepairs(rawExisting);
  await saveConfig(root, repaired);
  return repaired;
}

/**
 * Probes the Docker CLI to detect if Docker is installed and executable.
 *
 * @param {object} params Parameter containing the execute function.
 * @returns {Promise<number>} Exit code 0 if available, 127 or non-zero otherwise.
 */
async function detectDockerAvailable({ execute }) {
  try {
    return await execute({ command: "docker", args: ["--version"] }, { stdin: null, stdout: null, stderr: null });
  } catch {
    return 127;
  }
}

/**
 * Offers the user an option to store an unattended RunOnce continuation on Windows.
 *
 * @param {string} root Installation root directory path.
 * @param {string} runtimeVersion Target runtime version string.
 * @param {import("node:stream").Readable} stdin Standard input stream.
 * @param {import("node:stream").Writable} stdout Standard output stream.
 * @param {object} actions Planned actions dictionary.
 * @returns {Promise<void>}
 */
async function offerUnattendedContinuation(root, runtimeVersion, stdin, stdout, actions) {
  const answer = await promptYesNo(
    stdin,
    stdout,
    "Allow an unattended continuation for this same version on the next Windows RunOnce run (expires in 24h)?",
    { defaultYes: false }
  );
  if (answer) {
    await writeRunOnceContinuation(root, { runtimeVersion, actions });
    stdout.write("Unattended continuation stored; it is consumed once and expires in 24 hours.\n");
  }
}

/**
 * Repairs configuration, environment variables, compose templates, and runtime containers in place.
 *
 * @param {object} params Repair options including root, config, platform, streams, and runners.
 * @returns {Promise<number>} Process exit code (0 for success).
 */
async function repairRuntime({ root, config, platform, stdin, stdout, stderr, execute, request, sleep, dryRun = false, ensureDocker = ensureDockerAvailable, env = process.env, arch = process.arch, inspectResources = inspectSystemResources }) {
  const raw = await readRawConfig(root);
  const plan = planConfigRepairs(raw);
  if (dryRun) {
    stdout.write(`Config repairs planned: ${JSON.stringify(plan)}\n`);
    return 0;
  }
  if (!raw) throw new Error(`No installation found. Run "${UNIVERSAL_COMMAND} install" first.`);
  const repaired = applyConfigRepairs(raw);
  if (!await requireChangeApproval(stdin, stdout, stderr, [
    "Repair configuration and recreate the current runtime without deleting data.",
    ...plan.actions.map((action) => action.detail)
  ])) return 1;
  const engine = repaired.engine ?? "docker";
  if (engine === "podman") {
    const ready = await podmanIsReady(execute);
    if (!ready) {
      stderr.write(`Podman is not running or accessible. ${podmanInstallHelp(platform)}\n`);
      return 1;
    }
    const podmanInfo = await getPodmanInfo(execute);
    const isRootless = Boolean(podmanInfo?.host?.security?.rootless);
    if (!isRootless) {
      stderr.write("Rootless Podman is required. Running Podman as root is not supported.\n");
      return 1;
    }
  } else {
    const prerequisites = await ensureDocker({platform, arch, env, stdin, stdout, stderr, execute, sleep: sleep || wait,
      installArgs: {root,requestedProfile:repaired.profile,requestedAccessMode:repaired.accessMode,requestedEngine:engine,noOpen:true,autoConfirm:true}});
    if(prerequisites.reexecuted || prerequisites.code !== 0) return prerequisites.code;
  }
  config = repaired;
  if (await verifyStorage({ root, config, existingConfig: config, operation: "repair", inspectResources, execute, stdout, stderr }) !== 0) return 1;
  await saveConfig(root, config);
  await writeRuntimeFiles(root, config);
  const pullCode = await withHeadlessDockerConfig(
    platform,
    composeCommand("pull", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }),
    (pullSpec) => execute(pullSpec, { stdin, stdout, stderr })
  );
  if (pullCode !== 0) {
    if (config.engine !== "podman") {
      writeWindowsCredentialHint(platform, stderr);
    }
    return pullCode;
  }
  if (await verifyStorage({ root, config, existingConfig: config, operation: "repair", inspectResources, execute, stdout, stderr }) !== 0) return 1;
  const upCode = await execute(
    composeCommand("repair", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }),
    { stdin, stdout, stderr }
  );
  if (upCode !== 0) {
    return upCode;
  }
  if (typeof request === "function") {
    const url = `http://${config.bindHost}:${config.port}`;
    const ready = await waitForReadiness({
      url,
      request,
      sleep: sleep || wait,
      onProgress: async ({ elapsedSeconds }) => {
        stdout.write(`Waiting for SpaceApp readiness after repair (${elapsedSeconds}s)...\n`);
      }
    });
    if (!ready) {
      stderr.write("SpaceApp runtime repair completed, but readiness check timed out.\n");
      return 1;
    }
  }
  const cleanupCode = await removeInactiveProfileServices({root, config, execute, stdin, stdout, stderr});
  if (cleanupCode !== 0) return cleanupCode;
  if (config?.volumesPurged) {
    delete config.volumesPurged;
    await saveConfig(root, config);
  }
  stdout.write(`SpaceApp ${config.version} runtime repaired.\n`);
  return 0;
}

/**
 * Upgrades SpaceApp to a new version, creating checkpoints, verifying storage, and rolling back on failure.
 *
 * @param {object} params Update parameters including root, config, targetVersion, platform, streams, and runners.
 * @returns {Promise<number>} Process exit code (0 for success).
 */
async function performUpdate({
  root,
  config,
  targetVersion,
  platform,
  stdin,
  stdout,
  stderr,
  execute,
  preserveRecreate,
  request,
  sleep,
  inspectResources = inspectSystemResources
}) {
  const updated = targetVersion === config.version
    ? config
    : {
      ...config,
      version: targetVersion,
      previousVersion: config.version
    };
  const stagedRoot = await mkdtemp(join(tmpdir(), "spaceapp-update-"));
  let checkpoint = null;
  try {
    await commitInstallation(stagedRoot, updated, { projectRoot: root });
    const stagedCommand = (action) => composeCommand(action, root, {...updated, engine: updated.engine, stateRoot: stagedRoot});
    const pullCode = await withHeadlessDockerConfig(
      platform, stagedCommand("pull"),
      (pullSpec) => execute(pullSpec, { stdin, stdout, stderr })
    );
    if (pullCode !== 0) {
      if (updated.engine !== "podman") {
        writeWindowsCredentialHint(platform, stderr);
      }
      const engineLabel = updated.engine === "podman" ? "Podman" : "Docker";
      throw new Error(`Image pull failed with ${engineLabel} exit ${pullCode}.`);
    }
    if (await verifyStorage({ root, config: updated, existingConfig: config, operation: "upgrade", inspectResources, execute, stdout, stderr }) !== 0) return 1;
    checkpoint = await createQuiescedCheckpoint(root, config, {stdin, stdout, stderr, execute, platform});
    await commitInstallation(root, updated, { persistConfig: false });
    const upCode = await execute(
      composeCommand("up", root, { profile: updated.profile, companionsEnabled: updated.companionsEnabled, engine: updated.engine }),
      { stdin, stdout, stderr }
    );
    if (upCode !== 0) {
      const engineLabel = updated.engine === "podman" ? "Podman" : "Docker";
      throw new Error(`Runtime start failed with ${engineLabel} exit ${upCode}.`);
    }
    if (typeof request === "function") {
      const url = `http://${updated.bindHost}:${updated.port}`;
      const ready = await waitForReadiness({
        url,
        request,
        sleep: sleep || wait,
        onProgress: async ({ elapsedSeconds }) => {
          stdout.write(`Waiting for SpaceApp readiness after update (${elapsedSeconds}s)...\n`);
        }
      });
      if (!ready) {
        throw new Error("Updated runtime started, but readiness check timed out.");
      }
    }
    await saveConfig(root, updated);
    await markCheckpointVerified(checkpoint);
    stdout.write(`Updated to SpaceApp ${targetVersion}.\n`);
    return 0;
  } catch (error) {
    stderr.write(`SpaceApp update failed: ${error?.message || String(error)}\n`);
    if(checkpoint) await retainFailedUpgrade(root, checkpoint, updated, {stdin,stdout,stderr,execute});
    return 1;
  } finally {
    await rm(stagedRoot, {recursive: true, force: true});
  }
}

const CHECKPOINT_ID_PATTERN = /^spaceapp-checkpoint-\d{8}T\d{6}Z(?:-[a-f0-9]{8})?$/;
const CHECKPOINT_KEEP_COUNT = 2;

/**
 * Generates a unique checkpoint identifier string based on timestamp and random bytes.
 *
 * @returns {string} Checkpoint identifier string.
 */
function checkpointId() {
  return `spaceapp-checkpoint-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomBytes(4).toString("hex")}`;
}

/**
 * Generates a manifest file entry with size and SHA-256 hash for a specified path.
 *
 * @param {string} path Actual file system path.
 * @param {string} logicalPath Relative logical path stored in the manifest.
 * @returns {Promise<{ path: string, bytes: number, sha256: string }>} Manifest entry object.
 */
async function manifestEntry(path, logicalPath) {
  const content = await readFile(path);
  return {
    path: logicalPath,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

/**
 * Recursively copies a directory tree from source to destination.
 *
 * @param {string} source Source directory path.
 * @param {string} destination Destination directory path.
 * @returns {Promise<void>}
 */
async function cpDirectory(source, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const entrySource = join(source, entry.name);
    const entryDestination = join(destination, entry.name);
    if (entry.isDirectory()) {
      await cpDirectory(entrySource, entryDestination);
    } else {
      await copyFile(entrySource, entryDestination);
    }
  }
}

/**
 * Recursively scans a directory and collects manifest entries for all contained files.
 *
 * @param {string} directory Filesystem directory path.
 * @param {string} logicalDirectory Base logical path prefix for manifest entries.
 * @returns {Promise<Array<{ path: string, bytes: number, sha256: string }>>} List of manifest entries.
 */
async function collectFiles(directory, logicalDirectory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) {
      files.push(...await collectFiles(join(directory, entry.name), `${logicalDirectory}/${entry.name}`));
    } else {
      files.push(await manifestEntry(join(directory, entry.name), `${logicalDirectory}/${entry.name}`));
    }
  }
  return files;
}

// Writers (core, CLI, browser, Temporal) are frozen, not stopped, while the backup runs in a one-off container:
// the database, files, memory and Temporal histories are one moment and CLI sessions survive (external review
// 2026-10-16). Compose skips services that are not running.
async function backupWithWritersPaused(execute, root, config, io) {
  const options = { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine };
  io.stdout.write("Pausing SpaceApp writers for the backup; the app and CLI sessions resume afterwards...\n");
  const pauseCode = await execute(composeCommand("pauseWriters", root, options), io);
  if (pauseCode !== 0) return pauseCode;
  let backupCode = 1;
  let resumeCode = 1;
  try {
    backupCode = await execute(composeCommand("backup", root, options), io);
  } finally {
    resumeCode = await execute(composeCommand("unpauseWriters", root, options), io).catch(() => 1);
    if (resumeCode !== 0) io.stderr.write(`SpaceApp writers could not be resumed (exit ${resumeCode}). Run "${UNIVERSAL_COMMAND} up".\n`);
  }
  return backupCode !== 0 ? backupCode : resumeCode;
}

/**
 * Pauses container database writers and creates a full state checkpoint before upgrade.
 *
 * @param {string} root Installation root directory path.
 * @param {object} config SpaceApp configuration object.
 * @param {object} io Execution context containing streams and execute runner.
 * @returns {Promise<object>} Checkpoint descriptor object.
 */
async function createQuiescedCheckpoint(root, config, io) {
  io.stdout.write("Pausing SpaceApp writers before the database checkpoint...\n");
  try {
    io.stdout.write("Ensuring the existing PostgreSQL database is ready for the checkpoint...\n");
    const databaseCode = await io.execute(composeCommand("ensureCheckpointDatabase", root, config), io);
    if (databaseCode !== 0) throw new Error(`The existing PostgreSQL database did not become ready (exit ${databaseCode}). The upgrade was not applied.`);
    const code = await io.execute(composeCommand("stopForRestore", root, config), io);
    if (code !== 0) throw new Error(`Could not pause SpaceApp writers (exit ${code}).`);
    return await createCheckpoint(root, config, io);
  } catch (error) {
    const resumed = await io.execute(composeCommand("up", root, config), io).catch(() => 1);
    if (resumed !== 0) io.stderr.write("RECOVERY_REQUIRED: could not resume the unchanged runtime. Run doctor --fix.\n");
    throw error;
  }
}

/**
 * Creates a checkpoint snapshot of configuration files, secrets, and database dump.
 *
 * @param {string} root Installation root directory path.
 * @param {object} config SpaceApp configuration object.
 * @param {object} io Options containing streams, execute runner, and platform.
 * @returns {Promise<object>} Checkpoint descriptor object with id, path, and manifest.
 */
async function createCheckpoint(root, config, { stdin, stdout, stderr, execute, platform }) {
  const id = checkpointId();
  const path = join(root, "checkpoints", id);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    version: config.version,
    files: []
  };
  const fileNames = [
    "config.json",
    "runtime.env",
    "compose.yml",
    "compose.workspaces.yml",
    "compose.host-access.yml"
  ];
  for (const fileName of fileNames) {
    await copyFile(join(root, fileName), join(path, fileName));
    manifest.files.push(await manifestEntry(join(path, fileName), fileName));
  }
  await cpDirectory(join(root, "secrets"), join(path, "secrets"));
  for (const file of await collectFiles(join(path, "secrets"), "secrets")) {
    manifest.files.push(file);
  }
  stdout.write("Creating checkpoint (configuration, secrets, and database dump)...\n");
  const dumpPath = join(path, "postgres.dump");
  const dumpStream=createWriteStream(dumpPath,{mode:0o600});
  await once(dumpStream,"open");
  let dumpCode;
  try {
    dumpCode = await execute(
      composeCommand("checkpointDump", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }),
      { stdin: null, stdout: dumpStream, stderr }
    );
  } finally {
    dumpStream.end();
    await once(dumpStream,"close");
  }
  const dumpSize=(await stat(dumpPath)).size;
  if (dumpCode !== 0 || dumpSize === 0) {
    await rm(path, { recursive: true, force: true });
    throw new Error(`Checkpoint database dump failed or was empty (exit ${dumpCode}). The upgrade was not applied.`);
  }
  manifest.files.push(await manifestEntry(dumpPath, "postgres.dump"));
  await writeFile(join(path, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const verified = await verifyCheckpoint({ path, manifest });
  if (!verified) {
    throw new Error(`Checkpoint verification failed. The checkpoint remains at ${path}. No changes were made.`);
  }
  return { id, path, manifest };
}

/**
 * Verifies that all files in a checkpoint exist on disk and match their manifest SHA-256 hashes.
 *
 * @param {object} checkpoint Checkpoint descriptor object.
 * @returns {Promise<boolean>} True if all files match manifest, false otherwise.
 */
async function verifyCheckpoint(checkpoint) {
  for (const file of checkpoint.manifest.files ?? []) {
    const actual = await manifestEntry(join(checkpoint.path, file.path), file.path).catch(() => null);
    if (!actual || actual.bytes !== file.bytes || actual.sha256 !== file.sha256) {
      return false;
    }
  }
  return true;
}

/**
 * Retains failed upgrade state and writes recovery metadata to the checkpoint for manual diagnostics.
 *
 * @param {string} root Installation root directory path.
 * @param {object} checkpoint Checkpoint descriptor object.
 * @param {object} attemptedConfig Attempted configuration object.
 * @param {object} io IO streams and execute runner.
 * @returns {Promise<void>}
 */
async function retainFailedUpgrade(root, checkpoint, attemptedConfig, io) {
  // A partially started runtime may already have accepted owner writes. Never
  // replace its database automatically with an older snapshot.
  const stopCode = await io.execute(composeCommand("stopForRestore", root, attemptedConfig),
    {stdin:null,stdout:io.stdout,stderr:io.stderr}).catch(()=>1);
  await commitInstallation(root, attemptedConfig);
  const recovery = {status:"RECOVERY_REQUIRED",failedAt:new Date().toISOString(),
    previousVersion:checkpoint.manifest.version,attemptedVersion:attemptedConfig.version,
    checkpointPath:checkpoint.path,databasePreserved:true,writersStopped:stopCode===0};
  await writeFile(join(checkpoint.path,"recovery.json"),`${JSON.stringify(recovery,null,2)}\n`,{mode:0o600});
  io.stderr.write(`RECOVERY_REQUIRED: the current database and volumes were retained. Checkpoint: ${checkpoint.path}\n`);
  if(stopCode!==0)io.stderr.write("Could not stop all application writers. No database restore was attempted.\n");
  io.stderr.write(`Run "${UNIVERSAL_COMMAND} doctor --fix" to repair the attempted version. Restoring older data requires an explicit recovery decision.\n`);
}

/**
 * Marks a checkpoint as verified after successful post-upgrade health checks and prunes older checkpoints.
 *
 * @param {object} checkpoint Checkpoint descriptor object.
 * @returns {Promise<void>}
 */
async function markCheckpointVerified(checkpoint) {
  await writeFile(
    join(checkpoint.path, "verified.json"),
    `${JSON.stringify({ verifiedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  );
  await pruneCheckpoints(checkpoint.path);
}

/**
 * Prunes verified checkpoints beyond the retention count limit.
 *
 * @param {string} currentPath Path of the current verified checkpoint.
 * @returns {Promise<void>}
 */
async function pruneCheckpoints(currentPath) {
  const parent = join(currentPath, "..");
  const entries = (await readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && CHECKPOINT_ID_PATTERN.test(entry.name))
    .map((entry) => join(parent, entry.name))
    .sort();
  const verified = [];
  for (const entry of entries) {
    if (await stat(join(entry, "verified.json")).catch(() => null)) verified.push(entry);
  }
  while (verified.length > CHECKPOINT_KEEP_COUNT) {
    await rm(verified.shift(), { recursive: true, force: true });
  }
}

/**
 * Requires interactive user confirmation or approved automation before applying destructive changes.
 *
 * @param {import("node:stream").Readable} stdin Standard input stream.
 * @param {import("node:stream").Writable} stdout Standard output stream.
 * @param {import("node:stream").Writable} stderr Standard error stream.
 * @param {string[]} lines Summary lines describing changes.
 * @returns {Promise<boolean>} True if approved, false otherwise.
 */
async function requireChangeApproval(stdin, stdout, stderr, lines) {
  if (!interactiveAvailable(stdin) && !approvedAutomation(stdin)) {
    stderr.write("This change requires an interactive terminal (TTY). No changes were made.\n");
    return false;
  }
  return finalConfirmation(stdin, stdout, lines);
}

/**
 * Collects and reports container status and recent logs to stderr before rollback.
 *
 * @param {object} options Diagnostic options including root, stateRoot, profile, platform, streams, execute, and engine.
 * @returns {Promise<void>}
 */
async function reportInstallDiagnostics({
  root,
  stateRoot,
  profile,
  platform,
  stdin,
  stdout,
  stderr,
  execute,
  engine = "docker"
}) {
  stderr.write("Collecting SpaceApp service status and recent logs before rollback...\n");
  for (const action of ["status", "logs"]) {
    try {
      const code = await executeWithDockerDiagnostics(
        execute,
        composeCommand(action, root, {
          profile,
          stateRoot,
          lines: 200,
          engine
        }),
        { stdin, stdout, stderr },
        { platform, stderr, engine }
      );
      if (code !== 0) {
        const engineLabel = engine === "podman" ? "Podman" : "Docker";
        stderr.write(
          `SpaceApp could not collect ${action} diagnostics (${engineLabel} exit ${code}).\n`
        );
      }
    } catch (error) {
      stderr.write(
        `SpaceApp could not collect ${action} diagnostics: ${error?.message || String(error)}.\n`
      );
    }
  }
}

/**
 * Restores previous container runtime configuration and containers after an installation failure.
 *
 * @param {object} options Restore options including root, existingConfig, streams, execute, engine, and platform.
 * @returns {Promise<void>}
 */
async function restoreRuntimeAfterFailedInstall({
  root,
  stagedStateRoot,
  existingConfig,
  attemptedProfile,
  companionsEnabled,
  engine = "docker",
  platform,
  stdin,
  stdout,
  stderr,
  execute
}) {
  const targetEngine = existingConfig?.engine ?? engine;
  const runtimeExecute = (spec) => executeWithDockerDiagnostics(
    execute,
    spec,
    { stdin, stdout, stderr },
    { platform, stderr, engine: targetEngine }
  );
  try {
    if (existingConfig) {
      await commitInstallation(root, existingConfig);
      const restoreCode = await runtimeExecute(
        composeCommand("up", root, {
          profile: existingConfig.profile,
          companionsEnabled: existingConfig.companionsEnabled,
          engine: existingConfig.engine
        })
      );
      if (restoreCode === 0) {
        const cleanupCode = await removeInactiveProfileServices({root, config: existingConfig,
          execute: runtimeExecute, stdin, stdout, stderr});
        if (cleanupCode !== 0) stderr.write("The previous runtime was restored, but inactive service cleanup failed. Run doctor --fix.\n");
        stderr.write("The previous SpaceApp runtime and access mode were restored.\n");
        return;
      }
      stderr.write(
        "The previous SpaceApp runtime could not be restored; stopping the partially updated runtime.\n"
      );
    }

    const stopCode = await runtimeExecute(
      composeCommand("down", root, {
        profile: existingConfig?.profile ?? attemptedProfile,
        stateRoot: existingConfig ? root : stagedStateRoot,
        companionsEnabled: existingConfig?.companionsEnabled ?? companionsEnabled,
        engine: targetEngine
      })
    );
    if (stopCode !== 0) {
      stderr.write(
        "The partially updated SpaceApp runtime could not be stopped automatically. Run the install command again immediately.\n"
      );
    }
  } catch (error) {
    stderr.write(
      `SpaceApp could not restore or stop the partially updated runtime: ${error?.message || String(error)}\n`
    );
  }
}

/**
 * Parses and validates command-line arguments for the install command.
 *
 * @param {string[]} args Array of command-line argument strings.
 * @returns {{ requestedProfile: string, requestedAccessMode?: string, requestedEngine?: string, noOpen: boolean, companionsEnabled: boolean }}
 */
function parseInstallArgs(args) {
  let requestedProfile = "auto";
  let requestedAccessMode;
  let requestedEngine;
  let noOpen = false;
  let companionsEnabled = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open" && !noOpen) {
      noOpen = true;
      continue;
    }
    if (argument === "--with-companions" && !companionsEnabled) {
      companionsEnabled = true;
      continue;
    }
    if (argument === "--engine" && index + 1 < args.length) {
      requestedEngine = args[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--engine=")) {
      requestedEngine = argument.slice("--engine=".length);
      continue;
    }
    if (argument === "--profile" && index + 1 < args.length) {
      requestedProfile = args[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--profile=")) {
      requestedProfile = argument.slice("--profile=".length);
      continue;
    }
    if (argument === "--access" && index + 1 < args.length) {
      requestedAccessMode = args[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--access=")) {
      requestedAccessMode = argument.slice("--access=".length);
      continue;
    }
    throw new Error(
      `Usage: ${UNIVERSAL_COMMAND} install [--engine docker|podman] [--profile auto|small|medium|large|light|standard] [--access isolated|host-root] [--with-companions] [--no-open]`
    );
  }
  if (
    !["auto", "small", "medium", "large", "light", "standard"].includes(requestedProfile) ||
    (
      requestedAccessMode !== undefined &&
      !["isolated", "host-root"].includes(requestedAccessMode)
    ) ||
    (
      requestedEngine !== undefined &&
      !["docker", "podman"].includes(requestedEngine)
    )
  ) {
    throw new Error(
      `Usage: ${UNIVERSAL_COMMAND} install [--engine docker|podman] [--profile auto|small|medium|large|light|standard] [--access isolated|host-root] [--with-companions] [--no-open]`
    );
  }
  return { requestedProfile, requestedAccessMode, requestedEngine, noOpen, companionsEnabled };
}

/**
 * Loads the existing SpaceApp configuration from the root directory or returns null if not installed.
 *
 * @param {string} root Installation root directory path.
 * @returns {Promise<object|null>} Loaded configuration object or null if absent.
 */
async function loadExistingInstallation(root) {
  try {
    return await loadConfig(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Takes "--user <user-id>" out of the arguments (multi-user: the command acts on that user's container). */
function takeUserOption(args) {
  const index = args.indexOf("--user");
  if (index === -1) return { userId: undefined, args };
  const userId = args[index + 1];
  if (!userId) throw new Error("--user needs a SpaceApp user id, for example user:Ab12cd34Ef56.");
  return { userId, args: [...args.slice(0, index), ...args.slice(index + 2)] };
}

function assertRegisteredUser(config, userId) {
  if (!(config.users ?? []).some((user) => user.id === userId)) {
    throw new Error(`User "${userId}" has no CLI container: run "${UNIVERSAL_COMMAND} user add ${userId}" first.`);
  }
}

/**
 * Manages external directory workspace bind mounts (add, remove, list).
 *
 * @param {string[]} rawArgs Command arguments.
 * @param {object} params Options including root, config, platform, stdin, stdout, stderr, execute.
 * @returns {Promise<number>} Process exit code (0 for success).
 */
async function workspaceCommand(rawArgs, { root, config, platform, stdin, stdout, stderr, execute }) {
  const { userId, args } = takeUserOption(rawArgs);
  if (userId) assertRegisteredUser(config, userId);
  const [action, identity, ...rest] = args;
  const applyWorkspaces = async (updated) => {
    // A user's mounts belong to their own container; "up" recreates only the services whose mounts changed.
    const code = await execute(composeCommand(userId ? "up" : "syncWorkspaces", root, { profile: updated.profile, companionsEnabled: updated.companionsEnabled, engine: updated.engine }), { stdin, stdout, stderr });
    if (code !== 0) stderr.write(`The change is saved, but the running services could not pick it up. Run "${UNIVERSAL_COMMAND} up".\n`);
    return code;
  };
  if (action === "add") {
    if (!identity || rest.some((arg) => arg !== "--read-only")) {
      throw new Error(
        `Usage: ${UNIVERSAL_COMMAND} workspace add <absolute-path> [--read-only]`
      );
    }
    const readOnly = rest.includes("--read-only");
    const updated = await addWorkspace(config, identity, { readOnly, userId });
    await saveConfig(root, updated);
    await writeRuntimeFiles(root, updated);
    stdout.write(`Workspace registered: ${identity}\n`);
    if (platform === "linux" && !readOnly) await writeAccessHint(identity, stdout);
    return applyWorkspaces(updated);
  }
  if (action === "remove") {
    if (!identity || rest.length > 0) {
      throw new Error(
        `Usage: ${UNIVERSAL_COMMAND} workspace remove <id-or-absolute-path>`
      );
    }
    const updated = removeWorkspace(config, identity, { userId });
    await saveConfig(root, updated);
    await writeRuntimeFiles(root, updated);
    stdout.write(`Workspace removed: ${identity}\n`);
    return applyWorkspaces(updated);
  }
  if (action === "list" && args.length === 1) {
    const workspaces = userId ? config.users.find((user) => user.id === userId).workspaces : config.workspaces;
    stdout.write(`${JSON.stringify(workspaces, null, 2)}\n`);
    return 0;
  }
  throw new Error(`Usage: ${UNIVERSAL_COMMAND} workspace <add|remove|list> [--user <user-id>]`);
}

// The CLIs run as uid 10001 in Docker; on Linux a bind-mounted folder keeps its host owner, so they cannot write to it.
const CLI_UID = 10001;
async function writeAccessHint(hostPath, stdout) {
  const info = await stat(hostPath);
  if (info.uid === CLI_UID || (info.mode & 0o002) !== 0) return;
  const owner = process.getuid?.() ?? info.uid;
  stdout.write(
    `The AI CLIs run as uid ${CLI_UID} and cannot write to this folder yet. Give them access without changing its owner:\n` +
    `  sudo setfacl -R -m u:${CLI_UID}:rwX -m u:${owner}:rwX -m d:u:${CLI_UID}:rwX -m d:u:${owner}:rwX ${JSON.stringify(hostPath)}\n` +
    "(install the acl package first if setfacl is missing; add --read-only instead if they should only read)\n"
  );
}

/** Streams one compose export into a 0600 archive; a failed export leaves no file. */
async function exportArchive(archive, action, { root, config, service, stdin, stderr, execute }) {
  const out = createWriteStream(archive, { mode: 0o600 });
  await once(out, "open");
  const code = await execute(
    composeCommand(action, root, { profile: config.profile, companionsEnabled: config.companionsEnabled, service, engine: config.engine }),
    { stdin, stdout: out, stderr }
  ).catch(() => 1);
  out.end();
  await once(out, "close");
  if (code !== 0) await rm(archive, { force: true });
  return code === 0;
}

const userArchive = (directory, userId, kind) => join(directory, "users", `${userSlug(userId)}-${kind}.tar.gz`);

/** Adds the workspace list and the CLIs' own settings to the backup just created; a failure here keeps the backup. */
async function addBackupExtras({ root, config, stdin, stdout, stderr, execute }) {
  const directory = join(root, "backups", await selectLatestBackupId(root));
  await copyFile(join(root, "config.json"), join(directory, "spaceapp-config.json"));
  const io = { root, config, stdin, stderr, execute };
  const saved = await exportArchive(join(directory, "cli-config.tar.gz"), "exportCliSettings", io);
  if (!saved) stderr.write("The backup has no CLI settings (MCP servers, base URLs): the CLI service did not answer or has none.\n");
  // Each user's CLI settings and Space Memory, from their own container; their logins and keys never (MU-004).
  const users = config.users ?? [];
  if (users.length > 0) await mkdir(join(directory, "users"), { recursive: true, mode: 0o700 });
  let complete = 0;
  for (const user of users) {
    const service = `spaceapp-cli-${userSlug(user.id)}`;
    const settings = await exportArchive(userArchive(directory, user.id, "cli-config"), "exportCliSettings", { ...io, service });
    const memory = await exportArchive(userArchive(directory, user.id, "memory"), "exportMemory", { ...io, service });
    if (settings && memory) complete++;
    else stderr.write(`The backup misses the ${settings ? "Space Memory" : memory ? "CLI settings" : "CLI settings and Space Memory"} of ${user.id}: their container did not answer.\n`);
  }
  stdout.write(`Backup includes the workspace list${saved ? " and the CLI settings" : ""}${users.length > 0 ? `, and the CLI settings and Space Memory of ${complete} of ${users.length} user(s)` : ""}.\n`);
}

/** Puts a user's CLI settings and Space Memory from a backup into their own container. */
async function restoreUserState({ root, config, directory, userId, stdin, stdout, stderr, execute }) {
  const service = `spaceapp-cli-${userSlug(userId)}`;
  const restored = [];
  for (const [kind, action, label] of [["cli-config", "importCliSettings", "CLI settings"], ["memory", "importMemory", "Space Memory"]]) {
    const input = await readFile(userArchive(directory, userId, kind)).catch(() => null);
    if (!input) continue;
    const code = await execute(
      composeCommand(action, root, { profile: config.profile, companionsEnabled: config.companionsEnabled, service, engine: config.engine }),
      { stdin, stdout, stderr, input }
    ).catch(() => 1);
    if (code === 0) restored.push(label);
    else stderr.write(`The ${label} of ${userId} could not be restored.\n`);
  }
  if (restored.length > 0) stdout.write(`${restored.join(" and ")} of ${userId} restored.\n`);
  return restored.length;
}

/** Puts the CLIs' settings back and names what a restore does not bring back. */
async function restoreBackupExtras({ root, config, backupId, stdin, stdout, stderr, execute }) {
  const directory = join(root, "backups", backupId);
  const archive = await readFile(join(directory, "cli-config.tar.gz")).catch(() => null);
  if (archive) {
    const code = await execute(
      composeCommand("importCliSettings", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }),
      { stdin, stdout, stderr, input: archive }
    ).catch(() => 1);
    stdout.write(code === 0 ? "CLI settings (MCP servers, base URLs) restored.\n" : "The CLI settings in this backup could not be restored.\n");
  }
  const saved = await readFile(join(directory, "spaceapp-config.json"), "utf8").then(JSON.parse).catch(() => null);
  const missing = (saved?.workspaces ?? []).filter((workspace) => !config.workspaces.some((current) => current.hostPath === workspace.hostPath));
  for (const workspace of missing) {
    stdout.write(`Workspace of the backup to add again: ${UNIVERSAL_COMMAND} workspace add "${workspace.hostPath}"${workspace.readOnly ? " --read-only" : ""}\n`);
  }
  // Multi-user: the accounts come back with the database; each user's CLI container and workspaces are added again.
  if (saved?.users !== undefined && config.users === undefined) stdout.write(`SpaceApp accounts were on: ${UNIVERSAL_COMMAND} user enable\n`);
  for (const user of saved?.users ?? []) {
    if ((config.users ?? []).some((current) => current.id === user.id)) {
      await restoreUserState({ root, config, directory, userId: user.id, stdin, stdout, stderr, execute });
    } else {
      stdout.write(`User of the backup to add again: ${UNIVERSAL_COMMAND} user add ${user.id}${user.memoryLimit ? ` --memory ${user.memoryLimit}` : ""}\n`);
      if (await stat(userArchive(directory, user.id, "memory")).then(() => true, () => false)) {
        stdout.write(`Then their CLI settings and Space Memory: ${UNIVERSAL_COMMAND} user restore ${user.id}\n`);
      }
    }
    for (const workspace of user.workspaces ?? []) {
      stdout.write(`Their workspace to add again: ${UNIVERSAL_COMMAND} workspace add "${workspace.hostPath}"${workspace.readOnly ? " --read-only" : ""} --user ${user.id}\n`);
    }
  }
  stdout.write(`API keys and CLI logins are never in backups: enter them again with "${UNIVERSAL_COMMAND} credentials set <provider>".\n`);
}

/**
 * Manages external AI provider credentials and API keys stored in secrets.
 *
 * @param {string[]} rawArgs Command arguments (set, remove, list).
 * @param {object} params Options including root, config, streams, and execute runner.
 * @returns {Promise<number>} Process exit code (0 for success).
 */
async function credentialsCommand(rawArgs, { root, config, stdin, stdout, stderr, execute }) {
  const { userId, args } = takeUserOption(rawArgs);
  if (userId) assertRegisteredUser(config, userId);
  // A user's keys reach only their own container.
  const service = userId ? `spaceapp-cli-${userSlug(userId)}` : undefined;
  const [action, provider, ...rest] = args;
  if (action === "list" && args.length === 1) {
    stdout.write(`${JSON.stringify(credentialProviders(), null, 2)}\n`);
    return 0;
  }
  if (action === "set") {
    if (!provider || rest.length > 0) {
      throw new Error(
        `Usage: ${UNIVERSAL_COMMAND} credentials set <provider> (the value is read from stdin)`
      );
    }
    const value = await readSecret(stdin, stdout, `Enter ${provider} credential: `);
    await writeCredential(root, provider, value, { userId });
    const syncCode = await execute(
      composeCommand("syncCredentials", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, service, engine: config.engine }),
      { stdin, stdout, stderr }
    );
    if (syncCode !== 0) {
      stderr.write(`Credential stored for ${provider}, but the CLI service could not be refreshed.\n`);
      return syncCode;
    }
    stdout.write(`Credential stored and applied for ${provider}.\n`);
    return syncCode;
  }
  if (action === "remove") {
    if (!provider || rest.length > 0) {
      throw new Error(`Usage: ${UNIVERSAL_COMMAND} credentials remove <provider>`);
    }
    const removed = await removeCredential(root, provider, { userId });
    const syncCode = await execute(
      composeCommand("syncCredentials", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, service, engine: config.engine }),
      { stdin, stdout, stderr }
    );
    if (syncCode !== 0) {
      stderr.write(`Credential file state changed for ${provider}, but the CLI service could not be refreshed.\n`);
      return syncCode;
    }
    stdout.write(removed ? `Credential removed and applied for ${provider}.\n` : `No credential stored for ${provider}.\n`);
    return syncCode;
  }
  throw new Error(`Usage: ${UNIVERSAL_COMMAND} credentials <set|remove|list> [--user <user-id>]`);
}

// Multi-user: "user enable" turns SpaceApp accounts on (invites); each invited user gets their own CLI container with
// "user add <user-id>" (the id is in Settings -> Users). Until then that user's CLIs do not start.
const USER_CLI_READY_ATTEMPTS = 30;

/** After "user add": the core is ready again with the new host map, and the user's own CLI host answers. */
async function waitForUserCli({ root, config, userId, stdin, stdout, stderr, execute, request, sleep }) {
  if (!await waitForApplicationReady({ url: `http://${config.bindHost}:${config.port}`, request, sleep })) {
    stderr.write(`SpaceApp did not become ready after adding ${userId}. Run "${UNIVERSAL_COMMAND} status".\n`);
    return 1;
  }
  const service = `spaceapp-cli-${userSlug(userId)}`;
  for (let attempt = 0; attempt < USER_CLI_READY_ATTEMPTS; attempt++) {
    const code = await execute(
      composeCommand("cliHostReady", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, service, engine: config.engine }),
      { stdin, stdout: null, stderr: null }
    ).catch(() => 1);
    if (code === 0) {
      stdout.write(`The CLI container of ${userId} is ready.\n`);
      return 0;
    }
    await sleep(2_000);
  }
  stderr.write(`The CLI container of ${userId} does not answer yet. Run "${UNIVERSAL_COMMAND} logs" and look at ${service}.\n`);
  return 1;
}

async function userCommand(args, { root, config, stdin, stdout, stderr, execute, request, sleep }) {
  const [action, userId, ...rest] = args;
  const apply = async (updated, message) => {
    await saveConfig(root, updated);
    await writeRuntimeFiles(root, updated);
    stdout.write(message);
    const code = await execute(composeCommand("up", root, { profile: updated.profile, companionsEnabled: updated.companionsEnabled, engine: updated.engine }), { stdin, stdout, stderr });
    if (code !== 0) stderr.write(`The change is saved, but the running services could not pick it up. Run "${UNIVERSAL_COMMAND} up".\n`);
    return code;
  };
  if (action === "list" && args.length === 1) {
    stdout.write(`${JSON.stringify({ enabled: config.users !== undefined, users: (config.users ?? []).map((user) => ({ ...user, container: `spaceapp-cli-${userSlug(user.id)}` })) }, null, 2)}\n`);
    return 0;
  }
  if (action === "enable" && args.length === 1) {
    if (config.accessMode !== "isolated") throw new Error("SpaceApp accounts need isolated access: host-root lets every agent read the whole host.");
    if (config.users !== undefined) {
      stdout.write("SpaceApp accounts are already on.\n");
      return 0;
    }
    return apply({ ...structuredClone(config), users: [] }, "SpaceApp accounts are on: invite people in Settings -> Users, then add each one here.\n");
  }
  if (action === "add" && userId && (rest.length === 0 || (rest.length === 2 && rest[0] === "--memory"))) {
    if (config.users === undefined) throw new Error(`SpaceApp accounts are off: run "${UNIVERSAL_COMMAND} user enable" first.`);
    const updated = addUser(config, userId, { memoryLimit: rest[1] });
    const code = await apply(updated, `User ${userId} gets the CLI container spaceapp-cli-${userSlug(userId)}. Add their keys with "${UNIVERSAL_COMMAND} credentials set <provider> --user ${userId}".\n`);
    return code === 0 ? waitForUserCli({ root, config: updated, userId, stdin, stdout, stderr, execute, request, sleep }) : code;
  }
  if (action === "restore" && userId && rest.length === 0) {
    assertRegisteredUser(config, userId);
    // "restore" first saves a backup of the install it replaces, so the newest backup with this user's state is the
    // one to use, not simply the newest backup (lab recheck 2026-10-18).
    const backups = (await readdir(join(root, "backups")).catch(() => [])).filter((id) => BACKUP_ID_PATTERN.test(id)).sort().reverse();
    for (const id of backups) {
      const directory = join(root, "backups", id);
      if (!await stat(userArchive(directory, userId, "memory")).then(() => true, () => false)) continue;
      if (await restoreUserState({ root, config, directory, userId, stdin, stdout, stderr, execute }) === 0) break;
      return 0;
    }
    throw new Error(`No backup has the CLI settings or Space Memory of ${userId}.`);
  }
  if (action === "remove" && userId && rest.length === 0) {
    // The container goes; its volumes (the user's CLI logins, memory and files) stay until uninstall --purge-data.
    return apply(removeUser(config, userId), `User ${userId} no longer has a CLI container. Their volumes are kept.\n`);
  }
  throw new Error(`Usage: ${UNIVERSAL_COMMAND} user <enable|add <user-id> [--memory <2g>]|restore <user-id>|remove <user-id>|list>`);
}

/**
 * Installs optional LLM provider binaries into the persistent provider volume.
 *
 * @param {string[]} rawArgs Command arguments including provider name.
 * @param {object} params Options including root, config, streams, and execute runner.
 * @returns {Promise<number>} Process exit code (0 for success).
 */
async function providerCommand(rawArgs, { root, config, stdin, stdout, stderr, execute }) {
  const { userId, args } = takeUserOption(rawArgs);
  if (args.length !== 2 || args[0] !== "install") {
    throw new Error(`Usage: ${UNIVERSAL_COMMAND} provider install <provider> [--user <user-id>]`);
  }
  if (userId) assertRegisteredUser(config, userId);
  const provider=args[1];
  // A user's CLIs run in their own container, so an optional CLI goes into that container's volume.
  const service = userId ? `spaceapp-cli-${userSlug(userId)}` : undefined;
  stdout.write(`Installing optional provider ${provider} into ${userId ? `the private provider volume of ${userId}` : "this installation's private provider volume"}.\n`);
  // Keep the existing Claude path compatible with older runtime images.
  const action=provider === "claude" ? "installClaude" : "installProvider";
  return execute(composeCommand(action, root, { profile: config.profile, companionsEnabled: config.companionsEnabled, provider, service, engine: config.engine }), { stdin, stdout, stderr });
}

/**
 * Manages administrator setup tokens and passwords (reset-password, rotate-setup-token).
 *
 * @param {string[]} args Command arguments.
 * @param {object} params Options including root, config, streams, and execute runner.
 * @returns {Promise<number>} Process exit code (0 for success).
 */
async function ownerCommand(args, { root, config, stdin, stdout, stderr, execute }) {
  if (args.length === 1 && args[0] === "rotate-setup-token") {
    const token = randomBytes(32).toString("base64url");
    const code = await execute(composeCommand("rotateOwnerSetupToken", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }), {
      stdin,
      stdout,
      stderr,
      input: `${token}\n`
    });
    if (code !== 0) return code;
    await writeSetupToken(root, token);
    stdout.write(`New one-time setup token: ${token}\n`);
    stdout.write("It expires in 15 minutes and only works before the first owner is claimed.\n");
    return 0;
  }
  if (args.length !== 1 || args[0] !== "reset-password") {
    throw new Error(
      `Usage: ${UNIVERSAL_COMMAND} owner <reset-password|rotate-setup-token>`
    );
  }
  const password = await readSecret(stdin, stdout, "New owner password: ");
  if (password.length < 6) {
    throw new Error("Owner password must be at least 6 characters.");
  }
  return execute(composeCommand("resetOwnerPassword", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }), {
    stdin,
    stdout,
    stderr,
    input: `${password}\n`
  });
}

/**
 * Performs a clean reinstallation recreating compose templates and runtime while preserving data.
 *
 * @param {object} params Reinstall options including root, config, streams, and runners.
 * @returns {Promise<number>} Process exit code (0 for success).
 */
async function reinstallCommand({
  root,
  config,
  platform,
  stdin,
  stdout,
  stderr,
  execute,
  request,
  sleep
}) {
  const approved = await requireChangeApproval(stdin, stdout, stderr, [
    `Clean setup SpaceApp at ${root}`,
    "This recreates managed files, templates, and runtime containers.",
    "Your database, persistent data, and credentials will be preserved."
  ]);
  if (!approved) {
    return 0;
  }
  const downCode = await execute(
    composeCommand("down", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }),
    { stdin, stdout, stderr }
  );
  if (downCode !== 0) {
    stderr.write(`Clean setup warning: container stop returned exit ${downCode}.\n`);
  }
  await writeRuntimeFiles(root, config);
  const upCode = await execute(
    composeCommand("up", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }),
    { stdin, stdout, stderr }
  );
  if (upCode !== 0) {
    stderr.write(`Clean setup failed during container startup (exit ${upCode}).\n`);
    return upCode;
  }
  if (typeof request === "function") {
    const url = `http://${config.bindHost}:${config.port}`;
    const ready = await waitForReadiness({
      url,
      request,
      sleep: sleep || wait,
      onProgress: async ({ elapsedSeconds }) => {
        stdout.write(`Waiting for SpaceApp readiness after clean setup (${elapsedSeconds}s)...\n`);
      }
    });
    if (!ready) {
      stderr.write("Clean setup completed container start, but readiness check timed out.\n");
      return 1;
    }
  }
  if (config?.volumesPurged) {
    delete config.volumesPurged;
    await saveConfig(root, config);
  }
  stdout.write("SpaceApp clean setup completed successfully. All data and settings preserved.\n");
  return 0;
}

/**
 * Checks whether CPU and memory cgroup controllers are delegated to the user session.
 *
 * @param {string[]|string|null|undefined} controllers Cgroup controller names or comma/space-separated string.
 * @param {string} platform Target platform OS name (e.g. "linux", "darwin").
 * @returns {boolean} True if limits are delegated or running on a non-Linux platform.
 */
export function cgroupLimitsDelegated(controllers, platform) {
  if (platform !== "linux") return true;
  const list = Array.isArray(controllers)
    ? controllers
    : typeof controllers === "string"
      ? controllers.split(/[,\s]+/)
      : [];
  const names = new Set(list.map((c) => String(c).trim().toLowerCase()));
  return names.has("cpu") && names.has("memory");
}

/**
 * Queries and parses Podman system information formatted as JSON.
 *
 * @param {Function} execute Command execution runner.
 * @returns {Promise<object|null>} Parsed JSON info object or null if Podman info command fails.
 */
export async function getPodmanInfo(execute) {
  let rawJson = "";
  const captureStream = new Writable({
    write(chunk, _encoding, callback) {
      rawJson += chunk.toString();
      if (typeof callback === "function") callback();
    }
  });
  try {
    const code = await execute({ command: "podman", args: ["info", "--format", "json"] }, {
      stdin: null,
      stdout: captureStream,
      stderr: null
    });
    if (code !== 0) return null;
    return JSON.parse(rawJson);
  } catch {
    return null;
  }
}

/**
 * Collects host, engine, configuration, and runtime health information into a sanitized diagnostic bundle.
 *
 * @param {object} params Parameter object.
 * @param {string} params.root Installation root directory.
 * @param {object} [params.config] SpaceApp configuration object.
 * @param {string} params.platform Operating system platform name.
 * @param {string} params.arch System architecture string.
 * @param {import("node:stream").Writable} params.stdout Standard output stream.
 * @param {import("node:stream").Writable} params.stderr Standard error stream.
 * @param {Function} params.execute Command execution runner.
 * @param {Function} [params.request] Fetch-compatible request function.
 * @param {string} [params.outPath] Optional custom output file path.
 * @returns {Promise<number>} Resolves with process exit code 0 on success.
 */
async function supportBundleCommand({
  root,
  config,
  platform,
  arch,
  stdout,
  stderr,
  execute,
  request,
  outPath
}) {
  const existingConfig = config ?? await loadConfig(root).catch(() => null);
  const resolvedEngine = existingConfig?.engine ?? "docker";
  let engineFacts = {
    engine: resolvedEngine
  };
  if (resolvedEngine === "podman") {
    const parsed = await getPodmanInfo(execute);
    if (parsed) {
      const controllers = parsed?.host?.cgroupControllers;
      const limitsDelegated = cgroupLimitsDelegated(controllers, platform);
      engineFacts = {
        engine: "podman",
        version: parsed?.version?.Version ?? parsed?.Version?.Version ?? "unknown",
        rootless: parsed?.host?.security?.rootless ?? null,
        cgroupVersion: parsed?.host?.cgroupVersion ?? null,
        cgroupControllers: parsed?.host?.cgroupControllers ?? null,
        limitsDelegated
      };
    } else {
      engineFacts = {
        engine: "podman",
        status: "unavailable"
      };
    }
  } else {
    let rawJson = "";
    const captureStream = new Writable({
      write(chunk, _encoding, callback) {
        rawJson += chunk.toString();
        if (typeof callback === "function") callback();
      }
    });
    try {
      await execute({ command: "docker", args: ["info", "--format", "{{json .}}"] }, {
        stdin: null,
        stdout: captureStream,
        stderr: null
      });
      const parsed = JSON.parse(rawJson);
      engineFacts = {
        engine: "docker",
        serverVersion: parsed?.ServerVersion ?? null
      };
    } catch {
      engineFacts = {
        engine: "docker",
        status: "unavailable"
      };
    }
  }

  const bundle = {
    schemaVersion: "1.0.0",
    collectedAt: new Date().toISOString(),
    system: {
      platform,
      arch,
      nodeVersion: process.version,
      release: typeof process.release === "object" ? process.release.name : "unknown"
    },
    launcher: {
      version: PACKAGE_VERSION,
      runtimeVersion: RUNTIME_VERSION
    },
    engine: engineFacts,
    installation: {
      root,
      config: existingConfig
        ? {
            version: existingConfig.version,
            profile: existingConfig.profile,
            accessMode: existingConfig.accessMode,
            engine: existingConfig.engine ?? "docker",
            companionsEnabled: existingConfig.companionsEnabled,
            bindHost: existingConfig.bindHost,
            port: existingConfig.port,
            previousVersion: existingConfig.previousVersion ?? null
          }
        : null
    },
    services: {},
    health: {}
  };

  if (existingConfig) {
    const url = `http://${existingConfig.bindHost}:${existingConfig.port}`;
    if (typeof request === "function") {
      try {
        const res = await request(`${url}/readyz`, { method: "GET", signal: AbortSignal.timeout(3000) });
        bundle.health.readyz = { status: res.status, ok: res.ok };
      } catch (e) {
        bundle.health.readyz = { error: e.message };
      }
    }
  }

  const destination = outPath || join(
    root,
    `support-bundle-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`
  );
  await writeFile(destination, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  stdout.write(`SpaceApp support bundle generated: ${destination}\n`);
  return 0;
}

/**
 * Performs a destructive factory reset, erasing containers, volumes, database, and configuration.
 *
 * @param {object} params Reset options including root, config, platform, streams, runners, and versions.
 * @returns {Promise<number>} Process exit code (0 for success).
 */
async function factoryResetCommand({
  root,
  config,
  platform,
  stdin,
  stdout,
  stderr,
  execute,
  runtimeVersion,
  persistSetupToken
}) {
  stdout.write("\nWARNING: Factory reset will PERMANENTLY ERASE all local database records, persistent volumes, and configuration.\n");
  stdout.write("External workspaces outside the installation root are preserved.\n\n");

  let backupCode;
  try {
    stdout.write("Creating safety backup before factory reset...\n");
    backupCode = await backupWithWritersPaused(execute, root, config, { stdin, stdout, stderr });
  } catch (err) {
    stdout.write(`Safety backup error: ${err.message}.\n`);
    backupCode = 1;
  }
  // Without a backup, erasing the data needs its own confirmation.
  const phrase = backupCode === 0 ? "FACTORY-RESET" : "FACTORY-RESET-WITHOUT-BACKUP";
  if (backupCode !== 0) {
    stdout.write(
      `The safety backup FAILED (exit ${backupCode}), so no backup of your data exists. ` +
      `The backup needs SpaceApp running: cancel, run "${UNIVERSAL_COMMAND} up", and try again.\n`
    );
  }

  const confirm = await readSecret(
    stdin,
    stdout,
    `Type ${phrase} to remove all data and reset SpaceApp: `,
    { mask: false }
  );
  if (confirm.trim() !== phrase) {
    stdout.write("Factory reset cancelled. No data was erased.\n");
    return 0;
  }

  const purgeCode = await execute(
    composeCommand("purge", root, { profile: config.profile, companionsEnabled: config.companionsEnabled, engine: config.engine }),
    { stdin, stdout, stderr }
  );
  if (purgeCode !== 0) {
    stderr.write(`Factory reset stopped: removing the data failed (exit ${purgeCode}). The configuration was kept; run "${UNIVERSAL_COMMAND} doctor".\n`);
    return purgeCode;
  }

  try {
    await rm(join(root, "config.json"), { force: true });
    await rm(join(root, "runtime.env"), { force: true });
    await rm(join(root, "compose.yml"), { force: true });
  } catch {}

  const result = await initializeInstallation(root, { version: runtimeVersion });
  await saveConfig(root, { ...result.config, volumesPurged: true });
  stdout.write(`SpaceApp factory reset complete. Clean installation initialized at ${root}\n`);
  if (result.setupToken) {
    stdout.write(`One-time setup token: ${result.setupToken}\n`);
    stdout.write("Store it temporarily; it expires after first owner setup.\n");
  }
  return 0;
}

/**
 * Handles the update command to upgrade or downgrade the SpaceApp runtime image version.
 *
 * @param {string[]} args Command arguments containing optional target version.
 * @param {object} options Options including root, config, version, streams, and runners.
 * @returns {Promise<number>} Process exit code (0 for success).
 */
async function updateCommand(args, { root, config, version, platform, stdin, stdout, stderr, execute, request, sleep, inspectResources = inspectSystemResources, ensureDocker = ensureDockerAvailable, env = process.env, arch = process.arch }) {
  if (args.length > 1) {
    throw new Error(`Usage: ${UNIVERSAL_COMMAND} update [version]`);
  }
  const targetVersion = args[0] || version;
  const path = upgradePath(config.version, targetVersion);
  const interactive = interactiveAvailable(stdin);
  const continuation = await readRunOnceContinuation(root, { platform, runtimeVersion: targetVersion });
  if (!interactive && !continuation && !approvedAutomation(stdin)) {
    stderr.write(
      "SpaceApp update changes require an interactive terminal (TTY). " +
      "Re-run from a terminal, or continue an approved Windows RunOnce plan.\n"
    );
    return 1;
  }
  if (continuation) {
    await consumeRunOnceContinuation(root);
    stdout.write("Continuing the approved unattended SpaceApp update plan.\n");
  }
  if (path === "same") {
    if (!continuation) {
      const choice = await promptChoice(stdin, stdout, `SpaceApp ${config.version} is already installed. What would you like to do?`, [
        { label: "Run doctor diagnostics (read-only)", value: "doctor" },
        { label: "Repair the runtime (recreate containers from the current configuration)", value: "repair" },
        { label: "Cancel", value: "cancel" }
      ]);
      if (choice === "cancel") {
        stdout.write("Cancelled. No changes were made.\n");
        return 0;
      }
      if (choice === "doctor") {
        return doctor({ root, platform, stdout, stderr, execute, stdin, inspectResources: inspectSystemResources });
      }
    }
    return repairRuntime({ root, config, platform, stdin, stdout, stderr, execute, request, sleep, inspectResources, ensureDocker, env, arch });
  }
  if (path === "downgrade") {
    if (!continuation) {
      stderr.write(
        `WARNING: target ${targetVersion} is OLDER than the installed ${config.version}.\n` +
        "A downgrade can lose data created by the newer version.\n"
      );
      const typed = await readSecret(stdin, stdout, "Type DOWNGRADE to proceed with the controlled rollback: ", { mask: false });
      if (typed !== "DOWNGRADE") {
        stdout.write("Cancelled. No changes were made.\n");
        return 0;
      }
    }
  } else if (path === "unsupported") {
    stderr.write(
      `Installed version ${config.version} is older than the minimum supported upgrade source ` +
      `${SPACEAPP_UPGRADE_POLICY.minSupportedSourceVersion}. Make a backup, then reinstall from scratch.\n`
    );
    return 1;
  } else if (path === "unknown") {
    stderr.write(
      `Installed version ${config.version} cannot be compared with target ${targetVersion}. Update cancelled.\n`
    );
    return 1;
  }
  if (!continuation) {
    const approved = await finalConfirmation(stdin, stdout, [
      `Runtime image version: ${config.version} -> ${targetVersion}`,
      "Checkpoint: configuration, secrets, and a verified database dump are saved before the change; current data is preserved if cutover fails.",
      "Downtime: containers restart during the cutover.",
      SPACEAPP_UPGRADE_POLICY.rollbackCapable
        ? "Recovery: use doctor --fix after a failed cutover; the previous version and verified checkpoint remain available for explicit rollback."
        : "Rollback: not supported for this target version."
    ]);
    if (!approved) {
      return 0;
    }
  }
  const engine = config.engine ?? "docker";
  if (engine === "podman") {
    const ready = await podmanIsReady(execute);
    if (!ready) {
      stderr.write(`Podman is not running or accessible. ${podmanInstallHelp(platform)}\n`);
      return 1;
    }
  } else {
    const prerequisites = await ensureDocker({ platform, arch, env, stdin, stdout, stderr, execute,
      installArgs: { root, requestedProfile: config.profile, requestedEngine: engine, noOpen: true, autoConfirm: true } });
    if (prerequisites.reexecuted || prerequisites.code !== 0) return prerequisites.code;
  }
  const resources = await inspectResources(root);
  const storagePlan = await inspectStoragePlan({ root, config: { ...config, version: targetVersion }, existingConfig: config, resources, execute, operation: "upgrade" });
  if (await doctor({ root, platform, stdout, stderr, execute, stdin, inspectResources, resources,
    profile: config.profile, dockerReady: engine === "docker", podmanReady: engine === "podman", engine, operation: "upgrade", storagePlan }) !== 0) return 1;
  return performUpdate({
    root,
    config,
    targetVersion,
    platform,
    stdin,
    stdout,
    stderr,
    execute,
    request,
    sleep,
    inspectResources,
    preserveRecreate: path === "preserve-recreate"
  });
}

/**
 * Verifies available disk space against calculated storage plans and prints diagnostic status.
 *
 * @param {object} params Options including root, config, existingConfig, operation, inspectResources, execute, and streams.
 * @returns {Promise<number>} Process exit code (0 if sufficient storage, 1 otherwise).
 */
async function verifyStorage({ root, config, existingConfig, operation, inspectResources, execute, stdout, stderr }) {
  const resources = await inspectResources(root);
  const plan = await inspectStoragePlan({ root, config, existingConfig, operation, resources, execute });
  const checks = storageChecks(plan, resources);
  for (const check of checks) (check.ok ? stdout : stderr).write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
  if (checks.some((check) => !check.ok)) {
    stderr.write("Insufficient additional storage. Existing data and runtime have not been replaced; free space and retry.\n");
    return 1;
  }
  return 0;
}

/**
 * Executes system, configuration, resource, and container runtime diagnostic probes.
 *
 * @param {object} params Diagnostic parameters.
 * @param {string} params.root SpaceApp installation directory.
 * @param {string} params.platform Operating system platform name.
 * @param {import("node:stream").Writable} params.stdout Standard output stream.
 * @param {import("node:stream").Writable} params.stderr Standard error stream.
 * @param {Function} params.execute Command execution runner.
 * @param {import("node:stream").Readable} [params.stdin] Standard input stream.
 * @param {Function} params.inspectResources System resource inspection callback.
 * @param {object} [params.resources] Pre-inspected system resources.
 * @param {string} [params.profile] Selected install profile.
 * @param {string} [params.operation] Installation operation type ("fresh", "upgrade", "repair", "maintenance").
 * @param {object} [params.storagePlan] Pre-inspected storage plan.
 * @param {boolean} [params.dockerReady] Whether Docker engine readiness is pre-verified.
 * @param {boolean} [params.podmanReady] Whether Podman engine readiness is pre-verified.
 * @param {string} [params.engine] Container engine ("docker" | "podman").
 * @returns {Promise<number>} Resolves with 0 if all checks pass, 1 otherwise.
 */
async function doctor({
  root,
  platform,
  stdout,
  stderr,
  execute,
  stdin,
  inspectResources,
  resources,
  profile,
  operation,
  storagePlan,
  dockerReady = false,
  podmanReady = false,
  engine
}) {
  const configuration = profile ? { ok: true, detail: "Prepared installation configuration" } : await loadConfig(root).then(() => ({ ok: true, detail: root })).catch((error) => ({ ok: false, detail: `${error.message}. Run install for a new setup, or doctor --fix for an existing setup.` }));
  const detectedResources = resources ?? await inspectResources(root);
  const existingConfig = await loadConfig(root).catch(() => null);
  let resolvedProfile = profile;
  if (!resolvedProfile) {
    if (existingConfig?.profile) {
      resolvedProfile = existingConfig.profile;
    } else if (detectedResources?.totalMemoryBytes) {
      resolvedProfile = resolveInstallProfile("auto", detectedResources);
    } else {
      resolvedProfile = "light";
    }
  }
  const resolvedEngine = engine ?? existingConfig?.engine ?? "docker";
  operation ??= existingConfig ? "maintenance" : "fresh";
  const resourceChecks = installResourceChecks(storagePlan?.resources ?? detectedResources, resolvedProfile, {
    operation, ...(storagePlan ? { requiredDiskBytes: storagePlan.requiredDiskBytes } : {})
  });
  const checks = [
    { name: "Node.js", ok: Number(process.versions.node.split(".")[0]) >= 20, detail: process.version },
    { name: "Configuration", ...configuration },
    ...resourceChecks.filter((check) => !storagePlan || check.name !== "Free disk"),
    ...(storagePlan ? storageChecks(storagePlan, detectedResources) : [])
  ];

  if (resolvedEngine === "podman") {
    const podmanResults = [];
    for (const probe of [
      { name: "Podman CLI", command: "podman", args: ["--version"] },
      { name: "Podman Compose", command: "podman", args: ["compose", "version"] },
      { name: "Podman Service", command: "podman", args: ["info"] }
    ]) {
      const code = podmanReady
        ? 0
        : await execute(probe, { stdin, stdout: null, stderr: null });
      podmanResults.push({ ...probe, code });
    }
    const [podmanCli, podmanCompose, podmanService] = podmanResults;
    checks.push({
      name: podmanCli.name,
      ok: podmanCli.code === 0,
      detail: podmanCli.code === 0
        ? "available"
        : podmanCli.code === 127
          ? "not found on PATH"
          : `unavailable (exit ${podmanCli.code})`
    });
    checks.push({
      name: podmanCompose.name,
      ok: podmanCompose.code === 0,
      detail: podmanCompose.code === 0
        ? "available"
        : podmanCli.code !== 0
          ? "not available because Podman CLI is missing"
          : `compose provider unavailable (exit ${podmanCompose.code})`
    });
    checks.push({
      name: podmanService.name,
      ok: podmanService.code === 0,
      detail: podmanService.code === 0
        ? "available"
        : podmanCli.code === 0
          ? "installed but not running or inaccessible"
          : "not reachable because Podman CLI is missing"
    });

    let podmanInfo = null;
    if (podmanService.code === 0) {
      podmanInfo = await getPodmanInfo(execute);
    }

    if (podmanInfo) {
      const version = podmanInfo?.version?.Version ?? podmanInfo?.Version?.Version ?? "unknown";
      checks.push({
        name: "Podman version",
        ok: true,
        detail: version
      });

      const isRootless = Boolean(podmanInfo?.host?.security?.rootless);
      checks.push({
        name: "Podman rootless",
        ok: isRootless,
        detail: isRootless ? "rootless" : "rootful"
      });

      const cgroupVersion = podmanInfo?.host?.cgroupVersion ?? (platform === "linux" ? "unknown" : "v2");
      const isCgroupV2 = cgroupVersion === "v2" || cgroupVersion === "2";
      checks.push({
        name: "Podman cgroup version",
        ok: isCgroupV2,
        detail: cgroupVersion
      });

      const controllers = podmanInfo?.host?.cgroupControllers;
      const limitsDelegated = cgroupLimitsDelegated(controllers, platform);
      checks.push({
        name: "Podman resource limit delegation",
        ok: limitsDelegated,
        detail: limitsDelegated
          ? "CPU and memory controllers delegated"
          : "CPU and memory limits cannot be applied (cgroup controllers not delegated to user session)"
      });
      if (!limitsDelegated) {
        stderr.write("Warning: CPU and memory limits cannot be applied by rootless Podman because cgroup controllers are not delegated. Configure systemd user delegation to enable container resource limits.\n");
      }
    } else if (podmanService.code === 0) {
      checks.push({
        name: "Podman rootless",
        ok: false,
        detail: "system information unavailable or unreadable"
      });
    }

    for (const check of checks) {
      (check.ok ? stdout : stderr).write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
    }
    if (podmanCli.code !== 0 || podmanCompose.code !== 0 || podmanService.code !== 0) {
      stderr.write(`${podmanInstallHelp(platform)}\n`);
    }
    return checks.every((check) => check.ok) ? 0 : 1;
  }

  const dockerResults = [];
  for (const probe of [
    { name: "Docker CLI", command: "docker", args: ["--version"] },
    { name: "Docker Compose", command: "docker", args: ["compose", "version"] },
    { name: "Docker Engine", command: "docker", args: ["info"] }
  ]) {
    const code = dockerReady
      ? 0
      : await execute(probe, { stdin, stdout: null, stderr: null });
    dockerResults.push({ ...probe, code });
  }
  const [dockerCli, dockerCompose, dockerEngine] = dockerResults;
  checks.push({
    name: dockerCli.name,
    ok: dockerCli.code === 0,
    detail: dockerCli.code === 0
      ? "available"
      : dockerCli.code === 127
        ? "not found on PATH"
        : `unavailable (exit ${dockerCli.code})`
  });
  checks.push({
    name: dockerCompose.name,
    ok: dockerCompose.code === 0,
    detail: dockerCompose.code === 0
      ? "available"
      : dockerCli.code !== 0
        ? "not available because Docker CLI is missing"
        : `plugin unavailable (exit ${dockerCompose.code})`
  });
  checks.push({
    name: dockerEngine.name,
    ok: dockerEngine.code === 0,
    detail: dockerEngine.code === 0
      ? "available"
      : dockerCli.code === 0
        ? "installed but not running or inaccessible"
        : "not reachable because Docker CLI is missing"
  });
  for (const check of checks) {
    (check.ok ? stdout : stderr).write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
  }
  if (dockerCli.code !== 0 || dockerCompose.code !== 0) {
    stderr.write(`${dockerInstallHelp(platform)}\n`);
  } else if (dockerEngine.code !== 0) {
    stderr.write(`${dockerEngineHelp(platform)}\n`);
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}

/**
 * Polls the application readyz endpoint until it reports healthy or times out.
 *
 * @param {object} params Polling parameters.
 * @param {string} params.url Application root URL.
 * @param {Function} params.request Fetch-compatible request function.
 * @param {Function} params.sleep Sleep function.
 * @param {Function} [params.onProgress] Optional progress callback.
 * @param {number} [params.maxAttempts] Maximum polling attempts.
 * @param {number} [params.attemptTimeoutMs] Timeout per attempt in milliseconds.
 * @returns {Promise<boolean>} True if ready, false if timed out.
 */
async function waitForApplicationReady({
  url,
  request,
  sleep,
  onProgress,
  maxAttempts = APPLICATION_READY_MAX_ATTEMPTS,
  attemptTimeoutMs = APPLICATION_READY_ATTEMPT_TIMEOUT_MS
}) {
  if (typeof request !== "function") {
    throw new Error("SpaceApp readiness requires a Fetch-compatible request function.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APPLICATION_READY_WAIT_MS);
  try {
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      const attemptController = new AbortController();
      const attemptTimeout = setTimeout(
        () => attemptController.abort(),
        attemptTimeoutMs
      );
      const onOverallAbort = () => attemptController.abort();
      controller.signal.addEventListener("abort", onOverallAbort, { once: true });
      try {
        const response = await request(`${url}/readyz`, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          signal: attemptController.signal
        });
        if (response?.ok) {
          const payload = await response.json();
          if (payload?.ok === true) {
            return true;
          }
        }
      } catch {
        if (controller.signal.aborted) {
          return false;
        }
      } finally {
        clearTimeout(attemptTimeout);
        controller.signal.removeEventListener("abort", onOverallAbort);
      }
      if (attempt < maxAttempts && !controller.signal.aborted) {
        await sleep(APPLICATION_READY_POLL_MS);
        const completedAttempts = attempt + 1;
        if (
          typeof onProgress === "function" &&
          completedAttempts % APPLICATION_READY_PROGRESS_ATTEMPTS === 0
        ) {
          await onProgress({
            elapsedSeconds: completedAttempts * APPLICATION_READY_POLL_MS / 1_000
          });
        }
      }
    }
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

const waitForReadiness = waitForApplicationReady;

/**
 * Queries the setup status endpoint to verify if initialization or claim is needed.
 *
 * @param {object} params Options including url and request function.
 * @returns {Promise<object>} Status object with setupRequired and expiresAt.
 */
async function requestSetupStatus({ url, request }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SETUP_STATUS_TIMEOUT_MS);
  try {
    const response = await request(`${url}/api/setup/status`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal
    });
    if (!response?.ok) {
      throw new Error(`HTTP ${response?.status ?? "error"}`);
    }
    const payload = await response.json();
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.setupRequired !== "boolean" ||
      (payload.expiresAt !== null && typeof payload.expiresAt !== "string")
    ) {
      throw new Error("invalid setup status response");
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("setup status request timed out", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Executes an engine command and writes helpful diagnostic guidance on missing CLI error (127).
 *
 * @param {Function} execute Command execution runner.
 * @param {object} spec Command specification object.
 * @param {object} io Stdio streams object.
 * @param {object} options Options including platform, stderr stream, and optional engine name.
 * @returns {Promise<number>} Process exit code.
 */
async function executeWithDockerDiagnostics(execute, spec, io, { platform, stderr }) {
  const code = await execute(spec, io);
  if (spec.command === "docker" && code === 127) {
    stderr.write(
      `SpaceApp could not find the Docker CLI. ${dockerInstallHelp(platform)}\n`
    );
  } else if (spec.command === "podman" && code === 127) {
    stderr.write(
      `SpaceApp could not find the Podman CLI. ${podmanInstallHelp(platform)}\n`
    );
  }
  return code;
}

/**
 * Reads user input from stdin, optionally masking characters for password or token entry.
 *
 * @param {import("node:stream").Readable} stdin Standard input stream.
 * @param {import("node:stream").Writable} stdout Standard output stream.
 * @param {string} prompt Prompt question string.
 * @param {object} [options={}] Options including mask, answerKey, and defaultValue.
 * @returns {Promise<string>} Entered input string.
 */
export async function readSecret(stdin, stdout, prompt, { mask = true, answerKey = null, defaultValue = "" } = {}) {
  const controller = stdin?._spaceappPromptController || new PromptController({ stdin, stdout });
  return await controller.readLine(prompt, { mask, answerKey, defaultValue });
}

/**
 * Executes a trusted command with streaming IO, arguments validation, and timeout handling.
 *
 * @param {object} spec Command specification with command, args, and optional env/timeoutMs.
 * @param {object} [io={}] IO configuration including stdin, stdout, stderr, and optional input string.
 * @returns {Promise<number>} Resolves with process exit code.
 */
export function executeCommand(spec, { stdin, stdout, stderr, input } = {}) {
  return new Promise((resolve, reject) => {
    if (!spec || typeof spec !== "object" || !trustedCommands.has(spec.command)) {
      reject(new Error("SpaceApp refused to execute an untrusted command."));
      return;
    }
    if (spec.command === "powershell.exe" && (
      spec.args !== undefined ||
      typeof spec.operation !== "string"
    )) {
      reject(new Error("SpaceApp PowerShell commands must use a trusted operation."));
      return;
    }
    if (spec.command !== "powershell.exe" && (
      !Array.isArray(spec.args) ||
      spec.args.some((argument) => typeof argument !== "string")
    )) {
      reject(new Error("SpaceApp command arguments must be strings."));
      return;
    }
    const commandEnv = spec.env === undefined
      ? process.env
      : validateCommandEnvironment(spec.env);
    const background = spec.command === 'xdg-open' && spec.background === true;
    let launchTimer, commandTimer;
    const child = spawnTrustedCommand(spec, {
      env: commandEnv,
      shell: false,
      detached: background,
      stdio: background ? ['ignore','ignore','ignore'] : [input === undefined ? (stdin || "inherit") : "pipe", stdout && typeof stdout.fd !== "number" ? "pipe" : stdout || "ignore", stderr && typeof stderr.fd !== "number" ? "pipe" : stderr || "ignore"]
    });
    if (!background && child.stdout && stdout) child.stdout.pipe(stdout, { end: false });
    if (!background && child.stderr && stderr) child.stderr.pipe(stderr, { end: false });
    if (Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) commandTimer = setTimeout(() => child.kill(), spec.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(launchTimer);
      clearTimeout(commandTimer);
      if (error?.code === "ENOENT") {
        resolve(127);
      } else {
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(launchTimer);
      clearTimeout(commandTimer);
      resolve(code ?? (signal ? 1 : 0));
    });
    if(background)launchTimer=setTimeout(()=>{child.unref();resolve(0);},750);
    if (input !== undefined && !background) {
      child.stdin.end(input);
    }
  });
}

/**
 * Spawns an allowable system binary process with specified arguments and spawn options.
 *
 * @param {object} spec Command specification object.
 * @param {object} options Child process spawn options.
 * @returns {import("node:child_process").ChildProcess} Spawned child process.
 */
function spawnTrustedCommand(spec, options) {
  const args = spec.args;
  switch (spec.command) {
    case "codesign": return spawn("codesign", args, options);
    case "docker": return spawn("docker", args, options);
    case "hdiutil": return spawn("hdiutil", args, options);
    case "open": return spawn("open", args, options);
    case "podman": return spawn("podman", args, options);
    case "powershell.exe":
      return spawn("powershell.exe", windowsPowerShellArgs(spec.operation), options);
    case "sg": return spawn("sg", args, options);
    case "shutdown.exe": return spawn("shutdown.exe", args, options);
    case "spctl": return spawn("spctl", args, options);
    case "sudo": return spawn("sudo", args, options);
    case "winget.exe": return spawn("winget.exe", args, options);
    case "wsl.exe": return spawn("wsl.exe", args, options);
    case "xdg-open": return spawn("xdg-open", args, options);
    default: throw new Error("SpaceApp refused to execute an untrusted command.");
  }
}

/**
 * Validates environment variables to ensure only trusted names and string values are passed.
 *
 * @param {object} commandEnvironment Proposed command environment map.
 * @returns {object} Merged environment object.
 */
function validateCommandEnvironment(commandEnvironment) {
  if (
    !commandEnvironment ||
    typeof commandEnvironment !== "object" ||
    Array.isArray(commandEnvironment) ||
    Object.entries(commandEnvironment).some(
      ([name, value]) => !trustedEnvironmentNames.has(name) || typeof value !== "string"
    )
  ) {
    throw new Error("SpaceApp refused untrusted command environment values.");
  }
  return { ...process.env, ...commandEnvironment };
}

/**
 * Launches the web browser on the host platform pointing to the given URL.
 *
 * @param {string} url Web URL to open.
 * @param {string} platform Operating system platform name.
 * @param {Function} execute Command execution runner.
 * @param {object} io Stdio streams.
 * @returns {Promise<number>} Process exit code.
 */
function openBrowser(url, platform, execute, io) {
  if (platform === "darwin") {
    return execute({ command: "open", args: [url] }, io);
  }
  if (platform === "win32") {
    return execute({
      command: "powershell.exe",
      operation: "open-spaceapp-browser",
      env: { SPACEAPP_OPEN_URL: url }
    }, io);
  }
  return execute({ command: "xdg-open", args: [url], background: true }, io);
}

/**
 * Asserts that no extra positional arguments were passed to a command.
 *
 * @param {string[]} args Array of arguments.
 * @param {string} command Command name.
 */
function assertNoArgs(args, command) {
  if (args.length > 0) {
    throw new Error(`Usage: ${UNIVERSAL_COMMAND} ${command}`);
  }
}

/**
 * Determines whether a given command requires existing runtime configuration and compose files.
 *
 * @param {string} command Command name.
 * @param {string[]} args Array of arguments.
 * @returns {boolean} True if runtime files are required.
 */
function commandNeedsRuntimeFiles(command, args) {
  if ([
    "up",
    "down",
    "status",
    "logs",
    "backup",
    "restore",
    "uninstall"
  ].includes(command)) {
    return true;
  }
  if (command === "credentials") {
    return args[0] === "set" || args[0] === "remove";
  }
  if (command === "provider") {
    return args[0] === "install";
  }
  if (command === "owner") {
    return args[0] === "reset-password" || args[0] === "rotate-setup-token";
  }
  return false;
}

/**
 * Returns Docker installation guidance text tailored to the host platform.
 *
 * @param {string} platform Operating system platform name.
 * @returns {string} Guidance text string.
 */
function dockerInstallHelp(platform) {
  if (platform === "win32") {
    return `Run "${UNIVERSAL_COMMAND} install" to install and start signed Docker Desktop with WSL2 automatically.`;
  }
  if (platform === "darwin") {
    return `Run "${UNIVERSAL_COMMAND} install" to install and start signed Docker Desktop automatically.`;
  }
  return `Run "${UNIVERSAL_COMMAND} install" to install and start Docker Engine and Compose automatically on supported Linux distributions.`;
}

/**
 * Returns Docker troubleshooting guidance text when Docker is installed but unreachable.
 *
 * @param {string} platform Operating system platform name.
 * @returns {string} Troubleshooting text string.
 */
function dockerEngineHelp(platform) {
  if (platform === "win32" || platform === "darwin") {
    return `Open Docker Desktop, complete any first-run prompt, then run "${UNIVERSAL_COMMAND} doctor" again.`;
  }
  return `Start Docker Engine, verify the current user can access it, then run "${UNIVERSAL_COMMAND} doctor" again.`;
}

/**
 * Formats a byte count into gibibytes rounded to one decimal place.
 *
 * @param {number} bytes Byte count.
 * @returns {number} Value in GiB.
 */
function formatGibibytes(bytes) {
  return Math.floor((bytes / 1024 ** 3) * 10) / 10;
}

/**
 * Pauses execution for a specified duration in milliseconds.
 *
 * @param {number} milliseconds Duration to wait.
 * @returns {Promise<void>}
 */
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Returns the full multi-line help documentation string for the SpaceApp launcher CLI.
 *
 * @returns {string} Help text string.
 */
function helpText() {
  return `SpaceApp self-hosted launcher

Usage: ${UNIVERSAL_COMMAND} <command>
       spaceapp <command>             Optional global launcher

  init                              Create a local SpaceApp installation
  install [--engine docker|podman] [--profile auto|small|medium|large|light|standard] [--access isolated|host-root] [--with-companions] [--no-open]
                                    Install prerequisites, initialize, and start
  reinstall [--keep-data] [--engine docker|podman] [--profile auto|small|medium|large|light|standard] [--access isolated|host-root] [--with-companions] [--no-open]
                                    Clean reinstallation preserving data and credentials
  repair [--dry-run]                Verify and repair configuration and runtime files
  up | down | status | logs         Manage the application runtime
  open                              Open the local web application
  doctor [--fix]                    Diagnose; --fix repairs existing config and runtime
  support-bundle                    Generate a diagnostic bundle JSON for support
  update [version] | rollback       Update or roll back images
  backup | restore                  Back up or restore persistent state
  factory-reset                     Safety backup, purge all volumes/data, and reset
  workspace add <path> [--read-only]
  workspace remove <id-or-path>
  workspace list
  credentials set <provider>        Read a credential from masked stdin
  credentials remove <provider>
  credentials list
                                    credentials and workspace take --user <user-id>
  user enable                       Turn SpaceApp accounts on (invites in Settings -> Users)
  user add <user-id> [--memory 2g]  Give an invited user their own CLI container
  user restore <user-id>            Put a user's CLI settings and Space Memory back from the latest backup
  user remove <user-id> | user list
  provider install <provider> [--user <id>]  Install an optional CLI in its persistent volume (or a user's)
                                    codex, gemini, qwen, kimi, grok, claude, deepseek,
                                    autohand, cursor, copilot (also installed on first use)
  owner reset-password              Read the new password from masked stdin
  owner rotate-setup-token          Replace an expired unclaimed setup token
  uninstall [--purge-data]          Remove containers; keep data by default

Options:
  --engine docker|podman            Container engine (defaults to docker; picks podman if only podman exists)
  --plan                            Dry-run mode: print actions without executing
  --json                            Output structured JSON where supported
  --log-file <file>                 Append all execution logs to specified file
  --local-images               Use preloaded images only (offline/lab; missing images fail)
  --non-interactive                 Run non-interactively, failing on missing input
  --answers <json|path>             Pre-seed answers; automation requires confirm:true

Profiles (auto uses CPU, RAM and free disk, then checks Docker resources):
  small:  4 CPUs, 7 GiB usable RAM, 6.5 GiB fresh space; SpaceApp + OpenCode.
          Background integration workers and managed browser are disabled.
  medium: 4 CPUs, 11 GiB usable RAM, 8 GiB fresh space; adds background workers.
  large:  8 CPUs, 15 GiB usable RAM, 11 GiB fresh space; adds managed browser.
  light/standard: compatibility settings for existing installations.
Upgrades keep the installed profile unless you explicitly choose another one.
Upgrade space: missing layers + database checkpoint + 0.5 GiB reserve.
Cached target images need no extra image space; existing data stays in place.
Unknown layer sizes use a conservative estimate; space is rechecked after pull.
No automatic deletion of images, volumes, workspaces, or backups to free space.

Quick start: install (automatic profile, OpenCode first, browser opens on completion).
Windows PowerShell: use npx.cmd if script execution policy blocks npx.ps1.
The npx command requires Node.js 20.11+ installed; Docker is installed if missing.
Data lives in SPACEAPP_HOME (config/secrets) and persistent Docker volumes.
Use backup before major changes; uninstall preserves data unless --purge-data.
Never use factory-reset to solve an ordinary installation problem.

Automation: --non-interactive --answers '{"confirm":true,"profile":"auto","access":"isolated","companions":false,"telemetry":false,"open":false}'
For shells with different quoting, save that JSON to a file and pass --answers file.json.
Use help or <command> --help from any directory, including before installation.

Interactive setup wizard: install, reinstall, update, init, rollback, repair,
factory-reset, and uninstall ask questions and require a final confirmation
before any change. Command flags pre-select answers; unattended changes require explicit confirm:true.
`;
}
