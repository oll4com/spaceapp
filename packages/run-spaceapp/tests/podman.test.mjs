import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import {
  addWorkspace,
  composeCommand,
  configEngine,
  initializeInstallation,
  loadConfig,
  prepareInstallation,
  renderWorkspaceCompose,
  validateConfig
} from "../src/index.mjs";
import { storageChecks } from "../src/storage.mjs";
import {
  checkPodmanMachineResources,
  detectAvailableEngines,
  ensurePodmanApiService,
  ensurePodmanAvailable,
  podmanApiServiceHelp,
  podmanApiServiceReady,
  podmanInstallHelp,
  podmanIsReady
} from "../src/prerequisites.mjs";

// Rootless Podman engine support (issue #63). Docker remains the default and
// keeps its exact config shape; Podman is stored explicitly in config.json.

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

function ttyStdin(...answers) {
  let index = 0;
  return {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= answers.length) {
            return { done: true };
          }
          const answer = answers[index];
          index += 1;
          return { done: false, value: answer + "\n" };
        },
        async return() {
          return { done: true };
        }
      };
    }
  };
}

const eightGigabyteClassLinuxGuest = Object.freeze({
  cpuCount: 4,
  totalMemoryBytes: 8_325_902_336,
  freeDiskBytes: 15 * 1024 ** 3
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const podmanInfo = {
  host: {
    arch: "amd64",
    cpus: 4,
    memTotal: 8_325_902_336,
    cgroupVersion: "2.0.0",
    cgroupControllers: ["cpu", "memory", "pids"],
    security: { rootless: true }
  },
  store: { graphRoot: "/home/tester/.local/share/containers/storage" },
  version: { Version: "5.2.3" }
};

// profile, access, companions, telemetry, open, confirm
const FRESH_APPROVALS = ["", "", "", "", "", "y"];

function podmanAwareExecute(calls = []) {
  return async (spec, io) => {
    calls.push(spec);
    const args = spec.args ?? [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-f") {
        assert.ok((await readFile(args[i + 1], "utf8")).length > 0, "Missing Compose file " + args[i + 1]);
      }
    }
    if (args.includes("info") && args.includes("--format") && io?.stdout) {
      io.stdout.write(JSON.stringify(podmanInfo));
    }
    if (args.includes("pg_dump") && io?.stdout) {
      io.stdout.write("-- PostgreSQL database dump\nSELECT 1;\n");
    }
    return 0;
  };
}

test("detectAvailableEngines prefers Docker and never probes Podman when Docker works", async () => {
  const probed = [];
  const execute = async (spec) => {
    probed.push(spec.command);
    return 0;
  };
  assert.deepEqual(await detectAvailableEngines(execute), ["docker"]);
  assert.equal(probed.includes("podman"), false);
});

test("detectAvailableEngines falls back to Podman only when Docker is unusable", async () => {
  const podmanOnly = async (spec) => spec.command === "podman" ? 0 : 1;
  assert.deepEqual(await detectAvailableEngines(podmanOnly), ["podman"]);
  const none = async () => 127;
  assert.deepEqual(await detectAvailableEngines(none), []);
});

test("podmanIsReady requires the compose provider, not only the CLI", async () => {
  const withoutCompose = async (spec) => {
    if (spec.command !== "podman") return 1;
    if (spec.args.includes("compose")) return 1;
    return 0;
  };
  assert.equal(await podmanIsReady(withoutCompose), false);
  const complete = async (spec) => spec.command === "podman" ? 0 : 1;
  assert.equal(await podmanIsReady(complete), true);
});

test("podmanInstallHelp gives platform-specific guidance", () => {
  assert.match(podmanInstallHelp("linux"), /apt-get install podman/);
  assert.match(podmanInstallHelp("linux"), /podman compose version/);
  assert.match(podmanInstallHelp("darwin"), /podman machine start/);
  assert.match(podmanInstallHelp("win32"), /not supported on Windows/);
});

test("ensurePodmanAvailable checks readiness, refuses Windows, and reports machine state", async () => {
  const ready = await ensurePodmanAvailable({
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    execute: async () => 0
  });
  assert.equal(ready.code, 0);

  const missingStderr = capture();
  const missing = await ensurePodmanAvailable({
    platform: "linux",
    stdout: capture().stream,
    stderr: missingStderr.stream,
    execute: async (spec) => spec.command === "podman" ? 127 : 0
  });
  assert.equal(missing.code, 1);
  assert.match(missingStderr.value(), /Install Podman/);

  const windows = await ensurePodmanAvailable({
    platform: "win32",
    stdout: capture().stream,
    stderr: capture().stream,
    execute: async () => 0
  });
  assert.equal(windows.code, 1);

  const machineStderr = capture();
  const stopped = await ensurePodmanAvailable({
    platform: "darwin",
    stdout: capture().stream,
    stderr: machineStderr.stream,
    execute: async (spec, io) => {
      if ((spec.args ?? []).includes("machine")) {
        io.stdout.write(JSON.stringify([{ Running: false }]));
      }
      return 0;
    }
  });
  assert.equal(stopped.code, 1);
  assert.match(machineStderr.value(), /podman machine start/);
});

test("checkPodmanMachineResources reports undersized machines with resize instructions", async () => {
  const undersized = await checkPodmanMachineResources(
    async (spec, io) => {
      if ((spec.args ?? []).includes("machine")) {
        io.stdout.write(JSON.stringify([{ State: "running", Resources: { CPUs: 2, Memory: 2048, DiskSize: 10 } }]));
      }
      return 0;
    },
    { cpuCount: 4, memoryBytes: 8 * 1024 ** 3, freshDiskBytes: 20 * 1024 ** 3 }
  );
  assert.equal(undersized.ok, false);
  assert.equal(undersized.reason, "podman-machine-undersized");
  assert.equal(undersized.issues.length, 3);
  assert.match(undersized.issues[0], /podman machine set --cpus 4/);
  assert.match(undersized.issues[1], /podman machine set --memory/);
  assert.match(undersized.issues[2], /disk/);

  // Podman 5+ nests machine sizing under Resources (Memory in MiB, DiskSize in
  // GiB) and reports the status in State.
  const adequate = await checkPodmanMachineResources(
    async (spec, io) => {
      if ((spec.args ?? []).includes("machine")) {
        io.stdout.write(JSON.stringify([{ State: "running", Resources: { CPUs: 8, Memory: 8192, DiskSize: 40 } }]));
      }
      return 0;
    },
    { cpuCount: 4, memoryBytes: 8 * 1024 ** 3, freshDiskBytes: 20 * 1024 ** 3 }
  );
  assert.equal(adequate.ok, true);
  assert.deepEqual(adequate.issues, []);

  const stopped = await checkPodmanMachineResources(async (spec, io) => {
    if ((spec.args ?? []).includes("machine")) {
      io.stdout.write(JSON.stringify([{ State: "stopped" }]));
    }
    return 0;
  });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, "podman-machine-not-running");
});

