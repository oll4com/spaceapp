import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import {
  downloadFile,
  ensureDockerAvailable,
  prepareDockerCliPath,
  windowsResumeScript,
  windowsPowerShellArgs
} from "../src/prerequisites.mjs";

function capture() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    }
  });
  return { stream, value: () => value };
}

test("Windows PowerShell operations use fixed scripts and reject arbitrary commands", () => {
  const operations = [
    "install-wsl",
    "windows-wsl-ready",
    "windows-restart-pending",
    "register-spaceapp-resume",
    "verify-docker-installer",
    "install-docker-desktop",
    "start-docker-desktop"
  ];

  for (const operation of operations) {
    const args = windowsPowerShellArgs(operation);
    assert.deepEqual(args.slice(0, 4), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command"
    ]);
    assert.equal(typeof args[4], "string");
  }
  assert.throws(
    () => windowsPowerShellArgs("Write-Output untrusted"),
    /untrusted PowerShell operation/
  );
});

test("Windows WSL readiness and restart probes are valid non-admin PowerShell statements", () => {
  const readinessScript = windowsPowerShellArgs("windows-wsl-ready")[4];
  const restartScript = windowsPowerShellArgs("windows-restart-pending")[4];

  assert.match(readinessScript, /Get-CimInstance/);
  assert.doesNotMatch(readinessScript, /Get-WindowsOptionalFeature/);
  assert.match(restartScript, /;\s*if \(\$pending\)/);
  assert.doesNotMatch(restartScript, /\)\s+if \(\$pending\)/);
});

test("Windows resume uses the same pinned launcher entrypoint and validated install options", () => {
  const script = windowsResumeScript({
    executable: "C:\\Program Files\\nodejs\\node.exe",
    entrypoint: "C:\\Users\\Admin\\AppData\\Local\\npm-cache\\spaceapp.mjs",
    requestedProfile: "light",
    noOpen: true
  });

  assert.match(
    script,
    /"C:\\Program Files\\nodejs\\node\.exe" "C:\\Users\\Admin\\AppData\\Local\\npm-cache\\spaceapp\.mjs" install --profile light --no-open/
  );
  assert.match(script, /SPACEAPP_RESUME_EXIT/);
  assert.match(script, /del \/f \/q "%~f0"/);
  assert.doesNotMatch(script, /\bnpx(?:\.cmd)?\b/i);
  assert.throws(
    () => windowsResumeScript({
      executable: "C:\\Program Files\\nodejs\\node.exe",
      entrypoint: "C:\\spaceapp.mjs",
      requestedProfile: "unsafe & whoami",
      noOpen: false
    }),
    /profile/i
  );
});

test("Docker Desktop CLI discovery is prepared on every supported desktop platform", async () => {
  const windowsEnv = {
    LOCALAPPDATA: "C:\\Users\\Admin\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    Path: "C:\\Windows\\System32"
  };
  const windowsDirectory = "C:\\Program Files\\Docker\\Docker\\resources\\bin";
  assert.equal(await prepareDockerCliPath({
    platform: "win32",
    env: windowsEnv,
    pathExists: async (path) => path === windowsDirectory
  }), windowsDirectory);
  assert.equal(windowsEnv.Path, `${windowsDirectory};C:\\Windows\\System32`);

  const macEnv = { PATH: "/usr/bin:/bin" };
  const macDirectory = "/Applications/Docker.app/Contents/Resources/bin";
  assert.equal(await prepareDockerCliPath({
    platform: "darwin",
    env: macEnv,
    pathExists: async (path) => path === macDirectory
  }), macDirectory);
  assert.equal(macEnv.PATH, `${macDirectory}:/usr/bin:/bin`);

  const linuxEnv = { PATH: "/usr/bin:/bin" };
  assert.equal(await prepareDockerCliPath({
    platform: "linux",
    env: linuxEnv,
    pathExists: async () => true
  }), null);
  assert.equal(linuxEnv.PATH, "/usr/bin:/bin");
});

