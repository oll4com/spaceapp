import { createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, posix, win32 } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DOCKER_TERMS_URL = "https://www.docker.com/legal/docker-subscription-service-agreement/";
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000;
const WINDOWS_DOCKER_DOWNLOADS = Object.freeze({
  x64: "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe",
  arm64: "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe"
});
const MAC_DOCKER_DOWNLOADS = Object.freeze({
  x64: "https://desktop.docker.com/mac/main/amd64/Docker.dmg",
  arm64: "https://desktop.docker.com/mac/main/arm64/Docker.dmg"
});

export async function ensureDockerAvailable({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  execute,
  launch = launchDetachedCommand,
  download = downloadFile,
  pathExists = fileExists,
  sleep = wait,
  osRelease,
  installArgs
}) {
  if (await dockerIsReady(execute)) {
    return { code: 0, reexecuted: false };
  }
  if (platform === "win32") {
    return ensureWindowsDocker({
      arch,
      env,
      stdin,
      stdout,
      stderr,
      execute,
      launch,
      download,
      pathExists,
      sleep
    });
  }
  if (platform === "darwin") {
    return ensureMacDocker({
      arch,
      env,
      stdin,
      stdout,
      stderr,
      execute,
      launch,
      download,
      pathExists,
      sleep
    });
  }
  return ensureLinuxDocker({
    arch,
    env,
    stdin,
    stdout,
    stderr,
    execute,
    download,
    sleep,
    osRelease,
    installArgs
  });
}

async function ensureWindowsDocker({
  arch,
  env,
  stdin,
  stdout,
  stderr,
  execute,
  launch,
  download,
  pathExists,
  sleep
}) {
  const paths = windowsDockerPaths(env);
  let application = await firstExisting(paths.applications, pathExists);

  if (!application) {
    stdout.write("Docker Desktop is required and is not installed.\n");
    const accepted = await confirmDesktopInstall({ platformName: "Windows", stdin, stdout });
    if (!accepted) {
      stderr.write("Docker Desktop installation was cancelled.\n");
      return { code: 1, reexecuted: false };
    }
  }

  const wslCode = await execute(
    { command: "wsl.exe", args: ["--version"] },
    { stdin, stdout: null, stderr: null }
  );
  if (wslCode !== 0) {
    stdout.write("Installing the Windows Subsystem for Linux 2 support required by Docker Desktop...\n");
    const installWslCode = await execute(
      {
        command: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            "$ErrorActionPreference = 'Stop'; try {",
            "$process = Start-Process -FilePath 'wsl.exe'",
            "-ArgumentList @('--install','--no-distribution')",
            "-Verb RunAs -Wait -PassThru",
            "; exit $process.ExitCode",
            "} catch { exit 1 }"
          ].join(" ")
        ]
      },
      { stdin, stdout, stderr }
    );
    if (installWslCode !== 0) {
      stderr.write(
        "Windows could not enable WSL2 automatically. Run this command from an Administrator terminal, restart Windows if requested, and run it again.\n"
      );
      return { code: installWslCode, reexecuted: false };
    }
    const installedWslCode = await execute(
      { command: "wsl.exe", args: ["--version"] },
      { stdin, stdout: null, stderr: null }
    );
    if (installedWslCode !== 0) {
      stderr.write(
        "Windows must restart to finish enabling WSL2. Restart Windows, then run the same SpaceApp command again.\n"
      );
      return { code: 1, reexecuted: false };
    }
  }

  if (!application) {
    const downloadUrl = WINDOWS_DOCKER_DOWNLOADS[arch];
    if (!downloadUrl) {
      stderr.write(`Docker Desktop automatic installation does not support Windows architecture "${arch}".\n`);
      return { code: 1, reexecuted: false };
    }
    const temporaryRoot = await mkdtemp(join(tmpdir(), "spaceapp-docker-"));
    const installer = join(temporaryRoot, "Docker Desktop Installer.exe");
    try {
      stdout.write("Downloading Docker Desktop from Docker's official distribution service...\n");
      await download(downloadUrl, installer);
      const signatureCode = await execute({
        command: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
            "if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Docker') { exit 1 }"
          ].join("; "),
          installer
        ]
      }, { stdin, stdout: null, stderr });
      if (signatureCode !== 0) {
        stderr.write("The Docker Desktop installer signature is not valid. Installation was stopped.\n");
        return { code: 1, reexecuted: false };
      }
      const installCode = await execute({
        command: installer,
        args: ["install", "--user", "--quiet", "--accept-license"]
      }, { stdin, stdout, stderr });
      if (installCode !== 0) {
        stderr.write("Docker Desktop installation failed before SpaceApp downloaded any images.\n");
        return { code: installCode, reexecuted: false };
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    application = await firstExisting(paths.applications, pathExists);
    if (!application) {
      stderr.write("Docker Desktop reported success, but its application could not be found.\n");
      return { code: 1, reexecuted: false };
    }
  } else {
    stdout.write("Docker Desktop is installed but is not running. Starting it now...\n");
  }

  const cliDirectory = await firstExisting(paths.cliDirectories, pathExists);
  if (cliDirectory) {
    prependPath(env, cliDirectory);
  }
  const launchCode = await launch({ command: application, args: [] });
  if (launchCode !== 0) {
    stderr.write("Docker Desktop is installed, but SpaceApp could not start it.\n");
    return { code: launchCode, reexecuted: false };
  }
  if (await waitForDocker({ execute, sleep })) {
    stdout.write("Docker Desktop is ready.\n");
    return { code: 0, reexecuted: false };
  }
  stderr.write(
    "Docker Desktop was installed but did not become ready. Complete any Docker Desktop prompt or restart Windows if requested, then run the same SpaceApp command again.\n"
  );
  return { code: 1, reexecuted: false };
}