test("composeCommand targets the podman binary for podman installations", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-compose-"));
  const pull = composeCommand("pull", root, { profile: "small", engine: "podman" });
  assert.equal(pull.command, "podman");
  // No user-namespace overlay: rootless Podman uses its default subuid/subgid
  // mapping and the published images manage their own privileges.
  assert.equal(pull.args.some((argument) => argument.endsWith("compose.podman.yml")), false);

  const dockerPull = composeCommand("pull", root, { profile: "small", engine: "docker" });
  assert.equal(dockerPull.command, "docker");
  assert.equal(dockerPull.args.some((argument) => argument.endsWith("compose.podman.yml")), false);

  const backup = composeCommand("backup", root, { profile: "small", engine: "podman" });
  assert.ok(backup.args.includes("--user"));
  assert.equal(backup.args[backup.args.indexOf("--user") + 1], "0:0");
  const dockerBackup = composeCommand("backup", root, { profile: "small" });
  assert.equal(dockerBackup.command, "docker");
  assert.equal(dockerBackup.args[dockerBackup.args.indexOf("--user") + 1], "0:0");

  const restore = composeCommand("restore", root, { backupId: "spaceapp-backup-20260118T000000001Z", profile: "small", engine: "podman" });
  assert.equal(restore.command, "podman");
  assert.equal(restore.args[restore.args.indexOf("--user") + 1], "0:0");
});

