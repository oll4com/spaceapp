import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { containerEngine, selectContainerEngine, engineExecutor, inspectContainerEngine, podmanChecks, renderEngineCompose, withPodmanWritersPaused } from "../src/engine.mjs";
import { composeCommand, createDefaultConfig, initializeInstallation, installResourceChecks, loadConfig, prepareInstallation, renderWorkspaceCompose, validateConfig } from "../src/index.mjs";
import { run } from "../src/cli.mjs";
import { inspectStoragePlan } from "../src/storage.mjs";

const info = { version: { Version: "5.8.1" }, host: { security: { rootless: true, selinuxEnabled: true },
  cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"], cpus: 8, memTotal: 16 * 1024 ** 3 },
  registries: { auth: "must-not-appear" }, store: { graphRoot: "/private/storage" } };
const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const execute = async (spec, io) => {
    calls.push(spec);
    if (spec.command === "docker") throw new Error("Docker must not be invoked for saved Podman installs");
    if (spec.args[0] === "info") io?.stdout?.write(JSON.stringify({ ...info, store: { graphRoot: root } }));
    else if (spec.args[0] === "compose" && spec.args.includes("version")) io?.stdout?.write("5.6.0\n");
    else if (spec.args[0] === "image") return 1;
    else if (spec.args.includes("df")) io?.stdout?.write("20000000000");
    return 0;
  };
  const options = { env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" }, platform: "linux", stdin: Readable.from([]), stdout: sink(), stderr: sink(), execute,
    ensureDocker: async () => { throw new Error("Docker installation must not run"); },
    prepareDockerPath: async () => { throw new Error("Docker preparation must not run"); },
    inspectResources: async () => ({ cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 30 * 1024 ** 3 }),
    sleep: async () => {}, request: async (url) => ({ ok: true, status: 200, json: async () => url.endsWith("/readyz") ? { ok: true } : { setupRequired: true, expiresAt: null } }) };
  return { root, calls, execute, options };
}

test("automatic selection prefers working Docker; Podman-only hosts never install Docker", async () => {
  const selection = { platform: "linux", hasPodman: async () => true };
  assert.equal(await selectContainerEngine({ ...selection, execute: async () => 0 }), "docker");
  const seen = [];
  assert.equal(await selectContainerEngine({ ...selection, execute: async (spec) => { seen.push(spec.command); return spec.command === "docker" ? 127 : 0; } }), "podman");
  assert.deepEqual(seen, ["docker", "podman"]);
  assert.equal(await selectContainerEngine({ ...selection, existing: { engine: "podman" }, execute: () => { throw new Error("no autodetection for saved choice"); } }), "podman");
  assert.throws(() => containerEngine("sh"), /docker or podman/);
});

test("Compose construction and executor preserve arguments and bind only runtime commands", async () => {
  const docker = composeCommand("backup", "/tmp/space-engine", { profile: "small" });
  const podman = composeCommand("backup", "/tmp/space-engine", { profile: "small", engine: "podman" });
  assert.equal(podman.command, "podman");
  assert.deepEqual(podman.args, docker.args);
  const specs = [];
  const execute = engineExecutor(async (spec) => { specs.push(spec); return 0; }, "podman");
  await execute(docker);
  await execute({ command: "open", args: ["http://127.0.0.1:4911"] });
  assert.equal(specs[0].command, "podman"); assert.equal(specs[1].command, "open");
  assert.deepEqual(specs[0].args, ["compose", "--parallel", "1", ...docker.args.slice(1)]);
  assert.deepEqual(composeCommand("installProvider", "/tmp/space-engine", { provider: "opencode" }).args.slice(-3), ["spaceapp-cli", "opencode", "--version"]);
});

test("old Docker configurations remain compatible and engine switches fail before writes", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.0.2" });
  const before = await readFile(join(f.root, "config.json"), "utf8");
  assert.equal(containerEngine((await loadConfig(f.root)).engine), "docker");
  await assert.rejects(prepareInstallation(f.root, { version: "1.0.3", engine: "podman" }), /Changing container engines/);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), before);
  assert.throws(() => validateConfig({ ...createDefaultConfig({ version: "1.0.2" }), engine: "podman", accessMode: "host-root" }), /host-root/);
});

