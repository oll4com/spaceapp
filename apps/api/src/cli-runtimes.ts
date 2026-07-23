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

export function isCliRuntimeTerminalLaunchable(
  runtime: Pick<AgentRuntime, "adapterStatus" | "authState" | "status">
): boolean {
  return isAgentRuntimeReady(runtime);
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

async function cliRuntime(config: SpaceApiConfig, definition: CliRuntimeDescriptor, checkedAt: string): Promise<AgentRuntime> {
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
