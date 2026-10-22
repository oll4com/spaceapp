#!/usr/bin/env node
// npm run dev:stack            start the whole SpaceApp from source (Ctrl-C stops it)
// npm run dev:stack -- down    stop everything it started (data is kept)
// npm run dev:stack -- reset   remove the containers, volumes and state directory it created
// npm run dev:stack -- status  show what is running
// CONTRIBUTING.md, "Run the full app from source", documents ports, variables and troubleshooting.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
  watch, writeFileSync, chmodSync, copyFileSync, renameSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BIND_HOST, CLI_WRAPPER_RUNTIMES, DevStackError, PORT_ENV, STATE_MARKER, buildCliHostEnvironment, buildCoreEnvironment,
  cliHostSocketPath, composeProjectName, directoryMarker, findProcesses, packageBuildOrder, packageForPath, processAlive, processMatches,
  readOpenCodePin, readPinnedImages, rebuildPlan, redact, renderCliWrapper, renderComposeFile, resolvePorts
} from "./dev-stack-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_TEMPLATE = join(repoRoot, "packages", "run-spaceapp", "templates", "compose.yml");
const DOCKERFILE = join(repoRoot, "Dockerfile");
const READY_TIMEOUT_MS = Number.parseInt(process.env.SPACEAPP_DEV_READY_TIMEOUT_MS ?? "240000", 10);
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
const say = (text = "") => process.stdout.write(`${text}\n`);
const info = (text) => say(`${paint("36", "dev-stack:")} ${text}`);
const warn = (text) => process.stderr.write(`${paint("33", "dev-stack: warning:")} ${text}\n`);

// ---------------------------------------------------------------------------------------------------------------
// Settings shared by every command.

