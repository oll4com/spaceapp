import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { ensureDockerAvailable } from "../src/prerequisites.mjs";

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

test("Windows installs signed Docker Desktop, starts it, and continues in one command", async () => {
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const downloads = [];
  const launches = [];
  let installed = false;
  let launched = false;

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
      if (spec.command === "wsl.exe") return 0;
      if (spec.command === "powershell.exe") return 0;
      if (spec.command.endsWith("Docker Desktop Installer.exe")) {
        installed = true;
        return 0;
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
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].url, /^https:\/\/desktop\.docker\.com\/win\/main\/amd64\//);
  assert.ok(calls.some((spec) =>
    spec.command === "powershell.exe" &&
    spec.args.join(" ").includes("Get-AuthenticodeSignature")
  ));
  assert.ok(calls.some((spec) =>
    spec.command.endsWith("Docker Desktop Installer.exe") &&
    spec.args.includes("--user") &&
    spec.args.includes("--quiet") &&
    spec.args.includes("--accept-license")
  ));
  assert.deepEqual(launches, [{
    command: "C:\\Users\\Admin\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe",
    args: []
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
      if (spec.command.endsWith("/Contents/MacOS/install")) installed = true;
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
    pathExists: async () => true,
    sleep: async () => {}
  });

  assert.deepEqual(result, { code: 0, reexecuted: false });
  assert.match(downloads[0].url, /^https:\/\/desktop\.docker\.com\/mac\/main\/arm64\//);
  assert.ok(calls.some((spec) => spec.command === "codesign" && spec.args.includes("--strict")));
  assert.ok(calls.some((spec) =>
    spec.command.endsWith("/Contents/MacOS/install") &&
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
    spec.args[2].includes("spaceapp install --profile auto")
  ));
});