test("Podman render keeps shared UID mappings and labels only relevant binds, preserving read-only mounts", async () => {
  const template = await readFile(new URL("../templates/compose.yml", import.meta.url), "utf8");
  assert.equal(renderEngineCompose(template, "docker"), template);
  const rendered = renderEngineCompose(template, "podman");
  assert.equal((rendered.match(/userns_mode:/g) ?? []).length, 4);
  assert.match(rendered, /\.\/secrets\/database-url:\/run\/secrets\/database-url:ro,z/);
  assert.doesNotMatch(rendered, /^ {4}secrets:/m);
  assert.match(rendered, /spaceapp-codex-sessions:\/var\/lib\/spaceapp-cli\/providers\/codex\/sessions:ro$/m);
  assert.match(rendered, /\.\/backups:\/backups:z/);
  assert.doesNotMatch(rendered, /label=disable|privileged/);
  const config = createDefaultConfig({ version: "1.0.2", engine: "podman" });
  config.workspaces = [{ id: "fixture-12345678", hostPath: "/tmp/engine fixture", containerPath: "/workspaces/fixture", readOnly: true }];
  assert.match(renderWorkspaceCompose(config), /read_only: true\n {8}bind:\n {10}selinux: z/);
  assert.doesNotMatch(renderWorkspaceCompose(config, { cliSandbox: true }), /seccomp=|apparmor=unconfined/);
});

test("engine diagnostics omit auth/storage payload and reject rootful or missing delegation", async (t) => {
  const f = await fixture(t);
  const observed = await inspectContainerEngine(f.execute, "podman", "linux");
  assert.equal(observed.rootless, true); assert.equal(observed.selinux, true);
  assert.ok(podmanChecks(observed, "linux").every((check) => check.ok));
  assert.doesNotMatch(JSON.stringify(observed), /must-not-appear|private\/storage/);
  assert.ok(podmanChecks({ ...observed, rootless: false }).some((check) => !check.ok));
  assert.ok(podmanChecks({ ...observed, cgroupControllers: ["memory"] }).some((check) => !check.ok));
  assert.ok(podmanChecks({ ...observed, composeVersion: "2.0.0" }).some((check) => !check.ok));
});

test("--answers selects Podman and all later commands reuse the saved engine", async (t) => {
  const f = await fixture(t);
  const answer = { engine: "podman", confirm: true, profile: "small", access: "isolated", companions: false, telemetry: false, open: false };
  assert.equal(await run(["install", "--non-interactive", "--answers", JSON.stringify(answer)], f.options), 0);
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.equal(await run(["status", "--non-interactive", "--answers", JSON.stringify(answer)], { ...f.options, stdin: Readable.from([]) }), 0);
  assert.match(await readFile(join(f.root, "compose.yml"), "utf8"), /keep-id/);
  for (const args of [["status"], ["logs"], ["down"], ["up"], ["provider", "install", "opencode"], ["doctor"], ["doctor", "--fix", "--non-interactive", "--answers", '{"confirm":true}']]) {
    assert.equal(await run(args, { ...f.options, stdin: Readable.from([]) }), 0, args.join(" "));
  }
  assert.ok(f.calls.every((spec) => spec.command === "podman"));
  const out = join(f.root, "support.json");
  assert.equal(await run(["support-bundle", "--out", out], f.options), 0);
  assert.equal(JSON.parse(await readFile(out, "utf8")).engine.name, "podman");
});

test("explicit Podman host-root is refused before any command or filesystem mutation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(run(["install", "--engine", "podman", "--access", "host-root"], f.options), /host-root/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(join(f.root, "config.json")), { code: "ENOENT" });
});

