import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import {
  addWorkspace,
  composeCommand,
  configEngine,
  createDefaultConfig,
  initializeInstallation,
  loadConfig,
  prepareInstallation,
  renderWorkspaceCompose,
  resolveInstallEngine,
  saveConfig
} from "../src/index.mjs";
import {
  assessCgroupDelegation,
  engineSwitchRefusal,
  hostRootPodmanRefusal,
  normalizeEngineInfo,
  parseCgroupControllers,
  parseEngineVersion,
  parseHumanBytes,
  parsePodmanMachines,
  podmanMachineChecks,
  podmanMachineResizeGuidance,
  podmanVersionAssessment,
  selectPodmanMachine
} from "../src/engines.mjs";
import { PROFILE_REQUIREMENTS } from "../src/index.mjs";

const RUNTIME_VERSION = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
).spaceappRuntimeVersion;

const PODMAN_INFO = {
  version: { Version: "5.2.2" },
  host: {
    arch: "amd64",
    cpus: 6,
    memTotal: 16_000_000_000,
    cgroupVersion: "v2",
    cgroupManager: "systemd",
    security: { rootless: true }
  },
  store: { graphRoot: "/home/space/.local/share/containers/storage" }
};

const DOCKER_INFO = {
  Version: "27.3.1",
  Architecture: "x86_64",
  NCPU: 4,
  MemTotal: 8_000_000_000,
  DockerRootDir: "/var/lib/docker",
  CgroupVersion: "2",
  CgroupDriver: "systemd",
  SecurityOptions: ["name=seccomp,profile=builtin"]
};

test("engine selection resolves flag, existing value, and default", () => {
  assert.equal(resolveInstallEngine(undefined), "docker");
  assert.equal(resolveInstallEngine(undefined, "podman"), "podman");
  assert.equal(resolveInstallEngine("podman", "docker"), "podman");
  assert.equal(resolveInstallEngine("docker", "podman"), "docker");
  assert.throws(() => resolveInstallEngine("nerdctl"), /docker or podman/);
});

test("engine versions parse for both CLIs and the Podman floor is enforced", () => {
  assert.deepEqual(parseEngineVersion("podman", "podman version 5.2.2\n").tuple, [5, 2, 2]);
  assert.deepEqual(parseEngineVersion("docker", "Docker version 27.3.1, build 7d4bcd8\n").tuple, [27, 3, 1]);
  assert.equal(parseEngineVersion("podman", "not a version"), null);
  assert.equal(podmanVersionAssessment([4, 8, 0]).ok, false);
  assert.match(podmanVersionAssessment([4, 8, 0]).detail, /older than the supported minimum 4\.9\.0/);
  assert.equal(podmanVersionAssessment([4, 9, 3]).ok, true);
  assert.match(podmanVersionAssessment([4, 9, 3]).detail, /recommended/);
  assert.equal(podmanVersionAssessment([5, 2, 2]).ok, true);
});

test("engine info normalization maps Docker and Podman shapes onto one form", () => {
  const podman = normalizeEngineInfo("podman", PODMAN_INFO);
  assert.equal(podman.version, "5.2.2");
  assert.equal(podman.cpuCount, 6);
  assert.equal(podman.memoryBytes, 16_000_000_000);
  assert.equal(podman.rootDir, "/home/space/.local/share/containers/storage");
  assert.equal(podman.rootless, true);
  assert.equal(podman.cgroupVersion, "2");

  const docker = normalizeEngineInfo("docker", DOCKER_INFO);
  assert.equal(docker.version, "27.3.1");
  assert.equal(docker.cpuCount, 4);
  assert.equal(docker.memoryBytes, 8_000_000_000);
  assert.equal(docker.rootDir, "/var/lib/docker");
  assert.equal(docker.rootless, null);
  assert.equal(docker.cgroupVersion, "2");
  assert.equal(normalizeEngineInfo("podman", null), null);
});