test("configEngine defaults to docker and validateConfig accepts only docker and podman", async () => {
  assert.equal(configEngine(null), "docker");
  assert.equal(configEngine({}), "docker");
  assert.equal(configEngine({ engine: "docker" }), "docker");
  assert.equal(configEngine({ engine: "podman" }), "podman");

  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-config-"));
  const { config } = await initializeInstallation(root, { version: "0.1.30", profile: "small" });
  assert.equal("engine" in JSON.parse(await readFile(join(root, "config.json"), "utf8")), false);
  assert.throws(() => validateConfig({ ...config, engine: "lxd" }), /engine must be "docker" or "podman"/);
  validateConfig({ ...config, engine: "podman" });
});

test("prepareInstallation refuses engine switches and documents the migration", async () => {
  const dockerRoot = await mkdtemp(join(tmpdir(), "spaceapp-engine-docker-"));
  await initializeInstallation(dockerRoot, { version: "0.1.30", profile: "small" });
  await assert.rejects(
    () => prepareInstallation(dockerRoot, { version: "0.1.30", profile: "small", engine: "podman" }),
    /was set up with the docker engine; switching to podman in place is not supported/
  );
  await assert.rejects(
    () => prepareInstallation(dockerRoot, { version: "0.1.30", profile: "small", engine: "podman" }),
    /backup.*uninstall --purge-data.*--engine podman.*restore/s
  );

  const podmanRoot = await mkdtemp(join(tmpdir(), "spaceapp-engine-podman-"));
  await initializeInstallation(podmanRoot, { version: "0.1.30", profile: "small", engine: "podman" });
  await assert.rejects(
    () => prepareInstallation(podmanRoot, { version: "0.1.30", profile: "small", engine: "docker" }),
    /was set up with the podman engine; switching to docker in place is not supported/
  );
});

test("a podman installation stores the engine and writes no overlay file", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-init-"));
  const { config } = await initializeInstallation(root, { version: "0.1.30", profile: "small", engine: "podman" });
  assert.equal(config.engine, "podman");
  assert.equal(JSON.parse(await readFile(join(root, "config.json"), "utf8")).engine, "podman");
  // Rootless Podman runs the published images through its default subordinate
  // UID/GID mapping; the entrypoints start as root and drop privileges themselves.
  // A keep-id overlay would run them as the mapped user without capabilities and
  // crash the services, so no overlay file must exist.
  await assert.rejects(() => readFile(join(root, "compose.podman.yml")));

  const dockerRoot = await mkdtemp(join(tmpdir(), "spaceapp-docker-init-"));
  await initializeInstallation(dockerRoot, { version: "0.1.30", profile: "small" });
  await assert.rejects(() => readFile(join(dockerRoot, "compose.podman.yml")));
});

test("workspace mounts get SELinux z binds only for the podman engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-workspaces-"));
  const { config } = await initializeInstallation(root, { version: "0.1.30", profile: "small", engine: "podman" });
  await mkdir(join(root, "work"), { recursive: true });
  const withWorkspace = await addWorkspace(config, join(root, "work"));
  const podmanCompose = renderWorkspaceCompose(withWorkspace);
  assert.match(podmanCompose, /selinux: "z"/);

  const dockerCompose = renderWorkspaceCompose({ ...withWorkspace, engine: undefined });
  assert.doesNotMatch(dockerCompose, /selinux/);
});

test("storageChecks labels engine storage per engine and stays informational without capacity", () => {
  const plan = {
    requiredDiskBytes: 4 * 1024 ** 3,
    operation: "upgrade",
    missingImageBytes: 0,
    checkpointBytes: 0,
    dockerFreeDiskBytes: 9 * 1024 ** 3
  };
  const resources = { freeDiskBytes: 12 * 1024 ** 3 };
  const podmanChecks = storageChecks(plan, resources, "podman");
  assert.equal(podmanChecks[1].name, "Engine storage");
  assert.equal(podmanChecks[1].ok, true);
  const dockerChecks = storageChecks(plan, resources);
  assert.equal(dockerChecks[1].name, "Docker storage");
  assert.equal(dockerChecks[1].ok, true);

  const unknown = storageChecks({ ...plan, dockerFreeDiskBytes: null }, resources, "podman");
  assert.equal(unknown[1].ok, true);
  assert.match(unknown[1].detail, /Podman ENOSPC/);
});

