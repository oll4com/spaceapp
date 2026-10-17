import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import {
  assertEngineUnchanged, containerEngine, engineExecutor, engineInstallArgs,
  inspectContainerEngine, podmanChecks, selectContainerEngine
} from "../src/container-engine.mjs";
import {
  composeCommand, createDefaultConfig, initializeInstallation,
  loadConfig, prepareInstallation, renderHostAccessCompose, renderRuntimeEnv, renderWorkspaceCompose, saveConfig
} from "../src/index.mjs";
import { run } from "../src/cli.mjs";

const GiB = 1024 ** 3;
const info = {
  version: { Version: "5.8.7" },
  host: { security: { rootless: true }, cgroupVersion: "v2",
    cgroupControllers: ["cpu", "memory", "pids"], cpus: 8, memTotal: 16 * GiB },
  // Diagnostic output must not copy arbitrary engine metadata.
  registries: { privateCredential: "never-export-this" }
};
function mockEngine({ docker = false, metadata = info, compose = "2.24.0", machine = [] } = {}) {
  const calls = [];
  const execute = async (spec, io) => {
    calls.push(spec);
    if (spec.command === "docker" && spec.args[0] === "info") return docker ? 0 : 127;
    if (spec.command === "podman" && spec.args[0] === "info") {
      io?.stdout?.write(JSON.stringify(metadata)); return 0;
    }
    if (spec.command === "podman" && spec.args.slice(0, 2).join(" ") === "compose version") {
      io?.stdout?.write(compose); return 0;
    }
    if (spec.command === "podman" && spec.args[0] === "machine") {
      if (spec.args[1] === "list") {
        io?.stdout?.write(JSON.stringify(machine.map((item) => ({ Name: item.Name ?? "custom-machine", Running: item.State === "running", Default: true }))));
        return 0;
      }
      io?.stdout?.write(JSON.stringify(machine)); return 0;
    }
    return 0;
  };
  return { calls, execute };
}
function output() {
  let text = "";
  const stream = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
  return { stream, text: () => text };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mock = mockEngine();
  const out = output();
  return { root, out, ...mock, options: {
    platform: "linux", arch: "x64", env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
    stdin: Readable.from([]), stdout: out.stream, stderr: out.stream,
    execute: mock.execute, prepareDockerPath: async () => { throw new Error("must not prepare Docker for Podman"); },
    inspectResources: async () => ({ cpuCount: 8, totalMemoryBytes: 16 * GiB, freeDiskBytes: 30 * GiB }),
    request: async (url) => ({ ok: true, status: 200,
      json: async () => url.endsWith("/readyz") ? { ok: true } : { setupRequired: true, expiresAt: null } }),
    sleep: async () => {}
  } };
}

test("engine flags and unattended answers validate names without swallowing other flags", () => {
  assert.equal(containerEngine(), "docker");
  assert.throws(() => containerEngine("sh"), /docker or podman/);
  assert.deepEqual(engineInstallArgs(["--profile", "small", "--engine=podman"]), {
    requested: "podman", args: ["--profile", "small"]
  });
  assert.equal(engineInstallArgs(["--engine", "docker"], { engine: "podman" }).requested, "docker");
  assert.equal(engineInstallArgs([], { engine: "podman" }).requested, "podman");
  assert.throws(() => engineInstallArgs(["--engine", "--profile"]), /requires/);
});

test("Docker remains the default when ready; Podman fallback requires actual engine metadata", async () => {
  const docker = mockEngine({ docker: true });
  assert.equal(await selectContainerEngine({ platform: "linux", execute: docker.execute }), "docker");
  assert.equal(docker.calls.length, 1);
  const podman = mockEngine();
  assert.equal(await selectContainerEngine({ platform: "linux", execute: podman.execute }), "podman");
  assert.equal(await selectContainerEngine({ platform: "linux", execute: podman.execute, offer: async () => false }), "docker");
  assert.equal(await selectContainerEngine({ platform: "linux", execute: async () => 0 }), "docker");
  assert.equal(await selectContainerEngine({ platform: "win32", execute: async () => { throw new Error("no probes"); } }), "docker");
});

test("saved and explicit engines do not probe or silently switch engine namespaces", async () => {
  const execute = async () => { throw new Error("unexpected probe"); };
  assert.equal(await selectContainerEngine({ requested: "podman", execute }), "podman");
  assert.equal(await selectContainerEngine({ stored: { engine: "podman" }, execute }), "podman");
  assert.equal(await selectContainerEngine({ stored: {}, execute }), "docker");
  assert.throws(() => assertEngineUnchanged({}, "podman"), /do not share volumes/);
  assert.throws(() => assertEngineUnchanged({ engine: "podman" }, "docker"), /do not share volumes/);
});

test("a stopped macOS machine still offers the installed Podman CLI instead of installing Docker", async () => {
  let offers = 0;
  const execute = async (spec, io) => {
    if (spec.command === "podman" && spec.args[0] === "--version") {
      io.stdout.write("podman-remote version 5.8.7\n"); return 0;
    }
    return 127;
  };
  assert.equal(await selectContainerEngine({ platform: "darwin", execute, offer: async () => { offers += 1; return true; } }), "podman");
  assert.equal(offers, 1);
});