async function ensureMacDocker({
  arch,
  env,
  stdin,
  stdout,
  stderr,
  execute,
  launch,
  download,
  pathExists,
  sleep
}) {
  const application = "/Applications/Docker.app";
  const cliDirectory = posix.join(application, "Contents", "Resources", "bin");
  let installed = await pathExists(application);

  if (!installed) {
    stdout.write("Docker Desktop is required and is not installed.\n");
    const accepted = await confirmDesktopInstall({ platformName: "macOS", stdin, stdout });
    if (!accepted) {
      stderr.write("Docker Desktop installation was cancelled.\n");
      return { code: 1, reexecuted: false };
    }
    const downloadUrl = MAC_DOCKER_DOWNLOADS[arch];
    if (!downloadUrl) {
      stderr.write(`Docker Desktop automatic installation does not support macOS architecture "${arch}".\n`);
      return { code: 1, reexecuted: false };
    }
    const username = String(env.USER || "");
    if (!/^[A-Za-z0-9._-]+$/.test(username)) {
      stderr.write("A valid macOS username is required for Docker Desktop installation.\n");
      return { code: 1, reexecuted: false };
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), "spaceapp-docker-"));
    const diskImage = join(temporaryRoot, "Docker.dmg");
    const mountedApplication = "/Volumes/Docker/Docker.app";
    const installer = posix.join(mountedApplication, "Contents", "MacOS", "install");
    let mounted = false;
    try {
      stdout.write("Downloading Docker Desktop from Docker's official distribution service...\n");
      await download(downloadUrl, diskImage);
      const attachCode = await execute(
        { command: "hdiutil", args: ["attach", "-nobrowse", diskImage] },
        { stdin, stdout, stderr }
      );
      if (attachCode !== 0) {
        return { code: attachCode, reexecuted: false };
      }
      mounted = true;
      const signatureCode = await execute({
        command: "codesign",
        args: ["--verify", "--deep", "--strict", "--verbose=2", mountedApplication]
      }, { stdin, stdout: null, stderr });
      if (signatureCode !== 0) {
        stderr.write("The Docker Desktop application signature is not valid. Installation was stopped.\n");
        return { code: 1, reexecuted: false };
      }
      const gatekeeperCode = await execute({
        command: "spctl",
        args: ["--assess", "--type", "execute", "--verbose=4", mountedApplication]
      }, { stdin, stdout: null, stderr });
      if (gatekeeperCode !== 0) {
        stderr.write("macOS Gatekeeper did not accept Docker Desktop. Installation was stopped.\n");
        return { code: 1, reexecuted: false };
      }
      const installCode = await execute({
        command: "sudo",
        args: [installer, "--accept-license", `--user=${username}`]
      }, { stdin, stdout, stderr });
      if (installCode !== 0) {
        stderr.write("Docker Desktop installation failed before SpaceApp downloaded any images.\n");
        return { code: installCode, reexecuted: false };
      }
    } finally {
      if (mounted) {
        await execute(
          { command: "hdiutil", args: ["detach", "/Volumes/Docker"] },
          { stdin, stdout: null, stderr: null }
        );
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    installed = await pathExists(application);
    if (!installed) {
      stderr.write("Docker Desktop reported success, but /Applications/Docker.app could not be found.\n");
      return { code: 1, reexecuted: false };
    }
  } else {
    stdout.write("Docker Desktop is installed but is not running. Starting it now...\n");
  }

  if (await pathExists(cliDirectory)) {
    prependPath(env, cliDirectory);
  }
  const launchCode = await launch({ command: "open", args: ["-a", "Docker"] });
  if (launchCode !== 0) {
    stderr.write("Docker Desktop is installed, but SpaceApp could not start it.\n");
    return { code: launchCode, reexecuted: false };
  }
  if (await waitForDocker({ execute, sleep })) {
    stdout.write("Docker Desktop is ready.\n");
    return { code: 0, reexecuted: false };
  }
  stderr.write(
    "Docker Desktop was installed but did not become ready. Complete any Docker Desktop prompt, then run the same SpaceApp command again.\n"
  );
  return { code: 1, reexecuted: false };
}

