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
  chmodSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync
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

/**
 * Print one line to stdout. cmdUp is synchronous and prints in order, so every
 * user-facing message goes through here rather than a bare console.log.
 * @param {string} message
 */
function say(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Run a command and hand back the raw result.
 * @param {string} command
 * @param {string[]} args
 * @param {{capture?: boolean}} [options] capture pipes stdout/stderr back to the
 *   caller instead of inheriting the terminal, which is what the state-reading
 *   helpers below need.
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    ...options
  });
  if (result.error) fail(`Failed to run ${command}: ${result.error.message}`);
  return result;
}

/**
 * Fail with an actionable message when Docker with the compose plugin is not
 * usable, so the first line of output names the real problem.
 */
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
/**
 * Read the digest-pinned postgres and temporal image references out of the
 * upstream compose template.
 *
 * The acceptance contract for this feature requires the digests to come from
 * packages/run-spaceapp/templates/compose.yml rather than being copied by hand,
 * so this parses that file rather than hardcoding anything. A template that stops
 * pinning a digest, or a renamed service, fails loudly here instead of quietly
 * running an unpinned image.
 *
 * @param {string} [templateText] Contents of the upstream compose template.
 * @returns {{postgres: string, temporal: string}} Digest-pinned image references.
 */
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
// Two modes, decided by whether a file crosses the container boundary.
//
// Exactly ONE file does. `postgres-password` is declared under the compose
// file's top-level `secrets:` and bind-mounted at /run/secrets/, and the
// temporal service reads it as a NON-ROOT user: temporalio/auto-setup:1.29.1
// sets `User: temporal`, and its entrypoint runs `cat /run/secrets/
// postgres-password`. A 0600 host file makes that `cat` fail with
// `Permission denied`, which crash-loops temporal; the worker that dials it
// then exits 1 and takes the whole stack down. That is a measured failure, not
// a guess: CI run 38892278575 died exactly this way, with postgres Healthy
// (pgvector/pgvector runs as root, so it reads the same file fine) and temporal
// stuck at `running starting`.
//
// packages/run-spaceapp already keeps its container secrets at 0644 for the
// same reason, and its contract test says so outright:
// packages/run-spaceapp/tests/cli.test.mjs:765 — "container secrets are
// world-readable so non-root container users can mount them".
//
// The other three never leave the host, so they stay 0600:
//
//   session-secret  → SPACE_SESSION_SECRET, an environment value
//   database-url    → SPACE_DATABASE_URL, an environment value
//   setup-token     → SPACE_SETUP_TOKEN_FILE, read by the API on the host
//
// owner-only.env is the developer-facing copy of the same values and is 0600
// for the same reason.
//
// The one 0644 file is not exposed by that mode, because the directory holding
// it is 0700: another local user cannot traverse into `secrets/` to reach it.
// That is strictly tighter than the installed app, which leaves its secrets
// directory traversable, and it is what closes the "secrets in directories
// other local users may traverse" finding.
// ---------------------------------------------------------------------------
const SECRET_MODE = 0o600;
const CONTAINER_SECRET_MODE = 0o644;
const SECRETS_DIR_MODE = 0o700;
const SECRET_MODES = {
  "postgres-password": CONTAINER_SECRET_MODE,
  "session-secret": SECRET_MODE,
  "setup-token": SECRET_MODE,
  "database-url": SECRET_MODE
};
const SECRET_FILES = Object.keys(SECRET_MODES);

/**
 * Create the per-state-directory secrets, or tighten the ones already there.
 *
 * Modes are per file, not per directory of files: `postgres-password` is 0644
 * because a non-root container user reads it, and everything else is 0600
 * because only this machine ever sees it. The directory itself is 0700, which is
 * what keeps the one 0644 file unreachable by other local users. The full
 * reasoning, and the CI run that proves the 0600 case fails, is in the block
 * comment above.
 *
 * Idempotent on purpose: re-running narrows a file an older run left too open,
 * in either direction.
 *
 * @param {string} [dir] State secret directory to create or reuse.
 * @returns {{postgresPassword: string, sessionSecret: string, setupToken: string, databaseUrl: string}}
 */
