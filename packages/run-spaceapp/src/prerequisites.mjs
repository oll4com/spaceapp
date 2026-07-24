import { createWriteStream } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const DOCKER_TERMS_URL = "https://www.docker.com/legal/docker-subscription-service-agreement/";
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
      { command: "wsl.exe", args: ["--install", "--no-distribution"] },
      { stdin, stdout, stderr }
    );
    if (installWslCode !== 0) {
      stderr.write(
        "Windows could not enable WSL2 automatically. Run this command from an Administrator terminal, restart Windows if requested, and run it again.\n"
      );
      return { code: installWslCode, reexecuted: false };
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
  const cliDirectory = join(application, "Contents", "Resources", "bin");
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
    const installer = join(mountedApplication, "Contents", "MacOS", "install");
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

async function ensureLinuxDocker() {
  return { code: 1, reexecuted: false };
}

async function confirmDesktopInstall({ platformName, stdin, stdout }) {
  const readline = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  try {
    const answer = await readline.question(
      `Review the Docker Desktop terms at ${DOCKER_TERMS_URL}\nInstall Docker Desktop for ${platformName} and accept those terms? [y/N] `
    );
    return /^(?:y|yes)$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    readline.close();
  }
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

async function downloadFile(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Docker download failed with HTTP ${response.status}.`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(target, { flags: "wx", mode: 0o600 })
  );
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
