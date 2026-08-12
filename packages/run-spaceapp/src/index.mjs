import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
  stat,
  writeFile
} from "node:fs/promises";
import { availableParallelism, homedir, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeWorkspaceName,
  stripTrailingLineEndings
} from "./string-utils.mjs";
import { UNIVERSAL_COMMAND } from "./package-info.mjs";

const CONFIG_SCHEMA_VERSION = 3;
const MIN_INSTALL_CPU_COUNT = 4;
const MIN_INSTALL_MEMORY_BYTES = 7 * 1024 ** 3;
const MIN_INSTALL_MEMORY_LABEL = "7 GiB usable (8 GB-class system)";
const CONTAINER_SECRET_MODE = 0o644;
const MIN_INSTALL_FREE_DISK_BYTES = 15 * 1024 ** 3;
const PROFILE_RUNTIME_SETTINGS = Object.freeze({
  light: Object.freeze({
    browserEnabled: false,
    coreMemoryLimit: "2g",
    coreCpuLimit: "2.0",
    cliMemoryLimit: "1536m",
    cliCpuLimit: "1.5",
    browserMemoryLimit: "1536m",
    browserCpuLimit: "1.5",
    postgresMemoryLimit: "768m",
    postgresCpuLimit: "1.0",
    temporalMemoryLimit: "768m",
    temporalCpuLimit: "1.0"
  }),
  standard: Object.freeze({
    browserEnabled: true,
    coreMemoryLimit: "4g",
    coreCpuLimit: "4.0",
    cliMemoryLimit: "3g",
    cliCpuLimit: "3.0",
    browserMemoryLimit: "2g",
    browserCpuLimit: "2.0",
    postgresMemoryLimit: "1g",
    postgresCpuLimit: "2.0",
    temporalMemoryLimit: "1g",
    temporalCpuLimit: "2.0"
  })
});
const SECRET_FIELD = /password|secret|token|api.?key|credential/i;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const BACKUP_ID_PATTERN = /^spaceapp-backup-\d{8}T\d{9}Z$/;
const PROVIDERS = Object.freeze({
  bundled: Object.freeze(["opencode", "codex", "gemini", "qwen", "kimi", "grok", "autohand", "cursor", "copilot"]),
  ownerInstalled: Object.freeze(["claude"]),
  experimental: Object.freeze(["deepseek"])
});
const ALL_PROVIDERS = new Set(Object.values(PROVIDERS).flat());
const CONFIG_KEYS = new Set([
  "schemaVersion",
  "version",
  "previousVersion",
  "bindHost",
  "port",
  "telemetry",
  "profile",
  "accessMode",
  "workspaces",
  "companionsEnabled"
]);

export function resolveSpaceAppHome({
  env = process.env,
  platform = process.platform,
  home = homedir()
} = {}) {
  if (env.SPACEAPP_HOME) {
    return resolve(env.SPACEAPP_HOME);
  }
  if (platform === "win32") {
    return resolve(env.APPDATA || join(home, "AppData", "Roaming"), "SpaceApp");
  }
  if (platform === "darwin") {
    return resolve(home, "Library", "Application Support", "SpaceApp");
  }
  return resolve(env.XDG_CONFIG_HOME || join(home, ".config"), "spaceapp");
}

export function resolveInstallProfile(requestedProfile, totalMemoryBytes) {
  if (requestedProfile === "light" || requestedProfile === "standard") {
    return requestedProfile;
  }
  if (requestedProfile !== "auto") {
    throw new Error("Install profile must be auto, light, or standard.");
  }
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    throw new Error("Total system memory must be available for automatic profile selection.");
  }
  return "light";
}

export function resolveInstallAccessMode(requestedMode, existingMode = "isolated") {
  if (requestedMode === undefined) {
    return existingMode;
  }
  if (requestedMode === "isolated" || requestedMode === "host-root") {
    return requestedMode;
  }
  throw new Error("Install access mode must be isolated or host-root.");
}

