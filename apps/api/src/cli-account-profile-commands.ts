import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { cliProfileUsageSchema, type CliProfileUsage } from "@space/contracts";
import type { CliAccountProfileRuntimeId } from "./cli-account-profile-runtimes.js";
import { claudeProfileUsageSchema } from "./claude-usage-services.js";
import type { ClaudeProfileUsage } from "./claude-usage.js";
import type { SpaceApiConfig } from "./config.js";
import { execFile } from "./safe-child-process.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

const execFileAsync = promisify(execFile);

/** Test seams for the CLI account profile commands; createApp's options extend them. */
export interface CliAccountProfileCommandOptions {
  removeGeminiAccountProfileState?: (profileId: string) => Promise<void>;
  readGeminiAccountProfileDetails?: (profileId: string) => Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null }>;
  removeClaudeAccountProfileState?: (profileId: string) => Promise<void>;
  readClaudeAccountProfileDetails?: (profileId: string) => Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null }>;
  readClaudeAccountProfileUsage?: (profileId: string) => Promise<ClaudeProfileUsage>;
  removeCopilotAccountProfileState?: (profileId: string) => Promise<void>;
  readCopilotAccountProfileDetails?: (profileId: string) => Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null; login?: string | null }>;
  removeCursorAccountProfileState?: (profileId: string) => Promise<void>;
  readCursorAccountProfileDetails?: (profileId: string) => Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null }>;
  readCopilotAccountProfileUsage?: (profileId: string) => Promise<CliProfileUsage>;
  removeKimiAccountProfileState?: (profileId: string) => Promise<void>;
  readKimiAccountProfileDetails?: (profileId: string) => Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null }>;
  readKimiAccountProfileUsage?: (profileId: string) => Promise<CliProfileUsage>;
}

/**
 * Each CLI's account profile commands through its parity wrapper (remove a profile, read its sign-in identity, read its
 * usage) unless an option replaces them, and the 30-second identity cache the linked-accounts view reads.
 */
