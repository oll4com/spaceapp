#!/usr/bin/env node
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compose,
  dockerResources,
  ensureBuild,
  ensureTemporalNamespace,
  installOpenCode,
  ownerSetupBanner,
  parseOpenCodeVersion,
  parsePinnedImages,
  prepareState,
  renderCompose,
  resolveConfig,
  run,
  sleep,
  sourceEnv,
  waitHealthy,
  waitReady
} from "./dev-stack-lib.mjs";
import {
  assertSafeDevStackOverrides,
  claimStateOwnership,
  claimSupervisor,
  clearProcessRecords,
  ownedSupervisorPid,
  readStateOwnership,
  releaseSupervisor,
  spawnOwnedProcess,
  terminateOwnedProcessGroups,
  writeProcessRecords
} from "./dev-stack-safety.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function prefixStream(stream, label, target) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) target.write(`[${label}] ${line}\n`);
  });
  stream.on("end", () => { if (pending) target.write(`[${label}] ${pending}\n`); });
}

export function spawnService(config, name, command, args, env, ownership, onUnexpectedExit) {
  const child = spawnOwnedProcess(ownership, command, args, {
    cwd: config.root,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.once("error", (error) => onUnexpectedExit(name, child, null, error));
  if (!Number.isInteger(child.pid) || child.pid <= 1) throw new Error(`Could not establish a process-group leader for ${name}.`);
  prefixStream(child.stdout, name, process.stdout);
  prefixStream(child.stderr, name, process.stderr);
  child.once("exit", (code, signal) => onUnexpectedExit(name, child, code, signal));
  return {
    child,
    record: { name, pid: child.pid, pgid: child.pid, sid: child.pid }
  };
}

export async function ensureDarwinNodePtySpawnHelpers(root, platform = process.platform) {
  if (platform !== "darwin") return [];
  const prebuilds = join(root, "node_modules", "node-pty", "prebuilds");
  if (!existsSync(prebuilds)) return [];

  const repaired = [];
  for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("darwin-")) continue;
    const helper = join(prebuilds, entry.name, "spawn-helper");
    if (!existsSync(helper)) continue;
    const info = await stat(helper);
    const currentMode = info.mode & 0o777;
    const desiredMode = currentMode | 0o111;
    if (currentMode === desiredMode) continue;
    await chmod(helper, desiredMode);
    repaired.push(helper);
  }
  return repaired;
}

// Four service groups can each use 7s graceful + 2s forced termination, then
// Docker stops the dependent containers. Include bounded VM/CLI overhead too;
// 15s could expire while a healthy Colima teardown was still making progress.
async function waitSupervisorExit(config, pid, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ownedSupervisorPid(config, { strict: false }) !== pid) return;
    await sleep(100);
  }
  throw new Error(`Dev-stack supervisor ${pid} did not stop cleanly.`);
}

async function waitServiceHealthyWithDiagnostics(config, service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "missing";
  while (Date.now() < deadline) {
    const id = (await compose(config, ["ps", "-q", service], { capture: true })).stdout;
    if (id) {
      const status = await run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", id], {
        capture: true,
        allowFailure: true
      });
      lastStatus = status.stdout || `inspect-exit-${status.code}`;
      if (lastStatus === "healthy") return;
      if (["exited", "dead"].includes(lastStatus)) break;
    }
    await sleep(1000);
  }

  const logs = await compose(config, ["logs", "--no-color", "--tail", "200", service], { capture: true, allowFailure: true });
  const diagnostic = [logs.stdout, logs.stderr].filter(Boolean).join("\n");
  if (diagnostic) process.stderr.write(`[dev:stack] ${service} diagnostic logs:\n${diagnostic}\n`);
  throw new Error(`${service} did not become healthy within ${Math.round(timeoutMs / 1000)} seconds; last status=${lastStatus}.`);
}

async function ownershipForCleanup(config) {
  if (existsSync(config.stateRoot)) return readStateOwnership(config);
  const resources = await dockerResources(config);
  if (resources.containers.length || resources.volumes.length || resources.networks.length) {
    throw new Error(`Dev-stack Docker resources exist for ${config.project}, but the state ownership record is missing; refusing cleanup because ownership cannot be proven.`);
  }
  return null;
}

