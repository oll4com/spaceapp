import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import {
  downloadFile,
  ensureDockerAvailable
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

test("Windows enables WSL2, installs signed Docker Desktop, and continues in one command", async () => {
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
        return wslChecks === 1 ? 1 : 0;
      }
      if (spec.command === "powershell.exe") {
        const command = spec.args.at(-1);
        if (command?.includes("wsl.exe") && command.includes("-Verb RunAs")) {
          return 0;
        }
        if (
          command?.includes("Get-AuthenticodeSignature") &&
          spec.env?.SPACEAPP_DOCKER_INSTALLER_PATH?.endsWith("Docker Desktop Installer.exe")
        ) {
          return 0;
        }
        if (
          command?.includes("Start-Process -FilePath $path") &&
          command.includes("@('install','--user','--quiet','--accept-license')") &&
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
  assert.equal(wslChecks, 2);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].url, /^https:\/\/desktop\.docker\.com\/win\/main\/amd64\//);
  assert.ok(calls.some((spec) =>
    spec.command === "powershell.exe" &&
    spec.args.join(" ").includes("Get-AuthenticodeSignature")
  ));
  assert.ok(calls.some((spec) =>
    spec.command === "powershell.exe" &&
    spec.args.join(" ").includes("Start-Process") &&
    spec.args.join(" ").includes("-Verb RunAs")
  ));
  assert.ok(calls.some((spec) =>
    spec.command === "powershell.exe" &&
    spec.args.join(" ").includes("Start-Process") &&
    spec.args.at(-1).includes("@('install','--user','--quiet','--accept-license')") &&
    spec.env?.SPACEAPP_DOCKER_INSTALLER_PATH.endsWith("Docker Desktop Installer.exe")
  ));
  assert.deepEqual(launches, [{
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$path = $env:SPACEAPP_DOCKER_DESKTOP_PATH; if ([string]::IsNullOrWhiteSpace($path)) { exit 1 }; Start-Process -FilePath $path"
    ],
    env: {
      SPACEAPP_DOCKER_DESKTOP_PATH: "C:\\Users\\Admin\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe"
    }
  }]);
  assert.match(stdout.value(), /Docker Desktop is required/i);
  assert.match(stdout.value(), /Docker Desktop is ready/i);
  assert.equal(stderr.value(), "");
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

test("Windows elevates WSL2 setup and stops for a required restart before downloading Docker", async () => {
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
        return 1;
      }
      if (spec.command === "powershell.exe") return 0;
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
  assert.equal(wslChecks, 2);
  assert.equal(downloaded, false);
  assert.ok(calls.some((spec) =>
    spec.command === "powershell.exe" &&
    spec.args.join(" ").includes("Start-Process") &&
    spec.args.join(" ").includes("--install") &&
    spec.args.join(" ").includes("--no-distribution") &&
    spec.args.join(" ").includes("-Verb RunAs") &&
    spec.args.join(" ").includes("$ErrorActionPreference = 'Stop'") &&
    spec.args.join(" ").includes("catch { exit 1 }") &&
    spec.args.join(" ").includes("; exit $process.ExitCode")
  ));
  assert.match(stderr.value(), /restart Windows/i);
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
    spec.command === "open" &&
    spec.args.join(" ") === "-a Docker"
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