export function createCliAccountProfileCommands(options: CliAccountProfileCommandOptions, config: SpaceApiConfig) {
  const removeGeminiAccountProfileState = options.removeGeminiAccountProfileState ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? `${SPACE_INSTALL_ROOT}/bin`;
    await execFileAsync(join(commandRoot, "gemini-vscode-parity"), ["remove-profile", profileId], {
      timeout: 15_000,
      maxBuffer: 64 * 1024
    });
  });
  const readGeminiAccountProfileDetails = options.readGeminiAccountProfileDetails ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? `${SPACE_INSTALL_ROOT}/bin`;
    const { stdout } = await execFileAsync(join(commandRoot, "gemini-vscode-parity"), ["profile-info", profileId], {
      timeout: 12_000,
      maxBuffer: 16 * 1024
    });
    return z.object({
      authStatus: z.enum(["CONNECTED", "NOT_CONNECTED", "UNAVAILABLE"]),
      email: z.string().email().nullable()
    }).strict().parse(JSON.parse(stdout));
  });
  const removeClaudeAccountProfileState = options.removeClaudeAccountProfileState ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? `${SPACE_INSTALL_ROOT}/bin`;
    await execFileAsync(join(commandRoot, "claude-vscode-parity"), ["remove-profile", profileId], {
      timeout: 15_000,
      maxBuffer: 64 * 1024
    });
  });
  const readClaudeAccountProfileDetails = options.readClaudeAccountProfileDetails ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? `${SPACE_INSTALL_ROOT}/bin`;
    const { stdout } = await execFileAsync(join(commandRoot, "claude-vscode-parity"), ["profile-info", profileId], {
      timeout: 12_000,
      maxBuffer: 16 * 1024
    });
    return z.object({
      authStatus: z.enum(["CONNECTED", "NOT_CONNECTED", "UNAVAILABLE"]),
      email: z.string().email().nullable()
    }).strict().parse(JSON.parse(stdout));
  });
  const readClaudeAccountProfileUsage = options.readClaudeAccountProfileUsage ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? `${SPACE_INSTALL_ROOT}/bin`;
    const { stdout } = await execFileAsync(join(commandRoot, "claude-vscode-parity"), ["usage-info", profileId], {
      timeout: 25_000,
      maxBuffer: 16 * 1024
    });
    return claudeProfileUsageSchema.parse(JSON.parse(stdout));
  });
  const removeCopilotAccountProfileState = options.removeCopilotAccountProfileState ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? `${SPACE_INSTALL_ROOT}/bin`;
    await execFileAsync(join(commandRoot, "copilot-vscode-parity"), ["remove-profile", profileId], {
      timeout: 15_000,
      maxBuffer: 64 * 1024
    });
  });
  const readCopilotAccountProfileDetails = options.readCopilotAccountProfileDetails ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? `${SPACE_INSTALL_ROOT}/bin`;
    const { stdout } = await execFileAsync(join(commandRoot, "copilot-vscode-parity"), ["profile-info", profileId], {
      timeout: 12_000,
      maxBuffer: 16 * 1024
    });
    return z.object({
      authStatus: z.enum(["CONNECTED", "NOT_CONNECTED", "UNAVAILABLE"]),
      email: z.string().email().nullable(),
      login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).nullable().optional()
    }).strict().parse(JSON.parse(stdout));
  });
  const removeCursorAccountProfileState = options.removeCursorAccountProfileState ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? `${SPACE_INSTALL_ROOT}/bin`;
    await execFileAsync(join(commandRoot, "cursor-vscode-parity"), ["remove-profile", profileId], {
      timeout: 15_000,
      maxBuffer: 64 * 1024
    });
  });
  const readCursorAccountProfileDetails = options.readCursorAccountProfileDetails ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? `${SPACE_INSTALL_ROOT}/bin`;
    const { stdout } = await execFileAsync(join(commandRoot, "cursor-vscode-parity"), ["profile-info", profileId], {
      timeout: 12_000,
      maxBuffer: 16 * 1024
    });
    return z.object({
      authStatus: z.enum(["CONNECTED", "NOT_CONNECTED", "UNAVAILABLE"]),
      email: z.string().email().nullable()
    }).strict().parse(JSON.parse(stdout));
  });
  const runAccountWrapper = async (command: string, args: string[], timeout: number) =>
    (await execFileAsync(join(config.cliCommandPath ?? `${SPACE_INSTALL_ROOT}/bin`, command), args, { timeout, maxBuffer: 16 * 1024 })).stdout;
  const removeKimiAccountProfileState = options.removeKimiAccountProfileState ?? (async (profileId: string) => {
    await runAccountWrapper("kimi-vscode-parity", ["remove-profile", profileId], 15_000);
  });
  const readKimiAccountProfileDetails = options.readKimiAccountProfileDetails ?? (async (profileId: string) =>
    z.object({ authStatus: z.enum(["CONNECTED", "NOT_CONNECTED", "UNAVAILABLE"]), email: z.string().email().nullable() }).strict()
      .parse(JSON.parse(await runAccountWrapper("kimi-vscode-parity", ["profile-info", profileId], 12_000))));
  const readKimiAccountProfileUsage = options.readKimiAccountProfileUsage ?? (async (profileId: string) =>
    cliProfileUsageSchema.parse(JSON.parse(await runAccountWrapper("kimi-vscode-parity", ["usage-info", profileId], 20_000))));
  const deletingCliAccountProfileKeys = new Set<string>();
  const cliAccountProfileKey = (runtimeId: string, profileId: string) => `${runtimeId}/${profileId}`;
  const readCliAccountProfileDetails = (runtimeId: CliAccountProfileRuntimeId, profileId: string) =>
    runtimeId === "cli:gemini"
      ? readGeminiAccountProfileDetails(profileId)
      : runtimeId === "cli:claude"
        ? readClaudeAccountProfileDetails(profileId)
        : runtimeId === "cli:copilot"
          ? readCopilotAccountProfileDetails(profileId)
          : runtimeId === "cli:kimi"
            ? readKimiAccountProfileDetails(profileId)
            : readCursorAccountProfileDetails(profileId);
  // The linked-accounts view reads every profile's sign-in identity; a short cache keeps
  // repeated menu opens from spawning one native probe per profile each time.
  const cliAccountIdentityCacheTtlMs = 30_000;
  const cliAccountIdentityCache = new Map<string, { expiresAt: number; value: Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null; login?: string | null }> }>();
  const readCachedCliAccountIdentity = (runtimeId: CliAccountProfileRuntimeId, profileId: string) => {
    const key = cliAccountProfileKey(runtimeId, profileId);
    const cached = cliAccountIdentityCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = readCliAccountProfileDetails(runtimeId, profileId)
      .catch(() => ({ authStatus: "UNAVAILABLE" as const, email: null }));
    cliAccountIdentityCache.set(key, { expiresAt: Date.now() + cliAccountIdentityCacheTtlMs, value });
    return value;
  };
  const invalidateCliAccountIdentity = (runtimeId: string, profileId: string) => {
    cliAccountIdentityCache.delete(cliAccountProfileKey(runtimeId, profileId));
  };
  const readCopilotAccountProfileUsage = options.readCopilotAccountProfileUsage ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? `${SPACE_INSTALL_ROOT}/bin`;
    const { stdout } = await execFileAsync(join(commandRoot, "copilot-vscode-parity"), ["usage-info", profileId], {
      timeout: 20_000,
      maxBuffer: 16 * 1024
    });
    return cliProfileUsageSchema.parse(JSON.parse(stdout));
  });
  return {
    removeGeminiAccountProfileState,
    readGeminiAccountProfileDetails,
    removeClaudeAccountProfileState,
    readClaudeAccountProfileUsage,
    removeCopilotAccountProfileState,
    removeCursorAccountProfileState,
    removeKimiAccountProfileState,
    readKimiAccountProfileUsage,
    readCopilotAccountProfileUsage,
    deletingCliAccountProfileKeys,
    cliAccountProfileKey,
    readCliAccountProfileDetails,
    cliAccountIdentityCacheTtlMs,
    cliAccountIdentityCache,
    readCachedCliAccountIdentity,
    invalidateCliAccountIdentity
  } as const;
}
