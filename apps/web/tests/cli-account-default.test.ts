import { describe, expect, it } from "vitest";
import type { ListCliAccountProfilesResponse } from "@space/contracts";
import { cliAccountProfileForPane, lateListAccountProfileId } from "../src/features/cli-accounts/cli-account-default.js";

function list(profileIds: string[], gatewayProfile?: ListCliAccountProfilesResponse["gatewayProfile"]): ListCliAccountProfilesResponse {
  return {
    profiles: profileIds.map((profileId) => ({
      runtimeId: "cli:claude",
      profileId,
      displayName: profileId,
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z",
      updatedBy: null
    })),
    ...(gatewayProfile === undefined ? {} : { gatewayProfile })
  };
}

describe("account a pane starts on", () => {
  const ids = ["main", "work", "space-gateway"];

  it("opens every pane without a CLI on Space Gateway while it is ready for the CLI, whatever its age", () => {
    expect(cliAccountProfileForPane(list(ids, { profileId: "space-gateway", ready: true }), "work", true)).toBe("space-gateway");
    expect(cliAccountProfileForPane(list(ids, { profileId: "space-gateway", ready: true }), "main", true)).toBe("space-gateway");
  });

  it("keeps a running pane, or one the operator picked by hand, on its own account", () => {
    expect(cliAccountProfileForPane(list(ids, { profileId: "space-gateway", ready: true }), "work", false)).toBe("work");
  });

  it("never defaults a new pane to Space Gateway while it is not ready", () => {
    const notReady = list(ids, { profileId: "space-gateway", ready: false });
    expect(cliAccountProfileForPane(notReady, "work", true)).toBe("work");
    expect(cliAccountProfileForPane(notReady, "space-gateway", true)).toBe("main");
    // A pane already on the gateway keeps it.
    expect(cliAccountProfileForPane(notReady, "space-gateway", false)).toBe("space-gateway");
  });

  it("keeps the remembered account for CLIs without a gateway profile", () => {
    expect(cliAccountProfileForPane(list(["main", "work"]), "work", true)).toBe("work");
    expect(cliAccountProfileForPane(list(["main", "work"], null), "gone", true)).toBe("main");
    expect(cliAccountProfileForPane(list([]), "work", true)).toBe("main");
  });

  it("starts a pane whose account list is late on the CLI's gateway profile, never the remembered one", () => {
    expect(lateListAccountProfileId("cli:claude")).toBe("space-gateway");
    expect(lateListAccountProfileId("cli:gemini")).toBe("space-gateway");
    expect(lateListAccountProfileId("cli:copilot")).toBe("space-gateway");
    // CLIs without a gateway profile keep the picker's selection.
    expect(lateListAccountProfileId("cli:cursor")).toBeUndefined();
  });
});
