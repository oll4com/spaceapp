#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, unlinkSync, lstatSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { initState, readState, removeState } from "./dev-stack-state.mjs";
import { resolvePorts, readImages, readOpenCodeVersion, composeConfig, serviceEnv } from "./dev-stack-config.mjs";
import { processIdentity, processIdentityFailureDiagnostic, sameProcess, signalOwnedProcess, createShutdownSignals, waitGroupsGone, verifyShutdownGroups } from "./dev-stack-process.mjs";
import { openCodeWrapper } from "./dev-stack-wrapper.mjs";
import { withLifecycleAdmission } from "./dev-stack-lifecycle.mjs";
import { prepareDevPtyDependency } from "./dev-stack-native.mjs";
import { cleanupFailureRecord } from "./dev-stack-diagnostics.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));

const observedStepNames = new Set(["Docker prerequisites", "start PostgreSQL and Temporal",
  "build source and workspace packages", "database migrations", "install pinned state-local OpenCode"]);

/** Fixed-label monotonic progress only; never serialize commands, env or errors. */
export async function runObservedStep(name, run, { clock = () => performance.now(),
  emit = record => console.log(JSON.stringify(record)) } = {}) {
  if (!observedStepNames.has(name) || typeof run !== "function" || typeof clock !== "function" || typeof emit !== "function") {
    throw new Error("Invalid source-step observation.");
  }
  const started = clock();
  emit({ schema: "spaceapp.dev-stack-step.v1", step: name, event: "START", elapsedMs: 0 });
  let result;
  try { result = await run(); }
  catch (error) {
    emit({ schema: "spaceapp.dev-stack-step.v1", step: name, event: "FAIL",
      elapsedMs: Math.max(0, Math.round(clock() - started)) });
    throw error;
  }
  emit({ schema: "spaceapp.dev-stack-step.v1", step: name, event: "END",
    elapsedMs: Math.max(0, Math.round(clock() - started)) });
  return result;
}

export async function waitUntil(predicate, { timeoutMs = 180_000, intervalMs = 250, label = "condition", signal } = {}) {
  const deadline = performance.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    if (await predicate()) return;
    await delay(intervalMs);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${label}.`);
}

function privateWrite(path, content, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { flag: "wx", mode });
  renameSync(temporary, path);
}

function redact(value, state) {
  let output = String(value);
  for (const secret of Object.values(state.secrets)) output = output.replaceAll(secret, "[REDACTED]");
  return output;
}

function paths(state) {
  return {
    compose: join(state.stateDir, "compose.json"),
    runtime: join(state.stateDir, "runtime.json"),
    lock: join(state.stateDir, "running.lock")
  };
}

function composeArguments(state, ...args) {
  return ["compose", "--project-name", state.project, "--file", paths(state).compose, ...args];
}

export function assertComposeMatches(content, state, images) {
  let actual;
  try { actual = JSON.parse(content); }
  catch { throw new Error("Owned compose file is not valid JSON; refusing Docker cleanup."); }
  if (!isDeepStrictEqual(actual, composeConfig(state, images))) {
    throw new Error("Owned compose configuration differs from this checkout's expected project/services/volumes; refusing Docker cleanup.");
  }
}

function validateOwnedCompose(state) {
  const file = paths(state).compose;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536 ||
      (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)) {
    throw new Error("Owned compose file is not a bounded private regular file; refusing Docker cleanup.");
  }
  assertComposeMatches(readFileSync(file, "utf8"), state, readImages(state.repoRoot));
}

function dockerEnvironment(state) {
  // Docker Desktop/Colima may select a socket through the user's existing Docker
  // context. This is not forwarded to application or provider processes.
  const context = { DOCKER_CONFIG: join(homedir(), ".docker") };
  for (const key of ["DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
    if (process.env[key]) context[key] = process.env[key];
  }
  return { ...serviceEnv(state), ...context, DEV_STACK_POSTGRES_PASSWORD: state.secrets.postgresPassword };
}

function removeEmptyLock(path) {
  try { rmdirSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function removeClosedSocket(state) {
  const socket = join(state.stateDir, "h.sock");
  try {
    if (!lstatSync(socket).isSocket()) throw new Error("CLI socket path is not a socket; refusing cleanup.");
    unlinkSync(socket);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function relayOutput(stream, name, state) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  stream.on("data", chunk => {
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      process.stdout.write(`[${name}] ${redact(pending.slice(0, newline + 1), state)}`);
      pending = pending.slice(newline + 1);
    }
    if (Buffer.byteLength(pending) > 65536) {
      pending = "";
      process.stdout.write(`[${name}] oversized diagnostic line omitted.\n`);
    }
  });
  stream.on("end", () => {
    pending += decoder.end();
    if (pending) process.stdout.write(`[${name}] ${redact(pending, state)}\n`);
  });
}

function dockerOutput(state, args) {
  try {
    return execFileSync("docker", args, {
      cwd: state.repoRoot, env: dockerEnvironment(state), encoding: "utf8", timeout: 90_000,
      maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    throw new Error("Docker operation failed; resources are not certified clean. Check Docker/Compose and retry down/reset explicitly.");
  }
}

function resourceIds(state, kind) {
  return dockerOutput(state, [kind, "ls", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${state.project}`]);
}