test("Podman capability checks fail early for old, rootful or undelegated engines and old providers", async () => {
  const good = await inspectContainerEngine(mockEngine().execute, "podman", { platform: "linux" });
  assert.ok(podmanChecks(good, { platform: "linux" }).every((check) => check.ok));
  assert.equal(podmanChecks(good, { platform: "darwin" }).find((check) => check.name === "Podman machine resources").ok, false);
  assert.ok(!JSON.stringify(good).includes("never-export-this"));
  for (const change of [{ version: "4.9.4" }, { rootless: false }, { cgroupVersion: "v1" },
    { cpuLimits: false }, { memoryLimits: false }, { composeVersion: "2.23.3" }, { composeVersion: null }]) {
    assert.ok(podmanChecks({ ...good, ...change }, { platform: "linux" }).some((check) => !check.ok), JSON.stringify(change));
  }
  assert.ok(podmanChecks({ ...good, composeVersion: "5.6.0" }, { platform: "linux" }).every((check) => check.ok));
  assert.equal((await inspectContainerEngine(mockEngine({ compose: "v2.38.2-desktop.1" }).execute, "podman", { platform: "linux" })).composeVersion, "2.38.2");
});

test("macOS machine resources are allowlisted, checked per profile, with resize instructions", async () => {
  const mock = mockEngine({ machine: [{ State: "running", Resources: { CPUs: 4, Memory: 7168, DiskSize: 20 }, SSHConfig: { IdentityPath: "private" } }] });
  const facts = await inspectContainerEngine(mock.execute, "podman", { platform: "darwin" });
  assert.ok(podmanChecks(facts, { platform: "darwin", profile: "small" }).every((check) => check.ok));
  const failure = podmanChecks(facts, { platform: "darwin", profile: "large" }).find((check) => !check.ok);
  assert.match(failure.detail, /podman machine set --cpus 8 --memory 15360/);
  assert.ok(!JSON.stringify(facts).includes("private"));
});

test("Podman executor starts only the user socket, once, and preserves command arrays and exit codes", async () => {
  const calls = [];
  const execute = engineExecutor(async (spec) => { calls.push(spec); return spec.args.includes("fail") ? 19 : 0; }, "podman", { platform: "linux" });
  await execute({ command: "docker", args: ["info"] });
  await execute({ command: "docker", args: ["compose", "up", "--wait"] });
  assert.equal(await execute({ command: "podman", args: ["compose", "fail"] }), 19);
  await execute({ command: "xdg-open", args: ["http://127.0.0.1:4911"] });
  assert.equal(calls.filter((spec) => spec.command === "systemctl").length, 1);
  assert.deepEqual(calls[1].args, ["--user", "start", "podman.socket"]);
  assert.deepEqual(calls[2], { command: "podman", args: ["compose", "up", "--wait"] });
  assert.equal(calls.at(-1).command, "xdg-open");
});

test("socket failures stop Compose and macOS never starts a Linux service", async () => {
  const calls = [];
  const execute = engineExecutor(async (spec) => { calls.push(spec); return 7; }, "podman", { platform: "linux" });
  assert.equal(await execute({ command: "docker", args: ["compose", "up"] }), 7);
  assert.equal(calls.length, 1);
  const mac = engineExecutor(async (spec) => { assert.equal(spec.command, "podman"); return 0; }, "podman", { platform: "darwin" });
  assert.equal(await mac({ command: "docker", args: ["compose", "up"] }), 0);
});

test("every Compose action retains Docker arguments on Podman, including profiles and numeric users", () => {
  for (const action of ["up", "down", "status", "logs", "pull", "backup", "installProvider", "purge", "databaseSize", "ensureCheckpointDatabase", "checkpointDump", "checkpointRestore"]) {
    const options = { profile: "large", provider: "opencode" };
    const docker = composeCommand(action, "/tmp/spaceapp-test", options);
    const podman = composeCommand(action, "/tmp/spaceapp-test", { ...options, engine: "podman" });
    assert.equal(podman.command, "podman");
    assert.deepEqual(podman.args, docker.args);
    assert.ok(podman.args.includes("standard"));
  }
  assert.ok(composeCommand("installProvider", "/tmp/spaceapp-test", { engine: "podman", provider: "opencode" }).args.includes("10001:10001"));
});

test("Podman config is persisted and legacy Docker roots cannot be switched", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.1.5", engine: "podman" });
  assert.equal((await loadConfig(f.root)).engine, "podman");
  const before = await readFile(join(f.root, "config.json"), "utf8");
  await assert.rejects(prepareInstallation(f.root, { version: "1.1.5", engine: "docker" }), /Switching container engines/);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), before);
  assert.throws(() => createDefaultConfig({ version: "1.1.5", engine: "podman", accessMode: "host-root" }), /not supported with Podman/);
});

