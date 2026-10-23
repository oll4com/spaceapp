#!/usr/bin/env node
// Inject one verified worker failure in opted-in Linux CI, then exercise normal restart.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { devStackTestOwner } from "./dev-stack-test-fixtures.mjs";
import { promisify } from "node:util";

const exec = promisify(execFile);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const arg = process.argv.indexOf("--repo");
const root = arg >= 0 && process.argv[arg + 1] ? resolve(process.argv[arg + 1]) : null;

async function until(label, action, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await pause(200);
  }
  throw new Error(`${label} did not reach its asserted condition within ${timeoutMs}ms.`);
}

async function optionalText(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function ready(body) {
  return body?.ok === true && ["database", "worker", "cliHost"].every((key) => body.dependencies?.[key] === "RUNNING");
}

async function request(base, path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(5_000), cache: "no-store",
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  assert(response.ok, `Local fixture request ${method} ${path} failed with HTTP ${response.status}.`);
  return { response, payload: await response.json() };
}

async function readiness(base) {
  try { const { payload } = await request(base, "/readyz"); return ready(payload) && payload; }
  catch { return false; }
}

async function loginAndRooms(base) {
  const { response, payload } = await request(base, "/api/auth/login", {
    method: "POST", body: devStackTestOwner
  });
  assert.equal(payload.isAuthenticated, true);
  assert.equal(payload.user?.role, "ADMIN");
  assert.equal(typeof payload.user?.id, "string");
  const cookies = response.headers.getSetCookie?.() || [];
  const cookie = (cookies[0] || response.headers.get("set-cookie") || "").split(";", 1)[0];
  assert(cookie, "Ordinary owner login must return a session cookie.");
  const rooms = (await request(base, "/api/rooms", { cookie })).payload;
  const list = Array.isArray(rooms) ? rooms : rooms?.data;
  assert(Array.isArray(list) && list.length > 0);
  return { ownerId: payload.user.id, roomIds: list.map((room) => room.id).sort() };
}

async function liveMembers(groupIds) {
  const result = await exec("ps", ["-axo", "pid=,pgid=,stat="], { timeout: 5_000 });
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    assert(match, "Unexpected process inventory format; refusing to infer cleanup.");
    return { pid: Number(match[1]), pgid: Number(match[2]), state: match[3] };
  }).filter((entry) => groupIds.has(entry.pgid) && !entry.state.startsWith("Z"));
}

async function portClosed(port) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(2_000);
    socket.once("connect", () => { socket.destroy(); resolvePromise(false); });
    socket.once("error", (error) => { socket.destroy(); error.code === "ECONNREFUSED" ? resolvePromise(true) : reject(new Error("Cannot establish whether the owned loopback API port closed.")); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("API port connection timed out; a silent hang is not proof of shutdown.")); });
  });
}

export async function killOwnedWorkerWithPidfd(record, token) {
  // pidfd anchors the exact process even if its numeric PID is reused between checks.
  // Token travels over stdin, never a shell argument or a printed environment.
  const code = `import json, os, signal, sys
data = json.load(sys.stdin)
pid = data['pid']
if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
    raise SystemExit('Linux pidfd support is required; no broad-kill fallback is permitted')
fd = os.pidfd_open(pid, 0)
try:
    env = open('/proc/%d/environ' % pid, 'rb').read().split(b'\\0')
    command = open('/proc/%d/cmdline' % pid, 'rb').read().split(b'\\0')
    expected = ('SPACE_DEV_PROCESS_TOKEN=' + data['token']).encode()
    if expected not in env or len(command) < 2 or command[1] != b'apps/worker/dist/worker.js':
        raise SystemExit('Recorded worker identity does not match this owned source stack')
    if os.getpgid(pid) != data['pgid'] or os.getsid(pid) != data['sid']:
        raise SystemExit('Recorded worker process group/session no longer matches')
    signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
finally:
    os.close(fd)
`;
  await new Promise((resolvePromise, reject) => {
    const child = spawn("python3", ["-c", code], { stdio: ["pipe", "ignore", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Owned-worker pidfd helper timed out; no fallback attempted.")); }, 10_000);
    let stderr = "";
    child.stderr.on("data", (chunk) => { if (stderr.length < 2_000) stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolvePromise() : reject(new Error(`Owned-worker pidfd injection failed (exit ${code}); no fallback attempted. ${stderr.trim()}`)); });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ pid: record.pid, pgid: record.pgid, sid: record.sid, token }));
  });
}

