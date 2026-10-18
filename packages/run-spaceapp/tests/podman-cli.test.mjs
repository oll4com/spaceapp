import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { executeCommand, run } from "../src/cli.mjs";
import { addWorkspace, createDefaultConfig, initializeInstallation, loadConfig, saveConfig } from "../src/index.mjs";

const GiB = 1024 ** 3;
const resources = { cpuCount: 8, totalMemoryBytes: 32 * GiB, freeDiskBytes: 100 * GiB };
function capture() {
  let text = "";
  const stream = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
  return { stream, text: () => text };
}
async function fixture(t, { dockerMissing = false, engineCpuCount = 8, engineMemoryBytes = 32 * GiB } = {}) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const stdout = capture(), stderr = capture();
  const execute = async (spec, io = {}) => {
    calls.push(spec);
    if (spec.command === "docker" && dockerMissing) return 127;
    let output = "";
    if (spec.args[0] === "--version") output = "podman version 5.7.0";
    if (spec.args[0] === "version") output = JSON.stringify({ Client: { Version: "5.7.0" }, Server: { Version: "5.7.0" } });
    if (spec.args[0] === "info") output = JSON.stringify({
      version: { Version: "5.7.0" },
      host: { arch: "amd64", cpus: engineCpuCount, memTotal: engineMemoryBytes, serviceIsRemote: false, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"], security: { rootless: true } },
      store: { graphRoot: "/", graphRootAllocated: 100 * GiB, graphRootUsed: GiB }
    });
    if (spec.args[0] === "machine" && spec.args[1] === "list") output = JSON.stringify([{ Name: "synthetic-vm", Default: true, Running: true, CPUs: engineCpuCount, Memory: engineMemoryBytes, DiskSize: 100 * GiB, VMType: "qemu" }]);
    if (spec.args[0] === "machine" && spec.args[1] === "ssh") output = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda4 104857600 1048576 103809024 1% /";
    if (spec.args[0] === "compose" && spec.args.includes("version")) output = "Docker Compose version v2.38.2";
    if (spec.args[0] === "compose" && spec.args[1] === "ls") output = "[]";
    if (spec.args[0] === "compose" && spec.args.includes("--help")) output = "--wait  Wait for services to be running|healthy --wait-timeout timeout";
    if (spec.args[0] === "image" && spec.args.includes("inspect")) output = spec.args.includes("{{.Id}}") ? "a".repeat(64) : "[]";
    if (spec.args[0] === "system" && spec.args[1] === "df") output = "[]";
    if (spec.args.includes("psql") && spec.args.some(arg => arg.includes("pg_database_size"))) output = "1024";
    if (spec.args.includes("pg_dump")) output = "synthetic database dump";
    if (output) io.stdout?.write(`${output}\n`);
    return 0;
  };
  let podmanPrerequisites = 0;
  const options = {
    env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" }, platform: "linux",
    stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream,
    execute, inspectResources: async () => resources, prepareDockerPath: async () => {},
    ensureDocker: async () => { throw new Error("Docker bootstrap must not run for Podman"); },
    ensurePodman: async () => { podmanPrerequisites++; return { code: 0, reexecuted: false }; },
    request: async (url) => new Response(JSON.stringify(url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null }), { status: 200 }),
    sleep: async () => {}
  };
  return { root, calls, options, stdout, stderr, podmanPrerequisites: () => podmanPrerequisites };
}
function installArgs(extra = [], answers = {}) {
  return ["install", "--profile", "small", "--no-open", "--non-interactive", "--answers",
    JSON.stringify({ confirm: true, telemetry: false, open: false, ...answers }), ...extra];
}