export async function inspectSystemResources(root) {
  validateHome(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const fileSystem = await statfs(root);
  return {
    cpuCount: availableParallelism(),
    totalMemoryBytes: totalmem(),
    freeDiskBytes: Number(fileSystem.bavail) * Number(fileSystem.bsize)
  };
}

export function installResourceChecks(resources) {
  const cpuCount = Number(resources?.cpuCount);
  const totalMemoryBytes = Number(resources?.totalMemoryBytes);
  const freeDiskBytes = Number(resources?.freeDiskBytes);
  if (![cpuCount, totalMemoryBytes, freeDiskBytes].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("System CPU, memory, and free-disk information is required.");
  }
  return [
    {
      name: "CPU",
      ok: cpuCount >= MIN_INSTALL_CPU_COUNT,
      detail: `${cpuCount} available; ${MIN_INSTALL_CPU_COUNT} required`
    },
    {
      name: "Memory",
      ok: totalMemoryBytes >= MIN_INSTALL_MEMORY_BYTES,
      detail: `${formatGibibytes(totalMemoryBytes)} GiB available; ${MIN_INSTALL_MEMORY_LABEL} required`
    },
    {
      name: "Free disk",
      ok: freeDiskBytes >= MIN_INSTALL_FREE_DISK_BYTES,
      detail: `${formatGibibytes(freeDiskBytes)} GiB available; ${formatGibibytes(MIN_INSTALL_FREE_DISK_BYTES)} GiB required`
    }
  ];
}

export function createDefaultConfig({
  version,
  profile = "light",
  accessMode = "isolated",
  companionsEnabled = false
}) {
  assertVersion(version);
  if (profile !== "light" && profile !== "standard") {
    throw new Error("Default config requires a resolved light or standard profile.");
  }
  const resolvedAccessMode = resolveInstallAccessMode(accessMode);
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    version,
    previousVersion: null,
    bindHost: "127.0.0.1",
    port: 4911,
    telemetry: false,
    profile,
    accessMode: resolvedAccessMode,
    companionsEnabled,
    workspaces: []
  };
}

export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("SpaceApp config must be an object.");
  }
  for (const key of Object.keys(config)) {
    if (SECRET_FIELD.test(key)) {
      throw new Error(`SpaceApp config cannot contain secret field "${key}".`);
    }
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`Unsupported SpaceApp config field "${key}".`);
    }
  }
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`Unsupported SpaceApp config schema ${config.schemaVersion}.`);
  }
  assertVersion(config.version);
  if (config.previousVersion !== null) {
    assertVersion(config.previousVersion);
  }
  if (config.bindHost !== "127.0.0.1" && config.bindHost !== "0.0.0.0") {
    throw new Error("bindHost must be 127.0.0.1 or 0.0.0.0.");
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error("port must be an integer between 1024 and 65535.");
  }
  if (typeof config.telemetry !== "boolean") {
    throw new Error("telemetry must be boolean.");
  }
  if (!["light", "standard"].includes(config.profile)) {
    throw new Error("profile must be light or standard.");
  }
  if (config.accessMode !== "isolated" && config.accessMode !== "host-root") {
    throw new Error("accessMode must be isolated or host-root.");
  }
  if (typeof config.companionsEnabled !== "boolean") {
    throw new Error("companionsEnabled must be boolean.");
  }
  if (!Array.isArray(config.workspaces)) {
    throw new Error("workspaces must be an array.");
  }
  for (const workspace of config.workspaces) {
    validateWorkspace(workspace);
  }
  return config;
}