test("a saved Podman install refuses runtime writes after switching to a rootful connection", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.1.8", engine: "podman" });
  const before = await readFile(join(f.root, "config.json"), "utf8");
  const calls = [];
  const execute = async (spec, io) => {
    calls.push(spec);
    if (spec.args[0] === "info") {
      io.stdout.write(JSON.stringify({ ...info, host: { ...info.host, security: { rootless: false } } }));
      return 0;
    }
    return f.execute(spec, io);
  };
  assert.equal(await run(["up"], { ...f.options, execute }), 1);
  assert.ok(calls.every((spec) => spec.args[0] === "info" || spec.args.includes("version")));
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), before);
});


test("Podman image IDs without a sha256 prefix count as cached images", async (t) => {
  const f = await fixture(t);
  const execute = engineExecutor(async (spec, io) => {
    if (spec.args[0] === "image") { io?.stdout?.write("a".repeat(64)); return 0; }
    return f.execute(spec, io);
  }, "podman", "linux");
  const plan = await inspectStoragePlan({ root: f.root, config: createDefaultConfig({ version: "1.1.8", profile: "small", engine: "podman" }),
    resources: { freeDiskBytes: 30 * 1024 ** 3 }, execute, operation: "fresh" });
  assert.deepEqual(plan.missingImages, []);
  assert.equal(plan.missingImageBytes, 0);
});


test("macOS diagnostics use the selected named machine and omit connection identities", async () => {
  const calls = [];
  const execute = engineExecutor(async (spec, io) => {
    calls.push(spec.args);
    let value;
    if (spec.args[0] === "info") value = info;
    else if (spec.args[0] === "compose") { io.stdout.write("5.6.0"); return 0; }
    else if (spec.args[0] === "system") value = [{ Name: "my-machine", IsMachine: true, Default: true, URI: "ssh://core@127.0.0.1:1234/run/podman.sock", Identity: "/private/key" }];
    else if (spec.args[1] === "list") value = [{ Name: "my-machine", Port: 1234, Running: true }];
    else value = [{ Name: "my-machine", State: "running", Rootful: false, Resources: { CPUs: 4, Memory: 8192, DiskSize: 40 } }];
    io.stdout.write(JSON.stringify(value)); return 0;
  }, "podman", "darwin", {});
  const observed = await inspectContainerEngine(execute, "podman", "darwin");
  assert.equal(observed.machine.name, "my-machine");
  assert.ok(calls.some((args) => args.join(" ") === "machine inspect my-machine"));
  assert.doesNotMatch(JSON.stringify(observed), /private\/key|ssh:\/\//);
});

test("Podman machine allocation must satisfy the selected profile independently of host capacity", () => {
  const resources = { cpuCount: 12, totalMemoryBytes: 32 * 1024 ** 3, freeDiskBytes: 30 * 1024 ** 3,
    engineName: "Podman", engineCpuCount: 4, engineMemoryBytes: 8 * 1024 ** 3 };
  assert.ok(installResourceChecks(resources, "small").every((check) => check.ok));
  assert.deepEqual(installResourceChecks(resources, "large").filter((check) => !check.ok).map((check) => check.name), ["Podman memory", "Podman CPU"]);
});


test("Podman resumes exactly the running writers after backup failure", async () => {
  const calls = [];
  const id = "a".repeat(64);
  const execute = async (spec, io) => {
    calls.push(spec.args);
    if (spec.args[0] === "ps") io.stdout.write(JSON.stringify([
      { Id: id, Labels: { "com.docker.compose.service": "spaceapp-core" } },
      { Id: "b".repeat(64), Labels: { "com.docker.compose.service": "postgres" } }
    ]));
    return 0;
  };
  await assert.rejects(withPodmanWritersPaused(execute, "spaceapp-test", { stderr: sink() }, async () => { throw new Error("backup failed"); }), /backup failed/);
  assert.deepEqual(calls.slice(1), [["pause", id], ["unpause", id]]);
  assert.ok(calls[0].includes("label=com.docker.compose.project=spaceapp-test"));
  assert.ok(calls[0].includes("status=running"));
});
