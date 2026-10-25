import { describe, expect, it, vi } from "vitest";
import type { CliRuntimeSettingsResponse, CliVpnConnection, CliVpnRoutingStatus } from "@space/contracts";
import {
  CLI_VPN_ROUTING_STATUS_EVENT,
  cliVpnRoutingStatusKey,
  harnessPaneVpnRoutingPresentation,
  paneVpnRoutingPresentation,
  refreshCliVpnRoutingStatus,
  resetCliVpnRoutingStatusForTests
} from "../src/cli-vpn-routing.js";

const routingStatusRequest = vi.fn();
vi.mock("../src/api.js", () => ({
  api: {
    cliVpnRoutingStatus: () => routingStatusRequest()
  }
}));

const status: CliVpnRoutingStatus = {
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
  checkedAt: "2026-08-01T09:00:00.000Z"
};

describe("CLI VPN pane routing presentation", () => {
  it("shows the VPN egress only for the exact applied normal session", () => {
    expect(paneVpnRoutingPresentation(status, {
      sessionId: "cli_session:vpn",
      runtimeId: "cli:opencode",
      purpose: "NORMAL"
    })).toMatchObject({ label: "Greece · 150.228.63.199", tone: "vpn" });

    expect(paneVpnRoutingPresentation(status, {
      sessionId: "cli_session:other",
      runtimeId: "cli:opencode",
      purpose: "NORMAL"
    })).toBeNull();

    expect(paneVpnRoutingPresentation(status, {
      sessionId: "cli_session:vpn",
      runtimeId: "cli:opencode",
      purpose: "LOGIN"
    })).toBeNull();
  });

  it("uses the actual selected route name for Mullvad panes", () => {
    expect(paneVpnRoutingPresentation({
      ...status,
      selectedRoute: "mullvad",
      egressIpv4: "193.32.249.133"
    }, {
      sessionId: "cli_session:vpn",
      runtimeId: "cli:opencode",
      purpose: "NORMAL"
    })).toMatchObject({ label: "Mullvad · 193.32.249.133", tone: "vpn" });
  });

  it("appends the VPN relay city to the label and title when known", () => {
    const withCity = paneVpnRoutingPresentation({
      ...status,
      selectedRoute: "mullvad",
      egressIpv4: "193.32.249.133",
      relay: {
        hostname: "gr-ath-wg-001",
        cityCode: "ath",
        cityName: "Athens",
        countryCode: "gr",
        countryName: "Greece"
      }
    }, {
      sessionId: "cli_session:vpn",
      runtimeId: "cli:opencode",
      purpose: "NORMAL"
    });
    expect(withCity).toMatchObject({
      label: "Mullvad · 193.32.249.133 · Athens (GR)",
      title: expect.stringContaining("VPN city: Athens (GR)."),
      tone: "vpn",
      city: "Athens (GR)"
    });
  });

  it("keeps the plain route label when the VPN relay has no city", () => {
    expect(paneVpnRoutingPresentation(status, {
      sessionId: "cli_session:vpn",
      runtimeId: "cli:opencode",
      purpose: "NORMAL"
    })).toMatchObject({ label: "Greece · 150.228.63.199", tone: "vpn", city: undefined });
  });

  it("marks only the exact legacy session as pending restart", () => {
    expect(paneVpnRoutingPresentation(status, {
      sessionId: "cli_session:legacy",
      runtimeId: "cli:opencode",
      purpose: "NORMAL"
    })).toMatchObject({ label: "VPN pending", tone: "pending" });
  });

  it("reports an unavailable protected route without claiming a VPN egress", () => {
    expect(paneVpnRoutingPresentation({
      ...status,
      connectionStatus: "ERROR",
      egressIpv4: null,
      applications: [{
        ...status.applications[0]!,
        effectiveMode: "BLOCKED"
      }]
    }, {
      sessionId: "cli_session:legacy",
      runtimeId: "cli:opencode",
      purpose: "NORMAL"
    })).toMatchObject({ label: "VPN unavailable", tone: "blocked" });
  });

  it("shows the real Harness VPN egress and relay city without a CLI transcript session", () => {
    const connection: CliVpnConnection = {
      profileConfigured: true,
      status: "CONNECTED",
      endpoint: "vpn.example.test:51820",
      dnsServers: ["10.64.0.1"],
      profileFingerprint: "0123456789abcdef",
      relay: {
        hostname: "nz-akl-wg-001",
        cityCode: "akl",
        cityName: "Auckland",
        countryCode: "nz",
        countryName: "New Zealand"
      },
      egressIpv4: "103.75.11.100",
      egressIpv6: null,
      lastHandshakeAt: status.checkedAt,
      lastVerifiedAt: status.checkedAt,
      lastVerificationCode: "VERIFIED",
      updatedAt: status.checkedAt
    };
    const settings: CliRuntimeSettingsResponse = {
      settings: [],
      runtimes: [],
      vpnSupported: true,
      vpnApplications: [],
      egress: {
        supported: true,
        selectedRoute: "mullvad",
        directEgressIpv4: "78.46.128.16",
        removedProfiles: [],
        profiles: { greece: connection, thailand: connection, mullvad: connection, nord: connection },
        applications: [],
        checkedAt: status.checkedAt
      },
      harness: {
        runtimeId: "cli:harness",
        enabled: true,
        vpnEnabled: true,
        effectiveMode: "VPN",
        isolated: true,
        pid: 3264577
      },
      checkedAt: status.checkedAt
    };

    expect(harnessPaneVpnRoutingPresentation(settings)).toMatchObject({
      label: "Mullvad · 103.75.11.100 · Auckland (NZ)",
      title: expect.stringContaining("VPN city: Auckland (NZ)."),
      tone: "vpn"
    });
    expect(harnessPaneVpnRoutingPresentation({
      ...settings,
      harness: { ...settings.harness!, enabled: false, pid: null }
    })).toBeNull();
  });
});

