// Pure building blocks of `npm run dev:stack` (scripts/dev-stack.mjs). Everything here is deterministic and
// side-effect free apart from the small process helpers at the end, so scripts/tests/dev-stack.test.mjs can cover it
// without Docker.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/** Ports of an installed SpaceApp (run-spaceapp): the dev stack never uses them. */
export const INSTALLED_PORTS = Object.freeze([4910, 4911]);

/** Default host ports: "1" in front of the port the installed app (or the service) uses. All bind to 127.0.0.1. */
export const DEFAULT_PORTS = Object.freeze({
  api: 14910,
  web: 14911,
  opencode: 14912,
  postgres: 15432,
  temporal: 17233
});

export const PORT_ENV = Object.freeze({
  api: "SPACEAPP_DEV_API_PORT",
  web: "SPACEAPP_DEV_WEB_PORT",
  opencode: "SPACEAPP_DEV_OPENCODE_PORT",
  postgres: "SPACEAPP_DEV_POSTGRES_PORT",
  temporal: "SPACEAPP_DEV_TEMPORAL_PORT"
});

export const BIND_HOST = "127.0.0.1";

/** The two compose services the dev stack runs in Docker; their images come from the launcher's compose template. */
export const DOCKER_SERVICES = Object.freeze(["postgres", "temporal"]);

/** CLI wrapper names the API looks for in SPACE_CLI_COMMAND_PATH (the same list the Dockerfile links). */
export const CLI_WRAPPER_RUNTIMES = Object.freeze([
  "codex", "claude", "gemini", "opencode", "qwen", "kimi", "grok", "deepseek", "autohand", "cursor", "copilot"
]);

/** Marker file that proves a directory is a dev-stack state directory before `reset` deletes it. */
export const STATE_MARKER = ".spaceapp-dev-stack";

export class DevStackError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = "DevStackError";
    this.hint = hint ?? null;
  }
}

function fail(message, hint) {
  throw new DevStackError(message, hint);
}

/** Parses one port variable; rejects anything that is not a free-to-use TCP port. */
export function parsePort(name, raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw).trim())) fail(`${name} must be a port number, got "${raw}".`);
  const port = Number.parseInt(String(raw).trim(), 10);
  if (port < 1024 || port > 65535) fail(`${name} must be between 1024 and 65535, got ${port}.`);
  return port;
}

/** Host ports from the environment, defaults otherwise. Distinct, and never the installed app's 4910/4911. */
export function resolvePorts(env = process.env) {
  const ports = {};
  for (const [key, name] of Object.entries(PORT_ENV)) ports[key] = parsePort(name, env[name], DEFAULT_PORTS[key]);
  const seen = new Map();
  for (const [key, port] of Object.entries(ports)) {
    if (INSTALLED_PORTS.includes(port)) {
      fail(`${PORT_ENV[key]}=${port} is a port of an installed SpaceApp.`, "Pick another port so both can run side by side.");
    }
    if (seen.has(port)) fail(`${PORT_ENV[key]} and ${PORT_ENV[seen.get(port)]} both use port ${port}.`);
    seen.set(port, key);
  }
  return ports;
}

/**
 * The compose project is "spaceapp-dev-" plus a short hash of the state directory, so two checkouts (or two state
 * directories) never share containers or volumes, and `reset` only ever matches its own.
 */
export function composeProjectName(stateDir, override) {
  if (override) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(override)) {
      fail(`SPACEAPP_DEV_PROJECT must be lowercase letters, digits, "-" or "_", got "${override}".`);
    }
    if (override === "spaceapp") fail('SPACEAPP_DEV_PROJECT must not be "spaceapp", the installed app\'s project.');
    return override;
  }
  return `spaceapp-dev-${createHash("sha256").update(stateDir).digest("hex").slice(0, 8)}`;
}

/** Unix socket paths are limited to 104 bytes on macOS and 108 on Linux; a deep checkout gets a short /tmp path. */
export function cliHostSocketPath(stateDir, temporaryRoot = tmpdir()) {
  const inside = join(stateDir, "run", "cli-host.sock");
  if (Buffer.byteLength(inside) <= 100) return { path: inside, external: false };
  const hash = createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  return { path: join(temporaryRoot, `spaceapp-dev-${hash}`, "cli-host.sock"), external: true };
}

