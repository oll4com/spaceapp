import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { containerEngine, selectContainerEngine, executeWithContainerEngine, podmanFacts, podmanChecks } from "../src/engine.mjs";
import { composeCommand, createDefaultConfig, renderHostAccessCompose, renderWorkspaceCompose, validateConfig } from "../src/index.mjs";
import { run } from "../src/cli.mjs";

const info = { version: { Version: "5.4.0" }, host: { arch: "x86_64", cpus: 8, memTotal: 16 * 1024 ** 3, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory"], security: { rootless: true } }, store: { graphRootAllocated: 100 * 1024 ** 3, graphRootUsed: 1024 ** 3 } };

test("engine selection preserves working Docker and saved choices, and offers installed Podman", async () => {
  const options = { platform: "linux", nonInteractive: true, offerPodman: () => { throw new Error("must not prompt unattended"); } };
  assert.equal(await selectContainerEngine({ ...options, execute: async () => 0 }), "docker");
  const execute = async (spec, io) => { if (spec.command === "docker") return 127; io.stdout.write("podman version 5.4.0"); return 0; };
  assert.equal(await selectContainerEngine({ ...options, execute }), "podman");
  let offered = false;
  assert.equal(await selectContainerEngine({ ...options, execute, nonInteractive: false, offerPodman: async () => { offered = true; return true; } }), "podman");
  assert.ok(offered);
  assert.equal(await selectContainerEngine({ ...options, existing: {}, execute: () => { throw new Error("do not probe saved engine"); } }), "docker");
  await assert.rejects(selectContainerEngine({ ...options, existing: { engine: "podman" }, requested: "docker" }), /Switching engines is refused/);
  assert.throws(() => containerEngine("podman; echo wrong"), /docker or podman/);
});

test("Podman validates provider, rootless mode and delegated limits without leaking arbitrary info", () => {
  const facts = podmanFacts({ ...info, secret: "must-not-leak" }, "Docker Compose version v2.24.4");
  assert.ok(podmanChecks(facts, "linux").every(check => check.ok));
  assert.ok(!JSON.stringify(facts).includes("must-not-leak"));
  for (const output of ["podman-compose version 1.2.0", "Docker Compose version v2.24.3", ""]) assert.equal(podmanFacts(info, output).composeSupported, false);
  assert.equal(podmanFacts(info, "Docker Compose version v5.5.1").composeSupported, true);
  assert.ok(podmanChecks(podmanFacts({ ...info, host: { ...info.host, cgroupControllers: [], security: { rootless: false } } }, "Docker Compose version v2.24.4"), "linux").filter(check => !check.ok).length >= 2);
});

test("all command families retain arguments and select the persisted engine", async () => {
  for (const engine of ["docker", "podman"]) for (const action of ["up", "down", "status", "logs", "pull", "backup", "purge", "repair", "syncCredentials", "checkpointDump", "storageFree", "rotateOwnerSetupToken", "resetOwnerPassword"]) {
    const spec = composeCommand(action, "/tmp/spaceapp-engine-unit", { profile: "large", engine });
    assert.equal(spec.command, engine);
    assert.ok(spec.args.includes("workflows"));
    const calls = [];
    await executeWithContainerEngine(async call => { calls.push(call); return 0; }, engine)({ ...spec, command: "docker" });
    assert.deepEqual(calls, [spec]);
  }
});

test("rootless mounts preserve host ownership, read-only bindings, labels and file-secret isolation", () => {
  const config = createDefaultConfig({ version: "1.1.6", profile: "small", engine: "podman" });
  config.workspaces = [{ id: "test-abcdef12", hostPath: "/tmp/source", containerPath: "/workspaces/test", readOnly: true }];
  const mounts = renderWorkspaceCompose(config), overrides = renderHostAccessCompose(config);
  assert.match(mounts, /read_only: true/); assert.match(mounts, /selinux: z/); assert.match(mounts, /create_host_path: true/);
  assert.match(overrides, /keep-id:uid=10001,gid=10001/); assert.match(overrides, /user: "0:0"/);
  assert.match(overrides, /database-url:\/run\/secrets\/database-url:ro,z/);
  assert.doesNotMatch(mounts + overrides, /:U|chown|label=disable/);
  assert.throws(() => validateConfig({ ...config, accessMode: "host-root" }), /host-root is refused/);
});

test("bundled OpenCode is checked without reinstalling, using either persisted engine", () => {
  for (const engine of ["docker", "podman"]) {
    const command = composeCommand("installProvider", "/tmp/spaceapp-engine-unit", { engine, provider: "opencode" });
    assert.equal(command.command, engine);
    assert.deepEqual(command.args.slice(-7), ["exec", "-T", "--user", "10001:10001", "spaceapp-cli", "opencode", "--version"]);
    assert.ok(!command.args.includes("/app/deploy/docker/provider-install.mjs"));
  }
});

test("answers select Podman on install and every later lifecycle command uses it", async t => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = []; let output = "";
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
  const options = { env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" }, platform: "linux", stdin: Readable.from([]), stdout: stream, stderr: stream,
    inspectResources: async () => ({ cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 100 * 1024 ** 3 }),
    prepareDockerPath: () => { throw new Error("must not configure Docker"); }, ensureDocker: () => { throw new Error("must not install Docker"); }, sleep: async () => {},
    execute: async (spec, io) => {
      calls.push(spec); assert.equal(spec.command, "podman");
      if (spec.args[0] === "info") io.stdout?.write(JSON.stringify(info));
      if (spec.args[0] === "compose" && spec.args[1] === "version") io.stdout?.write("Docker Compose version v2.24.4");
      if (spec.args[0] === "image") io.stdout?.write("sha256:" + "a".repeat(64));
      return 0;
    }, request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/readyz") ? { ok: true } : { setupRequired: true, expiresAt: null } }) };
  const answers = JSON.stringify({ engine: "podman", confirm: true, profile: "small", access: "isolated", companions: false, telemetry: false, open: false });
  assert.equal(await run(["install", "--non-interactive", "--answers", answers], options), 0, output);
  assert.equal(JSON.parse(await readFile(join(root, "config.json"), "utf8")).engine, "podman");
  for (const command of ["status", "logs", "backup", "down", "up", "doctor"]) assert.equal(await run([command], { ...options, stdin: Readable.from([]) }), 0, output);
  assert.ok(calls.some(spec => spec.args.includes("scripts/portable-backup.mjs")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  assert.equal(await run(["workspace", "add", workspace], { ...options, stdin: Readable.from([]) }), 0, output);
  assert.equal(await run(["up"], { ...options, stdin: Readable.from([]) }), 0, output);
  await rm(workspace, { recursive: true });
  for (const pathIsFile of [false, true]) {
    if (pathIsFile) await writeFile(workspace, "not a directory");
    const beforeStart = calls.length;
    await assert.rejects(run(["up"], { ...options, stdin: Readable.from([]) }), /Registered workspace must be an existing directory/);
    assert.equal(calls.length, beforeStart, "refuse before invoking Compose or creating the missing path");
  }
  assert.equal(await run(["down"], { ...options, stdin: Readable.from([]) }), 0, output);
  assert.equal(await run(["workspace", "remove", workspace], { ...options, stdin: Readable.from([]) }), 0, output);
  const before = calls.length;
  await assert.rejects(run(["install", "--engine", "docker"], { ...options, stdin: Readable.from([]) }), /Switching engines is refused/);
  assert.equal(calls.length, before);
});
