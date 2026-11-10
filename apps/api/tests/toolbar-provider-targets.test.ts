import { describe, expect, it } from "vitest";
import { createToolbarProviderTargets } from "../src/toolbar-provider-targets.js";

describe("toolbar provider targets", () => {
  it("lists every provider with its health, the current one first, and offers no switch", async () => {
    const store: any = {
      listProviders: async () => [
        { id: "a", displayName: "Alpha", type: "OPENAI", status: "ERROR", routeProfile: null },
        { id: "gw", displayName: "Space Gateway", type: "SPACE_GATEWAY", status: "VERIFIED", routeProfile: "direct-auto" },
        { id: "b", displayName: "Beta", type: "OPENAI", status: "PENDING", routeProfile: null }
      ],
      getProviderSettings: async () => ({ defaultProviderId: "gw" })
    };
    const targets = await createToolbarProviderTargets({ store }).readToolbarProviderTargets();
    expect(targets.data).toEqual([
      { providerId: "gw", displayName: "Space Gateway", isCurrent: true, canSwitch: false, health: "HEALTHY", reason: "Codex runs through Space Gateway." },
      { providerId: "a", displayName: "Alpha", isCurrent: false, canSwitch: false, health: "UNAVAILABLE", reason: "Provider does not expose a supported Space Gateway route." },
      { providerId: "b", displayName: "Beta", isCurrent: false, canSwitch: false, health: "UNKNOWN", reason: "Provider does not expose a supported Space Gateway route." }
    ]);
    expect(targets.pagination).toEqual({ page: 1, pageSize: 100, totalItems: 3, totalPages: 1 });
  });
});