test("Windows with ready WSL2 installs signed Docker Desktop and continues in one command", async () => {
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const downloads = [];
  const launches = [];
  let installed = false;
  let launched = false;
  let wslChecks = 0;

  const result = await ensureDockerAvailable({
    platform: "win32",
    arch: "x64",
    env: {
      LOCALAPPDATA: "C:\\Users\\Admin\\AppData\\Local",
      Path: "C:\\Windows\\System32"
    },
    stdin: Readable.from(["y\n"]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec) => {
      calls.push(spec);
      if (spec.command === "docker") {
        return installed && launched ? 0 : 127;
      }
      if (spec.command === "wsl.exe") {
        wslChecks += 1;
        return 0;
      }
      if (spec.command === "winget.exe") {
        return 127;
      }
      if (spec.command === "powershell.exe") {
        if (spec.operation === "windows-wsl-ready") {
          return 0;
        }
        if (
          spec.operation === "verify-docker-installer" &&
          spec.env?.SPACEAPP_DOCKER_INSTALLER_PATH?.endsWith("Docker Desktop Installer.exe")
        ) {
          return 0;
        }
        if (
          spec.operation === "install-docker-desktop" &&
          spec.env?.SPACEAPP_DOCKER_INSTALLER_PATH?.endsWith("Docker Desktop Installer.exe")
        ) {
          installed = true;
          return 0;
        }
        return 1;
      }
      return 0;
    },
    download: async (url, target) => {
      downloads.push({ url, target });
    },
    launch: async (spec) => {
      launches.push(spec);
      launched = true;
      return 0;
    },
    pathExists: async (path) => installed && path.endsWith("Docker Desktop.exe"),
    sleep: async () => {}
  });

  assert.deepEqual(result, { code: 0, reexecuted: false });
  assert.equal(wslChecks, 1);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].url, /^https:\/\/desktop\.docker\.com\/win\/main\/amd64\//);
  assert.ok(calls.some((spec) =>
    spec.command === "powershell.exe" &&
    spec.operation === "verify-docker-installer" &&
    spec.args === undefined
  ));
  assert.equal(
    calls.some((spec) =>
      spec.command === "powershell.exe" &&
      spec.operation === "install-wsl"
    ),
    false
  );
  assert.ok(calls.some((spec) =>
    spec.command === "powershell.exe" &&
    spec.operation === "install-docker-desktop" &&
    spec.args === undefined &&
    spec.env?.SPACEAPP_DOCKER_INSTALLER_PATH.endsWith("Docker Desktop Installer.exe")
  ));
  assert.deepEqual(launches, [{
    operation: "start-docker-desktop",
    env: {
      SPACEAPP_DOCKER_DESKTOP_PATH: "C:\\Users\\Admin\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe"
    }
  }]);
  assert.match(stdout.value(), /Docker Desktop is required/i);
  assert.match(stdout.value(), /Docker Desktop is ready/i);
  assert.equal(stderr.value(), "");
});