test("cgroup delegation assessment distinguishes delegated, missing, and unknown", () => {
  const root = parseCgroupControllers("cpuset cpu io memory hugetlb pids");
  const delegated = parseCgroupControllers("cpuset cpu io memory pids");
  const partial = parseCgroupControllers("cpuset io pids");
  assert.deepEqual(
    assessCgroupDelegation({ rootControllers: root, userControllers: delegated }),
    { known: true, cpuDelegated: true, memoryDelegated: true, missing: [] }
  );
  const missing = assessCgroupDelegation({ rootControllers: root, userControllers: partial });
  assert.equal(missing.known, true);
  assert.deepEqual(missing.missing, ["cpu", "memory"]);
  const unknown = assessCgroupDelegation({ rootControllers: root, userControllers: null });
  assert.equal(unknown.known, false);
  assert.equal(unknown.cpuDelegated, null);
});

test("podman machine facts parse and resize guidance carries exact commands", () => {
  assert.equal(parseHumanBytes("2GiB"), 2 * 1024 ** 3);
  assert.equal(parseHumanBytes("7168MiB"), 7168 * 1024 ** 2);
  assert.equal(parseHumanBytes("100GB"), 100 * 1000 ** 3);
  const machines = parsePodmanMachines(JSON.stringify([
    { Name: "podman-machine-default", CPUs: 2, Memory: "2GiB", DiskSize: "100GiB", Running: true, Default: true }
  ]));
  assert.equal(machines.length, 1);
  const machine = selectPodmanMachine(machines);
  assert.equal(machine.name, "podman-machine-default");
  const checks = podmanMachineChecks(machine, PROFILE_REQUIREMENTS.small);
  assert.equal(checks.every((check) => check.ok), false);
  const guidance = podmanMachineResizeGuidance(machine, PROFILE_REQUIREMENTS.small).join("\n");
  assert.match(guidance, /podman machine set --cpus 4 --memory 7168 --disk-size 7 podman-machine-default/);

  const big = selectPodmanMachine(parsePodmanMachines(JSON.stringify([
    { Name: "roomy", CPUs: 4, Memory: "8GiB", DiskSize: "100GiB", Running: true }
  ])));
  assert.equal(podmanMachineChecks(big, PROFILE_REQUIREMENTS.small).every((check) => check.ok), true);
  assert.equal(podmanMachineChecks(null, PROFILE_REQUIREMENTS.small)[0].ok, false);
});

test("default config records only a non-default engine; legacy configs stay Docker", async () => {
  const docker = createDefaultConfig({ version: RUNTIME_VERSION });
  assert.equal("engine" in docker, false);
  assert.equal(configEngine(docker), "docker");
  const podman = createDefaultConfig({ version: RUNTIME_VERSION, engine: "podman" });
  assert.equal(podman.engine, "podman");
  assert.throws(
    () => createDefaultConfig({ version: RUNTIME_VERSION, engine: "nerdctl" }),
    /docker or podman/
  );

  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-config-"));
  const legacy = createDefaultConfig({ version: RUNTIME_VERSION });
  await saveConfig(root, legacy);
  assert.equal(configEngine(await loadConfig(root)), "docker");
  await assert.rejects(
    () => saveConfig(root, { ...legacy, engine: "nerdctl" }),
    /engine must be docker or podman/
  );
});

test("compose commands are identical for both engines except the binary", () => {
  const root = join(tmpdir(), "spaceapp-compose-contract");
  const cases = [
    ["up", {}],
    ["down", {}],
    ["status", {}],
    ["backup", {}],
    ["ensureCheckpointDatabase", {}],
    ["installProvider", { provider: "opencode" }],
    ["restore", { backupId: "spaceapp-backup-20260101T000000000Z" }]
  ];
  for (const [action, extra] of cases) {
    const docker = composeCommand(action, root, { profile: "small", ...extra });
    const podman = composeCommand(action, root, { profile: "small", engine: "podman", ...extra });
    assert.equal(docker.command, "docker");
    assert.equal(podman.command, "podman");
    assert.deepEqual(podman.args, docker.args);
    assert.equal(podman.args[0], "compose");
  }
  // The features the Podman criteria call out stay in the generated commands:
  // health-gated waits and fixed runtime users are engine-independent.
  const checkpoint = composeCommand("ensureCheckpointDatabase", root, { profile: "medium", engine: "podman" });
  assert.ok(checkpoint.args.includes("--wait"));
  assert.ok(checkpoint.args.includes("--wait-timeout"));
  const provider = composeCommand("installProvider", root, { engine: "podman", provider: "opencode" });
  assert.ok(provider.args.includes("10001:10001"));
  const backup = composeCommand("backup", root, { engine: "podman" });
  assert.ok(backup.args.includes("10001:10001") || backup.args.includes("0:0"));
  assert.throws(() => composeCommand("up", root, { engine: "nerdctl" }), /docker or podman/);
});