test("explicit Podman install persists engine and never bootstraps Docker", async (t) => {
  const f = await fixture(t);
  assert.equal(await run(installArgs(["--engine", "podman"]), f.options), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.equal(f.podmanPrerequisites(), 1);
  const lifecycle = f.calls.filter((spec) => spec.args.includes("compose") && !spec.args.includes("version") && !spec.args.includes("--help"));
  assert.ok(lifecycle.length > 0);
  assert.ok(lifecycle.every((spec) => spec.command === "podman"));
  assert.ok(lifecycle.every((spec) => spec.env?.PODMAN_COMPOSE_PROVIDER === "docker-compose"));
});

test("answers can select Podman even when Docker is installed", async (t) => {
  const f = await fixture(t);
  assert.equal(await run(installArgs([], { engine: "podman" }), f.options), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine, "podman");
});

test("noninteractive fresh install selects available Podman instead of installing absent Docker", async (t) => {
  const f = await fixture(t, { dockerMissing: true });
  assert.equal(await run(installArgs(), f.options), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine, "podman");
});

test("a legacy Docker installation refuses an engine switch before commands or config repair", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.1.5" });
  const before = await readFile(join(f.root, "config.json"), "utf8");
  await assert.rejects(run(installArgs(["--engine", "podman"]), f.options), /switch|different engine|migration/i);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), before);
  assert.equal(f.calls.length, 0);
});

test("Podman host-root is refused before creating installation state", async (t) => {
  const f = await fixture(t);
  const root = join(f.root, "uncreated");
  await assert.rejects(run(installArgs(["--engine", "podman", "--access", "host-root"]), {
    ...f.options, env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" }
  }), /Podman.*host-root|host-root.*Podman/i);
  await assert.rejects(stat(root), { code: "ENOENT" });
  assert.equal(f.calls.length, 0);
});

test("stored Podman engine controls lifecycle commands without a repeated flag", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.5", profile: "small" });
  for (const command of ["up", "down", "status", "logs", "backup"]) {
    assert.equal(await run([command], { ...f.options, stdin: Readable.from([]) }), 0);
  }
  assert.equal(f.calls.length, 5);
  assert.ok(f.calls.every((spec) => spec.command === "podman" && spec.args.includes(join(f.root, "compose.engine.yml"))));
});


test("fresh selection retains a working Docker engine", async (t) => {
  const f = await fixture(t);
  let dockerPrerequisites = 0;
  assert.equal(await run(installArgs(), { ...f.options, ensureDocker: async () => { dockerPrerequisites++; return { code: 0 }; } }), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine ?? "docker", "docker");
  assert.equal(dockerPrerequisites, 1);
  assert.equal(f.podmanPrerequisites(), 0);
});

test("Podman Windows and invalid engine answers fail before probes or state writes", async (t) => {
  const f = await fixture(t);
  for (const [args, platform, pattern] of [
    [installArgs(["--engine=podman"]), "win32", /Podman.*Windows|Windows.*Podman/i],
    [installArgs([], {engine: "sh"}), "linux", /engine.*docker.*podman/i],
    [installArgs([], {engine: null}), "linux", /engine.*docker.*podman/i]
  ]) {
    await assert.rejects(run(args, { ...f.options, platform }), pattern);
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(stat(join(f.root, "config.json")), { code: "ENOENT" });
});

test("switch refusal precedes repair of incomplete legacy configuration", async (t) => {
  const f = await fixture(t);
  const raw = '{"version":"1.1.5"}';
  await writeFile(join(f.root, "config.json"), raw);
  await assert.rejects(run(installArgs([], {engine:"podman"}), f.options), /switch|migration/i);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), raw);
  assert.equal(f.calls.length, 0);
});

test("Podman local-images skips pull and disables startup downloads", async (t) => {
  const f = await fixture(t);
  assert.equal(await run(installArgs(["--engine=podman", "--local-images"]), f.options), 0, f.stderr.text());
  assert.ok(!f.calls.some(spec => spec.args.at(-1) === "pull"));
  const up = f.calls.find(spec => spec.args.includes("up") && !spec.args.includes("--help"));
  assert.equal(up.command, "podman");
  assert.ok(up.args.includes("never"));
});

