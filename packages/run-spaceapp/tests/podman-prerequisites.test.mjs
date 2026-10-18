import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as prerequisites from "../src/prerequisites.mjs";

const GiB = 1024 ** 3;
const version = { Client: { Version: "5.0.0" }, Server: { Version: "5.0.0" } };
const info = {
  host: { arch: "amd64", cpus: 4, memTotal: 8 * GiB, cgroupVersion: "v2",
    cgroupControllers: ["cpu", "memory", "pids"], serviceIsRemote: false,
    security: { rootless: true }, hostname: "secret-hostname" },
  version: { Version: "5.0.0" },
  store: { graphRootAllocated: 30 * GiB, graphRootUsed: 10 * GiB,
    graphRoot: "/",
    configFile: "/home/private-user/.config/containers/storage.conf" },
  registries: { "private-registry.example": { token: "secret-token" } }
};

function fixture(options = {}) {
  const calls = [];
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
  const execute = async (spec, io) => {
    calls.push(spec);
    assert.equal(spec.command, "podman");
    let text;
    if (spec.args[0] === "version") text = JSON.stringify(options.version ?? version);
    else if (spec.args[0] === "info") text = options.infoText ?? JSON.stringify(options.info ?? info);
    else if (spec.args.join(" ") === "compose version") {
      assert.deepEqual(spec.env, { PODMAN_COMPOSE_PROVIDER: "docker-compose" });
      text = options.compose ?? "Docker Compose version v2.24.4";
    } else if (spec.args.join(" ") === "compose up --help") {
      assert.deepEqual(spec.env, { PODMAN_COMPOSE_PROVIDER: "docker-compose" });
      text = options.help ?? "--wait Wait for services\n--wait-timeout SECONDS";
    } else if (spec.args.join(" ") === "compose ls --format json") {
      assert.deepEqual(spec.env, { PODMAN_COMPOSE_PROVIDER: "docker-compose" });
      if (options.socketUnavailable) return 1;
      text = options.projects ?? "[]";
    } else if (spec.args.join(" ") === "machine list --format json") {
      text = JSON.stringify(options.machines ?? []);
    } else if (spec.args[0] === "machine" && spec.args[1] === "ssh") {
      assert.deepEqual(spec.args, ["machine", "ssh", "spaceapp-vm", "df", "-Pk", "--", (options.info ?? info).store.graphRoot]);
      text = options.dfText ?? "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda4 31457280 10485760 10485760 50% /";
    } else assert.fail(`Unexpected prerequisite command: ${spec.args.join(" ")}`);
    if (options.unavailable === spec.args[0]) return 127;
    io.stdout.write(text);
    return 0;
  };
  return { calls, execute, stream, text: () => output };
}

async function ensure(options = {}) {
  assert.equal(typeof prerequisites.ensurePodmanAvailable, "function", "Podman prerequisite helper is exported");
  const f = fixture(options);
  const result = await prerequisites.ensurePodmanAvailable({ platform: "linux", execute: f.execute,
    stdout: f.stream, stderr: f.stream, ...options.ensure });
  return { ...f, result };
}

test("rootless Podman facts are normalized without registry, identity or host details", async () => {
  assert.equal(typeof prerequisites.probeEngineInfo, "function", "Engine probe is exported");
  const f = fixture();
  const result = await prerequisites.probeEngineInfo({ engine: "podman", platform: "linux", execute: f.execute });
  assert.equal(result.available, true);
  assert.equal(result.cliVersion, "5.0.0");
  assert.equal(result.version, "5.0.0");
  assert.equal(result.composeProvider, "docker-compose");
  assert.equal(result.composeVersion, "2.24.4");
  assert.equal(result.rootless, true);
  assert.equal(result.cgroupVersion, "v2");
  assert.equal(result.cpuLimitDelegated, true);
  assert.equal(result.memoryLimitDelegated, true);
  assert.equal(result.cpuCount, 4);
  assert.equal(result.memoryBytes, 8 * GiB);
  assert.ok(result.freeDiskBytes > 0);
  assert.equal(result.architecture, "amd64");
  assert.equal(result.machine, null);
  assert.equal(result.checks.every(check => check.ok), true);
  assert.doesNotMatch(JSON.stringify(result), /secret|private-user|private-registry/);
});

