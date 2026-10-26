import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { registerSetupExecutionRoutes } from "../src/setup-execution-routes.js";
import type { SetupConnectionsService } from "../src/setup-connections.js";

describe("legacy first setup draft proposal", () => {
  it("keeps existing choices in an incomplete legacy proposal without changing settings or completion", async () => {
    const store = new InMemorySpaceStore();
    store.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" });
    const { user } = store.claimOwnerSetup({ tokenHash: "a".repeat(64), email: "owner@example.com", passwordHash: "fixture", now: new Date().toISOString() });
    const currentOnboarding = store.getOwnerOnboarding();
    const before = store.updateUserSettings(user.id, { panesHidden: ["files", "databases"], customPanesHidden: ["files", "databases"], docksHidden: ["media"], customDocksHidden: ["media"], desktopWidgets: { clock: { enabled: true, x: 22 } }, uiTheme: "codex" });
    let legacy = false;
    store.getOwnerOnboarding = () => ({ ...currentOnboarding, onboardingVersion: legacy ? 1 : 2 });
    const app = Fastify();
    app.addHook("preHandler", async (request) => { request.user = user; });
    registerSetupExecutionRoutes(app, { store, actionPumpEnabled: false,
      connections: { overview: async () => [] } as unknown as SetupConnectionsService });
    try {
      const fresh = await app.inject({ method: "GET", url: "/api/setup/draft" });
      expect(fresh.json().requestedFeatureIds).not.toContain("widget:clock");
      legacy = true;
      const proposal = await app.inject({ method: "GET", url: "/api/setup/draft" });
      expect(proposal.statusCode).toBe(200);
      expect(proposal.json()).toMatchObject({ revision: null, selectionOrigin: "EXISTING_SETTINGS" });
      expect(proposal.json().requestedFeatureIds).toContain("widget:clock");
      expect(proposal.json().requestedFeatureIds).toContain("pane:browser");
      expect(proposal.json().requestedFeatureIds).not.toContain("pane:files");
      expect(proposal.json().requestedFeatureIds).not.toContain("dock:media");
      expect(store.getUserSettings(user.id)).toEqual(before);
      expect(store.getOwnerOnboarding().isComplete).toBe(false);
      expect((await store.getSetupExecutionState(user.id))?.draft).toBeFalsy();
    } finally { await app.close(); }
  });
});