test("doctor and support bundle report sanitized Podman facts", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.5", profile: "small" });
  assert.equal(await run(["doctor"], f.options), 0, f.stderr.text());
  assert.match(f.stdout.text(), /Podman.*5\.7\.0/);
  assert.match(f.stdout.text(), /Podman rootless.*Rootless/);
  assert.match(f.stdout.text(), /Podman cgroup.*v2/);
  assert.match(f.stdout.text(), /Podman CPU delegation.*available/);
  assert.match(f.stdout.text(), /Podman memory delegation.*available/);
  const destination = join(f.root, "support.json");
  assert.equal(await run(["support-bundle", "--out", destination], f.options), 0);
  const bundle = JSON.parse(await readFile(destination, "utf8"));
  assert.equal(bundle.engine.engine, "podman");
  assert.equal(bundle.engine.rootless, true);
  assert.equal(bundle.engine.cgroupVersion, "v2");
  assert.equal(bundle.engine.cpuLimitDelegated, true);
  assert.equal(bundle.engine.memoryLimitDelegated, true);
  assert.equal(bundle.engine.version, "5.7.0");
  assert.ok(!JSON.stringify(bundle).includes("/synthetic/podman"));
  assert.ok(!f.calls.some(spec => spec.command === "docker"));
});

test("doctor retains a valid stored Podman engine when unrelated configuration needs repair", async (t) => {
  const f = await fixture(t);
  const raw = JSON.stringify({ ...createDefaultConfig({ engine: "podman", version: "1.1.5", profile: "small" }),
    schemaVersion: 3, companionsEnabled: "false" });
  await writeFile(join(f.root, "config.json"), raw);
  assert.equal(await run(["doctor"], f.options), 1);
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every(spec => spec.command === "podman"));
  assert.match(f.stderr.text(), /FAIL Configuration:.*doctor --fix/);
  assert.match(f.stdout.text(), /Podman 5\.7\.0; rootless; cgroup v2; CPU delegation available; memory delegation available/);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), raw);
  assert.equal(f.podmanPrerequisites(), 0);
});

test("doctor refuses an unknown stored engine before executing commands", async (t) => {
  const f = await fixture(t);
  const raw = JSON.stringify({ ...createDefaultConfig({ version: "1.1.5", profile: "small" }), engine: "sh" });
  await writeFile(join(f.root, "config.json"), raw);
  await assert.rejects(run(["doctor"], f.options), /engine.*docker.*podman/i);
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), raw);
});

test("failed fresh Podman startup diagnoses and stops the attempted engine", async (t) => {
  const f = await fixture(t);
  const execute = async (spec, io) => {
    if (spec.args.includes("up") && !spec.args.includes("--help")) { f.calls.push(spec); return 9; }
    return f.options.execute(spec, io);
  };
  assert.equal(await run(installArgs(["--engine=podman"]), { ...f.options, execute }), 9);
  const runtime = f.calls.filter(spec => spec.args.includes("compose") && !spec.args.includes("version") && !spec.args.includes("--help"));
  assert.ok(runtime.some(spec => spec.args.includes("down")));
  assert.ok(runtime.some(spec => spec.args.includes("logs")));
  assert.ok(runtime.every(spec => spec.command === "podman"));
  await assert.rejects(stat(join(f.root, "config.json")), { code: "ENOENT" });
});

test("Podman update checkpoints the engine override and recovery retains the engine", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.5", profile: "small" });
  const execute = async (spec, io) => {
    if (spec.args.includes("up") && !spec.args.includes("--help") && !spec.args.includes("--wait")) { f.calls.push(spec); return 9; }
    return f.options.execute(spec, io);
  };
  assert.equal(await run(["update", "1.1.6", "--non-interactive", "--answers", '{"confirm":true}'], { ...f.options, execute }), 1);
  const checkpoints = await readdir(join(f.root, "checkpoints"));
  assert.equal(checkpoints.length, 1);
  const checkpoint = join(f.root, "checkpoints", checkpoints[0]);
  const manifest = JSON.parse(await readFile(join(checkpoint, "manifest.json"), "utf8"));
  assert.ok(manifest.files.some(file => file.path === "compose.engine.yml"));
  const recovery = JSON.parse(await readFile(join(checkpoint, "recovery.json"), "utf8"));
  assert.equal(recovery.databasePreserved, true);
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.ok(f.calls.every(spec => spec.command === "podman"));
});

