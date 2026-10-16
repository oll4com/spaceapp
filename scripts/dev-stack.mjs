#!/usr/bin/env node
/**
 * dev-stack.mjs — Run the whole SpaceApp from source with one command.
 *
 *   npm run dev:stack              start everything, print the URL and setup token
 *   npm run dev:stack -- down      stop every process and container this started
 *   npm run dev:stack -- reset     down, then remove only the containers, volumes
 *                                  and state directory this command created
 *   npm run dev:stack -- status    print what is running
 *
 * What it starts, in order:
 *   1. PostgreSQL (pgvector) and Temporal in Docker, images pinned by digest and
 *      read from packages/run-spaceapp/templates/compose.yml — never copied.
 *   2. The migrations (packages/db).
 *   3. The API in watch mode, the Vite web dev server, the Temporal worker and
 *      the CLI host (packages/cli-host) from source.
 *
 * Isolation from an installed SpaceApp:
 *   - its own `docker compose` project name
 *   - its own state directory (.dev-stack/, git-ignored)
 *   - ports that do not collide with an install on 4910/4911, overridable
 *   - every port binds 127.0.0.1 only
 *
 * Secrets (database password, session secret, setup token) are generated per
 * state directory with mode 0600. They are never printed apart from the setup
 * token, and never committed. Owner setup goes through the normal setup-token
 * flow; the dev-login shortcut is not enabled.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, statSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_TEMPLATE = join(repoRoot, "packages/run-spaceapp/templates/compose.yml");
export const STATE_DIR = resolve(repoRoot, process.env.SPACE_DEV_STACK_DIR ?? ".dev-stack");
export const COMPOSE_PROJECT = process.env.SPACE_DEV_STACK_PROJECT ?? "spaceapp-dev-stack";
const COMPOSE_FILE = join(STATE_DIR, "compose.yml");
const SECRETS_DIR = join(STATE_DIR, "secrets");
const PID_FILE = join(STATE_DIR, "dev-stack.pids.json");
const LOG_DIR = join(STATE_DIR, "logs");

// ---------------------------------------------------------------------------
// Ports. An installed SpaceApp owns 4910 (API) and 4911 (web). The dev stack
// defaults beside them and binds 127.0.0.1 only, including Vite, PostgreSQL and
// Temporal. Every port is overridable through an environment variable.
// ---------------------------------------------------------------------------
export const PORTS = {
  api: Number.parseInt(process.env.SPACE_DEV_STACK_API_PORT ?? "5910", 10),
  web: Number.parseInt(process.env.SPACE_DEV_STACK_WEB_PORT ?? "5911", 10),
  postgres: Number.parseInt(process.env.SPACE_DEV_STACK_POSTGRES_PORT ?? "55432", 10),
  temporal: Number.parseInt(process.env.SPACE_DEV_STACK_TEMPORAL_PORT ?? "57233", 10),
  temporalUi: Number.parseInt(process.env.SPACE_DEV_STACK_TEMPORAL_UI_PORT ?? "58080", 10)
};

for (const [name, port] of Object.entries(PORTS)) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    fail(`Invalid ${name} port: ${port}. Set SPACE_DEV_STACK_${name.toUpperCase()}_PORT to 1024-65535.`);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function fail(message) {
  // Throw rather than exit so the pure helpers stay testable and an import from
  // a test runner cannot kill the process. The CLI entry below turns this into
  // a non-zero exit.
  throw new Error(`dev-stack: ${message}`);
}

function say(message) {
  process.stdout.write(`${message}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    ...options
  });
  if (result.error) fail(`Failed to run ${command}: ${result.error.message}`);
  return result;
}

function requireDocker() {
  const probe = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    fail(
      "Docker with the compose plugin is required (Docker Desktop, Colima or the docker engine).\n" +
      "  Install Docker, start it, then re-run `npm run dev:stack`.\n" +
      "  macOS: Docker Desktop or Colima.  Windows 11: Docker Desktop with the WSL2 backend."
    );
  }
}

// ---------------------------------------------------------------------------
// Pinned images. The acceptance contract says the Docker services use the same
// images, pinned by digest, as packages/run-spaceapp/templates/compose.yml, and
// that the digests are read from that file or one shared place — never copied by
// hand. This is that reader.
// ---------------------------------------------------------------------------
export function readPinnedImages(templateText = readFileSync(COMPOSE_TEMPLATE, "utf8")) {
  // Match  `image: <repo>:<tag>@sha256:<64 hex>`  anywhere in the file.
  // `\r?$` matters: the repo is checked out with CRLF line endings on Windows,
  // and a bare `$` in multiline mode stops before `\n`, leaving the `\r` to
  // break the match.
  const imageLine = /^[ \t]*image:[ \t]*(\S+?)[ \t]*\r?$/gm;
  const wanted = { postgres: null, temporal: null };
  let match;
  while ((match = imageLine.exec(templateText)) !== null) {
    const ref = match[1].replace(/\r/g, "");
    if (!/@sha256:[0-9a-f]{64}$/.test(ref)) continue;
    if (ref.startsWith("pgvector/pgvector")) wanted.postgres = ref;
    else if (ref.startsWith("temporalio/")) wanted.temporal = ref;
  }
  for (const [name, ref] of Object.entries(wanted)) {
    if (!ref) fail(`Could not find a digest-pinned ${name} image in ${COMPOSE_TEMPLATE}.`);
  }
  return wanted;
}

// ---------------------------------------------------------------------------
// Secrets. Generated per state directory, never printed except the owner setup
// token, never committed (.dev-stack/ is git-ignored).
//
// Two mode classes, matching packages/run-spaceapp/src/index.mjs:23:
//
//   CONTAINER_SECRET_MODE (0644) for the four files the compose template binds
//     into containers. They are read by the non-root user inside temporalio/
//     auto-setup (`cat /run/secrets/postgres-password`), so they have to be
//     world-readable on the host. packages/run-spaceapp/tests/cli.test.mjs:765
//     names the contract outright — "container secrets are world-readable so
//     non-root container users can mount them" — and its sibling test repairs a
//     0600 file back to 0644. 0600 here provably crash-loops temporal with
//     `cat: can't open '/run/secrets/postgres-password': Permission denied`.
//
//   OWNER_ONLY_MODE (0600) for owner-only.env, the developer-facing copy of the
//     same values. It is never bound into a container, so it can stay 0600.
// ---------------------------------------------------------------------------
const CONTAINER_SECRET_MODE = 0o644;
const OWNER_ONLY_MODE = 0o600;

// Idempotent repair, as ensureContainerSecretReadable does upstream: an existing
// container secret is chmod'ed back to CONTAINER_SECRET_MODE so a stray 0600 can
// never wedge the stack. No-op on Windows, which has no POSIX permission bits.
function ensureContainerSecretReadable(path) {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, CONTAINER_SECRET_MODE);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function generateSecrets(dir = SECRETS_DIR) {
  mkdirSync(dir, { recursive: true });
  const write = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, value, { mode: CONTAINER_SECRET_MODE });
    chmodSync(path, CONTAINER_SECRET_MODE);
    ensureContainerSecretReadable(path);
    return path;
  };
  // PostgreSQL password: URL-safe, no shell/URL metacharacters.
  const postgresPassword = randomBytes(24).toString("base64url");
  // Session secret: long and random.
  const sessionSecret = randomBytes(48).toString("base64url");
  // Owner setup token: 32-500 chars, no line breaks (matches
  // scripts/rotate-owner-setup-token.mjs's validator).
  const setupToken = randomBytes(32).toString("hex");

  write("postgres-password", postgresPassword);
  write("session-secret", sessionSecret);
  write("setup-token", setupToken);
  write("database-url", `postgresql://spaceapp:${postgresPassword}@127.0.0.1:${PORTS.postgres}/spaceapp`);

  // The developer-facing copy: same values, never mounted into a container, so
  // it can and does stay owner-only. This is where the 0600 requirement applies.
  const ownerOnlyPath = join(dir, "owner-only.env");
  writeFileSync(
    ownerOnlyPath,
    [
      "# Owner-only copy of the dev-stack secrets. Not mounted into any container.",
      `DATABASE_URL=postgresql://spaceapp:${postgresPassword}@127.0.0.1:${PORTS.postgres}/spaceapp`,
      `SPACE_SESSION_SECRET=${sessionSecret}`,
      `SPACE_OWNER_SETUP_TOKEN=${setupToken}`,
      ""
    ].join("\n"),
    { mode: OWNER_ONLY_MODE }
  );
  chmodSync(ownerOnlyPath, OWNER_ONLY_MODE);

  // Belt and braces on POSIX: assert the modes landed.
  // Windows has no POSIX permission bits — Node reports 0666 for every
  // user-writable file and chmodSync only toggles the read-only flag, so an
  // assertion there would be meaningless. There the secret is protected by the
  // per-user profile directory; chmodSync is still called so the file is at
  // least marked read-only where that helps. This is the same trade-off npm
  // makes for ~/.npmrc credentials, and the same guard packages/run-spaceapp/
  // tests/cli.test.mjs:774 applies.
  if (process.platform !== "win32") {
    for (const name of ["postgres-password", "session-secret", "setup-token", "database-url"]) {
      const mode = statSync(join(dir, name)).mode & 0o777;
      if (mode !== CONTAINER_SECRET_MODE) {
        fail(`Container secret ${name} has mode ${mode.toString(8)}; expected 0644 so the container's non-root user can read it.`);
      }
    }
    const ownerMode = statSync(ownerOnlyPath).mode & 0o777;
    if (ownerMode !== OWNER_ONLY_MODE) {
      fail(`owner-only.env has mode ${ownerMode.toString(8)}; expected 0600.`);
    }
  }
  return {
    postgresPassword,
    sessionSecret,
    setupToken,
    databaseUrl: `postgresql://spaceapp:${postgresPassword}@127.0.0.1:${PORTS.postgres}/spaceapp`,
    platform: process.platform
  };
}

export function readSecrets(dir = SECRETS_DIR) {
  const read = (name) => readFileSync(join(dir, name), "utf8");
  return {
    postgresPassword: read("postgres-password"),
    sessionSecret: read("session-secret"),
    setupToken: read("setup-token"),
    databaseUrl: read("database-url")
  };
}

// ---------------------------------------------------------------------------
// Generated compose file. Only the Docker services (postgres + temporal). The
// application processes run from source on the host, which is the whole point.
// ---------------------------------------------------------------------------
export function renderCompose(images, secrets, ports = PORTS) {
  return `# Generated by scripts/dev-stack.mjs — do not edit, do not commit.
# Images are pinned by digest and copied from packages/run-spaceapp/templates/compose.yml
# by readPinnedImages(); regenerate with \`npm run dev:stack\`.
services:
  postgres:
    image: ${images.postgres}
    restart: unless-stopped
    mem_limit: "${process.env.SPACEAPP_POSTGRES_MEMORY_LIMIT ?? "512m"}"
    cpus: "${process.env.SPACEAPP_POSTGRES_CPU_LIMIT ?? "1.0"}"
    environment:
      POSTGRES_DB: spaceapp
      POSTGRES_USER: spaceapp
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password
    ports:
      - "127.0.0.1:${ports.postgres}:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    secrets:
      - postgres-password
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp"]
      interval: 10s
      timeout: 5s
      retries: 10
    networks: [devstack]

  temporal:
    image: ${images.temporal}
    restart: unless-stopped
    mem_limit: "${process.env.SPACEAPP_TEMPORAL_MEMORY_LIMIT ?? "768m"}"
    cpus: "${process.env.SPACEAPP_TEMPORAL_CPU_LIMIT ?? "1.0"}"
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DB: postgres12
      DB_PORT: 5432
      POSTGRES_USER: spaceapp
      POSTGRES_SEEDS: postgres
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml
    entrypoint: ["/bin/sh", "-ec"]
    command:
      - export POSTGRES_PWD="$$(cat /run/secrets/postgres-password)"; exec /etc/temporal/entrypoint.sh autosetup
    ports:
      - "127.0.0.1:${ports.temporal}:7233"
      - "127.0.0.1:${ports.temporalUi}:8080"
    secrets:
      - postgres-password
    healthcheck:
      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"]
      interval: 15s
      timeout: 10s
      retries: 12
    networks: [devstack]

networks:
  devstack:
    internal: false

secrets:
  postgres-password:
    file: ${join(SECRETS_DIR, "postgres-password").replaceAll("\\", "/")}

volumes:
  postgres-data:
`;
}

// ---------------------------------------------------------------------------
// OpenCode CLI. The acceptance contract says the OpenCode pane must be served
// by the version pinned in the Dockerfile, installed into the state directory —
// not globally. The version is read from the Dockerfile so the two cannot drift.
// ---------------------------------------------------------------------------
const DOCKERFILE = join(repoRoot, "Dockerfile");

export function readPinnedOpenCode(dockerfileText = readFileSync(DOCKERFILE, "utf8")) {
  // `RUN npm install --global ... opencode-ai@1.18.4 ...`
  const match = dockerfileText.match(/opencode-ai@([0-9]+\.[0-9]+\.[0-9]+(?:-[^\s\\]+)?)/);
  if (!match) fail(`Could not find a pinned opencode-ai version in ${DOCKERFILE}.`);
  return match[1];
}

function ensureOpenCode(stateDir = STATE_DIR) {
  const version = readPinnedOpenCode();
  const binDir = join(stateDir, "bin");
  mkdirSync(binDir, { recursive: true });

  // Already installed at the pinned version? Then skip the network entirely.
  const stamp = join(stateDir, "opencode.version");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version) {
    say(`dev-stack: OpenCode ${version} already installed in ${binDir}`);
    return { version, binDir };
  }

  say(`dev-stack: installing opencode-ai@${version} into ${binDir} (not global)...`);
  // `npm install --prefix` writes into the state directory only. Nothing is
  // installed into the user's global npm prefix, so an installed SpaceApp's
  // toolchain is untouched.
  const install = run("npm", [
    "install", "--prefix", stateDir, "--no-audit", "--no-fund", "--silent",
    `opencode-ai@${version}`
  ], { capture: true });
  if (install.status !== 0) {
    process.stderr.write(install.stdout ?? "");
    process.stderr.write(install.stderr ?? "");
    fail(`Installing opencode-ai@${version} failed.`);
  }
  writeFileSync(stamp, version, "utf8");
  say(`dev-stack: OpenCode ${version} installed at ${join(binDir, "opencode")}`);
  return { version, binDir };
}

// ---------------------------------------------------------------------------
// Compose plumbing. Always namespaced to COMPOSE_PROJECT and always pointed at
// COMPOSE_FILE so nothing here can touch an installed SpaceApp's stack.
// ---------------------------------------------------------------------------
const composeArgs = (verb, extra = []) => [
  "compose", "-p", COMPOSE_PROJECT, "-f", COMPOSE_FILE, verb, ...extra
];

function compose(verb, extra = [], options = {}) {
  return run("docker", composeArgs(verb, extra), options);
}

// Synchronous sleep — cmdUp is synchronous by design so `npm run dev:stack`
// prints everything in order, and Atomics.wait is the one portable way to block
// without pulling in a dependency.
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function containerState(name) {
  const r = run("docker", ["inspect", "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", name], { capture: true });
  return (r.stdout ?? "").trim();
}

export function waitForInfrastructure(names = { postgres: `${COMPOSE_PROJECT}-postgres-1`, temporal: `${COMPOSE_PROJECT}-temporal-1` }, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let postgres = "";
  let temporal = "";
  while (Date.now() < deadline) {
    postgres = containerState(names.postgres);
    temporal = containerState(names.temporal);
    // PostgreSQL must report healthy. Temporal only has to be running: its
    // image's healthcheck shells out to the `temporal` CLI, which is not a
    // contract this script should depend on.
    if (postgres.startsWith("healthy") && temporal.startsWith("running")) {
      say(`dev-stack: postgres ${postgres}; temporal ${temporal}`);
      return { postgres, temporal };
    }
    sleepMs(2_000);
  }
  const ps = run("docker", composeArgs("ps", ["-a"]), { capture: true });
  process.stderr.write(ps.stdout ?? "");
  process.stderr.write(ps.stderr ?? "");
  // Without the container logs a crash-looping service is a mystery: the state
  // says "restarting" but not why. Print every service's own output so the
  // reason is in the failure instead of one `docker logs` away.
  for (const name of Object.values(names)) {
    const logs = run("docker", ["logs", "--tail", "80", name], { capture: true });
    process.stderr.write(`\n--- docker logs ${name} ---\n`);
    process.stderr.write(logs.stdout ?? "");
    process.stderr.write(logs.stderr ?? "");
  }
  fail(`Infrastructure did not become ready in ${Math.round(timeoutMs / 1000)}s (postgres=${postgres || "absent"}, temporal=${temporal || "absent"}).`);
}

// ---------------------------------------------------------------------------
// Process supervision. Each child writes to its own log; if one dies the whole
// stack prints a clear failure and shuts down — never a silent hang.
// ---------------------------------------------------------------------------
const children = new Map();
let stopping = false;
let exitCode = 0;

function spawnService(name, command, args, env, options = {}) {
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `${name}.log`);
  const logFd = openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", logFd, logFd],
    detached: process.platform !== "win32",
    ...options
  });
  children.set(name, { child, logPath, command, args });
  child.once("error", (error) => {
    process.stderr.write(`\ndev-stack: ${name} failed to start: ${error.message}\n`);
    exitCode = 1;
    stopAll();
  });
  child.once("exit", (code, signal) => {
    children.delete(name);
    if (!stopping) {
      process.stderr.write(
        `\ndev-stack: ${name} exited unexpectedly (${code ?? signal}). See ${logPath}\n` +
        `dev-stack: shutting the stack down so nothing is left half-running.\n`
      );
      exitCode = code || 1;
      stopAll();
    }
    if (children.size === 0 && stopping) {
      cleanupFiles();
      process.exit(exitCode);
    }
  });
  return child;
}

function stopAll(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const [name, { child }] of children) {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* already gone */ }
    void name;
  }
  // Last child's exit handler calls process.exit; add a hard deadline anyway.
  setTimeout(() => {
    for (const { child } of children.values()) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    cleanupFiles();
    process.exit(exitCode);
  }, 8000).unref();
}

