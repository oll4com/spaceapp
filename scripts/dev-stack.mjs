import { spawn, fork } from "node:child_process";
import { constants } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { devCompose, devEnvironment, devStackConfig, pinnedDevImages, pinnedOpenCode } from "./dev-stack-config.mjs";
import { devProcessIdentity, devSupervisorIsAlive } from "./dev-stack-process.mjs";

const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const action = process.argv[2] ?? "up";
if (!["up", "down", "reset", "rebuild"].includes(action) || process.argv.length > 3) throw new Error("Usage: npm run dev:stack -- [up|down|reset|rebuild]");
if (process.platform === "win32") throw new Error("Run dev:stack inside WSL2, with Docker integration enabled.");
if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("The contributor stack requires Node 22, matching .nvmrc.");

let config = devStackConfig(root, process.env);
const state = config.state, marker = join(state, "config.json"), runningFile = join(state, "running.json"), controlPath = join(state, "control.sock");
const children = new Set();
let control, closing = false, shutdownPromise, serviceFailure, wroteRunning = false;
let secrets = {};
const safeError = error => redact(error instanceof Error ? error.message : String(error));
function redact(text) {
  for (const value of Object.values(secrets)) if (value) text = text.split(value).join("[redacted]");
  return text;
}
function output(label, stream) {
  let pending = "";
  stream.on("data", chunk => {
    pending += chunk.toString();
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      process.stdout.write(`[${label}] ${redact(pending.slice(0, newline))}\n`);
      pending = pending.slice(newline + 1);
    }
    if (pending.length > 65536) pending = "[oversize service line omitted]";
  });
  stream.on("end", () => { if (pending) process.stdout.write(`[${label}] ${redact(pending)}\n`); });
}
function command(file, args, { cwd = root, env = process.env, quiet = false, tolerate = false, duringShutdown = false } = {}) {
  if (closing && !duringShutdown) return Promise.reject(new Error("Dev stack stopped."));
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    if (!quiet) { output(file, child.stdout); output(file, child.stderr); }
    else { child.stdout.resume(); child.stderr.resume(); }
    child.once("error", error => { children.delete(child); reject(error); });
    child.once("close", code => { children.delete(child); if (code === 0 || tolerate) resolve(code); else reject(new Error(`${file} ${args[0] ?? ""} failed (exit ${code}).`)); });
  });
}
const compose = (args, options = {}) => command("docker", ["compose", "--project-name", config.project, "--project-directory", state, "--file", join(state, "compose.json"), ...args], options);
async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Dev-stack directory must not be a symlink: ${path}`);
  await chmod(path, 0o700);
}
async function secret(name, create = true) {
  const path = join(state, "secrets", name);
  if (create) try { await writeFile(path, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error(`Invalid dev-stack secret file: ${name}`);
  await chmod(path, 0o600);
  return (await readFile(path, "utf8")).trim();
}
async function loadState() {
  try {
    const info = await lstat(state);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Refusing a symlink or non-directory dev-stack state path.");
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  let existing;
  try { existing = JSON.parse(await readFile(marker, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" && !(await readdir(state)).length && action === "up") return false;
    throw new Error("Refusing to use or remove an unrecognized dev-stack directory.");
  }
  if (existing.version !== 1 || existing.root !== root || existing.state !== state || existing.project !== config.project) throw new Error("Dev-stack ownership marker does not match this checkout.");
  const defaults = Object.fromEntries(Object.entries(existing.ports).map(([key, value]) => [`SPACE_DEV_${key.toUpperCase()}_PORT`, String(value)]));
  const requested = action === "down" || action === "reset" ? defaults : { ...defaults, ...process.env };
  config = { ...devStackConfig(root, { ...requested, SPACE_DEV_STACK_DIR: state }), opencode: existing.opencode };
  if (JSON.stringify(config.ports) !== JSON.stringify(existing.ports)) throw new Error("Dev-stack ports differ from this state directory. Stop and reset it before changing ports.");
  secrets = { database: await secret("postgres-password", false), session: await secret("session-secret", false), setup: await secret("setup-token", false), control: await secret("control-token", false) };
  return true;
}
async function initialize() {
  await directory(state);
  for (const name of ["secrets", "home", "tmp", "bin", "vendor", "providers", "workspaces", "artifacts", "memory", "memory-graph", "telegram", "integrations"]) await directory(join(state, name));
  secrets = { database: await secret("postgres-password"), session: await secret("session-secret"), setup: await secret("setup-token"), control: await secret("control-token") };
  config.opencode = pinnedOpenCode(await readFile(join(root, "Dockerfile"), "utf8"));
  await writeFile(marker, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
async function requestStop() {
  let running;
  try { running = JSON.parse(await readFile(runningFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect(controlPath); let result = "";
      socket.setTimeout(3000, () => socket.destroy(new Error("Dev-stack control timed out.")));
      socket.on("connect", () => socket.write(JSON.stringify({ command: "down", token: secrets.control }) + "\n"));
      socket.on("data", data => { result += data; });
      socket.on("error", reject); socket.on("end", () => result.includes('"ok":true') ? resolve() : reject(new Error("Dev-stack control refused shutdown.")));
    });
  } catch (error) {
    if (await devSupervisorIsAlive(running)) throw new Error("The recorded dev-stack supervisor is alive but cannot be reached. Stop its terminal process; no unrelated PID was signalled.");
    // Forked service wrappers stop their own groups on IPC disconnect.
    await delay(5500);
    await rm(runningFile, { force: true });
    return;
  }
  for (let i = 0; i < 120; i++) {
    try { await lstat(runningFile); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    await delay(1000);
  }
  throw new Error("Dev-stack shutdown is still running; state was preserved.");
}
async function stop() {
  if (shutdownPromise) return shutdownPromise;
  closing = true;
  shutdownPromise = (async () => {
    const owned = [...children];
    for (const child of owned) { try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    await Promise.race([Promise.all(owned.map(child => child.exitCode !== null ? undefined : new Promise(resolve => child.once("close", resolve)))), delay(6000)]);
    for (const child of owned) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    if (control) await new Promise(resolve => control.close(resolve));
    await compose(["down", "--remove-orphans"], { duringShutdown: true });
    await rm(runningFile, { force: true });
    await rm(controlPath, { force: true });
  })();
  return shutdownPromise;
}
async function checkPort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", () => reject(new Error(`Port ${port} is in use. Choose unused SPACE_DEV_*_PORT values before initializing the stack.`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
async function waitReady(url, json = false) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (closing) throw serviceFailure ?? new Error("Dev stack stopped.");
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (response.ok && (!json || (await response.json()).ok === true)) return; } catch { /* Startup is asynchronous. */ }
    await delay(1000);
  }
  throw new Error(`Dev stack did not become ready at ${url}. See the labelled service output above.`);
}
function startService(role, env) {
  if (closing) throw new Error("Dev stack stopped.");
  const child = fork(join(root, "scripts", "dev-stack-service.mjs"), [role, root], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.add(child); output(role, child.stdout); output(role, child.stderr);
  const failed = reason => {
    children.delete(child);
    if (!closing) { serviceFailure = new Error(`${role} stopped unexpectedly (${reason}). Stopping this dev stack.`); console.error(safeError(serviceFailure)); process.exitCode = 1; void stop().catch(error => console.error(safeError(error))); }
  };
  child.once("error", error => failed(error.message)); child.once("exit", (code, signal) => failed(signal ?? `exit ${code}`));
  console.log(`[dev-stack] ${role} supervisor PID ${child.pid}`);
}

try {
  const exists = await loadState();
  if (!exists && action !== "up") { console.log("No dev stack exists in this checkout."); }
  else if (action === "down" || action === "reset") {
    await requestStop();
    await compose(["down", "--remove-orphans", ...(action === "reset" ? ["--volumes"] : [])]);
    if (action === "reset") await rm(state, { recursive: true });
    console.log(`Dev stack ${action === "reset" ? "removed" : "stopped"}: ${config.project}`);
  } else if (action === "rebuild") {
    await command("npm", ["run", "build"]);
    console.log("Internal packages rebuilt. Running watch processes pick up imported build changes.");
  } else {
    if (!exists) await initialize();
    try { await lstat(runningFile); throw new Error("This dev stack has a supervisor record. Run dev:stack -- down first."); } catch (error) { if (error.code !== "ENOENT") throw error; }
    config.opencode = pinnedOpenCode(await readFile(join(root, "Dockerfile"), "utf8"));
    await writeFile(marker, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    const images = pinnedDevImages(await readFile(join(root, "packages/run-spaceapp/templates/compose.yml"), "utf8"));
    await writeFile(join(state, "secrets/temporal.env"), `POSTGRES_PWD=${secrets.database}\n`, { mode: 0o600 });
    await writeFile(join(state, "compose.json"), JSON.stringify(devCompose(config, images), null, 2), { mode: 0o600 });
    const env = devEnvironment(config, secrets, process.env);
    await writeFile(join(state, "secrets/database-url"), env.SPACE_DATABASE_URL + "\n", { mode: 0o600 });
    const identity = await devProcessIdentity(process.pid);
    if (!identity) throw new Error("Cannot record this dev-stack supervisor's process identity.");
    await writeFile(runningFile, JSON.stringify({ pid: process.pid, identity, project: config.project }), { flag: "wx", mode: 0o600 });
    wroteRunning = true;
    await rm(controlPath, { force: true });
    control = net.createServer(socket => {
      let body = ""; socket.setTimeout(3000, () => socket.destroy());
      socket.on("data", data => {
        body += data; if (body.length > 1024) { socket.destroy(); return; }
        if (!body.includes("\n")) return;
        try {
          const request = JSON.parse(body), supplied = Buffer.from(String(request.token ?? "")), expected = Buffer.from(secrets.control);
          if (request.command !== "down" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { socket.destroy(); return; }
          socket.end('{"ok":true}\n'); void stop().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
        } catch { socket.destroy(); }
      });
    });
    await new Promise((resolve, reject) => { control.once("error", reject); control.listen(controlPath, resolve); });
    await chmod(controlPath, 0o600);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stop().catch(error => { console.error(safeError(error)); process.exitCode = 1; }); });
    for (const port of Object.values(config.ports)) await checkPort(port);
    await command("docker", ["compose", "version"], { quiet: true });
    await command("docker", ["info", "--format", "{{.ServerVersion}}"], { quiet: true });
    try { await compose(["up", "-d", "--wait", "--wait-timeout", "240"]); }
    catch (error) {
      await compose(["logs", "--no-color", "--tail", "40"], { tolerate: true });
      throw error;
    }
    const namespaceArgs = ["exec", "-T", "temporal", "temporal", "operator", "namespace"];
    if (await compose([...namespaceArgs, "describe", "--namespace", config.namespace, "--address", "temporal:7233"], { quiet: true, tolerate: true })) {
      await compose([...namespaceArgs, "create", "--namespace", config.namespace, "--address", "temporal:7233"]);
    }
    await command("npm", ["run", "build"]);
    // node-pty 1.1.0's macOS prebuild can arrive with a non-executable helper.
    // Only normalize the helper inside this checkout's installed dependency.
    if (process.platform === "darwin") {
      for (const directory of [`prebuilds/darwin-${process.arch}`, "build/Release"]) {
        const helper = join(root, "node_modules/node-pty", directory, "spawn-helper");
        try {
          const info = await lstat(helper);
          if (info.isFile() && !info.isSymbolicLink()) await chmod(helper, info.mode | 0o111);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
    await command("npm", ["install", "--prefix", join(state, "vendor"), "--no-audit", "--no-fund", "--save-exact", `opencode-ai@${config.opencode}`], { env });
    await copyFile(join(root, "scripts/dev-stack-opencode.mjs"), join(state, "bin/opencode-vscode-parity"));
    await chmod(join(state, "bin/opencode-vscode-parity"), 0o700);
    await writeFile(join(state, "bin/package.json"), '{"type":"module"}\n', { mode: 0o600 });
    for (const name of ["gemini_history.md", "gemini_history_monthly.md", "installation-guide.md"]) {
      try { await copyFile(join(root, "starter-memory", name), join(state, "memory", name), constants.COPYFILE_EXCL); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    await command(process.execPath, ["packages/db/dist/migrate.js"], { env });
    for (const role of ["cli", "worker", "api", "web"]) startService(role, env);
    await waitReady(`http://127.0.0.1:${config.ports.api}/readyz`, true);
    await waitReady(`http://127.0.0.1:${config.ports.web}/`);
    if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${secrets.setup}`);
    console.log(`\nDev stack ready: http://127.0.0.1:${config.ports.web}\nOne-time owner setup token: ${secrets.setup}\nToken expires 15 minutes after API startup. Browser service and admin shell are disabled.\nStop: npm run dev:stack -- down\nRemove this stack's data: npm run dev:stack -- reset`);
  }
} catch (error) {
  console.error(safeError(error)); process.exitCode = 1;
  if (control) { try { await stop(); } catch (stopError) { console.error(safeError(stopError)); } }
  else if (wroteRunning) { try { await rm(runningFile, { force: true }); } catch (cleanupError) { console.error(safeError(cleanupError)); } }
}