async function workspaceFixture(t) {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.5", profile: "small" });
  let config = await loadConfig(f.root);
  for (const [name, readOnly] of [["rw notes", false], ["ro", true]]) {
    const path = join(f.root, name);
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "input"), "private fixture", { mode: 0o600 });
    config = await addWorkspace(config, path, { readOnly });
  }
  await saveConfig(f.root, config);
  return { ...f, config };
}

test("Podman prepares exact shared labels on the server with read-only mounts before Compose", async (t) => {
  const f = await workspaceFixture(t);
  assert.equal(await run(["up"], f.options), 0);
  const probe = f.calls.find(spec => spec.args[0] === "run");
  assert.ok(probe, "a native mount check must precede compatible container creation");
  assert.ok(f.calls.indexOf(probe) < f.calls.findIndex(spec => spec.args[0] === "compose"));
  for (const flag of ["--rm", "--read-only", "--no-healthcheck"]) assert.ok(probe.args.includes(flag));
  for (const [flag, value] of [["--pull", "missing"], ["--network", "none"], ["--cap-drop", "ALL"], ["--user", "10001:10001"], ["--entrypoint", "node"]]) assert.equal(probe.args[probe.args.indexOf(flag) + 1], value);
  assert.ok(probe.args.includes("ghcr.io/oll4com/spaceapp-core:1.1.5"));
  for (const [index, workspace] of f.config.workspaces.entries()) {
    const field = `"source=${workspace.hostPath.replaceAll('"', '""')}"`;
    assert.ok(probe.args.includes(`type=bind,${field},target=/workspace-check/${index},ro=true,relabel=shared`));
    if (process.platform !== "win32") {
      assert.equal((await stat(workspace.hostPath)).mode & 0o777, 0o700);
      assert.equal((await stat(join(workspace.hostPath, "input"))).mode & 0o777, 0o600);
      assert.equal((await stat(workspace.hostPath)).uid, process.getuid());
    }
  }
  const name = probe.args[probe.args.indexOf("--name") + 1];
  assert.match(name, /^spaceapp-workspace-check-[a-f0-9-]+$/);
  assert.deepEqual(f.calls.find(spec => spec.args[0] === "rm").args, ["rm", "--force", "--ignore", name]);
  // A synthetic server-side path tests allowed delimiters without Windows-invalid filenames.
  const specialSource = join(f.root, "notes:=project");
  await saveConfig(f.root, { ...f.config, workspaces: [{ ...f.config.workspaces[0], hostPath: specialSource }] });
  const beforeSpecial = f.calls.length;
  assert.equal(await run(["up"], f.options), 0);
  const specialProbe = f.calls.slice(beforeSpecial).find(spec => spec.args[0] === "run");
  assert.ok(specialProbe.args.includes(`type=bind,"source=${specialSource.replaceAll('"', '""')}",target=/workspace-check/0,ro=true,relabel=shared`));
  for (const suffix of [",U=true", '"', "\r", "\n"]) {
    const hostPath = `${f.config.workspaces[0].hostPath}${suffix}`;
    await assert.rejects(addWorkspace(f.config, hostPath), /Podman compatibility API.*workspace paths/i);
    // Older hand-edited state must also fail before any native relabel or Compose creation.
    await saveConfig(f.root, { ...f.config, workspaces: [{ ...f.config.workspaces[0], hostPath }] });
    const calls = f.calls.length;
    await assert.rejects(run(["up"], f.options), /Podman compatibility API.*workspace paths/i);
    assert.equal(f.calls.length, calls);
  }
  for (const command of ["down", "status"]) assert.equal(await run([command], f.options), 0);
});

test("workspace check uses the staged candidate runtime during an existing-install upgrade", async (t) => {
  const f = await workspaceFixture(t);
  assert.equal(await run(installArgs(["--engine", "podman"]), { ...f.options, runtimeVersion: "1.1.6" }), 0, f.stderr.text());
  const probes = f.calls.filter(spec => spec.args[0] === "run");
  assert.equal(probes.length, 1);
  assert.ok(probes[0].args.includes("ghcr.io/oll4com/spaceapp-core:1.1.6"));
  assert.equal((await loadConfig(f.root)).version, "1.1.6");
});

