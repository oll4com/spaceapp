import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { composeDefinition, ensureSecrets, initializeState, readPins, readState, resolvePorts, runtimeDirectory, saveState, serviceEnvironment, statePath } from "../dev-stack-state.mjs";
import { isSameProcess, processIdentity, ProcessSupervisor, stopRecords } from "../dev-stack-processes.mjs";
import { readyResponse, reset, root } from "../dev-stack.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "spaceapp-stack-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "packages/run-spaceapp/templates"), { recursive: true });
  writeFileSync(join(directory, "packages/run-spaceapp/templates/compose.yml"), readFileSync(join(root, "packages/run-spaceapp/templates/compose.yml")));
  writeFileSync(join(directory, "Dockerfile"), readFileSync(join(root, "Dockerfile")));
  return directory;
}

test("dev-stack validates ports strictly, forbids installed ports and rejects duplicate bindings", () => {
  assert.deepEqual(resolvePorts({}), { api: 5910, web: 5911, postgres: 55432, temporal: 57233 });
  assert.equal(resolvePorts({ SPACE_DEV_API_PORT: "6010" }).api, 6010);
  for (const value of ["0", "65536", "5432abc", "1e4", "4910", "4911", "-1", ""]) assert.throws(() => resolvePorts({ SPACE_DEV_API_PORT: value }));
  assert.throws(() => resolvePorts({ SPACE_DEV_API_PORT: "5911" }), /distinct/);
});

test("dev-stack reads exact pins from upstream and fails closed on an unpinned image", (t) => {
  const directory = fixture(t);
  const pins = readPins(directory);
  assert.match(pins.postgres, /@sha256:[a-f0-9]{64}$/);
  assert.match(pins.temporal, /@sha256:[a-f0-9]{64}$/);
  assert.match(pins.opencode, /^\d+\.\d+\.\d+$/);
  const template = join(directory, "packages/run-spaceapp/templates/compose.yml");
  writeFileSync(template, readFileSync(template, "utf8").replace(/@sha256:[a-f0-9]{64}/g, ""));
  assert.throws(() => readPins(directory), /digest-pinned/);
});

test("dev-stack refuses arbitrary state folders, nested stacks, symlinks and pre-existing data", (t) => {
  const directory = fixture(t);
  for (const value of [".", "..", "/", "apps", "packages", ".dev-stack/child", "other-folder"]) assert.throws(() => statePath(directory, { SPACE_DEV_STATE_DIR: value }));
  symlinkSync(directory, join(directory, ".dev-stack-link"));
  assert.throws(() => statePath(directory, { SPACE_DEV_STATE_DIR: ".dev-stack-link" }), /symlink/);
  const target = statePath(directory, {});
  mkdirSync(target);
  writeFileSync(join(target, "keep"), "user data");
  assert.throws(() => initializeState(directory, target, {}), /refusing to adopt/);
  assert.equal(readFileSync(join(target, "keep"), "utf8"), "user data");
});

test("dev-stack retains per-state secrets with mode 0600 and injects Temporal credentials without weakening permissions", (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  const first = ensureSecrets(state);
  assert.deepEqual(ensureSecrets(state), first);
  assert.equal(statSync(state.directory).mode & 0o777, 0o700);
  for (const name of ["postgres-password", "session-secret", "setup-token", "database-url", "temporal.env"]) assert.equal(statSync(join(state.directory, "secrets", name)).mode & 0o777, 0o600);
  const compose = composeDefinition(state);
  assert.ok(!JSON.stringify(compose).includes(first.password));
  assert.deepEqual(compose.services.temporal.env_file, ["./secrets/temporal.env"]);
  assert.equal(readFileSync(join(state.directory, "secrets/temporal.env"), "utf8"), `POSTGRES_PWD=${first.password}\n`);
  for (const service of Object.values(compose.services)) for (const port of service.ports) assert.match(port, /^127\.0\.0\.1:/);
});

test("dev-stack restores non-default ports and refuses manifest adoption from another checkout", (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), { SPACE_DEV_WEB_PORT: "6011" });
  assert.equal(initializeState(directory, state.directory, {}).ports.web, 6011);
  assert.throws(() => initializeState(directory, state.directory, { SPACE_DEV_WEB_PORT: "6012" }), /reset this stack/);
  state.root = "/other-checkout";
  saveState(state);
  assert.throws(() => readState(directory, state.directory), /does not belong/);
});