test("valid Podman prerequisites require no engine installation or reexecution", async () => {
  const { result, calls } = await ensure();
  assert.equal(result.code, 0);
  assert.equal(result.reexecuted, false);
  assert.equal(calls.some(spec => spec.args.includes("start") || spec.args.includes("install")), false);
});

for (const [name, options, expected] of [
  ["missing CLI", { unavailable: "version" }, /Podman CLI/],
  ["old CLI", { version: { ...version, Client: { Version: "4.9.4" } } }, /Podman CLI/],
  ["old server", { info: { ...info, version: { Version: "4.9.4" } } }, /Podman Engine/],
  ["old Compose provider", { compose: "Docker Compose version v2.24.3" }, /Compose/],
  ["wrong Compose provider", { compose: "podman-compose version 2.24.4" }, /Compose/],
  ["missing wait support", { help: "--detach" }, /wait/],
  ["rootful engine", { info: { ...info, host: { ...info.host, security: { rootless: false } } } }, /rootless/i],
  ["cgroup v1", { info: { ...info, host: { ...info.host, cgroupVersion: "v1" } } }, /cgroup/i],
  ["missing CPU delegation", { info: { ...info, host: { ...info.host, cgroupControllers: ["memory"] } } }, /CPU/],
  ["missing memory delegation", { info: { ...info, host: { ...info.host, cgroupControllers: ["cpu"] } } }, /memory/i],
  ["remote Linux engine", { info: { ...info, host: { ...info.host, serviceIsRemote: true } } }, /local/i],
  ["malformed info", { infoText: "private-token: broken JSON" }, /Podman Engine/]
]) test(`${name} is rejected before launching the stack`, async () => {
  const { result, text } = await ensure(options);
  assert.equal(result.code, 1);
  assert.match(text(), expected);
  assert.doesNotMatch(text(), /private-token|private-user|secret-token/);
});

test("Windows rejects Podman without executing commands", async () => {
  const { result, calls } = await ensure({ ensure: { platform: "win32" } });
  assert.equal(result.code, 1);
  assert.deepEqual(calls, []);
});