test("a missing remote source blocks Compose and still removes only its native check", async (t) => {
  const f = await workspaceFixture(t);
  assert.equal(await run(["up"], { ...f.options, platform: "darwin", execute: async (spec) => {
    f.calls.push(spec);
    return spec.args[0] === "run" ? 125 : 0;
  } }), 125);
  assert.deepEqual(f.calls.map(spec => spec.args[0]), ["run", "rm"]);
  for (const command of ["down", "status"]) assert.equal(await run([command], f.options), 0);
  assert.equal(f.calls.filter(spec => spec.args[0] === "run").length, 1);
});

test("workspace label check honors local images and cleans up on interruption", async (t) => {
  const f = await workspaceFixture(t);
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await assert.rejects(run(["up", "--local-images"], { ...f.options, execute: async (spec) => {
    f.calls.push(spec);
    if (spec.args[0] !== "run") return 0;
    assert.equal(spec.args[spec.args.indexOf("--pull") + 1], "never");
    const aborted = new Promise((_, reject) => spec.signal.addEventListener("abort", () => reject(spec.signal.reason), { once: true }));
    process.emit("SIGTERM");
    return aborted;
  } }), /interrupt|abort/i);
  assert.deepEqual(f.calls.map(spec => spec.args[0]), ["run", "rm"]);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
});

test("aborted native clients close before command cleanup can proceed", async () => {
  const originalSpawn = childProcess.spawn;
  const child = new EventEmitter();
  let completed = false;
  childProcess.spawn = () => child;
  syncBuiltinESMExports();
  try {
    const pending = executeCommand({ command: "podman", args: ["run"], signal: new AbortController().signal })
      .catch(error => { completed = true; return error; });
    child.emit("error", Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" }));
    await Promise.resolve();
    assert.equal(completed, false, "AbortError must not race exact-container cleanup ahead of child close");
    child.emit("close", null, "SIGTERM");
    assert.equal((await pending).code, "ABORT_ERR");
  } finally {
    child.emit("close", null, "SIGTERM");
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
});

test("timed native cleanup escalates to SIGKILL even without an abort signal", async () => {
  const originalSpawn = childProcess.spawn;
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  const child = new EventEmitter(), timers = [], kills = [];
  child.kill = signal => kills.push(signal ?? "SIGTERM");
  childProcess.spawn = () => child;
  globalThis.setTimeout = (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; };
  globalThis.clearTimeout = () => {};
  syncBuiltinESMExports();
  try {
    const pending = executeCommand({ command: "podman", args: ["rm", "--force", "--ignore", "spaceapp-workspace-check-synthetic"], timeoutMs: 15_000 });
    assert.equal(timers[0].delay, 15_000);
    timers[0].callback();
    assert.deepEqual(kills, ["SIGTERM"]);
    assert.equal(timers[1]?.delay, 5_000);
    timers[1].callback();
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
    child.emit("close", null, "SIGKILL");
    assert.equal(await pending, 1);
  } finally {
    child.emit("close", null, "SIGKILL");
    childProcess.spawn = originalSpawn;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    syncBuiltinESMExports();
  }
});

test("Podman provider, credentials and owner commands retain engine", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.5", profile: "small" });
  for (const [args, input] of [
    [["provider", "install", "opencode"], ""],
    [["credentials", "set", "codex"], "synthetic-test-key\n"],
    [["owner", "reset-password"], "synthetic-test-password\n"],
    [["owner", "rotate-setup-token"], ""]
  ]) {
    assert.equal(await run(args, { ...f.options, stdin: Readable.from([input]) }), 0);
  }
  assert.ok(f.calls.length >= 4);
  assert.ok(f.calls.every(spec => spec.command === "podman"));
});

test("Podman bundled OpenCode check propagates success and execution failure", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.5", profile: "small" });
  for (const code of [0, 23]) {
    const calls = [];
    assert.equal(await run(["provider", "install", "opencode"], { ...f.options, execute: async (spec) => {
      calls.push(spec);
      return code;
    } }), code);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "podman");
    assert.deepEqual(calls[0].args.slice(-7), ["exec", "-T", "--user", "10001:10001", "spaceapp-cli", "opencode", "--version"]);
    assert.ok(!calls[0].args.includes("/app/deploy/docker/provider-install.mjs"));
  }
});

