// 龙娘 · 2026-10-26: check room and owner onboarding defaults without overriding selected projects.
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "../src/index.js";

const workspace = "/checkout/.dev-stack/workspaces";
afterEach(() => vi.unstubAllEnvs());

describe("in-memory room project defaults", () => {
  it("uses the dev workspace for rooms and user starter panes, preserving an explicit source folder", () => {
    vi.stubEnv("SPACE_INSTANCE", "dev");
    vi.stubEnv("SPACE_CLI_WORKSPACE_ROOT", workspace);
    const store = new InMemorySpaceStore();
    expect(store.createRoom({ name: "Default", initialPaneCount: 0 }).projectPath).toBe(workspace);
    expect(store.createRoom({ name: "Selected", initialPaneCount: 0, projectPath: "/checkout/source" }).projectPath).toBe("/checkout/source");
    const starter = new InMemorySpaceStore();
    const room = starter.ensureUserStarterRoom("user:test", "test@example.invalid");
    expect(room?.projectPath).toBe(workspace);
    expect(starter.snapshot().panes[0]?.cwd).toBe(workspace);
  });

  it("uses the dev workspace throughout owner setup", () => {
    vi.stubEnv("SPACE_INSTANCE", "dev");
    vi.stubEnv("SPACE_CLI_WORKSPACE_ROOT", workspace);
    const store = new InMemorySpaceStore();
    store.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2026-10-26T12:15:00.000Z" });
    store.claimOwnerSetup({ tokenHash: "a".repeat(64), passwordHash: "synthetic-hash", email: "owner@example.invalid", now: "2026-10-26T12:00:00.000Z" });
    expect(store.ensureOwnerStarterRoom().room.projectPath).toBe(workspace);
    expect(store.snapshot().panes[0]?.cwd).toBe(workspace);
  });

  it("keeps stable rooms and starter panes at their existing default", () => {
    vi.stubEnv("SPACE_INSTANCE", "stable");
    vi.stubEnv("SPACE_CLI_WORKSPACE_ROOT", workspace);
    const store = new InMemorySpaceStore();
    expect(store.createRoom({ name: "Default", initialPaneCount: 0 }).projectPath).toBe("/opt/spaceapp");
    const starter = new InMemorySpaceStore();
    expect(starter.ensureUserStarterRoom("user:test", "test@example.invalid")?.projectPath).toBe("/opt/spaceapp");
    expect(starter.snapshot().panes[0]?.cwd).toBe("/opt/spaceapp");
  });
});
