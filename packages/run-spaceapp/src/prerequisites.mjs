import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEngineInfo } from "./index.mjs";
import { UNIVERSAL_INSTALL_COMMAND } from "./package-info.mjs";

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
const MAC_ADMIN_PASSWORD_PROMPT =
  "SpaceApp Mac administrator password (input hidden): ";
// Sources:
// https://learn.microsoft.com/windows/package-manager/winget/install
// https://github.com/microsoft/winget-pkgs/tree/master/manifests/d/Docker/DockerDesktop
const WINDOWS_DOCKER_WINGET_ARGS = Object.freeze([
  "install",
  "--id", "Docker.DockerDesktop",
  "--exact",
  "--source", "winget",
  "--silent",
  "--accept-package-agreements",
  "--accept-source-agreements",
  "--disable-interactivity"
]);

export function windowsPowerShellArgs(operation) {
  const scripts = {
    "install-wsl": [
      "$ErrorActionPreference = 'Stop'; try {",
      "$process = Start-Process -FilePath 'wsl.exe'",
      "-ArgumentList @('--install','--no-distribution')",
      "-Verb RunAs -Wait -PassThru",
      "; exit $process.ExitCode",
      "} catch { exit 1 }"
    ].join(" "),
    "windows-restart-pending": [
      "$pending = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')",
      "if ($pending) { exit 0 }",
      "exit 1"
    ].join("; "),
    "register-spaceapp-resume": [
      "$ErrorActionPreference = 'Stop'",
      "$path = $env:SPACEAPP_RESUME_SCRIPT_PATH",
      "if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { exit 1 }",
      "$runOnce = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'",
      "New-Item -Path $runOnce -Force | Out-Null",
      "$command = 'cmd.exe /d /k call \"' + $path + '\"'",
      "New-ItemProperty -Path $runOnce -Name 'SpaceAppResumeInstall' -Value $command -PropertyType String -Force | Out-Null"
    ].join("; "),
    "verify-docker-installer": [
      "$path = $env:SPACEAPP_DOCKER_INSTALLER_PATH",
      "if ([string]::IsNullOrWhiteSpace($path)) { exit 1 }",
      "$signature = Get-AuthenticodeSignature -LiteralPath $path",
      "if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Docker') { exit 1 }"
    ].join("; "),
    "install-docker-desktop": [
      "$path = $env:SPACEAPP_DOCKER_INSTALLER_PATH",
      "if ([string]::IsNullOrWhiteSpace($path)) { exit 1 }",
      "$process = Start-Process -FilePath $path -ArgumentList @('install','--user','--quiet','--accept-license') -Wait -PassThru",
      "exit $process.ExitCode"
    ].join("; "),
    "start-docker-desktop": [
      "Set-Service -Name 'com.docker.service' -StartupType Automatic -ErrorAction SilentlyContinue",
      "Start-Service -Name 'com.docker.service' -ErrorAction SilentlyContinue",
      "$path = $env:SPACEAPP_DOCKER_DESKTOP_PATH",
      "if ([string]::IsNullOrWhiteSpace($path)) { exit 1 }",
      "Start-Process -FilePath $path"
    ].join("; "),
    "open-spaceapp-browser": [
      "$ErrorActionPreference = 'Stop'",
      "$url = $env:SPACEAPP_OPEN_URL",
      "$uri = $null",
      "if ([string]::IsNullOrWhiteSpace($url) -or -not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri)) { exit 1 }",
      "if ($uri.Scheme -ne 'http' -or @('127.0.0.1','0.0.0.0') -notcontains $uri.Host -or $uri.Port -lt 1024 -or $uri.Port -gt 65535) { exit 1 }",
      "$roots = @([Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), [Environment]::GetEnvironmentVariable('ProgramFiles'), [Environment]::GetEnvironmentVariable('LOCALAPPDATA')) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }",
      "$edge = $roots | ForEach-Object { Join-Path $_ 'Microsoft\\Edge\\Application\\msedge.exe' } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1",
      "if ($edge) { Start-Process -FilePath $edge -ArgumentList @('--no-first-run','--no-default-browser-check',$url); exit 0 }",
      "Start-Process -FilePath 'explorer.exe' -ArgumentList @($url)"
    ].join("; ")
  };
  if (!Object.hasOwn(scripts, operation)) {
    throw new Error("SpaceApp refused an untrusted PowerShell operation.");
  }
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", scripts[operation]];
}

