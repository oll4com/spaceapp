import { describe, expect, it, vi } from "vitest";
import type { GatewayAccountRecord } from "@space/db";
import { InMemoryGatewayRepository } from "@space/db";
import { createGatewayCliAccounts } from "../src/gateway/gateway-cli-accounts.js";
import { createGatewayAdminService } from "../src/gateway/gateway-service.js";

function account(provider: GatewayAccountRecord["provider"], status: GatewayAccountRecord["status"], index: number): GatewayAccountRecord {
  return {
    id: `gw_account:${String(index).repeat(32)}`, provider, label: `${provider} ${index}`, email: null, planType: null, status, statusReason: null,
    priority: 100, warmupEnabled: false, resetCreditsAvailable: null, primaryWindow: { usedPercent: null, resetAt: null, windowMinutes: null },
    secondaryWindow: { usedPercent: null, resetAt: null, windowMinutes: null }, lastRefreshAt: null, lastUsedAt: null,
    createdAt: "2026-10-12T00:00:00.000Z", externalAccountId: null, credentialsEncrypted: "v1.secret-envelope",
    credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, blockedUntil: null
  };
}

const claudeGatewayProfile = async (runtimeId: string, profileId: string) => runtimeId === "cli:claude" && profileId === "space-gateway";

describe("Space Gateway account for new CLI panes", () => {
  it("starts new Claude panes on the gateway profile only while the gateway serves Claude", async () => {
    let serving = true;
    let clock = 0;
    const serves = vi.fn(async () => serving);
    const accounts = createGatewayCliAccounts({ gateway: { serves }, profileExists: claudeGatewayProfile, ttlMs: 10_000, now: () => clock });

    expect(await accounts.gatewayProfile("cli:claude")).toEqual({ profileId: "space-gateway", ready: true });
    expect(await accounts.newPaneProfileId("cli:claude")).toBe("space-gateway");
    expect(serves).toHaveBeenCalledTimes(1);
    expect(serves).toHaveBeenCalledWith("CLAUDE");

    serving = false;
    clock = 9_999;
    expect(await accounts.newPaneProfileId("cli:claude")).toBe("space-gateway");
    clock = 10_000;
    expect(await accounts.gatewayProfile("cli:claude")).toEqual({ profileId: "space-gateway", ready: false });
    expect(await accounts.newPaneProfileId("cli:claude")).toBeNull();
    expect(serves).toHaveBeenCalledTimes(2);
  });

  it("has no gateway profile for CLIs without one or before the profile is registered", async () => {
    const serves = vi.fn(async () => true);
    const registered = createGatewayCliAccounts({ gateway: { serves }, profileExists: claudeGatewayProfile });
    for (const runtimeId of ["cli:gemini", "cli:copilot", "cli:cursor", "cli:codex"]) {
      // Gemini and Copilot have a gateway profile, but it is not registered here.
      expect(await registered.gatewayProfile(runtimeId)).toBeNull();
      expect(await registered.newPaneProfileId(runtimeId)).toBeNull();
    }
    const unregistered = createGatewayCliAccounts({ gateway: { serves }, profileExists: async () => false });
    expect(await unregistered.gatewayProfile("cli:claude")).toBeNull();
    expect(serves).not.toHaveBeenCalled();
  });

  it("serves the Copilot gateway profile from the gateway's ChatGPT accounts", async () => {
    const serves = vi.fn(async (provider: string) => provider === "CODEX");
    const accounts = createGatewayCliAccounts({ gateway: { serves }, profileExists: async (_runtimeId, profileId) => profileId === "space-gateway" });
    expect(await accounts.gatewayProfile("cli:copilot")).toEqual({ profileId: "space-gateway", ready: true });
    expect(serves).toHaveBeenCalledWith("CODEX");
    expect(await accounts.gatewayProfile("cli:claude")).toEqual({ profileId: "space-gateway", ready: false });
  });

  it("serves the Antigravity gateway profile from the gateway's Antigravity accounts", async () => {
    const serves = vi.fn(async (provider: string) => provider === "ANTIGRAVITY");
    const accounts = createGatewayCliAccounts({ gateway: { serves }, profileExists: async (_runtimeId, profileId) => profileId === "space-gateway" });
    expect(await accounts.newPaneProfileId("cli:gemini")).toBe("space-gateway");
    expect(serves).toHaveBeenCalledWith("ANTIGRAVITY");
    // Space Control opens a pane on the gateway unless the request names another account.
    expect(await accounts.openProfileId("cli:gemini", undefined)).toBe("space-gateway");
    expect(await accounts.openProfileId("cli:gemini", "space-gateway")).toBe("space-gateway");
    expect(await accounts.openProfileId("cli:gemini", "work")).toBeNull();
    expect(await accounts.openProfileId("cli:cursor", undefined)).toBeNull();
  });

  it("counts a failed gateway check as not ready", async () => {
    const accounts = createGatewayCliAccounts({
      gateway: { serves: async () => { throw new Error("database unavailable"); } },
      profileExists: claudeGatewayProfile
    });
    expect(await accounts.gatewayProfile("cli:claude")).toEqual({ profileId: "space-gateway", ready: false });
  });
});

describe("Space Gateway serves a provider", () => {
  it("needs an active account of the provider and a running gateway", async () => {
    const repository = new InMemoryGatewayRepository();
    let status: () => Promise<Response> = async () => new Response(JSON.stringify({ draining: false }));
    const fetchImpl = vi.fn(async () => status());
    const service = createGatewayAdminService({ repository, gatewayUrl: "http://127.0.0.1:4920", fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await service.serves("CLAUDE")).toBe(false);
    repository.accounts.push(account("CODEX", "ACTIVE", 1), account("CLAUDE", "PAUSED", 2), account("CLAUDE", "RATE_LIMITED", 3));
    expect(await service.serves("CLAUDE")).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();

    repository.accounts.push(account("CLAUDE", "ACTIVE", 4));
    expect(await service.serves("CLAUDE")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4920/__space-gateway/status", expect.anything());

    status = async () => new Response(JSON.stringify({ draining: true }));
    expect(await service.serves("CLAUDE")).toBe(false);
    status = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED 127.0.0.1:4920") }); };
    expect(await service.serves("CLAUDE")).toBe(false);
  });
});