test("macOS checks the running default machine instead of its conventional name", async () => {
  const { result } = await ensure({
    info: { ...info, host: { ...info.host, serviceIsRemote: true } },
    machines: [
      { Name: "podman-machine-default", Default: false, Running: false, CPUs: 1, Memory: String(GiB), DiskSize: String(10 * GiB), VMType: "qemu" },
      { Name: "spaceapp-vm", Default: true, Running: true, CPUs: 4, Memory: String(8 * GiB), DiskSize: String(30 * GiB), VMType: "applehv", IdentityPath: "/private/key" }
    ], ensure: { platform: "darwin" }
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.engineInfo.machine, { name: "spaceapp-vm", running: true, cpus: 4,
    memoryBytes: 8 * GiB, diskBytes: 30 * GiB, vmType: "applehv" });
  assert.doesNotMatch(JSON.stringify(result), /private\/key/);
});

for (const [name, store] of [["zero", { graphRoot: "/tmp", graphRootAllocated: 10 * GiB, graphRootUsed: 10 * GiB }], ["unknown", {}], ["invalid", { graphRootAllocated: -1, graphRootUsed: 0 }]]) {
  test(`macOS ${name} guest free disk is rejected even with a large VM capacity`, async () => {
    const { result, text } = await ensure({ info: { ...info, store }, ensure: { platform: "darwin" },
      ...(name === "zero" ? { dfText: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda4 10485760 10485760 0 100% /" } : {}),
      machines: [{ Name: "spaceapp-vm", Default: true, Running: true, CPUs: 4, Memory: String(8 * GiB), DiskSize: String(100 * GiB), VMType: "qemu" }] });
    assert.equal(result.code, 1);
    assert.equal(result.engineInfo.freeDiskBytes, name === "zero" ? 0 : null);
    assert.match(text(), /disk|storage/i);
  });
}

test("automatic profile defers VM allocation thresholds but an explicit small profile rejects them", async () => {
  const options = { info: { ...info, host: { ...info.host, cpus: 2, memTotal: 2 * GiB } } };
  assert.equal((await ensure({ ...options, ensure: { profile: "auto" } })).result.code, 0);
  assert.equal((await ensure(options)).result.code, 1);
});

test("oversized engine JSON is unavailable and never included in diagnostics", async () => {
  const { result, text } = await ensure({ infoText: JSON.stringify({ ...info, secret: "private-token".repeat(100_000) }) });
  assert.equal(result.code, 1);
  assert.equal(result.engineInfo.available, false);
  assert.doesNotMatch(text(), /private-token/);
});

test("Docker diagnostics normalize its own schema without Podman requirements", async () => {
  assert.equal(typeof prerequisites.probeEngineInfo, "function", "Engine probe is exported");
  const calls = [];
  const result = await prerequisites.probeEngineInfo({ engine: "docker", platform: "linux", execute: async (spec, io) => {
    calls.push(spec);
    assert.equal(spec.command, "docker");
    if (spec.args[0] === "--version") io.stdout.write("Docker version 27.5.1, build abcdef");
    else if (spec.args[0] === "compose") io.stdout.write("Docker Compose version v2.24.4");
    else if (spec.args[0] === "info") io.stdout.write(JSON.stringify({ ServerVersion: "27.5.1", Architecture: "aarch64", NCPU: 8,
      MemTotal: 16 * GiB, CgroupVersion: "2", SecurityOptions: ["name=rootless"], CpuCfsQuota: true, CpuCfsPeriod: true, MemoryLimit: true }));
    else assert.fail("Unexpected Docker probe");
    return 0;
  } });
  assert.equal(result.engine, "docker");
  assert.equal(result.available, true);
  assert.equal(result.rootless, true);
  assert.equal(result.architecture, "arm64");
  assert.equal(result.cpuLimitDelegated, true);
  assert.equal(result.memoryLimitDelegated, true);
  assert.equal(result.checks.every(check => check.ok), true);
  assert.equal(calls.some(spec => spec.env), false);
});

test("cgroup v1 cannot report CPU or memory limits as delegated", async () => {
  const { result } = await ensure({ info: { ...info, host: { ...info.host, cgroupVersion: "v1" } } });
  assert.equal(result.engineInfo.cpuLimitDelegated, false);
  assert.equal(result.engineInfo.memoryLimitDelegated, false);
});

test("malformed versions cannot overflow the minimum-version comparison", async () => {
  const { result } = await ensure({ version: { ...version, Client: { Version: `${"9".repeat(400)}.0.0` } } });
  assert.equal(result.code, 1);
  assert.equal(result.engineInfo.cliVersion, null);
});

test("an old remote server cannot be hidden by a newer info version", async () => {
  const { result } = await ensure({ version: { ...version, Server: { Version: "4.9.4" } } });
  assert.equal(result.code, 1);
});

test("malformed Docker security options do not crash diagnostics", async () => {
  const result = await prerequisites.probeEngineInfo({ execute: async (spec, io) => {
    if (spec.args[0] === "info") io.stdout.write(JSON.stringify({ ServerVersion: "27.5.1", SecurityOptions: [null, {}] }));
    else io.stdout.write("Docker version 27.5.1");
    return 0;
  } });
  assert.equal(result.rootless, false);
});

test("a local graph root measures available filesystem bytes instead of VM allocation", { skip: process.platform === "win32" }, async t => {
  const graphRoot = await mkdtemp(join(tmpdir(), "spaceapp-podman-probe-"));
  t.after(() => rm(graphRoot, { recursive: true, force: true }));
  const fs = await statfs(graphRoot);
  const { result } = await ensure({ info: { ...info, store: { graphRoot } } });
  // Other tests can allocate a few blocks concurrently on this filesystem.
  assert.ok(Math.abs(result.engineInfo.freeDiskBytes - Number(fs.bavail) * Number(fs.bsize)) < 16 * 1024 ** 2);
  assert.equal(result.engineInfo.freeDiskBytes > 0, true);
  assert.doesNotMatch(JSON.stringify(result.engineInfo), /spaceapp-podman-probe-/);
});

test("macOS refuses an ambiguous default machine", async () => {
  const machine = { Name: "vm-one", Default: true, Running: true, CPUs: 4, Memory: String(8 * GiB), DiskSize: String(20 * GiB), VMType: "qemu" };
  const { result } = await ensure({ machines: [machine, { ...machine, Name: "vm-two" }], ensure: { platform: "darwin" } });
  assert.equal(result.code, 1);
  assert.equal(result.engineInfo.machine, null);
});

for (const [name, dfText, expected] of [
  ["reserved blocks", "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda4 31457280 10485760 10485760 50% /", 10 * GiB],
  ["zero available blocks", "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda4 31457280 10485760 0 100% /", 0],
  ["unavailable measurement", "df: private-token unavailable", null]
]) test(`macOS guest disk uses actual available space with ${name}`, async () => {
  const { result } = await ensure({ info: { ...info, store: { ...info.store, graphRoot: "/var/home/core/.local/share/containers/storage" } },
    machines: [{ Name: "spaceapp-vm", Default: true, Running: true, CPUs: 4, Memory: String(8 * GiB), DiskSize: String(30 * GiB), VMType: "qemu" }],
    dfText, ensure: { platform: "darwin" } });
  assert.equal(result.engineInfo.freeDiskBytes, expected);
  assert.equal(result.code, expected > 0 ? 0 : 1);
});

test("a graph-root shell fragment cannot enter the machine SSH command", async () => {
  const { result, calls } = await ensure({ info: { ...info, store: { ...info.store, graphRoot: "/var/home/core;touch /tmp/unsafe" } },
    machines: [{ Name: "spaceapp-vm", Default: true, Running: true, CPUs: 4, Memory: String(8 * GiB), DiskSize: String(30 * GiB), VMType: "qemu" }],
    ensure: { platform: "darwin" } });
  assert.equal(result.engineInfo.freeDiskBytes, null);
  assert.equal(result.code, 1);
  assert.equal(calls.some(spec => spec.args[1] === "ssh"), false);
});

test("inaccessible Linux storage cannot use a Bfree estimate as usable space", async () => {
  const { result } = await ensure({ info: { ...info, store: { ...info.store, graphRoot: "/spaceapp-does-not-exist-for-probe-test" } } });
  assert.equal(result.engineInfo.freeDiskBytes, null);
  assert.equal(result.code, 1);
});

test("a stopped rootless API socket fails before pulling images", async () => {
  const { result, calls, text } = await ensure({ socketUnavailable: true });
  assert.equal(result.code, 1);
  assert.equal(calls.some(spec => spec.args.includes("pull") || spec.args.includes("start")), false);
  assert.match(text(), /systemctl --user start podman\.socket/);
});

test("invalid provider API output cannot pass socket readiness or enter diagnostics", async () => {
  const { result, text } = await ensure({ projects: '{"secret-project":"private-name"}' });
  assert.equal(result.code, 1);
  assert.doesNotMatch(text(), /secret-project|private-name/);
});

test("a machine-name shell fragment cannot enter the machine SSH command", async () => {
  const { result, calls } = await ensure({ machines: [{ Name: "vm;touch-unsafe", Default: true, Running: true,
    CPUs: 4, Memory: String(8 * GiB), DiskSize: String(20 * GiB), VMType: "qemu" }], ensure: { platform: "darwin" } });
  assert.equal(result.code, 1);
  assert.equal(result.engineInfo.machine, null);
  assert.equal(calls.some(spec => spec.args[1] === "ssh"), false);
});
