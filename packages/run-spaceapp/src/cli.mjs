import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
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
  addWorkspace,
  applyConfigRepairs,
  commitInstallation,
  composeCommand,
  credentialProviders,
  initializeInstallation,
  inspectSystemResources,
  installResourceChecks,
  loadConfig,
  planConfigRepairs,
  prepareInstallation,
  removeCredential,
  removeWorkspace,
  resolveInstallAccessMode,
  resolveInstallProfile,
  resolveSpaceAppHome,
  saveConfig,
  selectLatestBackupId,
  SPACEAPP_UPGRADE_POLICY,
  upgradePath,
  writeCredential,
  writeRuntimeFiles,
  writeSetupToken
} from "./index.mjs";
import {
  ensureDockerAvailable,
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
  INSTALL_PING_TIMEOUT_MS,
  reportFirstInstallPing
} from "./telemetry.mjs";

const APPLICATION_READY_WAIT_MINUTES = 10;
const APPLICATION_READY_WAIT_MS = APPLICATION_READY_WAIT_MINUTES * 60 * 1_000;
const APPLICATION_READY_POLL_MS = 2_000;
const APPLICATION_READY_MAX_ATTEMPTS = APPLICATION_READY_WAIT_MS / APPLICATION_READY_POLL_MS;
const APPLICATION_READY_PROGRESS_ATTEMPTS = 30_000 / APPLICATION_READY_POLL_MS;
const APPLICATION_READY_LOG_INTERVAL_SECONDS = 120;
const SETUP_STATUS_TIMEOUT_MS = 10_000;
const trustedCommands = new Set([
  "codesign",
  "docker",
  "hdiutil",
  "open",
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

export async function withHeadlessDockerConfig(platform, spec, run) {
  if (platform !== "win32") {
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

function interactiveAvailable(stdin) {
  return Boolean(stdin?.isTTY && typeof stdin?.setRawMode === "function");
}

async function promptYesNo(stdin, stdout, question, { defaultYes = false } = {}) {
  for (;;) {
    const answer = (await readSecret(stdin, stdout, `${question} [${defaultYes ? "Y/n" : "y/N"}] `, { mask: false })).trim().toLowerCase();
    if (answer === "") {
      return defaultYes;
    }
    if (answer === "y" || answer === "yes") {
      return true;
    }
    if (answer === "n" || answer === "no") {
      return false;
    }
    stdout.write("Please answer y or n.\n");
  }
}

async function promptChoice(stdin, stdout, question, options, { defaultIndex = 0 } = {}) {
  stdout.write(`${question}\n`);
  options.forEach((option, index) => {
    stdout.write(`  [${index + 1}] ${option.label}\n`);
  });
  for (;;) {
    const answer = (await readSecret(stdin, stdout, `Select 1-${options.length} [${defaultIndex + 1}]: `, { mask: false })).trim();
    if (answer === "") {
      return options[defaultIndex].value;
    }
    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      return options[index - 1].value;
    }
    stdout.write(`Invalid choice. Enter a number between 1 and ${options.length}.\n`);
  }
}

async function finalConfirmation(stdin, stdout, lines) {
  stdout.write("SpaceApp setup plan:\n");
  for (const line of lines) {
    stdout.write(`  - ${line}\n`);
  }
  const approved = await promptYesNo(stdin, stdout, "Apply this plan?", { defaultYes: false });
  if (!approved) {
    stdout.write("Cancelled. No changes were made.\n");
  }
  return approved;
}

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

function currentOsUsername({ platform, env }) {
  if (platform === "win32") {
    return env.USERNAME || env.USER || userInfo().username;
  }
  return env.USER || userInfo().username;
}

function runOnceContinuationPath(root) {
  return join(root, "var", "runonce-continuation.json");
}

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

async function consumeRunOnceContinuation(root) {
  await rm(runOnceContinuationPath(root), { force: true }).catch(() => {});
}

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
  const [command = "help", ...args] = argv;
  const root = resolveSpaceAppHome({ env, platform });

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
    return runtimeExecute(composeCommand(command, root, { profile: config.profile, companionsEnabled: config.companionsEnabled }), { stdin, stdout, stderr });
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
  if (command === "workspace") {
    return workspaceCommand(args, { root, config, stdout });
  }
  if (command === "credentials") {
    return credentialsCommand(args, { root, config, stdin, stdout, stderr, execute: runtimeExecute });
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
      execute: runtimeExecute
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
      composeCommand("pull", root, { profile: rollback.profile, companionsEnabled: rollback.companionsEnabled }),
      (pullSpec) => runtimeExecute(pullSpec, { stdin, stdout, stderr })
    );
    if (pullCode !== 0) {
      await writeRuntimeFiles(root, config);
      return pullCode;
    }
    const upCode = await runtimeExecute(composeCommand("up", root, { profile: rollback.profile, companionsEnabled: rollback.companionsEnabled }), { stdin, stdout, stderr });
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
    return runtimeExecute(composeCommand("backup", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }), { stdin, stdout, stderr });
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
    const backupCode = await runtimeExecute(composeCommand("backup", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }), { stdin, stdout, stderr });
    if (backupCode !== 0) return backupCode;
    const stopCode = await runtimeExecute(composeCommand("stopForRestore", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }), { stdin, stdout, stderr });
    if (stopCode !== 0) return stopCode;
    const restoreCode = await runtimeExecute(
      composeCommand("restore", root, { backupId, profile: config.profile }),
      { stdin, stdout, stderr }
    );
    if (restoreCode !== 0) return restoreCode;
    return runtimeExecute(composeCommand("up", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }), { stdin, stdout, stderr });
  }
  if (command === "uninstall") {
    if (args.length === 0) {
      const approved = await requireChangeApproval(stdin, stdout, stderr, [
        "Stop and remove SpaceApp containers and network.",
        "Data, configuration, secrets, and backups remain at the installation root.",
        "Docker volumes are retained; the global SpaceApp CLI remains installed."
      ]);
      if (!approved) {
        return 0;
      }
      stdout.write("Stopping and removing SpaceApp containers and network...\n");
      const code = await runtimeExecute(
        composeCommand("down", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }),
        { stdin, stdout, stderr }
      );
      if (code === 0) {
        stdout.write("SpaceApp runtime removed successfully. It is safe to run this command again.\n");
        stdout.write(`Data, configuration, secrets, and backups remain at ${root}.\n`);
        stdout.write("Docker volumes are retained. The global SpaceApp CLI remains installed.\n");
        stdout.write("To remove only the global CLI, run: npm uninstall -g run-spaceapp\n");
      } else {
        stderr.write(`Uninstall could not remove the runtime (Docker exit ${code}).\n`);
        stdout.write(`Data, configuration, secrets, and backups remain at ${root}.\n`);
        stdout.write("The global SpaceApp CLI remains installed.\n");
      }
      return code;
    }
    if (args.length === 1 && args[0] === "--purge-data") {
      const confirmation = await readSecret(stdin, stdout, "Type DELETE to remove Docker volumes: ", { mask: false });
      if (confirmation !== "DELETE") {
        throw new Error("Purge cancelled.");
      }
      stdout.write("Removing SpaceApp containers, network, and Docker volumes...\n");
      const code = await runtimeExecute(
        composeCommand("purge", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }),
        { stdin, stdout, stderr }
      );
      if (code === 0) {
        stdout.write("SpaceApp runtime and Docker volumes removed successfully.\n");
        stdout.write(`Host configuration and backups remain at ${root} for manual review.\n`);
        stdout.write("The global SpaceApp CLI remains installed.\n");
        stdout.write("To remove only the global CLI, run: npm uninstall -g run-spaceapp\n");
      } else {
        stderr.write(`SpaceApp Docker volume purge failed (Docker exit ${code}).\n`);
        stdout.write(`Host files and the global SpaceApp CLI remain at ${root}.\n`);
      }
      return code;
    }
    throw new Error(`Usage: ${UNIVERSAL_COMMAND} uninstall [--purge-data]`);
  }

  throw new Error(`Unknown command "${command}". Run "${UNIVERSAL_COMMAND} help".`);
}

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
    inspectResources
  });
  if (wizard.exit !== undefined) {
    return wizard.exit;
  }
  const {
    requestedProfile,
    requestedAccessMode,
    noOpen,
    companionsEnabled,
    telemetryEnabled
  } = wizard;
  const existingConfig = await loadExistingInstallation(root);
  const accessMode = resolveInstallAccessMode(
    requestedAccessMode,
    existingConfig?.accessMode ?? "isolated"
  );
  if (accessMode === "host-root" && platform !== "linux") {
    throw new Error("Host-root access is supported only on Linux.");
  }
  if (accessMode === "host-root" && !hostRootRuntimeCompatible) {
    throw new Error(
      "Host-root access is disabled for this launcher-only candidate because its runtime images were not rebuilt. Use --access isolated."
    );
  }
  await prepareDockerPath({ platform, env });
  const resources = await inspectResources(root);
  const profile = resolveInstallProfile(requestedProfile, resources.totalMemoryBytes);
  if (accessMode === "host-root") {
    stderr.write(
      "WARNING: host-root access lets SpaceApp CLI sessions read and modify the entire Linux host through /host, including credentials and system files.\n"
    );
  }
  const result = await prepareInstallation(root, {
    version: runtimeVersion,
    profile,
    accessMode,
    ...(companionsEnabled ? { companionsEnabled } : {})
  });
  if (telemetryEnabled && !existingConfig) {
    result.config = { ...result.config, telemetry: true };
  }

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
  stdout.write(existingConfig
    ? "Preserved existing data, workspaces, credentials, secrets, and persistent Docker volumes.\n"
    : "Future refreshes preserve data, workspaces, credentials, secrets, and persistent Docker volumes.\n");
  stdout.write(
    `Selected profile: ${profile} (${formatGibibytes(resources.totalMemoryBytes)} GiB system memory detected).\n`
  );
  stdout.write(`SpaceApp installation root: ${root}\n`);
  if (installResourceChecks(resources).some((check) => !check.ok)) {
    const doctorCode = await doctor({
      root,
      platform,
      stdout,
      stderr,
      execute,
      stdin,
      inspectResources,
      resources
    });
    stderr.write(
      `Installation stopped before downloading images. Fix the failed checks and run "${UNIVERSAL_COMMAND} install" again.\n`
    );
    return doctorCode;
  }

  const prerequisiteResult = await ensureDocker({
    platform,
    arch,
    env,
    stdin,
    stdout,
    stderr,
    execute,
    installArgs: { root, requestedProfile, requestedAccessMode, noOpen }
  });
  if (prerequisiteResult.reexecuted) {
    return prerequisiteResult.code;
  }
  if (prerequisiteResult.code !== 0) {
    stderr.write(
      `Installation stopped before downloading images. Fix the failed checks and run "${UNIVERSAL_COMMAND} install" again.\n`
    );
    return prerequisiteResult.code;
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
    dockerReady: true
  });
  if (doctorCode !== 0) {
    stderr.write(
      `Installation stopped before downloading images. Fix the failed checks and run "${UNIVERSAL_COMMAND} install" again.\n`
    );
    return doctorCode;
  }
  const stagedStateRoot = await mkdtemp(join(tmpdir(), "run-spaceapp-install-"));
  let runtimeMutationAttempted = false;
  const failAfterRuntimeMutation = async (code) => {
    if (runtimeMutationAttempted) {
      await reportInstallDiagnostics({
        root,
        stateRoot: stagedStateRoot,
        profile,
        platform,
        stdin,
        stdout,
        stderr,
        execute
      });
      await restoreRuntimeAfterFailedInstall({
        root,
        stagedStateRoot,
        existingConfig,
        attemptedProfile: profile,
        companionsEnabled,
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
    await commitInstallation(stagedStateRoot, result.config);
    const stagedComposeCommand = (action, options = {}) =>
      composeCommand(action, root, {
        profile,
        stateRoot: stagedStateRoot,
        companionsEnabled,
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
    if (pullCode !== 0) return pullCode;
    runtimeMutationAttempted = true;
    const upCode = await executeWithDockerDiagnostics(
      execute,
      stagedComposeCommand("up"),
      { stdin, stdout, stderr },
      { platform, stderr }
    );
    if (upCode !== 0) return await failAfterRuntimeMutation(upCode);

    const url = `http://${result.config.bindHost}:${result.config.port}`;
    stdout.write(
      `Waiting up to ${APPLICATION_READY_WAIT_MINUTES} minutes for SpaceApp services to become ready...\n`
    );
    const ready = await waitForApplicationReady({
      url,
      request,
      sleep,
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
            stderr.write(`SpaceApp service status check failed with Docker exit ${statusCode}.\n`);
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
              stderr.write(`SpaceApp startup log check failed with Docker exit ${logsCode}.\n`);
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

    if (profile === "light") {
      const removeBrowserCode = await executeWithDockerDiagnostics(
        execute,
        composeCommand("removeBrowser", root, {
          profile: "standard",
          stateRoot: stagedStateRoot
        }),
        { stdin, stdout, stderr },
        { platform, stderr }
      );
      if (removeBrowserCode !== 0) {
        stderr.write(
          "SpaceApp is ready, but the managed browser container could not be removed for the light profile.\n"
        );
        return await failAfterRuntimeMutation(removeBrowserCode);
      }
    }

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
    runtimeMutationAttempted = false;
    try {
      await reportFirstInstallPing({
        existingConfig,
        env,
        platform,
        arch,
        launcherVersion,
        runtimeVersion
      }, {
        request,
        timeoutMs: INSTALL_PING_TIMEOUT_MS
      });
    } catch (error) {
      stderr.write(
        `SpaceApp installation report could not be sent: ${error?.message || String(error)}\n`
      );
    }
    stdout.write(`SpaceApp is ready at ${url}\n`);
    if (setupToken) {
      stdout.write(`One-time setup token: ${setupToken}\n`);
      stdout.write('Paste it into the "One-time setup token" field in the page that opens.\n');
      stdout.write("It expires in 15 minutes and stops working after the first owner is created.\n");
      stdout.write(`If it expires, run: ${UNIVERSAL_COMMAND} owner rotate-setup-token\n`);
    }
    stdout.write(
      `Next: add CLI credentials with "${UNIVERSAL_COMMAND} credentials set <provider>".\n`
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

async function planInteractiveSetup({
  args,
  root,
  runtimeVersion,
  platform,
  stdin,
  stdout,
  stderr,
  execute,
  inspectResources
}) {
  const parsed = parseInstallArgs(args);
  const rawExisting = await readRawConfig(root);
  const repairs = planConfigRepairs(rawExisting);
  const path = upgradePath(rawExisting?.version ?? null, runtimeVersion);
  const interactive = interactiveAvailable(stdin);
  const continuation = await readRunOnceContinuation(root, { platform, runtimeVersion });

  if (!interactive && !continuation) {
    stderr.write(
      "SpaceApp setup changes require an interactive terminal (TTY). " +
      "Re-run from a terminal, or continue an approved Windows RunOnce plan.\n"
    );
    return { exit: 1 };
  }

  const resources = await inspectResources(root);
  const resolveProfileChoice = (choice) => {
    const resolved = resolveInstallProfile(choice, resources.totalMemoryBytes);
    return { resolved, display: choice === "auto" ? `auto (${resolved})` : resolved };
  };

  if (continuation) {
    await consumeRunOnceContinuation(root);
    stdout.write("Continuing the approved unattended SpaceApp setup plan.\n");
    await applyApprovedConfigRepairs(root, rawExisting);
    const actions = continuation.actions ?? {};
    return {
      requestedProfile: actions.profile ?? "auto",
      requestedAccessMode: actions.accessMode,
      noOpen: actions.noOpen !== false,
      companionsEnabled: actions.companionsEnabled ?? false,
      telemetryEnabled: actions.telemetry ?? false
    };
  }

  if (path === "fresh") {
    const profileChoice = await promptChoice(stdin, stdout, "Which installation profile?", [
      { label: `auto (light profile on this system; ${formatGibibytes(resources.totalMemoryBytes)} GiB detected)`, value: "auto" },
      { label: "light (smaller footprint)", value: "light" },
      { label: "standard (full features, incl. managed browser)", value: "standard" }
    ], { defaultIndex: ["auto", "light", "standard"].indexOf(parsed.requestedProfile) });
    const accessChoice = await promptChoice(stdin, stdout, "Which access mode?", [
      { label: "isolated (recommended; no host access)", value: "isolated" },
      { label: "host-root (Linux only; CLI sessions can read and modify the whole host)", value: "host-root" }
    ], { defaultIndex: parsed.requestedAccessMode === "host-root" ? 1 : 0 });
    const companionsChoice = await promptYesNo(stdin, stdout, "Enable companion integrations (Claude Code, browser companions)?", { defaultYes: parsed.companionsEnabled });
    const telemetryChoice = await promptYesNo(stdin, stdout, "Enable anonymous usage telemetry?", { defaultYes: false });
    let dockerChoice = true;
    if (platform === "win32") {
      const dockerProbe = await detectDockerAvailable({ execute });
      if (dockerProbe !== 0) {
        dockerChoice = await promptYesNo(stdin, stdout, "Docker Engine was not detected. Include automatic Docker installation?", { defaultYes: true });
      }
    }
    const openBrowserChoice = await promptYesNo(stdin, stdout, "Open the web application when installation completes?", { defaultYes: !parsed.noOpen });

    const { resolved } = resolveProfileChoice(profileChoice);
    const approved = await finalConfirmation(stdin, stdout, [
      `Installation root: ${root}`,
      `Runtime image version: not installed -> ${runtimeVersion}`,
      `Profile: ${profileChoice === "auto" ? `auto (${resolved})` : profileChoice}`,
      `Access mode: ${accessChoice}`,
      `Companions: ${companionsChoice ? "enabled" : "disabled"}`,
      `Telemetry: ${telemetryChoice ? "enabled" : "disabled"}`,
      `Docker installation: ${dockerChoice ? "automatic if missing" : "not included"}`,
      `Open browser afterwards: ${openBrowserChoice ? "yes" : "no"}`,
      "Future refreshes preserve data, workspaces, credentials, secrets, and persistent Docker volumes."
    ]);
    if (!approved) {
      return { exit: 0 };
    }
    if (platform === "win32") {
      await offerUnattendedContinuation(root, runtimeVersion, stdin, stdout, {
        profile: profileChoice,
        accessMode: accessChoice,
        companionsEnabled: companionsChoice,
        telemetry: telemetryChoice,
        noOpen: !openBrowserChoice
      });
    }
    return {
      requestedProfile: profileChoice,
      requestedAccessMode: accessChoice,
      noOpen: !openBrowserChoice,
      companionsEnabled: companionsChoice,
      telemetryEnabled: telemetryChoice
    };
  }

  if (path === "same" && !hasRequestedConfigChange(rawExisting, parsed)) {
    const choice = await promptChoice(stdin, stdout, `SpaceApp ${rawExisting.version} is already installed. What would you like to do?`, [
      { label: "Run doctor diagnostics (read-only)", value: "doctor" },
      { label: "Repair the runtime (recreate containers from the current configuration)", value: "repair" },
      { label: "Cancel", value: "cancel" }
    ]);
    if (choice === "cancel") {
      stdout.write("Cancelled. No changes were made.\n");
      return { exit: 0 };
    }
    if (choice === "doctor") {
      return { exit: await doctor({ root, platform, stdout, stderr, execute, stdin, inspectResources, resources }) };
    }
    await applyApprovedConfigRepairs(root, rawExisting);
    const config = await loadExistingInstallation(root);
    return { exit: await repairRuntime({ root, config, platform, stdin, stdout, stderr, execute }) };
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

  const repairLines = repairs.actions.map((action) => `Config repair: ${action.detail}`);
  const approved = await finalConfirmation(stdin, stdout, [
    `Installation root: ${root}`,
    `Runtime image version: ${rawExisting?.version ?? "not installed"} -> ${runtimeVersion}`,
    `Profile: ${rawExisting?.profile ?? "not configured"} -> ${resolveProfileChoice(parsed.requestedProfile).display}`,
    `Access mode: ${rawExisting?.accessMode ?? "not configured"} -> ${resolveInstallAccessMode(parsed.requestedAccessMode, rawExisting?.accessMode ?? "isolated")}`,
    ...repairLines,
    path === "preserve-recreate"
      ? "Runtime: preserve/recreate (containers are recreated without touching data volumes)."
      : "Runtime: standard staged upgrade; previous runtime is restored automatically on failure.",
    "Preserved: data, workspaces, credentials, secrets, and persistent Docker volumes."
  ]);
  if (!approved) {
    return { exit: 0 };
  }
  await applyApprovedConfigRepairs(root, rawExisting);
  if (platform === "win32") {
    await offerUnattendedContinuation(root, runtimeVersion, stdin, stdout, {
      profile: parsed.requestedProfile,
      accessMode: parsed.requestedAccessMode,
      companionsEnabled: parsed.companionsEnabled,
      noOpen: parsed.noOpen
    });
  }
  return {
    requestedProfile: parsed.requestedProfile,
    requestedAccessMode: parsed.requestedAccessMode,
    noOpen: parsed.noOpen,
    companionsEnabled: parsed.companionsEnabled,
    telemetryEnabled: false
  };
}

function hasRequestedConfigChange(rawExisting, parsed) {
  if (!rawExisting) {
    return false;
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

async function detectDockerAvailable({ execute }) {
  try {
    return await execute({ command: "docker", args: ["--version"] }, { stdin: null, stdout: null, stderr: null });
  } catch {
    return 127;
  }
}

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

async function repairRuntime({ root, config, platform, stdin, stdout, stderr, execute }) {
  const pullCode = await withHeadlessDockerConfig(
    platform,
    composeCommand("pull", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }),
    (pullSpec) => execute(pullSpec, { stdin, stdout, stderr })
  );
  if (pullCode !== 0) {
    writeWindowsCredentialHint(platform, stderr);
    return pullCode;
  }
  const upCode = await execute(
    composeCommand("repair", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }),
    { stdin, stdout, stderr }
  );
  if (upCode !== 0) {
    return upCode;
  }
  stdout.write(`SpaceApp ${config.version} runtime repaired.\n`);
  return 0;
}

async function performUpdate({
  root,
  config,
  targetVersion,
  platform,
  stdin,
  stdout,
  stderr,
  execute,
  preserveRecreate
}) {
  const updated = targetVersion === config.version
    ? config
    : {
      ...config,
      version: targetVersion,
      previousVersion: config.version
    };
  const checkpoint = await createCheckpoint(root, config, { stdin, stdout, stderr, execute, platform });
  try {
    await writeRuntimeFiles(root, updated);
    if (preserveRecreate) {
      const downCode = await execute(
        composeCommand("down", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }),
        { stdin, stdout, stderr }
      );
      if (downCode !== 0) {
        throw new Error(`Preserve/recreate stop failed with Docker exit ${downCode}.`);
      }
    }
    const pullCode = await withHeadlessDockerConfig(
      platform,
      composeCommand("pull", root, { profile: updated.profile, companionsEnabled: updated.companionsEnabled }),
      (pullSpec) => execute(pullSpec, { stdin, stdout, stderr })
    );
    if (pullCode !== 0) {
      writeWindowsCredentialHint(platform, stderr);
      throw new Error(`Image pull failed with Docker exit ${pullCode}.`);
    }
    const upCode = await execute(
      composeCommand("up", root, { profile: updated.profile, companionsEnabled: updated.companionsEnabled }),
      { stdin, stdout, stderr }
    );
    if (upCode !== 0) {
      throw new Error(`Runtime start failed with Docker exit ${upCode}.`);
    }
    await saveConfig(root, updated);
    await markCheckpointVerified(checkpoint);
    stdout.write(`Updated to SpaceApp ${targetVersion}.\n`);
    return 0;
  } catch (error) {
    stderr.write(`SpaceApp update failed: ${error?.message || String(error)}\n`);
    const restored = await restoreCheckpoint(root, checkpoint, { stdin, stdout, stderr, execute, config });
    if (!restored) {
      stderr.write(
        `Automatic restore failed. The checkpoint remains available at ${checkpoint.path} for manual recovery.\n`
      );
    }
    return 1;
  }
}

const CHECKPOINT_ID_PATTERN = /^spaceapp-checkpoint-\d{8}T\d{6}Z$/;
const CHECKPOINT_KEEP_COUNT = 2;

function checkpointId() {
  return `spaceapp-checkpoint-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

async function manifestEntry(path, logicalPath) {
  const content = await readFile(path);
  return {
    path: logicalPath,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

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
  const dumpCode = await execute(
    composeCommand("checkpointDump", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }),
    { stdin: null, stdout: createWriteStream(dumpPath), stderr }
  );
  if (dumpCode !== 0) {
    await rm(path, { recursive: true, force: true });
    throw new Error(`Checkpoint database dump failed with Docker exit ${dumpCode}. No changes were made.`);
  }
  try {
    await stat(dumpPath);
  } catch {
    await writeFile(dumpPath, "");
  }
  manifest.files.push(await manifestEntry(dumpPath, "postgres.dump"));
  await writeFile(join(path, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const verified = await verifyCheckpoint({ path, manifest });
  if (!verified) {
    throw new Error(`Checkpoint verification failed. The checkpoint remains at ${path}. No changes were made.`);
  }
  return { id, path, manifest };
}

async function verifyCheckpoint(checkpoint) {
  for (const file of checkpoint.manifest.files ?? []) {
    const actual = await manifestEntry(join(checkpoint.path, file.path), file.path).catch(() => null);
    if (!actual || actual.bytes !== file.bytes || actual.sha256 !== file.sha256) {
      return false;
    }
  }
  return true;
}

async function markCheckpointVerified(checkpoint) {
  await writeFile(
    join(checkpoint.path, "verified.json"),
    `${JSON.stringify({ verifiedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  );
  await pruneCheckpoints(checkpoint.path);
}

async function pruneCheckpoints(currentPath) {
  const parent = join(currentPath, "..");
  const entries = (await readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && CHECKPOINT_ID_PATTERN.test(entry.name))
    .map((entry) => join(parent, entry.name))
    .sort();
  while (entries.length > CHECKPOINT_KEEP_COUNT) {
    await rm(entries.shift(), { recursive: true, force: true });
  }
}

async function restoreCheckpoint(root, checkpoint, { stdin, stdout, stderr, execute, config }) {
  if (!checkpoint) {
    stderr.write("No checkpoint was available for restore.\n");
    return false;
  }
  const verified = await verifyCheckpoint(checkpoint);
  if (!verified) {
    stderr.write(`Checkpoint ${checkpoint.id} failed verification; it remains at ${checkpoint.path} for manual recovery.\n`);
    return false;
  }
  stdout.write(`Restoring checkpoint ${checkpoint.id}...\n`);
  await execute(
    composeCommand("down", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }),
    { stdin: null, stdout: null, stderr: null }
  ).catch(() => {});
  const fileNames = ["config.json", "runtime.env", "compose.yml", "compose.workspaces.yml", "compose.host-access.yml"];
  for (const fileName of fileNames) {
    await copyFile(join(checkpoint.path, fileName), join(root, fileName));
  }
  const restored = await loadConfig(root);
  const dumpPath = join(checkpoint.path, "postgres.dump");
  const dbCode = await execute(
    composeCommand("checkpointRestore", root, { profile: restored.profile, companionsEnabled: restored.companionsEnabled }),
    { stdin: createReadStream(dumpPath), stdout, stderr }
  );
  if (dbCode !== 0) {
    stderr.write(`Checkpoint database restore failed with Docker exit ${dbCode}. Checkpoint remains at ${checkpoint.path}.\n`);
    return false;
  }
  const upCode = await execute(
    composeCommand("up", root, { profile: restored.profile, companionsEnabled: restored.companionsEnabled }),
    { stdin, stdout, stderr }
  );
  return upCode === 0;
}

async function requireChangeApproval(stdin, stdout, stderr, lines) {
  if (!interactiveAvailable(stdin)) {
    stderr.write("This change requires an interactive terminal (TTY). No changes were made.\n");
    return false;
  }
  return finalConfirmation(stdin, stdout, lines);
}

async function reportInstallDiagnostics({
  root,
  stateRoot,
  profile,
  platform,
  stdin,
  stdout,
  stderr,
  execute
}) {
  stderr.write("Collecting SpaceApp service status and recent logs before rollback...\n");
  for (const action of ["status", "logs"]) {
    try {
      const code = await executeWithDockerDiagnostics(
        execute,
        composeCommand(action, root, {
          profile,
          stateRoot,
          lines: 200
        }),
        { stdin, stdout, stderr },
        { platform, stderr }
      );
      if (code !== 0) {
        stderr.write(
          `SpaceApp could not collect ${action} diagnostics (Docker exit ${code}).\n`
        );
      }
    } catch (error) {
      stderr.write(
        `SpaceApp could not collect ${action} diagnostics: ${error?.message || String(error)}.\n`
      );
    }
  }
}

async function restoreRuntimeAfterFailedInstall({
  root,
  stagedStateRoot,
  existingConfig,
  attemptedProfile,
  companionsEnabled,
  platform,
  stdin,
  stdout,
  stderr,
  execute
}) {
  const runtimeExecute = (spec) => executeWithDockerDiagnostics(
    execute,
    spec,
    { stdin, stdout, stderr },
    { platform, stderr }
  );
  try {
    if (existingConfig) {
      await commitInstallation(root, existingConfig);
      const restoreCode = await runtimeExecute(
        composeCommand("up", root, {
          profile: existingConfig.profile,
          companionsEnabled: existingConfig.companionsEnabled
        })
      );
      if (restoreCode === 0) {
        if (existingConfig.profile === "light") {
          const cleanupCode = await runtimeExecute(
            composeCommand("removeBrowser", root, {
              profile: "standard"
            })
          );
          if (cleanupCode !== 0) {
            stderr.write(
              "The previous SpaceApp runtime was restored, but an inactive browser container may remain.\n"
            );
          }
        }
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
        companionsEnabled: existingConfig?.companionsEnabled ?? companionsEnabled
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

function parseInstallArgs(args) {
  let requestedProfile = "auto";
  let requestedAccessMode;
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
      `Usage: ${UNIVERSAL_COMMAND} install [--profile auto|light|standard] [--access isolated|host-root] [--with-companions] [--no-open]`
    );
  }
  if (
    !["auto", "light", "standard"].includes(requestedProfile) ||
    (
      requestedAccessMode !== undefined &&
      !["isolated", "host-root"].includes(requestedAccessMode)
    )
  ) {
    throw new Error(
      `Usage: ${UNIVERSAL_COMMAND} install [--profile auto|light|standard] [--access isolated|host-root] [--with-companions] [--no-open]`
    );
  }
  return { requestedProfile, requestedAccessMode, noOpen, companionsEnabled };
}

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

async function workspaceCommand(args, { root, config, stdout }) {
  const [action, identity, ...rest] = args;
  if (action === "add") {
    if (!identity || rest.some((arg) => arg !== "--read-only")) {
      throw new Error(
        `Usage: ${UNIVERSAL_COMMAND} workspace add <absolute-path> [--read-only]`
      );
    }
    const updated = await addWorkspace(config, identity, { readOnly: rest.includes("--read-only") });
    await saveConfig(root, updated);
    await writeRuntimeFiles(root, updated);
    stdout.write(`Workspace registered: ${identity}\n`);
    return 0;
  }
  if (action === "remove") {
    if (!identity || rest.length > 0) {
      throw new Error(
        `Usage: ${UNIVERSAL_COMMAND} workspace remove <id-or-absolute-path>`
      );
    }
    const updated = removeWorkspace(config, identity);
    await saveConfig(root, updated);
    await writeRuntimeFiles(root, updated);
    stdout.write(`Workspace removed: ${identity}\n`);
    return 0;
  }
  if (action === "list" && args.length === 1) {
    stdout.write(`${JSON.stringify(config.workspaces, null, 2)}\n`);
    return 0;
  }
  throw new Error(`Usage: ${UNIVERSAL_COMMAND} workspace <add|remove|list>`);
}

async function credentialsCommand(args, { root, config, stdin, stdout, stderr, execute }) {
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
    await writeCredential(root, provider, value);
    const syncCode = await execute(
      composeCommand("syncCredentials", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }),
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
    const removed = await removeCredential(root, provider);
    const syncCode = await execute(
      composeCommand("syncCredentials", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }),
      { stdin, stdout, stderr }
    );
    if (syncCode !== 0) {
      stderr.write(`Credential file state changed for ${provider}, but the CLI service could not be refreshed.\n`);
      return syncCode;
    }
    stdout.write(removed ? `Credential removed and applied for ${provider}.\n` : `No credential stored for ${provider}.\n`);
    return syncCode;
  }
  throw new Error(`Usage: ${UNIVERSAL_COMMAND} credentials <set|remove|list>`);
}

async function providerCommand(args, { root, config, stdin, stdout, stderr, execute }) {
  if (args.length !== 2 || args[0] !== "install" || args[1] !== "claude") {
    throw new Error(`Usage: ${UNIVERSAL_COMMAND} provider install claude`);
  }
  stdout.write("Installing Claude Code from Anthropic into this installation's private provider volume.\n");
  return execute(composeCommand("installClaude", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }), { stdin, stdout, stderr });
}

async function ownerCommand(args, { root, config, stdin, stdout, stderr, execute }) {
  if (args.length === 1 && args[0] === "rotate-setup-token") {
    const token = randomBytes(32).toString("base64url");
    const code = await execute(composeCommand("rotateOwnerSetupToken", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }), {
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
  return execute(composeCommand("resetOwnerPassword", root, { profile: config.profile, companionsEnabled: config.companionsEnabled }), {
    stdin,
    stdout,
    stderr,
    input: `${password}\n`
  });
}

async function updateCommand(args, { root, config, version, platform, stdin, stdout, stderr, execute }) {
  if (args.length > 1) {
    throw new Error(`Usage: ${UNIVERSAL_COMMAND} update [version]`);
  }
  const targetVersion = args[0] || version;
  const path = upgradePath(config.version, targetVersion);
  const interactive = interactiveAvailable(stdin);
  const continuation = await readRunOnceContinuation(root, { platform, runtimeVersion: targetVersion });
  if (!interactive && !continuation) {
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
    return repairRuntime({ root, config, platform, stdin, stdout, stderr, execute });
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
      "Checkpoint: configuration, secrets, and a database dump are saved before the change and restored automatically on failure.",
      "Downtime: containers restart during the cutover.",
      SPACEAPP_UPGRADE_POLICY.rollbackCapable
        ? "Rollback: the previous runtime is restored automatically on failure; the previous version stays recorded for manual rollback."
        : "Rollback: not supported for this target version."
    ]);
    if (!approved) {
      return 0;
    }
  }
  return performUpdate({
    root,
    config,
    targetVersion,
    platform,
    stdin,
    stdout,
    stderr,
    execute,
    preserveRecreate: path === "preserve-recreate"
  });
}

async function doctor({
  root,
  platform,
  stdout,
  stderr,
  execute,
  stdin,
  inspectResources,
  resources,
  dockerReady = false
}) {
  const detectedResources = resources ?? await inspectResources(root);
  const checks = [
    { name: "Node.js", ok: Number(process.versions.node.split(".")[0]) >= 20, detail: process.version },
    { name: "Configuration", ok: true, detail: root },
    ...installResourceChecks(detectedResources)
  ];
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

async function waitForApplicationReady({
  url,
  request,
  sleep,
  onProgress,
  maxAttempts = APPLICATION_READY_MAX_ATTEMPTS
}) {
  if (typeof request !== "function") {
    throw new Error("SpaceApp readiness requires a Fetch-compatible request function.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APPLICATION_READY_WAIT_MS);
  try {
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await request(`${url}/readyz`, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          signal: controller.signal
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

async function executeWithDockerDiagnostics(execute, spec, io, { platform, stderr }) {
  const code = await execute(spec, io);
  if (spec.command === "docker" && code === 127) {
    stderr.write(
      `SpaceApp could not find the Docker CLI. ${dockerInstallHelp(platform)}\n`
    );
  }
  return code;
}

export async function readSecret(stdin, stdout, prompt, { mask = true } = {}) {
  stdout.write(prompt);
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    // Non-TTY stdin (e.g. piped input on Windows through npx.cmd). Read only
    // up to the first newline so an interactive console that reports non-TTY
    // stdin still works: previously this drained the stream to EOF, so typing
    // "y" + Enter looked frozen and a second keystroke produced "y\ny" and
    // "Please answer y or n." loops. When the stream ends before a newline
    // (fully piped answers), everything read is returned as-is so "y\nn\n"
    // piped input still yields successive valid answers. Event listeners are
    // used instead of the Readable async iterator because an abandoned
    // iterator can destroy the stream, breaking the next prompt.
    const value = await new Promise((resolve) => {
      let answer = "";
      const finish = (result) => {
        cleanup();
        resolve(result);
      };
      // Paused-mode reads: consume exactly one line from the buffer, leaving
      // the rest (and the stream itself) intact for the next prompt.
      const onReadable = () => {
        let chunk;
        while ((chunk = stdin.read()) !== null) {
          for (const character of String(chunk)) {
            if (character === "\r" || character === "\n") {
              finish(answer);
              return;
            }
            answer += character;
          }
        }
      };
      const onEnd = () => finish(answer);
      const onClose = () => finish(answer);
      const cleanup = () => {
        stdin.off("readable", onReadable);
        stdin.off("end", onEnd);
        stdin.off("close", onClose);
      };
      if (typeof stdin.read === "function" && typeof stdin.on === "function") {
        stdin.on("readable", onReadable);
        stdin.once("end", onEnd);
        stdin.once("close", onClose);
        onReadable();
      } else {
        // Fallback for exotic streams without readable-mode support.
        const iterator = stdin[Symbol.asyncIterator]();
        (async () => {
          for (;;) {
            const step = await iterator.next();
            if (step.done) {
              finish(answer);
              return;
            }
            for (const character of String(step.value)) {
              if (character === "\r" || character === "\n") {
                finish(answer);
                return;
              }
              answer += character;
            }
          }
        })().catch(() => finish(answer));
      }
    });
    stdout.write("\n");
    return value;
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let value = "";
  try {
    // Drive the iterator manually instead of breaking a for-await loop:
    // breaking a for-await early calls the Readable async iterator's return(),
    // which DESTROYS the stream, so any later prompt would abort. Stopping
    // without calling return() leaves the stream paused and intact.
    const iterator = stdin[Symbol.asyncIterator]();
    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        break;
      }
      for (const character of step.value) {
        if (character === "\u0003") {
          throw new Error("Input cancelled.");
        }
        if (character === "\r" || character === "\n") {
          stdout.write("\n");
          return value;
        }
        if (character === "\u007f") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (mask) stdout.write("\b \b");
          }
          continue;
        }
        value += character;
        if (mask) stdout.write("*");
      }
    }
    return value;
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

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
    const child = spawnTrustedCommand(spec, {
      env: commandEnv,
      shell: false,
      stdio: [input === undefined ? (stdin || "inherit") : "pipe", stdout || "ignore", stderr || "ignore"]
    });
    child.once("error", (error) => {
      if (error?.code === "ENOENT") {
        resolve(127);
      } else {
        reject(error);
      }
    });
    child.once("exit", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

function spawnTrustedCommand(spec, options) {
  const args = spec.args;
  switch (spec.command) {
    case "codesign": return spawn("codesign", args, options);
    case "docker": return spawn("docker", args, options);
    case "hdiutil": return spawn("hdiutil", args, options);
    case "open": return spawn("open", args, options);
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
  return execute({ command: "xdg-open", args: [url] }, io);
}

function assertNoArgs(args, command) {
  if (args.length > 0) {
    throw new Error(`Usage: ${UNIVERSAL_COMMAND} ${command}`);
  }
}

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

function dockerInstallHelp(platform) {
  if (platform === "win32") {
    return `Run "${UNIVERSAL_COMMAND} install" to install and start signed Docker Desktop with WSL2 automatically.`;
  }
  if (platform === "darwin") {
    return `Run "${UNIVERSAL_COMMAND} install" to install and start signed Docker Desktop automatically.`;
  }
  return `Run "${UNIVERSAL_COMMAND} install" to install and start Docker Engine and Compose automatically on supported Linux distributions.`;
}

function dockerEngineHelp(platform) {
  if (platform === "win32" || platform === "darwin") {
    return `Open Docker Desktop, complete any first-run prompt, then run "${UNIVERSAL_COMMAND} doctor" again.`;
  }
  return `Start Docker Engine, verify the current user can access it, then run "${UNIVERSAL_COMMAND} doctor" again.`;
}

function formatGibibytes(bytes) {
  return Math.floor((bytes / 1024 ** 3) * 10) / 10;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function helpText() {
  return `SpaceApp self-hosted launcher

Usage: ${UNIVERSAL_COMMAND} <command>
       spaceapp <command>             Optional global launcher

  init                              Create a local SpaceApp installation
  install [--profile auto|light|standard] [--access isolated|host-root] [--with-companions] [--no-open]
                                    Install prerequisites, initialize, and start
  up | down | status | logs         Manage the Docker application
  open                              Open the local web application
  doctor                            Check resources, Docker, Compose, and engine
  update [version] | rollback       Update or roll back images
  backup | restore                  Back up or restore persistent state
  workspace add <path> [--read-only]
  workspace remove <id-or-path>
  workspace list
  credentials set <provider>        Read a credential from masked stdin
  credentials remove <provider>
  credentials list
  provider install claude           Owner-initiated Anthropic package install
  owner reset-password              Read the new password from masked stdin
  owner rotate-setup-token          Replace an expired unclaimed setup token
  uninstall [--purge-data]          Remove containers; keep data by default

Interactive setup wizard: install, update, init, rollback, and uninstall ask
questions and require a final confirmation before any change. Command flags
pre-select answers but never skip the confirmation. Without a TTY, changes
are refused; the only exception is an approved Windows RunOnce continuation
(bound to the user, installation root, and target version; expires in 24h).
`;
}