export async function saveConfig(root, config) {
  validateHome(root);
  validateConfig(config);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await atomicWrite(join(root, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

export async function loadConfig(root) {
  validateHome(root);
  const config = migrateConfig(JSON.parse(await readFile(join(root, "config.json"), "utf8")));
  return validateConfig(config);
}

function migrateConfig(config) {
  if (config?.schemaVersion === 2) {
    return {
      ...config,
      schemaVersion: CONFIG_SCHEMA_VERSION,
      accessMode: "isolated",
      companionsEnabled: false
    };
  }
  if (config?.schemaVersion !== 1) {
    return config;
  }
  const legacyProfiles = {
    core: "light",
    full: "standard"
  };
  return {
    ...config,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    profile: legacyProfiles[config.profile] ?? config.profile,
    accessMode: "isolated",
    companionsEnabled: false
  };
}

export async function addWorkspace(config, hostPath, { readOnly = false } = {}) {
  validateConfig(config);
  if (!isAbsolute(hostPath)) {
    throw new Error("Workspace path must be absolute.");
  }
  const absolutePath = resolve(hostPath);
  const pathStat = await stat(absolutePath);
  if (!pathStat.isDirectory()) {
    throw new Error("Workspace path must be an existing directory.");
  }
  if (config.workspaces.some((workspace) => workspace.hostPath === absolutePath)) {
    return structuredClone(config);
  }
  const name = normalizeWorkspaceName(basename(absolutePath));
  const suffix = createHash("sha256").update(absolutePath).digest("hex").slice(0, 8);
  const workspace = {
    id: `${name}-${suffix}`,
    name,
    hostPath: absolutePath,
    containerPath: `/workspaces/${name}`,
    readOnly: Boolean(readOnly)
  };
  return { ...structuredClone(config), workspaces: [...config.workspaces, workspace] };
}

export function removeWorkspace(config, identity) {
  validateConfig(config);
  const remaining = config.workspaces.filter(
    (workspace) => workspace.id !== identity && workspace.hostPath !== identity
  );
  if (remaining.length === config.workspaces.length) {
    throw new Error(`Workspace "${identity}" is not registered.`);
  }
  return { ...structuredClone(config), workspaces: remaining };
}

export function credentialProviders() {
  return {
    bundled: [...PROVIDERS.bundled],
    ownerInstalled: [...PROVIDERS.ownerInstalled],
    experimental: [...PROVIDERS.experimental]
  };
}

export async function writeCredential(root, provider, value) {
  assertProvider(provider);
  validateHome(root);
  const normalized = stripTrailingLineEndings(value);
  if (!normalized || normalized.includes("\0")) {
    throw new Error("Credential value cannot be empty or contain null bytes.");
  }
  const credentialsRoot = join(root, "secrets", "providers");
  await mkdir(credentialsRoot, { recursive: true, mode: 0o700 });
  const target = join(credentialsRoot, `${provider}.key`);
  await atomicWrite(target, normalized);
  return target;
}

export async function removeCredential(root, provider) {
  assertProvider(provider);
  validateHome(root);
  try {
    await rm(join(root, "secrets", "providers", `${provider}.key`));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function writeSetupToken(root, token) {
  validateHome(root);
  const normalized = stripTrailingLineEndings(token);
  if (normalized.length < 32 || normalized.length > 500 || /[\0\r\n]/.test(normalized)) {
    throw new Error("SpaceApp setup token must be 32-500 characters without line breaks.");
  }
  const target = join(root, "secrets", "setup-token");
  await atomicWrite(target, normalized);
  return target;
}

export function renderRuntimeEnv(config) {
  validateConfig(config);
  const settings = PROFILE_RUNTIME_SETTINGS[config.profile];
  return [
    `SPACEAPP_IMAGE_TAG=${safeEnv(config.version)}`,
    `SPACEAPP_BIND_HOST=${safeEnv(config.bindHost)}`,
    `SPACEAPP_PORT=${config.port}`,
    `SPACEAPP_TELEMETRY=${config.telemetry}`,
    `SPACEAPP_PROFILE=${safeEnv(config.profile)}`,
    `SPACEAPP_BROWSER_ENABLED=${settings.browserEnabled}`,
    `SPACEAPP_CORE_MEMORY_LIMIT=${settings.coreMemoryLimit}`,
    `SPACEAPP_CORE_CPU_LIMIT=${settings.coreCpuLimit}`,
    `SPACEAPP_CLI_MEMORY_LIMIT=${settings.cliMemoryLimit}`,
    `SPACEAPP_CLI_CPU_LIMIT=${settings.cliCpuLimit}`,
    `SPACEAPP_BROWSER_MEMORY_LIMIT=${settings.browserMemoryLimit}`,
    `SPACEAPP_BROWSER_CPU_LIMIT=${settings.browserCpuLimit}`,
    `SPACEAPP_POSTGRES_MEMORY_LIMIT=${settings.postgresMemoryLimit}`,
    `SPACEAPP_POSTGRES_CPU_LIMIT=${settings.postgresCpuLimit}`,
    `SPACEAPP_TEMPORAL_MEMORY_LIMIT=${settings.temporalMemoryLimit}`,
    `SPACEAPP_TEMPORAL_CPU_LIMIT=${settings.temporalCpuLimit}`,
    `SPACEAPP_COMPANIONS_ENABLED=${config.companionsEnabled ? "true" : "false"}`,
    ""
  ].join("\n");
}

export function renderWorkspaceCompose(config) {
  validateConfig(config);
  const mounts = config.workspaces.flatMap((workspace) => [
    "      - type: bind",
    `        source: ${JSON.stringify(workspace.hostPath)}`,
    `        target: ${JSON.stringify(workspace.containerPath)}`,
    `        read_only: ${workspace.readOnly}`
  ]);
  const service = mounts.length > 0
    ? ["    volumes:", ...mounts]
    : ["    volumes: []"];
  return [
    "services:",
    "  spaceapp-core:",
    ...service,
    "  spaceapp-cli:",
    ...service,
    ""
  ].join("\n");
}

export function renderHostAccessCompose(config) {
  validateConfig(config);
  if (config.accessMode === "isolated") {
    return "services: {}\n";
  }
  const hostMount = (readOnly) => [
    "      - type: bind",
    '        source: "/"',
    '        target: "/host"',
    `        read_only: ${readOnly}`,
    "        bind:",
    "          propagation: rslave"
  ];
  return [
    "services:",
    "  spaceapp-core:",
    "    environment:",
    '      SPACE_CLI_WORKSPACE_ROOT: "/host"',
    "    volumes:",
    ...hostMount(true),
    "  spaceapp-cli:",
    "    environment:",
    '      SPACEAPP_CLI_HOST_ROOT_ACCESS: "true"',
    "    volumes:",
    ...hostMount(false),
    ""
  ].join("\n");
}

export function composeCommand(action, root, options = {}) {
  validateHome(root);
  const stateRoot = options.stateRoot ?? root;
  validateHome(stateRoot);
  const profile = options.profile ?? "standard";
  if (profile !== "light" && profile !== "standard") {
    throw new Error("Compose profile must be light or standard.");
  }
  const base = [
    "compose",
    "--project-name", composeProjectName(root),
    "--project-directory", root,
    "--env-file", join(stateRoot, "runtime.env"),
    "-f", join(stateRoot, "compose.yml"),
    "-f", join(stateRoot, "compose.workspaces.yml"),
    "-f", join(stateRoot, "compose.host-access.yml"),
    ...(profile === "standard" ? ["--profile", "standard"] : []),
    ...(options.companionsEnabled ? ["--profile", "companions"] : [])
  ];
  const actions = {
    up: ["up", "-d", "--remove-orphans"],
    down: ["down"],
    status: ["ps"],
    logs: ["logs", "--tail", String(options.lines || 200)],
    pull: ["pull"],
    syncCredentials: ["up", "-d", "--no-deps", "--force-recreate", "spaceapp-cli"],
    installClaude: [
      "run",
      "--rm",
      "--no-deps",
      "--user",
      "10001:10001",
      "--entrypoint",
      "npm",
      "spaceapp-cli",
      "install",
      "--prefix",
      "/var/lib/spaceapp-cli/vendor/claude",
      "--no-audit",
      "--no-fund",
      "@anthropic-ai/claude-code@2.1.206"
    ],
    backup: ["exec", "-T", "--user", "0:0", "spaceapp-core", "node", "scripts/portable-backup.mjs"],
    stopForRestore: ["stop", "spaceapp-core", "spaceapp-cli", "spaceapp-browser"],
    resetOwnerPassword: [
      "exec",
      "-T",
      "--user",
      "10001:10001",
      "spaceapp-core",
      "node",
      "scripts/reset-owner-password.mjs",
      "--stdin"
    ],
    rotateOwnerSetupToken: [
      "exec",
      "-T",
      "--user",
      "10001:10001",
      "spaceapp-core",
      "node",
      "scripts/rotate-owner-setup-token.mjs",
      "--stdin"
    ],
    removeBrowser: ["rm", "--stop", "--force", "spaceapp-browser"],
    purge: ["down", "--volumes", "--remove-orphans"]
  };
  let selected = actions[action];
  if (action === "restore") {
    if (typeof options.backupId !== "string" || !BACKUP_ID_PATTERN.test(options.backupId)) {
      throw new Error("A valid SpaceApp backup id is required for restore.");
    }
    selected = [
      "run",
      "--rm",
      "--no-deps",
      "--user",
      "0:0",
      "--env",
      "SPACE_DATABASE_URL_FILE=/run/secrets/database-url",
      "--entrypoint",
      "node",
      "spaceapp-core",
      "scripts/portable-restore.mjs",
      "--input",
      "/backups",
      "--backup-id",
      options.backupId,
      "--confirm",
      "RESTORE"
    ];
  }
  if (!selected) {
    throw new Error(`Unsupported Compose action "${action}".`);
  }
  return { command: "docker", args: [...base, ...selected] };
}

export function composeProjectName(root) {
  validateHome(root);
  return `spaceapp-${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12)}`;
}

export async function selectLatestBackupId(root) {
  validateHome(root);
  const entries = await readdir(join(root, "backups"), { withFileTypes: true });
  const backupId = entries
    .filter((entry) => entry.isDirectory() && BACKUP_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (!backupId) {
    throw new Error(
      `No portable backup exists. Run "${UNIVERSAL_COMMAND} backup" before restore.`
    );
  }
  return backupId;
}

export async function writeRuntimeFiles(root, config) {
  validateHome(root);
  validateConfig(config);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await atomicWrite(join(root, "runtime.env"), renderRuntimeEnv(config));
  await atomicWrite(join(root, "compose.workspaces.yml"), renderWorkspaceCompose(config));
  await atomicWrite(join(root, "compose.host-access.yml"), renderHostAccessCompose(config));
}

export async function prepareInstallation(root, {
  version,
  profile,
  accessMode,
  companionsEnabled
}) {
  validateHome(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all([
    mkdir(join(root, "backups"), { recursive: true, mode: 0o700 }),
    mkdir(join(root, "secrets", "providers"), { recursive: true, mode: 0o700 })
  ]);
  const resolvedProfile = profile === undefined
    ? undefined
    : resolveInstallProfile(profile, totalmem());
  let config;
  try {
    config = await loadConfig(root);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    config = createDefaultConfig({
      version,
      profile: resolvedProfile ?? "light",
      accessMode: resolveInstallAccessMode(accessMode),
      companionsEnabled
    });
  }
  if (config.version !== version) {
    config = {
      ...config,
      version,
      previousVersion: config.version
    };
  }
  if (resolvedProfile !== undefined) {
    config = { ...config, profile: resolvedProfile };
  }
  const resolvedAccessMode = resolveInstallAccessMode(accessMode, config.accessMode);
  if (config.accessMode !== resolvedAccessMode) {
    config = { ...config, accessMode: resolvedAccessMode };
  }
  if (companionsEnabled !== undefined && config.companionsEnabled !== companionsEnabled) {
    config = { ...config, companionsEnabled };
  }
  validateConfig(config);

  const postgresPasswordPath = join(root, "secrets", "postgres-password");
  let postgresPassword;
  try {
    postgresPassword = (await readFile(postgresPasswordPath, "utf8")).trim();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    postgresPassword = randomBytes(32).toString("base64url");
    await atomicWrite(postgresPasswordPath, postgresPassword, CONTAINER_SECRET_MODE);
  }
  await ensureContainerSecretReadable(postgresPasswordPath);
  const databaseUrlPath = join(root, "secrets", "database-url");
  try {
    await stat(databaseUrlPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    const encodedPassword = encodeURIComponent(postgresPassword);
    await atomicWrite(
      databaseUrlPath,
      `postgresql://spaceapp:${encodedPassword}@postgres:5432/spaceapp`,
      CONTAINER_SECRET_MODE
    );
  }
  await ensureContainerSecretReadable(databaseUrlPath);

  const sessionSecretPath = join(root, "secrets", "session-secret");
  try {
    await stat(sessionSecretPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await atomicWrite(sessionSecretPath, randomBytes(48).toString("base64url"), CONTAINER_SECRET_MODE);
  }
  await ensureContainerSecretReadable(sessionSecretPath);

  const setupTokenPath = join(root, "secrets", "setup-token");
  let setupToken = null;
  try {
    await stat(setupTokenPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    setupToken = randomBytes(32).toString("base64url");
    await atomicWrite(setupTokenPath, setupToken, CONTAINER_SECRET_MODE);
  }
  await ensureContainerSecretReadable(setupTokenPath);
  return { config, setupToken };
}

export async function commitInstallation(root, config, {
  templateDir = defaultTemplateDir()
} = {}) {
  validateHome(root);
  validateConfig(config);
  const composeTemplate = await readFile(join(templateDir, "compose.yml"), "utf8");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await atomicWrite(join(root, "compose.yml"), composeTemplate);
  await writeRuntimeFiles(root, config);
  await saveConfig(root, config);
}

export async function initializeInstallation(root, options) {
  const result = await prepareInstallation(root, options);
  await commitInstallation(root, result.config, {
    templateDir: options.templateDir
  });
  return result;
}

function validateWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object") {
    throw new Error("Invalid workspace entry.");
  }
  if (!/^[a-z0-9._-]+-[a-f0-9]{8}$/.test(workspace.id)) {
    throw new Error("Invalid workspace id.");
  }
  if (!isAbsolute(workspace.hostPath) || !workspace.containerPath.startsWith("/workspaces/")) {
    throw new Error("Workspace paths must be absolute.");
  }
  if (typeof workspace.readOnly !== "boolean") {
    throw new Error("Workspace readOnly must be boolean.");
  }
}

function validateHome(root) {
  if (!root || !isAbsolute(root)) {
    throw new Error("SpaceApp home must be an absolute path.");
  }
}

function assertVersion(version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid SpaceApp version "${version}".`);
  }
}

function assertProvider(provider) {
  if (!ALL_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported credential provider "${provider}".`);
  }
}

function safeEnv(value) {
  if (String(value).includes("\n") || String(value).includes("\r")) {
    throw new Error("Runtime settings cannot contain newlines.");
  }
  return String(value);
}

function formatGibibytes(bytes) {
  return Math.floor((bytes / 1024 ** 3) * 10) / 10;
}

async function atomicWrite(target, value, mode = 0o600) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, value, { encoding: "utf8", mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, target);
    await chmod(target, mode);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function ensureContainerSecretReadable(path) {
  if (process.platform === "win32") {
    return;
  }
  await chmod(path, CONTAINER_SECRET_MODE).catch((error) => {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  });
}

function defaultTemplateDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../templates");
}