test("doctor reports the podman engine, rootless mode, and cgroup delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-"));
  await initializeInstallation(root, { version: "0.1.30", profile: "small", engine: "podman" });
  const stdout = capture();
  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: capture().stream,
    stdin: ttyStdin(),
    execute: podmanAwareExecute(),
    inspectResources: async () => eightGigabyteClassLinuxGuest
  });
  assert.equal(code, 0);
  const out = stdout.value();
  assert.match(out, /PASS Podman CLI: available/);
  assert.match(out, /PASS Podman Compose: available/);
  assert.match(out, /PASS Podman Engine: available/);
  assert.match(out, /PASS Container engine: podman \(rootless\)/);
  assert.match(out, /PASS Engine rootless: rootless \(no root privileges required\)/);
  assert.match(out, /PASS Engine delegation: cgroup v2\.0\.0 with cpu and memory delegation/);
  assert.match(out, /PASS Podman API socket: reachable/);
  assert.doesNotMatch(out, /Docker CLI/);
});

test("doctor fails with podman install guidance when the engine is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-missing-"));
  await initializeInstallation(root, { version: "0.1.30", profile: "small", engine: "podman" });
  const stderr = capture();
  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: stderr.stream,
    stdin: ttyStdin(),
    execute: async () => 127,
    inspectResources: async () => eightGigabyteClassLinuxGuest
  });
  assert.equal(code, 1);
  assert.match(stderr.value(), /FAIL Podman CLI: not found on PATH/);
  assert.match(stderr.value(), /Install Podman/);
});

test("install validates the --engine value", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-bad-engine-"));
  await assert.rejects(
    () => run(["install", "--engine", "lxd", "--no-open"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: capture().stream,
      stderr: capture().stream,
      stdin: ttyStdin()
    }),
    /--engine docker\|podman/
  );
});

test("install refuses host-root access with the podman engine before executing anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-host-root-"));
  const calls = [];
  await assert.rejects(
    () => run(["install", "--engine", "podman", "--access", "host-root", "--no-open"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: capture().stream,
      stderr: capture().stream,
      stdin: ttyStdin(...FRESH_APPROVALS),
      hostRootRuntimeCompatible: true,
      inspectResources: async () => eightGigabyteClassLinuxGuest,
      execute: async (spec) => {
        calls.push(spec);
        return 0;
      }
    }),
    /not supported with the rootless Podman engine/
  );
  assert.equal(calls.length, 0);
});

test("install --engine podman completes with podman compose commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-install-"));
  const stdout = capture();
  const calls = [];
  const code = await run(["install", "--engine", "podman", "--profile", "small", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: capture().stream,
    stdin: ttyStdin(...FRESH_APPROVALS),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    request: async (url) => jsonResponse(
      url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null }
    ),
    sleep: async () => {},
    execute: podmanAwareExecute(calls)
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(await readFile(join(root, "config.json"), "utf8")).engine, "podman");
  assert.equal(JSON.parse(await readFile(join(root, "config.json"), "utf8")).profile, "small");
  assert.match(stdout.value(), /Engine: podman \(rootless\)/);
  await assert.rejects(() => readFile(join(root, "compose.podman.yml")));

  // The readiness probe "podman compose version" has no -f files; filter to real compose commands.
  const composeCalls = calls.filter((spec) => spec.args?.includes("--project-name"));
  assert.ok(composeCalls.length > 0, "expected compose activity");
  assert.ok(composeCalls.every((spec) => spec.command === "podman"));
  assert.ok(composeCalls.every((spec) => spec.args.every((argument) => !argument.endsWith("compose.podman.yml"))));
  assert.ok(composeCalls.some((spec) => spec.args.includes("pull")));
  assert.ok(composeCalls.some((spec) => spec.args.includes("up")));
});

