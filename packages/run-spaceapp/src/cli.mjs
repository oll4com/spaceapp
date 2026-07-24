import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  addWorkspace,
  composeCommand,
  credentialProviders,
  initializeInstallation,
  inspectSystemResources,
  installResourceChecks,
  loadConfig,
  removeCredential,
  removeWorkspace,
  resolveInstallProfile,
  resolveSpaceAppHome,
  saveConfig,
  selectLatestBackupId,
  writeCredential,
  writeRuntimeFiles,
  writeSetupToken
} from "./index.mjs";
import {
  ensureDockerAvailable,
  windowsPowerShellArgs
} from "./prerequisites.mjs";

const trustedCommands = new Set([
  "codesign",
  "docker",
  "explorer.exe",
  "hdiutil",
  "open",
  "powershell.exe",
  "sg",
  "spctl",
  "sudo",
  "winget.exe",
  "wsl.exe",
  "xdg-open"
]);
const trustedEnvironmentNames = new Set([
  "SPACEAPP_DOCKER_INSTALLER_PATH"
]);

export async function run(argv, {
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  execute = executeCommand,
  inspectResources = inspectSystemResources,
  ensureDocker = ensureDockerAvailable
} = {}) {
  const [command = "help", ...args] = argv;
  const root = resolveSpaceAppHome({ env, platform });
  const version = await packageVersion();

  if (command === "help" || command === "--help" || command === "-h") {
    stdout.write(helpText());
    return 0;
  }
  if (command === "--version" || command === "-v") {
    stdout.write(`${version}\n`);
    return 0;
  }
  if (command === "install") {
    return installCommand(args, {
      root,
      version,
      platform,
      arch,
      env,
      stdin,
      stdout,
      stderr,
      execute,
      inspectResources,
      ensureDocker
    });
  }
  if (command === "init") {
    assertNoArgs(args, "init");
    const result = await initializeInstallation(root, { version });
    stdout.write(`SpaceApp initialized at ${root}\n`);
    if (result.setupToken) {
      stdout.write(`One-time setup token: ${result.setupToken}\n`);
      stdout.write("Store it temporarily; it expires after first owner setup.\n");
    }
    stdout.write("Next: spaceapp doctor && spaceapp up && spaceapp open\n");
    return 0;
  }

  const config = await loadConfig(root);
  await writeRuntimeFiles(root, config);

  if (["up", "down", "status", "logs"].includes(command)) {
    assertNoArgs(args, command);
    return execute(composeCommand(command, root, { profile: config.profile }), { stdin, stdout, stderr });
  }
  if (command === "open") {
    assertNoArgs(args, "open");
    return openBrowser(`http://${config.bindHost}:${config.port}`, platform, execute, { stdin, stdout, stderr });
  }
  if (command === "doctor") {
    assertNoArgs(args, "doctor");
    return doctor({ root, platform, stdout, stderr, execute, stdin, inspectResources });
  }
  if (command === "workspace") {
    return workspaceCommand(args, { root, config, stdout });
  }
  if (command === "credentials") {
    return credentialsCommand(args, { root, config, stdin, stdout, stderr, execute });
  }
  if (command === "provider") {
    return providerCommand(args, { root, config, stdin, stdout, stderr, execute });
  }
  if (command === "owner") {
    return ownerCommand(args, { root, config, stdin, stdout, stderr, execute });
  }
  if (command === "update") {
    return updateCommand(args, { root, config, version, stdin, stdout, stderr, execute });
  }
  if (command === "rollback") {
    assertNoArgs(args, "rollback");
    if (!config.previousVersion) {
      throw new Error("No previous SpaceApp version is recorded.");
    }
    const rollback = {
      ...config,
      version: config.previousVersion,
      previousVersion: config.version
    };
    await writeRuntimeFiles(root, rollback);
    const pullCode = await execute(composeCommand("pull", root, { profile: rollback.profile }), { stdin, stdout, stderr });
    if (pullCode !== 0) {
      await writeRuntimeFiles(root, config);
      return pullCode;
    }
    const upCode = await execute(composeCommand("up", root, { profile: rollback.profile }), { stdin, stdout, stderr });
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
    return execute(composeCommand("backup", root, { profile: config.profile }), { stdin, stdout, stderr });
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
    const backupCode = await execute(composeCommand("backup", root, { profile: config.profile }), { stdin, stdout, stderr });
    if (backupCode !== 0) return backupCode;
    const stopCode = await execute(composeCommand("stopForRestore", root, { profile: config.profile }), { stdin, stdout, stderr });
    if (stopCode !== 0) return stopCode;
    const restoreCode = await execute(
      composeCommand("restore", root, { backupId, profile: config.profile }),
      { stdin, stdout, stderr }
    );
    if (restoreCode !== 0) return restoreCode;
    return execute(composeCommand("up", root, { profile: config.profile }), { stdin, stdout, stderr });
  }
  if (command === "uninstall") {
    if (args.length === 0) {
      const code = await execute(composeCommand("down", root, { profile: config.profile }), { stdin, stdout, stderr });
      if (code === 0) {
        stdout.write(`Containers removed. Data and configuration remain at ${root}.\n`);
      }
      return code;
    }
    if (args.length === 1 && args[0] === "--purge-data") {
      const confirmation = await readSecret(stdin, stdout, "Type DELETE to remove Docker volumes: ", { mask: false });
      if (confirmation !== "DELETE") {
        throw new Error("Purge cancelled.");
      }
      return execute(composeCommand("purge", root, { profile: config.profile }), { stdin, stdout, stderr });
    }
    throw new Error("Usage: spaceapp uninstall [--purge-data]");
  }

  throw new Error(`Unknown command "${command}". Run "spaceapp help".`);
}

