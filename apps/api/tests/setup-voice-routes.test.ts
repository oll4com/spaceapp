import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemorySpaceStore, SetupExecutionCoordinator } from "@space/runtime";
import { SetupVoiceCredentials } from "../src/setup-voice-credentials.js";
import { getApiConfig } from "../src/config.js";
import { registerSetupVoiceRoutes } from "../src/setup-voice-routes.js";
import { SetupVoiceVerification } from "../src/setup-voice-verification.js";

describe("conditional setup voice routes", () => {
  it("requires an interactive owner and selected Live before storing a scoped credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-voice-route-"));
    const store = new InMemorySpaceStore();
    const credentials = new SetupVoiceCredentials(root, getApiConfig({}));
    const app = Fastify();
    await app.register(websocket);
    app.decorateRequest("user", null);
    app.addHook("preHandler", async request => {
      if (request.headers["test-actor"] === "owner") request.user = { id: "user:owner", email: "owner@example.com", role: "ADMIN" };
      if (request.headers["test-actor"] === "reader") request.user = { id: "user:reader", email: "reader@example.com", role: "MEMBER" };
    });
    registerSetupVoiceRoutes(app, { store, credentials, verification: new SetupVoiceVerification({ store, credentials, config: getApiConfig({}) }) });
    try {
      const payload = { providerId: "google", apiKey: "private-fixture-key" };
      expect((await app.inject({ method: "POST", url: "/api/setup/voice/credentials", payload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/setup/voice/credentials", payload, headers: { "test-actor": "reader" } })).statusCode).toBe(403);
      const headers = { "test-actor": "owner" };
      expect((await app.inject({ method: "GET", url: "/api/setup/voice/providers", headers })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: "/api/setup/voice/credentials", headers, payload })).statusCode).toBe(409);
      expect(await credentials.resolve("user:owner", "google")).toBeNull();
      await new SetupExecutionCoordinator(store).updateDraft("user:owner", null, { persona: "everyday", level: "full", requestedFeatureIds: ["pane:live"], connectionChoices: [] });
      const saved = await app.inject({ method: "POST", url: "/api/setup/voice/credentials", headers, payload });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ credentialRef: expect.stringMatching(/^cred:voice:/), configured: true });
      expect(saved.body).not.toContain("private-fixture-key");
      const providers = await app.inject({ method: "GET", url: "/api/setup/voice/providers", headers });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().providers.find((item: { id: string }) => item.id === "google").configured).toBe(true);
      expect(providers.body).not.toContain("private-fixture-key");
      // An explicit check endpoint must exist and must fail closed for invalid choices.
      expect((await app.inject({ method: "POST", url: "/api/setup/voice/checks", headers, payload: { draftRevision: 0 } })).statusCode).toBe(422);
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
