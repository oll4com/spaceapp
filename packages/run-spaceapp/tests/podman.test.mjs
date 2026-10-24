import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { executeCommand, run } from "../src/cli.mjs";
import {
  composeCommand,
  createDefaultConfig,
  initializeInstallation,
  prepareInstallation,
  renderWorkspaceCompose,
  validateConfig
} from "../src/index.mjs";
import {
  PODMAN_MIN_VERSION,
  engineOf,
  engineSwitchRefusal,
  parseEngineVersion,
  podmanInfoFacts,
  podmanMachineCheck,
  podmanMachineFacts,
  probeCgroupDelegation,
  resolveInstallEngine,
  versionAtLeast
} from "../src/engine.mjs";
import { ensurePodmanAvailable } from "../src/prerequisites.mjs";
import { inspectStoragePlan, storageChecks } from "../src/storage.mjs";

const launcherManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
);
const RUNTIME_VERSION = launcherManifest.spaceappRuntimeVersion;

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
  let eventMode = false;
  const dataHandlers = [];
  const endHandlers = [];
  const keypressHandlers = [];
  const stream = {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    on(event, handler) {
      if (event === "data") {
        dataHandlers.push(handler);
        if (!eventMode) {
          eventMode = true;
          queueMicrotask(() => deliverEvents());
        }
      } else if (event === "end") {
        endHandlers.push(handler);
      } else if (event === "keypress") {
        keypressHandlers.push(handler);
        if (!eventMode) {
          eventMode = true;
          queueMicrotask(() => deliverEvents());
        }
      }
      return stream;
    },
    once(event, handler) {
      if (event === "data" || event === "end" || event === "keypress") {
        stream.on(event, handler);
      }
      return stream;
    },
    removeListener() {
      return stream;
    },
    off() {
      return stream;
    },
    listenerCount(event) {
      if (event === "data") return dataHandlers.length;
      if (event === "end") return endHandlers.length;
      if (event === "keypress") return keypressHandlers.length;
      return 0;
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= answers.length) {
            return { done: true };
          }
          const answer = answers[index];
          index += 1;
          return { done: false, value: `${answer}\n` };
        },
        async return() {
          return { done: true };
        }
      };
    }
  };
  function deliverEvents() {
    while (index < answers.length) {
      const answer = answers[index];
      index += 1;
      if (keypressHandlers.length > 0) {
        for (const character of answer) {
          for (const handler of [...keypressHandlers]) {
            handler({ sequence: character, name: undefined, ctrl: false, meta: false, shift: false });
          }
        }
        for (const handler of [...keypressHandlers]) {
          handler({ sequence: "\r", name: "return", ctrl: false, meta: false, shift: false });
        }
      } else {
        for (const handler of [...dataHandlers]) {
          handler(`${answer}\n`);
        }
      }
    }
    for (const handler of [...endHandlers]) {
      handler();
    }
  }
  return stream;
}

const FRESH_APPROVALS = ["", "", "", "", "", "y"];
const GENEROUS_RESOURCES = Object.freeze({
  cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
  freeDiskBytes: 40 * 1024 ** 3
});

const PODMAN_INFO = Object.freeze({
  version: { Version: "5.2.2" },
  host: {
    security: { rootless: true },
    cgroupVersion: "v2",
    cpus: 8,
    memTotal: 16 * 1024 ** 3,
    arch: "amd64"
  },
  store: { graphRoot: "/home/spaceuser/.local/share/containers/storage" }
});

