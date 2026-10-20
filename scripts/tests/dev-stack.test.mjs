import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { composeDefinition, ensureSecrets, initializeState, readPins, readState, resolvePorts, runtimeDirectory, saveState, serviceEnvironment, statePath } from "../dev-stack-state.mjs";
import { isSameProcess, processIdentity, processTable, ProcessSupervisor, stopRecords } from "../dev-stack-processes.mjs";
import { prepareFiles, readyResponse, reset, root } from "../dev-stack.mjs";

/**
 * Create a disposable checkout skeleton with the real dependency pins and remove it after the test.
 */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "spaceapp-stack-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "packages/run-spaceapp/templates"), { recursive: true });
  writeFileSync(join(directory, "packages/run-spaceapp/templates/compose.yml"), readFileSync(join(root, "packages/run-spaceapp/templates/compose.yml")));
  writeFileSync(join(directory, "Dockerfile"), readFileSync(join(root, "Dockerfile")));
  return directory;
}

test("dev-stack process snapshots retain stable birth dates and zombie detection across caller locales and timezones", (t) => {
  const previous = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TZ: process.env.TZ, SPACE_DEV_PS_CANARY: process.env.SPACE_DEV_PS_CANARY };
  process.env.LANG = "ja_JP.UTF-8";
  process.env.LC_ALL = "ja_JP.UTF-8";
  process.env.TZ = "Pacific/Honolulu";
  process.env.SPACE_DEV_PS_CANARY = "keep-inherited-environment";
  let status = "S";
  try {
    t.mock.method(childProcess, "execFileSync", (command, args, options) => {
      assert.equal(command, "ps");
      assert.deepEqual(args, ["-axo", "pid=,ppid=,pgid=,lstart=,stat="]);
      const env = options.env ?? process.env;
      assert.equal(env.SPACE_DEV_PS_CANARY, "keep-inherited-environment");
      const birth = env.LC_ALL !== "C" || env.LANG !== "C" ? "月 10/19 12:34:56 2026" : env.TZ === "UTC0" ? "Mon Oct 19 12:34:56 2026" : "Mon Oct 19 02:34:56 2026";
      return `${process.pid} 1 ${process.pid} ${birth} ${status}\n`;
    });
    syncBuiltinESMExports();
    const [live] = processTable();
    assert.equal(live.start, "Mon Oct 19 12:34:56 2026");
    assert.equal(live.stat, "S");
    status = "Z";
    assert.equal(processIdentity(process.pid, processTable()), null);
    assert.equal(process.env.LC_ALL, "ja_JP.UTF-8");
    assert.equal(process.env.LANG, "ja_JP.UTF-8");
    assert.equal(process.env.TZ, "Pacific/Honolulu");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

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
  for (const key of ["HOME", "SPACE_MEMORY_ROOT", "SPACE_APP_DIAGNOSTICS_ROOT", "SPACE_PROJECTS_ROOT", "SPACE_INSTALL_ROOT", "SPACE_CODEX_HOME", "SPACE_LIVE_VOICE_LOG_ROOT", "SPACE_PLUGINS_ROOT", "SPACE_PERSONAL_GIT_ROOT", "SPACE_AGENT_FILE_DOCX_WORK_ROOT"]) assert.ok(env[key].startsWith(state.directory), key);
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

test("dev-stack skips recycled identities while stopping remaining owned processes", async (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  mkdirSync(join(state.directory, "logs"));
  const runner = new ProcessSupervisor(state, {}, () => {});
  try {
    const unrelated = runner.start("unrelated-fixture", process.execPath, ["-e", "setInterval(()=>{},1000)"], {}, false);
    const managed = runner.start("managed-fixture", process.execPath, ["-e", "setInterval(()=>{},1000)"], {}, false);
    const unrelatedIdentity = processIdentity(unrelated.pid);
    const managedIdentity = processIdentity(managed.pid);
    assert.ok(unrelatedIdentity && managedIdentity);
    // A mismatched birth identity models a saved PID now owned by someone else.
    await stopRecords([{ ...unrelatedIdentity, start: "different-start" }, managedIdentity]);
    assert.ok(isSameProcess(unrelatedIdentity), "never signal the unrelated live process");
    assert.equal(isSameProcess(managedIdentity), false, "still stop the authenticated managed process");
  } finally { await runner.stop(); }
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


test("dev-stack reauthenticates a process group before escalating shutdown", async (t) => {
  const children = [0, 1].map(() => childProcess.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" }));
  const identities = children.map((child) => processIdentity(child.pid));
  assert.ok(identities.every(Boolean));
  const [managed, unrelated] = identities;
  const original = childProcess.execFileSync;
  const before = processTable().map(({ pid, ppid, pgid, start, stat }) => `${pid} ${ppid} ${pgid} ${start} ${stat}`).join("\n");
  // Model the owned group disappearing after TERM, followed by reuse of its
  // numeric ID. No kernel PID recycling or real signal delivery is claimed.
  const after = before.split("\n").filter((line) => Number(line.trim().split(/\s+/)[0]) !== managed.pid).map((line) => {
    const fields = line.trim().split(/\s+/);
    if (Number(fields[0]) === unrelated.pid) fields[2] = String(managed.pgid);
    return fields.join(" ");
  }).join("\n");
  let terminated = false;
  const signals = [];
  try {
    t.mock.method(childProcess, "execFileSync", (command, ...args) => command === "ps" ? (terminated ? after : before) : original(command, ...args));
    syncBuiltinESMExports();
    t.mock.method(process, "kill", (pid, signal) => {
      signals.push({ pid, signal });
      if (pid === -managed.pgid && signal === "SIGTERM") terminated = true;
    });
    await stopRecords([managed], 0);
    assert.ok(terminated, "the owned group initially receives TERM");
    assert.ok(!signals.some((entry) => entry.signal === "SIGKILL"), "never escalate against a reused, unauthenticated group");
    assert.ok(!signals.some((entry) => entry.pid === unrelated.pid), "never signal the unrelated process individually");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await stopRecords(identities);
  }
});

test("dev-stack preserves recovery identities when signal delivery is denied", async (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  mkdirSync(join(state.directory, "logs"));
  const runner = new ProcessSupervisor(state, {}, () => {});
  const child = runner.start("denied-fixture", process.execPath, ["-e", "setInterval(()=>{},1000)"], {}, false);
  const identity = processIdentity(child.pid);
  const original = process.kill;
  try {
    t.mock.method(process, "kill", (pid, signal) => {
      if (pid === -child.pid) throw Object.assign(new Error("permission denied fixture"), { code: "EPERM" });
      return original(pid, signal);
    });
    await assert.rejects(runner.stop(), { code: "EPERM" });
    assert.ok(readState(directory, state.directory).processes.some((record) => record.pid === identity.pid));
    assert.ok(isSameProcess(identity), "denied cleanup must retain the live identity for recovery");
  } finally {
    t.mock.restoreAll();
    await runner.stop();
  }
});

test("dev-stack reports an executable startup failure and drains its child handle", async (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  mkdirSync(join(state.directory, "logs"));
  let notify;
  const failure = new Promise((resolve) => { notify = resolve; });
  const runner = new ProcessSupervisor(state, {}, notify);
  try {
    runner.start("missing-fixture", join(directory, "missing-executable"), []);
    const error = await Promise.race([failure, delay(5000).then(() => { throw new Error("startup failure not reported"); })]);
    assert.match(error.message, /missing-fixture could not start:.*ENOENT/);
  } finally { await runner.stop(); }
  assert.deepEqual(state.processes, []);
});

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  test(`smoke restores both edited sources synchronously on ${signal}`, { timeout: 10_000 }, async (t) => {
    const directory = fixture(t);
    const paths = [join(directory, "server.ts"), join(directory, "index.ts")];
    const originals = ["// original API\n", "// original contracts\n"];
    paths.forEach((path, index) => writeFileSync(path, originals[index]));
    // Execute the actual smoke cleanup block in an isolated child, without
    // launching Docker or editing the contributor's real source files.
    const smoke = readFileSync(join(root, "scripts/dev-stack-smoke.mjs"), "utf8");
    const start = smoke.indexOf("const originalFiles = new Map();");
    const end = smoke.indexOf("\ntry {", start);
    assert.ok(start >= 0 && end > start, "smoke source guard must precede its try/finally");
    const child = childProcess.spawn(process.execPath, ["-e", `
      const { readFileSync, writeFileSync } = require("node:fs");
      const directory = ${JSON.stringify(directory)};
      ${smoke.slice(start, end)}
      for (const path of ${JSON.stringify(paths)}) {
        originalFiles.set(path, readFileSync(path, "utf8"));
        writeFileSync(path, originalFiles.get(path) + "console.log('smoke-marker');\\n");
      }
      process.send("edited");
      setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`fixture exited before editing: ${stderr}`)));
    });
    assert.ok(paths.every((path) => readFileSync(path, "utf8").includes("smoke-marker")));
    child.kill(signal);
    const result = await exited;
    paths.forEach((path, index) => assert.equal(readFileSync(path, "utf8"), originals[index]));
    assert.deepEqual(result, { code, signal: null });
    assert.match(stderr, /Interrupted.*reset/);
  });
}

test("dev-stack foreground supervisor drains real detached children on SIGHUP", { timeout: 25_000 }, async (t) => {
  const directory = fixture(t);
  const stateDirectory = join(root, `.dev-stack-signal-${basename(directory)}`);
  const env = { ...process.env };
  const ports = new Set();
  for (const name of ["API", "WEB", "POSTGRES", "TEMPORAL"]) {
    let port;
    do {
      port = await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); });
      });
    } while (ports.has(port) || [4910, 4911].includes(port));
    ports.add(port);
    env[`SPACE_DEV_${name}_PORT`] = String(port);
  }
  // Execute the actual up/shutdown/finally path and a real private control
  // socket. Stub only Docker, build commands and HTTP readiness; launch four
  // real detached Node children instead of a second complete application.
  const child = childProcess.spawn(process.execPath, ["-e", `
    const cp = require("node:child_process");
    const fs = require("node:fs");
    const { promisify } = require("node:util");
    const docker = () => { throw new Error("Use the promisified Docker fixture"); };
    docker[promisify.custom] = async () => ({ stdout: "", stderr: "" });
    cp.execFile = docker;
    require("node:module").syncBuiltinESMExports();
    (async () => {
      const { up } = await import(${JSON.stringify(join(root, "scripts/dev-stack.mjs"))});
      const { ProcessSupervisor } = await import(${JSON.stringify(join(root, "scripts/dev-stack-processes.mjs"))});
      const start = ProcessSupervisor.prototype.start;
      ProcessSupervisor.prototype.run = async function() {};
      ProcessSupervisor.prototype.start = function(name) {
        return start.call(this, name, process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: {} });
      };
      global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, setupRequired: false, dependencies: { database: "RUNNING", store: "postgres", temporal: "enabled", worker: "RUNNING", cliHost: "RUNNING" } }) });
      console.log = (...values) => {
        if (values.some(value => String(value).includes("Stop: npm run dev:stack"))) {
          process.send({ ready: true, processes: JSON.parse(fs.readFileSync(${JSON.stringify(join(stateDirectory, "manifest.json"))}, "utf8")).processes });
        }
      };
      await up(${JSON.stringify(stateDirectory)});
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  let records = [];
  try {
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
    assert.equal(message.ready, true, stderr);
    records = message.processes;
    assert.equal(records.length, 4);
    assert.ok(records.every(record => isSameProcess(record)));
    child.kill("SIGHUP");
    const [code, signal] = await exited;
    assert.equal(records.filter(record => isSameProcess(record)).length, 0, `SIGHUP left detached services alive (supervisor exit ${signal ?? code})`);
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    const saved = readState(root, stateDirectory);
    assert.deepEqual(saved.processes, []);
    assert.equal(saved.controller, null);
    assert.equal(existsSync(join(stateDirectory, "supervisor.lock")), false);
    assert.equal(existsSync(join(saved.runtime, "control.sock")), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
    const saved = readState(root, stateDirectory);
    await stopRecords([...records, ...(saved?.processes ?? [])]);
    if (saved?.runtime) { runtimeDirectory(saved); rmSync(saved.runtime, { recursive: true, force: true }); }
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

for (const legacy of [false, true]) {
  test(`dev-stack seeds canonical Space Memory files and preserves ${legacy ? "legacy content" : "source templates"}`, (t) => {
    const directory = fixture(t);
    const state = initializeState(directory, statePath(directory, {}), {});
    runtimeDirectory(state);
    t.after(() => rmSync(state.runtime, { recursive: true, force: true }));
    const memory = join(state.directory, "data/memory");
    mkdirSync(memory, { recursive: true });
    if (legacy) {
      writeFileSync(join(memory, "gemini_history.md"), "existing private index\n");
      writeFileSync(join(memory, "gemini_history_monthly.md"), "existing monthly history\n");
    }
    prepareFiles(state);
    const env = serviceEnvironment(state, ensureSecrets(state));
    for (const [file, key, content] of [
      ["space_memory.md", "SPACE_MEMORY_INDEX_PATH", "existing private index\n"],
      ["space_memory_monthly.md", "SPACE_MEMORY_MONTHLY_PATH", "existing monthly history\n"]
    ]) {
      const path = join(memory, file);
      assert.equal(env[key], path);
      assert.equal(readFileSync(path, "utf8"), legacy ? content : readFileSync(join(root, "starter-memory", file), "utf8"));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      writeFileSync(path, "subsequent user edit\n");
    }
    prepareFiles(state);
    for (const file of ["space_memory.md", "space_memory_monthly.md"]) assert.equal(readFileSync(join(memory, file), "utf8"), "subsequent user edit\n");
    if (legacy) assert.equal(readFileSync(join(memory, "gemini_history.md"), "utf8"), "existing private index\n");
  });
}

for (const [target, kind] of [["data", "symlink"], ["bin/opencode-vscode-parity", "symlink"], ["data/memory/space_memory.md", "symlink"], ["data/memory/gemini_history.md", "symlink"], ["data/memory/space_memory.md", "hardlink"], ["data/memory/space_memory.md", "dangling"]]) {
  test(`redteam: preparation refuses ${kind} ${target} without touching outside data`, (t) => {
    const directory = fixture(t);
    const state = initializeState(directory, statePath(directory, {}), {});
    runtimeDirectory(state);
    t.after(() => rmSync(state.runtime, { recursive: true, force: true }));
    const outside = join(directory, "outside");
    const path = join(state.directory, target);
    mkdirSync(join(path, ".."), { recursive: true });
    if (target === "data") mkdirSync(outside);
    else if (kind !== "dangling") writeFileSync(outside, "private outside canary\n", { mode: 0o644 });
    if (kind === "hardlink") linkSync(outside, path); else symlinkSync(outside, path);
    assert.throws(() => prepareFiles(state), /private|symlink|directory/i);
    if (target === "data") assert.deepEqual(readdirSync(outside), []);
    else if (kind === "dangling") assert.equal(existsSync(outside), false);
    else {
      assert.equal(readFileSync(outside, "utf8"), "private outside canary\n");
      assert.equal(statSync(outside).mode & 0o777, 0o644);
    }
  });
}

test("redteam: preparation refuses a symlinked runtime tmp directory", (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  runtimeDirectory(state);
  t.after(() => rmSync(state.runtime, { recursive: true, force: true }));
  const outside = join(directory, "outside-tmp");
  mkdirSync(outside, { mode: 0o755 });
  symlinkSync(outside, join(state.runtime, "tmp"));
  assert.throws(() => prepareFiles(state), /private directory/);
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(statSync(outside).mode & 0o777, 0o755);
});

test("redteam: hard-linked secrets cannot change an outside file's permissions", (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  ensureSecrets(state);
  const path = join(state.directory, "secrets/postgres-password");
  const outside = join(directory, "outside-secret");
  writeFileSync(outside, "a".repeat(64), { mode: 0o644 });
  rmSync(path);
  linkSync(outside, path);
  assert.throws(() => ensureSecrets(state), /private|secret file/i);
  assert.equal(statSync(outside).mode & 0o777, 0o644);
  assert.equal(readFileSync(outside, "utf8"), "a".repeat(64));
});

test("redteam: the OpenCode wrapper refuses a linked provider home before creating account data", (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  const outside = join(directory, "outside-provider");
  mkdirSync(outside, { mode: 0o755 });
  mkdirSync(join(state.directory, "data"));
  symlinkSync(outside, join(state.directory, "data/providers"));
  const result = childProcess.spawnSync(process.execPath, [join(root, "scripts/dev-stack-opencode.mjs"), state.directory, "inspect-env"], { encoding: "utf8", timeout: 5000 });
  assert.notEqual(result.status, 0, "refuse unsafe provider state even for a diagnostic command");
  assert.match(result.stderr, /private directory/);
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(statSync(outside).mode & 0o777, 0o755);
});

for (const kind of ["symlink", "hardlink"]) {
  test(`redteam: supervision refuses a ${kind} log before launching a child`, async (t) => {
    const directory = fixture(t);
    const state = initializeState(directory, statePath(directory, {}), {});
    mkdirSync(join(state.directory, "logs"));
    const outside = join(directory, "outside-log");
    writeFileSync(outside, "outside canary\n", { mode: 0o644 });
    const path = join(state.directory, "logs/linked.log");
    if (kind === "symlink") symlinkSync(outside, path); else linkSync(outside, path);
    const runner = new ProcessSupervisor(state, {}, () => {});
    try {
      assert.throws(() => runner.start("linked", process.execPath, ["-e", "console.log('unwanted write'); setInterval(()=>{},1000)"], {}, false), /private|symlink|log/i);
      assert.deepEqual(state.processes, []);
    } finally { await runner.stop(); }
    assert.equal(readFileSync(outside, "utf8"), "outside canary\n");
    assert.equal(statSync(outside).mode & 0o777, 0o644);
  });
}

test("redteam: supervision rejects a linked log directory", async (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  const outside = join(directory, "outside-logs");
  mkdirSync(outside, { mode: 0o755 });
  symlinkSync(outside, join(state.directory, "logs"));
  const runner = new ProcessSupervisor(state, {}, () => {});
  try {
    assert.throws(() => runner.start("linked", process.execPath, ["-e", "console.log('unwanted write')"], {}, false), /private directory/);
    assert.deepEqual(state.processes, []);
  } finally { await runner.stop(); }
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(statSync(outside).mode & 0o777, 0o755);
});

test("redteam: replacing a live log path cannot redirect its open descriptor", { timeout: 10_000 }, async (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  const outside = join(directory, "outside-log");
  writeFileSync(outside, "outside canary\n");
  const runner = new ProcessSupervisor(state, {}, () => {});
  const path = join(state.directory, "logs/rotation.log");
  const original = join(state.directory, "logs/rotated.log");
  try {
    runner.start("rotation", process.execPath, ["-e", "console.log('ready'); setInterval(()=>console.log('tick'),20)"], {}, false);
    for (let i = 0; i < 100 && (!existsSync(path) || !readFileSync(path, "utf8").includes("ready")); i++) await delay(20);
    assert.match(readFileSync(path, "utf8"), /ready/);
    renameSync(path, original);
    symlinkSync(outside, path);
    const size = statSync(original).size;
    for (let i = 0; i < 100 && statSync(original).size === size; i++) await delay(20);
    assert.ok(statSync(original).size > size, "continue writing only to the authenticated descriptor");
    assert.equal(readFileSync(outside, "utf8"), "outside canary\n");
  } finally { await runner.stop(); }
});

test("redteam: long newline-free output progresses while split secrets stay redacted", { timeout: 10_000 }, async (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  mkdirSync(join(state.directory, "logs"));
  const secret = "ab".repeat(32);
  const runner = new ProcessSupervisor(state, { secret }, () => {});
  const path = join(state.directory, "logs/long-line.log");
  try {
    const child = runner.start("long-line", process.execPath, ["-e", `
      process.stdout.write("x".repeat(65520) + ${JSON.stringify(secret.slice(0, 20))});
      setTimeout(() => process.stdout.write(${JSON.stringify(secret.slice(20))} + "y".repeat(196608), () => process.send("written")), 50);
      setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "pipe", "pipe", "ipc"] }, false);
    await once(child, "message", { signal: AbortSignal.timeout(3000) });
    for (let i = 0; i < 100 && (!existsSync(path) || statSync(path).size < 131072); i++) await delay(20);
    assert.ok(existsSync(path) && statSync(path).size >= 131072, "must flush a long line while its producer is still running");
  } finally { await runner.stop(); }
  const logged = readFileSync(path, "utf8");
  assert.equal(logged, "x".repeat(65520) + "[redacted]" + "y".repeat(196608));
  assert.ok(!logged.includes(secret));
});

test("redteam: bounded log flushing preserves Unicode characters across its boundary", { timeout: 10_000 }, async (t) => {
  const directory = fixture(t);
  const state = initializeState(directory, statePath(directory, {}), {});
  const runner = new ProcessSupervisor(state, { secret: "a".repeat(64) }, () => {});
  const path = join(state.directory, "logs/unicode.log");
  try {
    const child = runner.start("unicode", process.execPath, ["-e", "process.stdout.write('💫'.repeat(70000),()=>process.send('written')); setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "pipe", "ipc"] }, false);
    await once(child, "message", { signal: AbortSignal.timeout(3000) });
    for (let i = 0; i < 100 && (!existsSync(path) || statSync(path).size < 131072); i++) await delay(20);
    assert.ok(existsSync(path) && statSync(path).size >= 131072);
  } finally { await runner.stop(); }
  assert.equal(readFileSync(path, "utf8"), "💫".repeat(70000));
});

for (const isolated of [true, false]) {
  test(`redteam: Vite ${isolated ? "excludes checkout dotenv in the isolated stack" : "preserves standalone dotenv behavior"}`, (t) => {
    const directory = fixture(t);
    writeFileSync(join(directory, ".env.local"), "VITE_STACK_REDTEAM_CANARY=outside-account-canary\n");
    const output = childProcess.execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { resolveConfig } from "vite";
      const config = await resolveConfig({ root: ${JSON.stringify(directory)}, configFile: ${JSON.stringify(join(root, "apps/web/vite.config.ts"))}, logLevel: "silent" }, "serve");
      console.log(JSON.stringify(config.env));
    `], { cwd: root, env: { ...process.env, SPACE_INSTANCE: isolated ? "dev" : "standalone" }, encoding: "utf8", timeout: 20_000 });
    const env = JSON.parse(output.trim());
    assert.equal(env.VITE_STACK_REDTEAM_CANARY, isolated ? undefined : "outside-account-canary");
  });
}