test("Podman selection and a consented install ID survive config reload and upgrade preparation", async (t) => {
  const f = await fixture(t);
  const installId = "synthetic-install-116";
  const config = { ...createDefaultConfig({ version: "1.1.5", engine: "podman" }), telemetry: true, installId };
  await saveConfig(f.root, config);
  assert.deepEqual(await loadConfig(f.root), config);
  const next = await prepareInstallation(f.root, { version: "1.1.6", engine: "podman" });
  assert.equal(next.config.engine, "podman");
  assert.equal(next.config.installId, installId);
  assert.equal(next.config.telemetry, true);
  assert.match(renderRuntimeEnv(next.config), /^SPACEAPP_INSTALL_ID=synthetic-install-116$/m);
});

test("workspace overrides preserve read-only flags, share SELinux labels and map the host owner without chown", () => {
  const config = createDefaultConfig({ version: "1.1.5", engine: "podman" });
  config.workspaces = [{ id: "source-1234abcd", name: "source", hostPath: "/tmp/project", containerPath: "/workspaces/source", readOnly: true }];
  const mounts = renderWorkspaceCompose(config);
  assert.match(mounts, /read_only: true/);
  assert.match(mounts, /selinux: z/);
  assert.match(mounts, /create_host_path: true/);
  assert.match(renderHostAccessCompose(config), /keep-id:uid=10001,gid=10001/);
  assert.doesNotMatch(mounts, /:U|chown/);
});

test("unattended explicit Podman install persists engine and never invokes Docker", async (t) => {
  const f = await fixture(t);
  assert.equal(await run(["install", "--engine", "podman", "--non-interactive", "--answers",
    JSON.stringify({ confirm: true, profile: "small", access: "isolated", open: false, telemetry: false })], f.options), 0);
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.ok(f.calls.some((spec) => spec.command === "podman" && spec.args.includes("up")));
  assert.ok(!f.calls.some((spec) => spec.command === "docker"));
  assert.equal(await run(["status"], f.options), 0);
  assert.equal(f.calls.at(-1).command, "podman");
});

test("engine in answers works; host-root refusal precedes all runtime calls", async (t) => {
  const f = await fixture(t);
  await assert.rejects(run(["install", "--non-interactive", "--answers",
    JSON.stringify({ confirm: true, engine: "podman", profile: "small", access: "host-root", open: false })], f.options), /not supported with Podman/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(join(f.root, "config.json")), { code: "ENOENT" });
});

test("unattended fallback persists Podman without offering to install Docker", async (t) => {
  const f = await fixture(t);
  let prepared = 0;
  f.options.prepareDockerPath = async () => { prepared += 1; };
  assert.equal(await run(["install", "--non-interactive", "--answers",
    '{"confirm":true,"profile":"small","access":"isolated","open":false}'], f.options), 0);
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.equal(prepared, 1);
  assert.ok(f.calls.some((spec) => spec.command === "docker" && spec.args[0] === "info"));
  assert.ok(!f.calls.some((spec) => spec.command === "docker" && spec.args[0] === "compose"));
});

test("support bundle uses saved engine and exports no raw private engine metadata", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.1.5", engine: "podman" });
  const path = join(f.root, "support.json");
  assert.equal(await run(["support-bundle", "--out", path], f.options), 0);
  const text = await readFile(path, "utf8");
  assert.equal(JSON.parse(text).containerEngine.name, "podman");
  assert.equal(JSON.parse(text).containerEngine.memoryLimits, true);
  assert.ok(!text.includes("never-export-this"));
  assert.ok(!f.calls.some((spec) => spec.command === "docker"));
});

test("provider install opencode verifies the bundled executable instead of an unsupported optional install", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.1.5", engine: "podman" });
  assert.equal(await run(["provider", "install", "opencode"], f.options), 0);
  assert.equal(f.calls.at(-1).command, "podman");
  assert.deepEqual(f.calls.at(-1).args.slice(-5), ["--user", "10001:10001", "spaceapp-cli", "opencode", "--version"]);
});

test("an explicit Docker selection is persisted even on a legacy Docker root", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.1.5" });
  const result = await prepareInstallation(f.root, { version: "1.1.5", engine: "docker" });
  assert.equal(result.config.engine, "docker");
});

test("automatic host-root setup on a Podman-only host stops instead of installing Docker", async (t) => {
  const f = await fixture(t);
  f.options.prepareDockerPath = async () => {};
  f.options.execute = async (spec, io) => spec.command === "docker" ? 127 : f.execute(spec, io);
  assert.equal(await run(["install", "--non-interactive", "--answers",
    '{"confirm":true,"profile":"small","access":"host-root","open":false}'], f.options), 1);
  assert.match(f.out.text(), /No Docker installation was attempted/);
  assert.ok(!f.calls.some((spec) => ["sudo", "apt-get", "dnf"].includes(spec.command)));
  await assert.rejects(readFile(join(f.root, "config.json")), { code: "ENOENT" });
});

test("factory reset retains the saved engine for the next lifecycle command", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.1.5", engine: "podman" });
  assert.equal(await run(["factory-reset"], { ...f.options, stdin: Readable.from(["FACTORY-RESET\n"]) }), 0);
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.equal(await run(["status"], f.options), 0);
  assert.equal(f.calls.at(-1).command, "podman");
});
