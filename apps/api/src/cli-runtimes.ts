import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  agentRuntimeRegistrySchema,
  agentRuntimeSchema,
  isAgentRuntimeReady,
  type AgentRuntime,
  type AgentRuntimeRegistry
} from "@space/contracts";
import { nowIso } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import { cliRuntimeDescriptors, type CliRuntimeDescriptor } from "./cli-runtime-descriptors.js";

const execFileAsync = promisify(execFile);
const credentialStatusTimeoutMs = 5_000;
const credentialObservationTimeoutMs = 5_000;
const longCredentialSmokeRuntimeIds = new Set([
  "cli:codex",
  "cli:kimi",
  "cli:grok",
  "cli:cursor",
  "cli:copilot"
]);

export type CliCredentialCheckOutcome =
  | "VERIFIED"
  | "QUOTA_LIMITED"
  | "PROVIDER_FAILED"
  | "TIMED_OUT";

export interface CliCredentialCheckResult {
  outcome: CliCredentialCheckOutcome;
}

export type CliCredentialCommandExecutor = (
  commandPath: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
  }
) => Promise<{ stdout: string }>;

export function credentialSmokeTimeoutForRuntime(runtimeId: string): number {
  return longCredentialSmokeRuntimeIds.has(runtimeId) ? 190_000 : 130_000;
}

function controlledCredentialEnvironment(): NodeJS.ProcessEnv {
  return {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TERM: "xterm-256color"
  };
}

export function isCliRuntimeTerminalLaunchable(
  runtime: Pick<AgentRuntime, "adapterStatus" | "authState" | "status">
): boolean {
  return isAgentRuntimeReady(runtime);
}

export function isCliRuntimeLoginLaunchable(
  runtime: Pick<AgentRuntime, "adapterStatus" | "detectedCommandPath">
): boolean {
  return runtime.adapterStatus === "ENABLED" && Boolean(runtime.detectedCommandPath);
}

function webChatRuntime(config: SpaceApiConfig, checkedAt: string): AgentRuntime {
  const enabled = config.agentPaneEnabled && config.enableCodexTurns && config.codexAppServerEnabled;
  return agentRuntimeSchema.parse({
    id: "web:codex-app-server",
    providerId: "codex",
    providerName: "Codex",
    agentId: "codex-app-server",
    agentName: "Codex Web Chat",
    displayName: "Codex Web Chat",
    capabilities: ["WEB_CHAT"],
    adapterStatus: enabled ? "ENABLED" : "DISABLED",
    authMode: "NONE",
    authState: enabled ? "READY" : "UNAVAILABLE",
    authReason: enabled
      ? "Codex App Server is configured for Space-native web chat."
      : "SPACE_AGENT_PANE_ENABLED=true, SPACE_ENABLE_CODEX_TURNS=true, and SPACE_CODEX_APP_SERVER_ENABLED=true are required.",
    canStartLogin: false,
    status: enabled ? "ENABLED" : "DISABLED",
    statusReason: enabled
      ? "Codex App Server is configured for Space-native web chat."
      : "SPACE_AGENT_PANE_ENABLED=true, SPACE_ENABLE_CODEX_TURNS=true, and SPACE_CODEX_APP_SERVER_ENABLED=true are required.",
    commandName: null,
    detectedCommandPath: null,
    defaultModelId: "codex-app-server-default",
    supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    checkedAt
  });
}

function rootRuntime(config: SpaceApiConfig, checkedAt: string): AgentRuntime {
  const statusReason = config.cliRootEnabled
    ? "Dedicated root shell host is enabled."
    : "SPACE_CLI_ROOT_ENABLED=true is required before root sessions can start.";
  return agentRuntimeSchema.parse({
    id: "cli:root",
    providerId: "root",
    providerName: "Root",
    agentId: "root",
    agentName: "Root Shell",
    displayName: "CLI ROOT",
    capabilities: ["CLI"],
    adapterStatus: config.cliRootEnabled ? "ENABLED" : "DISABLED",
    authMode: "NONE",
    authState: config.cliRootEnabled ? "READY" : "UNAVAILABLE",
    authReason: statusReason,
    canStartLogin: false,
    status: config.cliRootEnabled ? "ENABLED" : "DISABLED",
    statusReason,
    commandName: "/bin/bash",
    detectedCommandPath: config.cliRootEnabled ? "/bin/bash" : null,
    defaultModelId: null,
    supportedReasoningEfforts: [],
    checkedAt
  });
}

