import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { authUserSchema } from "@space/contracts";
import { InMemorySpaceStore, SetupExecutionCoordinator } from "@space/runtime";
import { SetupClientRuntimeVerification, registerSetupClientRuntimeRoutes } from "../src/setup-client-runtime-verification.js";
afterEach(() => vi.useRealTimers());

async function fixture() {
  const store = new InMemorySpaceStore();
  const ownerId = "user:owner";
  store.upsertUser(authUserSchema.parse({ id: ownerId, email: "owner@example.test", role: "ADMIN" }));
  const coordinator = new SetupExecutionCoordinator(store);
  const draft = await coordinator.updateDraft(ownerId, null, { persona: "creator", level: "full",
    requestedFeatureIds: ["utility:osk", "utility:asteroids", "pane:youtube"], connectionChoices: [] });
  const verification = new SetupClientRuntimeVerification(store, "build-one");
  return { store, ownerId, coordinator, draft, verification };
}

describe("selected client runtime setup checks", () => {
  it("requires an observed OSK text round trip and invalidates proof on draft/build changes", async () => {
    const f = await fixture();
    const check = await f.verification.begin(f.ownerId, "utility:osk", f.draft.revision);
    expect(await f.verification.currentFingerprint(f.ownerId, "utility:osk")).toBeNull();
    await f.verification.complete(f.ownerId, check.checkId, { featureId: "utility:osk", text: check.challenge, terminalData: check.challenge });
    expect(await f.verification.currentFingerprint(f.ownerId, "utility:osk")).toMatch(/^[a-f0-9]{64}$/);
    const restarted = new SetupClientRuntimeVerification(f.store, "build-one");
    expect(await restarted.currentFingerprint(f.ownerId, "utility:osk")).toMatch(/^[a-f0-9]{64}$/);
    expect(await new SetupClientRuntimeVerification(f.store, "build-two").currentFingerprint(f.ownerId, "utility:osk")).toBeNull();
    await f.coordinator.updateDraft(f.ownerId, f.draft.revision, { persona: "everyday", level: "minimal", requestedFeatureIds: [], connectionChoices: [] });
    expect(await restarted.currentFingerprint(f.ownerId, "utility:osk")).toBeNull();
  });

  it("refuses boolean-only, wrong-feature, foreign, unselected and replayed observations", async () => {
    const f = await fixture();
    await expect(f.verification.begin("user:missing", "utility:osk", f.draft.revision)).rejects.toThrow();
    const check = await f.verification.begin(f.ownerId, "utility:osk", f.draft.revision);
    await expect(f.verification.complete("user:foreign", check.checkId, { featureId: "utility:osk", text: check.challenge, terminalData: check.challenge })).rejects.toThrow();
    await expect(f.verification.complete(f.ownerId, check.checkId, { verified: true })).rejects.toThrow();
    const next = await f.verification.begin(f.ownerId, "utility:osk", f.draft.revision);
    await expect(f.verification.complete(f.ownerId, next.checkId, { featureId: "pane:youtube", ready: true, position: 0, embedHost: "www.youtube.com" })).rejects.toThrow();
    const last = await f.verification.begin(f.ownerId, "utility:osk", f.draft.revision);
    await f.verification.complete(f.ownerId, last.checkId, { featureId: "utility:osk", text: last.challenge, terminalData: last.challenge });
    await expect(f.verification.complete(f.ownerId, last.checkId, { featureId: "utility:osk", text: last.challenge, terminalData: last.challenge })).rejects.toThrow();
  });

  it("rechecks persisted browser evidence at the capability gate and refuses it after its ten-minute lifetime", async () => {
    const f = await fixture(); const inspect = f.verification.capabilityChecks()["utility:osk"]!;
    await expect(inspect(f.ownerId)).rejects.toThrow();
    const check = await f.verification.begin(f.ownerId, "utility:osk", f.draft.revision);
    await f.verification.complete(f.ownerId, check.checkId, { featureId: "utility:osk", text: check.challenge, terminalData: check.challenge });
    await expect(inspect(f.ownerId)).resolves.toMatch(/^[a-f0-9]{64}$/);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 600_001);
    await expect(inspect(f.ownerId)).rejects.toThrow();
  });

  it("expires or cancels challenges without issuing proof and rejects an incomplete canvas or embed check", async () => {
    const f = await fixture();
    const game = await f.verification.begin(f.ownerId, "utility:asteroids", f.draft.revision);
    await expect(f.verification.complete(f.ownerId, game.checkId, { featureId: "utility:asteroids", ticks: 30, elapsed: 0, shotsFired: 0, painted: false })).rejects.toThrow();
    const video = await f.verification.begin(f.ownerId, "pane:youtube", f.draft.revision);
    await f.verification.cancel(f.ownerId, video.checkId);
    await expect(f.verification.complete(f.ownerId, video.checkId, { featureId: "pane:youtube", ready: true, position: 0, embedHost: "www.youtube.com" })).rejects.toThrow();
    expect(await f.verification.currentFingerprint(f.ownerId, "utility:asteroids")).toBeNull();
    const expired = await f.verification.begin(f.ownerId, "utility:osk", f.draft.revision);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 121_000);
    await expect(f.verification.complete(f.ownerId, expired.checkId, { featureId: "utility:osk", text: expired.challenge, terminalData: expired.challenge })).rejects.toThrow();
  });

  it("requires an interactive same-origin owner and strict runtime DTOs", async () => {
    const f = await fixture();
    const app = Fastify();
    app.addHook("preHandler", async request => { request.user = authUserSchema.parse({ id: f.ownerId, email: "owner@example.test", role: "ADMIN" }); });
    registerSetupClientRuntimeRoutes(app, { verification: f.verification });
    try {
      const request = { method: "POST" as const, url: "/api/setup/client-runtime/checks", headers: { host: "localhost" }, payload: { featureId: "utility:osk", draftRevision: f.draft.revision } };
      expect((await app.inject(request)).statusCode).toBe(403);
      expect((await app.inject({ ...request, headers: { ...request.headers, origin: "http://localhost" } })).statusCode).toBe(200);
      expect((await app.inject({ ...request, headers: { ...request.headers, origin: "http://localhost" }, payload: { ...request.payload, url: "http://untrusted.invalid" } })).statusCode).toBe(422);
    } finally { await app.close(); }
  });
  it.each([
    { name: "trusted loopback proxy", remoteAddress: "127.0.0.1", origin: "http://127.0.0.1:4911", expected: 422 },
    { name: "untrusted forwarded host", remoteAddress: "192.0.2.44", origin: "http://127.0.0.1:4911", expected: 403 },
    { name: "foreign origin", remoteAddress: "127.0.0.1", origin: "http://foreign.test", expected: 403 },
    { name: "missing origin", remoteAddress: "127.0.0.1", origin: undefined, expected: 403 }
  ])("uses Fastify's trusted proxy origin for $name", async ({ remoteAddress, origin, expected }) => {
    const f = await fixture();
    const app = Fastify({ trustProxy: ["127.0.0.1"] });
    app.addHook("preHandler", async request => {
      request.user = { id: "user:owner", email: "owner@example.test", role: "ADMIN" };
    });
    registerSetupClientRuntimeRoutes(app, { verification: f.verification });
    try {
      const response = await app.inject({ method: "POST", url: "/api/setup/client-runtime/checks", remoteAddress,
        headers: { host: "127.0.0.1:4000", "x-forwarded-host": "127.0.0.1:4911",
          "x-forwarded-proto": "http", ...(origin ? { origin } : {}) }, payload: { unexpected: "value" } });
      expect(response.statusCode).toBe(expected);
    } finally { await app.close(); }
  });

});