async function stopDockerResources(config, ownership, { removeVolumes = false } = {}) {
  const before = await dockerResources(config, ownership);
  const hasRuntimeResources = before.containers.length || before.networks.length || (removeVolumes && before.volumes.length);
  if (hasRuntimeResources) {
    if (existsSync(config.composeFile)) {
      const args = ["down"];
      if (removeVolumes) args.push("-v");
      args.push("--remove-orphans");
      await compose(config, args);
    } else {
      if (before.containers.length) await run("docker", ["rm", "-f", ...before.containers]);
      if (before.networks.length) await run("docker", ["network", "rm", ...before.networks]);
      if (removeVolumes && before.volumes.length) await run("docker", ["volume", "rm", ...before.volumes]);
    }
  }

  const after = await dockerResources(config, ownership);
  if (after.containers.length || after.networks.length || (removeVolumes && after.volumes.length)) {
    throw new Error(`Cleanup left owned Docker resources behind; state preserved for retry: ${JSON.stringify(after)}`);
  }
  return after;
}

async function removeOwnedState(config, ownership) {
  if (!existsSync(config.stateRoot)) return;
  const current = await readStateOwnership(config);
  if (current.token !== ownership.token) throw new Error("Dev-stack state ownership changed during reset; refusing deletion.");
  const quarantine = `${config.stateRoot}.reset-${ownership.token.slice(0, 12)}`;
  if (existsSync(quarantine)) throw new Error(`Cannot reset while recovery directory already exists: ${quarantine}`);
  await rename(config.stateRoot, quarantine);
  try {
    await rm(quarantine, { recursive: true, force: true });
  } catch (error) {
    try { await rename(quarantine, config.stateRoot); }
    catch {
      throw new Error(`State deletion failed and recovery data remains at ${quarantine}: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw new Error(`State deletion failed; ownership data was restored for retry: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function down(config) {
  const ownership = await ownershipForCleanup(config);
  if (!ownership) return;
  const pid = await ownedSupervisorPid(config);
  if (pid && pid !== process.pid) {
    process.kill(pid, "SIGTERM");
    await waitSupervisorExit(config, pid);
  }
  await terminateOwnedProcessGroups(config, ownership);
  await stopDockerResources(config, ownership);
}

export async function reset(config) {
  const ownership = await ownershipForCleanup(config);
  if (!ownership) {
    console.log("[dev:stack] Reset complete; no owned state or Docker resources exist.");
    return;
  }
  await down(config);
  await terminateOwnedProcessGroups(config, ownership);
  await stopDockerResources(config, ownership, { removeVolumes: true });
  await removeOwnedState(config, ownership);
  const tmpSocketRoot = dirname(config.socketPath);
  if (!tmpSocketRoot.startsWith(config.stateRoot) && tmpSocketRoot.includes(`spaceapp-dev-${config.rootHash}`)) {
    await rm(config.socketPath, { force: true }).catch(() => {});
    await rmdir(tmpSocketRoot).catch((error) => {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
    });
  }
  console.log("[dev:stack] Reset complete; owned containers, volumes, processes and state were removed.");
}

export async function status(config) {
  const stateExists = existsSync(config.stateRoot);
  const ownership = stateExists ? await readStateOwnership(config, { allowMissing: true }) : null;
  const pid = ownership ? await ownedSupervisorPid(config, { strict: false }) : null;
  const resources = await dockerResources(config, ownership);
  const noDockerResources = !resources.containers.length && !resources.volumes.length && !resources.networks.length;
  const payload = {
    running: Boolean(pid),
    supervisorPid: pid,
    project: config.project,
    stateRoot: config.stateRoot,
    ownershipVerified: Boolean(ownership) || (!stateExists && noDockerResources),
    ports: config.ports,
    docker: resources
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

export async function rebuild(config) {
  const ownership = existsSync(config.stateRoot) ? await readStateOwnership(config) : null;
  const pid = ownership ? await ownedSupervisorPid(config) : null;
  if (!pid) {
    await ensureBuild(config, true);
    console.log("[dev:stack] Rebuilt source workspaces; no running supervisor to restart.");
    return;
  }
  process.kill(pid, "SIGHUP");
  console.log(`[dev:stack] Rebuild requested from supervisor ${pid}.`);
}

export async function start(config) {
  await run("docker", ["compose", "version"]);
  const ownership = await claimStateOwnership(config);
  await claimSupervisor(config);

  let children = new Map();
  let stopping = false;
  let shutdownPromise = null;
  let reloadChain = Promise.resolve();
  let processRecordWrite = Promise.resolve();

  const persistChildren = async () => {
    const records = [...children.values()].map((entry) => entry.record);
    processRecordWrite = processRecordWrite.then(() => writeProcessRecords(config, ownership, records));
    await processRecordWrite;
  };

  const runCommand = async (name, command, args, options = {}) => {
    if (stopping) throw new Error(`Refusing to run ${name} while the dev stack is stopping.`);
    // Builds, migrations and npm installs can spawn children of their own.
    // Track the transient group so shutdown owns the whole command tree.
    const child = spawnOwnedProcess(ownership, command, args, {
      cwd: config.root,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const completed = new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code, signal) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`${command} ${args.join(" ")} failed (${code ?? signal}).`));
      });
    });
    if (!Number.isInteger(child.pid) || child.pid <= 1) {
      await completed;
      throw new Error(`Could not establish a process-group leader for ${name}.`);
    }
    prefixStream(child.stdout, name, process.stdout);
    prefixStream(child.stderr, name, process.stderr);
    const entry = { child, record: { name, pid: child.pid, pgid: child.pid, sid: child.pid } };
    children.set(name, entry);
    await Promise.all([persistChildren(), completed]);
    if (children.get(name) === entry) {
      children.delete(name);
      await persistChildren();
    }
    if (stopping) throw new Error(`${name} cancelled while the dev stack is stopping.`);
  };
  const runBuild = (command, args, options) => runCommand("build", command, args, options);

  const stopChildren = async () => {
    const snapshot = [...children.values()];
    children = new Map();
    const records = snapshot.map((entry) => entry.record);
    await processRecordWrite;
    if (records.length) {
      await terminateOwnedProcessGroups(config, ownership, { records, liveChildren: snapshot.map((entry) => entry.child) });
      await clearProcessRecords(config);
    }
    try { await rm(config.socketPath, { force: true }); } catch {}
  };

  const shutdown = (reason) => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      console.log(`[dev:stack] Stopping (${reason})...`);
      let failure = null;
      try { await stopChildren(); }
      catch (error) { failure = error; }
      try { await stopDockerResources(config, ownership); }
      catch (error) { failure ??= error; }
      try { await releaseSupervisor(config); }
      catch (error) { failure ??= error; }
      if (failure) throw failure;
    })();
    return shutdownPromise;
  };

  const finishShutdown = (reason, preferredCode = 0) => {
    void shutdown(reason).then(
      () => process.exit(process.exitCode || preferredCode),
      (error) => {
        process.stderr.write(`[dev:stack] cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    );
  };

  const unexpectedExit = (name, child, code, signal) => {
    if (stopping || child !== children.get(name)?.child) return;
    console.error(`[dev:stack] ${name} exited unexpectedly (${code ?? signal}); stopping the stack.`);
    process.exitCode = 1;
    finishShutdown("child-failure", 1);
  };

  const addChild = async (name, command, args, env) => {
    if (stopping) throw new Error(`Refusing to start ${name} while the dev stack is stopping.`);
    const entry = spawnService(config, name, command, args, env, ownership, unexpectedExit);
    children.set(name, entry);
    await persistChildren();
  };

  const spawnChildren = async (forceBuild = false, state) => {
    await ensureBuild(config, forceBuild, runBuild);
    const repairedHelpers = await ensureDarwinNodePtySpawnHelpers(config.root);
    if (repairedHelpers.length) {
      console.log(`[dev:stack] Repaired execute permission on ${repairedHelpers.length} node-pty macOS spawn helper(s).`);
    }
    const openCodeWrapper = await installOpenCode(config, state.openCodeVersion,
      (command, args, options) => runCommand("opencode-install", command, args, options));
    const env = sourceEnv(config, state.databaseUrl, state.sessionSecret, openCodeWrapper);
    await addChild("cli-host", process.execPath, ["packages/cli-host/dist/main.js"], env);
    await addChild("worker", process.execPath, ["apps/worker/dist/worker.js"], env);
    await addChild("api", "npm", ["exec", "--", "tsx", "watch", "apps/api/src/server.ts"], env);
    await addChild("web", "npm", ["run", "dev", "-w", "@space/web", "--", "--host", "127.0.0.1", "--port", String(config.ports.web)], env);
  };

  let runtimeState = null;
  const reload = () => {
    reloadChain = reloadChain.then(async () => {
      if (stopping) return;
      console.log("[dev:stack] Rebuilding workspaces and restarting source services...");
      await stopChildren();
      if (stopping) return;
      await spawnChildren(true, runtimeState);
      if (stopping) {
        await stopChildren();
        return;
      }
      await waitReady(config);
      console.log("[dev:stack] Rebuild complete; source services are ready.");
    }).catch((error) => {
      console.error(`[dev:stack] rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      finishShutdown("rebuild-failure", 1);
    });
  };

  // Keep handlers installed throughout asynchronous cleanup: a concurrent down
  // or reset must join the same shutdown, not restore the default fatal signal.
  process.on("SIGINT", () => finishShutdown("SIGINT"));
  process.on("SIGTERM", () => finishShutdown("SIGTERM"));
  process.on("SIGHUP", reload);

  try {
    await terminateOwnedProcessGroups(config, ownership);
    await dockerResources(config, ownership);

    const composeTemplate = await readFile(resolve(config.root, "packages/run-spaceapp/templates/compose.yml"), "utf8");
    const dockerfile = await readFile(resolve(config.root, "Dockerfile"), "utf8");
    const images = parsePinnedImages(composeTemplate);
    const openCodeVersion = parseOpenCodeVersion(dockerfile);
    const { databaseUrl, sessionSecret, postgresPassword } = await prepareState(config);
    runtimeState = { databaseUrl, sessionSecret, openCodeVersion };

    await mkdir(dirname(config.composeFile), { recursive: true, mode: 0o700 });
    await writeFile(config.composeFile, renderCompose(config, images, ownership), { mode: 0o600 });
    await writeFile(config.configFile, `${JSON.stringify({
      root: config.root,
      stateRoot: config.stateRoot,
      project: config.project,
      ports: config.ports,
      socketPath: config.socketPath,
      openCodeVersion
    }, null, 2)}\n`, { mode: 0o600 });

    console.log(`[dev:stack] Starting digest-pinned PostgreSQL and Temporal (${config.project})...`);
    await compose(config, ["up", "-d", "postgres", "temporal"], {
      env: { ...process.env, SPACEAPP_DEV_POSTGRES_PASSWORD: postgresPassword }
    });
    await Promise.all([
      waitHealthy(config, "postgres"),
      waitServiceHealthyWithDiagnostics(config, "temporal", 240_000)
    ]);
    await ensureTemporalNamespace(config);
    await ensureBuild(config, false, runBuild);
    console.log("[dev:stack] Applying database migrations...");
    await runCommand("migrations", "npm", ["run", "db:migrate"], { env: { ...process.env, SPACE_DATABASE_URL: databaseUrl } });
    await spawnChildren(false, runtimeState);
    await waitReady(config);
    const setupBanner = await ownerSetupBanner(config);
    console.log("\n============================================================");
    console.log("SpaceApp dev stack is READY");
    console.log(`Web:   http://127.0.0.1:${config.ports.web}`);
    console.log(`API:   http://127.0.0.1:${config.ports.api}`);
    console.log(setupBanner);
    console.log("Package changes: npm run dev:stack -- rebuild");
    console.log("Stop: npm run dev:stack -- down | Reset: npm run dev:stack -- reset");
    console.log("============================================================\n");
    await new Promise(() => {});
  } catch (error) {
    process.exitCode = 1;
    try { await shutdown("startup-failure"); }
    catch (cleanupError) {
      process.stderr.write(`[dev:stack] cleanup failed after startup error: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
    }
    throw error;
  }
}

async function main() {
  const command = process.argv[2] || "up";
  assertSafeDevStackOverrides();
  const config = await resolveConfig();
  if (["up", "start"].includes(command)) return start(config);
  if (["down", "stop"].includes(command)) return down(config);
  if (command === "reset") return reset(config);
  if (command === "status") return status(config);
  if (command === "rebuild") return rebuild(config);
  throw new Error(`Unknown dev:stack command ${JSON.stringify(command)}. Use up, down, reset, status, or rebuild.`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`[dev:stack] ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
