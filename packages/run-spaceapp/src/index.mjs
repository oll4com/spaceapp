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
import { imageVerificationOff, verifyLockedImages } from "./image-attestations.mjs";
import { IMAGE_TARGETS, imageDigestEnv, PACKAGE_IMAGE_LOCK, parseRecordedDigests } from "./image-lock.mjs";

const CONFIG_SCHEMA_VERSION = 4;
const CONTAINER_SECRET_MODE = 0o644;
export const MIN_INSTALL_FREE_DISK_BYTES_STANDARD = 15 * 1024 ** 3;
export const MIN_INSTALL_FREE_DISK_BYTES_LIGHT = 7 * 1024 ** 3;
export const MIN_INSTALL_FREE_DISK_BYTES = MIN_INSTALL_FREE_DISK_BYTES_STANDARD;
const PROFILE_RUNTIME_SETTINGS = Object.freeze({
  small: Object.freeze({
    browserEnabled: false, temporalEnabled: false,
    coreMemoryLimit: "2g", coreCpuLimit: "2.0",
    cliMemoryLimit: "2g", cliCpuLimit: "1.5",
    browserMemoryLimit: "1536m", browserCpuLimit: "1.5",
    postgresMemoryLimit: "768m", postgresCpuLimit: "1.0",
    temporalMemoryLimit: "768m", temporalCpuLimit: "1.0"
  }),
  medium: Object.freeze({
    browserEnabled: false, temporalEnabled: true,
    coreMemoryLimit: "3g", coreCpuLimit: "3.0",
    cliMemoryLimit: "3g", cliCpuLimit: "2.0",
    browserMemoryLimit: "1536m", browserCpuLimit: "1.5",
    postgresMemoryLimit: "1g", postgresCpuLimit: "1.0",
    temporalMemoryLimit: "768m", temporalCpuLimit: "1.0"
  }),
  large: Object.freeze({
    browserEnabled: true, temporalEnabled: true,
    coreMemoryLimit: "4g", coreCpuLimit: "4.0",
    cliMemoryLimit: "4g", cliCpuLimit: "3.0",
    browserMemoryLimit: "2g", browserCpuLimit: "2.0",
    postgresMemoryLimit: "1g", postgresCpuLimit: "2.0",
    temporalMemoryLimit: "1g", temporalCpuLimit: "2.0"
  }),
  light: Object.freeze({
    browserEnabled: false,
    temporalEnabled: true,
    coreMemoryLimit: "2g",
    coreCpuLimit: "2.0",
    cliMemoryLimit: "2g",
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
    temporalEnabled: true,
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
export const INSTALL_PROFILES = Object.freeze(["small", "medium", "large", "light", "standard"]);
export const PROFILE_REQUIREMENTS = Object.freeze({
  small: { cpuCount: 4, memoryBytes: 7 * 1024 ** 3, freshDiskBytes: 6.5 * 1024 ** 3 },
  medium: { cpuCount: 4, memoryBytes: 11 * 1024 ** 3, freshDiskBytes: 8 * 1024 ** 3 },
  large: { cpuCount: 8, memoryBytes: 15 * 1024 ** 3, freshDiskBytes: 11 * 1024 ** 3 },
  // Existing installations keep their settings and background integrations.
  light: { cpuCount: 4, memoryBytes: 7 * 1024 ** 3, freshDiskBytes: 8 * 1024 ** 3 },
  standard: { cpuCount: 4, memoryBytes: 7 * 1024 ** 3, freshDiskBytes: 11 * 1024 ** 3 }
});

export function profileRuntimeSettings(profile) {
  const settings = PROFILE_RUNTIME_SETTINGS[profile];
  if (!settings) throw new Error("Install profile must be small, medium, large, light, or standard.");
  return settings;
}
const SECRET_FIELD = /password|secret|token|api.?key|credential/i;
// provider install claude: an image with provider lockfiles reinstalls Claude Code from its lockfile (review INT5-C-F14).
// Older runtime images approve Claude Code's postinstall (its native binary) for exactly the pinned version in the vendor
// project's package.json allowScripts, then install with npm. $1 is the package; npm 11 refuses --allow-scripts for an
// install with --prefix.
const CLAUDE_INSTALL_SCRIPT = [
  "[ ! -f /app/deploy/docker/provider-locks/claude.json ] || exec node /app/deploy/docker/provider-install.mjs claude --reinstall; ",
  "node -e 'const fs=require(\"fs\");const dir=\"/var/lib/spaceapp-cli/vendor/claude\";const file=dir+\"/package.json\";",
  "let manifest={private:true};try{manifest=JSON.parse(fs.readFileSync(file,\"utf8\"))}catch{}",
  "manifest.allowScripts={...manifest.allowScripts,[process.argv[1]]:true};fs.mkdirSync(dir,{recursive:true});",
  "fs.writeFileSync(file,JSON.stringify(manifest,null,2)+\"\\n\")' \"$1\"",
  " && exec npm install --prefix /var/lib/spaceapp-cli/vendor/claude --no-audit --no-fund \"$1\""
].join("");
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const BACKUP_ID_PATTERN = /^spaceapp-backup-\d{8}T\d{9}Z$/;
const PROVIDERS = Object.freeze({
  bundled: Object.freeze(["opencode"]),
  ownerInstalled: Object.freeze(["codex", "gemini", "qwen", "kimi", "grok", "autohand", "cursor", "copilot", "claude"]),
  experimental: Object.freeze(["deepseek"])
});
const ALL_PROVIDERS = new Set(Object.values(PROVIDERS).flat());
export const CLI_SETTINGS_FILES = Object.freeze([
  "claude/settings.json", "claude/.claude.json", "codex/config.toml", "opencode/config/opencode/opencode.json"
]);
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
  "companionsEnabled",
  "optionalModules",
  "installId",
  "users"
]);

// Multi-user (SpaceApp accounts with SPACE_MULTI_USER_ENABLED): every user's CLIs run in their own container, with
// their own keys, logins, memory and workspaces; the core starts each pane in its owner's container.
const USER_ID_PATTERN = /^user:[A-Za-z0-9_-]{1,80}$/;
const MEMORY_LIMIT_PATTERN = /^[1-9]\d{0,5}[mg]$/;

// Optional SpaceApp modules (games, copilots, channels, ...): "all", "none" or a comma list.
// A config written before 1.1.5 has no field and keeps every module; new installs start with none.
const OPTIONAL_MODULES_PATTERN = /^(?:all|none|[a-z][a-z-]*(?:,[a-z][a-z-]*)*)$/;

export const SPACEAPP_UPGRADE_POLICY = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  minSupportedSourceVersion: "0.1.10",
  preserveRecreateSourceVersions: Object.freeze([]),
  rollbackCapable: true
});

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