test("install picks the podman engine through --answers with --non-interactive", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-answers-"));
  const stdout = capture();
  const calls = [];
  const answers = {
    confirm: true,
    profile: "small",
    access: "isolated",
    engine: "podman",
    companions: false,
    telemetry: false,
    open: false
  };
  const code = await run(["install", "--non-interactive", "--answers", JSON.stringify(answers)], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: capture().stream,
    stdin: ttyStdin(),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    request: async (url) => jsonResponse(
      url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null }
    ),
    sleep: async () => {},
    execute: podmanAwareExecute(calls)
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(await readFile(join(root, "config.json"), "utf8")).engine, "podman");
  assert.match(stdout.value(), /Engine: podman \(rootless\)/);
  const composeCalls = calls.filter((spec) => spec.args?.includes("--project-name"));
  assert.ok(composeCalls.length > 0, "expected compose activity");
  assert.ok(composeCalls.every((spec) => spec.command === "podman"));
});

test("install rejects an unsupported engine in --answers before executing anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-answers-bad-"));
  const calls = [];
  await assert.rejects(
    () => run(["install", "--non-interactive", "--answers", JSON.stringify({
      confirm: true,
      profile: "small",
      access: "isolated",
      engine: "lxd",
      companions: false,
      telemetry: false,
      open: false
    })], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: capture().stream,
      stderr: capture().stream,
      stdin: ttyStdin(),
      inspectResources: async () => eightGigabyteClassLinuxGuest,
      execute: async (spec) => {
        calls.push(spec);
        return 0;
      }
    }),
    /Unsupported container engine in --answers: lxd/
  );
  assert.equal(calls.length, 0);
});

test("update on a podman installation keeps podman commands and checkpoints the runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-update-"));
  await initializeInstallation(root, { version: "0.1.30", profile: "light", engine: "podman" });
  const calls = [];
  let ensureEngine = null;
  const stderr = capture();
  const code = await run(["update"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdin: ttyStdin("y"),
    stdout: capture().stream,
    stderr: stderr.stream,
    execute: podmanAwareExecute(calls),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async (options) => {
      ensureEngine = options.engine;
      return { code: 0, reexecuted: false };
    },
    prepareDockerPath: async () => null,
    request: async (url) => jsonResponse(
      url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null }
    ),
    sleep: async () => {}
  });
  assert.equal(code, 0, stderr.value());
  assert.equal(ensureEngine, "podman");
  assert.ok(calls.length > 0);
  assert.ok(calls.every((spec) => spec.command === "podman"));
  assert.ok(calls.every((spec) => (spec.args ?? []).every((argument) => !argument.endsWith("compose.podman.yml"))));

  const checkpoint = (await readdir(join(root, "checkpoints")))
    .find((name) => name.startsWith("spaceapp-checkpoint-"));
  assert.ok(checkpoint, "expected a checkpoint directory");
  assert.ok((await readdir(join(root, "checkpoints", checkpoint))).includes("runtime.env"));
  assert.equal((await loadConfig(root)).engine, "podman");
});

test("support-bundle reports the podman engine facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-bundle-"));
  await initializeInstallation(root, { version: "0.1.30", profile: "small", engine: "podman" });
  const bundlePath = join(root, "bundle.json");
  const code = await run(["support-bundle", "--out", bundlePath], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: ttyStdin(),
    execute: podmanAwareExecute(),
    request: async (url) => jsonResponse(
      url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null }
    )
  });
  assert.equal(code, 0);
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(bundle.engine.name, "podman");
  assert.equal(bundle.engine.available, true);
  assert.equal(bundle.engine.version, "5.2.3");
  assert.equal(bundle.engine.rootless, true);
  assert.equal(bundle.engine.cgroupVersion, "2.0.0");
  assert.deepEqual(bundle.engine.cgroupControllers, ["cpu", "memory", "pids"]);
  assert.equal(bundle.installation.config.engine, "podman");
});