test("Windows schedules the same install to resume after the WSL2 restart", async () => {
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const scheduled = [];
  let wslChecks = 0;
  let downloaded = false;

  const result = await ensureDockerAvailable({
    platform: "win32",
    arch: "x64",
    env: {
      LOCALAPPDATA: "C:\\Users\\Admin\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
      Path: "C:\\Windows\\System32"
    },
    stdin: Readable.from(["y\n"]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec) => {
      calls.push(spec);
      if (spec.command === "docker") return 127;
      if (spec.command === "wsl.exe") {
        wslChecks += 1;
        return wslChecks === 1 ? 1 : 0;
      }
      if (spec.command === "powershell.exe" && spec.operation === "install-wsl") {
        return 0;
      }
      if (spec.command === "powershell.exe" && spec.operation === "windows-wsl-ready") {
        return 1;
      }
      if (spec.command === "powershell.exe" && spec.operation === "windows-restart-pending") {
        return 0;
      }
      if (spec.command === "shutdown.exe") return 0;
      return 127;
    },
    download: async () => {
      downloaded = true;
    },
    launch: async () => 0,
    pathExists: async () => false,
    sleep: async () => {},
    installArgs: {
      root: "C:\\Users\\Admin\\AppData\\Roaming\\SpaceApp",
      requestedProfile: "light",
      noOpen: true
    },
    scheduleResume: async (options) => {
      scheduled.push(options);
      return 0;
    },
    confirmRestart: async () => true
  });

  assert.deepEqual(result, { code: 0, reexecuted: true });
  assert.equal(downloaded, false);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].root, "C:\\Users\\Admin\\AppData\\Roaming\\SpaceApp");
  assert.equal(scheduled[0].requestedProfile, "light");
  assert.equal(scheduled[0].noOpen, true);
  assert.ok(calls.some((spec) =>
    spec.command === "powershell.exe" &&
    spec.operation === "windows-wsl-ready"
  ));
  assert.ok(calls.some((spec) =>
    spec.command === "powershell.exe" &&
    spec.operation === "windows-restart-pending"
  ));
  assert.ok(calls.some((spec) =>
    spec.command === "shutdown.exe" &&
    spec.args.join(" ") ===
      '/r /t 15 /c SpaceApp will continue automatically after you sign in.'
  ));
  assert.match(stdout.value(), /resume automatically after you sign in/i);
  assert.equal(stderr.value(), "");
});

test("Windows prefers hash-verified winget Docker Desktop installation over the direct downloader", async () => {
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  let downloaded = false;
  let installed = false;
  let launched = false;

  const result = await ensureDockerAvailable({
    platform: "win32",
    arch: "x64",
    env: {
      LOCALAPPDATA: "C:\\Users\\Admin\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
      Path: "C:\\Windows\\System32"
    },
    stdin: Readable.from(["y\n"]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec) => {
      calls.push(spec);
      if (spec.command === "docker") {
        return installed && launched ? 0 : 127;
      }
      if (spec.command === "wsl.exe") {
        return 0;
      }
      if (spec.command === "powershell.exe" && spec.operation === "windows-wsl-ready") {
        return 0;
      }
      if (spec.command === "winget.exe" && spec.args[0] === "--version") {
        return 0;
      }
      if (spec.command === "winget.exe" && spec.args[0] === "install") {
        installed = true;
        return 0;
      }
      return 1;
    },
    download: async () => {
      downloaded = true;
    },
    launch: async () => {
      launched = true;
      return 0;
    },
    pathExists: async (path) => installed && path.endsWith("Docker Desktop.exe"),
    sleep: async () => {}
  });

  assert.deepEqual(result, { code: 0, reexecuted: false });
  assert.equal(downloaded, false);
  assert.ok(calls.some((spec) =>
    spec.command === "winget.exe" &&
    spec.args.join(" ") === [
      "install",
      "--id", "Docker.DockerDesktop",
      "--exact",
      "--source", "winget",
      "--silent",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity"
    ].join(" ")
  ));
  assert.equal(
    calls.some((spec) =>
      spec.command === "powershell.exe" &&
      spec.operation === "verify-docker-installer"
    ),
    false
  );
  assert.match(stdout.value(), /Windows Package Manager/i);
  assert.equal(stderr.value(), "");
});