async function installCommand(args, {
  root,
  version,
  platform,
  arch,
  env,
  stdin,
  stdout,
  stderr,
  execute,
  inspectResources,
  ensureDocker
}) {
  const { requestedProfile, noOpen } = parseInstallArgs(args);
  const resources = await inspectResources(root);
  const profile = resolveInstallProfile(requestedProfile, resources.totalMemoryBytes);
  const result = await initializeInstallation(root, { version, profile });

  stdout.write(
    `Selected profile: ${profile} (${formatGigabytes(resources.totalMemoryBytes)} GB system memory detected).\n`
  );
  stdout.write(`SpaceApp installation root: ${root}\n`);
  if (result.setupToken) {
    stdout.write(`One-time setup token: ${result.setupToken}\n`);
    stdout.write("Store it temporarily; it expires after first owner setup.\n");
  }

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
    stderr.write("Installation stopped before downloading images. Fix the failed checks and run the same command again.\n");
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
    installArgs: { requestedProfile, noOpen }
  });
  if (prerequisiteResult.reexecuted || prerequisiteResult.code !== 0) {
    if (prerequisiteResult.code !== 0) {
      stderr.write("Installation stopped before downloading images. Fix the failed checks and run the same command again.\n");
    }
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
    stderr.write("Installation stopped before downloading images. Fix the failed checks and run the same command again.\n");
    return doctorCode;
  }
  const pullCode = await execute(composeCommand("pull", root, { profile }), { stdin, stdout, stderr });
  if (pullCode !== 0) return pullCode;
  const upCode = await execute(composeCommand("up", root, { profile }), { stdin, stdout, stderr });
  if (upCode !== 0) return upCode;

  const url = `http://${result.config.bindHost}:${result.config.port}`;
  stdout.write(`SpaceApp is running at ${url}\n`);
  stdout.write('Next: add CLI credentials with "spaceapp credentials set <provider>".\n');
  if (noOpen) return 0;
  const openCode = await openBrowser(url, platform, execute, { stdin, stdout, stderr });
  if (openCode !== 0) {
    stderr.write(`Could not open SpaceApp automatically. Open ${url} manually.\n`);
  }
  return 0;
}

function parseInstallArgs(args) {
  let requestedProfile = "auto";
  let noOpen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open" && !noOpen) {
      noOpen = true;
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
    throw new Error("Usage: spaceapp install [--profile auto|light|standard] [--no-open]");
  }
  if (!["auto", "light", "standard"].includes(requestedProfile)) {
    throw new Error("Usage: spaceapp install [--profile auto|light|standard] [--no-open]");
  }
  return { requestedProfile, noOpen };
}