test("dev-stack rejects symlink secret files and restores existing secret permissions", (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  ensureSecrets(state);
  const password = join(state.directory, "secrets/postgres-password");
  chmodSync(password, 0o644);
  ensureSecrets(state);
  assert.equal(statSync(password).mode & 0o777, 0o600);
  rmSync(password);
  const outside = join(directory, "outside");
  writeFileSync(outside, "a".repeat(64), { mode: 0o644 });
  symlinkSync(outside, password);
  assert.throws(() => ensureSecrets(state), /secret file/);
  assert.equal(statSync(outside).mode & 0o777, 0o644);
});

test("dev-stack uses short private socket paths and verifies their ownership", (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  const runtime = runtimeDirectory(state);
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  assert.ok(Buffer.byteLength(join(runtime, "control.sock")) < 100);
  assert.equal(statSync(runtime).mode & 0o777, 0o700);
  writeFileSync(join(runtime, "owner.json"), '{"id":"other"}');
  assert.throws(() => runtimeDirectory(state), /ownership/);
});

test("dev-stack runtime environment isolates cookies, paths, workflows and inherited accounts", (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  state.runtime = join(directory, "socket-fixture");
  const env = serviceEnvironment(state, ensureSecrets(state), { PATH: "/bin", SPACE_RUNTIME_STORE: "memory", SPACE_INSTANCE: "stable", OPENAI_API_KEY: "never-import", SPACE_DATABASE_URL: "postgres://installed", NODE_OPTIONS: "--require bad.js" });
  assert.equal(env.SPACE_INSTANCE, "dev");
  assert.equal(env.SPACE_DEV_LOGIN, "false");
  assert.equal(env.SPACE_RUNTIME_STORE, "postgres");
  assert.equal(env.SPACEAPP_WORKFLOWS_ENABLED, "true");
  assert.equal(env.SPACE_TEMPORAL_NAMESPACE, "spaceapp-dev");
  assert.equal(env.SPACE_PG_SOCKET_PATH, join(state.runtime, "postgres-disabled.sock"));
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.TMPDIR, join(state.runtime, "tmp"));
  for (const key of ["HOME", "SPACE_MEMORY_ROOT", "SPACE_APP_DIAGNOSTICS_ROOT", "SPACE_PROJECTS_ROOT", "SPACE_INSTALL_ROOT", "SPACE_CODEX_HOME"]) assert.ok(env[key].startsWith(state.directory), key);
});

test("dev-stack runs real tsx watch IPC with a checkout/state path longer than Unix socket limits", async (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, { SPACE_DEV_STATE_DIR: `.dev-stack-${"deep".repeat(25)}` }), {});
  const runtime = runtimeDirectory(state);
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  const env = serviceEnvironment(state, ensureSecrets(state));
  assert.ok(Buffer.byteLength(join(state.directory, "data/tmp/tsx-1000/12345.pipe")) > 108);
  assert.ok(Buffer.byteLength(join(env.TMPDIR, "tsx-1000/12345.pipe")) < 100);
  mkdirSync(env.TMPDIR, { mode: 0o700 });
  mkdirSync(join(state.directory, "logs"));
  const entry = join(directory, "watch-entry.mjs");
  writeFileSync(entry, 'console.log("tsx-watch-ready"); setInterval(() => {}, 1000);');
  let failure;
  const runner = new ProcessSupervisor(state, {}, (error) => { failure = error; });
  try {
    const watcher = runner.start("watcher", process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "watch", entry], { env });
    const log = join(state.directory, "logs/watcher.log");
    for (let i = 0; i < 150 && !failure && (!existsSync(log) || !readFileSync(log, "utf8").includes("tsx-watch-ready")); i++) await delay(100);
    assert.equal(failure, undefined);
    assert.match(readFileSync(log, "utf8"), /tsx-watch-ready/);
    assert.ok(isSameProcess(processIdentity(watcher.pid)));
  } finally { await runner.stop(); }
});

test("dev-stack readiness requires a real PostgreSQL store, worker and CLI host", () => {
  const body = { ok: true, dependencies: { store: "postgres", database: "RUNNING", temporal: "enabled", worker: "RUNNING", cliHost: "RUNNING" } };
  assert.equal(readyResponse(body), true);
  assert.equal(readyResponse({ ...body, dependencies: { ...body.dependencies, worker: "disabled" } }), false);
  assert.equal(readyResponse({ ...body, dependencies: { ...body.dependencies, store: "memory" } }), false);
  assert.equal(readyResponse({ ...body, dependencies: { ...body.dependencies, temporal: "disabled" } }), false);
  assert.equal(readyResponse({ ok: true }), false);
});