async function main() {
  assert(root, "Pass --repo with the disposable checkout path.");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_OS, "Linux");
  assert.equal(process.env.SPACE_DEV_ACCEPTANCE_MUTATIONS, "1");
  assert(process.env.RUNNER_TEMP);
  const initialExitFile = process.env.SPACE_DEV_INITIAL_EXIT_FILE;
  assert(initialExitFile, "The initial npm-launcher exit-status witness is required.");
  assert.equal(await optionalText(initialExitFile), null, "Initial stack has already exited; do not inject a fault into a failed setup.");
  const log = resolve(process.env.SPACE_DEV_STACK_LOG || join(process.env.RUNNER_TEMP, "dev-stack.log"));
  const evidenceRoot = resolve(process.env.SPACE_DEV_EVIDENCE_DIR || join(process.env.RUNNER_TEMP, "dev-stack-acceptance-evidence"));
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  const sha = await git("rev-parse", "HEAD");
  const baselineStatus = await git("status", "--porcelain=v1");
  const lib = await import(pathToFileURL(join(root, "deploy/docker/dev-stack-lib.mjs")).href);
  const safety = await import(pathToFileURL(join(root, "deploy/docker/dev-stack-safety.mjs")).href);
  safety.assertSafeDevStackOverrides();
  const config = await lib.resolveConfig(process.env, root);
  const persistedConfig = JSON.parse(await readFile(config.configFile, "utf8"));
  for (const key of ["root", "stateRoot", "project", "ports"]) assert.deepEqual(persistedConfig[key], config[key], `Running config ${key} differs from this checkout's selected configuration.`);
  assert((await lstat(config.stateRoot)).isDirectory());
  assert(!(await lstat(config.stateRoot)).isSymbolicLink());
  const ownership = await safety.readStateOwnership(config);
  const supervisor = await safety.ownedSupervisorPid(config);
  assert(supervisor, "A verified live source supervisor is required.");
  const records = await safety.readProcessRecords(config, ownership);
  const workers = records.filter((entry) => entry.name === "worker");
  assert.equal(workers.length, 1);
  const worker = workers[0];
  const groupIds = new Set(records.map((entry) => entry.pgid));
  const api = `http://127.0.0.1:${config.ports.api}`;
  const initialReady = await until("Initial complete readiness", () => readiness(api));
  const owner = await loginAndRooms(api);
  const resources = await lib.dockerResources(config, ownership);
  assert(resources.containers.length >= 2 && resources.volumes.length > 0);
  const logOffset = (await stat(log)).size;
  const receipt = { candidateSha: sha, passed: false, injected: false, clearFailureObserved: false, nonzeroExitObserved: false, failFastCleanupObserved: false, explicitRestartReady: false, originalOwnerAndRoomsPreserved: false };
  let recovery;
  let recoveryError;
  try {
    await killOwnedWorkerWithPidfd(worker, ownership.token);
    receipt.injected = true;
    const suffix = async () => (await readFile(log)).subarray(logOffset).toString("utf8");
    await until("Explicit new worker-failure diagnostic", async () => (await suffix()).includes("worker exited unexpectedly (SIGKILL); stopping the stack."));
    receipt.clearFailureObserved = true;
    const exitStatus = await until("Nonzero original npm-launcher exit witness", async () => {
      const raw = await optionalText(initialExitFile);
      if (raw === null) return false;
      assert(/^[0-9]+\s*$/.test(raw), "Invalid launcher exit witness.");
      assert.notEqual(Number(raw), 0, "A worker crash must not terminate the launcher successfully.");
      return { code: Number(raw) };
    });
    receipt.nonzeroExitObserved = true;
    receipt.launcherExitCode = exitStatus.code;
    await until("Whole owned source stack stopped", async () => {
      if (await safety.ownedSupervisorPid(config, { strict: false })) return false;
      if ((await liveMembers(groupIds)).length) return false;
      const remaining = await lib.dockerResources(config, ownership);
      if (remaining.containers.length || remaining.networks.length) return false;
      assert.deepEqual([...remaining.volumes].sort(), [...resources.volumes].sort(), "Fail-fast down must preserve owned persistent volumes for an explicit restart.");
      return portClosed(config.ports.api);
    });
    receipt.failFastCleanupObserved = true;
    console.log("[dev-stack-worker-probe] PASS owned worker SIGKILL produced a clear failure, nonzero exit, and complete fail-fast shutdown");

    const recoveryExit = join(process.env.RUNNER_TEMP, "dev-stack-recovery.exit");
    await rm(recoveryExit, { force: true });
    const recoveryOffset = (await stat(log)).size;
    // Same documented command; no reset, dev-login, reused auth session, or alternate environment.
    recovery = spawn("bash", ["-c", 'set +e; npm run dev:stack >>"$1" 2>&1; code=$?; printf "%s\\n" "$code" >"$2.tmp"; mv "$2.tmp" "$2"; exit "$code"', "dev-stack-recovery", log, recoveryExit], { cwd: root, detached: true, stdio: "ignore", env: process.env });
    recovery.once("error", (error) => { recoveryError = error; });
    assert(Number.isInteger(recovery.pid) && recovery.pid > 1, "Could not launch the ordinary recovery command.");
    await writeFile(join(process.env.RUNNER_TEMP, "dev-stack-recovery-shell.pid"), `${recovery.pid}\n`, { mode: 0o600 });
    const afterReady = await until("Explicit normal restart readiness", async () => {
      assert(!recoveryError, "The ordinary recovery launcher could not start.");
      assert.equal(await optionalText(recoveryExit), null, "Recovered launcher exited before reaching readiness; inspect the redacted stack log.");
      const body = await readiness(api);
      if (!body) return false;
      const newRecords = await safety.readProcessRecords(config, ownership);
      const newWorker = newRecords.find((entry) => entry.name === "worker");
      if (!newWorker || newWorker.pid === worker.pid || !await safety.ownedSupervisorPid(config)) return false;
      const output = (await readFile(log)).subarray(recoveryOffset).toString("utf8");
      return output.includes('"service":"space-worker"') && output.includes('"status":"running"') && body;
    }, 420_000);
    assert.notEqual(await safety.ownedSupervisorPid(config), supervisor);
    assert.notEqual(afterReady.apiStartedAt, initialReady.apiStartedAt);
    assert.equal((await safety.readStateOwnership(config)).token, ownership.token);
    receipt.explicitRestartReady = true;
    // Assert the real second boot does not advertise the now-consumed setup
    // secret. Restrict inspection to the recovery log suffix: the original
    // first-owner boot legitimately printed its one-time token.
    const restartOutput = await until("Claimed-owner startup banner", async () => {
      const text = (await readFile(log)).subarray(recoveryOffset).toString("utf8");
      return text.includes("Owner setup already complete; sign in with the existing owner account.") && text;
    });
    assert(!restartOutput.includes("Owner setup token: "), "Recovered stack printed a consumed owner setup token.");
    receipt.claimedOwnerTokenSuppressed = true;
    assert.deepEqual(await loginAndRooms(api), owner, "The same owner credentials and room IDs must survive ordinary restart.");
    receipt.originalOwnerAndRoomsPreserved = true;
    assert.equal(await git("rev-parse", "HEAD"), sha);
    assert.equal(await git("status", "--porcelain=v1"), baselineStatus);
    receipt.passed = true;
    console.log("[dev-stack-worker-probe] PASS explicit normal restart, ready dependencies, original owner login and room identities");
  } finally {
    await writeFile(join(evidenceRoot, "worker-recovery-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    // Keep recovery services available for the workflow's existing always-down/reset.
    // With stdio detached and a recorded shell PID, they do not keep this probe alive.
    recovery?.unref();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[dev-stack-worker-probe] FAIL ${error.message}`); process.exitCode = 1; });
}
