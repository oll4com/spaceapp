#!/usr/bin/env node
// End-to-end acceptance run of `npm run dev:stack` (issue #65), used by .github/workflows/dev-stack.yml on Linux, macOS
// and Windows (WSL2), and runnable on a contributor's machine: `node scripts/dev-stack-e2e.mjs`.
// It needs Docker and nothing else. It starts the stack without a TTY, checks every acceptance criterion that a
// program can check, and leaves nothing behind (it ends with `reset`). Do not run it against a stack you use: it
// claims the owner account of a fresh state directory and removes that state directory at the end.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { BIND_HOST, composeProjectName, findProcesses, readOpenCodePin, readPinnedImages, resolvePorts, stripAnsi } from "./dev-stack-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = resolve(repoRoot, process.env.SPACEAPP_DEV_STATE_DIR || ".dev-stack");
const project = composeProjectName(stateDir, process.env.SPACEAPP_DEV_PROJECT);
const ports = resolvePorts(process.env);
const web = `http://${BIND_HOST}:${ports.web}`;
const START_TIMEOUT_MS = Number.parseInt(process.env.SPACEAPP_DEV_E2E_START_TIMEOUT_MS ?? "900000", 10);
const owner = { email: "owner@dev-stack.example", password: `dev-stack-${randomUUID()}` };
const started = Date.now();
let step = 0;
let current = null;
const restores = [];

const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s`;
const log = (text) => process.stdout.write(`e2e ${elapsed()}  ${text}\n`);
function check(condition, message, detail) {
  if (!condition) {
    const error = new Error(message);
    error.detail = detail;
    throw error;
  }
  log(`  ok  ${message}`);
}
async function stage(title, work) {
  step += 1;
  log(`[${step}] ${title}`);
  await work();
}
async function until(what, probe, timeoutMs, intervalMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe().catch((error) => ({ error: error.message }));
    if (last && last.done) return last.value;
    await delay(intervalMs);
  }
  throw Object.assign(new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`), { detail: last });
}

// ---------------------------------------------------------------------------------------------------------------
// The dev stack process.

// On GitHub Actions the one-time setup token of the throwaway stack is masked in the public job log, like a secret.
let maskedToken = null;
function maskSetupTokenInCi() {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  try {
    const token = readFileSync(join(stateDir, "secrets", "setup-token"), "utf8").trim();
    if (token && token !== maskedToken) {
      process.stdout.write(`::add-mask::${token}\n`);
      maskedToken = token;
    }
  } catch {
    // Not written yet; the dev stack writes it long before it prints the banner.
  }
}

function startStack(label) {
  const child = spawn(process.execPath, [join(repoRoot, "scripts", "dev-stack.mjs")], {
    cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SPACEAPP_DEV_QUIET: "1", NO_COLOR: "1" }
  });
  const stack = { child, output: "", exited: null, label };
  const onData = (chunk) => {
    const text = chunk.toString();
    stack.output += text;
    maskSetupTokenInCi();
    for (const line of text.split(/\r?\n/)) if (line.trim()) process.stdout.write(`  | ${line}\n`);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  stack.exit = new Promise((resolveExit) => child.once("exit", (code, signal) => {
    stack.exited = { code, signal };
    resolveExit(stack.exited);
  }));
  current = stack;
  return stack;
}

async function waitForReady(stack) {
  await until("the dev stack's ready banner", async () => {
    if (stack.exited) throw Object.assign(new Error(`npm run dev:stack exited early (${JSON.stringify(stack.exited)})`), { fatal: true });
    return { done: stack.output.includes("dev-stack: ready.") };
  }, START_TIMEOUT_MS, 500).catch((error) => {
    throw error;
  });
}

function runStack(args) {
  const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "dev-stack.mjs"), ...args], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }
  });
  for (const line of `${result.stdout}${result.stderr}`.split(/\r?\n/)) if (line.trim()) process.stdout.write(`  | ${line}\n`);
  return result;
}

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

const projectFilter = ["--filter", `label=com.docker.compose.project=${project}`];
const ourProcessMarkers = [stateDir, join(repoRoot, "apps", "api", "src", "server.ts"), join(repoRoot, "node_modules", "vite", "bin", "vite.js"),
  join(repoRoot, "apps", "worker", "dist", "worker.js"), join(repoRoot, "packages", "cli-host", "dist", "main.js"), join(repoRoot, "scripts", "dev-stack.mjs")];