export function resolveInstallProfile(requestedProfile, resources) {
  if (INSTALL_PROFILES.includes(requestedProfile)) {
    return requestedProfile;
  }
  if (requestedProfile !== "auto") {
    throw new Error("Install profile must be auto, small, medium, large, light, or standard.");
  }
  const totalMemoryBytes = typeof resources === "number" ? resources : resources?.totalMemoryBytes;
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    throw new Error("Total system memory must be available for automatic profile selection.");
  }
  // Memory-only callers cannot safely choose a larger footprint.
  if (typeof resources === "number") return "small";
  for (const profile of ["large", "medium", "small"]) {
    if (installResourceChecks(resources, profile).every((check) => check.ok)) return profile;
  }
  return "small";
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

export function versionTuple(version) {
  if (typeof version !== "string") {
    return null;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a, b) {
  const aTuple = versionTuple(a);
  const bTuple = versionTuple(b);
  if (!aTuple || !bTuple) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (aTuple[index] !== bTuple[index]) {
      return aTuple[index] < bTuple[index] ? -1 : 1;
    }
  }
  return 0;
}

export function upgradePath(sourceVersion, targetVersion) {
  if (sourceVersion === null || sourceVersion === undefined) {
    return "fresh";
  }
  if (sourceVersion === targetVersion) {
    return "same";
  }
  const comparison = compareVersions(sourceVersion, targetVersion);
  if (comparison === null) {
    return "unknown";
  }
  if (comparison > 0) {
    return "downgrade";
  }
  const minimum = compareVersions(sourceVersion, SPACEAPP_UPGRADE_POLICY.minSupportedSourceVersion);
  if (minimum === null || minimum < 0) {
    return "unsupported";
  }
  if (SPACEAPP_UPGRADE_POLICY.preserveRecreateSourceVersions.includes(sourceVersion)) {
    return "preserve-recreate";
  }
  return "update";
}