export function activeCliSessionObserverRuntime(
  config: SpaceApiConfig,
  runtimeId: string,
  checkedAt = nowIso()
): AgentRuntime | null {
  const observerReason =
    "An existing Space-managed CLI process is running; diagnostics observer metadata skips launch and credential probes.";
  if (runtimeId === "cli:root") {
    return agentRuntimeSchema.parse({
      id: "cli:root",
      providerId: "root",
      providerName: "Root",
      agentId: "root",
      agentName: "Root Shell",
      displayName: "CLI ROOT",
      capabilities: ["CLI"],
      adapterStatus: "ENABLED",
      authMode: "NONE",
      authState: "READY",
      authReason: observerReason,
      canStartLogin: false,
      status: "ENABLED",
      statusReason: observerReason,
      commandName: "/bin/bash",
      detectedCommandPath: "/bin/bash",
      defaultModelId: null,
      supportedReasoningEfforts: [],
      checkedAt
    });
  }

  const descriptor = cliRuntimeDescriptors.find((candidate) => candidate.id === runtimeId);
  if (!descriptor) return null;
  return agentRuntimeSchema.parse({
    id: descriptor.id,
    providerId: descriptor.providerId,
    providerName: descriptor.providerName,
    agentId: descriptor.key,
    agentName: descriptor.agentName,
    displayName: descriptor.agentName,
    capabilities: ["CLI"],
    adapterStatus: "ENABLED",
    authMode: descriptor.authMode,
    authState: "READY",
    authReason: observerReason,
    canStartLogin: false,
    status: "ENABLED",
    statusReason: observerReason,
    commandName: config.cliRuntimeCommands[descriptor.key],
    detectedCommandPath: null,
    defaultModelId: descriptor.defaultModelId,
    supportedReasoningEfforts: [],
    checkedAt
  });
}

function commandNameIsSafe(commandName: string): boolean {
  return commandName === basename(commandName) && !commandName.includes("..") && commandName.trim().length > 0;
}