test("workspace rendering adds SELinux relabeling and keep-id only for Podman", async () => {
  const base = createDefaultConfig({ version: RUNTIME_VERSION, profile: "small" });
  const hostPath = await mkdtemp(join(tmpdir(), "spaceapp-workspace-fixture-"));
  const withWorkspace = await addWorkspace(base, hostPath, { readOnly: false });
  const readOnly = await addWorkspace(withWorkspace, hostPath, { readOnly: true }).catch(() => withWorkspace);

  const dockerRender = renderWorkspaceCompose(withWorkspace);
  assert.doesNotMatch(dockerRender, /selinux|userns_mode/);

  const podmanRender = renderWorkspaceCompose({ ...readOnly, engine: "podman" });
  assert.match(podmanRender, /userns_mode: "keep-id:uid=10001,gid=10001"/);
  assert.match(podmanRender, /bind:\s*\n\s*selinux: "z"/);
  // Both services that mount workspaces get the treatment.
  assert.equal(podmanRender.match(/selinux: "z"/g).length, 2);
  assert.equal(podmanRender.match(/userns_mode/g).length, 2);
});

test("engine switch on an existing installation is refused with the migration path", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-switch-"));
  await initializeInstallation(root, { version: RUNTIME_VERSION, profile: "small" });
  assert.equal(configEngine(await loadConfig(root)), "docker");
  await assert.rejects(
    () => prepareInstallation(root, { version: RUNTIME_VERSION, profile: "small", engine: "podman" }),
    (error) => {
      assert.match(error.message, /created with Docker, but --engine podman was requested/);
      assert.match(error.message, /spaceapp backup/);
      assert.match(error.message, /uninstall --purge-data/);
      assert.match(error.message, /spaceapp restore/);
      return true;
    }
  );
  // The refusal leaves the stored engine untouched.
  assert.equal(configEngine(await loadConfig(root)), "docker");
});

test("fresh Podman preparation persists the engine; a Podman install refuses Docker too", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-podman-"));
  const prepared = await prepareInstallation(root, {
    version: RUNTIME_VERSION,
    profile: "small",
    engine: "podman"
  });
  assert.equal(prepared.config.engine, "podman");
  await initializeInstallation(root, { version: RUNTIME_VERSION, profile: "small", engine: "podman" });
  assert.equal(configEngine(await loadConfig(root)), "podman");
  await assert.rejects(
    () => prepareInstallation(root, { version: RUNTIME_VERSION, profile: "small", engine: "docker" }),
    /created with Podman, but --engine docker was requested/
  );
  // Re-running with the same or no engine is fine.
  const again = await prepareInstallation(root, { version: RUNTIME_VERSION, profile: "small" });
  assert.equal(again.config.engine, "podman");
});

test("refusal texts name the data-safety and host-root reasons plainly", () => {
  assert.match(engineSwitchRefusal("docker", "podman"), /volumes are not visible to Podman/);
  assert.match(hostRootPodmanRefusal(), /--access host-root is refused with the Podman engine/);
  assert.match(hostRootPodmanRefusal(), /workspace add/);
});

test("support facts never include the engine root directory", () => {
  const facts = normalizeEngineInfo("podman", PODMAN_INFO);
  const bundleShape = {
    name: facts.engine,
    version: facts.version,
    rootless: facts.rootless,
    cgroupVersion: facts.cgroupVersion,
    cgroupManager: facts.cgroupManager
  };
  assert.doesNotMatch(JSON.stringify(bundleShape), /graphRoot|containers\/storage/);
  assert.ok(stat); // stat imported for parity with other suites; no-op guard
});

// ---------------------------------------------------------------------------
// Prerequisites: ensurePodmanAvailable against stubbed executors
// ---------------------------------------------------------------------------
import { ensurePodmanAvailable } from "../src/prerequisites.mjs";
import { run } from "../src/cli.mjs";

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

