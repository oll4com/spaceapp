#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { closeSync, readFileSync, existsSync, readlinkSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { readState } from "./dev-stack-state.mjs";
import { processIdentity, signalOwnedGroup, assertGroupsGone, darwinStateCwdProcesses } from "./dev-stack-process.mjs";
import { runAcceptance, assertReadiness, readinessFailureDiagnostic, sourceStartupTimeoutMs } from "./dev-stack-acceptance.mjs";
import { runBrowserProof } from "./dev-stack-browser.mjs";
import { runApiReloadProof, runPackageRebuildProof, createOwnedAppendLog, openOwnedAppendLog, readOwnedLog } from "./dev-stack-reload.mjs";
import { supervisorExitRecord } from "./dev-stack-diagnostics.mjs";
import { resetAfterObservedExit } from "./dev-stack-lifecycle.mjs";

// Explicit isolated POSIX CI only. This is not an operator-host diagnostic.
if (!["linux", "darwin"].includes(process.platform) || process.env.CI !== "true") {
  throw new Error("Run this full-stack mutation proof only in an isolated Linux/macOS CI checkout.");
}
const root = resolve(import.meta.dirname, "..");
if (existsSync(join(root, ".dev-stack"))) throw new Error("CI proof requires fresh absent dev-stack state.");
const logPath = join(process.env.RUNNER_TEMP || tmpdir(), `spaceapp-dev-stack-${process.pid}.txt`);
let ownedLogIdentity;
function spawnSupervisor(action = "up") {
  if (!["up", "rebuild"].includes(action)) throw new Error("Unexpected source supervisor action.");
  const log = action === "up" ? createOwnedAppendLog(logPath) : openOwnedAppendLog(logPath, ownedLogIdentity);
  ownedLogIdentity ??= log.identity;
  const descriptor = log.fd;
  let child;
  try {
    child = spawn(process.execPath, ["scripts/dev-stack.mjs", action], {
      cwd: root, env: process.env, detached: true, stdio: ["ignore", descriptor, descriptor]
    });
  } finally { closeSync(descriptor); }
  const observed = { child, exit: undefined, startError: undefined };
  child.once("error", () => { observed.startError = new Error("CI source supervisor could not start."); });
  child.once("exit", (code, signal) => { observed.exit = { code, signal }; });
  return observed;
}
let supervisor = spawnSupervisor();
const pause = () => new Promise(done => setTimeout(done, 500));
async function until(predicate, timeoutMs, label, requireAlive = true) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (supervisor.startError) throw supervisor.startError;
    if (requireAlive && supervisor.exit) throw new Error(`Supervisor exited before ${label}; inspect the captured source log.`);
    if (await predicate()) return;
    await pause();
  }
  throw new Error(`CI timed out at ${label}.`);
}
function leftovers(state) {
  if (process.platform === "darwin") return darwinStateCwdProcesses(state.stateDir);
  const found = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cwd = readlinkSync(`/proc/${name}/cwd`);
      if (cwd === state.stateDir || cwd.startsWith(`${state.stateDir}${sep}`)) found.push(Number(name));
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error;
    }
  }
  return found;
}
function reset() {
  execFileSync(process.execPath, ["scripts/dev-stack.mjs", "reset"], {
    cwd: root, env: process.env, stdio: "inherit", timeout: 120_000
  });
}
let state;
let receipts = [];
let proof;
let browser;
let apiReload;
let packageRebuild;
let afterRebuild;
let phase = "STARTUP";
let primaryFailure;
let finalReceipt;
const cleanupFailures = [];
async function waitReady(label, requireCurrentSupervisor = false, timeoutMs = sourceStartupTimeoutMs(process.platform)) {
  await until(async () => {
    if (!existsSync(join(root, ".dev-stack", "owner.json"))) return false;
    try {
      state = readState(root);
      if (requireCurrentSupervisor) {
        const record = JSON.parse(readFileSync(join(state.stateDir, "runtime.json"), "utf8"));
        const observed = processIdentity(supervisor.child.pid);
        if (!observed || record.supervisor.pid !== observed.pid || record.supervisor.startId !== observed.startId) return false;
      }
      const response = await fetch(`http://127.0.0.1:${state.ports.api}/readyz?strict=1`, { signal: AbortSignal.timeout(3000) });
      return assertReadiness({ status: response.status, body: await response.json() });
    } catch { return false; }
  }, timeoutMs, label);
}
try {
  await waitReady("strict source startup", true, sourceStartupTimeoutMs(process.platform, true));
  phase = "HTTP_CLI_ACCEPTANCE";
  proof = await runAcceptance({ state });
  phase = "BROWSER_UI_HMR";
  browser = process.platform === "linux"
    ? await runBrowserProof({ state,
      artifactDir: join(process.env.RUNNER_TEMP || tmpdir(), `spaceapp-dev-stack-browser-${process.pid}`) })
    : { performed: false, passed: false, reason: "Browser UI proof runs in the Linux job; this job verifies the native macOS source stack." };
  phase = "API_WATCH";
  apiReload = await runApiReloadProof({ state });
  phase = "PACKAGE_REBUILD";
  packageRebuild = await runPackageRebuildProof({ state, readLog: () => readOwnedLog(logPath, ownedLogIdentity),
    restart: async () => {
      const old = supervisor;
      const oldState = state;
      const oldRuntime = JSON.parse(readFileSync(join(state.stateDir, "runtime.json"), "utf8"));
      supervisor = spawnSupervisor("rebuild");
      await until(() => old.exit !== undefined, 120_000, "old supervisor exits for documented rebuild");
      console.error(JSON.stringify({ ...supervisorExitRecord(old.exit), event: "REBUILD_OLD_EXIT", observed: true }));
      if (old.exit.code !== 0) throw new Error("Rebuild did not stop the original supervisor cleanly.");
      assertGroupsGone(oldRuntime.children);
      await waitReady("new rebuilt source supervisor", true);
      const preserved = state.project === oldState.project && JSON.stringify(state.ports) === JSON.stringify(oldState.ports)
        && Object.keys(oldState.secrets).every(key => state.secrets[key] === oldState.secrets[key]);
      if (!preserved) throw new Error("Rebuild did not preserve the project, ports and generated secrets.");
      return { oldSupervisorExited: true, newSupervisorVerified: true, projectAndSecretsPreserved: true };
    } });
  phase = "POST_REBUILD_ACCEPTANCE";
  afterRebuild = await runAcceptance({ state });
  if (afterRebuild.ownerClaimedNow || afterRebuild.starterRoomId !== proof.starterRoomId || afterRebuild.paneId !== proof.paneId) {
    throw new Error("Rebuild did not retain the original owner, starter room and pane.");
  }
  phase = "WORKER_FAILURE";
  const runtime = JSON.parse(readFileSync(join(state.stateDir, "runtime.json"), "utf8"));
  receipts = runtime.children;
  const worker = receipts.find(record => record.name === "worker");
  if (!worker || !processIdentity(worker.pid)) throw new Error("No running owned worker to test the failure path.");
  signalOwnedGroup(worker);
  await until(() => supervisor.exit !== undefined, 60_000, "visible worker failure shutdown", false);
  if (supervisor.exit.code === 0 || !/worker exited unexpectedly/.test(readOwnedLog(logPath, ownedLogIdentity))) {
    throw new Error("Worker failure did not produce an explicit failing supervisor outcome.");
  }
  assertGroupsGone(receipts);
  if (leftovers(state).length) throw new Error("Processes still have their cwd in owned state; cleanup is incomplete.");
  phase = "RESET";
  reset();
  if (existsSync(state.stateDir)) throw new Error("Reset left the owned state directory.");
  for (const kind of ["container", "volume", "network"]) {
    const remaining = execFileSync("docker", [kind, "ls", "--quiet", ...(kind === "container" ? ["--all"] : []),
      "--filter", `label=com.docker.compose.project=${state.project}`], { encoding: "utf8", timeout: 30_000 }).trim();
    if (remaining) throw new Error(`Reset left owned ${kind} resources.`);
  }
  finalReceipt = {
    schema: "spaceapp.dev-stack-ci.v2", passed: true, platform: process.platform,
    node: process.version, acceptance: proof, browser, apiReload, packageRebuild,
    postRebuildAcceptance: afterRebuild, explicitWorkerFailureVerified: true,
    ownedProcessGroupsGone: true, stateCwdProcessesGone: true, resetStateGone: true,
    ownedContainersVolumesNetworksGone: true,
    browserUiVerified: browser.passed === true, webHotReloadVerified: browser.webReactHmrVerified === true,
    apiWatchReloadVerified: apiReload.passed === true, packageRebuildVerified: packageRebuild.passed === true,
    secondPlatformVerified: false,
    completeIssueAcceptance: false
  };
} catch (error) {
  primaryFailure = error;
} finally {
  if (!supervisor.exit && supervisor.child.pid) {
    // Only the actual child handle just created by this proof; never a historic PID.
    try {
      supervisor.child.kill("SIGTERM");
      await until(() => supervisor.exit !== undefined, 45_000, "proof supervisor cleanup", false);
    } catch (error) { cleanupFailures.push(error); }
  }
  // A failed cleanup remains a failed job. Do not suppress reset/resource errors
  // or declare a clean environment merely because the leader is gone.
  if (state && existsSync(state.stateDir)) {
    try { resetAfterObservedExit(supervisor.exit, reset); } catch (error) { cleanupFailures.push(error); }
  }
  console.error(JSON.stringify({ ...supervisorExitRecord(supervisor.exit),
    event: "FINAL_CURRENT_EXIT", observed: supervisor.exit !== undefined }));
  console.log(`Source-stack log: ${logPath}`);
}
if (primaryFailure || cleanupFailures.length) {
  const code = error => typeof error?.code === "string" && /^[A-Z0-9_]{1,100}$/u.test(error.code)
    ? error.code : "CI_ERROR";
  // Preserve the original phase/failure separately from every cleanup failure.
  // Fixed codes and a locally captured enum-only readiness projection: never
  // print an HTTP body, cookie, ticket, metrics, identity or environment.
  console.error(JSON.stringify({ schema: "spaceapp.dev-stack-ci-failure.v1", passed: false,
    phase, primaryCode: primaryFailure ? code(primaryFailure) : null,
    readiness: readinessFailureDiagnostic(primaryFailure),
    cleanupCodes: cleanupFailures.map(code), cleanupVerified: cleanupFailures.length === 0 }));
  throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures],
    "Source proof or cleanup failed; original and cleanup errors retained separately.");
}
console.log(JSON.stringify(finalReceipt, null, 2));