async function detectCommand(commandPath: string, commandName: string): Promise<string | null> {
  if (!commandNameIsSafe(commandName)) return null;
  const root = resolve(commandPath);
  const candidate = resolve(root, commandName);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

type CliCredentialStatus = "READY" | "READY_QUOTA_EXHAUSTED";

async function readCredentialStatus(commandPath: string): Promise<CliCredentialStatus | null> {
  try {
    const { stdout } = await execFileAsync(commandPath, ["credential-status"], {
      encoding: "utf8",
      timeout: credentialStatusTimeoutMs,
      maxBuffer: 128
    });
    if (stdout === "READY\n" || stdout === "READY\r\n") return "READY";
    if (stdout === "READY_QUOTA_EXHAUSTED\n" || stdout === "READY_QUOTA_EXHAUSTED\r\n") {
      return "READY_QUOTA_EXHAUSTED";
    }
    return null;
  } catch {
    return null;
  }
}

export async function observeCliRuntimeCredential(runtime: AgentRuntime): Promise<string | null> {
  const definition = cliRuntimeDescriptors.find((candidate) => candidate.id === runtime.id);
  if (!definition?.credentialObservationAction || !runtime.detectedCommandPath) return null;
  try {
    const { stdout } = await execFileAsync(
      runtime.detectedCommandPath,
      [definition.credentialObservationAction],
      {
        encoding: "utf8",
        env: controlledCredentialEnvironment(),
        timeout: credentialObservationTimeoutMs,
        maxBuffer: 256
      }
    );
    if (stdout === "OBSERVATION:MISSING\n" || stdout === "OBSERVATION:MISSING\r\n") return null;
    return stdout.match(/^OBSERVATION:([0-9a-f]{64})\r?\n$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function credentialQuotaMarker(smokeMarker: string): string {
  return smokeMarker.endsWith("_OK")
    ? `${smokeMarker.slice(0, -3)}_QUOTA_LIMITED`
    : `${smokeMarker}_QUOTA_LIMITED`;
}

function isCredentialCheckTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; killed?: unknown; signal?: unknown };
  return candidate.code === "ETIMEDOUT" ||
    (candidate.killed === true && candidate.signal === "SIGTERM");
}

export async function checkCliRuntimeCredential(
  runtime: AgentRuntime,
  execute: CliCredentialCommandExecutor = execFileAsync as unknown as CliCredentialCommandExecutor
): Promise<CliCredentialCheckResult> {
  const definition = cliRuntimeDescriptors.find((candidate) => candidate.id === runtime.id);
  if (!definition?.credentialSmokeMarker || !runtime.detectedCommandPath) {
    return { outcome: "PROVIDER_FAILED" };
  }
  try {
    const { stdout } = await execute(runtime.detectedCommandPath, ["credential-smoke"], {
      encoding: "utf8",
      env: controlledCredentialEnvironment(),
      timeout: credentialSmokeTimeoutForRuntime(runtime.id),
      maxBuffer: 1_024
    });
    if (
      stdout === `${definition.credentialSmokeMarker}\n` ||
      stdout === `${definition.credentialSmokeMarker}\r\n`
    ) {
      return { outcome: "VERIFIED" };
    }
    const quotaMarker = credentialQuotaMarker(definition.credentialSmokeMarker);
    if (stdout === `${quotaMarker}\n` || stdout === `${quotaMarker}\r\n`) {
      return { outcome: "QUOTA_LIMITED" };
    }
    return { outcome: "PROVIDER_FAILED" };
  } catch (error) {
    return { outcome: isCredentialCheckTimeout(error) ? "TIMED_OUT" : "PROVIDER_FAILED" };
  }
}

export async function smokeCliRuntimeCredential(runtime: AgentRuntime): Promise<boolean> {
  const result = await checkCliRuntimeCredential(runtime);
  return result.outcome === "VERIFIED" || result.outcome === "QUOTA_LIMITED";
}

async function cliRuntime(
  config: SpaceApiConfig,
  definition: CliRuntimeDescriptor,
  checkedAt: string
): Promise<AgentRuntime> {
  const commandName = config.cliRuntimeCommands[definition.key];
  const commandRoot = config.cliCommandPath;
  const detectedCommandPath = config.cliEnabled && commandRoot ? await detectCommand(commandRoot, commandName) : null;
  const staticallyVerified = config.cliCredentialSmoke[definition.key];
  const commandIsDirectParity = commandName === definition.commandName;
  const adapterEnabled = Boolean(config.cliEnabled && commandRoot && detectedCommandPath && commandIsDirectParity);
  const adapterStatus: AgentRuntime["adapterStatus"] = adapterEnabled
    ? "ENABLED"
    : config.cliEnabled && commandRoot && commandNameIsSafe(commandName) && commandIsDirectParity && !detectedCommandPath
      ? "ERROR"
      : "DISABLED";
  const observedCredentialStatus = adapterEnabled && !staticallyVerified && definition.authMode !== "MANAGED"
    ? await readCredentialStatus(detectedCommandPath as string)
    : null;
  const dynamicCredentialStatus = observedCredentialStatus === "READY_QUOTA_EXHAUSTED" && definition.key !== "kimi"
    ? null
    : observedCredentialStatus;
  const credentialVerified = staticallyVerified || dynamicCredentialStatus !== null;
  const adapterReason = !config.cliEnabled
    ? "SPACE_CLI_ENABLED=true is required before CLI runtimes can start."
    : !commandRoot
      ? "SPACE_CLI_COMMAND_PATH must point to the controlled executable directory for the space service user."
      : !commandNameIsSafe(commandName)
        ? "Configured command must be a command name inside SPACE_CLI_COMMAND_PATH, not a path."
        : !commandIsDirectParity
          ? `${definition.commandEnv} must be ${definition.commandName} for direct ${definition.key === "codex" ? "VS Code/Codex" : "operator"} parity.`
        : !detectedCommandPath
          ? `Command ${commandName} was not executable inside SPACE_CLI_COMMAND_PATH for the space service user.`
          : definition.credentialVerifiedReason;
  const authState: AgentRuntime["authState"] = adapterStatus !== "ENABLED"
    ? "UNAVAILABLE"
    : credentialVerified
      ? "READY"
      : definition.missingAuthState;
  const authReason = authState === "READY"
    ? dynamicCredentialStatus === "READY_QUOTA_EXHAUSTED"
      ? "Kimi Code credentials are valid, but the current billing-cycle quota is exhausted. The CLI remains available and usage will resume when the provider refreshes the quota."
      : definition.credentialVerifiedReason
    : adapterStatus === "ENABLED"
      ? definition.missingAuthReason
      : adapterReason;
  const status: AgentRuntime["status"] = adapterStatus === "ERROR"
    ? "ERROR"
    : adapterStatus !== "ENABLED"
      ? "DISABLED"
      : authState === "READY"
        ? "ENABLED"
        : "NOT_CONNECTED";

  return agentRuntimeSchema.parse({
    id: definition.id,
    providerId: definition.providerId,
    providerName: definition.providerName,
    agentId: definition.key,
    agentName: definition.agentName,
    displayName: definition.agentName,
    capabilities: ["CLI"],
    adapterStatus,
    authMode: definition.authMode,
    authState,
    authReason,
    canStartLogin: adapterStatus === "ENABLED" &&
      (authState === "LOGIN_REQUIRED" || authState === "SETUP_REQUIRED") &&
      definition.loginAction !== null,
    status,
    statusReason: authReason,
    commandName,
    detectedCommandPath,
    defaultModelId: definition.defaultModelId,
    supportedReasoningEfforts: [],
    checkedAt
  });
}

export async function discoverAgentRuntimes(config: SpaceApiConfig): Promise<AgentRuntimeRegistry> {
  const checkedAt = nowIso();
  const cliRuntimes = await Promise.all(cliRuntimeDescriptors.map((definition) => cliRuntime(config, definition, checkedAt)));
  return agentRuntimeRegistrySchema.parse({
    data: [webChatRuntime(config, checkedAt), ...cliRuntimes, rootRuntime(config, checkedAt)],
    checkedAt
  });
}

export function createAgentRuntimeRegistryCache(
  discover: () => Promise<AgentRuntimeRegistry>,
  options: { ttlMs?: number; now?: () => number } = {}
): { read: () => Promise<AgentRuntimeRegistry>; invalidate: () => void } {
  const ttlMs = options.ttlMs ?? 10_000;
  const now = options.now ?? Date.now;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("Agent runtime cache TTL must be non-negative.");
  let revision = 0;
  let cached: { registry: AgentRuntimeRegistry; expiresAtMs: number } | null = null;
  let inFlight: Promise<AgentRuntimeRegistry> | null = null;

  return {
    read() {
      const currentTimeMs = now();
      if (cached && currentTimeMs < cached.expiresAtMs) return Promise.resolve(cached.registry);
      if (inFlight) return inFlight;
      const loadRevision = revision;
      const load = discover().then((registry) => {
        if (revision === loadRevision) cached = { registry, expiresAtMs: now() + ttlMs };
        return registry;
      }).finally(() => {
        if (inFlight === load) inFlight = null;
      });
      inFlight = load;
      return load;
    },
    invalidate() {
      revision += 1;
      cached = null;
      inFlight = null;
    }
  };
}

export function findRuntime(registry: AgentRuntimeRegistry, runtimeId: string): AgentRuntime | null {
  return registry.data.find((runtime) => runtime.id === runtimeId) ?? null;
}