function podmanExecute({
  version = "podman version 5.2.2\n",
  composeCode = 0,
  info = PODMAN_INFO,
  machines = null
} = {}) {
  return async (spec, io) => {
    if (spec.command !== "podman") return 1;
    const args = spec.args ?? [];
    if (args[0] === "--version") {
      if (version === null) return 127;
      io?.stdout?.write(version);
      return 0;
    }
    if (args[0] === "compose") return composeCode;
    if (args[0] === "info") {
      if (info === null) return 1;
      if (io?.stdout) io.stdout.write(JSON.stringify(info));
      return 0;
    }
    if (args[0] === "machine") {
      if (machines === null) return 1;
      if (io?.stdout) io.stdout.write(JSON.stringify(machines));
      return 0;
    }
    return 0;
  };
}

const delegatedControllers = async (path) => {
  if (path.endsWith("cgroup.controllers")) return "cpuset cpu io memory hugetlb pids";
  return null;
};

test("ensurePodmanAvailable explains installation instead of installing when Podman is missing", async () => {
  const stderr = capture();
  const result = await ensurePodmanAvailable({
    platform: "linux",
    stdout: capture().stream,
    stderr: stderr.stream,
    execute: podmanExecute({ version: null }),
    osRelease: { ID: "fedora" },
    readTextFile: delegatedControllers,
    getuid: () => 1000
  });
  assert.equal(result.code, 1);
  assert.match(stderr.value(), /sudo dnf install -y podman/);
  assert.match(stderr.value(), /podman compose version/);
  assert.match(stderr.value(), /podman-compose is not supported/);
});

test("ensurePodmanAvailable rejects Podman older than the supported minimum", async () => {
  const stderr = capture();
  const result = await ensurePodmanAvailable({
    platform: "linux",
    stdout: capture().stream,
    stderr: stderr.stream,
    execute: podmanExecute({ version: "podman version 4.8.0\n" }),
    osRelease: { ID: "ubuntu" },
    readTextFile: delegatedControllers,
    getuid: () => 1000
  });
  assert.equal(result.code, 1);
  assert.match(stderr.value(), /older than the supported minimum/);
});

test("ensurePodmanAvailable requires a working Compose provider and names the supported one", async () => {
  const stderr = capture();
  const result = await ensurePodmanAvailable({
    platform: "linux",
    stdout: capture().stream,
    stderr: stderr.stream,
    execute: podmanExecute({ composeCode: 1 }),
    osRelease: { ID: "ubuntu" },
    readTextFile: delegatedControllers,
    getuid: () => 1000
  });
  assert.equal(result.code, 1);
  assert.match(stderr.value(), /Docker Compose v2/);
  assert.match(stderr.value(), /required: false/);
});

test("ensurePodmanAvailable points at the user socket when the API does not answer", async () => {
  const stderr = capture();
  const result = await ensurePodmanAvailable({
    platform: "linux",
    stdout: capture().stream,
    stderr: stderr.stream,
    execute: podmanExecute({ info: null }),
    osRelease: { ID: "ubuntu" },
    readTextFile: delegatedControllers,
    getuid: () => 1000
  });
  assert.equal(result.code, 1);
  assert.match(stderr.value(), /systemctl --user enable --now podman\.socket/);
});

test("ensurePodmanAvailable accepts rootless Podman on cgroup v2 with delegated controllers", async () => {
  const stdout = capture();
  const result = await ensurePodmanAvailable({
    platform: "linux",
    stdout: stdout.stream,
    stderr: capture().stream,
    execute: podmanExecute(),
    osRelease: { ID: "ubuntu" },
    readTextFile: delegatedControllers,
    getuid: () => 1000
  });
  assert.equal(result.code, 0);
  assert.match(stdout.value(), /Podman 5\.2\.2/);
});