async function ensureLinuxDocker({
  arch,
  env,
  stdin,
  stdout,
  stderr,
  execute,
  download,
  osRelease,
  installArgs
}) {
  const cliAvailable = await dockerCliAndComposeAreAvailable(execute);
  if (!cliAvailable) {
    const release = osRelease ?? await readLinuxOsRelease();
    stdout.write(`Docker Engine is required and is not installed. Installing it for ${release.ID}...\n`);
    const installCode = await installLinuxDockerEngine({
      arch,
      release,
      stdin,
      stdout,
      stderr,
      execute,
      download
    });
    if (installCode !== 0) {
      return { code: installCode, reexecuted: false };
    }
  } else {
    stdout.write("Docker Engine is installed but is not ready. Starting it now...\n");
  }

  const startCode = await execute(
    { command: "sudo", args: ["systemctl", "enable", "--now", "docker"] },
    { stdin, stdout, stderr }
  );
  if (startCode !== 0) {
    stderr.write("Docker Engine was installed, but its system service could not be started.\n");
    return { code: startCode, reexecuted: false };
  }
  if (await dockerIsReady(execute)) {
    stdout.write("Docker Engine is ready.\n");
    return { code: 0, reexecuted: false };
  }
  if (env.SPACEAPP_PREREQUISITES_BOOTSTRAPPED === "1") {
    stderr.write("Docker Engine is running, but the current user still cannot access it.\n");
    return { code: 1, reexecuted: false };
  }

  const username = String(env.SUDO_USER || env.USER || "");
  if (!/^[A-Za-z0-9._-]+$/.test(username) || username === "root") {
    stderr.write("A valid non-root Linux username is required for Docker Engine access.\n");
    return { code: 1, reexecuted: false };
  }
  const accepted = await confirmQuestion({
    stdin,
    stdout,
    question: [
      "Docker's official post-install flow uses the docker group.",
      "Membership grants root-level privileges on this host.",
      `Add ${username} to the docker group and continue? [y/N] `
    ].join("\n")
  });
  if (!accepted) {
    stderr.write("Docker group membership was not changed.\n");
    return { code: 1, reexecuted: false };
  }
  const groupCode = await execute(
    { command: "sudo", args: ["usermod", "-aG", "docker", username] },
    { stdin, stdout, stderr }
  );
  if (groupCode !== 0) {
    return { code: groupCode, reexecuted: false };
  }

  const reentryCommand = linuxReentryCommand(installArgs);
  stdout.write("Docker Engine is ready. Continuing SpaceApp installation with the new group membership...\n");
  const reentryCode = await execute(
    { command: "sg", args: ["docker", "-c", reentryCommand] },
    { stdin, stdout, stderr }
  );
  return { code: reentryCode, reexecuted: true };
}

