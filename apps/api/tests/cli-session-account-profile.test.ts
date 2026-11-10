import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createCliSessionAccountProfileResolver } from "../src/cli-session-account-profile.js";

function setup(previousProfile?: string | null, options: { pinned?: boolean; ready?: boolean } = {}) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Account defaults", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
  store.createCliAccountProfile("cli:claude", { runtimeId: "cli:claude", profileId: "space-gateway", displayName: "Space Gateway" }, "user:admin");
  if (previousProfile !== undefined) store.createPaneCliSession({
    paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "anthropic", agentId: "claude",
    launchMode: "FRESH", cwd: "/etc", status: "EXITED", isActive: false, accountProfileId: previousProfile
  });
  const newPaneAccountProfileId = vi.fn(async () => options.ready === false ? null : "space-gateway");
  const resolve = createCliSessionAccountProfileResolver({ store, pinnedDirect: async () => options.pinned === true, newPaneAccountProfileId });
  return { store, pane, resolve, newPaneAccountProfileId, input: { paneId: pane.id, runtimeId: "cli:claude" } };
}

describe("CLI session account defaults", () => {
  it("inherits a closed pane's existing gateway profile without checking gateway readiness", async () => {
    const f = setup("space-gateway", { ready: false });
    expect(await f.resolve(f.input)).toBe("space-gateway");
    expect(f.newPaneAccountProfileId).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "removed-profile"])("uses the ready gateway with previous profile %s", async (previous) => {
    const f = setup(previous);
    expect(await f.resolve(f.input)).toBe("space-gateway");
    expect(f.newPaneAccountProfileId).toHaveBeenCalledWith("cli:claude");
  });

  it.each([null, "direct"])("keeps a pinned direct profile, including main (%s)", async (profileId) => {
    const f = setup(profileId, { pinned: true });
    expect(await f.resolve({ ...f.input, sourceSession: { runtimeId: "cli:claude", accountProfileId: "space-gateway" } })).toBe(profileId);
    expect(f.newPaneAccountProfileId).not.toHaveBeenCalled();
  });

  it("honors explicit main and Auto's already-selected profile, with null fallback if the gateway is not ready", async () => {
    const f = setup(undefined, { ready: false });
    expect(await f.resolve({ ...f.input, accountProfileId: "main" })).toBe("main");
    expect(await f.resolve({ ...f.input, accountProfileId: null })).toBeNull();
    expect(await f.resolve({ ...f.input, accountProfileId: "auto-picked" })).toBe("auto-picked");
    expect(f.newPaneAccountProfileId).not.toHaveBeenCalled();
    expect(await f.resolve(f.input)).toBeNull();
  });

  it("keeps a valid previous direct profile and the Job Copilot source-task rule, scoped to the runtime", async () => {
    const f = setup("work");
    f.store.createCliAccountProfile("cli:claude", { runtimeId: "cli:claude", profileId: "work", displayName: "Work" }, "user:admin");
    expect(await f.resolve(f.input)).toBe("work");
    expect(await f.resolve({ ...f.input, previousSession: { runtimeId: "cli:gemini", accountProfileId: "work" } })).toBe("space-gateway");
    const fresh = setup();
    expect(await fresh.resolve({ ...fresh.input, sourceSession: { runtimeId: "cli:claude", accountProfileId: "space-gateway" } })).toBe("space-gateway");
    fresh.store.createCliAccountProfile("cli:gemini", { runtimeId: "cli:gemini", profileId: "job-account", displayName: "Job account" }, "user:admin");
    expect(await fresh.resolve({ ...fresh.input, runtimeId: "cli:gemini", sourceSession: { runtimeId: "cli:gemini", accountProfileId: "job-account" } })).toBe("job-account");
    expect(await fresh.resolve({ ...fresh.input, runtimeId: "cli:gemini" })).toBeNull();
    expect(fresh.newPaneAccountProfileId).not.toHaveBeenCalled();
  });
});
