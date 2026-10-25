import { describe, expect, it } from "vitest";
import {
  cliRuntimeDisablePreviewSchema,
  cliRuntimeSettingsResponseSchema,
  cliGlobalEgressStatusSchema,
  cliToggleRuntimeIds,
  cliVpnConnectionSchema,
  cliVpnRoutingStatusSchema,
  replaceCliVpnProfileInputSchema,
  restartCliRuntimeVpnSessionsResultSchema,
  updateCliRuntimeVpnInputSchema,
  updateCliGlobalEgressInputSchema,
  updateCliRuntimeSettingInputSchema,
  updateHarnessEnabledInputSchema
} from "../src/schemas.js";

const timestamp = "2026-07-22T12:00:00.000Z";

describe("CLI runtime settings contracts", () => {
  it("accepts the exact allowlisted runtime set with default-enabled settings", () => {
    const response = cliRuntimeSettingsResponseSchema.parse({
      settings: cliToggleRuntimeIds.map((runtimeId) => ({
        runtimeId,
        enabled: true,
        updatedAt: timestamp,
        updatedBy: null
      })),
      runtimes: [],
      checkedAt: timestamp
    });

    expect(response.settings).toHaveLength(cliToggleRuntimeIds.length);
    expect(response.settings.map((setting) => setting.runtimeId)).toEqual([
      "cli:codex",
      "cli:claude",
      "cli:gemini",
      "cli:opencode",
      "cli:autohand",
      "cli:qwen",
      "cli:kimi",
      "cli:grok",
      "cli:deepseek",
      "cli:cursor",
      "cli:copilot",
      "cli:hermes",
      "cli:omp",
      "cli:qoder",
      "cli:muse",
      "cli:droid"
    ]);
    expect(response.settings.every((setting) => setting.enabled)).toBe(true);
    expect(response.settings.every((setting) => setting.vpnEnabled === false)).toBe(true);
    expect(response.vpnSupported).toBe(false);
  });

  it("accepts only bounded VPN profile input and exposes redacted connection health", () => {
    expect(replaceCliVpnProfileInputSchema.safeParse({ config: "short" }).success).toBe(false);
    expect(replaceCliVpnProfileInputSchema.safeParse({ config: "x".repeat(64) }).success).toBe(true);
    expect(updateCliRuntimeVpnInputSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(updateCliRuntimeVpnInputSchema.safeParse({ enabled: true, runtimeId: "cli:codex" }).success).toBe(false);
    expect(updateHarnessEnabledInputSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(updateHarnessEnabledInputSchema.safeParse({ enabled: true, runtimeId: "cli:harness" }).success).toBe(false);
    expect(cliVpnConnectionSchema.parse({
      profileConfigured: true,
      status: "CONNECTED",
      endpoint: "vpn.example.test:51820",
      dnsServers: ["10.2.0.1"],
      profileFingerprint: "0123456789abcdef",
      relay: null,
      egressIpv4: "198.51.100.8",
      egressIpv6: null,
      lastHandshakeAt: timestamp,
      lastVerifiedAt: timestamp,
      lastVerificationCode: "VERIFIED",
      updatedAt: timestamp
    })).not.toHaveProperty("config");
  });

  it("exposes exact per-session VPN application state and bounded restart results", () => {
    expect(cliVpnRoutingStatusSchema.parse({
      vpnSupported: true,
      selectedRoute: "greece",
      connectionStatus: "CONNECTED",
      egressIpv4: "150.228.63.199",
      egressIpv6: null,
      relay: null,
      applications: [{
        runtimeId: "cli:opencode",
        effectiveMode: "VPN",
        appliedSessionIds: ["cli_session:vpn"],
        restartRequiredSessionIds: ["cli_session:legacy"]
      }],
      checkedAt: timestamp
    })).toMatchObject({ selectedRoute: "greece", egressIpv4: "150.228.63.199" });

    expect(restartCliRuntimeVpnSessionsResultSchema.parse({
      runtimeId: "cli:opencode",
      requestedSessionIds: ["cli_session:legacy"],
      restartedSessionIds: ["cli_session:legacy"],
      replacementSessionIds: ["cli_session:vpn"],
      failedSessionIds: [],
      connection: {
        profileConfigured: true,
        status: "CONNECTED",
        endpoint: "vpn.example.test:51820",
        dnsServers: ["10.2.0.1"],
        profileFingerprint: "0123456789abcdef",
        relay: null,
        egressIpv4: "150.228.63.199",
        egressIpv6: null,
        lastHandshakeAt: timestamp,
        lastVerifiedAt: timestamp,
        lastVerificationCode: "VERIFIED",
        updatedAt: timestamp
      },
      application: {
        effectiveMode: "VPN",
        appliedSessionIds: ["cli_session:vpn"],
        restartRequiredSessionIds: []
      }
    })).toMatchObject({ failedSessionIds: [] });
  });

  it("allows Direct or one configured WireGuard profile as the global route for all fourteen CLIs", () => {
    expect(updateCliGlobalEgressInputSchema.safeParse({ routeId: "greece" }).success).toBe(true);
    expect(updateCliGlobalEgressInputSchema.safeParse({ routeId: "thailand" }).success).toBe(true);
    expect(updateCliGlobalEgressInputSchema.safeParse({ routeId: "mullvad" }).success).toBe(true);
    expect(updateCliGlobalEgressInputSchema.safeParse({ routeId: "nord" }).success).toBe(true);
    expect(updateCliGlobalEgressInputSchema.safeParse({ routeId: "automatic" }).success).toBe(false);
    const profile = cliVpnConnectionSchema.parse({
      profileConfigured: true,
      status: "CONNECTED",
      endpoint: "vpn.example.test:51820",
      dnsServers: ["10.2.0.1"],
      profileFingerprint: "0123456789abcdef",
      relay: null,
      egressIpv4: "198.51.100.8",
      egressIpv6: null,
      lastHandshakeAt: timestamp,
      lastVerifiedAt: timestamp,
      lastVerificationCode: "VERIFIED",
      updatedAt: timestamp
    });
    const status = cliGlobalEgressStatusSchema.parse({
      supported: true,
      selectedRoute: "thailand",
      directEgressIpv4: "78.46.128.16",
      removedProfiles: ["mullvad"],
      profiles: { greece: profile, thailand: profile, mullvad: profile, nord: profile },
      applications: cliToggleRuntimeIds.map((runtimeId) => ({
        runtimeId,
        routeId: "thailand",
        appliedSessionIds: [],
        restartRequiredSessionIds: []
      })),
      checkedAt: timestamp
    });
    expect(status.applications).toHaveLength(cliToggleRuntimeIds.length);
    expect(status.applications.every((application) => application.routeId === "thailand")).toBe(true);
    expect(status.removedProfiles).toEqual(["mullvad"]);
    expect(cliGlobalEgressStatusSchema.safeParse({
      supported: true,
      selectedRoute: "direct",
      directEgressIpv4: "78.46.128.16",
      removedProfiles: [],
      profiles: { greece: profile, thailand: profile, mullvad: profile, nord: profile },
      applications: [],
      checkedAt: timestamp
    }).success).toBe(true);
  });

  it("requires a bounded opaque token for every disable and rejects it for enable", () => {
    expect(updateCliRuntimeSettingInputSchema.safeParse({ enabled: false }).success).toBe(false);
    expect(updateCliRuntimeSettingInputSchema.safeParse({ enabled: false, confirmationToken: "a".repeat(32) }).success).toBe(true);
    expect(updateCliRuntimeSettingInputSchema.safeParse({ enabled: true, confirmationToken: "a".repeat(32) }).success).toBe(false);
    expect(updateCliRuntimeSettingInputSchema.safeParse({ enabled: true }).success).toBe(true);
  });

  it("rejects non-toggle runtimes and exposes exact impact counts", () => {
    expect(cliRuntimeDisablePreviewSchema.safeParse({
      runtimeId: "cli:root",
      activeSessionCount: 0,
      openPaneCount: 0,
      confirmationToken: "b".repeat(32),
      expiresAt: timestamp
    }).success).toBe(false);

    expect(cliRuntimeDisablePreviewSchema.parse({
      runtimeId: "cli:deepseek",
      activeSessionCount: 2,
      openPaneCount: 3,
      confirmationToken: "b".repeat(32),
      expiresAt: timestamp
    })).toMatchObject({ activeSessionCount: 2, openPaneCount: 3 });
  });
});