function cleanupFiles() {
  try { rmSync(PID_FILE, { force: true }); } catch { /* nothing to clean */ }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    process.stderr.write(`\ndev-stack: received ${signal}, stopping.\n`);
    stopAll();
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function cmdUp() {
  requireDocker();
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(SECRETS_DIR, { recursive: true });

  const images = readPinnedImages();
  const secrets = existsSync(join(SECRETS_DIR, "setup-token"))
    ? readSecrets()
    : generateSecrets();

  // A pre-existing state directory may carry a stray 0600 from an older run;
  // repair it whether or not generateSecrets just wrote these. Without this the
  // temporal container cannot `cat` its secret and crash-loops.
  for (const name of ["postgres-password", "session-secret", "setup-token", "database-url"]) {
    ensureContainerSecretReadable(join(SECRETS_DIR, name));
  }

  writeFileSync(COMPOSE_FILE, renderCompose(images, secrets), "utf8");

  say(`dev-stack: state directory  ${STATE_DIR}`);
  say(`dev-stack: compose project  ${COMPOSE_PROJECT}`);
  say(`dev-stack: postgres         ${images.postgres}`);
  say(`dev-stack: temporal         ${images.temporal}`);
  say(`dev-stack: ports            api=${PORTS.api} web=${PORTS.web} postgres=${PORTS.postgres} temporal=${PORTS.temporal} (all 127.0.0.1 only)`);
  say("");
  say("dev-stack: starting PostgreSQL and Temporal in Docker...");
  const up = compose("up", ["-d"]);
  if (up.status !== 0) {
    process.stderr.write(up.stdout ?? "");
    process.stderr.write(up.stderr ?? "");
    fail("docker compose up failed.");
  }
  // Deliberately not `--wait`: the Temporal auto-setup image's healthcheck
  // depends on the `temporal` CLI being on PATH inside the container, which is
  // not something this script should assume. Waiting on observable facts
  // (PostgreSQL healthy, then Temporal answering on its gRPC port) is
  // deterministic and gives a real message when something is stuck.
  waitForInfrastructure();

  say("dev-stack: running migrations...");
  const migrate = run("node", ["packages/db/dist/migrate.js"], {
    env: { ...process.env, SPACE_DATABASE_URL: secrets.databaseUrl },
    capture: true
  });
  if (migrate.status !== 0) {
    process.stderr.write(migrate.stdout ?? "");
    process.stderr.write(migrate.stderr ?? "");
    fail("Migrations failed. Run `npm run build -w @space/db` first if packages/db is not built.");
  }

  // OpenCode is installed into the state directory, never globally, at the
  // version pinned in the Dockerfile. No AI provider account is required to
  // open the pane — the pane only needs the CLI binary to exist.
  const opencode = ensureOpenCode();
  say(`dev-stack: OpenCode        ${opencode.version} (state-dir only, not global)`);

  // Every path the CLI host and panes touch lives under the state directory,
  // so an installed SpaceApp's sockets, provider state and workspaces are
  // never reused.
  for (const sub of ["workspaces", "providers/codex", "memory", "memory-graph", "artifacts", "logs"]) {
    mkdirSync(join(STATE_DIR, sub), { recursive: true });
  }

  const commonEnv = {
    // Real owner setup, not the dev-login shortcut.
    SPACE_DEV_LOGIN: "false",
    SPACE_SESSION_SECRET: secrets.sessionSecret,
    SPACE_SETUP_TOKEN: secrets.setupToken,
    SPACE_DATABASE_URL: secrets.databaseUrl,
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(PORTS.api),
    SPACE_API_ORIGIN: `http://127.0.0.1:${PORTS.api}`,
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(PORTS.web),
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${PORTS.temporal}`,
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_HOST_SOCKET: join(STATE_DIR, "cli-host.sock"),
    // The state-dir bin dir is prepended so panes resolve `opencode` to the
    // pinned build we just installed, not to anything on the user's PATH.
    SPACE_CLI_COMMAND_PATH: opencode.binDir,
    PATH: `${opencode.binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    SPACE_CLI_WORKSPACE_ROOT: join(STATE_DIR, "workspaces"),
    SPACE_CODEX_HOME: join(STATE_DIR, "providers/codex"),
    SPACE_MEMORY_ROOT: join(STATE_DIR, "memory"),
    SPACE_MEMORY_GRAPH_ROOT: join(STATE_DIR, "memory-graph"),
    SPACE_ARTIFACT_ROOT: join(STATE_DIR, "artifacts")
  };

  say("dev-stack: starting the API (watch), web (Vite), worker and CLI host from source...");
  spawnService("api", "npx", ["tsx", "watch", "apps/api/src/server.ts"], commonEnv);
  spawnService("web", "npx", ["vite", "--host", "127.0.0.1", "--port", String(PORTS.web)],
    { ...commonEnv, SPACE_WEB_HOST: "127.0.0.1", SPACE_WEB_PORT: String(PORTS.web) },
    { cwd: join(repoRoot, "apps/web") });
  spawnService("worker", "node", ["apps/worker/dist/worker.js"], commonEnv);
  spawnService("cli-host", "node", ["packages/cli-host/dist/main.js"], commonEnv);

  writeFileSync(PID_FILE, JSON.stringify([...children.entries()].map(([name, { child }]) => ({ name, pid: child.pid })), null, 2), "utf8");

  const url = `http://127.0.0.1:${PORTS.web}`;
  say("");
  say("════════════════════════════════════════════════════════════");
  say(`  SpaceApp (from source)  →  ${url}`);
  say("");
  say(`  One-time owner setup token:  ${secrets.setupToken}`);
  say("");
  say("  Open the URL, choose owner setup, paste the token, create the owner,");
  say("  sign in, open the Getting Started room and start an OpenCode pane.");
  say("");
  say(`  API    http://127.0.0.1:${PORTS.api}   (/readyz reports ok:true)`);
  say(`  Logs   ${LOG_DIR}`);
  say("");
  say("  Stop:   npm run dev:stack -- down");
  say("  Clean:  npm run dev:stack -- reset");
  say("════════════════════════════════════════════════════════════");
  say("");
}

function cmdDown() {
  requireDocker();
  if (existsSync(COMPOSE_FILE)) compose("down", ["--remove-orphans"]);
  // Stop anything still alive that we spawned (up was interrupted, etc).
  if (existsSync(PID_FILE)) {
    try {
      for (const { name, pid } of JSON.parse(readFileSync(PID_FILE, "utf8"))) {
        try { process.kill(pid, "SIGTERM"); say(`dev-stack: stopped ${name} (pid ${pid})`); }
        catch { /* already gone */ }
      }
    } catch { /* unreadable pid file */ }
    rmSync(PID_FILE, { force: true });
  }
  say("dev-stack: down.");
}

function cmdReset() {
  requireDocker();
  if (existsSync(COMPOSE_FILE)) {
    compose("down", ["-v", "--remove-orphans"]);
  }
  if (existsSync(PID_FILE)) {
    try {
      for (const { pid } of JSON.parse(readFileSync(PID_FILE, "utf8"))) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      }
    } catch { /* unreadable pid file */ }
  }
  // Remove only what this command created: the state directory. Nothing else.
  if (existsSync(STATE_DIR)) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    say(`dev-stack: removed ${STATE_DIR}`);
  }
  say("dev-stack: reset. Containers, volumes and the state directory are gone.");

  // The acceptance contract asks reset to prove nothing is left behind.
  const ps = spawnSync("docker", ["ps", "-a", "--filter", `label=com.docker.compose.project=${COMPOSE_PROJECT}`, "--format", "{{.Names}}"], { encoding: "utf8" });
  const volumes = spawnSync("docker", ["volume", "ls", "--filter", `label=com.docker.compose.project=${COMPOSE_PROJECT}`, "--format", "{{.Name}}"], { encoding: "utf8" });
  const leftover = [...(ps.stdout ?? "").split("\n"), ...(volumes.stdout ?? "")].map((s) => s.trim()).filter(Boolean);
  if (leftover.length) fail(`reset left resources behind: ${leftover.join(", ")}`);
  say("dev-stack: verified — no container, volume or process left from this project.");
}

function cmdStatus() {
  if (existsSync(COMPOSE_FILE)) compose("ps", [], {});
  else say("dev-stack: no state directory; the stack has not been started here.");
  if (existsSync(PID_FILE)) {
    for (const { name, pid } of JSON.parse(readFileSync(PID_FILE, "utf8"))) {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      say(`dev-stack: ${name} pid ${pid} ${alive ? "running" : "stopped"}`);
    }
  }
}

// ---------------------------------------------------------------------------
// entry — guarded so the pure helpers above can be imported by tests.
// ---------------------------------------------------------------------------
export const __testing = { renderCompose, readPinnedImages, readPinnedOpenCode, generateSecrets, readSecrets, PORTS, STATE_DIR, COMPOSE_PROJECT };

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  try {
    const command = (process.argv[2] ?? "up").replace(/^--/, "");
    if (command === "up") cmdUp();
    else if (command === "down") cmdDown();
    else if (command === "reset") cmdReset();
    else if (command === "status") cmdStatus();
    else fail(`Unknown command "${command}". Use up | down | reset | status.`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