export async function prepareDockerCliPath({
  platform = process.platform,
  env = process.env,
  pathExists = fileExists
} = {}) {
  let directories = [];
  if (platform === "win32") {
    directories = windowsDockerPaths(env).cliDirectories;
  } else if (platform === "darwin") {
    directories = ["/Applications/Docker.app/Contents/Resources/bin"];
  } else {
    return null;
  }
  const directory = await firstExisting(directories, pathExists);
  if (!directory) {
    return null;
  }
  prependPath(env, directory, platform);
  return directory;
}

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
  installArgs,
  scheduleResume = scheduleWindowsInstallResume,
  confirmRestart = confirmWindowsRestart
}) {
  const requestedEngine = installArgs?.requestedEngine ?? installArgs?.engine;
  if (requestedEngine === "podman") {
    return ensurePodmanAvailable({
      platform,
      stdin,
      stdout,
      stderr,
      execute
    });
  }
  const dockerState = await checkDockerState(execute);
  if (dockerState.ready) {
    return { code: 0, reexecuted: false };
  }
  if (
    !requestedEngine &&
    platform !== "win32" &&
    dockerState.cliMissing &&
    (Boolean(stdin?.isTTY) || Boolean(installArgs?.offerPodmanFallback) || stdin?._spaceappPromptController?.answers?.engine !== undefined)
  ) {
    if (await podmanIsReady(execute, platform, { requireVersionOutput: !installArgs?.offerPodmanFallback })) {
      stdout.write("Docker Engine was not found, but Podman is ready on this host.\n");
      const usePodman = await confirmPodmanFallback({ stdin, stdout });
      if (usePodman) {
        stdout.write("Using Podman as the container engine.\n");
        return { code: 0, reexecuted: false, engine: "podman" };
      }
    }
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
      sleep,
      installArgs,
      scheduleResume,
      confirmRestart
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
      sleep,
      installArgs
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
  sleep,
  installArgs,
  scheduleResume,
  confirmRestart
}) {
  const paths = windowsDockerPaths(env);
  let application = await firstExisting(paths.applications, pathExists);

  if (!application) {
    stdout.write("Docker Desktop is required and is not installed.\n");
    const accepted = await confirmDesktopInstall({
      platformName: "Windows",
      stdin,
      stdout,
      autoConfirm: Boolean(installArgs?.autoConfirm)
    });
    if (!accepted) {
      stderr.write("Docker Desktop installation was cancelled.\n");
      return { code: 1, reexecuted: false };
    }
  }

  let wslInstalledNow = false;
  const wslCode = await execute(
    { command: "wsl.exe", args: ["--version"] },
    { stdin, stdout: null, stderr: null }
  );
  if (wslCode !== 0) {
    stdout.write("Installing the Windows Subsystem for Linux 2 support required by Docker Desktop...\n");
    const installWslCode = await execute(
      {
        command: "powershell.exe",
        operation: "install-wsl"
      },
      { stdin, stdout, stderr }
    );
    if (installWslCode !== 0) {
      stderr.write(
        `Windows could not enable WSL2 automatically. Run "${UNIVERSAL_INSTALL_COMMAND}" from an Administrator Command Prompt, restart Windows if requested, and run it again.\n`
      );
      return { code: installWslCode, reexecuted: false };
    }
    wslInstalledNow = true;
  }

  const restartPendingCode = await execute(
    { command: "powershell.exe", operation: "windows-restart-pending" },
    { stdin, stdout: null, stderr: null }
  );
  if (wslInstalledNow || restartPendingCode === 0) {
    const scheduleCode = await scheduleResume({
      ...installArgs,
      execute,
      stdin,
      stdout,
      stderr
    });
    if (scheduleCode !== 0) {
      stderr.write(
        "Windows must restart to finish WSL2, but SpaceApp could not schedule automatic continuation.\n" +
        `Restart Windows, then run "${UNIVERSAL_INSTALL_COMMAND}" again.\n`
      );
      return { code: scheduleCode, reexecuted: false };
    }
    stdout.write(
      "Windows must restart to finish enabling WSL2.\n" +
      "SpaceApp is scheduled to resume automatically after you sign in.\n"
    );
    const restartNow = await confirmRestart({
      stdin,
      stdout,
      question: "Restart Windows in 15 seconds and continue SpaceApp after sign-in? [y/N] "
    });
    if (!restartNow) {
      stdout.write(
        "Restart Windows when ready. SpaceApp will resume automatically the next time you sign in.\n"
      );
      return { code: 0, reexecuted: true };
    }
    const restartCode = await execute(
      {
        command: "shutdown.exe",
        args: [
          "/r",
          "/t", "15",
          "/c", "SpaceApp will continue automatically after you sign in."
        ]
      },
      { stdin, stdout, stderr }
    );
    if (restartCode !== 0) {
      stderr.write(
        "Windows restart could not be scheduled. Restart Windows manually; SpaceApp will resume after sign-in.\n"
      );
      return { code: restartCode, reexecuted: false };
    }
    stdout.write(
      "Windows will restart in 15 seconds. Save your work; run \"shutdown /a\" to cancel the countdown.\n"
    );
    return { code: 0, reexecuted: true };
  }

  if (!application) {
    const wingetCode = await execute(
      { command: "winget.exe", args: ["--version"] },
      { stdin, stdout: null, stderr: null }
    );
    if (wingetCode === 0) {
      stdout.write(
        "Installing Docker Desktop through Windows Package Manager with manifest hash verification...\n"
      );
      const installCode = await execute(
        { command: "winget.exe", args: [...WINDOWS_DOCKER_WINGET_ARGS] },
        { stdin, stdout, stderr }
      );
      if (installCode === 0) {
        application = await firstExisting(paths.applications, pathExists);
        if (!application) {
          stderr.write(
            "Windows Package Manager reported success, but Docker Desktop could not be found.\n"
          );
          return { code: 1, reexecuted: false };
        }
      } else {
        stdout.write(
          "Windows Package Manager could not install Docker Desktop; trying Docker's signed direct installer...\n"
        );
      }
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
    const installerEnv = {
      SPACEAPP_DOCKER_INSTALLER_PATH: installer
    };
    try {
      stdout.write("Downloading Docker Desktop from Docker's official distribution service...\n");
      await download(downloadUrl, installer);
      const signatureCode = await execute({
        command: "powershell.exe",
        operation: "verify-docker-installer",
        env: installerEnv
      }, { stdin, stdout: null, stderr });
      if (signatureCode !== 0) {
        stderr.write("The Docker Desktop installer signature is not valid. Installation was stopped.\n");
        return { code: 1, reexecuted: false };
      }
      const installCode = await execute(
        {
          command: "powershell.exe",
          operation: "install-docker-desktop",
          env: installerEnv
        },
        { stdin, stdout, stderr }
      );
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

  await prepareDockerCliPath({ platform: "win32", env, pathExists });
  stdout.write(
    "Opening Docker Desktop for its first-run setup.\n" +
    "If Docker shows \"Welcome to Docker\", select \"Skip\" in the top-right (or sign in), and accept any remaining Docker prompt.\n" +
    "Keep this terminal open; SpaceApp will continue automatically when Docker is ready (up to 10 minutes).\n"
  );
  await execute(
    { command: "docker", args: ["desktop", "start", "--detach"] },
    { stdin, stdout: null, stderr: null }
  );
  const launchCode = await launch({
    operation: "start-docker-desktop",
    env: {
      SPACEAPP_DOCKER_DESKTOP_PATH: application
    }
  });
  if (launchCode !== 0) {
    stderr.write("Docker Desktop is installed, but SpaceApp could not start it.\n");
    return { code: launchCode, reexecuted: false };
  }
  if (await waitForDocker({ execute, sleep, attempts: 300 })) {
    stdout.write("Docker Desktop is ready.\n");
    return { code: 0, reexecuted: false };
  }
  stderr.write(
    `Docker Desktop did not become ready after 10 minutes. Open Docker Desktop and complete its first-run setup (select "Skip" on "Welcome to Docker" or sign in), restart Windows if requested, then run "${UNIVERSAL_INSTALL_COMMAND}" again.\n`
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
  sleep,
  installArgs
}) {
  const application = "/Applications/Docker.app";
  const cliDirectory = posix.join(application, "Contents", "Resources", "bin");
  let installed = await pathExists(application);

  if (!installed) {
    stdout.write("Docker Desktop is required and is not installed.\n");
    const accepted = await confirmDesktopInstall({
      platformName: "macOS",
      stdin,
      stdout,
      autoConfirm: Boolean(installArgs?.autoConfirm)
    });
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
        args: ["--verify", "--deep", "--strict", mountedApplication]
      }, { stdin, stdout: null, stderr: null });
      if (signatureCode !== 0) {
        stderr.write("The Docker Desktop application signature is not valid. Installation was stopped.\n");
        return { code: 1, reexecuted: false };
      }
      const gatekeeperCode = await execute({
        command: "spctl",
        args: ["--assess", "--type", "execute", "--verbose=4", mountedApplication]
      }, { stdin, stdout: null, stderr: null });
      if (gatekeeperCode !== 0) {
        stderr.write("macOS Gatekeeper did not accept Docker Desktop. Installation was stopped.\n");
        return { code: 1, reexecuted: false };
      }
      stdout.write("Docker Desktop signature and macOS trust verification passed.\n");
      stdout.write(
        "macOS administrator authorization is required to install Docker Desktop.\n" +
        "Enter the password for your Mac administrator account—not a Docker or SpaceApp password.\n" +
        "Characters are not displayed while you type. SpaceApp does not read, store, or log this password.\n"
      );
      const installCode = await execute({
        command: "sudo",
        args: [
          "-p",
          MAC_ADMIN_PASSWORD_PROMPT,
          installer,
          "--accept-license",
          `--user=${username}`
        ]
      }, { stdin, stdout, stderr });
      if (installCode !== 0) {
        stderr.write(
          "macOS authorization failed. Docker Desktop must be installed by a Mac administrator account.\n" +
          "Enter that account's password—not a Docker or SpaceApp password—and rerun the same SpaceApp install command.\n" +
          "No SpaceApp images were downloaded.\n"
        );
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

  await prepareDockerCliPath({ platform: "darwin", env, pathExists });
  const launchCode = await launch({ operation: "open-docker-desktop" });
  if (launchCode !== 0) {
    stderr.write("Docker Desktop is installed, but SpaceApp could not start it.\n");
    return { code: launchCode, reexecuted: false };
  }
  if (await waitForDocker({ execute, sleep, attempts: 300 })) {
    stdout.write("Docker Desktop is ready.\n");
    return { code: 0, reexecuted: false };
  }
  stderr.write(
    `Docker Desktop did not become ready after 10 minutes. Complete any Docker Desktop prompt, then run "${UNIVERSAL_INSTALL_COMMAND}" again.\n`
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
  sleep,
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
  if (await waitForDocker({ execute, sleep, attempts: 15 })) {
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
  stdout.write(
    [
      "Docker's official post-install flow uses the docker group.",
      "Membership grants root-level privileges on this host.",
      `Adding ${username} to the docker group automatically and continuing.`
    ].join("\n") + "\n"
  );
  const groupCode = await execute(
    { command: "sudo", args: ["usermod", "-aG", "docker", username] },
    { stdin, stdout, stderr }
  );
  if (groupCode !== 0) {
    stderr.write(`SpaceApp could not add ${username} to the docker group.\n`);
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

async function confirmDesktopInstall({ platformName, stdin, stdout, autoConfirm = false }) {
  if (autoConfirm) {
    stdout.write(`Installing Docker Desktop for ${platformName} automatically as approved in setup plan...\n`);
    return true;
  }
  return confirmQuestion({
    stdin,
    stdout,
    question:
      `Review the Docker Desktop terms at ${DOCKER_TERMS_URL}\n` +
      `Install Docker Desktop for ${platformName} and accept those terms? [y/N] `
  });
}

async function confirmWindowsRestart({ stdin, stdout, question }) {
  return confirmQuestion({ stdin, stdout, question });
}

async function confirmQuestion({ stdin, stdout, question, defaultYes = false }) {
  const readline = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  try {
    const answer = (await readline.question(question)).trim();
    if (answer === "") {
      return defaultYes;
    }
    return /^(?:y|yes|true|podman)$/i.test(answer);
  } catch {
    return false;
  } finally {
    readline.close();
  }
}

async function confirmPodmanFallback({ stdin, stdout }) {
  const prompt = "Use Podman instead of installing Docker? [Y/n] ";
  if (stdin?._spaceappPromptController) {
    const answer = String(await stdin._spaceappPromptController.readLine(prompt, {
      mask: false,
      answerKey: "engine",
      defaultValue: "y"
    })).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes" || answer === "true" || answer === "podman") {
      return true;
    }
    return false;
  }
  return confirmQuestion({ stdin, stdout, question: prompt, defaultYes: true });
}

async function captureOutput(execute, spec) {
  let output = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      if (output.length < 1024 * 1024) output += chunk.toString();
      callback();
    }
  });
  const code = await execute(spec, { stdout, stderr: null });
  return { code, output: output.trim() };
}

async function checkDockerState(execute) {
  if (await execute({ command: "docker", args: ["--version"] }, { stdout: null, stderr: null }) !== 0) {
    return { ready: false, cliMissing: true };
  }
  if (await execute({ command: "docker", args: ["compose", "version"] }, { stdout: null, stderr: null }) !== 0) {
    return { ready: false, cliMissing: false };
  }
  if (await execute({ command: "docker", args: ["info"] }, { stdout: null, stderr: null }) !== 0) {
    return { ready: false, cliMissing: false };
  }
  return { ready: true, cliMissing: false };
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
  return (await checkDockerState(execute)).ready;
}

export async function podmanIsReady(execute, platform = process.platform, { requireVersionOutput = false } = {}) {
  if (platform === "win32") {
    return false;
  }
  const versionProbe = await captureOutput(execute, { command: "podman", args: ["--version"] });
  if (versionProbe.code !== 0) {
    return false;
  }
  if (requireVersionOutput && !/\b(?:[5-9]|\d{2,})\.\d+/.test(versionProbe.output)) {
    return false;
  }
  if (await execute({ command: "podman", args: ["compose", "version"] }, { stdout: null, stderr: null }) !== 0) {
    return false;
  }
  const infoProbe = await captureOutput(execute, { command: "podman", args: ["info"] });
  if (infoProbe.code !== 0) {
    return false;
  }
  const info = parseEngineInfo({
    engine: "podman",
    versionOutput: versionProbe.output,
    infoOutput: infoProbe.output,
    platform
  });
  if (info.majorVersion !== null && info.majorVersion < 5) {
    return false;
  }
  if (platform === "linux" && info.cgroupVersion === "v1") {
    return false;
  }
  if (platform === "linux" && (!info.limitsDelegated.cpu || !info.limitsDelegated.memory)) {
    return false;
  }
  return true;
}

export async function ensurePodmanAvailable({
  platform = process.platform,
  stdin = process.stdin,
  stderr = process.stderr,
  execute
}) {
  if (platform === "win32") {
    stderr.write("Podman is not supported on Windows. Use --engine docker on Windows.\n");
    return { code: 1, reexecuted: false };
  }
  const versionProbe = await captureOutput(execute, { command: "podman", args: ["--version"] });
  if (versionProbe.code !== 0) {
    stderr.write(
      platform === "darwin"
        ? "Podman (>= 5) is required when using --engine podman, and podman was not found on PATH. Install Podman (`brew install podman`), run `podman machine init && podman machine start`, and rerun the command.\n"
        : "Podman (>= 5) is required when using --engine podman, and podman was not found on PATH. Install Podman 5.0 or newer with Compose support and rerun the command.\n"
    );
    return { code: versionProbe.code, reexecuted: false };
  }
  const composeCode = await execute(
    { command: "podman", args: ["compose", "version"] },
    { stdin, stdout: null, stderr: null }
  );
  if (composeCode !== 0) {
    stderr.write(
      "Podman Compose (`podman compose`) is required when using --engine podman. Install docker-compose v2 or podman-compose so `podman compose version` succeeds, then rerun the command.\n"
    );
    return { code: composeCode, reexecuted: false };
  }
  const infoProbe = await captureOutput(execute, { command: "podman", args: ["info"] });
  if (infoProbe.code !== 0) {
    stderr.write(
      platform === "darwin"
        ? "Podman is installed, but the Podman machine is not running or not reachable. Run `podman machine init && podman machine start` and rerun the command.\n"
        : "Podman is installed, but `podman info` failed. Verify rootless Podman (`subuid`/`subgid` and user runtime directory) and rerun the command.\n"
    );
    return { code: infoProbe.code, reexecuted: false };
  }
  const info = parseEngineInfo({
    engine: "podman",
    versionOutput: versionProbe.output,
    infoOutput: infoProbe.output,
    platform
  });
  if (info.majorVersion !== null && info.majorVersion < 5) {
    stderr.write(
      `Podman >= 5 is required (found ${info.version || "under 5.0"}). Upgrade Podman to 5.0 or newer and rerun the command.\n`
    );
    return { code: 1, reexecuted: false };
  }
  if (platform === "linux" && info.cgroupVersion === "v1") {
    stderr.write(
      "Rootless Podman on Linux requires cgroup v2, capability was reported as cgroup v1. Enable unified cgroup v2 hierarchy on the host and rerun the command.\n"
    );
    return { code: 1, reexecuted: false };
  }
  if (platform === "linux" && (!info.limitsDelegated.cpu || !info.limitsDelegated.memory)) {
    const missing = [!info.limitsDelegated.cpu && "cpu", !info.limitsDelegated.memory && "memory"].filter(Boolean).join(", ");
    stderr.write(
      `Rootless Podman requires cgroup v2 ${missing} controller delegation to enforce service limits. Delegate cpu and memory controllers via systemd user slice (\`Delegate=cpu cpuset io memory pids\`) and rerun the command.\n`
    );
    return { code: 1, reexecuted: false };
  }
  return { code: 0, reexecuted: false };
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
  const idFamily = new Set([
    id,
    ...String(release?.ID_LIKE || "").toLowerCase().split(/\s+/).filter(Boolean)
  ]);
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
    return installDnfDockerEngine({ id, stdin, stdout, stderr, execute, download });
  }
  if (
    idFamily.has("arch") ||
    idFamily.has("archlinux") ||
    idFamily.has("cachyos")
  ) {
    return installPacmanDockerEngine({ stdin, stdout, stderr, execute });
  }
  stderr.write(
    `Automatic Docker Engine installation is not yet supported for Linux distribution "${id || "unknown"}". ` +
    "Install Docker Engine and the Compose plugin from https://docs.docker.com/engine/install/ and rerun the same command.\n"
  );
  return 1;
}

function installPacmanDockerEngine({ stdin, stdout, stderr, execute }) {
  return execute(
    {
      command: "sudo",
      args: [
        "pacman",
        "-S",
        "--needed",
        "--noconfirm",
        "docker",
        "docker-compose"
      ]
    },
    { stdin, stdout, stderr }
  );
}

// Docker's repository signing keys (https://docs.docker.com/engine/install/): a downloaded key is trusted only when its
// primary key has the published fingerprint (review INT5-C-F14).
export const DOCKER_REPOSITORY_KEY_FINGERPRINTS = Object.freeze({
  apt: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88",
  rpm: "060A61C51B558A7F742B77AAC52FEB6B621E9F35"
});

/**
 * OpenPGP v4 fingerprints of every primary public-key packet in a file holding exactly one ASCII-armored key block
 * (RFC 4880 4.2 and 12.2), or null when the file is anything else. Subkeys need a binding signature by their primary key,
 * so the primary keys are the ones that can add trust; gpg and APT import every one of them (1.1.7 review).
 */
export function openPgpPrimaryFingerprints(armored) {
  const text = String(armored);
  if ((text.match(/-----BEGIN PGP PUBLIC KEY BLOCK-----/g) ?? []).length !== 1) return null;
  const lines = text.split(/\r?\n/);
  const begin = lines.findIndex((line) => line.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----"));
  let index = begin + 1;
  while (index < lines.length && lines[index].trim() !== "") index += 1;
  const body = [];
  for (index += 1; index < lines.length && !lines[index].startsWith("=") && !lines[index].startsWith("-----END"); index += 1) {
    body.push(lines[index].trim());
  }
  const bytes = Buffer.from(body.join(""), "base64");
  const fingerprints = [];
  let position = 0;
  while (position < bytes.length) {
    const header = bytes[position];
    if (!(header & 0x80)) return null;
    let tag;
    let length;
    let offset;
    if (header & 0x40) {
      tag = header & 0x3f;
      const first = bytes[position + 1];
      if (first === undefined) return null;
      if (first < 192) [length, offset] = [first, position + 2];
      else if (first < 224 && position + 2 < bytes.length) [length, offset] = [((first - 192) << 8) + bytes[position + 2] + 192, position + 3];
      else if (first === 255 && position + 6 <= bytes.length) [length, offset] = [bytes.readUInt32BE(position + 2), position + 6];
      else return null;
    } else {
      tag = (header >> 2) & 0x0f;
      const type = header & 0x03;
      if (type === 0 && position + 2 <= bytes.length) [length, offset] = [bytes[position + 1], position + 2];
      else if (type === 1 && position + 3 <= bytes.length) [length, offset] = [bytes.readUInt16BE(position + 1), position + 3];
      else if (type === 2 && position + 5 <= bytes.length) [length, offset] = [bytes.readUInt32BE(position + 1), position + 5];
      else return null;
    }
    if (offset + length > bytes.length) return null;
    if (tag === 6) {
      if (bytes[offset] !== 4 || length > 0xffff) return null;
      fingerprints.push(createHash("sha1")
        .update(Buffer.from([0x99, length >> 8, length & 0xff]))
        .update(bytes.subarray(offset, offset + length))
        .digest("hex")
        .toUpperCase());
    }
    position = offset + length;
  }
  return fingerprints.length ? fingerprints : null;
}

/** OpenPGP v4 fingerprint of the first primary key of an ASCII-armored key, or null. */
export function openPgpFingerprint(armored) {
  return openPgpPrimaryFingerprints(armored)?.[0] ?? null;
}

async function verifyDockerRepositoryKey(path, expected, stderr) {
  const fingerprints = openPgpPrimaryFingerprints(await readFile(path, "utf8").catch(() => ""));
  if (fingerprints?.length === 1 && fingerprints[0] === expected) return true;
  stderr.write(fingerprints?.includes(expected)
    ? `Docker's repository signing key file must hold only Docker's published key ${expected}; it also carries other keys. Installation was stopped.\n`
    : `Docker's repository signing key does not have its published fingerprint ${expected}. Installation was stopped.\n`);
  return false;
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
    if (!await verifyDockerRepositoryKey(signingKey, DOCKER_REPOSITORY_KEY_FINGERPRINTS.apt, stderr)) {
      return 1;
    }
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

export const DOCKER_DNF_KEY_PATH = "/etc/pki/rpm-gpg/spaceapp-docker-ce.asc";

/**
 * The Docker CE repository written locally: its packages are checked against the key whose fingerprint was verified,
 * so a tampered repository file or key URL at the download origin cannot add another key or host (1.1.7 review).
 */
export function dockerDnfRepository(id) {
  return [
    "[docker-ce-stable]",
    "name=Docker CE Stable - $basearch",
    `baseurl=https://download.docker.com/linux/${id}/$releasever/$basearch/stable`,
    "enabled=1",
    "gpgcheck=1",
    `gpgkey=file://${DOCKER_DNF_KEY_PATH}`,
    ""
  ].join("\n");
}

async function installDnfDockerEngine({ id, stdin, stdout, stderr, execute, download }) {
  const keyRoot = await mkdtemp(join(tmpdir(), "spaceapp-docker-"));
  try {
    const signingKey = join(keyRoot, "docker.asc");
    await download(`https://download.docker.com/linux/${id}/gpg`, signingKey);
    if (!await verifyDockerRepositoryKey(signingKey, DOCKER_REPOSITORY_KEY_FINGERPRINTS.rpm, stderr)) {
      return 1;
    }
    const repositoryFile = join(keyRoot, "docker-ce.repo");
    await writeFile(repositoryFile, dockerDnfRepository(id));
    for (const args of [
      ["install", "-D", "-m", "0644", signingKey, DOCKER_DNF_KEY_PATH],
      ["rpm", "--import", DOCKER_DNF_KEY_PATH],
      ["install", "-D", "-m", "0644", repositoryFile, "/etc/yum.repos.d/docker-ce.repo"]
    ]) {
      const code = await execute({ command: "sudo", args }, { stdin, stdout, stderr });
      if (code !== 0) return code;
    }
  } finally {
    await rm(keyRoot, { recursive: true, force: true });
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

function linuxReentryCommand({
  requestedProfile = "auto",
  requestedAccessMode,
  noOpen = false
} = {}) {
  if (!["auto", "small", "medium", "large", "light", "standard"].includes(requestedProfile)) {
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
    ...installAccessArgs(requestedAccessMode, "Docker group re-entry"),
    ...(noOpen ? ["--no-open"] : [])
  ].map(shellQuote).join(" ");
}

export function windowsResumeScript({
  executable = process.execPath,
  entrypoint = fileURLToPath(new URL("../bin/spaceapp.mjs", import.meta.url)),
  requestedProfile = "auto",
  requestedAccessMode,
  noOpen = false
} = {}) {
  if (!["auto", "small", "medium", "large", "light", "standard"].includes(requestedProfile)) {
    throw new Error("Invalid SpaceApp profile for Windows resume.");
  }
  if (typeof noOpen !== "boolean") {
    throw new Error("Invalid SpaceApp browser option for Windows resume.");
  }
  for (const [name, value] of [["executable", executable], ["entrypoint", entrypoint]]) {
    if (
      typeof value !== "string" ||
      !win32.isAbsolute(value) ||
      /["\r\n%]/.test(value)
    ) {
      throw new Error(`Invalid SpaceApp Windows resume ${name}.`);
    }
  }
  const command = [
    windowsBatchQuote(executable),
    windowsBatchQuote(entrypoint),
    "install",
    "--profile",
    requestedProfile,
    ...installAccessArgs(requestedAccessMode, "Windows resume"),
    ...(noOpen ? ["--no-open"] : [])
  ].join(" ");
  return [
    "@echo off",
    "setlocal",
    command,
    'set "SPACEAPP_RESUME_EXIT=%ERRORLEVEL%"',
    'if "%SPACEAPP_RESUME_EXIT%"=="0" del /f /q "%~f0"',
    'if not "%SPACEAPP_RESUME_EXIT%"=="0" echo SpaceApp setup needs attention. Review the error above, then run this file again.',
    "exit /b %SPACEAPP_RESUME_EXIT%",
    ""
  ].join("\r\n");
}

async function scheduleWindowsInstallResume({
  root,
  requestedProfile = "auto",
  requestedAccessMode,
  noOpen = false,
  execute,
  stdin,
  stdout,
  stderr
} = {}) {
  if (
    typeof root !== "string" ||
    !win32.isAbsolute(root) ||
    /["\r\n%]/.test(root)
  ) {
    stderr?.write("SpaceApp could not determine a safe Windows resume path.\n");
    return 1;
  }
  const resumePath = win32.join(root, "resume-install.cmd");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    resumePath,
    windowsResumeScript({ requestedProfile, requestedAccessMode, noOpen }),
    { encoding: "utf8", mode: 0o600 }
  );
  const code = await execute(
    {
      command: "powershell.exe",
      operation: "register-spaceapp-resume",
      env: { SPACEAPP_RESUME_SCRIPT_PATH: resumePath }
    },
    { stdin, stdout: null, stderr }
  );
  if (code !== 0) {
    await rm(resumePath, { force: true });
  }
  return code;
}

function installAccessArgs(requestedAccessMode, context) {
  if (requestedAccessMode === undefined) {
    return [];
  }
  if (requestedAccessMode === "isolated" || requestedAccessMode === "host-root") {
    return ["--access", requestedAccessMode];
  }
  throw new Error(`Invalid SpaceApp access mode for ${context}.`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function windowsBatchQuote(value) {
  return `"${String(value)}"`;
}

async function waitForDocker({ execute, sleep, attempts = 90 }) {
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    if (await dockerIsReady(execute)) {
      return true;
    }
    if (attempt < attempts) {
      await sleep(2_000);
    }
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

function prependPath(env, directory, platform = process.platform) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const pathDelimiter = platform === "win32" ? win32.delimiter : posix.delimiter;
  const entries = String(env[pathKey] || "").split(pathDelimiter).filter(Boolean);
  if (!entries.includes(directory)) {
    env[pathKey] = [directory, ...entries].join(pathDelimiter);
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
    const options = {
      detached: true,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      shell: false,
      stdio: "ignore"
    };
    let child;
    try {
      if (spec.operation === "start-docker-desktop") {
        child = spawn("powershell.exe", windowsPowerShellArgs(spec.operation), options);
      } else if (spec.operation === "open-docker-desktop") {
        child = spawn("open", ["-a", "/Applications/Docker.app"], options);
      } else {
        resolve(1);
        return;
      }
    } catch {
      resolve(1);
      return;
    }
    child.once("error", () => resolve(1));
    child.once("spawn", () => {
      // macOS open exits after Launch Services accepts or rejects the launch.
      // Spawning the utility alone is not evidence that it opened Docker.
      if (spec.operation === "open-docker-desktop") return;
      child.unref();
      resolve(0);
    });
    if (spec.operation === "open-docker-desktop") {
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    }
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