const leftovers = () => findProcesses(ourProcessMarkers).filter((entry) => !entry.command.includes("dev-stack-e2e.mjs"));

// ---------------------------------------------------------------------------------------------------------------
// HTTP with a cookie jar and the CSRF header the API requires on authenticated writes.

const jar = new Map();
let csrf = null;
async function http(method, path, { body, base = web, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth && jar.size) headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  if (auth && csrf && method !== "GET") headers[csrf.headerName] = csrf.csrfToken;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    const [pair] = cookie.split(";");
    const at = pair.indexOf("=");
    const value = pair.slice(at + 1);
    if (value === "" || /max-age=0|expires=thu, 01 jan 1970/i.test(cookie)) jar.delete(pair.slice(0, at));
    else jar.set(pair.slice(0, at), value);
  }
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json, text };
}

async function readyz() {
  const response = await http("GET", "/readyz", { auth: false });
  return response.json;
}

function externalAddresses() {
  return Object.values(networkInterfaces()).flat().filter((entry) => entry && entry.family === "IPv4" && !entry.internal).map((entry) => entry.address);
}

function tcpOpen(host, port) {
  return new Promise((resolveConnect) => {
    const socket = connect({ host, port, timeout: 2_000 });
    socket.once("connect", () => { socket.destroy(); resolveConnect(true); });
    socket.once("timeout", () => { socket.destroy(); resolveConnect(false); });
    socket.once("error", () => resolveConnect(false));
  });
}

function editFile(relativePath, marker) {
  const path = join(repoRoot, relativePath);
  const original = readFileSync(path, "utf8");
  restores.push(() => writeFileSync(path, original));
  writeFileSync(path, `${original}\n// ${marker}\n`);
  return () => {
    writeFileSync(path, original);
    restores.pop();
  };
}

/** Collects what an OpenCode pane draws, through the web server's WebSocket proxy, as the browser does. */
function attachTerminal(paneId, sessionId, token) {
  const query = new URLSearchParams({ sessionId, token, clientId: randomUUID(), initialCols: "120", initialRows: "36" });
  const socket = new WebSocket(`ws://${BIND_HOST}:${ports.web}/api/panes/${encodeURIComponent(paneId)}/cli/terminal?${query}`, {
    headers: { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "), origin: web }
  });
  const terminal = { output: "", messages: [], error: null, socket };
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "output") terminal.output += message.data;
    else terminal.messages.push(message);
  });
  socket.on("error", (error) => { terminal.error = error.message; });
  socket.on("unexpected-response", (_request, response) => { terminal.error = `HTTP ${response.statusCode}`; });
  return terminal;
}

/** Vite's HMR channel: the messages a browser tab would receive (with the token Vite gives its client). */
async function attachHmr() {
  const client = await (await fetch(`${web}/@vite/client`)).text();
  const token = /const wsToken = "([^"]+)"/.exec(client)?.[1];
  if (!token) throw new Error("Vite's client carries no HMR token");
  const socket = new WebSocket(`ws://${BIND_HOST}:${ports.web}/?token=${encodeURIComponent(token)}`, "vite-hmr", { headers: { origin: web } });
  const hmr = { messages: [], socket, error: null };
  socket.on("error", (error) => { hmr.error = error.message; });
  socket.on("message", (data) => {
    try { hmr.messages.push(JSON.parse(data.toString())); } catch { /* ignore */ }
  });
  return hmr;
}

// ---------------------------------------------------------------------------------------------------------------