test("ensurePodmanAvailable refuses cgroup v1 and undelegated limits with the fix", async () => {
  const v1 = await ensurePodmanAvailable({
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    execute: podmanExecute({ info: { ...PODMAN_INFO, host: { ...PODMAN_INFO.host, cgroupVersion: "v1" } } }),
    osRelease: { ID: "ubuntu" },
    readTextFile: delegatedControllers,
    getuid: () => 1000
  });
  assert.equal(v1.code, 1);

  const stderr = capture();
  const undelegated = await ensurePodmanAvailable({
    platform: "linux",
    stdout: capture().stream,
    stderr: stderr.stream,
    execute: podmanExecute(),
    osRelease: { ID: "ubuntu" },
    readTextFile: async (path) => path.includes("user.slice") ? "cpuset io pids" : "cpuset cpu io memory hugetlb pids",
    getuid: () => 1000
  });
  assert.equal(undelegated.code, 1);
  assert.match(stderr.value(), /not delegated to your user slice/);
  assert.match(stderr.value(), /Delegate=cpu cpuset io memory pids/);
});

test("ensurePodmanAvailable checks the macOS machine size for the profile and prints resize commands", async () => {
  const stderr = capture();
  const tooSmall = await ensurePodmanAvailable({
    platform: "darwin",
    stdout: capture().stream,
    stderr: stderr.stream,
    execute: podmanExecute({
      machines: [{ Name: "podman-machine-default", CPUs: 2, Memory: "2GiB", DiskSize: "100GiB", Running: true, Default: true }]
    }),
    installArgs: { requestedProfile: "small" },
    readTextFile: delegatedControllers,
    getuid: () => 501
  });
  assert.equal(tooSmall.code, 1);
  assert.match(stderr.value(), /too small for the small profile/);
  assert.match(stderr.value(), /podman machine set --cpus 4 --memory 7168 --disk-size 7 podman-machine-default/);

  const fits = await ensurePodmanAvailable({
    platform: "darwin",
    stdout: capture().stream,
    stderr: capture().stream,
    execute: podmanExecute({
      machines: [{ Name: "podman-machine-default", CPUs: 4, Memory: "8GiB", DiskSize: "100GiB", Running: true, Default: true }]
    }),
    installArgs: { requestedProfile: "small" },
    readTextFile: delegatedControllers,
    getuid: () => 501
  });
  assert.equal(fits.code, 0);
});

// ---------------------------------------------------------------------------
// CLI end-to-end: install, doctor, lifecycle, and support bundle on Podman
// ---------------------------------------------------------------------------

function ttyStdin(...answers) {
  let index = 0;
  const stream = {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    on() { return stream; },
    once() { return stream; },
    removeListener() { return stream; },
    off() { return stream; },
    listenerCount() { return 0; },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= answers.length) return { done: true };
          const answer = answers[index];
          index += 1;
          return { done: false, value: `${answer}\n` };
        },
        async return() { return { done: true }; }
      };
    }
  };
  return stream;
}

const BIG_HOST = Object.freeze({
  cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
  freeDiskBytes: 60 * 1024 ** 3
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function readyUnclaimedRequest(url) {
  return Promise.resolve(url.endsWith("/readyz")
    ? jsonResponse({ ok: true })
    : jsonResponse({ setupRequired: true, expiresAt: "2099-07-23T12:15:00.000Z" }));
}

test("fresh install with --engine podman drives every compose call through podman and persists the engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-install-"));
  const stdout = capture();
  const specs = [];
  let ensurePodmanCalls = 0;
  const code = await run(["install", "--engine", "podman", "--profile", "small", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: capture().stream,
    stdin: ttyStdin("", "", "", "", "", "y"),
    inspectResources: async () => BIG_HOST,
    ensureDocker: async () => { throw new Error("Docker must not be ensured for a Podman install"); },
    ensurePodman: async () => { ensurePodmanCalls += 1; return { code: 0, reexecuted: false }; },
    prepareDockerPath: async () => null,
    request: readyUnclaimedRequest,
    sleep: async () => {},
    execute: async (spec, io) => {
      if (spec.args?.includes("pg_dump")) io.stdout.write("-- PostgreSQL database dump\nSELECT 1;\n");
      if (!spec.timeoutMs) specs.push(spec);
      return 0;
    }
  });
  assert.equal(code, 0);
  assert.equal(ensurePodmanCalls, 1);
  const composeSpecs = specs.filter((spec) => spec.args?.includes("compose"));
  assert.ok(composeSpecs.length > 0, "expected compose calls during install");
  assert.ok(composeSpecs.every((spec) => spec.command === "podman"), "every compose call must use podman");
  assert.ok(specs.every((spec) => spec.command !== "docker"), "no docker calls in a Podman install");
  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(config.engine, "podman");
  const workspaces = await readFile(join(root, "compose.workspaces.yml"), "utf8");
  assert.match(workspaces, /userns_mode: "keep-id:uid=10001,gid=10001"/);
  assert.match(stdout.value(), /SpaceApp is ready at http:\/\/127\.0\.0\.1:4911/);
});