test("factory reset preserves the Podman engine", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.5", profile: "small" });
  assert.equal(await run(["factory-reset"], { ...f.options, stdin: Readable.from(["FACTORY-RESET\n"]) }), 0);
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.ok(f.calls.every(spec => spec.command === "podman"));
});

test("Podman provider environment accepts only the pinned literal", async () => {
  await assert.rejects(executeCommand({ command: "podman", args: ["--version"], env: { PODMAN_COMPOSE_PROVIDER: "/tmp/arbitrary-command" } }), /untrusted.*environment/i);
});


for (const [memoryGiB, engineCpuCount, expectedProfile] of [[3, 4, "small"], [5, 4, "medium"], [7, 8, "large"], [7, 4, "medium"]]) {
  test(`macOS auto sizing respects ${engineCpuCount} VM CPUs and ${memoryGiB} GiB engine memory`, async (t) => {
    const f = await fixture(t, {engineCpuCount, engineMemoryBytes: memoryGiB * GiB});
    let prerequisiteProfile;
    assert.equal(await run(installArgs(["--engine=podman", "--profile=auto"]), {
      ...f.options, platform: "darwin", ensurePodman: async ({profile}) => { prerequisiteProfile = profile; return {code: 0}; }
    }), 0, f.stderr.text());
    assert.equal(prerequisiteProfile, "auto");
    assert.equal((await loadConfig(f.root)).profile, expectedProfile);
    assert.ok(!f.calls.some(spec => spec.command === "docker"));
  });
}

test("standalone Podman doctor fails insufficient VM allocation", async (t) => {
  const f = await fixture(t, {engineCpuCount: 4, engineMemoryBytes: 3 * GiB});
  await initializeInstallation(f.root, {engine: "podman", version: "1.1.5", profile: "large"});
  assert.equal(await run(["doctor"], {...f.options, platform: "darwin"}), 1);
  assert.match(f.stderr.text(), /FAIL Podman memory.*3 GiB allocated.*7 GiB required/);
  assert.match(f.stderr.text(), /FAIL Podman CPU.*4 allocated.*8 required/);
  assert.match(f.stderr.text(), /podman machine set --cpus.*--memory.*--disk-size/);
});

test("a successful Podman upgrade and rollback preserve engine and checkpoint files", async (t) => {
  const f = await workspaceFixture(t);
  assert.equal(await run(["update", "1.1.6", "--non-interactive", "--answers", '{"confirm":true}'], f.options), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.equal((await loadConfig(f.root)).version, "1.1.6");
  assert.ok(f.calls.find(spec => spec.args[0] === "run").args.includes("ghcr.io/oll4com/spaceapp-core:1.1.6"));
  const [checkpointId] = await readdir(join(f.root, "checkpoints"));
  assert.ok(await stat(join(f.root, "checkpoints", checkpointId, "verified.json")));
  assert.ok(await stat(join(f.root, "checkpoints", checkpointId, "compose.engine.yml")));
  assert.equal(await run(["rollback", "--non-interactive", "--answers", '{"confirm":true}'], {...f.options, stdin: Readable.from([])}), 0);
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.equal((await loadConfig(f.root)).version, "1.1.5");
  assert.ok(f.calls.findLast(spec => spec.args[0] === "run").args.includes("ghcr.io/oll4com/spaceapp-core:1.1.5"));
  assert.ok(f.calls.every(spec => spec.command === "podman"));
});

test("Podman doctor fix, repair and reinstall retain engine", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, {engine: "podman", version: "1.1.5", profile: "small"});
  for (const args of [["doctor", "--fix"], ["repair"], ["reinstall"]]) {
    assert.equal(await run([...args, "--non-interactive", "--answers", '{"confirm":true}'], {...f.options, stdin: Readable.from([])}), 0, f.stderr.text());
  }
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.equal(f.podmanPrerequisites(), 2);
  assert.ok(f.calls.every(spec => spec.command === "podman"));
});