export async function inspectSystemResources(root) {
  validateHome(root);
  // Stat the nearest existing ancestor: on a clean Linux home the install
  // root's parent (~/.config) may not exist yet, and statfs on a missing
  // path throws ENOENT. Walking up guarantees a real mount point for the
  // free-disk measurement.
  let target = root;
  for (;;) {
    try {
      await stat(target);
      break;
    } catch {
      const parent = dirname(target);
      if (parent === target) {
        break;
      }
      target = parent;
    }
  }
  const fileSystem = await statfs(target);
  return {
    cpuCount: availableParallelism(),
    totalMemoryBytes: totalmem(),
    freeDiskBytes: Number(fileSystem.bavail) * Number(fileSystem.bsize)
  };
}

export function installResourceChecks(resources, profile = "small", { requiredDiskBytes, operation = "fresh" } = {}) {
  const cpuCount = Number(resources?.cpuCount);
  const totalMemoryBytes = Number(resources?.totalMemoryBytes);
  const freeDiskBytes = Number(resources?.freeDiskBytes);
  if (![cpuCount, totalMemoryBytes, freeDiskBytes].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("System CPU, memory, and free-disk information is required.");
  }
  const requirements = PROFILE_REQUIREMENTS[profile];
  if (!requirements) throw new Error("Unknown installation profile.");
  const minFreeDisk = requiredDiskBytes ?? (operation === "fresh" ? requirements.freshDiskBytes : 512 * 1024 ** 2);
  const engineMemoryBytes = { small: 3, medium: 5, large: 7, light: 3, standard: 3 }[profile] * 1024 ** 3;
  return [
    {
      name: "CPU",
      ok: cpuCount >= requirements.cpuCount,
      detail: `${cpuCount} available; ${requirements.cpuCount} required`
    },
    {
      name: "Memory",
      ok: totalMemoryBytes >= requirements.memoryBytes,
      detail: `${formatGibibytes(totalMemoryBytes)} GiB available; ${formatGibibytes(requirements.memoryBytes)} GiB usable${requirements.memoryBytes === 7 * 1024 ** 3 ? " (8 GB-class system)" : ""} required`
    },
    {
      name: "Free disk",
      ok: freeDiskBytes >= minFreeDisk,
      detail: `${formatGibibytes(freeDiskBytes)} GiB available; ${formatGibibytes(minFreeDisk)} GiB required${operation === "fresh" ? "" : " additionally for " + operation}`
    },
    ...(resources.engineMemoryBytes > 0 ? [{ name: "Docker memory", ok: resources.engineMemoryBytes >= engineMemoryBytes,
      detail: `${formatGibibytes(resources.engineMemoryBytes)} GiB allocated; ${formatGibibytes(engineMemoryBytes)} GiB required for ${profile}` }] : []),
    ...(resources.engineCpuCount > 0 ? [{ name: "Docker CPU", ok: resources.engineCpuCount >= 4,
      detail: `${resources.engineCpuCount} allocated; 4 required` }] : [])
  ];
}