// ---------------------------------------------------------------------------------------------------------------
// packages/run-spaceapp/templates/compose.yml: the single source of the images and of the core environment.
// The template is plain block YAML; these readers accept exactly that shape and fail closed on anything else.

function serviceBlock(composeText, service) {
  const lines = composeText.split(/\r?\n/);
  const servicesAt = lines.findIndex((line) => line === "services:");
  if (servicesAt === -1) fail("The compose template has no top-level services: key.");
  const start = lines.findIndex((line, index) => index > servicesAt && line === `  ${service}:`);
  if (start === -1) fail(`The compose template has no "${service}" service.`);
  const block = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith("    ")) break;
    block.push(line);
  }
  return block;
}

const PINNED_IMAGE = /^([a-z0-9]+(?:[._/-][a-z0-9]+)*):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})@sha256:([a-f0-9]{64})$/;

/** The image of one compose service, which must be pinned as name:tag@sha256:<64 hex>. */
export function readPinnedImage(composeText, service) {
  const line = serviceBlock(composeText, service).find((entry) => /^ {4}image:/.test(entry));
  if (!line) fail(`The "${service}" service in the compose template has no image.`);
  const image = line.replace(/^ {4}image:\s*/, "").replace(/^["']|["']$/g, "").trim();
  const match = PINNED_IMAGE.exec(image);
  if (!match) {
    fail(`The "${service}" image in the compose template is not pinned by digest: ${image}`,
      "The dev stack only runs images pinned as name:tag@sha256:<digest>, like the installed app.");
  }
  return { image, name: match[1], tag: match[2], digest: `sha256:${match[3]}` };
}

export function readPinnedImages(composeText) {
  return Object.fromEntries(DOCKER_SERVICES.map((service) => [service, readPinnedImage(composeText, service)]));
}

/** The `environment:` mapping of one compose service, in file order, with quotes removed. */
export function readServiceEnvironment(composeText, service) {
  const block = serviceBlock(composeText, service);
  const at = block.findIndex((line) => line === "    environment:");
  if (at === -1) fail(`The "${service}" service in the compose template has no environment mapping.`);
  const entries = [];
  for (const line of block.slice(at + 1)) {
    if (!line.startsWith("      ")) break;
    const match = /^ {6}([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) fail(`Unexpected line in the "${service}" environment of the compose template: ${line.trim()}`);
    let value = match[2].trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    entries.push([match[1], value]);
  }
  if (entries.length === 0) fail(`The "${service}" environment of the compose template is empty.`);
  return entries;
}

/** The OpenCode package and version the CLI image installs (Dockerfile), e.g. @opencode/cli@2.0.32. */
export function readOpenCodePin(dockerfileText) {
  // OpenCode 2 ships as @opencode/cli; releases before 1.1.7 installed opencode-ai. Either must be an exact version.
  const match = /npm install --global[^\n]*?\s((?:@opencode\/cli)|(?:opencode-ai))@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?=[\s\\]|$)/m
    .exec(dockerfileText.replace(/\\\r?\n\s*/g, " "));
  if (!match) {
    fail("The Dockerfile pins no OpenCode version (npm install --global @opencode/cli@<x.y.z>).",
      "The dev stack installs exactly the OpenCode version of the CLI image.");
  }
  return { packageName: match[1], version: match[2], spec: `${match[1]}@${match[2]}` };
}

// ---------------------------------------------------------------------------------------------------------------
// The core environment: the installed core container's environment, translated to host paths and ports.

/**
 * Container paths of the core and CLI containers and where they live in a dev stack. Longest prefix wins. Values
 * of the core environment that start with "/" must fall under one of these, so a new path in the template fails
 * loudly (scripts/tests/dev-stack.test.mjs) instead of pointing a contributor's process at /var/lib.
 */
export function containerPathMap({ repoRoot, stateDir }) {
  return [
    ["/opt/spaceapp/starter-memory", join(repoRoot, "starter-memory")],
    ["/var/lib/spaceapp-cli", join(stateDir, "cli")],
    ["/var/lib/spaceapp", join(stateDir, "data")],
    ["/run/spaceapp-browser", join(stateDir, "run", "browser")],
    ["/run/spaceapp-cli", join(stateDir, "run")],
    ["/workspaces", join(stateDir, "workspaces")],
    ["/usr/local/bin", join(stateDir, "bin")]
  ];
}

export function mapContainerPath(value, pathMap) {
  const entry = pathMap
    .filter(([prefix]) => value === prefix || value.startsWith(`${prefix}/`))
    .sort((a, b) => b[0].length - a[0].length)[0];
  if (!entry) return null;
  return entry[1] + value.slice(entry[0].length);
}

/** Expands ${NAME} and ${NAME:-default}; every NAME must be known to the dev stack. */
export function interpolate(value, variables, key) {
  return value.replace(/\$\{([A-Z0-9_]+)(:-([^}]*))?\}/g, (_, name, hasDefault, fallback) => {
    if (Object.hasOwn(variables, name)) return variables[name];
    if (hasDefault !== undefined) return fallback;
    fail(`${key} in the compose template uses \${${name}}, which the dev stack does not define.`);
  });
}

/** Keys of the core environment the dev stack does not pass on, each with its reason. */
export const DROPPED_CORE_KEYS = Object.freeze({
  // core-entrypoint.sh copies these secrets to SPACE_*_FILE; the dev stack points SPACE_*_FILE at its state directory.
  SPACE_DATABASE_URL_SOURCE_FILE: "read by core-entrypoint.sh only",
  SPACE_SETUP_TOKEN_SOURCE_FILE: "read by core-entrypoint.sh only"
});

/**
 * Builds the environment of the API and the worker: the core container's environment from the compose template,
 * with container paths moved into the state directory, then the settings that differ on a contributor's machine.
 */
export function buildCoreEnvironment({ composeText, repoRoot, stateDir, ports, secrets, socketPath, appVersion, optionalModules }) {
  const pathMap = containerPathMap({ repoRoot, stateDir });
  const variables = {
    SPACEAPP_IMAGE_TAG: `${appVersion}-dev`,
    SPACEAPP_TELEMETRY: "false",
    SPACEAPP_OPTIONAL_MODULES: optionalModules ?? "all",
    SPACEAPP_INSTALL_ID: "",
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    // The browser service is out of scope for the dev stack; the UI explains that it is off, as in a light install.
    SPACEAPP_BROWSER_ENABLED: "false"
  };
  const env = {};
  const origin = {};
  for (const [key, raw] of readServiceEnvironment(composeText, "spaceapp-core")) {
    if (Object.hasOwn(DROPPED_CORE_KEYS, key)) continue;
    let value = interpolate(raw, variables, key);
    if (value.startsWith("/")) {
      const mapped = mapContainerPath(value, pathMap);
      if (mapped === null && !value.startsWith("/run/secrets/") && !value.startsWith("/run/spaceapp/")) {
        fail(`${key}=${value} in the compose template is a container path the dev stack does not map.`,
          "Add its prefix to containerPathMap() in scripts/dev-stack-lib.mjs.");
      }
      value = mapped ?? value;
    }
    env[key] = value;
    origin[key] = "compose";
  }
  const overrides = {
    // The host the processes listen on, and the ports chosen for this stack (never 4910/4911).
    SPACE_API_HOST: BIND_HOST,
    SPACE_API_PORT: String(ports.api),
    SPACE_WEB_HOST: BIND_HOST,
    SPACE_WEB_PORT: String(ports.web),
    SPACE_API_ORIGIN: `http://${BIND_HOST}:${ports.api}`,
    SPACE_TEMPORAL_ADDRESS: `${BIND_HOST}:${ports.temporal}`,
    SPACE_CLI_HOST_SOCKET: socketPath,
    // core-entrypoint.sh exports the database URL and session secret from the secret files and points the API at the
    // setup token file; the dev stack does the same with the files in its state directory.
    SPACE_DATABASE_URL: secrets.databaseUrl,
    SPACE_DATABASE_URL_FILE: join(stateDir, "secrets", "database-url"),
    SPACE_SESSION_SECRET: secrets.sessionSecret,
    SPACE_SESSION_SECRET_FILE: join(stateDir, "secrets", "session-secret"),
    SPACE_SETUP_TOKEN_FILE: join(stateDir, "secrets", "setup-token")
  };
  // Defaults in apps/api/src/config.ts that point under /opt/spaceapp, a directory a contributor cannot write.
  // They are not in the template because the container never writes them; on a host the API would try to.
  const hostDefaults = {
    SPACE_APP_DIAGNOSTICS_ROOT: join(stateDir, "data", "app-diagnostics"),
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: join(stateDir, "data", "maintenance-autopilot", "state.json"),
    SPACE_STREAMING_SECRET_ROOT: join(stateDir, "data", "streaming-secrets"),
    SPACE_DEMO_PROJECTS_ROOT: join(repoRoot, "demos"),
    SPACE_DEMO_PROJECTS_VAR_ROOT: join(stateDir, "data", "demo-projects"),
    SPACE_PROJECTS_ROOT: join(stateDir, "workspaces", "projects"),
    SPACE_INSTALL_ROOT: join(stateDir, "install-root"),
    SPACE_DESIGN_GATEWAY_KEY_FILE: join(stateDir, "secrets", "space-design.key"),
    SPACE_CONNECTOR_KEY_FILE: join(stateDir, "secrets", "space-connector.key"),
    SPACE_GIT_ROOT: repoRoot
  };
  for (const [key, value] of Object.entries({ ...hostDefaults, ...overrides })) {
    env[key] = value;
    origin[key] = Object.hasOwn(overrides, key) ? "override" : "host-default";
  }
  return { env, origin };
}

/** Environment of the CLI host: what the CLI container gets (no database URL, no session secret). */
export function buildCliHostEnvironment({ coreEnv, stateDir, baseEnv = process.env }) {
  const keep = ["PATH", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR", "SystemRoot"];
  const env = {};
  for (const key of keep) if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  return {
    ...env,
    HOME: join(stateDir, "cli"),
    SPACE_PUBLIC_DISTRIBUTION: coreEnv.SPACE_PUBLIC_DISTRIBUTION ?? "true",
    SPACE_MEMORY_ROOT: coreEnv.SPACE_MEMORY_ROOT,
    SPACE_CLI_HOST_SOCKET: coreEnv.SPACE_CLI_HOST_SOCKET
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Generated files in the state directory.

function yamlString(value) {
  return JSON.stringify(String(value));
}

/**
 * The compose file for PostgreSQL and Temporal. It mirrors the template's two services (same images, database,
 * user, health checks and Temporal entrypoint) with ports on 127.0.0.1 only. The database password reaches the
 * containers as a compose secret read from the environment of the `docker compose` process, so compose copies it
 * into each container and the file on the host can stay 0600 (a file-backed secret is a bind mount, which the
 * non-root Temporal user could not read).
 */
export function renderComposeFile({ images, ports, project }) {
  return `# Generated by scripts/dev-stack.mjs for the compose project ${project}. Do not edit; it is rewritten on every start.
name: ${project}
services:
  postgres:
    image: ${yamlString(images.postgres.image)}
    pull_policy: missing
    environment:
      POSTGRES_DB: spaceapp
      POSTGRES_USER: spaceapp
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password
    secrets:
      - postgres-password
    ports:
      - ${yamlString(`${BIND_HOST}:${ports.postgres}:5432`)}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp"]
      interval: 2s
      timeout: 5s
      retries: 60
    labels:
      dev.spaceapp.dev-stack: "true"
    networks:
      - dev-stack
  temporal:
    image: ${yamlString(images.temporal.image)}
    pull_policy: missing
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
    secrets:
      - postgres-password
    ports:
      - ${yamlString(`${BIND_HOST}:${ports.temporal}:7233`)}
    healthcheck:
      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"]
      interval: 3s
      timeout: 10s
      retries: 100
    labels:
      dev.spaceapp.dev-stack: "true"
    networks:
      - dev-stack
networks:
  dev-stack:
    labels:
      dev.spaceapp.dev-stack: "true"
secrets:
  postgres-password:
    environment: SPACEAPP_DEV_POSTGRES_PASSWORD
volumes:
  postgres-data:
    labels:
      dev.spaceapp.dev-stack: "true"
`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * The `<runtime>-vscode-parity` wrapper the from-source CLI host starts. It follows deploy/docker/public-cli-wrapper.sh
 * for OpenCode, with every path in the state directory and OpenCode taken from the state directory's own install.
 * Other runtimes answer as not installed; they can be added later through the same mechanism.
 */
export function renderCliWrapper({ stateDir, repoRoot, nodePath, opencodePort }) {
  const q = shellQuote;
  return `#!/usr/bin/env bash
# Generated by scripts/dev-stack.mjs. The from-source counterpart of deploy/docker/public-cli-wrapper.sh.
set -euo pipefail

runtime_name="$(basename "$0" -vscode-parity)"
state_dir=${q(stateDir)}
state_root="$state_dir/cli/providers/$runtime_name"
credential_root="$state_dir/cli/imported-credentials"
credential_file="$credential_root/$runtime_name.key"
opencode_bin="$state_dir/opencode/node_modules/.bin/opencode"

export USER="\${USER:-spaceapp}"
export HOME="$state_root"
export TMPDIR="$state_root/tmp"
export PATH="$state_dir/opencode/node_modules/.bin:$PATH"
umask 077

if [ "$runtime_name" != "opencode" ]; then
  case "\${1:-}" in
    credential-status) printf 'NOT_READY\\n'; exit 1 ;;
    inspect-env) printf 'runtime=%s\\nhome=isolated\\ncredential=absent\\n' "$runtime_name"; exit 0 ;;
  esac
  echo "$runtime_name is not installed in the dev stack; it runs OpenCode only (CONTRIBUTING.md, Run the full app from source)." >&2
  exit 69
fi

export XDG_CONFIG_HOME="$state_root/config"
export XDG_DATA_HOME="$state_root/data"
export XDG_CACHE_HOME="$state_root/cache"
export XDG_STATE_HOME="$state_root/state"
export OPENCODE_DISABLE_AUTOUPDATE=true
if [ -s "$credential_file" ]; then export OPENCODE_API_KEY="$(cat "$credential_file")"; fi

mkdir -p "$HOME" "$TMPDIR" "$credential_root"
chmod 0700 "$HOME" "$TMPDIR" "$credential_root"

if [ "\${1:-}" = "--run-inner" ]; then
  shift
fi

case "\${1:-}" in
  credential-status)
    if [ -x "$opencode_bin" ]; then printf 'READY\\n'; exit 0; fi
    printf 'NOT_READY\\n'; exit 1 ;;
  credential-observation)
    [ -x "$opencode_bin" ] || exit 1
    printf 'OBSERVATION:%s\\n' "$(printf '%s' "opencode:ready" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d ' ' -f 1 || printf 'ready')"
    exit 0 ;;
  credential-smoke)
    [ -x "$opencode_bin" ] || exit 1
    printf 'SPACE_OPENCODE_OK\\n'; exit 0 ;;
  inspect-env)
    printf 'runtime=opencode\\nhome=isolated\\ncredential=%s\\n' "$([ -x "$opencode_bin" ] && printf present || printf absent)"
    exit 0 ;;
  login)
    shift
    exec "$opencode_bin" auth login --standalone "$@" ;;
  credential-install|opencode-text|opencode-models|setup)
    echo "\${1} is not available in the dev stack." >&2
    exit 64 ;;
esac

if [ ! -x "$opencode_bin" ]; then
  echo "OpenCode is missing from $state_dir/opencode. Restart npm run dev:stack to install it." >&2
  exit 69
fi

# OpenCode 2: a pane (a fresh or resumed TUI) attaches to one shared server with --server, like the CLI image;
# other commands run --standalone (help and version need neither).
case "\${1:-}" in
  --help|-h|--version|-v|models|auth|version) exec "$opencode_bin" "$@" ;;
  ""|--continue|-c) ;;
  *) exec "$opencode_bin" "$@" --standalone ;;
esac

server_url=""
while IFS='=' read -r key value; do
  case "$key" in
    OPENCODE_SERVER_URL) server_url="$value" ;;
    OPENCODE_SERVER_USERNAME) export OPENCODE_SERVER_USERNAME="$value" ;;
    OPENCODE_SERVER_PASSWORD) export OPENCODE_SERVER_PASSWORD="$value" ;;
  esac
done < <(${q(nodePath)} ${q(join(repoRoot, "scripts", "dev-stack.mjs"))} opencode-server --port ${q(opencodePort)} || true)
if [ -z "$server_url" ]; then
  echo "The dev stack could not start the OpenCode server; see $state_dir/cli/providers/opencode/state/opencode/spaceapp-shared-server.log." >&2
  exit 69
fi
exec "$opencode_bin" --server "$server_url" "$@" "$PWD"
`;
}

// ---------------------------------------------------------------------------------------------------------------
// Internal packages: build order and rebuilds.

/** The internal packages in the order the root `build` script builds them (the one place that order is kept). */
export function packageBuildOrder(rootPackageJson) {
  const build = rootPackageJson?.scripts?.build;
  if (typeof build !== "string") fail("The root package.json has no build script.");
  const order = [];
  for (const match of build.matchAll(/npm run build -w (@space\/[a-z0-9-]+)/g)) {
    if (!order.includes(match[1])) order.push(match[1]);
  }
  const apps = new Set(["@space/api", "@space/worker", "@space/web"]);
  const packages = order.filter((name) => !apps.has(name));
  if (packages.length === 0) fail("The root build script names no @space/* package.");
  return packages;
}

/** The package that changed and every later package in build order that depends on it, directly or not. */
export function rebuildPlan(changed, order, dependencies) {
  const plan = new Set([changed]);
  for (const name of order) {
    if (plan.has(name)) continue;
    if ((dependencies[name] ?? []).some((dependency) => plan.has(dependency))) plan.add(name);
  }
  return order.filter((name) => plan.has(name));
}

/** Maps a changed file to the internal package whose src it is in, or null. */
export function packageForPath(relativePath, packageDirs) {
  const normalized = relativePath.replaceAll("\\", "/");
  for (const [name, dir] of Object.entries(packageDirs)) {
    if (normalized.startsWith(`${dir}/src/`)) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Output helpers.

/** Removes ANSI escape sequences, so terminal output can be searched. */
export function stripAnsi(text) {
  return String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[@-Z\\-_]/g, "");
}

/** Replaces every occurrence of the given secrets with a placeholder. */
export function redact(text, secrets) {
  let output = String(text);
  for (const secret of secrets) {
    if (secret && secret.length >= 8) output = output.split(secret).join("[redacted]");
  }
  return output;
}

// ---------------------------------------------------------------------------------------------------------------
// Process identity. A PID in a record file can belong to another process after a crash or reboot; the dev stack
// only signals a process whose command line still names it.

/** The full command line of a process, or null when it does not exist. Linux reads /proc; macOS asks ps. */
export function processCommandLine(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (raw) return raw.split("\0").filter(Boolean).join(" ");
  } catch {
    // Not Linux, or the process is gone.
  }
  try {
    const output = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return output || null;
  } catch {
    return null;
  }
}

/** Process state letter (R, S, Z...) or null; a zombie counts as gone. */
export function processState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) || null;
  } catch {
    // Not Linux, or gone.
  }
  try {
    return execFileSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().charAt(0) || null;
  } catch {
    return null;
  }
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return processState(pid) !== "Z";
}

/** True when the process exists and its command line contains every marker. */
export function processMatches(pid, markers) {
  if (!processAlive(pid)) return false;
  const command = processCommandLine(pid);
  return command !== null && markers.every((marker) => command.includes(marker));
}

/** Every live process whose command line mentions one of the markers (except this process). */
/** Command-line marker for processes started from `dir`. The trailing separator keeps a sibling directory
 *  (`.dev-stack-2/` next to `.dev-stack/`, see SPACEAPP_DEV_STATE_DIR) from matching. */
export function directoryMarker(dir, separator = sep) {
  return dir.endsWith(separator) ? dir : `${dir}${separator}`;
}

export function findProcesses(markers, { exclude = [process.pid] } = {}) {
  let output;
  try {
    output = execFileSync("ps", ["-A", "-o", "pid=,stat=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return [];
  }
  const found = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    if (exclude.includes(pid) || match[2].startsWith("Z")) continue;
    if (markers.some((marker) => match[3].includes(marker))) found.push({ pid, command: match[3] });
  }
  return found;
}