test("Windows explains first-run Docker onboarding and continues when the user finishes it", async () => {
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  let dockerInfoChecks = 0;
  let sleepCalls = 0;

  const result = await ensureDockerAvailable({
    platform: "win32",
    arch: "x64",
    env: {
      LOCALAPPDATA: "C:\\Users\\Admin\\AppData\\Local",
      Path: "C:\\Windows\\System32"
    },
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec) => {
      calls.push(spec);
      if (spec.command === "docker" && spec.args[0] === "info") {
        dockerInfoChecks += 1;
        return dockerInfoChecks >= 302 ? 0 : 127;
      }
      if (spec.command === "docker") return 0;
      if (spec.command === "wsl.exe") return 0;
      return 0;
    },
    launch: async () => 0,
    pathExists: async (path) =>
      path.endsWith("Docker Desktop.exe") ||
      path.endsWith("resources\\bin"),
    sleep: async () => {
      sleepCalls += 1;
    }
  });

  assert.deepEqual(result, { code: 0, reexecuted: false });
  assert.equal(sleepCalls, 300);
  assert.ok(calls.some((spec) =>
    spec.command === "docker" &&
    spec.args.join(" ") === "desktop start --detach"
  ));
  assert.match(stdout.value(), /Welcome to Docker/i);
  assert.match(stdout.value(), /Skip/i);
  assert.match(stdout.value(), /continue automatically/i);
  assert.match(stdout.value(), /Docker Desktop is ready/i);
  assert.equal(stderr.value(), "");
});

test("Windows bounds the first-run Docker onboarding wait at ten minutes", async () => {
  const stderr = capture();
  let sleepCalls = 0;

  const result = await ensureDockerAvailable({
    platform: "win32",
    arch: "x64",
    env: {
      LOCALAPPDATA: "C:\\Users\\Admin\\AppData\\Local",
      Path: "C:\\Windows\\System32"
    },
    stdin: Readable.from([]),
    stdout: capture().stream,
    stderr: stderr.stream,
    execute: async (spec) => {
      if (spec.command === "wsl.exe") return 0;
      if (spec.command === "powershell.exe" && spec.operation === "windows-wsl-ready") {
        return 0;
      }
      return 127;
    },
    launch: async () => 0,
    pathExists: async (path) =>
      path.endsWith("Docker Desktop.exe") ||
      path.endsWith("resources\\bin"),
    sleep: async () => {
      sleepCalls += 1;
    }
  });

  assert.deepEqual(result, { code: 1, reexecuted: false });
  assert.equal(sleepCalls, 300);
  assert.match(stderr.value(), /first-run setup/i);
});

test("Windows does not install Docker Desktop when its license is declined", async () => {
  let downloaded = false;
  const result = await ensureDockerAvailable({
    platform: "win32",
    arch: "x64",
    env: { LOCALAPPDATA: "C:\\Users\\Admin\\AppData\\Local" },
    stdin: Readable.from(["n\n"]),
    stdout: capture().stream,
    stderr: capture().stream,
    execute: async (spec) => spec.command === "docker" ? 127 : 0,
    download: async () => {
      downloaded = true;
    },
    launch: async () => 0,
    pathExists: async () => false,
    sleep: async () => {}
  });

  assert.deepEqual(result, { code: 1, reexecuted: false });
  assert.equal(downloaded, false);
});

test("Windows stops when virtualization is unavailable without a pending restart", async () => {
  const calls = [];
  const stderr = capture();
  let downloaded = false;
  let wslChecks = 0;

  const result = await ensureDockerAvailable({
    platform: "win32",
    arch: "x64",
    env: { LOCALAPPDATA: "C:\\Users\\Admin\\AppData\\Local" },
    stdin: Readable.from(["y\n"]),
    stdout: capture().stream,
    stderr: stderr.stream,
    execute: async (spec) => {
      calls.push(spec);
      if (spec.command === "docker") return 127;
      if (spec.command === "wsl.exe") {
        wslChecks += 1;
        return 0;
      }
      if (spec.command === "powershell.exe" && spec.operation === "windows-wsl-ready") {
        return 1;
      }
      if (spec.command === "powershell.exe" && spec.operation === "windows-restart-pending") {
        return 1;
      }
      return 0;
    },
    download: async () => {
      downloaded = true;
    },
    launch: async () => 0,
    pathExists: async () => false,
    sleep: async () => {}
  });

  assert.deepEqual(result, { code: 1, reexecuted: false });
  assert.equal(wslChecks, 1);
  assert.equal(downloaded, false);
  assert.equal(
    calls.some((spec) =>
      spec.command === "powershell.exe" &&
      spec.operation === "install-wsl"
    ),
    false
  );
  assert.match(stderr.value(), /virtualization is unavailable/i);
});

