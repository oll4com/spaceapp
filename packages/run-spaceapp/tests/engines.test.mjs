import test from "node:test";
import assert from "node:assert/strict";
import { detectContainerEngine, inspectEngine, podmanInstallHelp } from "../src/engines.mjs";

const GiB = 1024 ** 3;
function podmanInfo(overrides = {}) {
  return {
    host: { cpus: 8, memTotal: 8 * GiB, security: { rootless: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"], ...overrides.host },
    version: { Version: "5.2.3", ...overrides.version },
    store: { graphRootAllocated: 100 * GiB, graphRootUsed: 20 * GiB, ...overrides.store }
  };
}

function engineProbe({ info = podmanInfo(), engineVersion = "podman version 5.2.3", composeVersion = "2.29.2", machine } = {}) {
  const calls = [];
  const execute = async (spec, io) => {
    calls.push(spec);
    let output;
    if (spec.args[0] === "--version") output = engineVersion;
    else if (spec.args[0] === "info") output = JSON.stringify(info);
    else if (spec.args[0] === "compose") output = spec.args[1] === "version" ? composeVersion : "[]";
    else if (spec.args[0] === "machine" && spec.args[1] === "info") output = JSON.stringify({ Host: { DefaultMachine: machine?.Name } });
    else if (spec.args[0] === "machine" && spec.args[1] === "inspect") output = JSON.stringify([machine]);
    if (output === undefined) return 1;
    io.stdout.write(output);
    return 0;
  };
  return { execute, calls };
}

test("Docker remains the default when both engines are installed", async () => {
  const calls = [];
  const selected = await detectContainerEngine({ execute: async (spec) => { calls.push(spec); return 0; }, platform: "linux" });
  assert.equal(selected.engine, "docker");
  assert.deepEqual(calls.map((spec) => spec.command), ["docker"]);
});

test("Docker CLI failure does not silently move an existing engine choice", async () => {
  const selected = await detectContainerEngine({ execute: async () => 1, platform: "linux" });
  assert.equal(selected.engine, "docker");
});

test("podman-docker compatibility shim selects confirmed native Podman", async () => {
  const calls = [];
  const selected = await detectContainerEngine({ platform: "linux", execute: async (spec, io) => {
    calls.push(spec.command);
    io.stdout.write("podman version 5.4.2\n");
    return 0;
  } });
  assert.equal(selected.engine, "podman");
  assert.deepEqual(calls, ["docker", "podman"], "each executable is probed once");
});

test("a shim cannot select Podman without a working native executable", async () => {
  const selected = await detectContainerEngine({ platform: "linux", execute: async (spec, io) => {
    if (spec.command === "podman") return 127;
    io.stdout.write("podman version 5.4.2\n");
    return 0;
  } });
  assert.equal(selected.engine, "docker");
});

test("a real Docker version preserves its default without probing Podman", async () => {
  const calls = [];
  const selected = await detectContainerEngine({ platform: "linux", execute: async (spec, io) => {
    calls.push(spec.command);
    io.stdout.write("Docker version 27.5.1, build 9f9e405\n");
    return 0;
  } });
  assert.equal(selected.engine, "docker");
  assert.deepEqual(calls, ["docker"]);
});

test("Podman is detected on Linux and macOS only when Docker is absent", async () => {
  for (const platform of ["linux", "darwin"]) {
    const selected = await detectContainerEngine({ platform, execute: async (spec, io) => {
      if (spec.command === "docker") return 127;
      io.stdout.write("podman version 5.2.3");
      return 0;
    } });
    assert.deepEqual(selected, { engine: "podman", detected: true, reason: "podman-available" });
  }
});

test("neither engine and Windows preserve the Docker installation path", async () => {
  assert.equal((await detectContainerEngine({ platform: "linux", execute: async () => 127 })).engine, "docker");
  const calls = [];
  assert.equal((await detectContainerEngine({ platform: "win32", execute: async (spec) => { calls.push(spec); return 127; } })).engine, "docker");
  assert.equal(calls.length, 1);
});

test("explicit engine choice avoids detection and rejects unsupported inputs", async () => {
  const execute = async () => { throw new Error("unexpected probe"); };
  for (const requestedEngine of ["docker", "podman"]) {
    assert.equal((await detectContainerEngine({ execute, platform: "linux", requestedEngine })).engine, requestedEngine);
  }
  await assert.rejects(detectContainerEngine({ execute, requestedEngine: "sh" }), /must be docker or podman/);
  await assert.rejects(detectContainerEngine({ execute, platform: "win32", requestedEngine: "podman" }), /Linux and macOS only/);
});

test("missing executable exceptions still permit Podman discovery", async () => {
  const execute = async (spec, io) => {
    if (spec.command === "docker") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    io.stdout.write("podman version 5.2.3");
    return 0;
  };
  assert.equal((await detectContainerEngine({ execute, platform: "linux" })).engine, "podman");
});

test("an empty successful command is not mistaken for an installed Podman CLI", async () => {
  const selected = await detectContainerEngine({ platform: "darwin", execute: async (spec) => spec.command === "docker" ? 127 : 0 });
  assert.equal(selected.engine, "docker");
});

test("Podman inspection enforces a static Compose v2 provider and reports rootless limits", async () => {
  const { execute, calls } = engineProbe();
  const result = await inspectEngine({ engine: "podman", execute, platform: "linux" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.facts.version, "5.2.3");
  assert.equal(result.facts.rootless, true);
  assert.equal(result.facts.cgroupVersion, "v2");
  assert.equal(result.facts.cpuLimitsDelegated, true);
  assert.equal(result.facts.memoryLimitsDelegated, true);
  assert.equal(result.facts.freeDiskBytes, 80 * GiB);
  assert.ok(calls.every((spec) => spec.command === "podman"));
  assert.deepEqual(calls.find((spec) => spec.args[0] === "compose").env, { PODMAN_COMPOSE_PROVIDER: "docker-compose" });
});

test("old Podman, old Compose, rootful mode and missing delegation fail before runtime launch", async () => {
  const { execute } = engineProbe({
    info: podmanInfo({ version: { Version: "4.9.4" }, host: { security: { rootless: false }, cgroupVersion: "v1", cgroupControllers: ["pids"] } }),
    composeVersion: "2.19.1"
  });
  const result = await inspectEngine({ engine: "podman", execute, platform: "linux" });
  for (const name of ["Podman version", "Podman Compose", "Rootless containers", "Cgroup version", "CPU limit delegation", "Memory limit delegation"]) {
    assert.equal(result.checks.find((check) => check.name === name).ok, false, name);
  }
  assert.match(result.errors.join("\n"), /Delegate=cpu cpuset memory pids/);
});

test("a stopped Podman API socket fails preflight even when native engine info succeeds", async () => {
  const probe = engineProbe();
  const result = await inspectEngine({ engine: "podman", platform: "linux", execute: (spec, io) => {
    if (spec.args[0] === "compose" && spec.args[1] === "ls") return 1;
    return probe.execute(spec, io);
  } });
  assert.equal(result.checks.find((check) => check.name === "Podman Engine").ok, true);
  assert.match(result.errors.join("\n"), /systemctl --user enable --now podman.socket/);
});

test("unavailable or invalid Podman probes fail closed without raw probe data", async () => {
  const { execute } = engineProbe({ info: null, engineVersion: "secret-token-value", composeVersion: "podman-compose version 1.3.0" });
  const result = await inspectEngine({ engine: "podman", execute, platform: "linux" });
  assert.equal(result.facts.version, null);
  assert.ok(result.errors.length > 0);
  assert.doesNotMatch(JSON.stringify(result), /secret-token-value/);
  const empty = await inspectEngine({ engine: "podman", execute: engineProbe({ info: {} }).execute, platform: "linux" });
  assert.equal(empty.checks.find((check) => check.name === "Podman Engine").ok, false);
});

test("engine diagnostics allowlist excludes paths, registry authentication and hostname", async () => {
  const info = { ...podmanInfo(), registries: { auth: "secret-registry-token" } };
  info.host.hostname = "private-host-name";
  info.store.graphRoot = "/home/private-person/containers";
  const result = await inspectEngine({ engine: "podman", execute: engineProbe({ info }).execute, platform: "linux" });
  assert.doesNotMatch(JSON.stringify(result), /secret-registry-token|private-host-name|private-person/);
});

test("Docker diagnostics use Docker facts and tolerate unknown optional fields", async () => {
  const { execute, calls } = engineProbe({ info: { ServerVersion: "28.0.1", SecurityOptions: ["name=rootless"], CgroupVersion: "2", CpuCfsQuota: true, MemoryLimit: true, NCPU: 4, MemTotal: 8 * GiB }, engineVersion: "Docker version 28.0.1", composeVersion: "2.34.0" });
  const result = await inspectEngine({ execute, platform: "linux" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.facts.rootless, true);
  assert.equal(result.facts.cgroupVersion, "v2");
  assert.ok(calls.every((spec) => spec.command === "docker" && !spec.env));
  const unknown = await inspectEngine({ execute: async () => 0, platform: "linux" });
  assert.deepEqual(unknown.errors, []);
  assert.equal(unknown.facts.version, null);
});

test("macOS checks the active machine CPU, memory and available disk against the profile", async () => {
  const machine = { Name: "spaceapp-machine", State: "running", Rootful: false, Resources: { CPUs: 4, Memory: 4096, DiskSize: 100 } };
  const { execute, calls } = engineProbe({ machine });
  const result = await inspectEngine({ engine: "podman", execute, platform: "darwin", profile: "small" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.facts.machine.memoryBytes, 4 * GiB);
  assert.equal(result.facts.machine.diskBytes, 100 * GiB);
  assert.deepEqual(calls.find((spec) => spec.args[1] === "inspect").args, ["machine", "inspect", "spaceapp-machine"]);
});

test("undersized machines explain resize and require actual free disk, not total disk", async () => {
  const machine = { Name: "spaceapp-machine", State: "running", Rootful: false, Resources: { CPUs: 2, Memory: 2048, DiskSize: 100 } };
  const { execute } = engineProbe({ machine, info: podmanInfo({ store: { graphRootUsed: 99 * GiB } }) });
  const result = await inspectEngine({ engine: "podman", execute, platform: "darwin", profile: "small" });
  for (const name of ["Podman machine CPU", "Podman machine memory", "Podman machine disk"]) assert.equal(result.checks.find((check) => check.name === name).ok, false);
  assert.match(result.errors.join("\n"), /podman machine set --cpus 4 --memory 3072 --disk-size 20 spaceapp-machine/);
  assert.match(result.errors.join("\n"), /Other VM providers/);
});

test("macOS maintenance uses additional required disk instead of fresh image reserve", async () => {
  const machine = { Name: "spaceapp-machine", State: "running", Rootful: false, Resources: { CPUs: 4, Memory: 4096, DiskSize: 100 } };
  const { execute } = engineProbe({ machine, info: podmanInfo({ store: { graphRootUsed: 99 * GiB } }) });
  const fresh = await inspectEngine({ engine: "podman", execute, platform: "darwin", profile: "small" });
  assert.equal(fresh.checks.find((check) => check.name === "Podman machine disk").ok, false);
  const maintenance = await inspectEngine({ engine: "podman", execute, platform: "darwin", profile: "small", requiredDiskBytes: 512 * 1024 ** 2 });
  assert.deepEqual(maintenance.errors, []);
  assert.match(maintenance.checks.find((check) => check.name === "Podman machine disk").detail, /0\.5 GiB required/);
});

test("macOS refuses missing and rootful machines", async () => {
  const missing = await inspectEngine({ engine: "podman", execute: engineProbe().execute, platform: "darwin", profile: "small" });
  assert.equal(missing.checks.find((check) => check.name === "Podman machine").ok, false);
  const machine = { Name: "spaceapp-machine", State: "running", Rootful: true, Resources: { CPUs: 4, Memory: 4096, DiskSize: 100 } };
  const rootful = await inspectEngine({ engine: "podman", execute: engineProbe({ machine }).execute, platform: "darwin" });
  assert.equal(rootful.checks.find((check) => check.name === "Podman machine").ok, false);
});

test("Podman help explains prerequisites without installing the engine", () => {
  assert.match(podmanInstallHelp("linux"), /systemctl --user enable --now podman.socket/);
  assert.match(podmanInstallHelp("darwin"), /podman machine start/);
  assert.match(podmanInstallHelp("win32"), /Use Docker on Windows/);
});