export function createDefaultConfig({
  version,
  profile = "light",
  accessMode = "isolated",
  companionsEnabled = false
}) {
  assertVersion(version);
  if (!INSTALL_PROFILES.includes(profile)) {
    throw new Error("Default config requires a resolved installation profile.");
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
    optionalModules: "none",
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
  if (!INSTALL_PROFILES.includes(config.profile)) {
    throw new Error("profile must be small, medium, large, light, or standard.");
  }
  if (config.accessMode !== "isolated" && config.accessMode !== "host-root") {
    throw new Error("accessMode must be isolated or host-root.");
  }
  if (typeof config.companionsEnabled !== "boolean") {
    throw new Error("companionsEnabled must be boolean.");
  }
  if (config.optionalModules !== undefined && !OPTIONAL_MODULES_PATTERN.test(config.optionalModules)) {
    throw new Error("optionalModules must be all, none or a comma-separated list of module names.");
  }
  // Optional: only installations whose owner said Yes to telemetry have one.
  if (config.installId !== undefined && (typeof config.installId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(config.installId))) {
    throw new Error("installId must be 8-64 letters, digits, '-' or '_'.");
  }
  if (!Array.isArray(config.workspaces)) {
    throw new Error("workspaces must be an array.");
  }
  for (const workspace of config.workspaces) {
    validateWorkspace(workspace);
  }
  if (config.users !== undefined) {
    if (!Array.isArray(config.users)) throw new Error("users must be an array.");
    // host-root would let every user's agent read the whole host, other users' keys included.
    if (config.users.length > 0 && config.accessMode !== "isolated") throw new Error("Installations with users must use isolated access.");
    const ids = new Set();
    for (const user of config.users) {
      if (!user || typeof user !== "object" || !USER_ID_PATTERN.test(user.id) || ids.has(user.id)) throw new Error("Invalid or repeated user id.");
      ids.add(user.id);
      if (user.memoryLimit !== undefined && !MEMORY_LIMIT_PATTERN.test(user.memoryLimit)) throw new Error("A user's memory limit looks like 2g or 1536m.");
      if (!Array.isArray(user.workspaces)) throw new Error("A user's workspaces must be an array.");
      for (const workspace of user.workspaces) validateWorkspace(workspace);
    }
  }
  return config;
}

/** A compose-safe name for a user's container and volumes; the hash keeps ids that differ only in case apart. */
export function userSlug(userId) {
  if (!USER_ID_PATTERN.test(userId)) throw new Error(`Invalid SpaceApp user id "${userId}".`);
  const name = userId.slice("user:".length).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "user";
  return `${name}-${createHash("sha256").update(userId).digest("hex").slice(0, 6)}`;
}

export function addUser(config, userId, { memoryLimit } = {}) {
  validateConfig(config);
  userSlug(userId);
  if (config.accessMode !== "isolated") throw new Error("Users need isolated access: host-root lets every agent read the whole host.");
  if ((config.users ?? []).some((user) => user.id === userId)) return structuredClone(config);
  const user = { id: userId, ...(memoryLimit ? { memoryLimit } : {}), workspaces: [] };
  return validateConfig({ ...structuredClone(config), users: [...(config.users ?? []), user] });
}

export function removeUser(config, userId) {
  validateConfig(config);
  const users = (config.users ?? []).filter((user) => user.id !== userId);
  if (users.length === (config.users ?? []).length) throw new Error(`User "${userId}" is not registered.`);
  return { ...structuredClone(config), users };
}

function userOf(config, userId) {
  const user = (config.users ?? []).find((candidate) => candidate.id === userId);
  if (!user) throw new Error(`User "${userId}" is not registered: run "${UNIVERSAL_COMMAND} user add ${userId}" first.`);
  return user;
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
  if (config?.schemaVersion === 3) {
    return {
      ...config,
      schemaVersion: CONFIG_SCHEMA_VERSION,
      ...(config.companionsEnabled === undefined ? { companionsEnabled: false } : {})
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

export function planConfigRepairs(rawConfig) {
  const actions = [];
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    return { actions };
  }
  const schema = rawConfig.schemaVersion;
  if (schema === 1 || schema === 2) {
    actions.push({
      type: "migrate-legacy-schema",
      from: schema,
      to: CONFIG_SCHEMA_VERSION,
      detail: `Config schema ${schema} will be migrated to schema ${CONFIG_SCHEMA_VERSION}.`
    });
    return { actions };
  }
  if (schema === 3) {
    if (rawConfig.companionsEnabled === undefined) {
      actions.push({
        type: "default-companions",
        detail: "companionsEnabled is missing and will default to false."
      });
    } else if (
      typeof rawConfig.companionsEnabled === "string" &&
      (rawConfig.companionsEnabled === "true" || rawConfig.companionsEnabled === "false")
    ) {
      actions.push({
        type: "convert-companions-string",
        value: rawConfig.companionsEnabled,
        detail: `companionsEnabled is the string "${rawConfig.companionsEnabled}" and will be converted to the boolean ${rawConfig.companionsEnabled === "true"}.`
      });
    } else if (typeof rawConfig.companionsEnabled !== "boolean") {
      actions.push({
        type: "reject-companions",
        detail: "companionsEnabled has an unsupported value and cannot be repaired automatically."
      });
    }
  }
  return { actions };
}

export function applyConfigRepairs(rawConfig) {
  const { actions } = planConfigRepairs(rawConfig);
  const rejected = actions.find((action) => action.type === "reject-companions");
  if (rejected) {
    throw new Error(rejected.detail);
  }
  let repaired = migrateConfig(structuredClone(rawConfig));
  const convert = actions.find((action) => action.type === "convert-companions-string");
  if (convert) {
    repaired = { ...repaired, companionsEnabled: convert.value === "true" };
  }
  return validateConfig(repaired);
}

export async function addWorkspace(config, hostPath, { readOnly = false, userId } = {}) {
  validateConfig(config);
  if (userId) {
    // A user's workspace is mounted only into that user's container.
    const user = userOf(config, userId);
    const added = await addWorkspace({ ...structuredClone(config), users: undefined, workspaces: user.workspaces }, hostPath, { readOnly });
    return { ...structuredClone(config), users: config.users.map((candidate) => candidate.id === userId ? { ...candidate, workspaces: added.workspaces } : candidate) };
  }
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
  // Two folders with the same name must not share one container path; the second one gets the id suffix.
  const taken = config.workspaces.some((workspace) => workspace.containerPath === `/workspaces/${name}`);
  const workspace = {
    id: `${name}-${suffix}`,
    name,
    hostPath: absolutePath,
    containerPath: taken ? `/workspaces/${name}-${suffix}` : `/workspaces/${name}`,
    readOnly: Boolean(readOnly)
  };
  return { ...structuredClone(config), workspaces: [...config.workspaces, workspace] };
}

export function removeWorkspace(config, identity, { userId } = {}) {
  validateConfig(config);
  if (userId) {
    const user = userOf(config, userId);
    const removed = removeWorkspace({ ...structuredClone(config), users: undefined, workspaces: user.workspaces }, identity);
    return { ...structuredClone(config), users: config.users.map((candidate) => candidate.id === userId ? { ...candidate, workspaces: removed.workspaces } : candidate) };
  }
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

/** Where a provider key lives: the default CLI container's, or one user's. */
function providerSecretsRoot(root, userId) {
  return userId ? join(root, "secrets", "users", userSlug(userId), "providers") : join(root, "secrets", "providers");
}

export async function writeCredential(root, provider, value, { userId } = {}) {
  assertProvider(provider);
  validateHome(root);
  const normalized = stripTrailingLineEndings(value);
  if (!normalized || normalized.includes("\0")) {
    throw new Error("Credential value cannot be empty or contain null bytes.");
  }
  const credentialsRoot = providerSecretsRoot(root, userId);
  await mkdir(credentialsRoot, { recursive: true, mode: 0o700 });
  const target = join(credentialsRoot, `${provider}.key`);
  await atomicWrite(target, normalized);
  return target;
}

export async function removeCredential(root, provider, { userId } = {}) {
  assertProvider(provider);
  validateHome(root);
  try {
    await rm(join(providerSecretsRoot(root, userId), `${provider}.key`));
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

export function renderRuntimeEnv(config, imageLock = PACKAGE_IMAGE_LOCK, recordedDigests = {}) {
  validateConfig(config);
  const settings = PROFILE_RUNTIME_SETTINGS[config.profile];
  return [
    `SPACEAPP_IMAGE_TAG=${safeEnv(config.version)}`,
    ...imageDigestEnv(config.version, imageLock, recordedDigests),
    `SPACEAPP_BIND_HOST=${safeEnv(config.bindHost)}`,
    `SPACEAPP_PORT=${config.port}`,
    `SPACEAPP_TELEMETRY=${config.telemetry}`,
    `SPACEAPP_INSTALL_ID=${config.installId ?? ""}`,
    `SPACEAPP_PROFILE=${safeEnv(config.profile)}`,
    `SPACEAPP_BROWSER_ENABLED=${settings.browserEnabled}`,
    `SPACEAPP_WORKFLOWS_ENABLED=${settings.temporalEnabled}`,
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
    `SPACEAPP_OPTIONAL_MODULES=${config.optionalModules ?? "all"}`,
    ""
  ].join("\n");
}

/**
 * Codex sandboxes each command with bubblewrap, which needs unprivileged user namespaces (pilot finding F17). Docker
 * Desktop's VM allows them; on Linux the host decides, and Ubuntu 23.10 and later restrict them through AppArmor.
 * shortcut: a Linux host running Docker Desktop is judged by the host's own settings; upgrade if such installs appear.
 */
export async function userNamespacesUsable(platform = process.platform, read = (path) => readFile(path, "utf8")) {
  if (platform !== "linux") return true;
  const value = async (path) => (await read(path).catch(() => ""))?.trim();
  if (await value("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1") return false;
  if (await value("/proc/sys/kernel/unprivileged_userns_clone") === "0") return false;
  return await value("/proc/sys/user/max_user_namespaces") !== "0";
}

// Docker's default seccomp profile plus user namespaces, and no AppArmor profile (docker-default denies the namespace
// mounts). Only where the sandbox can run: elsewhere it would widen the container for nothing.
const CLI_SANDBOX_OPTIONS = ["    security_opt:", "      - seccomp=./seccomp-cli.json", "      - apparmor=unconfined"];

export function renderWorkspaceCompose(config, { cliSandbox = false } = {}) {
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
  if (config.users === undefined) {
    return ["services:", "  spaceapp-core:", ...service, "  spaceapp-cli:", ...service, ...(cliSandbox ? CLI_SANDBOX_OPTIONS : []), ""].join("\n");
  }
  // "user enable": accounts are on, and the core starts a USER's CLIs only in that user's own container.
  const users = config.users;
  const settings = profileRuntimeSettings(config.profile);
  const bind = (workspace) => [
    "      - type: bind",
    `        source: ${JSON.stringify(workspace.hostPath)}`,
    `        target: ${JSON.stringify(workspace.containerPath)}`,
    `        read_only: ${workspace.readOnly}`
  ];
  const userServices = users.flatMap((user) => {
    const slug = userSlug(user.id);
    return [
      `  spaceapp-cli-${slug}:`,
      // The owner's pinned CLI image (runtime.env sets the digest; 1.1.7 review: a moved tag cannot change a user's).
      "    image: ghcr.io/oll4com/spaceapp-cli:${SPACEAPP_IMAGE_TAG}${SPACEAPP_CLI_IMAGE_DIGEST:-}",
      "    restart: unless-stopped",
      "    init: true",
      "    security_opt:",
      "      - no-new-privileges:true",
      ...(cliSandbox ? CLI_SANDBOX_OPTIONS.slice(1) : []),
      `    mem_limit: "${user.memoryLimit ?? settings.cliMemoryLimit}"`,
      "    cpus: \"${SPACEAPP_CLI_CPU_LIMIT}\"",
      "    environment:",
      '      SPACE_PUBLIC_DISTRIBUTION: "true"',
      "      SPACE_MEMORY_ROOT: /var/lib/spaceapp/memory",
      "      SPACE_CLI_HOST_SOCKET: /run/spaceapp-cli/host.sock",
      "    volumes:",
      `      - spaceapp-cli-state-${slug}:/var/lib/spaceapp-cli`,
      `      - spaceapp-memory-${slug}:/var/lib/spaceapp/memory`,
      `      - spaceapp-cli-socket-${slug}:/run/spaceapp-cli`,
      `      - spaceapp-workspaces-${slug}:/workspaces`,
      `      - ./secrets/users/${slug}/providers:/run/spaceapp-secrets/providers:ro`,
      ...user.workspaces.flatMap(bind),
      // Its own network: internet only, never the owner's internal services (temporal, companions) or other users.
      "    networks:",
      `      - spaceapp-user-${slug}`
    ];
  });
  return [
    "services:",
    "  spaceapp-core:",
    "    environment:",
    '      SPACE_MULTI_USER_ENABLED: "true"',
    "      SPACE_CLI_HOST_SOCKETS_FILE: /etc/spaceapp/cli-hosts.json",
    "    volumes:",
    ...(mounts.length > 0 ? mounts : []),
    "      - ./cli-hosts.json:/etc/spaceapp/cli-hosts.json:ro",
    ...users.map((user) => `      - spaceapp-cli-socket-${userSlug(user.id)}:/run/spaceapp-cli-users/${userSlug(user.id)}`),
    "  spaceapp-cli:",
    ...service,
    ...(cliSandbox ? CLI_SANDBOX_OPTIONS : []),
    ...userServices,
    ...(users.length > 0 ? ["volumes:"] : []),
    ...users.flatMap((user) => ["cli-state", "memory", "cli-socket", "workspaces"].map((kind) => `  spaceapp-${kind}-${userSlug(user.id)}: {}`)),
    ...(users.length > 0 ? ["networks:"] : []),
    ...users.map((user) => `  spaceapp-user-${userSlug(user.id)}: {}`),
    ""
  ].join("\n");
}

/** The core's map of each user to the pane host socket of their container (SPACE_CLI_HOST_SOCKETS_FILE). */
export function renderCliHosts(config) {
  validateConfig(config);
  return `${JSON.stringify(Object.fromEntries((config.users ?? []).map((user) =>
    [user.id, `/run/spaceapp-cli-users/${userSlug(user.id)}/host.sock`])), null, 2)}\n`;
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
  const settings = profileRuntimeSettings(profile);
  const base = [
    "compose",
    "--project-name", composeProjectName(root),
    "--project-directory", root,
    "--env-file", join(stateRoot, "runtime.env"),
    "-f", join(stateRoot, "compose.yml"),
    "-f", join(stateRoot, "compose.workspaces.yml"),
    "-f", join(stateRoot, "compose.host-access.yml"),
    ...(settings.browserEnabled ? ["--profile", "standard"] : []),
    ...(settings.temporalEnabled ? ["--profile", "workflows"] : []),
    ...(options.companionsEnabled ? ["--profile", "companions"] : [])
  ];
  const actions = {
    up: ["up", "-d", "--remove-orphans"],
    down: ["down"],
    status: ["ps"],
    logs: ["logs", "--tail", String(options.lines || 200)],
    pull: ["pull"],
    syncCredentials: ["up", "-d", "--no-deps", "--force-recreate", options.service ?? "spaceapp-cli"],
    // Workspace bind mounts belong to these two services; compose recreates them only when the mounts changed.
    syncWorkspaces: ["up", "-d", "spaceapp-core", "spaceapp-cli"],
    // The CLIs' own settings (MCP servers, base URLs), never their logins: these files hold no credentials.
    exportCliSettings: ["exec", "-T", "--user", "10001:10001", options.service ?? "spaceapp-cli", "sh", "-c",
      // No settings file yet (a fresh install): exit 3 without tar's "Cowardly refusing to create an empty archive" (1.1.8).
      `cd /var/lib/spaceapp-cli/providers && files=$(ls -d ${CLI_SETTINGS_FILES.join(" ")} 2>/dev/null); [ -n "$files" ] || exit 3; tar -czf - $files`],
    importCliSettings: ["exec", "-T", "--user", "10001:10001", options.service ?? "spaceapp-cli", "tar", "-C", "/var/lib/spaceapp-cli/providers", "-xzf", "-"],
    // The CLI host answers on its socket (a user's container is ready only then, not when Docker starts it).
    cliHostReady: ["exec", "-T", "--user", "10001:10001", options.service ?? "spaceapp-cli", "node", "-e",
      "require('node:net').connect('/run/spaceapp-cli/host.sock').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"],
    // A user's own Space Memory lives only in their CLI container (the owner's is in the core's portable backup).
    exportMemory: ["exec", "-T", "--user", "10001:10001", options.service ?? "spaceapp-cli", "tar", "-C", "/var/lib/spaceapp/memory", "-czf", "-", "."],
    importMemory: ["exec", "-T", "--user", "10001:10001", options.service ?? "spaceapp-cli", "tar", "-C", "/var/lib/spaceapp/memory", "-xzf", "-"],
    installClaude: [
      "run",
      "--rm",
      "--no-deps",
      "--user",
      "10001:10001",
      "--entrypoint",
      "sh",
      options.service ?? "spaceapp-cli",
      "-c",
      CLAUDE_INSTALL_SCRIPT,
      "sh",
      "@anthropic-ai/claude-code@2.1.301"
    ],
    // The backup runs in a one-off container while the writers are paused (backupWithWritersPaused in cli.mjs).
    backup: [
      "run", "--rm", "--no-deps", "--user", "0:0",
      "--env", "SPACE_DATABASE_URL_FILE=/run/secrets/database-url",
      "--entrypoint", "node", "spaceapp-core", "scripts/portable-backup.mjs"
    ],
    pauseWriters: ["pause", "spaceapp-core", "spaceapp-cli", "spaceapp-browser", "temporal"],
    unpauseWriters: ["unpause", "spaceapp-core", "spaceapp-cli", "spaceapp-browser", "temporal"],
    stopForRestore: ["stop", "spaceapp-core", "spaceapp-cli", "spaceapp-browser"],
    stopForPortableRestore: ["stop", "spaceapp-core", "spaceapp-cli", "spaceapp-browser", "temporal"],
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
    removeTemporal: ["rm", "--stop", "--force", "temporal"],
    enableTemporal: ["up", "-d", "--force-recreate", "temporal"],
    databaseSize: ["exec", "-T", "postgres", "psql", "-U", "spaceapp", "-d", "spaceapp", "-Atc", "SELECT pg_database_size(current_database())"],
    storageFree: ["exec", "-T", "spaceapp-core", "node", "-e", "const fs=require('node:fs');const s=fs.statfsSync('/var/lib/spaceapp');console.log(Number(s.bavail)*Number(s.bsize))"],
    purge: ["down", "--volumes", "--remove-orphans"],
    repair: ["up", "-d", "--remove-orphans", "--force-recreate"],
    ensureCheckpointDatabase: ["up", "-d", "--no-deps", "--wait", "--wait-timeout", "120", "postgres"],
    checkpointDump: ["exec", "-T", "postgres", "pg_dump", "-c", "--if-exists", "-U", "spaceapp", "-d", "spaceapp"],
    checkpointRestore: ["exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "spaceapp", "-d", "spaceapp"]
  };
  if (action === "installProvider") {
    assertProvider(options.provider);
    actions.installProvider = ["exec", "-T", "--user", "10001:10001", options.service ?? "spaceapp-cli", "node", "/app/deploy/docker/provider-install.mjs", options.provider];
  }
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

// mkdir keeps the mode of a secrets folder that already existed; the 0644 container secrets inside rely on it being
// owner-only (review INT5-C-F21), so install, init and every command that writes the runtime files tighten it.
// Windows has no POSIX modes.
async function ensureOwnerOnlySecrets(root) {
  if (process.platform === "win32") return;
  const secrets = join(root, "secrets");
  const info = await stat(secrets).catch(() => null);
  if (info && (info.mode & 0o077) !== 0) await chmod(secrets, 0o700);
}

/** The image digests this installation recorded per runtime version (image-digests.json). */
export async function readRecordedDigests(root) {
  return parseRecordedDigests(await readFile(join(root, "image-digests.json"), "utf8").catch(() => "{}"));
}

export async function writeRuntimeFiles(root, config, imageLock = PACKAGE_IMAGE_LOCK, verifyImages = verifyLockedImages) {
  validateHome(root);
  validateConfig(config);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await ensureOwnerOnlySecrets(root);
  // Each runtime version a locked package installs keeps its digests, for a later rollback to it.
  const recorded = await readRecordedDigests(root);
  if (imageLock && imageLock.runtimeVersion === config.version) {
    // Until a locked version's images have checked out here (image-attestations.mjs), every run verifies them first; the
    // evidence names the run and public commit that built the bytes this installation runs. With the opt-out the
    // version is recorded as unverified, and is verified on the first run without it.
    const attestations = await readFile(join(root, "image-attestations.json"), "utf8").then(JSON.parse).catch(() => ({}));
    const verified = IMAGE_TARGETS.every((target) => attestations?.[config.version]?.images?.[target]?.index === imageLock.images[target]);
    if (!verified && !(imageVerificationOff() && attestations?.[config.version]?.skipped)) {
      const evidence = imageVerificationOff()
        ? { runtimeVersion: config.version, skipped: "SPACEAPP_IMAGE_VERIFY=off", at: new Date().toISOString() }
        : await verifyImages(imageLock);
      await atomicWrite(join(root, "image-attestations.json"), `${JSON.stringify({ ...attestations, [config.version]: evidence }, null, 2)}\n`, 0o644);
    }
    if (JSON.stringify(recorded[config.version]) !== JSON.stringify(imageLock.images)) {
      recorded[config.version] = { ...imageLock.images };
      await atomicWrite(join(root, "image-digests.json"), `${JSON.stringify(recorded, null, 2)}\n`, 0o644);
    }
  }
  await atomicWrite(join(root, "runtime.env"), renderRuntimeEnv(config, imageLock, recorded));
  await atomicWrite(join(root, "compose.workspaces.yml"), renderWorkspaceCompose(config, { cliSandbox: await userNamespacesUsable() }));
  // The core reads it as uid 10001 through a read-only bind mount.
  await atomicWrite(join(root, "cli-hosts.json"), renderCliHosts(config), 0o644);
  for (const user of config.users ?? []) await mkdir(providerSecretsRoot(root, user.id), { recursive: true, mode: 0o700 });
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
  await ensureOwnerOnlySecrets(root);
  const resolvedProfile = profile === undefined
    ? undefined
    : resolveInstallProfile(profile, profile === "auto" ? await inspectSystemResources(root) : totalmem());
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
  templateDir = defaultTemplateDir(),
  persistConfig = true,
  // Compose resolves ./seccomp-cli.json against the project directory, also when the compose files are staged.
  projectRoot = root
} = {}) {
  validateHome(root);
  validateConfig(config);
  const composeTemplate = await readFile(join(templateDir, "compose.yml"), "utf8");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await atomicWrite(join(root, "compose.yml"), composeTemplate);
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  await atomicWrite(join(projectRoot, "seccomp-cli.json"), await readFile(join(defaultTemplateDir(), "seccomp-cli.json"), "utf8"));
  await writeRuntimeFiles(root, config);
  if (persistConfig) await saveConfig(root, config);
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