/** A Podman host as the launcher's probes see it; Docker is absent (127) on purpose. */
function podmanExecute(calls) {
  return async (spec, io) => {
    calls?.push(spec);
    if (spec.command === "docker") return 127;
    if (spec.command !== "podman") return 0;
    if (spec.args[0] === "--version") {
      io?.stdout?.write?.("podman version 5.2.2\n");
      return 0;
    }
    if (spec.args[0] === "info" && spec.args.includes("--format")) {
      io?.stdout?.write?.(JSON.stringify(PODMAN_INFO));
      return 0;
    }
    return 0;
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function readyRequest(url) {
  return Promise.resolve(url.endsWith("/readyz")
    ? jsonResponse({ ok: true })
    : jsonResponse({ setupRequired: false, expiresAt: null }));
}

test("engine version parsing and comparison follow the Podman >= 5 floor", () => {
  assert.equal(PODMAN_MIN_VERSION, "5.0.0");
  assert.equal(parseEngineVersion("podman version 5.2.2"), "5.2.2");
  assert.equal(parseEngineVersion("5.0.0"), "5.0.0");
  assert.equal(parseEngineVersion("podman version 4.9.3"), "4.9.3");
  assert.equal(parseEngineVersion("not a version"), null);
  assert.equal(parseEngineVersion(null), null);
  assert.equal(versionAtLeast("5.0.0", PODMAN_MIN_VERSION), true);
  assert.equal(versionAtLeast("5.2.2", PODMAN_MIN_VERSION), true);
  assert.equal(versionAtLeast("4.9.3", PODMAN_MIN_VERSION), false);
  assert.equal(versionAtLeast(null, PODMAN_MIN_VERSION), false);
});

test("engine selection: explicit wins, stored is kept, unknown is refused", () => {
  assert.equal(engineOf(null), "docker");
  assert.equal(engineOf({}), "docker");
  assert.equal(engineOf({ engine: "podman" }), "podman");
  assert.equal(resolveInstallEngine(undefined, "podman"), "podman");
  assert.equal(resolveInstallEngine("podman", "docker"), "podman");
  assert.throws(() => resolveInstallEngine("nerdctl"), /must be docker or podman/);
  assert.match(engineSwitchRefusal("docker", "podman"), /not\s+visible to podman/);
  assert.match(engineSwitchRefusal("docker", "podman"), /uninstall --purge-data/);
});

test("podman info facts are extracted from the Podman 5 info document", () => {
  assert.deepEqual(podmanInfoFacts(PODMAN_INFO), {
    version: "5.2.2",
    rootless: true,
    cgroupVersion: "v2",
    graphRoot: "/home/spaceuser/.local/share/containers/storage",
    cpuCount: 8,
    memoryBytes: 16 * 1024 ** 3,
    architecture: "amd64"
  });
  assert.equal(podmanInfoFacts(null), null);
  assert.equal(podmanInfoFacts({}), null);
  assert.equal(podmanInfoFacts("nope"), null);
});

test("podman machine facts are sized against the profile and resizing is explained", () => {
  const requirements = { cpuCount: 4, memoryBytes: 7 * 1024 ** 3, freshDiskBytes: 6.5 * 1024 ** 3 };
  const small = podmanMachineFacts([{ Name: "podman-machine-default", CPUs: 2, Memory: 2048, DiskSize: 20, Running: true }]);
  assert.equal(small.cpus, 2);
  assert.equal(small.memoryBytes, 2048 * 1024 ** 2);
  const failing = podmanMachineCheck(small, requirements);
  assert.equal(failing.ok, false);
  assert.match(failing.guidance, /podman machine set --cpus 4 --memory 7168 --disk-size 7/);
  const adequate = podmanMachineFacts([{ Name: "m", CPUs: 8, Memory: 16384, DiskSize: 100, Running: true }]);
  assert.equal(podmanMachineCheck(adequate, requirements).ok, true);
  const missing = podmanMachineCheck(null, requirements);
  assert.equal(missing.ok, false);
  assert.match(missing.guidance, /podman machine init/);
});

test("cgroup v2 delegation is probed from the current cgroup's controllers", async () => {
  const reads = {
    "/proc/self/cgroup": "0::/user.slice/user-1000.slice/session-3.scope\n",
    "/sys/fs/cgroup/user.slice/user-1000.slice/session-3.scope/cgroup.controllers": "cpuset cpu io memory hugetlb pids\n"
  };
  const delegated = await probeCgroupDelegation({ platform: "linux", read: async (path) => reads[path] });
  assert.equal(delegated.version, 2);
  assert.equal(delegated.cpuMemoryDelegated, true);
  const partial = await probeCgroupDelegation({
    platform: "linux",
    read: async (path) => path.endsWith("cgroup.controllers") ? "cpuset io pids\n" : reads["/proc/self/cgroup"]
  });
  assert.equal(partial.cpuMemoryDelegated, false);
  const v1 = await probeCgroupDelegation({
    platform: "linux",
    read: async () => "12:memory:/docker/abc\n11:cpu:/docker/abc\n"
  });
  assert.equal(v1.version, 1);
  assert.equal(v1.cpuMemoryDelegated, null);
  const other = await probeCgroupDelegation({ platform: "darwin", read: async () => { throw new Error("unread"); } });
  assert.equal(other.version, null);
});

test("composeCommand targets the configured engine with identical Compose arguments", () => {
  const root = "/tmp/spaceapp-engine-test";
  const dockerUp = composeCommand("up", root, { profile: "small" });
  const podmanUp = composeCommand("up", root, { profile: "small", engine: "podman" });
  assert.equal(dockerUp.command, "docker");
  assert.equal(podmanUp.command, "podman");
  assert.deepEqual(podmanUp.args, dockerUp.args);
  // Backup/restore run as 0:0 under both engines (required under rootless Podman).
  const backup = composeCommand("backup", root, { profile: "small", engine: "podman" });
  assert.deepEqual(backup.args.slice(-8, -6), ["--user", "0:0"]);
  // The checkpoint database wait keeps its health-condition semantics under podman compose.
  const checkpoint = composeCommand("ensureCheckpointDatabase", root, { profile: "small", engine: "podman" });
  assert.ok(checkpoint.args.includes("--wait"));
  // exec identity for the CLI services is unchanged.
  const ready = composeCommand("cliHostReady", root, { profile: "small", engine: "podman" });
  assert.ok(ready.args.includes("10001:10001"));
  assert.throws(() => composeCommand("up", root, { engine: "nerdctl" }), /Unsupported container engine/);
});

test("configuration persists the engine only when chosen and validates combinations", async () => {
  const unchosen = createDefaultConfig({ version: RUNTIME_VERSION });
  assert.equal("engine" in unchosen, false);
  const chosen = createDefaultConfig({ version: RUNTIME_VERSION, engine: "podman" });
  assert.equal(chosen.engine, "podman");
  assert.equal(validateConfig(chosen), chosen);
  assert.throws(
    () => validateConfig({ ...chosen, accessMode: "host-root" }),
    /host-root is not supported with the Podman engine/
  );
  assert.throws(
    () => createDefaultConfig({ version: RUNTIME_VERSION, engine: "nerdctl" }),
    /engine must be docker or podman/
  );
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-config-"));
  const prepared = await prepareInstallation(root, {
    version: RUNTIME_VERSION,
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  assert.equal(prepared.config.engine, "podman");
  // Once committed, preparing again without an engine keeps the stored one (the CLI layer is what
  // refuses an explicit switch; preparation itself never rewrites the engine).
  const installed = await initializeInstallation(root, {
    version: RUNTIME_VERSION,
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  assert.equal(installed.config.engine, "podman");
  const reprepared = await prepareInstallation(root, {
    version: RUNTIME_VERSION,
    profile: "small",
    accessMode: "isolated"
  });
  assert.equal(engineOf(reprepared.config), "podman");
  const onDisk = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(onDisk.engine, "podman");
});

test("workspace bind mounts gain the SELinux relabel option only under Podman", () => {
  const workspace = {
    id: "docs-0123abcd",
    hostPath: "/home/spaceuser/docs",
    containerPath: "/workspaces/docs",
    readOnly: false
  };
  const dockerConfig = { ...createDefaultConfig({ version: RUNTIME_VERSION }), workspaces: [workspace] };
  const dockerRender = renderWorkspaceCompose(dockerConfig);
  assert.doesNotMatch(dockerRender, /selinux/);
  const podmanRender = renderWorkspaceCompose({ ...dockerConfig, engine: "podman" });
  assert.match(podmanRender, /selinux: "z"/);
  const readOnlyRender = renderWorkspaceCompose({
    ...dockerConfig,
    engine: "podman",
    workspaces: [{ ...workspace, readOnly: true }]
  });
  assert.match(readOnlyRender, /read_only: true/);
  assert.match(readOnlyRender, /selinux: "z"/);
});

test("ensurePodmanAvailable gates on presence, version floor, compose provider, and reachability", async () => {
  const healthy = {
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    execute: podmanExecute(null)
  };
  assert.deepEqual(await ensurePodmanAvailable(healthy), { code: 0, reexecuted: false });

  const missingStderr = capture();
  const missing = await ensurePodmanAvailable({
    platform: "linux",
    stdout: capture().stream,
    stderr: missingStderr.stream,
    execute: async () => 127
  });
  assert.equal(missing.code, 1);
  assert.match(missingStderr.value(), /Podman was not found/);
  assert.match(missingStderr.value(), /dnf install podman/);

  const oldStderr = capture();
  const tooOld = await ensurePodmanAvailable({
    platform: "linux",
    stdout: capture().stream,
    stderr: oldStderr.stream,
    execute: async (spec, io) => {
      if (spec.args[0] === "--version") io?.stdout?.write?.("podman version 4.9.3\n");
      return 0;
    }
  });
  assert.equal(tooOld.code, 1);
  assert.match(oldStderr.value(), /too old: SpaceApp requires Podman >= 5\.0\.0/);

  const providerStderr = capture();
  const noProvider = await ensurePodmanAvailable({
    platform: "linux",
    stdout: capture().stream,
    stderr: providerStderr.stream,
    execute: async (spec, io) => {
      if (spec.args[0] === "--version") {
        io?.stdout?.write?.("podman version 5.2.2\n");
        return 0;
      }
      if (spec.args[0] === "compose") return 1;
      return 0;
    }
  });
  assert.equal(noProvider.code, 1);
  assert.match(providerStderr.value(), /podman-compose \(the Python tool\) is not a supported provider/);

  const socketStderr = capture();
  const unreachable = await ensurePodmanAvailable({
    platform: "linux",
    stdout: capture().stream,
    stderr: socketStderr.stream,
    execute: async (spec, io) => {
      if (spec.args[0] === "--version") {
        io?.stdout?.write?.("podman version 5.2.2\n");
        return 0;
      }
      if (spec.args[0] === "info") return 1;
      return 0;
    }
  });
  assert.equal(unreachable.code, 1);
  assert.match(socketStderr.value(), /podman\.socket/);

  const windows = await ensurePodmanAvailable({
    platform: "win32",
    stdout: capture().stream,
    stderr: capture().stream,
    execute: async () => 0
  });
  assert.equal(windows.code, 1);
});

test("the process launcher trusts podman exactly like docker", async () => {
  const code = await executeCommand(
    { command: "podman", args: ["--version"] },
    { stdout: capture().stream, stderr: capture().stream }
  );
  // 127 where Podman is not installed (this sandbox, most CI), 0 where it is; never a refusal.
  assert.ok(code === 0 || code === 127);
  await assert.rejects(
    executeCommand({ command: "podman-compose", args: ["version"] }),
    /refused to execute an untrusted command/
  );
});

async function podmanInstallationRoot() {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-install-"));
  const installed = await initializeInstallation(root, {
    version: RUNTIME_VERSION,
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  assert.equal(installed.config.engine, "podman");
  return root;
}

test("doctor reports the Podman engine, runtime facts, and rootless state", async () => {
  const root = await podmanInstallationRoot();
  const stdout = capture();
  const stderr = capture();
  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    inspectResources: async () => GENEROUS_RESOURCES,
    execute: podmanExecute(null)
  });
  assert.equal(code, 0);
  assert.match(stdout.value(), /PASS Podman CLI: available/);
  assert.match(stdout.value(), /PASS Podman Compose: available \(Docker Compose v2 provider\)/);
  assert.match(stdout.value(), /PASS Podman Engine: available/);
  assert.match(stdout.value(), /PASS Podman runtime: Podman 5\.2\.2, rootless, cgroup v2/);
  assert.doesNotMatch(stdout.value(), /Docker CLI/);
});

test("storage planning probes Podman and accepts its bare-hex image ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-storage-"));
  const config = createDefaultConfig({ version: RUNTIME_VERSION, profile: "small", engine: "podman" });
  const bareHexId = "a".repeat(64);
  const execute = async (spec, io) => {
    if (spec.command !== "podman") return 127;
    if (spec.args[0] === "info") {
      io?.stdout?.write?.(JSON.stringify(PODMAN_INFO));
      return 0;
    }
    if (spec.args.includes("inspect")) {
      io?.stdout?.write?.(bareHexId);
      return 0;
    }
    return 0;
  };
  const plan = await inspectStoragePlan({
    root,
    config,
    existingConfig: null,
    resources: { ...GENEROUS_RESOURCES },
    execute,
    operation: "fresh"
  });
  assert.equal(plan.engine, "podman");
  assert.deepEqual(plan.missingImages, []);
  const checks = storageChecks(plan, plan.resources);
  assert.equal(checks[1].name, "Podman storage");
});

async function installPodmanEndToEnd(root) {
  const calls = [];
  const stdout = capture();
  const stderr = capture();
  const code = await run(["install", "--engine", "podman", "--profile", "small", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin(...FRESH_APPROVALS),
    inspectResources: async () => GENEROUS_RESOURCES,
    request: readyRequest,
    sleep: async () => {},
    execute: podmanExecute(calls)
  });
  return { code, calls, stdout, stderr };
}

test("install --engine podman runs the whole flow on Podman and persists the engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-e2e-"));
  const { code, calls, stdout } = await installPodmanEndToEnd(root);
  assert.equal(code, 0);
  assert.match(stdout.value(), /Container engine: not configured -> podman/);
  assert.match(stdout.value(), /SpaceApp is ready at http:\/\/127\.0\.0\.1:4911/);
  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(config.engine, "podman");
  // Every executed command went to Podman; Docker was never invoked.
  assert.ok(calls.length > 0);
  assert.ok(calls.every((spec) => spec.command === "podman"));
  const composeActions = calls.filter((spec) => spec.args[0] === "compose").map((spec) => spec.args.at(-1));
  assert.ok(composeActions.includes("pull"));
  // Status on the installed root also drives Podman.
  const statusCalls = [];
  const statusCode = await run(["status"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: Readable.from([]),
    execute: podmanExecute(statusCalls)
  });
  assert.equal(statusCode, 0);
  assert.ok(statusCalls.every((spec) => spec.command === "podman"));
});