test("macOS installs the official signed Docker Desktop image and starts it", async () => {
  const calls = [];
  const downloads = [];
  let installed = false;
  let launched = false;

  const result = await ensureDockerAvailable({
    platform: "darwin",
    arch: "arm64",
    env: { USER: "space-user", PATH: "/usr/bin:/bin" },
    stdin: Readable.from(["yes\n"]),
    stdout: capture().stream,
    stderr: capture().stream,
    execute: async (spec) => {
      calls.push(spec);
      if (spec.command === "docker") return installed && launched ? 0 : 127;
      if (
        spec.command === "sudo" &&
        spec.args[0].endsWith("/Contents/MacOS/install")
      ) {
        installed = true;
      }
      return 0;
    },
    download: async (url, target) => {
      downloads.push({ url, target });
    },
    launch: async (spec) => {
      calls.push(spec);
      launched = true;
      return 0;
    },
    pathExists: async (path) => installed && path === "/Applications/Docker.app",
    sleep: async () => {}
  });

  assert.deepEqual(result, { code: 0, reexecuted: false });
  assert.match(downloads[0].url, /^https:\/\/desktop\.docker\.com\/mac\/main\/arm64\//);
  assert.ok(calls.some((spec) => spec.command === "codesign" && spec.args.includes("--strict")));
  assert.ok(calls.some((spec) =>
    spec.command === "spctl" &&
    spec.args.join(" ") === "--assess --type execute --verbose=4 /Volumes/Docker/Docker.app"
  ));
  assert.ok(calls.some((spec) =>
    spec.command === "sudo" &&
    spec.args[0].endsWith("/Contents/MacOS/install") &&
    spec.args.includes("--accept-license") &&
    spec.args.includes("--user=space-user")
  ));
  assert.ok(calls.some((spec) =>
    spec.operation === "open-docker-desktop"
  ));
});

test("Ubuntu installs Docker Engine from Docker's official repository and re-enters the docker group", async () => {
  const calls = [];
  let serviceStarted = false;

  const result = await ensureDockerAvailable({
    platform: "linux",
    arch: "x64",
    env: { USER: "spaceuser", PATH: "/usr/bin:/bin" },
    stdin: Readable.from(["yes\n"]),
    stdout: capture().stream,
    stderr: capture().stream,
    execute: async (spec) => {
      calls.push(spec);
      if (spec.command === "docker") return serviceStarted ? 1 : 127;
      if (spec.command === "sudo" && spec.args.includes("systemctl")) {
        serviceStarted = true;
      }
      if (spec.command === "sg") return 0;
      return 0;
    },
    download: async () => {},
    launch: async () => 0,
    pathExists: async () => true,
    sleep: async () => {},
    osRelease: {
      ID: "ubuntu",
      VERSION_CODENAME: "noble"
    },
    installArgs: {
      requestedProfile: "auto",
      noOpen: false
    }
  });

  assert.deepEqual(result, { code: 0, reexecuted: true });
  assert.ok(calls.some((spec) =>
    spec.command === "sudo" &&
    spec.args.join(" ") === "apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
  ));
  assert.ok(calls.some((spec) =>
    spec.command === "sudo" &&
    spec.args.join(" ") === "usermod -aG docker spaceuser"
  ));
  assert.ok(calls.some((spec) =>
    spec.command === "sg" &&
    spec.args[0] === "docker" &&
    spec.args[1] === "-c" &&
    spec.args[2].includes("SPACEAPP_PREREQUISITES_BOOTSTRAPPED=1") &&
    spec.args[2].includes("'install' '--profile' 'auto'")
  ));
});

test("Fedora uses Docker's official DNF repository and starts the engine", async () => {
  const calls = [];
  let serviceStarted = false;

  const result = await ensureDockerAvailable({
    platform: "linux",
    arch: "x64",
    env: { USER: "spaceuser" },
    stdin: Readable.from([]),
    stdout: capture().stream,
    stderr: capture().stream,
    execute: async (spec) => {
      calls.push(spec);
      if (spec.command === "docker") return serviceStarted ? 0 : 127;
      if (spec.command === "sudo" && spec.args.includes("systemctl")) {
        serviceStarted = true;
      }
      return 0;
    },
    download: async () => {},
    launch: async () => 0,
    pathExists: async () => true,
    sleep: async () => {},
    osRelease: { ID: "fedora", VERSION_ID: "42" },
    installArgs: { requestedProfile: "auto", noOpen: true }
  });

  assert.deepEqual(result, { code: 0, reexecuted: false });
  assert.ok(calls.some((spec) =>
    spec.command === "sudo" &&
    spec.args.join(" ") ===
      "dnf config-manager addrepo --from-repofile https://download.docker.com/linux/fedora/docker-ce.repo"
  ));
  assert.ok(calls.some((spec) =>
    spec.command === "sudo" &&
    spec.args.join(" ") ===
      "dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
  ));
});

test("Fedora falls back to the DNF4 repository command when DNF5 syntax is unavailable", async () => {
  const calls = [];
  let serviceStarted = false;

  const result = await ensureDockerAvailable({
    platform: "linux",
    arch: "x64",
    env: { USER: "spaceuser" },
    stdin: Readable.from([]),
    stdout: capture().stream,
    stderr: capture().stream,
    execute: async (spec) => {
      calls.push(spec);
      if (spec.command === "docker") return serviceStarted ? 0 : 127;
      if (
        spec.command === "sudo" &&
        spec.args.join(" ").startsWith("dnf config-manager addrepo")
      ) {
        return 1;
      }
      if (spec.command === "sudo" && spec.args.includes("systemctl")) {
        serviceStarted = true;
      }
      return 0;
    },
    download: async () => {},
    launch: async () => 0,
    pathExists: async () => true,
    sleep: async () => {},
    osRelease: { ID: "fedora", VERSION_ID: "40" },
    installArgs: { requestedProfile: "auto", noOpen: true }
  });

  assert.deepEqual(result, { code: 0, reexecuted: false });
  assert.ok(calls.some((spec) =>
    spec.command === "sudo" &&
    spec.args.join(" ") ===
      "dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo"
  ));
});

test("Linux rejects an unsafe username before granting docker-group access", async () => {
  const calls = [];
  const stderr = capture();

  const result = await ensureDockerAvailable({
    platform: "linux",
    arch: "x64",
    env: { USER: "user;touch-pwned" },
    stdin: Readable.from([]),
    stdout: capture().stream,
    stderr: stderr.stream,
    execute: async (spec) => {
      calls.push(spec);
      if (spec.command === "docker" && spec.args.includes("info")) return 1;
      return 0;
    },
    download: async () => {},
    launch: async () => 0,
    pathExists: async () => true,
    sleep: async () => {},
    installArgs: { requestedProfile: "auto", noOpen: true }
  });

  assert.deepEqual(result, { code: 1, reexecuted: false });
  assert.equal(calls.some((spec) => spec.args?.includes("user;touch-pwned")), false);
  assert.equal(calls.some((spec) => spec.command === "sg"), false);
  assert.match(stderr.value(), /valid non-root Linux username/i);
});

test("Docker downloads abort after a bounded timeout", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason);
    }, { once: true });
  });

  await assert.rejects(
    downloadFile("https://desktop.docker.com/example", "/tmp/unused-spaceapp-download", {
      timeoutMs: 5
    }),
    /timed out/i
  );
});
