import { describe, expect, it } from "vitest";
import type { GatewayAccount } from "@space/contracts";
import { gatewayAccountAvailability } from "../src/features/space-gateway/space-gateway-model.js";

const clock = Date.parse("2026-10-13T08:00:00.000Z");
const at = (minutes: number) => new Date(clock + minutes * 60_000).toISOString();
const base: GatewayAccount = {
  id: `gw_account:${"1".repeat(32)}`, provider: "CLAUDE", label: "crew", alias: null, email: "crew@spaceapp.dev", planType: "max5x", status: "ACTIVE",
  statusReason: null, priority: 100, warmupEnabled: false, resetCreditsAvailable: null, primaryWindow: { usedPercent: 27, resetAt: at(90), windowMinutes: 300 },
  secondaryWindow: { usedPercent: 29, resetAt: at(3 * 24 * 60), windowMinutes: 10080 }, lastRefreshAt: null, lastUsedAt: null, createdAt: "2026-10-11T10:00:00.000Z"
};
const account = (patch: Partial<GatewayAccount>): GatewayAccount => ({ ...base, ...patch });

describe("gatewayAccountAvailability", () => {
  it("reads availability from the windows as Resources does", () => {
    expect(gatewayAccountAvailability(base, clock)).toEqual({ state: "available", backAt: null });
    expect(gatewayAccountAvailability(account({ primaryWindow: { usedPercent: 100, resetAt: at(40), windowMinutes: 300 } }), clock)).toEqual({ state: "soon", backAt: at(40) });
    expect(gatewayAccountAvailability(account({ secondaryWindow: { usedPercent: 100, resetAt: at(3 * 24 * 60), windowMinutes: 10080 } }), clock)).toEqual({ state: "exhausted", backAt: at(3 * 24 * 60) });
    // A window whose reset passed is full again; no sample at all is unknown.
    expect(gatewayAccountAvailability(account({ primaryWindow: { usedPercent: 100, resetAt: at(-5), windowMinutes: 300 } }), clock).state).toBe("available");
    expect(gatewayAccountAvailability(account({ primaryWindow: { usedPercent: null, resetAt: null, windowMinutes: null }, secondaryWindow: { usedPercent: null, resetAt: null, windowMinutes: null } }), clock).state).toBe("unknown");
  });

  it("counts a gateway block even when the last sample still shows room, and offline statuses as offline", () => {
    expect(gatewayAccountAvailability(account({ status: "RATE_LIMITED" }), clock)).toEqual({ state: "soon", backAt: at(90) });
    expect(gatewayAccountAvailability(account({ status: "QUOTA_EXCEEDED", primaryWindow: { usedPercent: 40, resetAt: null, windowMinutes: 300 } }), clock))
      .toEqual({ state: "exhausted", backAt: at(3 * 24 * 60) });
    expect(gatewayAccountAvailability(account({ status: "RATE_LIMITED", primaryWindow: { usedPercent: 40, resetAt: null, windowMinutes: 300 },
      secondaryWindow: { usedPercent: 10, resetAt: null, windowMinutes: 10080 } }), clock)).toEqual({ state: "soon", backAt: null });
    for (const status of ["PAUSED", "DEACTIVATED", "REAUTH_REQUIRED"] as const) {
      expect(gatewayAccountAvailability(account({ status }), clock)).toEqual({ state: "offline", backAt: null });
    }
  });

  it("judges an account with quota groups by its best group", () => {
    const antigravity = account({ provider: "ANTIGRAVITY", quotaGroups: [
      { key: "gemini", primaryWindow: { usedPercent: 100, resetAt: at(60), windowMinutes: 300 }, secondaryWindow: { usedPercent: 10, resetAt: null, windowMinutes: 10080 } },
      { key: "claude", primaryWindow: { usedPercent: 20, resetAt: at(60), windowMinutes: 300 }, secondaryWindow: { usedPercent: 10, resetAt: null, windowMinutes: 10080 } }
    ] });
    expect(gatewayAccountAvailability(antigravity, clock).state).toBe("available");
  });
});