test("factory-reset on a podman installation reinitializes with the same engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-reset-"));
  await initializeInstallation(root, { version: "0.1.30", profile: "small", engine: "podman" });
  const code = await run(["factory-reset"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: ttyStdin("FACTORY-RESET"),
    execute: podmanAwareExecute(),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    request: async (url) => jsonResponse(url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null })
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(await readFile(join(root, "config.json"), "utf8")).engine, "podman");
  await assert.rejects(() => readFile(join(root, "compose.podman.yml")));
});


test("podmanApiServiceReady probes the compose path exactly where compose runs", async () => {
  const calls = [];
  const execute = async (spec) => {
    calls.push(spec);
    return spec.args.join(" ") === "compose ls" ? 1 : 0;
  };
  assert.equal(await podmanApiServiceReady(execute), false);
  assert.equal(await podmanApiServiceReady(async () => 0), true);
  assert.deepEqual(calls, [{ command: "podman", args: ["compose", "ls"] }]);
});

test("ensurePodmanApiService starts a detached podman system service when the socket is missing", async () => {
  const calls = [];
  let serviceStarted = false;
  const execute = async (spec) => {
    calls.push(spec);
    const args = spec.args.join(" ");
    if (args === "system service --time=0") {
      serviceStarted = true;
      return 0;
    }
    if (args === "compose ls") {
      return serviceStarted ? 0 : 1;
    }
    return 0;
  };
  const result = await ensurePodmanApiService(execute, { platform: "linux", sleep: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  const service = calls.find((spec) => spec.args.join(" ") === "system service --time=0");
  assert.ok(service, "expected a detached podman system service start");
  assert.equal(service.background, true);
});

test("ensurePodmanApiService explains a missing socket on macOS instead of starting a service", async () => {
  const calls = [];
  const execute = async (spec) => {
    calls.push(spec);
    return spec.args.join(" ") === "compose ls" ? 1 : 0;
  };
  const result = await ensurePodmanApiService(execute, { platform: "darwin" });
  assert.equal(result.ok, false);
  assert.match(result.instructions.join("\n"), /podman machine start/);
  assert.ok(calls.every((spec) => !spec.args.includes("system")));
});

test("ensurePodmanApiService gives up after the wait and prints manual guidance", async () => {
  const execute = async (spec) => (spec.args.join(" ") === "system service --time=0" ? 0 : 1);
  const result = await ensurePodmanApiService(execute, { platform: "linux", waitMs: 5, sleep: async () => {} });
  assert.equal(result.ok, false);
  assert.match(result.instructions.join("\n"), /podman system service/);
});

test("ensurePodmanApiService fails fast when the service cannot start at all", async () => {
  const result = await ensurePodmanApiService(async () => 1, { platform: "linux" });
  assert.equal(result.ok, false);
  assert.match(result.instructions.join("\n"), /podman.socket/);
});

test("ensurePodmanAvailable fails with socket guidance when the API service cannot come up", async () => {
  const stderr = capture();
  const result = await ensurePodmanAvailable({
    platform: "linux",
    stdout: capture().stream,
    stderr: stderr.stream,
    execute: async () => 0,
    apiService: async () => ({ ok: false, instructions: podmanApiServiceHelp() })
  });
  assert.equal(result.code, 1);
  assert.match(stderr.value(), /podman.socket/);
});

test("install starts the rootless podman API service when the socket is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-socket-"));
  const stdout = capture();
  const calls = [];
  const inner = podmanAwareExecute();
  let serviceStarted = false;
  const execute = async (spec, io) => {
    calls.push(spec);
    const args = spec.args.join(" ");
    if (args === "system service --time=0") {
      serviceStarted = true;
      return 0;
    }
    if (args === "compose ls") {
      return serviceStarted ? 0 : 1;
    }
    return inner(spec, io);
  };
  const code = await run(["install", "--engine", "podman", "--profile", "small", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: capture().stream,
    stdin: ttyStdin(...FRESH_APPROVALS),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    request: async (url) => jsonResponse(
      url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null }
    ),
    sleep: async () => {},
    execute
  });
  assert.equal(code, 0);
  const service = calls.find((spec) => spec.args.join(" ") === "system service --time=0");
  assert.ok(service, "expected the launcher to start the podman API service");
  assert.equal(service.background, true);
  assert.match(stdout.value(), /Engine: podman \(rootless\)/);
});