test("switching engines on an existing installation is refused with the migration path", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-switch-"));
  const { code } = await installPodmanEndToEnd(root);
  assert.equal(code, 0);
  await assert.rejects(
    run(["install", "--engine", "docker", "--no-open"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: capture().stream,
      stderr: capture().stream,
      stdin: ttyStdin("y"),
      inspectResources: async () => GENEROUS_RESOURCES,
      request: readyRequest,
      sleep: async () => {},
      execute: podmanExecute(null)
    }),
    /Switching container engines on an existing installation is refused/
  );
  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(config.engine, "podman");
});

test("--access host-root is refused with the Podman engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-hostroot-"));
  await assert.rejects(
    run(["install", "--engine", "podman", "--access", "host-root", "--no-open"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: capture().stream,
      stderr: capture().stream,
      stdin: ttyStdin(...FRESH_APPROVALS),
      inspectResources: async () => GENEROUS_RESOURCES,
      request: readyRequest,
      sleep: async () => {},
      execute: podmanExecute(null)
    }),
    /host-root is refused with the Podman engine/
  );
});

test("the support bundle carries the Podman engine facts and no secrets", async () => {
  const root = await podmanInstallationRoot();
  const outPath = join(root, "bundle.json");
  const code = await run(["support-bundle", "--out", outPath], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: Readable.from([]),
    request: async () => { throw new Error("offline"); },
    execute: podmanExecute(null)
  });
  assert.equal(code, 0);
  const bundle = JSON.parse(await readFile(outPath, "utf8"));
  assert.equal(bundle.installation.config.engine, "podman");
  assert.equal(bundle.engine.name, "podman");
  assert.equal(bundle.engine.version, "5.2.2");
  assert.equal(bundle.engine.rootless, true);
  assert.equal(bundle.engine.cgroupVersion, "v2");
  assert.doesNotMatch(JSON.stringify(bundle), /secret/i);
});