async function workspaceCommand(args, { root, config, stdout }) {
  const [action, identity, ...rest] = args;
  if (action === "add") {
    if (!identity || rest.some((arg) => arg !== "--read-only")) {
      throw new Error("Usage: spaceapp workspace add <absolute-path> [--read-only]");
    }
    const updated = await addWorkspace(config, identity, { readOnly: rest.includes("--read-only") });
    await saveConfig(root, updated);
    await writeRuntimeFiles(root, updated);
    stdout.write(`Workspace registered: ${identity}\n`);
    return 0;
  }
  if (action === "remove") {
    if (!identity || rest.length > 0) {
      throw new Error("Usage: spaceapp workspace remove <id-or-absolute-path>");
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
  throw new Error("Usage: spaceapp workspace <add|remove|list>");
}

async function credentialsCommand(args, { root, config, stdin, stdout, stderr, execute }) {
  const [action, provider, ...rest] = args;
  if (action === "list" && args.length === 1) {
    stdout.write(`${JSON.stringify(credentialProviders(), null, 2)}\n`);
    return 0;
  }
  if (action === "set") {
    if (!provider || rest.length > 0) {
      throw new Error("Usage: spaceapp credentials set <provider> (the value is read from stdin)");
    }
    const value = await readSecret(stdin, stdout, `Enter ${provider} credential: `);
    await writeCredential(root, provider, value);
    const syncCode = await execute(
      composeCommand("syncCredentials", root, { profile: config.profile }),
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
      throw new Error("Usage: spaceapp credentials remove <provider>");
    }
    const removed = await removeCredential(root, provider);
    const syncCode = await execute(
      composeCommand("syncCredentials", root, { profile: config.profile }),
      { stdin, stdout, stderr }
    );
    if (syncCode !== 0) {
      stderr.write(`Credential file state changed for ${provider}, but the CLI service could not be refreshed.\n`);
      return syncCode;
    }
    stdout.write(removed ? `Credential removed and applied for ${provider}.\n` : `No credential stored for ${provider}.\n`);
    return syncCode;
  }
  throw new Error("Usage: spaceapp credentials <set|remove|list>");
}

async function providerCommand(args, { root, config, stdin, stdout, stderr, execute }) {
  if (args.length !== 2 || args[0] !== "install" || args[1] !== "claude") {
    throw new Error("Usage: spaceapp provider install claude");
  }
  stdout.write("Installing Claude Code from Anthropic into this installation's private provider volume.\n");
  return execute(composeCommand("installClaude", root, { profile: config.profile }), { stdin, stdout, stderr });
}

async function ownerCommand(args, { root, config, stdin, stdout, stderr, execute }) {
  if (args.length === 1 && args[0] === "rotate-setup-token") {
    const token = randomBytes(32).toString("base64url");
    const code = await execute(composeCommand("rotateOwnerSetupToken", root, { profile: config.profile }), {
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
    throw new Error("Usage: spaceapp owner <reset-password|rotate-setup-token>");
  }
  const password = await readSecret(stdin, stdout, "New owner password: ");
  if (password.length < 12) {
    throw new Error("Owner password must be at least 12 characters.");
  }
  return execute(composeCommand("resetOwnerPassword", root, { profile: config.profile }), {
    stdin,
    stdout,
    stderr,
    input: `${password}\n`
  });
}

async function updateCommand(args, { root, config, version, stdin, stdout, stderr, execute }) {
  if (args.length > 1) {
    throw new Error("Usage: spaceapp update [version]");
  }
  const targetVersion = args[0] || version;
  const updated = {
    ...config,
    version: targetVersion,
    previousVersion: config.version
  };
  await writeRuntimeFiles(root, updated);
  const pullCode = await execute(composeCommand("pull", root, { profile: updated.profile }), { stdin, stdout, stderr });
  if (pullCode !== 0) {
    await writeRuntimeFiles(root, config);
    return pullCode;
  }
  const upCode = await execute(composeCommand("up", root, { profile: updated.profile }), { stdin, stdout, stderr });
  if (upCode !== 0) {
    await writeRuntimeFiles(root, config);
    return upCode;
  }
  await saveConfig(root, updated);
  stdout.write(`Updated to SpaceApp ${targetVersion}.\n`);
  return 0;
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
  let dockerMissing = false;
  for (const probe of [
    { name: "Docker", command: "docker", args: ["--version"] },
    { name: "Docker Compose", command: "docker", args: ["compose", "version"] },
    { name: "Docker Engine", command: "docker", args: ["info"] }
  ]) {
    const code = dockerReady
      ? 0
      : await execute(probe, { stdin, stdout: null, stderr: null });
    if (code !== 0) dockerMissing = true;
    checks.push({ name: probe.name, ok: code === 0, detail: code === 0 ? "available" : "missing" });
  }
  for (const check of checks) {
    (check.ok ? stdout : stderr).write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
  }
  if (dockerMissing) {
    stderr.write(`${dockerInstallHelp(platform)}\n`);
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}

export async function readSecret(stdin, stdout, prompt, { mask = true } = {}) {
  stdout.write(prompt);
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    let value = "";
    for await (const chunk of stdin) {
      value += chunk;
    }
    stdout.write("\n");
    return value.replace(/[\r\n]+$/, "");
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let value = "";
  try {
    for await (const chunk of stdin) {
      for (const character of chunk) {
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
    case "explorer.exe": return spawn("explorer.exe", args, options);
    case "hdiutil": return spawn("hdiutil", args, options);
    case "open": return spawn("open", args, options);
    case "powershell.exe":
      return spawn("powershell.exe", windowsPowerShellArgs(spec.operation), options);
    case "sg": return spawn("sg", args, options);
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
    return execute({ command: "explorer.exe", args: [url] }, io);
  }
  return execute({ command: "xdg-open", args: [url] }, io);
}

function assertNoArgs(args, command) {
  if (args.length > 0) {
    throw new Error(`Usage: spaceapp ${command}`);
  }
}

function dockerInstallHelp(platform) {
  if (platform === "win32") {
    return 'Run "spaceapp install" to install and start signed Docker Desktop with WSL2 automatically.';
  }
  if (platform === "darwin") {
    return 'Run "spaceapp install" to install and start signed Docker Desktop automatically.';
  }
  return 'Run "spaceapp install" to install and start Docker Engine and Compose automatically on supported Linux distributions.';
}

function formatGigabytes(bytes) {
  return Math.floor((bytes / 1024 ** 3) * 10) / 10;
}

async function packageVersion() {
  const packageJson = new URL("../package.json", import.meta.url);
  return JSON.parse(await readFile(packageJson, "utf8")).version;
}

function helpText() {
  return `SpaceApp self-hosted launcher

Usage: spaceapp <command>

  init                              Create a local SpaceApp installation
  install [--profile auto|light|standard] [--no-open]
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
`;
}