test("dev-stack refuses to signal a recycled process identity", async () => {
  await assert.rejects(stopRecords([{ ...processIdentity(process.pid), start: "different-start" }]), /reused PID/);
  assert.ok(isSameProcess(processIdentity(process.pid)));
});

test("dev-stack supervises real children, redacts split output and stops separate-session descendants", async (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  mkdirSync(join(state.directory, "logs"));
  const secret = "local-redaction-fixture";
  let failed;
  const runner = new ProcessSupervisor(state, { secret }, (error) => { failed = error; });
  try {
  const pidFile = join(directory, "descendant.json");
  const child = runner.start("fixture", process.execPath, ["-e", `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify(child.pid)); process.stdout.write('local-redaction-');setTimeout(()=>process.stdout.write('fixture\\n'),40);setInterval(()=>{},1000);`]);
  for (let i = 0; i < 100 && (!existsSync(pidFile) || !existsSync(join(state.directory, "logs/fixture.log")) || !readFileSync(join(state.directory, "logs/fixture.log"), "utf8").includes("redacted")); i++) await delay(25);
  const descendant = processIdentity(JSON.parse(readFileSync(pidFile, "utf8")));
  assert.ok(descendant);
  assert.ok(isSameProcess(processIdentity(child.pid)));
  assert.match(readFileSync(join(state.directory, "logs/fixture.log"), "utf8"), /\[redacted\]/);
  await runner.stop();
  assert.equal(isSameProcess(descendant), false);
  assert.equal(failed, undefined);
  assert.deepEqual(state.processes, []);
  } finally { await runner.stop(); }
});

test("dev-stack reports unexpected service exit by name and propagates failure", async (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  mkdirSync(join(state.directory, "logs"));
  let fail;
  const failure = new Promise((resolve) => { fail = resolve; });
  const runner = new ProcessSupervisor(state, {}, fail);
  runner.start("worker-fixture", process.execPath, ["-e", "setTimeout(()=>process.exit(7),150)"]);
  try {
  const error = await Promise.race([failure, delay(5000).then(() => { throw new Error("failure not reported"); })]);
  assert.match(error.message, /worker-fixture exited unexpectedly \(7\)/);
  } finally { await runner.stop(); }
});

test("dev-stack retains PTY descendant identities across a killed parent and supervisor recovery", async (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  mkdirSync(join(state.directory, "logs"));
  const runner = new ProcessSupervisor(state, {}, () => {});
  const pidFile = join(directory, "orphan-pid");
  let orphan;
  try {
    const parent = runner.start("cli-fixture", process.execPath, ["-e", `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);`]);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(20);
    orphan = processIdentity(Number(readFileSync(pidFile, "utf8")));
    assert.ok(orphan);
    for (let i = 0; i < 100 && !state.processes[0].descendants?.some((child) => child.pid === orphan.pid); i++) await delay(20);
    const saved = readState(directory, state.directory);
    assert.ok(saved.processes[0].descendants?.some((child) => child.pid === orphan.pid));
    process.kill(parent.pid, "SIGKILL");
    for (let i = 0; i < 100 && isSameProcess(saved.processes[0]); i++) await delay(20);
    assert.equal(isSameProcess(saved.processes[0]), false);
    assert.ok(isSameProcess(orphan), "separate-session child survived the parent crash");
    await stopRecords(saved.processes);
    assert.equal(isSameProcess(orphan), false, "recovery stops the persisted orphan identity");
  } finally {
    if (orphan) await stopRecords([orphan]);
    await runner.stop();
  }
});

test("dev-stack reset preserves secrets and ownership state when Docker cleanup fails", async (t) => {
  const directory = join(root, `.dev-stack-test-${process.pid}`);
  const previous = process.env.PATH;
  const toolRoot = fixture(t);
  const docker = join(toolRoot, "docker");
  writeFileSync(docker, "#!/bin/sh\nexit 42\n", { mode: 0o700 });
  const state = initializeState(root, directory, {});
  const secrets = ensureSecrets(state);
  writeFileSync(join(directory, "compose.json"), JSON.stringify(composeDefinition(state)));
  process.env.PATH = `${toolRoot}:${previous}`;
  try {
    await assert.rejects(reset(state), /Command failed/);
    assert.equal(ensureSecrets(state).password, secrets.password);
    assert.ok(readState(root, directory));
  } finally { process.env.PATH = previous; rmSync(directory, { recursive: true, force: true }); }
});