export function generateSecrets(dir = SECRETS_DIR) {
  mkdirSync(dir, { recursive: true, mode: SECRETS_DIR_MODE });
  // mkdirSync's mode only applies to directories it creates, so a state
  // directory left behind by an older run has to be narrowed explicitly.
  if (process.platform !== "win32") chmodSync(dir, SECRETS_DIR_MODE);
  const write = (name, value) => {
    const path = join(dir, name);
    const mode = SECRET_MODES[name];
    // writeFileSync's mode only applies at creation, so an existing file needs
    // an explicit chmod to move between the two mode classes.
    writeFileSync(path, value, { mode });
    chmodSync(path, mode);
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

  // The developer-facing copy: same values, same mode, never mounted anywhere.
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
    { mode: SECRET_MODE }
  );
  chmodSync(ownerOnlyPath, SECRET_MODE);

  // Belt and braces on POSIX: assert the modes landed.
  // Windows has no POSIX permission bits — Node reports 0666 for every
  // user-writable file and chmodSync only toggles the read-only flag, so an
  // assertion there would be meaningless. There the secret is protected by the
  // per-user profile directory; chmodSync is still called so the file is at
  // least marked read-only where that helps. This is the same trade-off npm
  // makes for ~/.npmrc credentials, and the same guard packages/run-spaceapp/
  // tests/cli.test.mjs:774 applies.
  if (process.platform !== "win32") {
    const dirMode = statSync(dir).mode & 0o777;
    if (dirMode !== SECRETS_DIR_MODE) {
      fail(`${dir} has mode ${dirMode.toString(8)}; expected 0700 so other local users cannot reach the secrets.`);
    }
    const expected = { ...SECRET_MODES, "owner-only.env": SECRET_MODE };
    for (const name of Object.keys(expected)) {
      const mode = statSync(join(dir, name)).mode & 0o777;
      if (mode !== expected[name]) {
        fail(`${name} has mode ${mode.toString(8)}; expected 0${expected[name].toString(8)}.`);
      }
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

/**
 * Read the secrets a previous `up` wrote into a state directory.
 *
 * `up` uses this when the state directory already exists, so a second run reuses
 * the same database password instead of orphaning the postgres volume that is
 * still holding the old one. Throws if any file is missing, which is why `up`
 * checks for the directory before calling it.
 *
 * @param {string} [dir] State secret directory to read.
 * @returns {{postgresPassword: string, sessionSecret: string, setupToken: string, databaseUrl: string}}
 */
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
// The environment every from-source service shares.
//
// Exported so a test can assert the shape, because two of these are contracts
// that fail quietly when they are wrong:
//
//   SPACE_SETUP_TOKEN_FILE — the API reads the owner setup token from the file
//     this names, never from a `SPACE_SETUP_TOKEN` value
//     (apps/api/src/owner-setup.ts:29), and arms a 15 minute TTL when it loads
//     it. deploy/docker/core-entrypoint.sh hands its container the same
//     variable. Passing the token through the environment instead leaves
//     GET /api/setup/status reporting `expiresAt: null`, and POST
//     /api/setup/claim then fails closed with 409 "The SpaceApp setup token is
//     not valid." — which is exactly how the first green /readyz run failed.
//
//   SPACE_DEV_LOGIN — pinned to "false". The repository's own dev script sets
//     it true and ships a fixed session secret; the acceptance contract forbids
//     that shortcut, so the dev stack goes through real owner setup instead.
// ---------------------------------------------------------------------------
export const SETUP_TOKEN_FILE_VAR = "SPACE_SETUP_TOKEN_FILE";

/**
 * Build the environment for the four from-source services (API, web, worker and
 * CLI host).
 *
 * Every address, port and path the services need is decided here rather than
 * inherited, so the stack cannot pick up an installed SpaceApp's ports, state
 * directory or session secret by accident.
 *
 * The owner setup token travels as a FILE PATH, not a value: GET
 * /api/setup/status only registers a token that arrived through
 * SPACE_SETUP_TOKEN_FILE, and a plain SPACE_SETUP_TOKEN value leaves the
 * endpoint reporting `expiresAt: null` while POST /api/setup/claim then answers
 * 409 "The SpaceApp setup token is not valid."
 *
 * @param {{postgresPassword: string, sessionSecret: string, setupToken: string, databaseUrl: string}} secrets
 * @param {{version?: string, binDir: string, commandPath?: string}} opencode Where the pinned OpenCode wrapper lives.
 * @returns {Record<string, string>} Environment entries for the spawned services.
 */
export function buildServiceEnv(secrets, opencode) {
  const pathSep = process.platform === "win32" ? ";" : ":";
  return {
    // Real owner setup, not the dev-login shortcut.
    SPACE_DEV_LOGIN: "false",
    SPACE_SESSION_SECRET: secrets.sessionSecret,
    [SETUP_TOKEN_FILE_VAR]: join(SECRETS_DIR, "setup-token"),
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
    PATH: `${opencode.binDir}${pathSep}${process.env.PATH ?? ""}`,
    SPACE_CLI_WORKSPACE_ROOT: join(STATE_DIR, "workspaces"),
    SPACE_CODEX_HOME: join(STATE_DIR, "providers/codex"),
    SPACE_MEMORY_ROOT: join(STATE_DIR, "memory"),
    SPACE_MEMORY_GRAPH_ROOT: join(STATE_DIR, "memory-graph"),
    SPACE_ARTIFACT_ROOT: join(STATE_DIR, "artifacts")
  };
}

// ---------------------------------------------------------------------------
// Generated compose file. Only the Docker services (postgres + temporal). The
// application processes run from source on the host, which is the whole point.
// ---------------------------------------------------------------------------
/**
 * Render the dev-stack compose file: namespaced, loopback-bound, digest-pinned.
 *
 * Three things here are contract rather than convenience:
 *
 *   - The image references come from the upstream template through
 *     readPinnedImages, digest included. Nothing is hand-copied, so a bumped
 *     upstream template moves this stack with it and cannot silently drift.
 *   - Every published port is bound to 127.0.0.1. PostgreSQL and Temporal never
 *     leave the machine, which is a large part of why a generated database
 *     password is an acceptable one.
 *   - Only `postgres-password` appears under the top-level `secrets:`. That is
 *     the single fact the file modes above depend on: it is the only secret a
 *     container reads, so it is the only one that may be 0644.
 *
 * @param {{postgres: string, temporal: string}} images Digest-pinned image references.
 * @param {{postgresPassword: string, sessionSecret: string, setupToken: string, databaseUrl: string}} secrets
 * @param {Record<string, number>} [ports] Host port per service.
 * @returns {string} Contents for the generated compose file.
 */
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
// The API does not run `opencode` directly. apps/api/src/cli-runtimes.ts
// detectCommand() probes SPACE_CLI_COMMAND_PATH for a file named
// `<commandName>` and gates on `access(candidate, X_OK)`, and the `opencode`
// descriptor in apps/api/src/cli-runtime-descriptors.ts fixes commandName to
// `opencode-vscode-parity`. The containers satisfy that contract with symlinks
// the Dockerfile installs next to deploy/docker/public-cli-wrapper.sh; a
// from-source stack has to satisfy it itself, so renderOpenCodeWrapper() below
// writes the from-source equivalent into the state directory.
const DOCKERFILE = join(repoRoot, "Dockerfile");

export const OPENCODE_PARITY_COMMAND = "opencode-vscode-parity";

/**
 * Read the pinned opencode-ai version out of the upstream Dockerfile.
 *
 * The dev stack installs the same version the released images bake in, but into
 * its own state directory instead of a global npm prefix — the acceptance
 * contract calls that out, and it means an installed SpaceApp's toolchain is
 * never touched. Reading the version from the Dockerfile is what keeps the two
 * from drifting.
 *
 * @param {string} [dockerfileText] Contents of the upstream Dockerfile.
 * @returns {string} The pinned version, without a leading `@` or `v`.
 */
export function readPinnedOpenCode(dockerfileText = readFileSync(DOCKERFILE, "utf8")) {
  // `RUN npm install --global ... opencode-ai@1.18.4 ...`
  const match = dockerfileText.match(/opencode-ai@([0-9]+\.[0-9]+\.[0-9]+(?:-[^\s\\]+)?)/);
  if (!match) fail(`Could not find a pinned opencode-ai version in ${DOCKERFILE}.`);
  return match[1];
}

/**
 * The wrapper the API executes for an OpenCode pane. Mirrors the `opencode`
 * branch of deploy/docker/public-cli-wrapper.sh — provider state is redirected
 * under the state directory and `--run-inner` is tolerated, because the API
 * appends it when it resumes a native session.
 */
/**
 * Render the shell wrapper that stands in for the CLI host's `-vscode-parity`
 * command.
 *
 * The CLI host resolves a runtime by looking for `<name>-vscode-parity` inside
 * SPACE_CLI_COMMAND_PATH, so a directory holding only `opencode` is not enough:
 * without this wrapper the stack answers POST /api/panes/:id/cli/session with 503
 * CLI_RUNTIME_DISABLED. The wrapper is what makes the pane step in CI reachable.
 *
 * It pins OpenCode's state to the dev stack's own directory through the XDG
 * variables, so a developer's real OpenCode configuration is never read or
 * written, and it exports a placeholder OPENCODE_API_KEY because the pane only
 * has to start and show its UI — the contract explicitly requires no AI provider
 * account.
 *
 * @param {string} [stateDir] State directory the wrapper should confine itself to.
 * @returns {string} The wrapper script text.
 */
export function renderOpenCodeWrapper(stateDir = STATE_DIR) {
  const providerRoot = join(stateDir, "providers/opencode");
  // The launcher npm writes for a `--prefix` install. Addressed through the
  // state directory so a globally installed `opencode` can never be picked up.
  const launcher = join(stateDir, "node_modules/.bin/opencode");
  return `#!/bin/sh
# Generated by scripts/dev-stack.mjs — do not edit, do not commit.
#
# The API probes SPACE_CLI_COMMAND_PATH for this exact file name and requires
# it to be executable (apps/api/src/cli-runtimes.ts detectCommand). The name is
# fixed by the \`opencode\` descriptor in apps/api/src/cli-runtime-descriptors.ts.
set -eu

state_root="${providerRoot}"
mkdir -p "$state_root/tmp"
export HOME="$state_root"
export TMPDIR="$state_root/tmp"
export XDG_CONFIG_HOME="$state_root/config"
export XDG_DATA_HOME="$state_root/data"
export XDG_CACHE_HOME="$state_root/cache"
export XDG_STATE_HOME="$state_root/state"
umask 077

# The API appends this when it resumes a native session.
if [ "\${1:-}" = "--run-inner" ]; then
  shift
fi

exec "${launcher}" "$@"
`;
}

/**
 * Write the OpenCode wrapper into the state directory and mark it executable.
 *
 * The execute bit is part of the contract, not a nicety: the CLI host gates each
 * candidate on an execute-permission check, so a wrapper that is merely readable
 * is reported as absent. Windows has no execute bit and its access check only
 * confirms the file exists, hence the platform branch.
 *
 * Called before the version stamp is consulted, so an existing install still
 * picks up a changed wrapper.
 *
 * @param {string} [stateDir] State directory to write into.
 * @returns {{binDir: string, commandPath: string}} Where the wrapper landed.
 */
export function writeOpenCodeWrapper(stateDir = STATE_DIR) {
  const binDir = join(stateDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const commandPath = join(binDir, OPENCODE_PARITY_COMMAND);
  writeFileSync(commandPath, renderOpenCodeWrapper(stateDir), "utf8");
  // detectCommand gates on X_OK, so the bit is part of the contract. Windows
  // has no execute bit and its access(X_OK) only checks that the file exists.
  if (process.platform !== "win32") chmodSync(commandPath, 0o755);
  return { binDir, commandPath };
}

/**
 * Install the pinned OpenCode version into the state directory and write the
 * parity wrapper that SPACE_CLI_COMMAND_PATH has to contain.
 *
 * The install uses `npm install --prefix <stateDir>` on purpose: nothing lands
 * in the user's global npm prefix, so an installed SpaceApp's own toolchain is
 * left alone. A version stamp short-circuits the network on later runs.
 *
 * @param {string} [stateDir]
 * @returns {{version: string, binDir: string, commandPath: string}}
 */
function ensureOpenCode(stateDir = STATE_DIR) {
  const version = readPinnedOpenCode();
  const { binDir, commandPath } = writeOpenCodeWrapper(stateDir);

  // Already installed at the pinned version? Then skip the network entirely.
  const stamp = join(stateDir, "opencode.version");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version) {
    say(`dev-stack: OpenCode ${version} already installed in ${stateDir}`);
    return { version, binDir, commandPath };
  }

  say(`dev-stack: installing opencode-ai@${version} into ${stateDir} (not global)...`);
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
  say(`dev-stack: OpenCode ${version} installed; pane command ${commandPath}`);
  return { version, binDir, commandPath };
}

// ---------------------------------------------------------------------------
// Compose plumbing. Always namespaced to COMPOSE_PROJECT and always pointed at
// COMPOSE_FILE so nothing here can touch an installed SpaceApp's stack.
// ---------------------------------------------------------------------------
const composeArgs = (verb, extra = []) => [
  "compose", "-p", COMPOSE_PROJECT, "-f", COMPOSE_FILE, verb, ...extra
];

/**
 * Run one `docker compose` verb against this checkout's own project and file.
 * Every call is namespaced to COMPOSE_PROJECT and COMPOSE_FILE, so it cannot
 * reach an installed SpaceApp's stack.
 * @param {string} verb
 * @param {string[]} [extra]
 * @param {{capture?: boolean}} [options]
 */
function compose(verb, extra = [], options = {}) {
  return run("docker", composeArgs(verb, extra), options);
}

// Synchronous sleep — cmdUp is synchronous by design so `npm run dev:stack`
// prints everything in order, and Atomics.wait is the one portable way to block
// without pulling in a dependency.
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// `docker inspect` renders the two template fields as one string, so a healthy
// running container reads "running healthy" — the status first, the health
// second, and the health field is empty when the image ships no healthcheck.
// Split the fields and compare them individually; testing for a prefix of the
// joined string silently never matches "running healthy".
/**
 * Parse the newline-delimited JSON that `docker compose ps --format json` prints.
 *
 * One JSON object per line, one line per container, and empty output is a valid
 * answer meaning nothing is running — `reset` leans on that reading to prove it
 * cleaned up after itself, which is why an empty string must not throw.
 *
 * Unparseable lines are skipped rather than fatal, so a stray warning on stdout
 * cannot turn a teardown into a failure.
 *
 * @param {string} raw Raw stdout from `docker compose ps`.
 * @returns {Array<Record<string, unknown>>} One entry per parsed container.
 */
export function parseContainerState(raw) {
  const [status = "", health = ""] = (raw ?? "").trim().split(/\s+/);
  return { raw: (raw ?? "").trim(), status, health };
}

/**
 * Read one container's status and health exactly as docker inspect reports them.
 * @param {string} name
 * @returns {{raw: string, status: string, health: string}}
 */
function containerState(name) {
  const r = run("docker", ["inspect", "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", name], { capture: true });
  return parseContainerState(r.stdout);
}

/**
 * Poll `docker compose ps` until postgres reports healthy and temporal is up.
 *
 * Polling rather than sleeping a fixed interval, because the two containers need
 * very different amounts of time on a warm image cache versus a cold one, and
 * migrations must not start against a postgres that is still initialising its
 * data directory.
 *
 * A timeout fails with the states it actually observed, so a CI log says what was
 * wrong rather than only that something was slow.
 *
 * @param {{postgres: string, temporal: string}} [names] Container names to wait on.
 * @param {number} [timeoutMs] How long to keep polling before failing.
 */
export function waitForInfrastructure(names = { postgres: `${COMPOSE_PROJECT}-postgres-1`, temporal: `${COMPOSE_PROJECT}-temporal-1` }, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let postgres = parseContainerState("");
  let temporal = parseContainerState("");
  while (Date.now() < deadline) {
    postgres = containerState(names.postgres);
    temporal = containerState(names.temporal);
    // PostgreSQL must be running and report healthy. Temporal only has to be
    // running: its image's healthcheck shells out to the `temporal` CLI, which
    // is not a contract this script should depend on.
    if (postgres.status === "running" && postgres.health === "healthy" && temporal.status === "running") {
      say(`dev-stack: postgres ${postgres.raw}; temporal ${temporal.raw}`);
      return { postgres: postgres.raw, temporal: temporal.raw };
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
  fail(`Infrastructure did not become ready in ${Math.round(timeoutMs / 1000)}s (postgres=${postgres.raw || "absent"}, temporal=${temporal.raw || "absent"}).`);
}

// ---------------------------------------------------------------------------
// Process supervision. Each child writes to its own log; if one dies the whole
// stack prints a clear failure and shuts down — never a silent hang.
// ---------------------------------------------------------------------------
const children = new Map();
let stopping = false;
let exitCode = 0;

/**
 * Start one host-side service (api, web, worker, cli-host) with its output going
 * to its own file under LOG_DIR.
 *
 * A pipe is deliberately not used: `npx tsx watch` and `vite` keep the write
 * end open past this process's own lifetime, and a piped child would hold the
 * command open after it has already printed its banner.
 *
 * @param {string} name
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {{cwd?: string}} [options]
 */
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

// A child spawned with `detached` leads its own process group, so `-pid` is the
// only address that reaches the whole tree. `npx tsx watch` and `vite` each fork
// workers of their own, and a leader-only signal leaves those children running —
// which is exactly what the acceptance contract's "nothing left behind" check
// looks for after `reset`.
function signalProcessTree(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (process.platform === "win32") {
    // Windows has no POSIX signals. taskkill /T is the only way to reach the
    // grandchildren npx and vite fork, and console processes do not honour a
    // graceful close request, so /F is the form that actually works.
    return spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).status === 0;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
      return true;
    } catch (error) {
      // EPERM means the process exists but is not ours to signal; anything else
      // (ESRCH) means try the other address, then give up.
      if (error?.code === "EPERM") return true;
    }
  }
  return false;
}

// One /proc entry's scheduling state and process-group id, or null when the
// entry vanished between listing and reading. Field layout is
// `pid (comm) state ppid pgrp ...`; `comm` is the executable name and may itself
// contain spaces, parentheses and newlines, so only the fields after the closing
// paren are safe to split on.
function readProcStat(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], pgrp: Number(fields[2]) };
  } catch {
    return null;
  }
}