function settings() {
  const stateDir = resolve(repoRoot, process.env.SPACEAPP_DEV_STATE_DIR || ".dev-stack");
  if (stateDir === repoRoot || stateDir === homedir() || stateDir === "/" || !relative(stateDir, repoRoot).startsWith("..") && relative(stateDir, repoRoot) !== "") {
    throw new DevStackError(`SPACEAPP_DEV_STATE_DIR=${stateDir} would contain the checkout or your home directory.`);
  }
  const ports = resolvePorts(process.env);
  const project = composeProjectName(stateDir, process.env.SPACEAPP_DEV_PROJECT);
  const socket = cliHostSocketPath(stateDir);
  return {
    stateDir,
    project,
    ports,
    socket,
    paths: {
      secrets: join(stateDir, "secrets"),
      logs: join(stateDir, "logs"),
      run: join(stateDir, "run"),
      bin: join(stateDir, "bin"),
      opencode: join(stateDir, "opencode"),
      compose: join(stateDir, "compose.yml"),
      supervisor: join(stateDir, "run", "supervisor.json"),
      children: join(stateDir, "run", "children.json"),
      marker: join(stateDir, STATE_MARKER),
      opencodeRecord: join(stateDir, "cli", "providers", "opencode", "state", "opencode", "spaceapp-shared-server.json")
    }
  };
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writePrivate(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

// ---------------------------------------------------------------------------------------------------------------
// Docker.

function docker(args, { input, env, allowFailure = false, quiet = false } = {}) {
  const result = spawnSync("docker", args, {
    cwd: repoRoot,
    input,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) {
    throw new DevStackError("Docker is not installed or not on PATH.",
      "Install Docker Engine (Linux), Docker Desktop or Colima (macOS), or Docker inside WSL2 (Windows), then retry.");
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = `${result.stderr}${result.stdout}`.trim().split("\n").slice(-12).join("\n");
    throw new DevStackError(`docker ${args.slice(0, 3).join(" ")} failed (exit ${result.status}).\n${detail}`);
  }
  if (!quiet && result.status === 0 && result.stderr.trim() && args[0] === "compose" && args.includes("up")) {
    for (const line of result.stderr.trim().split("\n")) say(`  ${line}`);
  }
  return result;
}

function compose(s, args, options = {}) {
  const file = existsSync(s.paths.compose) ? ["-f", s.paths.compose] : [];
  return docker(["compose", "-p", s.project, ...file, ...args], options);
}

function dockerPreflight() {
  docker(["version", "--format", "{{.Server.Version}}"], { allowFailure: true });
  const daemon = docker(["info", "--format", "{{.ServerVersion}}"], { allowFailure: true });
  if (daemon.status !== 0) {
    throw new DevStackError("The Docker daemon is not reachable.",
      "Start Docker Desktop or Colima (macOS), `sudo service docker start` (Linux or WSL2), and check `docker info`.");
  }
  const composeVersion = docker(["compose", "version", "--short"], { allowFailure: true });
  if (composeVersion.status !== 0) {
    throw new DevStackError("Docker Compose v2 is missing (`docker compose version` failed).", "Install the docker-compose-plugin package or Docker Desktop.");
  }
  const [major, minor] = composeVersion.stdout.trim().replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
  if (major < 2 || (major === 2 && minor < 24)) {
    throw new DevStackError(`Docker Compose ${composeVersion.stdout.trim()} is too old; the dev stack needs 2.24 or newer.`);
  }
  return { server: daemon.stdout.trim(), compose: composeVersion.stdout.trim() };
}

function projectResources(project) {
  const filter = ["--filter", `label=com.docker.compose.project=${project}`];
  const list = (args) => {
    const result = docker(args, { allowFailure: true });
    return result.status === 0 ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  };
  return {
    containers: list(["ps", "-a", "-q", ...filter]),
    volumes: list(["volume", "ls", "-q", ...filter]),
    networks: list(["network", "ls", "-q", ...filter])
  };
}

// ---------------------------------------------------------------------------------------------------------------
// State directory and secrets.

function prepareStateDir(s) {
  if (existsSync(s.stateDir) && !existsSync(s.paths.marker) && readdirSync(s.stateDir).length > 0) {
    throw new DevStackError(`${s.stateDir} exists and was not created by the dev stack.`, "Choose another SPACEAPP_DEV_STATE_DIR.");
  }
  for (const dir of [s.stateDir, s.paths.secrets, s.paths.logs, s.paths.run, s.paths.bin,
    join(s.stateDir, "data", "memory"), join(s.stateDir, "data", "artifacts"), join(s.stateDir, "data", "memory-graph"),
    join(s.stateDir, "cli", "providers"), join(s.stateDir, "workspaces")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  if (!existsSync(s.paths.marker)) writeFileSync(s.paths.marker, `Created by scripts/dev-stack.mjs for compose project ${s.project}.\n`, { mode: 0o600 });
  if (s.socket.external) mkdirSync(dirname(s.socket.path), { recursive: true, mode: 0o700 });
}

const SECRET_NAMES = ["postgres-password", "session-secret", "setup-token"];

function ensureSecrets(s) {
  const fresh = SECRET_NAMES.filter((name) => !existsSync(join(s.paths.secrets, name)));
  if (fresh.includes("postgres-password") && projectResources(s.project).volumes.length > 0) {
    throw new DevStackError(`The database volume of ${s.project} exists, but its password file in ${s.paths.secrets} is gone.`,
      "Run `npm run dev:stack -- reset` to start with an empty database.");
  }
  for (const name of fresh) writePrivate(join(s.paths.secrets, name), randomBytes(32).toString("base64url"));
  const read = (name) => {
    const path = join(s.paths.secrets, name);
    chmodSync(path, 0o600);
    return readFileSync(path, "utf8").trim();
  };
  const postgresPassword = read("postgres-password");
  const databaseUrl = `postgresql://spaceapp:${encodeURIComponent(postgresPassword)}@${BIND_HOST}:${s.ports.postgres}/spaceapp`;
  writePrivate(join(s.paths.secrets, "database-url"), databaseUrl);
  return { postgresPassword, sessionSecret: read("session-secret"), setupToken: read("setup-token"), databaseUrl };
}

// ---------------------------------------------------------------------------------------------------------------
// Builds.

function newestMtime(dir) {
  let newest = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const mtime = statSync(join(entry.parentPath ?? entry.path, entry.name)).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

function workspaceInfo() {
  const rootPackage = readJson(join(repoRoot, "package.json"));
  const order = packageBuildOrder(rootPackage);
  const dirs = {};
  const dependencies = {};
  for (const dir of readdirSync(join(repoRoot, "packages"))) {
    const manifest = readJson(join(repoRoot, "packages", dir, "package.json"));
    if (!manifest?.name || !order.includes(manifest.name)) continue;
    dirs[manifest.name] = `packages/${dir}`;
    dependencies[manifest.name] = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) => name.startsWith("@space/"));
  }
  return { order, dirs, dependencies, version: readJson(join(repoRoot, "apps", "api", "package.json"))?.version ?? rootPackage.version };
}

const TSC = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

function tsc(projectDir) {
  return new Promise((resolveBuild) => {
    const child = spawn(process.execPath, [TSC, "-p", join(repoRoot, projectDir, "tsconfig.json")], {
      cwd: join(repoRoot, projectDir), stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("close", (code) => resolveBuild({ ok: code === 0, output }));
  });
}

async function buildIfStale(label, projectDir) {
  const src = join(repoRoot, projectDir, "src");
  const dist = join(repoRoot, projectDir, "dist");
  if (existsSync(dist) && newestMtime(dist) >= newestMtime(src)) return false;
  const started = Date.now();
  const result = await tsc(projectDir);
  if (!result.ok) throw new DevStackError(`Building ${label} failed:\n${result.output.trim()}`);
  info(`built ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// OpenCode, pinned by the Dockerfile and installed into the state directory.

function npmCommand() {
  const npmCli = process.env.npm_execpath;
  return npmCli && npmCli.endsWith(".js") ? [process.execPath, [npmCli]] : ["npm", []];
}

function ensureOpenCode(s) {
  const pin = readOpenCodePin(readFileSync(DOCKERFILE, "utf8"));
  const stamp = join(s.paths.opencode, ".installed");
  const binary = join(s.paths.opencode, "node_modules", ".bin", "opencode");
  if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === pin.spec) return { ...pin, binary };
  info(`installing ${pin.spec} (the CLI image's version) into ${relative(repoRoot, s.paths.opencode)}/, not globally...`);
  rmSync(s.paths.opencode, { recursive: true, force: true });
  mkdirSync(s.paths.opencode, { recursive: true, mode: 0o700 });
  writeFileSync(join(s.paths.opencode, "package.json"), `${JSON.stringify({ name: "spaceapp-dev-stack-opencode", private: true }, null, 2)}\n`);
  const [command, prefix] = npmCommand();
  const result = spawnSync(command, [...prefix, "install", "--no-audit", "--no-fund", "--loglevel=error", "--save-exact", pin.spec], {
    cwd: s.paths.opencode, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, npm_config_global: "false" }
  });
  if (result.status !== 0 || !existsSync(binary)) throw new DevStackError(`Installing ${pin.spec} into ${s.paths.opencode} failed.`);
  writeFileSync(stamp, `${pin.spec}\n`);
  return { ...pin, binary };
}

/**
 * node-pty 1.1 ships its macOS spawn-helper without the executable bit, so every pane fails with "posix_spawnp
 * failed" on macOS (Linux does not use the helper). The installed app runs on Linux; the dev stack fixes the mode in
 * this checkout's node_modules, the only place it touches.
 */
function ensureNodePtySpawnHelper() {
  if (process.platform !== "darwin") return;
  const root = join(repoRoot, "node_modules", "node-pty");
  const candidates = [join(root, "build", "Release", "spawn-helper")];
  const prebuilds = join(root, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds)) if (entry.startsWith("darwin-")) candidates.push(join(prebuilds, entry, "spawn-helper"));
  }
  for (const helper of candidates) {
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode & 0o777;
    if ((mode & 0o111) === 0o111) continue;
    chmodSync(helper, mode | 0o111);
    info(`made ${relative(repoRoot, helper)} executable (node-pty ships it without the executable bit on macOS)`);
  }
}

function writeCliWrappers(s) {
  const wrapper = join(s.paths.bin, "spaceapp-cli-wrapper");
  writeFileSync(wrapper, renderCliWrapper({ stateDir: s.stateDir, repoRoot, nodePath: process.execPath, opencodePort: s.ports.opencode }), { mode: 0o700 });
  chmodSync(wrapper, 0o700);
  for (const runtime of CLI_WRAPPER_RUNTIMES) {
    const link = join(s.paths.bin, `${runtime}-vscode-parity`);
    rmSync(link, { force: true });
    // A copy, not a symlink: the wrapper reads its runtime from $0 either way, and a copy works on every filesystem.
    copyFileSync(wrapper, link);
    chmodSync(link, 0o700);
  }
}

function seedMemory(coreEnv) {
  const memory = coreEnv.SPACE_MEMORY_ROOT;
  const starter = coreEnv.SPACE_STARTER_MEMORY_ROOT;
  mkdirSync(memory, { recursive: true, mode: 0o700 });
  const seeds = [
    ["space_memory.md", coreEnv.SPACE_MEMORY_INDEX_PATH ?? join(memory, "space_memory.md")],
    ["space_memory_monthly.md", coreEnv.SPACE_MEMORY_MONTHLY_PATH ?? join(memory, "space_memory_monthly.md")],
    ["installation-guide.md", join(memory, "installation-guide.md")]
  ];
  for (const [name, destination] of seeds) {
    if (!existsSync(destination) && existsSync(join(starter, name))) {
      copyFileSync(join(starter, name), destination);
      chmodSync(destination, 0o600);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Ports.

function portFree(port) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen({ port, host: BIND_HOST, exclusive: true }, () => server.close(() => resolvePort(true)));
  });
}

async function assertPortsFree(s, keys) {
  for (const key of keys) {
    if (!(await portFree(s.ports[key]))) {
      throw new DevStackError(`Port ${s.ports[key]} (${key}) on ${BIND_HOST} is already in use.`,
        `Stop what is using it, or choose another port with ${PORT_ENV[key]}=<port>.`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Supervisor: runs the four processes, rebuilds packages, and fails loudly when a process dies.

const NAMES = { "cli-host": "35", worker: "33", api: "32", web: "34" };

class Supervisor {
  constructor(s, secrets, coreEnv, cliHostEnv, workspace) {
    this.s = s;
    this.secrets = secrets;
    this.coreEnv = coreEnv;
    this.cliHostEnv = cliHostEnv;
    this.workspace = workspace;
    this.entries = new Map();
    this.stopping = false;
    this.redactions = [secrets.postgresPassword, secrets.sessionSecret, secrets.databaseUrl, encodeURIComponent(secrets.postgresPassword)];
    this.quiet = process.env.SPACEAPP_DEV_QUIET === "1";
    this.watchers = [];
    this.lastReady = null;
  }

  specs() {
    const node = process.execPath;
    const s = this.s;
    const env = { ...this.coreEnv, PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? s.stateDir, NODE_ENV: "development",
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), ...(process.env.LANG ? { LANG: process.env.LANG } : {}), FORCE_COLOR: color ? "1" : "0" };
    return {
      "cli-host": { command: node, args: [join(repoRoot, "packages", "cli-host", "dist", "main.js")], cwd: join(s.stateDir, "workspaces"), env: this.cliHostEnv },
      worker: { command: node, args: [join(repoRoot, "apps", "worker", "dist", "worker.js")], cwd: join(repoRoot, "apps", "worker"), env },
      api: { command: node, args: [join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), "watch", "--clear-screen=false", join(repoRoot, "apps", "api", "src", "server.ts")],
        cwd: join(repoRoot, "apps", "api"), env },
      web: { command: node, args: [join(repoRoot, "node_modules", "vite", "bin", "vite.js"), "--host", BIND_HOST, "--port", String(s.ports.web), "--strictPort"],
        cwd: join(repoRoot, "apps", "web"), env: { ...env, SPACE_DEV_API_ORIGIN: `http://${BIND_HOST}:${s.ports.api}` } }
    };
  }

  emit(name, line) {
    const clean = redact(line, this.redactions);
    this.entries.get(name)?.log.write(`${clean}\n`);
    if (!this.quiet) process.stdout.write(`${paint(NAMES[name] ?? "37", `[${name}]`.padEnd(11))}${clean}\n`);
  }

  saveChildren() {
    const children = [...this.entries.entries()].map(([name, entry]) => ({ name, pid: entry.child.pid, marker: entry.marker }));
    writePrivate(this.s.paths.children, JSON.stringify({ supervisor: process.pid, children }, null, 2));
  }

  start(name) {
    const spec = this.specs()[name];
    const log = this.entries.get(name)?.log ?? createWriteStream(join(this.s.paths.logs, `${name}.log`), { flags: "a", mode: 0o600 });
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const entry = { child, log, restarting: false, marker: spec.args[0], tail: [] };
    this.entries.set(name, entry);
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          entry.tail.push(line);
          if (entry.tail.length > 30) entry.tail.shift();
          this.emit(name, line);
        }
      });
    }
    child.once("error", (error) => this.failed(name, `could not start: ${error.message}`));
    child.once("exit", (code, signal) => {
      if (this.stopping || entry.restarting) return;
      this.failed(name, signal ? `was killed by ${signal}` : `exited with code ${code}`);
    });
    this.saveChildren();
    return entry;
  }

  async stopEntry(name, signal = "SIGTERM") {
    const entry = this.entries.get(name);
    if (!entry || entry.child.exitCode !== null || entry.child.signalCode !== null) return;
    const exited = new Promise((resolveExit) => entry.child.once("exit", resolveExit));
    try { process.kill(-entry.child.pid, signal); } catch { /* already gone */ }
    const timeout = delay(10_000).then(() => "timeout");
    if ((await Promise.race([exited, timeout])) === "timeout") {
      try { process.kill(-entry.child.pid, "SIGKILL"); } catch { /* gone */ }
      await exited;
    }
  }

  async restart(name, reason) {
    const entry = this.entries.get(name);
    if (!entry || this.stopping) return;
    entry.restarting = true;
    info(`restarting ${name} (${reason})`);
    await this.stopEntry(name);
    if (this.stopping) return;
    const next = this.start(name);
    info(`${name} restarted (process ${next.child.pid})`);
  }

  failed(name, how) {
    if (this.stopping) return;
    const entry = this.entries.get(name);
    say();
    say(paint("1;31", `dev-stack: FAILED: ${name} ${how}.`));
    if (entry?.tail.length) {
      say(paint("31", `dev-stack: last lines of ${relative(repoRoot, join(this.s.paths.logs, `${name}.log`))}:`));
      for (const line of entry.tail.slice(-15)) say(`  ${redact(line, this.redactions)}`);
    }
    say(paint("31", "dev-stack: stopping the rest of the stack so nothing is left half running. Fix the error and run npm run dev:stack again."));
    void this.shutdown(1);
  }

  async waitForSocket(path, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(path)) return;
      const entry = this.entries.get("cli-host");
      if (!entry || entry.child.exitCode !== null) return;
      await delay(100);
    }
    throw new DevStackError(`The CLI host did not create ${path} within ${timeoutMs / 1000}s.`);
  }

  async waitForApi(timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.stopping) {
      try {
        const response = await fetch(`http://${BIND_HOST}:${this.s.ports.api}/livez`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) return;
      } catch { /* not listening yet */ }
      await delay(300);
    }
  }

  async readyz() {
    try {
      const response = await fetch(`http://${BIND_HOST}:${this.s.ports.web}/readyz`, { signal: AbortSignal.timeout(4_000) });
      const body = await response.json().catch(() => null);
      return { reachable: true, ok: response.ok && body?.ok === true, body };
    } catch (error) {
      return { reachable: false, ok: false, body: null, error: error.message };
    }
  }

  async waitUntilReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last = null;
    while (Date.now() < deadline && !this.stopping) {
      last = await this.readyz();
      if (last.ok) return last;
      await delay(1_000);
    }
    if (this.stopping) return null;
    throw new DevStackError(`/readyz did not report ok within ${READY_TIMEOUT_MS / 1000}s: ${JSON.stringify(last?.body ?? last?.error)}`,
      `See the logs in ${relative(repoRoot, this.s.paths.logs)}/.`);
  }

  /** Prints every change of /readyz after startup, so a stopped dependency shows up instead of hanging silently. */
  monitorReadiness() {
    const timer = setInterval(async () => {
      if (this.stopping) return;
      const state = await this.readyz();
      const summary = state.ok ? "ok" : state.reachable ? describeNotReady(state.body) : `API not reachable (${state.error})`;
      // A restart after a code change takes a few seconds; report a state only once it holds for two checks in a row.
      const previous = this.candidate;
      this.candidate = summary;
      if (summary !== previous) return;
      if (summary !== this.lastReady) {
        if (state.ok) info(paint("32", "/readyz ok again"));
        else say(paint("1;31", `dev-stack: /readyz NOT READY: ${summary}`));
        this.lastReady = summary;
      }
    }, 3_000);
    timer.unref();
    this.readinessTimer = timer;
  }

  watchSources() {
    const { order, dirs, dependencies } = this.workspace;
    let pending = new Set();
    let workerPending = false;
    let timer = null;
    let running = Promise.resolve();
    const flush = () => {
      const changed = [...pending];
      const worker = workerPending;
      pending = new Set();
      workerPending = false;
      running = running.then(async () => {
        if (this.stopping) return;
        const plan = new Set();
        for (const name of changed) for (const item of rebuildPlan(name, order, dependencies)) plan.add(item);
        const ordered = order.filter((name) => plan.has(name));
        for (const name of ordered) {
          const started = Date.now();
          const result = await tsc(dirs[name]);
          if (!result.ok) {
            say(paint("1;31", `dev-stack: rebuilding ${name} failed; the running processes keep the last good build:`));
            for (const line of result.output.trim().split("\n").slice(0, 30)) say(`  ${line}`);
            return;
          }
          info(`rebuilt ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
        }
        if (ordered.length > 0 || worker) {
          if (worker || ordered.length > 0) {
            const result = await tsc("apps/worker");
            if (!result.ok) {
              say(paint("1;31", "dev-stack: rebuilding the worker failed; it keeps running the last good build:"));
              for (const line of result.output.trim().split("\n").slice(0, 30)) say(`  ${line}`);
              return;
            }
          }
          await this.restart("worker", worker && ordered.length === 0 ? "apps/worker/src changed" : `${ordered.join(", ")} rebuilt`);
        }
        if (ordered.includes("@space/cli-host")) await this.restart("cli-host", "@space/cli-host rebuilt");
        // tsx restarts the API by itself when an imported package's dist changes, and Vite reloads the browser.
      });
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(flush, 300);
    };
    for (const [name, dir] of Object.entries(dirs)) {
      const src = join(repoRoot, dir, "src");
      if (!existsSync(src)) continue;
      this.watchers.push(watch(src, { recursive: true }, (_event, file) => {
        if (!file || /(^|[\\/])\.|~$|\.swp$/.test(file)) return;
        if (packageForPath(`${dir}/src/${file}`, dirs) === name) {
          pending.add(name);
          schedule();
        }
      }));
    }
    this.watchers.push(watch(join(repoRoot, "apps", "worker", "src"), { recursive: true }, (_event, file) => {
      if (!file || /(^|[\\/])\.|~$|\.swp$/.test(file)) return;
      workerPending = true;
      schedule();
    }));
  }

  async shutdown(code = 0) {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.readinessTimer);
    for (const watcher of this.watchers) watcher.close();
    info("stopping the web server, API, worker and CLI host...");
    for (const name of ["web", "api", "worker", "cli-host"]) await this.stopEntry(name);
    await stopOpenCodeServer(this.s);
    info("stopping PostgreSQL and Temporal (data is kept)...");
    compose(this.s, ["down", "--timeout", "20"], { allowFailure: true, env: { SPACEAPP_DEV_POSTGRES_PASSWORD: "" } });
    rmSync(this.s.paths.supervisor, { force: true });
    rmSync(this.s.paths.children, { force: true });
    if (this.s.socket.external) rmSync(this.s.socket.path, { force: true });
    info(code === 0 ? "stopped." : paint("31", "stopped after a failure."));
    for (const entry of this.entries.values()) entry.log.end();
    process.exit(code);
  }
}

function describeNotReady(body) {
  if (!body || typeof body !== "object") return "no answer";
  const parts = [];
  for (const [key, value] of Object.entries(body.dependencies ?? body)) {
    if (key === "ok" || key === "checkedAt") continue;
    if (value && typeof value === "object" && typeof value.status === "string" && !["RUNNING", "READY", "ENABLED", "OK", "in-process", "disabled", "DISABLED"].includes(value.status)) {
      parts.push(`${key} ${value.status}${value.statusReason ? ` (${value.statusReason})` : ""}`);
    } else if (typeof value === "string" && ["UNAVAILABLE", "ERROR", "CAPACITY_MISMATCH"].includes(value)) {
      parts.push(`${key} ${value}`);
    }
  }
  return parts.join("; ") || JSON.stringify(body).slice(0, 300);
}

async function stopOpenCodeServer(s) {
  const record = readJson(s.paths.opencodeRecord);
  if (record?.pid && processMatches(record.pid, ["opencode", "serve", String(record.port)])) {
    try { process.kill(record.pid, "SIGTERM"); } catch { /* gone */ }
    for (let i = 0; i < 50 && processAlive(record.pid); i++) await delay(100);
    if (processAlive(record.pid)) { try { process.kill(record.pid, "SIGKILL"); } catch { /* gone */ } }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Commands.

async function up() {
  const s = settings();
  const existing = readJson(s.paths.supervisor);
  if (existing?.pid && processMatches(existing.pid, ["dev-stack.mjs"])) {
    throw new DevStackError(`The dev stack is already running (process ${existing.pid}).`, "Use npm run dev:stack -- down first, or -- status.");
  }
  const versions = dockerPreflight();
  const composeText = readFileSync(COMPOSE_TEMPLATE, "utf8");
  const images = readPinnedImages(composeText);
  const workspace = workspaceInfo();
  info(`state directory   ${relative(repoRoot, s.stateDir) || "."}/ (git-ignored)`);
  info(`compose project   ${s.project} (Docker ${versions.server}, Compose ${versions.compose})`);
  info(`images            ${images.postgres.image}`);
  info(`                  ${images.temporal.image}`);
  info(`                  (read from ${relative(repoRoot, COMPOSE_TEMPLATE)})`);
  info(`ports             app ${s.ports.web}, api ${s.ports.api}, postgres ${s.ports.postgres}, temporal ${s.ports.temporal}, opencode ${s.ports.opencode} (all ${BIND_HOST} only)`);
  await assertPortsFree(s, ["api", "web", "opencode"]);
  prepareStateDir(s);
  const secrets = ensureSecrets(s);
  writePrivate(join(s.paths.run, "supervisor.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), project: s.project }));

  // From here on containers and processes may exist, so every way out (a failure or a signal) cleans them up.
  // Before the supervisor exists that is the containers and the OpenCode server; afterwards Supervisor.shutdown.
  let supervisor;
  let cleaningUp = false;
  const cleanupBeforeSupervisor = async (code) => {
    if (cleaningUp) return;
    cleaningUp = true;
    await stopOpenCodeServer(s);
    info("stopping PostgreSQL and Temporal, startup did not finish (data is kept)...");
    compose(s, ["down", "--timeout", "20"], { allowFailure: true, env: { SPACEAPP_DEV_POSTGRES_PASSWORD: "" } });
    rmSync(s.paths.supervisor, { force: true });
    rmSync(s.paths.children, { force: true });
    if (code !== undefined) process.exit(code);
  };
  const failStartup = async (error) => {
    process.stderr.write(`${paint("1;31", "dev-stack: error:")} ${error.message}\n`);
    if (error.hint) process.stderr.write(`${paint("33", "dev-stack: hint:")} ${error.hint}\n`);
    if (supervisor) await supervisor.shutdown(1);
    else await cleanupBeforeSupervisor(1);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => void (supervisor ? supervisor.shutdown(0) : cleanupBeforeSupervisor(130)));
  }

  try {
    const running = projectResources(s.project).containers.length > 0;
    if (!running) await assertPortsFree(s, ["postgres", "temporal"]);
    writeFileSync(s.paths.compose, renderComposeFile({ images, ports: s.ports, project: s.project }), { mode: 0o600 });
    info("starting PostgreSQL (pgvector) and Temporal in Docker, waiting for their health checks...");
    const started = Date.now();
    compose(s, ["up", "--detach", "--wait", "--wait-timeout", "300", "--remove-orphans"], {
      env: { SPACEAPP_DEV_POSTGRES_PASSWORD: secrets.postgresPassword }, quiet: true
    });
    info(`PostgreSQL and Temporal are healthy (${((Date.now() - started) / 1000).toFixed(0)}s)`);

    const opencode = ensureOpenCode(s);
    info(`OpenCode          ${opencode.spec} in ${relative(repoRoot, s.paths.opencode)}/`);
    writeCliWrappers(s);
    ensureNodePtySpawnHelper();

    for (const name of workspace.order) await buildIfStale(name, workspace.dirs[name]);
    await buildIfStale("@space/worker", "apps/worker");

    const { env: coreEnv } = buildCoreEnvironment({
      composeText, repoRoot, stateDir: s.stateDir, ports: s.ports, socketPath: s.socket.path,
      appVersion: workspace.version, optionalModules: process.env.SPACEAPP_DEV_OPTIONAL_MODULES,
      secrets: { databaseUrl: secrets.databaseUrl, sessionSecret: secrets.sessionSecret }
    });
    seedMemory(coreEnv);

    info("applying database migrations...");
    const migrate = spawnSync(process.execPath, [join(repoRoot, "packages", "db", "dist", "migrate.js")], {
      cwd: repoRoot, env: { PATH: process.env.PATH ?? "", SPACE_DATABASE_URL: secrets.databaseUrl }, encoding: "utf8"
    });
    const migrateOutput = redact(`${migrate.stdout}${migrate.stderr}`, [secrets.postgresPassword, secrets.databaseUrl]).trim();
    if (migrate.status !== 0) throw new DevStackError(`Database migrations failed:\n${migrateOutput}`);
    const applied = migrateOutput.split("\n").filter((line) => line.startsWith("applied ")).length;
    info(applied > 0 ? `applied ${applied} migrations` : "database schema is up to date");

    const cliHostEnv = buildCliHostEnvironment({ coreEnv, stateDir: s.stateDir });
    supervisor = new Supervisor(s, secrets, coreEnv, cliHostEnv, workspace);
    rmSync(s.socket.path, { force: true });
    info("starting the CLI host, worker, API (watch mode) and Vite...");
    supervisor.start("cli-host");
    await supervisor.waitForSocket(s.socket.path);
    supervisor.start("worker");
    supervisor.start("api");
    // Vite proxies /api to the API; starting it once the API listens keeps proxy errors out of the first screen.
    await supervisor.waitForApi();
    supervisor.start("web");
  } catch (error) {
    await failStartup(error);
    return;
  }
  let ready;
  try {
    ready = await supervisor.waitUntilReady();
  } catch (error) {
    await failStartup(error);
    return;
  }
  if (!ready) return;
  supervisor.lastReady = "ok";
  supervisor.watchSources();
  supervisor.monitorReadiness();

  let setupRequired = true;
  try {
    const status = await (await fetch(`http://${BIND_HOST}:${s.ports.api}/api/setup/status`)).json();
    setupRequired = status?.setupRequired !== false;
  } catch { /* print the token anyway */ }
  const worker = ready.body?.dependencies?.worker;
  say();
  say(paint("1;32", "dev-stack: ready. SpaceApp is running from source."));
  say(`  App          ${paint("1", `http://${BIND_HOST}:${s.ports.web}`)}`);
  say(`  API          http://${BIND_HOST}:${s.ports.api}  (/readyz ok${worker ? `, worker ${worker.status ?? worker}` : ""}, workflows enabled)`);
  if (setupRequired) {
    say(`  Setup token  ${paint("1", secrets.setupToken)}`);
    say("               One-time: open the app, enter it, create the owner account, then sign in.");
  } else {
    say("  Owner        already set up; sign in with the owner account.");
  }
  say(`  State, logs  ${relative(repoRoot, s.stateDir)}/, ${relative(repoRoot, s.paths.logs)}/<process>.log`);
  say("  Stop         Ctrl-C, or npm run dev:stack -- down (another terminal)");
  say("  Remove all   npm run dev:stack -- reset");
  say();
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await delay(200);
  }
  return !processAlive(pid);
}

/** Stops the processes and containers; used by `down` and as the first half of `reset`. */
async function stopEverything(s) {
  const record = readJson(s.paths.supervisor);
  if (record?.pid && processMatches(record.pid, ["dev-stack.mjs"])) {
    info(`stopping the running dev stack (process ${record.pid})...`);
    process.kill(record.pid, "SIGTERM");
    if (!(await waitForExit(record.pid, 60_000))) {
      warn("the dev stack did not stop within 60s; stopping its processes directly.");
      try { process.kill(record.pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
  // A supervisor that was killed (kill -9, closed terminal) leaves its process groups behind; stop the ones that
  // still run the recorded command.
  const children = readJson(s.paths.children)?.children ?? [];
  for (const child of children) {
    if (processMatches(child.pid, [child.marker])) {
      info(`stopping leftover ${child.name} (process ${child.pid})`);
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { process.kill(child.pid, "SIGTERM"); } catch { /* gone */ } }
      if (!(await waitForExit(child.pid, 10_000))) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
    }
  }
  await stopOpenCodeServer(s);
  // Pane processes (OpenCode) run from the state directory; none may outlive the stack.
  for (const leftover of findProcesses([directoryMarker(s.stateDir)])) {
    info(`stopping leftover process ${leftover.pid}: ${leftover.command.slice(0, 120)}`);
    try { process.kill(leftover.pid, "SIGTERM"); } catch { /* gone */ }
  }
  dockerPreflight();
  compose(s, ["down", "--timeout", "20"], { allowFailure: true, env: { SPACEAPP_DEV_POSTGRES_PASSWORD: "" } });
  rmSync(s.paths.supervisor, { force: true });
  rmSync(s.paths.children, { force: true });
}

async function down() {
  const s = settings();
  await stopEverything(s);
  info(`stopped. Data is kept in the ${s.project} volumes and ${relative(repoRoot, s.stateDir)}/; npm run dev:stack starts it again.`);
}

async function reset() {
  const s = settings();
  await stopEverything(s);
  compose(s, ["down", "--volumes", "--remove-orphans", "--timeout", "10"], { allowFailure: true, env: { SPACEAPP_DEV_POSTGRES_PASSWORD: "" } });
  // Anything of this project that compose did not remove (for example after the compose file was deleted).
  const left = projectResources(s.project);
  if (left.containers.length) docker(["rm", "--force", "--volumes", ...left.containers], { allowFailure: true });
  if (left.volumes.length) docker(["volume", "rm", "--force", ...left.volumes], { allowFailure: true });
  if (left.networks.length) docker(["network", "rm", ...left.networks], { allowFailure: true });
  if (existsSync(s.stateDir)) {
    if (!existsSync(s.paths.marker)) {
      throw new DevStackError(`${s.stateDir} has no ${STATE_MARKER} marker, so it is not removed.`);
    }
    rmSync(s.stateDir, { recursive: true, force: true });
  }
  if (s.socket.external) rmSync(dirname(s.socket.path), { recursive: true, force: true });
  const remaining = projectResources(s.project);
  const processes = findProcesses([directoryMarker(s.stateDir)]);
  if (remaining.containers.length || remaining.volumes.length || remaining.networks.length || processes.length || existsSync(s.stateDir)) {
    throw new DevStackError(`reset left something behind: ${JSON.stringify({ ...remaining, processes: processes.map((p) => p.pid), stateDir: existsSync(s.stateDir) })}`);
  }
  info(`reset: removed the ${s.project} containers, volumes and network, and ${relative(repoRoot, s.stateDir)}/. Nothing of it is left.`);
}

async function status() {
  const s = settings();
  const record = readJson(s.paths.supervisor);
  const running = Boolean(record?.pid && processMatches(record.pid, ["dev-stack.mjs"]));
  info(`compose project ${s.project}, state directory ${relative(repoRoot, s.stateDir)}/ ${existsSync(s.stateDir) ? "" : "(absent)"}`);
  info(running ? `supervisor running (process ${record.pid})` : "supervisor not running");
  for (const child of readJson(s.paths.children)?.children ?? []) {
    info(`  ${child.name.padEnd(9)} ${processMatches(child.pid, [child.marker]) ? `running (process ${child.pid})` : "not running"}`);
  }
  const resources = projectResources(s.project);
  if (resources.containers.length) {
    const ps = docker(["ps", "-a", "--filter", `label=com.docker.compose.project=${s.project}`, "--format", "  {{.Names}}\t{{.Status}}\t{{.Ports}}"], { allowFailure: true });
    say(ps.stdout.trimEnd());
  } else {
    info("no containers");
  }
  try {
    const response = await fetch(`http://${BIND_HOST}:${s.ports.web}/readyz`, { signal: AbortSignal.timeout(3_000) });
    const body = await response.json();
    info(`/readyz ${body.ok ? "ok" : `NOT READY: ${describeNotReady(body)}`}`);
  } catch {
    info("/readyz not reachable");
  }
}

/** Run by the CLI wrapper: the URL and Basic auth of the one OpenCode server the panes attach to. */
async function opencodeServer(args) {
  const portAt = args.indexOf("--port");
  const port = Number.parseInt(args[portAt + 1] ?? "", 10);
  if (!Number.isInteger(port)) throw new DevStackError("opencode-server needs --port <port>.");
  const recordPath = join(process.env.XDG_STATE_HOME ?? "", "opencode", "spaceapp-shared-server.json");
  const record = readJson(recordPath);
  // Reuse a healthy server without the /proc check of the shared helper, which macOS cannot answer.
  if (record?.port === port && record.password) {
    try {
      const response = await fetch(`http://${BIND_HOST}:${port}/api/info`, { signal: AbortSignal.timeout(2_000),
        headers: { authorization: `Basic ${Buffer.from(`opencode:${record.password}`).toString("base64")}` } });
      if (response.status === 200) {
        process.stdout.write(`OPENCODE_SERVER_URL=http://${BIND_HOST}:${port}\nOPENCODE_SERVER_USERNAME=opencode\nOPENCODE_SERVER_PASSWORD=${record.password}\n`);
        return;
      }
    } catch { /* start a new one */ }
  }
  const { ensureSharedServer } = await import(pathToFileURL(join(repoRoot, "deploy", "docker", "opencode-shared-server.mjs")).href);
  const server = await ensureSharedServer({ env: process.env, port });
  process.stdout.write(`OPENCODE_SERVER_URL=${server.url}\nOPENCODE_SERVER_USERNAME=${server.username}\nOPENCODE_SERVER_PASSWORD=${server.password}\n`);
}

function usage() {
  say(`Usage: npm run dev:stack [-- <command>]

  (no command)  start PostgreSQL and Temporal in Docker, run the migrations, then the API (watch mode), the
                Vite web server, the Temporal worker and the CLI host from source; Ctrl-C stops everything
  down          stop everything the dev stack started; data is kept
  reset         remove the containers, volumes and state directory the dev stack created
  status        show what is running

Ports (all on ${BIND_HOST}): ${Object.entries(PORT_ENV).map(([key, name]) => `${name} (${key})`).join(", ")}.
Other variables: SPACEAPP_DEV_STATE_DIR (default .dev-stack), SPACEAPP_DEV_PROJECT, SPACEAPP_DEV_QUIET=1,
SPACEAPP_DEV_OPTIONAL_MODULES (default all). See CONTRIBUTING.md, "Run the full app from source".`);
}

async function main() {
  const [command = "up", ...rest] = process.argv.slice(2);
  switch (command) {
    case "up": case "start": return up();
    case "down": case "stop": return down();
    case "reset": return reset();
    case "status": return status();
    case "opencode-server": return opencodeServer(rest);
    case "help": case "--help": case "-h": return usage();
    default:
      usage();
      throw new DevStackError(`Unknown command "${command}".`);
  }
}

main().catch((error) => {
  if (error instanceof DevStackError) {
    process.stderr.write(`${paint("1;31", "dev-stack: error:")} ${error.message}\n`);
    if (error.hint) process.stderr.write(`${paint("33", "dev-stack: hint:")} ${error.hint}\n`);
  } else {
    process.stderr.write(`${paint("1;31", "dev-stack: unexpected error:")} ${error?.stack ?? error}\n`);
  }
  process.exit(1);
});
