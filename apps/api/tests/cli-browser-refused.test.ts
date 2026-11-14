import { describe, expect, it, vi } from "vitest";
import { SpaceFeatureDisabledError } from "@space/runtime";
import { tellBrowserRefused } from "../src/cli-browser-bridge-routes.js";

describe("an agent browser the host refused", () => {
  const store = { getRoom: async (id: string) => ({ id, ownerUserId: "user:owner" }) as never };
  const claims = { roomId: "room:x", paneId: "pane:cli" };

  it("tells Nous once per CLI pane when no display is free, and nothing for other errors (13/11)", async () => {
    const notice = vi.fn(async () => undefined);
    await tellBrowserRefused(new SpaceFeatureDisabledError("BROWSER_SESSION_CAPACITY", "No Xvfb display is available for a headed browser session."), { store, notice }, claims, "pane:browser");
    expect(notice).toHaveBeenCalledWith("user:owner", "browser-no-display:pane:cli", expect.stringContaining("No Xvfb display is available"));
    await tellBrowserRefused(new Error("BROWSER_ROUTE: another pane uses this browser account on another network route"), { store, notice }, claims, "pane:browser");
    await tellBrowserRefused(new Error("boom"), { store, notice }, claims, "pane:browser");
    expect(notice).toHaveBeenCalledTimes(1);
  });
});
