import type { GatewayProvider } from "@space/contracts";
import type { GatewayAdminService } from "./gateway-service.js";

/**
 * CLI account profiles that sign in through Space Gateway, with the gateway provider whose accounts serve them.
 * New panes of these CLIs start on the gateway profile while Space Gateway runs and has at least one active
 * account of that provider; otherwise they start on the account they would have used before.
 */
export const gatewayCliAccountProfiles: Readonly<Partial<Record<string, { profileId: string; provider: GatewayProvider }>>> = {
  "cli:claude": { profileId: "space-gateway", provider: "CLAUDE" },
  // Antigravity: the profile runs on the main account's sign-in and the gateway picks a pooled Google account per model call.
  "cli:gemini": { profileId: "space-gateway", provider: "ANTIGRAVITY" },
  // GitHub Copilot BYOK: the profile's model calls go to the gateway's ChatGPT (Codex) accounts.
  "cli:copilot": { profileId: "space-gateway", provider: "CODEX" }
};

const defaultTtlMs = 10_000;

export interface GatewayCliAccounts {
  /** The CLI's registered gateway profile and whether new panes start on it; null when the CLI has none. */
  gatewayProfile(runtimeId: string): Promise<{ profileId: string; ready: boolean } | null>;
  /** The profile a new pane of the CLI starts on when it names none: the gateway profile when ready, else null. */
  newPaneProfileId(runtimeId: string): Promise<string | null>;
  /** Space Control's panes.open: the ready gateway profile when the request names no account or names that profile. */
  openProfileId(runtimeId: string, requested: unknown): Promise<string | null>;
}

export function createGatewayCliAccounts(options: {
  gateway: Pick<GatewayAdminService, "serves">;
  profileExists: (runtimeId: string, profileId: string) => Promise<boolean>;
  ttlMs?: number;
  now?: () => number;
}): GatewayCliAccounts {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? defaultTtlMs;
  // Every pane mount lists its CLI's profiles; one gateway check per provider and TTL is enough.
  const checks = new Map<GatewayProvider, { at: number; serves: Promise<boolean> }>();
  const serves = (provider: GatewayProvider) => {
    const at = now();
    let check = checks.get(provider);
    if (!check || at - check.at >= ttlMs) {
      check = { at, serves: options.gateway.serves(provider).catch(() => false) };
      checks.set(provider, check);
    }
    return check.serves;
  };

  async function gatewayProfile(runtimeId: string) {
    const entry = gatewayCliAccountProfiles[runtimeId];
    if (!entry || !(await options.profileExists(runtimeId, entry.profileId).catch(() => false))) return null;
    return { profileId: entry.profileId, ready: await serves(entry.provider) };
  }

  async function newPaneProfileId(runtimeId: string) {
    const profile = await gatewayProfile(runtimeId);
    return profile?.ready ? profile.profileId : null;
  }

  return {
    gatewayProfile,
    newPaneProfileId,
    async openProfileId(runtimeId, requested) {
      const profileId = await newPaneProfileId(runtimeId);
      return requested == null || requested === profileId ? profileId : null;
    }
  };
}