async function confirmDesktopInstall({ platformName, stdin, stdout }) {
  return confirmQuestion({
    stdin,
    stdout,
    question:
      `Review the Docker Desktop terms at ${DOCKER_TERMS_URL}\n` +
      `Install Docker Desktop for ${platformName} and accept those terms? [y/N] `
  });
}

async function confirmQuestion({ stdin, stdout, question }) {
  const readline = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  try {
    const answer = await readline.question(question);
    return /^(?:y|yes)$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    readline.close();
  }
}

async function dockerCliAndComposeAreAvailable(execute) {
  for (const spec of [
    { command: "docker", args: ["--version"] },
    { command: "docker", args: ["compose", "version"] }
  ]) {
    if (await execute(spec, { stdout: null, stderr: null }) !== 0) {
      return false;
    }
  }
  return true;
}

async function dockerIsReady(execute) {
  for (const spec of [
    { command: "docker", args: ["--version"] },
    { command: "docker", args: ["compose", "version"] },
    { command: "docker", args: ["info"] }
  ]) {
    if (await execute(spec, { stdout: null, stderr: null }) !== 0) {
      return false;
    }
  }
  return true;
}

async function installLinuxDockerEngine({
  arch,
  release,
  stdin,
  stdout,
  stderr,
  execute,
  download
}) {
  const id = String(release?.ID || "").toLowerCase();
  if (id === "ubuntu" || id === "debian") {
    return installAptDockerEngine({
      arch,
      id,
      codename: release.VERSION_CODENAME || release.UBUNTU_CODENAME,
      stdin,
      stdout,
      stderr,
      execute,
      download
    });
  }
  if (id === "fedora" || id === "rhel" || id === "centos") {
    return installDnfDockerEngine({ id, stdin, stdout, stderr, execute });
  }
  stderr.write(
    `Automatic Docker Engine installation is not yet supported for Linux distribution "${id || "unknown"}". ` +
    "Install Docker Engine and the Compose plugin from https://docs.docker.com/engine/install/ and rerun the same command.\n"
  );
  return 1;
}