async function main() {
  log(`dev-stack end-to-end run on ${process.platform}/${process.arch}, Node ${process.version}, state ${stateDir}, project ${project}`);
  if (existsSync(stateDir)) throw new Error(`${stateDir} exists; the end-to-end run needs a fresh state directory (npm run dev:stack -- reset).`);
  const composeText = readFileSync(join(repoRoot, "packages", "run-spaceapp", "templates", "compose.yml"), "utf8");
  const images = readPinnedImages(composeText);
  const pin = readOpenCodePin(readFileSync(join(repoRoot, "Dockerfile"), "utf8"));
  let stack;

  await stage("npm run dev:stack, without a TTY, on a fresh state directory", async () => {
    stack = startStack("first start");
    await waitForReady(stack);
    check(stack.output.includes(`ports             app ${ports.web}, api ${ports.api}`), "it printed the ports it uses");
    check(stack.output.includes("Setup token"), "it printed a one-time owner setup token");
    check(stack.output.includes(`http://${BIND_HOST}:${ports.web}`), "it printed the app URL");
    const order = ["starting PostgreSQL (pgvector) and Temporal", "PostgreSQL and Temporal are healthy", "applying database migrations",
      "starting the CLI host, worker, API (watch mode) and Vite", "dev-stack: ready."].map((text) => stack.output.indexOf(text));
    check(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])),
      "order: PostgreSQL and Temporal, then the migrations, then the processes, then ready", order);
  });

  await stage("/readyz reports ok: true with workflows enabled", async () => {
    const body = await readyz();
    check(body?.ok === true, "/readyz (through the Vite proxy) is ok", body);
    check(body.dependencies?.worker === "RUNNING", "the Temporal worker is polling (dependencies.worker RUNNING)", body.dependencies);
    check(body.dependencies?.database === "RUNNING", "PostgreSQL is reachable (dependencies.database RUNNING)");
    check(body.dependencies?.cliHost === "RUNNING", "the from-source CLI host answers (dependencies.cliHost RUNNING)");
  });

  await stage("images, isolation, ports and secrets", async () => {
    const ids = docker(["ps", ...projectFilter, "-q"]);
    const containerImages = ids.flatMap((id) => docker(["inspect", "--format", "{{.Config.Image}}", id]));
    check(containerImages.length === 2 && containerImages.includes(images.postgres.image) && containerImages.includes(images.temporal.image),
      "the containers run the digest-pinned images of packages/run-spaceapp/templates/compose.yml", containerImages);
    for (const image of [images.postgres, images.temporal]) {
      const digests = docker(["image", "inspect", "--format", "{{join .RepoDigests \"\\n\"}}", image.image]);
      check(digests.some((digest) => digest.endsWith(image.digest)), `${image.name} resolved to ${image.digest.slice(0, 19)}...`, digests);
    }
    check(project !== "spaceapp" && project.startsWith("spaceapp-dev"), `own compose project (${project})`);
    const published = docker(["ps", ...projectFilter, "--format", "{{.Ports}}"]).join(",").split(",").map((entry) => entry.trim()).filter((entry) => entry.includes("->"));
    check(published.length >= 2 && published.every((entry) => entry.startsWith(`${BIND_HOST}:`)), "Docker publishes PostgreSQL and Temporal on 127.0.0.1 only", published);
    check(![ports.api, ports.web, ports.postgres, ports.temporal, ports.opencode].some((port) => port === 4910 || port === 4911), "no port collides with an installed SpaceApp (4910/4911)");
    for (const [name, port] of Object.entries({ api: ports.api, web: ports.web, postgres: ports.postgres, temporal: ports.temporal })) {
      check(await tcpOpen(BIND_HOST, port), `${name} answers on ${BIND_HOST}:${port}`);
      for (const address of externalAddresses()) {
        check(!(await tcpOpen(address, port)), `${name} does not answer on the external address ${address}:${port}`);
      }
    }
    check((statSync(stateDir).mode & 0o777) === 0o700, "the state directory is 0700");
    const secretValues = {};
    for (const name of ["postgres-password", "session-secret", "setup-token", "database-url"]) {
      const path = join(stateDir, "secrets", name);
      check((statSync(path).mode & 0o777) === 0o600, `secrets/${name} is 0600`);
      secretValues[name] = readFileSync(path, "utf8").trim();
    }
    check(!stack.output.includes(secretValues["postgres-password"]) && !stack.output.includes(secretValues["session-secret"]) && !stack.output.includes(secretValues["database-url"]),
      "the database password, session secret and database URL never appear in the output");
    check(stack.output.split(secretValues["setup-token"]).length - 1 === 1, "the setup token is printed exactly once");
    const ignored = spawnSync("git", ["check-ignore", "-q", join(stateDir, "secrets", "setup-token")], { cwd: repoRoot });
    check(ignored.status === 0, "the state directory is git-ignored");
    const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot, encoding: "utf8" });
    check(!status.stdout.includes(".dev-stack"), "git status shows nothing of the state directory");
    for (const log of ["api", "worker", "web", "cli-host"]) {
      const text = readFileSync(join(stateDir, "logs", `${log}.log`), "utf8");
      check(!text.includes(secretValues["session-secret"]) && !text.includes(secretValues["postgres-password"]), `logs/${log}.log holds no secret`);
    }
  });

  let roomId;
  await stage("owner setup: setup token, create the owner, sign in (no dev login)", async () => {
    const status = await http("GET", "/api/setup/status", { auth: false });
    check(status.json?.setupRequired === true, "a fresh stack requires owner setup", status.json);
    const anonymous = await http("GET", "/api/auth/me", { auth: false });
    check(anonymous.json?.isAuthenticated !== true, "an anonymous request is not signed in (the dev-login shortcut is off)", anonymous.json);
    const wrong = await http("POST", "/api/setup/claim", { body: { token: "x".repeat(43), ...owner }, auth: false });
    check(wrong.status >= 400, `a wrong setup token is refused (HTTP ${wrong.status})`);
    const token = readFileSync(join(stateDir, "secrets", "setup-token"), "utf8").trim();
    const claim = await http("POST", "/api/setup/claim", { body: { token, ...owner } });
    check(claim.status === 200 && claim.json?.isAuthenticated === true && claim.json?.isSetupRequired === false, "the printed token creates the owner account", claim.json);
    csrf = (await http("GET", "/api/auth/csrf")).json;
    await http("POST", "/api/auth/logout", { body: {} });
    jar.clear();
    csrf = null;
    const signedOut = await http("GET", "/api/auth/me");
    check(signedOut.json?.isAuthenticated !== true, "signed out");
    const login = await http("POST", "/api/auth/login", { body: owner });
    check(login.status === 200, `the owner signs in with email and password (HTTP ${login.status})`, login.json);
    csrf = (await http("GET", "/api/auth/csrf")).json;
    const me = await http("GET", "/api/auth/me");
    check(me.json?.isAuthenticated === true && me.json?.user?.email === owner.email, "signed in as the owner", me.json?.user);
    const again = await http("GET", "/api/setup/status", { auth: false });
    check(again.json?.setupRequired === false, "setup is no longer required");
    const room = await http("POST", "/api/setup/starter-room");
    roomId = room.json?.room?.id;
    check(room.status === 200 && Boolean(roomId), `the Getting Started room opens (${room.json?.room?.name ?? "?"})`, room.json);
  });

  await stage("an OpenCode pane through the from-source CLI host shows OpenCode's terminal UI", async () => {
    const pane = await http("POST", "/api/panes", { body: { roomId, title: "OpenCode", mode: "TERMINAL", terminalRuntimeId: "cli:opencode" } });
    check(pane.status === 200 && pane.json?.id, "a TERMINAL pane with cli:opencode is created", pane.json);
    const session = await http("POST", `/api/panes/${encodeURIComponent(pane.json.id)}/cli/session`, { body: { runtimeId: "cli:opencode" } });
    check(session.status === 200 && session.json?.session && session.json?.websocket?.token, "its CLI session starts", session.json?.session);
    const terminal = attachTerminal(pane.json.id, session.json.session.sessionId, session.json.websocket.token);
    const screen = await until("OpenCode's terminal UI", async () => {
      if (terminal.error) throw new Error(`terminal WebSocket: ${terminal.error}`);
      const text = stripAnsi(terminal.output);
      return { done: text.includes("Ask anything") && text.includes("ctrl+p"), value: text };
    }, 120_000);
    check(true, "OpenCode drew its prompt (\"Ask anything\", \"ctrl+p commands\") over the web server's WebSocket proxy");
    check(screen.includes(pin.version), `the pane runs OpenCode ${pin.version}, the version the Dockerfile pins`);
    const state = await http("GET", `/api/panes/${encodeURIComponent(pane.json.id)}/cli/session`);
    check(state.json?.session?.status === "RUNNING", "the API reports the CLI session RUNNING", state.json?.session?.status);
    const opencode = findProcesses([join(stateDir, "opencode")]);
    check(opencode.length > 0, `OpenCode runs from ${join(".dev-stack", "opencode")} (${opencode.length} processes), not from a global install`);
    check(existsSync(join(stateDir, "cli", "providers", "opencode", "state")), "OpenCode's provider state lives in the state directory");
    check((await tcpOpen(BIND_HOST, ports.opencode)) && !(await Promise.all(externalAddresses().map((address) => tcpOpen(address, ports.opencode)))).some(Boolean),
      `the shared OpenCode server listens on ${BIND_HOST}:${ports.opencode} only`);
    terminal.socket.close();
  });

  await stage("hot reload: apps/api/src restarts the API", async () => {
    const before = (await readyz())?.apiStartedAt;
    const restore = editFile("apps/api/src/server.ts", `dev-stack e2e ${Date.now()}`);
    const after = await until("the API to restart", async () => {
      const body = await readyz().catch(() => null);
      return { done: Boolean(body?.ok && body.apiStartedAt && body.apiStartedAt !== before), value: body?.apiStartedAt };
    }, 90_000);
    restore();
    check(after !== before, `the API restarted (apiStartedAt ${before} -> ${after}) and /readyz is ok again`);
    await until("the API to settle after the restore", async () => ({ done: (await readyz().catch(() => null))?.ok === true }), 90_000);
  });

  await stage("hot reload: apps/web/src is pushed to the browser by Vite HMR", async () => {
    const hmr = await attachHmr();
    await until("Vite's HMR channel", async () => {
      if (hmr.error) throw new Error(`HMR WebSocket: ${hmr.error}`);
      return { done: hmr.messages.some((message) => message.type === "connected") };
    }, 30_000, 200);
    check(true, "Vite's HMR WebSocket accepts a browser client");
    // Vite only pushes updates for modules a page has loaded; request the entry like a browser tab would.
    const page = await fetch(`${web}/`);
    const entry = /<script type="module" src="([^"]+main[^"]*)"/.exec(await page.text())?.[1] ?? "/src/main.tsx";
    await fetch(`${web}${entry}`);
    const target = "apps/web/src/main.tsx";
    const restore = editFile(target, `dev-stack e2e ${Date.now()}`);
    const message = await until("an HMR update", async () => {
      const found = hmr.messages.find((item) => item.type === "update" || item.type === "full-reload");
      return { done: Boolean(found), value: found };
    }, 30_000, 200);
    restore();
    check(true, `Vite sent "${message.type}"${message.updates ? ` for ${message.updates.map((update) => update.path).join(", ")}` : ""} after ${target} changed`);
    hmr.socket.close();
  });

  await stage("hot reload: a change in packages/* is rebuilt and picked up", async () => {
    const before = (await readyz())?.apiStartedAt;
    const offset = stack.output.length;
    const marker = `dev-stack e2e ${Date.now()}`;
    const restore = editFile("packages/opencode-control/src/index.ts", marker);
    await until("the rebuild of @space/opencode-control", async () => ({ done: stack.output.slice(offset).includes("rebuilt @space/opencode-control") }), 90_000, 300);
    check(true, "the dev stack rebuilt @space/opencode-control");
    check(readFileSync(join(repoRoot, "packages", "opencode-control", "dist", "index.js"), "utf8").length > 0, "its dist was rewritten");
    await until("the worker restart", async () => ({ done: stack.output.slice(offset).includes("worker restarted (process") }), 60_000, 300);
    check(true, "the worker, which imports it, was restarted");
    const after = await until("the API to restart on the new build", async () => {
      const body = await readyz().catch(() => null);
      return { done: Boolean(body?.ok && body.apiStartedAt !== before && body.dependencies?.worker === "RUNNING"), value: body?.apiStartedAt };
    }, 120_000);
    check(after !== before, "the API picked up the new build (restarted) and /readyz is ok with the worker RUNNING");
    const offsetRestore = stack.output.length;
    restore();
    await until("the rebuild after restoring the file", async () => ({ done: stack.output.slice(offsetRestore).includes("worker restarted (process") }), 90_000, 300);
    await until("readiness after restoring the file", async () => {
      const body = await readyz().catch(() => null);
      return { done: body?.ok === true && body.dependencies?.worker === "RUNNING" };
    }, 120_000);
  });

  await stage("stopping one process (the worker) is a clear failure, not a silent hang", async () => {
    const worker = await until("a running worker process", async () => {
      const children = JSON.parse(readFileSync(join(stateDir, "run", "children.json"), "utf8")).children;
      const entry = children.find((child) => child.name === "worker");
      const alive = Boolean(entry?.pid) && findProcesses([entry.marker]).some((found) => found.pid === entry.pid);
      const body = await readyz().catch(() => null);
      return { done: alive && body?.dependencies?.worker === "RUNNING", value: entry };
    }, 60_000, 500);
    check(true, `the worker runs as process ${worker.pid}`);
    const offset = stack.output.length;
    process.kill(worker.pid, "SIGKILL");
    await until("the failure message", async () => ({ done: stack.output.slice(offset).includes("dev-stack: FAILED: worker was killed by SIGKILL.") }), 30_000, 200);
    check(true, "the dev stack printed \"FAILED: worker was killed by SIGKILL.\" with the worker's last log lines");
    const exit = await Promise.race([stack.exit, delay(120_000).then(() => null)]);
    check(exit?.code === 1, "npm run dev:stack then stopped everything and exited with code 1", exit);
    check(leftovers().length === 0, "no process of the stack is left", leftovers());
    check(docker(["ps", ...projectFilter, "-q"]).length === 0, "its containers are stopped");
  });

  await stage("start again: data persists and the setup token is not printed again", async () => {
    stack = startStack("second start");
    await waitForReady(stack);
    check(!stack.output.includes("Setup token") && stack.output.includes("already set up"), "the banner says the owner exists instead of printing the token");
    jar.clear();
    csrf = null;
    const login = await http("POST", "/api/auth/login", { body: owner });
    check(login.status === 200, "the owner created before signs in again");
  });

  await stage("npm run dev:stack -- down stops everything and keeps the data", async () => {
    const result = runStack(["down"]);
    check(result.status === 0, "down exited 0");
    const exit = await Promise.race([stack.exit, delay(60_000).then(() => null)]);
    check(exit?.code === 0, "the running dev stack stopped cleanly (exit 0)", exit);
    check(leftovers().length === 0, "no process of the stack is left (API, web, worker, CLI host, OpenCode)", leftovers());
    check(docker(["ps", "-a", ...projectFilter, "-q"]).length === 0, "no container of the stack is left");
    check(docker(["volume", "ls", ...projectFilter, "-q"]).length === 1, "the database volume is kept");
  });

  await stage("npm run dev:stack -- reset removes only what it created", async () => {
    const before = { containers: docker(["ps", "-a", "-q"]).length, volumes: docker(["volume", "ls", "-q"]).length };
    const result = runStack(["reset"]);
    check(result.status === 0, "reset exited 0");
    check(docker(["ps", "-a", ...projectFilter, "-q"]).length === 0, "docker ps -a shows no container of the stack");
    check(docker(["volume", "ls", ...projectFilter, "-q"]).length === 0, "docker volume ls shows no volume of the stack");
    check(docker(["network", "ls", ...projectFilter, "-q"]).length === 0, "docker network ls shows no network of the stack");
    check(!existsSync(stateDir), "the state directory is gone");
    check(leftovers().length === 0, "no process is left");
    const after = { containers: docker(["ps", "-a", "-q"]).length, volumes: docker(["volume", "ls", "-q"]).length };
    check(after.containers === before.containers && after.volumes === before.volumes - 1, "nothing else on the Docker host was touched (only its own volume went away)", { before, after });
  });

  log(`PASSED: ${step} stages in ${elapsed().trim()}`);
}

main().catch(async (error) => {
  log(`FAILED: ${error.message}`);
  if (error.detail !== undefined) log(`  detail: ${JSON.stringify(error.detail, null, 2)?.slice(0, 4000)}`);
  for (const restore of restores.reverse()) restore();
  if (existsSync(join(stateDir, "logs"))) {
    for (const name of ["api", "worker", "web", "cli-host"]) {
      const path = join(stateDir, "logs", `${name}.log`);
      if (!existsSync(path)) continue;
      process.stdout.write(`----- last lines of .dev-stack/logs/${name}.log -----\n`);
      process.stdout.write(`${readFileSync(path, "utf8").split("\n").slice(-60).join("\n")}\n`);
    }
  }
  if (current && !current.exited) current.child.kill("SIGTERM");
  await delay(5_000);
  if (process.env.SPACEAPP_DEV_E2E_KEEP !== "1") runStack(["reset"]);
  process.exit(1);
});