// True when any process in `pgid` can still do work. `Z` is a zombie and `X` is
// being torn down; neither runs user code, and neither can be killed, so neither
// counts towards "something is still running here".
//
// This exists because the portable probe cannot answer the question. A process
// group answers signal 0 while ANY member exists, and an exited process stays a
// member until its parent collects it — so a fully stopped stack still reads as
// alive. Returns null when /proc is unavailable, letting the caller fall back.
function linuxGroupHasLiveMember(pgid) {
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const stat = readProcStat(entry);
    if (stat && stat.pgrp === pgid && stat.state !== "Z" && stat.state !== "X") return true;
  }
  return false;
}

/**
 * Decide a `ps -a -x -o pid=,pgid=,stat=` listing, read as text. Split out from
 * the spawn so the macOS rule can be proven on any platform: the CI job that
 * found the bug runs on Linux, and a test that only ever runs on macOS would
 * have missed it too.
 *
 * @param {string} stdout
 * @param {number} pgid
 * @returns {boolean} true when some row in `pgid` can still run user code.
 */
export function psRowsShowLiveMember(stdout, pgid) {
  for (const line of stdout.split("\n")) {
    const [pid, group, state] = line.trim().split(/\s+/);
    if (!pid || !group || !state) continue;
    if (Number(group) !== pgid) continue;
    if (state[0] === "Z" || state[0] === "X") continue;
    return true;
  }
  return false;
}