describe("CLI VPN routing status refresh", () => {
  it("notifies listeners only when the observed route actually changed", async () => {
    resetCliVpnRoutingStatusForTests();
    routingStatusRequest.mockReset();
    const seen: number[] = [];
    const listener = () => { seen.push(seen.length); };
    window.addEventListener(CLI_VPN_ROUTING_STATUS_EVENT, listener);
    try {
      routingStatusRequest.mockResolvedValue(status);
      await refreshCliVpnRoutingStatus();
      expect(seen).toHaveLength(1);

      routingStatusRequest.mockResolvedValue({ ...status, checkedAt: "2026-08-01T09:05:00.000Z" });
      await refreshCliVpnRoutingStatus();
      expect(seen).toHaveLength(1);
      expect(routingStatusRequest).toHaveBeenCalledTimes(2);

      routingStatusRequest.mockResolvedValue({
        ...status,
        selectedRoute: "mullvad",
        egressIpv4: "193.32.249.133",
        checkedAt: "2026-08-01T09:10:00.000Z"
      });
      await refreshCliVpnRoutingStatus();
      expect(seen).toHaveLength(2);
    } finally {
      window.removeEventListener(CLI_VPN_ROUTING_STATUS_EVENT, listener);
      resetCliVpnRoutingStatusForTests();
    }
  });

  it("keeps the status key stable across checks but sensitive to route and application state", () => {
    expect(cliVpnRoutingStatusKey(status)).toBe(cliVpnRoutingStatusKey({ ...status, checkedAt: "2026-08-02T00:00:00.000Z" }));
    expect(cliVpnRoutingStatusKey(status)).not.toBe(cliVpnRoutingStatusKey({ ...status, selectedRoute: "thailand" }));
    expect(cliVpnRoutingStatusKey(status)).not.toBe(cliVpnRoutingStatusKey({
      ...status,
      applications: [{ ...status.applications[0]!, effectiveMode: "BLOCKED" }]
    }));
  });
});