async function installAptDockerEngine({
  arch,
  id,
  codename,
  stdin,
  stdout,
  stderr,
  execute,
  download
}) {
  const dockerArch = { x64: "amd64", arm64: "arm64" }[arch];
  if (!dockerArch || !/^[a-z0-9._-]+$/.test(String(codename || ""))) {
    stderr.write("This Debian/Ubuntu architecture or release codename is not supported automatically.\n");
    return 1;
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "spaceapp-docker-"));
  const signingKey = join(temporaryRoot, "docker.asc");
  const repositoryFile = join(temporaryRoot, "docker.list");
  const repositoryBase = `https://download.docker.com/linux/${id}`;
  try {
    await download(`${repositoryBase}/gpg`, signingKey);
    await writeFile(
      repositoryFile,
      `deb [arch=${dockerArch} signed-by=/etc/apt/keyrings/docker.asc] ${repositoryBase} ${codename} stable\n`,
      { mode: 0o600, flag: "wx" }
    );
    for (const spec of [
      { command: "sudo", args: ["install", "-m", "0755", "-d", "/etc/apt/keyrings"] },
      { command: "sudo", args: ["install", "-m", "0644", signingKey, "/etc/apt/keyrings/docker.asc"] },
      {
        command: "sudo",
        args: ["install", "-m", "0644", repositoryFile, "/etc/apt/sources.list.d/docker.list"]
      },
      { command: "sudo", args: ["apt-get", "update"] },
      {
        command: "sudo",
        args: [
          "apt-get",
          "install",
          "-y",
          "docker-ce",
          "docker-ce-cli",
          "containerd.io",
          "docker-buildx-plugin",
          "docker-compose-plugin"
        ]
      }
    ]) {
      const code = await execute(spec, { stdin, stdout, stderr });
      if (code !== 0) {
        return code;
      }
    }
    return 0;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function installDnfDockerEngine({ id, stdin, stdout, stderr, execute }) {
  const repositoryUrl = `https://download.docker.com/linux/${id}/docker-ce.repo`;
  const repositoryArgs = id === "fedora"
    ? ["dnf", "config-manager", "addrepo", "--from-repofile", repositoryUrl]
    : ["dnf", "config-manager", "--add-repo", repositoryUrl];
  const pluginCode = await execute(
    { command: "sudo", args: ["dnf", "-y", "install", "dnf-plugins-core"] },
    { stdin, stdout, stderr }
  );
  if (pluginCode !== 0) {
    return pluginCode;
  }

  let repositoryCode = await execute(
    { command: "sudo", args: repositoryArgs },
    { stdin, stdout, stderr }
  );
  if (repositoryCode !== 0 && id === "fedora") {
    stdout.write("The DNF5 repository command was unavailable; retrying with DNF4 syntax...\n");
    repositoryCode = await execute(
      {
        command: "sudo",
        args: ["dnf", "config-manager", "--add-repo", repositoryUrl]
      },
      { stdin, stdout, stderr }
    );
  }
  if (repositoryCode !== 0) {
    return repositoryCode;
  }

  return execute(
    {
      command: "sudo",
      args: [
        "dnf",
        "-y",
        "install",
        "docker-ce",
        "docker-ce-cli",
        "containerd.io",
        "docker-buildx-plugin",
        "docker-compose-plugin"
      ]
    },
    { stdin, stdout, stderr }
  );
}

async function readLinuxOsRelease() {
  const content = await readFile("/etc/os-release", "utf8");
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2].trim();
    values[match[1]] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

function linuxReentryCommand({ requestedProfile = "auto", noOpen = false } = {}) {
  if (!["auto", "light", "standard"].includes(requestedProfile)) {
    throw new Error("Invalid SpaceApp profile for Docker group re-entry.");
  }
  const entrypoint = fileURLToPath(new URL("../bin/spaceapp.mjs", import.meta.url));
  return [
    "/usr/bin/env",
    "SPACEAPP_PREREQUISITES_BOOTSTRAPPED=1",
    process.execPath,
    entrypoint,
    "install",
    "--profile",
    requestedProfile,
    ...(noOpen ? ["--no-open"] : [])
  ].map(shellQuote).join(" ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function waitForDocker({ execute, sleep }) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (await dockerIsReady(execute)) {
      return true;
    }
    await sleep(2_000);
  }
  return false;
}

function windowsDockerPaths(env) {
  const localAppData = env.LOCALAPPDATA;
  const programFiles = env.ProgramFiles || env.PROGRAMFILES;
  return {
    applications: [
      localAppData && win32.join(localAppData, "Programs", "DockerDesktop", "Docker Desktop.exe"),
      programFiles && win32.join(programFiles, "Docker", "Docker", "Docker Desktop.exe")
    ].filter(Boolean),
    cliDirectories: [
      localAppData && win32.join(localAppData, "Programs", "DockerDesktop", "resources", "bin"),
      programFiles && win32.join(programFiles, "Docker", "Docker", "resources", "bin")
    ].filter(Boolean)
  };
}

async function firstExisting(paths, pathExists) {
  for (const path of paths) {
    if (await pathExists(path)) {
      return path;
    }
  }
  return null;
}

function prependPath(env, directory) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const entries = String(env[pathKey] || "").split(delimiter).filter(Boolean);
  if (!entries.includes(directory)) {
    env[pathKey] = [directory, ...entries].join(delimiter);
  }
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function downloadFile(url, target, {
  timeoutMs = DOWNLOAD_TIMEOUT_MS
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Docker download timeout must be a positive number.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      throw new Error(`Docker download failed with HTTP ${response.status}.`);
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
      { signal: controller.signal }
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Docker download timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function launchDetachedCommand(spec) {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      shell: false,
      stdio: "ignore"
    });
    child.once("error", () => resolve(1));
    child.once("spawn", () => {
      child.unref();
      resolve(0);
    });
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