/**
 * The macOS and BSD equivalent of `linuxGroupHasLiveMember`, reading `ps`
 * instead of `/proc`.
 *
 * BSD `ps` reports the same scheduling-state letters as `/proc`, so the same
 * zombie filter applies; it just has to be fetched through a command rather
 * than a file. `-a -x` lists every process, because the question is about the
 * whole group and not about one pid.
 *
 * @param {number} pgid
 * @returns {boolean | null} null when `ps` could not answer.
 */
function bsdGroupHasLiveMember(pgid) {
  const out = spawnSync("ps", ["-a", "-x", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
  if (out.status !== 0 || typeof out.stdout !== "string") return null;
  return psRowsShowLiveMember(out.stdout, pgid);
}

/**
 * The macOS and BSD equivalent of `readProcStat` for a single pid. Only the
 * state is needed here; the group is already known from the probe above.
 *
 * @param {number} pid
 * @returns {string | null} the `ps` state string, or null when the pid is gone.
 */
function bsdProcessState(pid) {
  const out = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  if (out.status !== 0 || typeof out.stdout !== "string") return null;
  const state = out.stdout.trim();
  return state === "" ? null : state;
}

/**
 * Any still-live member of `pgid`, or null when this platform cannot say.
 *
 * @param {number} pgid
 * @returns {boolean | null}
 */
function posixGroupHasLiveMember(pgid) {
  if (process.platform === "linux") return linuxGroupHasLiveMember(pgid);
  if (process.platform === "darwin" || process.platform.endsWith("bsd")) return bsdGroupHasLiveMember(pgid);
  return null;
}

/**
 * The scheduling state of one pid, or null when it is gone or unreadable.
 *
 * @param {number} pid
 * @returns {string | null}
 */
function posixProcessState(pid) {
  if (process.platform === "linux") return readProcStat(pid)?.state ?? null;
  if (process.platform === "darwin" || process.platform.endsWith("bsd")) return bsdProcessState(pid);
  return null;
}

/**
 * Report whether a process, or anything it forked, is still alive.
 *
 * Signal 0 is not sufficient on POSIX. A process whose parent never reaps it
 * stays visible as a zombie, and `process.kill(pid, 0)` succeeds for zombies,
 * so a service that has already finished would be reported as running forever.
 * The platform's process table — `/proc` on Linux, `ps` on macOS and BSD — is
 * asked first, and the zombie states are filtered out.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function processTreeAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (process.platform === "win32") {
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8" });
    return (out.stdout ?? "").includes(`"${pid}"`);
  }
  // Ask the process table first: the group, then the pid itself.
  const groupLive = posixGroupHasLiveMember(pid);
  if (groupLive !== null) {
    if (groupLive) return true;
    const own = posixProcessState(pid);
    return own !== null && own[0] !== "Z" && own[0] !== "X";
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      if (error?.code === "EPERM") return true;
    }
  }
  return false;
}

// Synchronous sleep: cmdDown/cmdReset have to be sure the tree is gone before
// they report success, and they run outside any event loop turn that could await.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// SIGTERM the tree, give it a bounded grace period, then SIGKILL whatever is
// left and verify. Returns true only when nothing survives.
function stopProcessTrees(entries, { graceMs = 6000 } = {}) {
  const pids = [...new Set(entries.map((entry) => entry.pid))].filter((pid) => Number.isInteger(pid) && pid > 1);
  for (const { name, pid } of entries) {
    if (signalProcessTree(pid, "SIGTERM")) say(`dev-stack: stopping ${name} (pid ${pid})`);
  }
  const deadline = Date.now() + graceMs;
  let alive = pids.filter(processTreeAlive);
  while (alive.length && Date.now() < deadline) {
    sleepSync(100);
    alive = alive.filter(processTreeAlive);
  }
  for (const pid of alive) signalProcessTree(pid, "SIGKILL");
  // SIGKILL is not synchronous: the process still has to be scheduled to die, and
  // a survivor check that runs immediately reports processes that were already on
  // their way out. Give the kernel a bounded moment before believing it.
  if (alive.length) {
    const killDeadline = Date.now() + 2000;
    while (alive.some(processTreeAlive) && Date.now() < killDeadline) sleepSync(50);
  }
  const survivors = alive.filter(processTreeAlive);
  if (survivors.length) {
    fail(`Could not stop pid ${survivors.join(", ")}. Stop them before continuing.`);
  }
  return pids.length;
}

/**
 * Read the pids an earlier `up` recorded. A missing, truncated or hand-edited
 * file reads as empty rather than throwing, so `down` and `reset` still work
 * after an interrupted start.
 * @param {string} [path]
 * @returns {Array<{name: string, pid: number}>}
 */
function readPidFile(path = PID_FILE) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && Number.isInteger(entry.pid) && entry.pid > 1);
  } catch {
    // A truncated or hand-edited pid file must not wedge `down` or `reset`.
    return [];
  }
}