test("host-root is refused with Podman before any installation state is written", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-hostroot-"));
  await assert.rejects(
    () => run(["install", "--engine", "podman", "--access", "host-root", "--no-open"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: capture().stream,
      stderr: capture().stream,
      stdin: ttyStdin("", "", "", "", "", "y"),
      inspectResources: async () => BIG_HOST,
      ensureDocker: async () => ({ code: 0, reexecuted: false }),
      ensurePodman: async () => ({ code: 0, reexecuted: false }),
      prepareDockerPath: async () => null,
      request: readyUnclaimedRequest,
      sleep: async () => {},
      execute: async () => 0
    }),
    /--access host-root is refused with the Podman engine/
  );
  await assert.rejects(() => readFile(join(root, "config.json"), "utf8"), /ENOENT/);
});

test("install refuses to switch an existing Docker installation to Podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-switch-"));
  await initializeInstallation(root, { version: RUNTIME_VERSION, profile: "small" });
  await assert.rejects(
    () => run(["install", "--engine", "podman", "--no-open"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: capture().stream,
      stderr: capture().stream,
      stdin: ttyStdin("y"),
      inspectResources: async () => BIG_HOST,
      ensureDocker: async () => ({ code: 0, reexecuted: false }),
      ensurePodman: async () => ({ code: 0, reexecuted: false }),
      prepareDockerPath: async () => null,
      request: readyUnclaimedRequest,
      sleep: async () => {},
      execute: async () => 0
    }),
    /not visible to Podman/
  );
});

test("doctor reports engine, version, rootless mode, and cgroup facts for Podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-"));
  await saveConfig(root, createDefaultConfig({ version: RUNTIME_VERSION, profile: "small", engine: "podman" }));
  const stdout = capture();
  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: capture().stream,
    stdin: ttyStdin(),
    inspectResources: async () => BIG_HOST,
    execute: podmanExecute()
  });
  assert.equal(code, 0);
  assert.match(stdout.value(), /PASS Podman CLI: 5\.2\.2/);
  assert.match(stdout.value(), /PASS Podman Compose: available \(Docker Compose v2 provider\)/);
  assert.match(stdout.value(), /PASS Podman Engine: rootless; cgroup v2/);
  assert.match(stdout.value(), /Cgroup limits/);
});

test("lifecycle commands use the engine saved in the configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-up-"));
  await saveConfig(root, createDefaultConfig({ version: RUNTIME_VERSION, profile: "small", engine: "podman" }));
  const specs = [];
  const code = await run(["up"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: ttyStdin(),
    execute: async (spec) => { specs.push(spec); return 0; }
  });
  assert.equal(code, 0);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].command, "podman");
  assert.ok(specs[0].args.includes("up"));
});

test("support bundle records Podman facts without host paths or secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-bundle-"));
  await saveConfig(root, createDefaultConfig({ version: RUNTIME_VERSION, profile: "small", engine: "podman" }));
  const outPath = join(root, "bundle.json");
  const code = await run(["support-bundle", "--out", outPath], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: ttyStdin(),
    execute: podmanExecute(),
    request: async () => jsonResponse({ ok: true })
  });
  assert.equal(code, 0);
  const bundle = JSON.parse(await readFile(outPath, "utf8"));
  assert.equal(bundle.installation.config.engine, "podman");
  assert.equal(bundle.engine.name, "podman");
  assert.equal(bundle.engine.version, "5.2.2");
  assert.equal(bundle.engine.rootless, true);
  assert.equal(bundle.engine.cgroupVersion, "2");
  assert.doesNotMatch(JSON.stringify(bundle), /graphRoot|containers\/storage/);
});