test("Podman restore and uninstall retain engine through every Compose action", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, {engine: "podman", version: "1.1.5", profile: "small"});
  await mkdir(join(f.root, "backups", "spaceapp-backup-20260723T120000000Z"));
  assert.equal(await run(["restore"], {...f.options, stdin: Readable.from(["RESTORE\n"])}), 0);
  assert.equal(await run(["uninstall", "--non-interactive", "--answers", '{"confirm":true}'], {...f.options, stdin: Readable.from([])}), 0);
  assert.equal(await run(["uninstall", "--purge-data"], {...f.options, stdin: Readable.from(["DELETE\n"])}), 0);
  assert.ok(f.calls.some(spec => spec.args.includes("scripts/portable-restore.mjs")));
  assert.ok(f.calls.some(spec => spec.args.includes("--volumes")));
  assert.ok(f.calls.every(spec => spec.command === "podman"));
});

test("Podman engine cannot be switched to Docker through answers", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, {engine: "podman", version: "1.1.5", profile: "small"});
  const before = await readFile(join(f.root, "config.json"), "utf8");
  await assert.rejects(run(installArgs([], {engine:"docker"}), f.options), /switch|migration/i);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), before);
  assert.equal(f.calls.length, 0);
});

test("Docker support facts retain unknown values without copying raw engine configuration", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, {version: "1.1.5", profile: "small"});
  const destination = join(f.root, "docker-support.json");
  assert.equal(await run(["support-bundle", "--out", destination], f.options), 0);
  const bundle = JSON.parse(await readFile(destination, "utf8"));
  assert.equal(bundle.engine.engine, "docker");
  assert.equal(bundle.engine.rootless, null);
  assert.equal(bundle.engine.cpuLimitDelegated, null);
  assert.equal(bundle.engine.memoryLimitDelegated, null);
  assert.equal(bundle.engine.version, null);
  assert.ok(!JSON.stringify(bundle.engine).includes("graphRoot"));
});


test("fresh interactive selection offers the installed Podman engine", async (t) => {
  const f = await fixture(t, {dockerMissing: true});
  const stdin = Readable.from(["\n"]);
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  assert.equal(await run(["install", "--no-open", "--answers", JSON.stringify({confirm:true, profile:"small", access:"isolated", companions:false, telemetry:false, open:false})], {
    ...f.options, stdin
  }), 0, f.stderr.text());
  assert.match(f.stdout.text(), /Docker is unavailable.*installed Podman/);
  assert.equal((await loadConfig(f.root)).engine, "podman");
});

test("explicit engine flag overrides a different answers engine", async (t) => {
  const f = await fixture(t);
  assert.equal(await run(installArgs(["--engine=podman"], {engine:"docker"}), f.options), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine, "podman");
});

test("Podman doctor reports unknown delegation without claiming it is available", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, {engine:"podman", version:"1.1.5", profile:"small"});
  const execute = async (spec, io = {}) => {
    if (spec.args[0] === "info") {
      f.calls.push(spec);
      io.stdout?.write(JSON.stringify({version:{Version:"5.7.0"}, host:{arch:"amd64", cpus:8, memTotal:32*GiB, serviceIsRemote:false, cgroupVersion:"v2", security:{rootless:true}}, store:{graphRoot:"/"}}));
      return 0;
    }
    return f.options.execute(spec, io);
  };
  assert.equal(await run(["doctor"], {...f.options, execute}), 1);
  assert.match(f.stdout.text(), /CPU delegation unknown; memory delegation unknown/);
  assert.match(f.stderr.text(), /CPU limits are not delegated/);
  assert.match(f.stderr.text(), /Memory limits are not delegated/);
});

test("automatic selection prepares the existing Docker CLI path before preferring Podman", async (t) => {
  const f = await fixture(t);
  let pathPrepared = false;
  let dockerPrerequisites = 0;
  const execute = async (spec, io) => spec.command === "docker" && !pathPrepared ? 127 : f.options.execute(spec, io);
  assert.equal(await run(installArgs(), { ...f.options, execute,
    prepareDockerPath: async () => { pathPrepared = true; },
    ensureDocker: async () => { dockerPrerequisites++; return {code:0}; }
  }), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine, "docker");
  assert.equal(dockerPrerequisites, 1);
  assert.equal(f.podmanPrerequisites(), 0);
});