/**
 * Ask every service this process spawned to stop, then hand off the state
 * cleanup. Guarded by `stopping` so a second signal cannot re-enter it.
 * @param {NodeJS.Signals} [signal]
 */
function stopAll(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const [name, { child }] of children) {
    // The group address covers the workers `npx tsx watch` and `vite` fork; the
    // child handle is the fallback for anything that never rejoined a group.
    if (!signalProcessTree(child.pid, signal)) {
      try { child.kill(signal); } catch { /* already gone */ }
    }
    void name;
  }
  // The last child's exit handler calls process.exit; add a hard deadline
  // anyway, and make it reach the group so nothing outlives the command.
  setTimeout(() => {
    for (const { child } of children.values()) {
      if (!signalProcessTree(child.pid, "SIGKILL")) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }
    cleanupFiles();
    process.exit(exitCode);
  }, 8000).unref();
}

/** Remove the pid file once every service has been asked to stop. */
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

  // A pre-existing state directory may carry modes from an older run. Re-apply
  // both classes whether or not generateSecrets just wrote these, so the
  // contract holds on every run and not only for a fresh state directory.
  if (process.platform !== "win32") {
    chmodSync(SECRETS_DIR, SECRETS_DIR_MODE);
    for (const name of SECRET_FILES) {
      const path = join(SECRETS_DIR, name);
      if (!existsSync(path)) continue;
      chmodSync(path, SECRET_MODES[name]);
    }
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
  say(`dev-stack: pane command    ${opencode.commandPath}`);

  // Every path the CLI host and panes touch lives under the state directory,
  // so an installed SpaceApp's sockets, provider state and workspaces are
  // never reused.
  for (const sub of ["workspaces", "providers/codex", "providers/opencode", "memory", "memory-graph", "artifacts", "logs"]) {
    mkdirSync(join(STATE_DIR, sub), { recursive: true });
  }

  const commonEnv = buildServiceEnv(secrets, opencode);

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

/**
 * `dev:stack -- down`: stop this project's containers and any host process an
 * earlier `up` recorded. The state directory is kept so a later `up` is fast.
 */
function cmdDown() {
  requireDocker();
  if (existsSync(COMPOSE_FILE)) compose("down", ["--remove-orphans"]);
  // Stop anything still alive that we spawned (up was interrupted, etc). The pid
  // file names children from an earlier process, so this can only address them by
  // pid — and only the process-group address reaches what they forked.
  const spawned = readPidFile();
  if (spawned.length) {
    const stopped = stopProcessTrees(spawned);
    say(`dev-stack: stopped ${stopped} host process(es) from this stack.`);
  }
  cleanupFiles();
  say("dev-stack: down.");
}

/**
 * `dev:stack -- reset`: stop host processes, tear the project down including
 * its volume, drop the state directory, then verify that nothing is left.
 * Only what this project created is removed.
 */
function cmdReset() {
  requireDocker();
  // Stop the host processes before anything else: they keep the state directory
  // busy, and the acceptance contract checks that reset leaves no process behind.
  const spawned = readPidFile();
  if (spawned.length) {
    const stopped = stopProcessTrees(spawned);
    say(`dev-stack: stopped ${stopped} host process(es) from this stack.`);
  }
  if (existsSync(COMPOSE_FILE)) {
    compose("down", ["-v", "--remove-orphans"]);
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
  const survivors = spawned.filter((entry) => processTreeAlive(entry.pid));
  if (survivors.length) {
    fail(`reset left processes behind: ${survivors.map((entry) => `${entry.name}(${entry.pid})`).join(", ")}`);
  }
  say("dev-stack: verified — no container, volume or process left from this project.");
}

/** `dev:stack -- status`: show the project's containers and recorded host pids. */
function cmdStatus() {
  if (existsSync(COMPOSE_FILE)) compose("ps", [], {});
  else say("dev-stack: no state directory; the stack has not been started here.");
  for (const { name, pid } of readPidFile()) {
    say(`dev-stack: ${name} pid ${pid} ${processTreeAlive(pid) ? "running" : "stopped"}`);
  }
}

// ---------------------------------------------------------------------------
// entry — guarded so the pure helpers above can be imported by tests.
// ---------------------------------------------------------------------------
export const __testing = {
  renderCompose, readPinnedImages, readPinnedOpenCode, generateSecrets, readSecrets,
  PORTS, STATE_DIR, COMPOSE_PROJECT, PID_FILE,
  // Teardown helpers: they reach a whole process group, which is what `down`
  // and `reset` rely on, so they are worth proving directly.
  signalProcessTree, processTreeAlive, stopProcessTrees, readPidFile, sleepSync,
  // The macOS half of the liveness probe. `ps` output is parsed here so the
  // rule can be tested wherever the suite runs, not only on a Mac.
  psRowsShowLiveMember
};

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
