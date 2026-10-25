import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SetupExecutionCoordinator } from "@space/runtime";
import Fastify from "fastify";
import * as capture from "../src/setup-capture-verification.js";
import { registerSetupExecutionRoutes } from "../src/setup-execution-routes.js";
import type { SetupConnectionsService } from "../src/setup-connections.js";

function capturedGrid(colors: string[]) {
  const bytes = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const color = colors[Math.floor(y / 4) * 8 + Math.floor(x / 4)]!;
    const at = (y * 32 + x) * 4;
    for (let channel = 0; channel < 3; channel++) bytes[at + channel] = parseInt(color.slice(1 + channel * 2, 3 + channel * 2), 16);
    bytes[at + 3] = 255;
  }
  return bytes.toString("base64");
}

async function fixture() {
  const store = new InMemorySpaceStore(); const coordinator = new SetupExecutionCoordinator(store);
  const draft = await coordinator.updateDraft("user:owner", null, { persona: "creator", level: "balanced",
    requestedFeatureIds: ["utility:snip"], connectionChoices: [] });
  return { store, coordinator, draft, verification: new capture.SetupCaptureVerification(store) };
}

describe("explicit first-setup capture proof", () => {
  it("verifies the synthetic captured pixels, persists only an owner/revision proof and rejects replay", async () => {
    const f = await fixture();
    const check = await f.verification.begin("user:owner", f.draft.revision);
    expect(await f.verification.currentFingerprint("user:owner")).toBeNull();
    await f.verification.complete("user:owner", check.checkId, capturedGrid(check.colors));
    expect(await new capture.SetupCaptureVerification(f.store).currentFingerprint("user:owner")).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.verification.currentFingerprint("user:other")).toBeNull();
    await expect(f.verification.complete("user:owner", check.checkId, capturedGrid(check.colors))).rejects.toThrow();
    expect(JSON.stringify(f.store.getSetupExecutionState("user:owner"))).not.toContain(check.colors[0]);
    await f.coordinator.updateDraft("user:owner", f.draft.revision, { persona: "creator", level: "balanced", requestedFeatureIds: [], connectionChoices: [] });
    expect(await f.verification.currentFingerprint("user:owner")).toBeNull();
  });

  it("rejects a foreign owner, cancelled capture, wrong pixels and stale draft", async () => {
    for (const mode of ["owner", "cancel", "pixels", "revision"]) {
      const f = await fixture(); const check = await f.verification.begin("user:owner", f.draft.revision);
      if (mode === "cancel") await f.verification.cancel("user:owner", check.checkId);
      if (mode === "revision") await f.coordinator.updateDraft("user:owner", f.draft.revision, { persona: "creator", level: "balanced", requestedFeatureIds: ["utility:snip", "dock:media"], connectionChoices: [] });
      await expect(f.verification.complete(mode === "owner" ? "user:other" : "user:owner", check.checkId,
        mode === "pixels" ? Buffer.alloc(32 * 32 * 4).toString("base64") : capturedGrid(check.colors))).rejects.toThrow();
      expect(await f.verification.currentFingerprint("user:owner")).toBeNull();
    }
  });

  it("requires explicit same-origin interactive selected requests and refuses boolean-only success", async () => {
    const f = await fixture(); const app = Fastify(); app.decorateRequest("user", null);
    app.addHook("preHandler", async request => {
      if (request.headers["test-owner"]) request.user = { id: "user:owner", role: "ADMIN", email: "fixture@example.com" };
    });
    capture.registerSetupCaptureRoutes(app, { verification: f.verification, uiOrigin: "http://localhost" });
    try {
      const payload = { draftRevision: f.draft.revision };
      expect((await app.inject({ method: "POST", url: "/api/setup/capture/checks", payload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/setup/capture/checks", headers: { "test-owner": "1", origin: "http://other.invalid" }, payload })).statusCode).toBe(403);
      const headers = { "test-owner": "1", origin: "http://localhost" };
      const begun = await app.inject({ method: "POST", url: "/api/setup/capture/checks", headers, payload });
      expect(begun.statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/setup/capture/checks/${begun.json().checkId}/complete`, headers,
        payload: { verified: true } })).statusCode).toBe(422);
      expect(await f.verification.currentFingerprint("user:owner")).toBeNull();
    } finally { await app.close(); }
  });

  it("clears the plan's permission blocker only after the explicit capture, and restores it after a draft edit or expiry", async () => {
    const f = await fixture(); const app = Fastify(); app.decorateRequest("user", null);
    app.addHook("preHandler", async request => { request.user = { id: "user:owner", role: "ADMIN", email: "fixture@example.com" }; });
    registerSetupExecutionRoutes(app, { store: f.store, actionPumpEnabled: false,
      connections: { overview: async () => [] } as unknown as SetupConnectionsService });
    try {
      const catalog = (await app.inject({ url: "/api/setup/catalog" })).json();
      expect(catalog.features.find((item: { id: string }) => item.id === "utility:snip").availability).toBe("INSTALLABLE");
      const plan = () => app.inject({ method: "POST", url: "/api/setup/plan", payload: { draftRevision: f.draft.revision } });
      expect((await plan()).json().requiredHumanInputs).toEqual([{ featureId: "utility:snip", kind: "OS_PERMISSION", reasonCode: "CAPTURE_PERMISSION_REQUIRED" }]);
      const headers = { origin: "http://localhost:80" };
      const begun = (await app.inject({ method: "POST", url: "/api/setup/capture/checks", headers,
        payload: { draftRevision: f.draft.revision } })).json();
      expect((await app.inject({ method: "POST", url: `/api/setup/capture/checks/${begun.checkId}/complete`, headers,
        payload: { rgba: capturedGrid(begun.colors) } })).statusCode).toBe(200);
      const verified = (await plan()).json(); expect(verified.requiredHumanInputs).toEqual([]);
      const time = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_001);
      try { expect((await plan()).json().requiredHumanInputs).toHaveLength(1); } finally { time.mockRestore(); }
      f.draft = await f.coordinator.updateDraft("user:owner", f.draft.revision, { persona: "developer", level: "balanced", requestedFeatureIds: ["utility:snip"], connectionChoices: [] });
      const edited = (await plan()).json(); expect(edited.requiredHumanInputs).toHaveLength(1);
      expect(edited.planDigest).not.toBe(verified.planDigest);
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
    capture.registerSetupCaptureRoutes(app, { verification: f.verification });
    try {
      const response = await app.inject({ method: "POST", url: "/api/setup/capture/checks", remoteAddress,
        headers: { host: "127.0.0.1:4000", "x-forwarded-host": "127.0.0.1:4911",
          "x-forwarded-proto": "http", ...(origin ? { origin } : {}) }, payload: { unexpected: "value" } });
      expect(response.statusCode).toBe(expected);
    } finally { await app.close(); }
  });

});
