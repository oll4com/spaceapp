// Longniang, 2026-10-28: preserve room and onboarding defaults across dev and stable deployments.
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "../src/index.js";

const workspace = "/checkout/.dev-stack/workspaces";
afterEach(() => vi.unstubAllEnvs());

describe("in-memory room project defaults", () => {
  it.each(["dev", "stable"])("keeps %s room and starter defaults while preserving an explicit project", (instance) => {
    vi.stubEnv("SPACE_INSTANCE", instance);
    vi.stubEnv("SPACE_CLI_WORKSPACE_ROOT", workspace);
    const store = new InMemorySpaceStore();
    expect(store.createRoom({ name: "Default", initialPaneCount: 0 }).projectPath).toBe("/opt/spaceapp");
    expect(store.createRoom({ name: "Selected", initialPaneCount: 0, projectPath: "/checkout/source" }).projectPath).toBe("/checkout/source");
    const starter = new InMemorySpaceStore();
    const room = starter.ensureUserStarterRoom("user:test", "test@example.invalid");
    expect(room?.projectPath).toBe("/opt/spaceapp");
    expect(starter.snapshot().panes[0]?.cwd).toBe("/opt/spaceapp");
  });

  it.each(["dev", "stable"])("keeps %s owner setup defaults", (instance) => {
    vi.stubEnv("SPACE_INSTANCE", instance);
    vi.stubEnv("SPACE_CLI_WORKSPACE_ROOT", workspace);
    const store = new InMemorySpaceStore();
    store.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2026-10-26T12:15:00.000Z" });
    store.claimOwnerSetup({ tokenHash: "a".repeat(64), passwordHash: "synthetic-hash", email: "owner@example.invalid", now: "2026-10-26T12:00:00.000Z" });
    expect(store.ensureOwnerStarterRoom().room.projectPath).toBe("/opt/spaceapp");
    expect(store.snapshot().panes[0]?.cwd).toBe("/opt/spaceapp");
  });

});