function assertDockerGone(state, includeVolumes) {
  // docker ps, unlike docker container ls, accepts the same all/quiet flags.
  if (resourceIds(state, "container")) throw new Error("Owned Docker containers remain; cleanup is incomplete.");
  if (includeVolumes) {
    const volumes = dockerOutput(state, ["volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${state.project}`]);
    if (volumes) throw new Error("Owned Docker volumes remain; reset is incomplete.");
    const networks = dockerOutput(state, ["network", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${state.project}`]);
    if (networks) throw new Error("Owned Docker networks remain; reset is incomplete.");
  }
}

function readRuntime(state) {
  if (!existsSync(paths(state).runtime)) return null;
  const info = lstatSync(paths(state).runtime);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) {
    throw new Error("Runtime ownership receipt is not a bounded regular file.");
  }
  const runtime = JSON.parse(readFileSync(paths(state).runtime, "utf8"));
  if (runtime.schema !== "spaceapp.dev-stack-runtime.v1" || runtime.project !== state.project ||
      runtime.repoRoot !== state.repoRoot || !Array.isArray(runtime.children) || !runtime.supervisor) {
    throw new Error("Runtime ownership record is invalid; refusing process teardown.");
  }
  return runtime;
}

async function stopState(state, reset = false, { signal } = {}) {
  signal?.throwIfAborted();
  validateOwnedCompose(state);
  const runtime = readRuntime(state);
  if (runtime) {
    // Never signal the shared npm/shell process group or trust PID alone.
    signalOwnedProcess(runtime.supervisor);
    await waitUntil(() => {
      const current = processIdentity(runtime.supervisor.pid, "SUPERVISOR_SHUTDOWN_WAIT");
      if (!current) return true;
      if (current.startId !== runtime.supervisor.startId) throw new Error("Supervisor PID was reused; refusing teardown escalation.");
      return false;
    }, { timeoutMs: 30_000, label: "supervisor shutdown", signal });
    signal?.throwIfAborted();
    const shutdown = createShutdownSignals();
    shutdown.signalAll(runtime.children);
    await verifyShutdownGroups(runtime.children, shutdown, { timeoutMs: 10_000, label: "owned child process groups to exit", signal });
  } else if (existsSync(paths(state).lock)) {
    throw new Error("A running lock has no complete process receipt; inspect it before recovery. No automatic deletion or PID guessing.");
  }
  signal?.throwIfAborted();
  if (!existsSync(paths(state).compose)) throw new Error("Owned compose file is missing; refusing to guess cleanup targets.");
  dockerOutput(state, composeArguments(state, "down", "--remove-orphans", ...(reset ? ["--volumes"] : [])));
  assertDockerGone(state, reset);
  // No cancellation point inside the runtime/running-lock finalization sequence.
  removeClosedSocket(state);
  if (runtime) {
    rmSync(paths(state).runtime, { force: true });
    removeEmptyLock(paths(state).lock);
  }
  if (reset) removeState(state.repoRoot);
  console.log(reset ? "dev-stack reset: owned process groups, containers, volumes, network and state removed." :
    "dev-stack down: owned processes and containers stopped; state and database volume retained.");
}

async function up(state, releaseAdmission = () => {}, handoffSignals = () => {}) {
  const location = paths(state);
  mkdirSync(location.lock, { mode: 0o700 }); // Exclusive; never remove a pre-existing lock.
  const children = new Map();
  const receipts = [];
  const errors = [];
  const shutdown = createShutdownSignals();
  let stopping = false;
  let ownershipLost = false;
  let supervisor;
  try { supervisor = processIdentity(process.pid); }
  catch (error) { removeEmptyLock(location.lock); throw error; }
  if (!supervisor) {
    removeEmptyLock(location.lock);
    throw new Error("Cannot establish the supervisor's creation identity; no child or Docker service was started.");
  }
  const save = () => privateWrite(location.runtime, JSON.stringify({
    schema: "spaceapp.dev-stack-runtime.v1", project: state.project, repoRoot: state.repoRoot,
    supervisor, children: receipts
  }, null, 2) + "\n");
  save();
  releaseAdmission(); // running.lock + complete supervisor receipt now block a competing up.

  const launch = (name, command, args, { cwd = repoRoot, env = serviceEnv(state), persistent = false } = {}) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.set(name, child);
    let failure;
    const completion = new Promise((accept, reject) => {
      child.once("error", () => { failure = new Error(`${name} could not start.`); reject(failure); });
      child.once("exit", (code, signal) => {
        children.delete(name);
        if (persistent && !stopping) {
          failure = new Error(`${name} exited unexpectedly (${code ?? signal}); shutting down the dev stack.`);
          errors.push(failure);
          console.error(failure.message);
        }
        if (code === 0 || stopping) accept();
        else reject(failure ?? new Error(`${name} exited with ${code ?? signal}.`));
      });
    });
    // Persistent child errors are observed by the supervisor, never unhandled promises.
    if (persistent) completion.catch(error => { if (!errors.includes(error)) errors.push(error); });
    for (const stream of [child.stdout, child.stderr]) relayOutput(stream, name, state);
    let record = null;
    try { if (child.pid) record = processIdentity(child.pid); }
    catch { /* The direct owned handle is stopped below; no identity claim follows. */ }
    if (!record || !sameProcess(record, record)) {
      ownershipLost = true;
      completion.catch(() => {});
      child.kill("SIGTERM"); // Direct handle from this launch, not a guessed persisted PID.
      throw new Error(`${name} lacks an observed private process identity; shutdown cannot be certified.`);
    }
    receipts.push(Object.freeze({ name, ...record }));
    save();
    return { child, completion };
  };

  const step = async (name, command, args, options) => {
    if (stopping) throw new Error("Dev stack interrupted during startup.");
    console.log(`dev-stack: ${name}`);
    await runObservedStep(name, () => launch(name, command, args, options).completion);
    if (stopping) throw new Error("Dev stack interrupted during startup.");
    if (errors.length) throw errors[0];
  };
  const stop = () => {
    stopping = true;
    shutdown.signalAll(receipts);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    handoffSignals(); // Existing up handlers cover signals before admission scope is removed.
    privateWrite(location.compose, JSON.stringify(composeConfig(state, readImages(repoRoot)), null, 2) + "\n");
    const env = serviceEnv(state);
    if (Buffer.byteLength(join(state.stateDir, "h.sock")) > 100) {
      throw new Error("Checkout is too long for the Unix CLI socket; use a short owned Linux filesystem path.");
    }
    for (const directory of ["bin", "vendor", "workspaces", "artifacts", "memory", "starter-memory", "memory-graph", "providers/opencode/config",
      "providers/opencode/data", "providers/opencode/cache", "providers/opencode/state", "providers/opencode/tmp", "home", "tmp"]) {
      mkdirSync(join(state.stateDir, directory), { recursive: true, mode: 0o700 });
    }
    for (const name of ["gemini_history.md", "gemini_history_monthly.md", "installation-guide.md"]) {
      const destination = join(state.stateDir, "memory", name);
      if (!existsSync(destination)) copyFileSync(join(repoRoot, "starter-memory", name), destination);
      const starter = join(state.stateDir, "starter-memory", name);
      if (!existsSync(starter)) copyFileSync(join(repoRoot, "starter-memory", name), starter);
    }
    privateWrite(join(state.stateDir, "bin", "opencode-vscode-parity"), openCodeWrapper(state), 0o700);
    await step("Docker prerequisites", "docker", ["compose", "version"], { env: dockerEnvironment(state) });
    await step("start PostgreSQL and Temporal", "docker", composeArguments(state, "up", "--detach", "--wait", "--wait-timeout", "240"), { env: dockerEnvironment(state) });
    await step("build source and workspace packages", "npm", ["run", "build"], { env });
    await step("database migrations", "npm", ["run", "db:migrate"], { env });
    if (!existsSync(join(state.stateDir, "vendor", "node_modules", ".bin", "opencode"))) {
      await step("install pinned state-local OpenCode", "npm", ["install", "--prefix", join(state.stateDir, "vendor"),
        "--no-audit", "--no-fund", "--save-exact", `opencode-ai@${readOpenCodeVersion(repoRoot)}`], { env });
    }
    if (stopping) return;
    launch("cli-host", process.execPath, ["packages/cli-host/dist/main.js"], { persistent: true });
    launch("worker", process.execPath, ["apps/worker/dist/worker.js"], { persistent: true });
    launch("api", process.execPath, ["node_modules/tsx/dist/cli.mjs", "watch", "apps/api/src/server.ts"], { persistent: true });
    launch("web", process.execPath, [join(repoRoot, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--strictPort",
      "--port", String(state.ports.web)], { cwd: join(repoRoot, "apps", "web"), persistent: true,
      env: { ...serviceEnv(state), SPACE_DEV_API_ORIGIN: `http://127.0.0.1:${state.ports.api}` } });
    await waitUntil(async () => {
      if (errors.length) throw errors[0];
      if (stopping) throw new Error("Dev stack interrupted during startup.");
      try {
        const response = await fetch(`http://127.0.0.1:${state.ports.api}/readyz?strict=1`, { signal: AbortSignal.timeout(3000) });
        const body = await response.json();
        return response.status === 200 && body.ok === true && body.dependencies?.worker === "RUNNING" &&
          body.dependencies.database === "RUNNING" && body.dependencies.store === "postgres" &&
          body.dependencies.cliHost === "RUNNING";
      } catch { return false; }
    }, { timeoutMs: 240_000, label: "strict readiness with an active Temporal worker" });
    console.log(`\nSpaceApp source: http://127.0.0.1:${state.ports.web}`);
    console.log(`One-time owner setup token (fresh database only): ${state.secrets.setupToken}`);
    console.log("Browser/Chromium, companion services and root-only features are disabled. No provider account is needed to open OpenCode.");
    while (!stopping) {
      if (errors.length) throw errors[0];
      await delay(250);
    }
  } finally {
    stopping = true;
    const cleanupErrors = [];
    const recordCleanupFailure = (stage, error, childName) => {
      cleanupErrors.push(error); // Preserve the original failure, not its diagnostic projection.
      console.error(JSON.stringify(cleanupFailureRecord({ stage, error, ...(childName ? { childName } : {}) })));
    };
    if (ownershipLost) cleanupErrors.push(new Error("A launched child's process identity was not established; retain receipts for recovery."));
    shutdown.signalAll(receipts);
    for (const failure of shutdown.failures()) {
      recordCleanupFailure("SIGNAL_CHILD_GROUP", failure.error, failure.record?.name);
    }
    try {
      await waitGroupsGone(receipts, { timeoutMs: 10_000, label: "child shutdown" });
    } catch (error) { recordCleanupFailure("WAIT_CHILD_GROUPS", error); }
    try {
      if (existsSync(location.compose)) {
        validateOwnedCompose(state);
        dockerOutput(state, composeArguments(state, "down", "--remove-orphans"));
        assertDockerGone(state, false);
      }
    } catch (error) { recordCleanupFailure("DOCKER_SHUTDOWN", error); }
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, "Dev-stack cleanup incomplete; ownership receipt and lock retained. Inspect before retrying down/reset.");
    }
    removeClosedSocket(state);
    rmSync(location.runtime, { force: true });
    removeEmptyLock(location.lock);
  }
}

export async function main(args = process.argv.slice(2)) {
  const action = args[0] ?? "up";
  if (["--help", "help"].includes(action)) {
    console.log("dev:stack [up|down|reset|rebuild|verify] - own isolated source stack; Linux/macOS or Windows11 WSL2, Node22.12+ (<23), Docker Compose v2.");
    return;
  }
  if (args.length > 1 || !["up", "down", "reset", "rebuild", "verify"].includes(action)) throw new Error("Unknown dev-stack action; use --help.");
  if (process.platform === "win32") throw new Error("Run the contributor stack inside Windows11 WSL2, not native Windows. No Windows feature is installed automatically.");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 22 || minor < 12) throw new Error("This checkout requires Node >=22.12 <23.");
  return await withLifecycleAdmission(repoRoot, async ({ signal, checkCancelled, releaseAdmission, handoffToUp }) => {
    if (action === "up") {
      const ports = resolvePorts(process.env);
      if (existsSync(join(repoRoot, ".dev-stack"))) {
        const existing = readState(repoRoot);
        if (existsSync(paths(existing).lock)) throw new Error("Dev stack is already running or has retained recovery state; inspect down/reset before starting.");
      }
      console.log(`dev-stack native prerequisite: ${JSON.stringify(prepareDevPtyDependency(repoRoot))}`);
      checkCancelled();
      return await up(initState(repoRoot, ports), releaseAdmission, handoffToUp);
    }
    const state = readState(repoRoot);
    if (action === "down" || action === "reset") return await stopState(state, action === "reset", { signal });
    if (action === "rebuild") {
      console.log(`dev-stack native prerequisite: ${JSON.stringify(prepareDevPtyDependency(state.repoRoot))}`);
      await stopState(state, false, { signal });
      checkCancelled();
      return await up(state, releaseAdmission, handoffToUp);
    }
    const { runAcceptance } = await import("./dev-stack-acceptance.mjs");
    console.log(JSON.stringify(await runAcceptance({ state }), null, 2));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Do not serialize causes that might include service environment or secret-bearing output.
    const diagnostic = processIdentityFailureDiagnostic(error);
    if (diagnostic) console.error(JSON.stringify(diagnostic));
    console.error(`dev-stack failed: ${error.message}`);
    process.exitCode = 1;
  });
}
