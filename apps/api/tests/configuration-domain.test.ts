import Fastify, { type FastifyInstance } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerConfigurationRoutes } from "../src/configuration-routes.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

function fixture(role?: "USER" | "ADMIN" | "OPERATOR") {
  const app = Fastify();
  apps.push(app);
  const store = new InMemorySpaceStore();
  const recordAudit = vi.fn();
  const exportBundle = vi.spyOn(store, "exportConfigurationBundle");
  const importBundle = vi.spyOn(store, "importConfigurationBundle");
  app.addHook("onRequest", async request => {
    if (role) request.user = { id: "user:domain", email: "domain@example.test", role };
    request.requestIdForSpace = "req:configuration-domain";
  });
  registerConfigurationRoutes(app, { store, recordAudit, routeOptions: { config: {} }, config: {},
    runtimes: { read: async () => ({ data: [] }), invalidate: () => undefined }, credentialHost: null });
  return { app, store, recordAudit, exportBundle, importBundle };
}

describe("Standalone configuration domain", () => {
  it("denies an absent principal before reading any bundle", async () => {
    const f = fixture();
    const response = await f.app.inject({ method: "GET", url: "/api/configuration/export" });
    expect(response.statusCode).toBe(401);
    expect(f.exportBundle).not.toHaveBeenCalled();
  });

  it("preserves downloadable own exports and inspection without full application bootstrap", async () => {
    const f = fixture("USER");
    await f.store.upsertUser({ id: "user:domain", email: "domain@example.test", role: "USER" });
    await f.store.createUserLink({ ownerUserId: "user:domain", title: "Domain fixture", url: "https://example.test/" });
    const response = await f.app.inject({ method: "GET", url: "/api/configuration/export" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="spaceapp-config-/);
    expect(response.json().data.userLinks).toHaveLength(1);
    expect(response.json().data.apiKeys).toBeUndefined();
    expect(response.json().data.credentials).toBeUndefined();
    const inspected = await f.app.inject({ method: "POST", url: "/api/configuration/inspect", payload: { bundle: response.json() } });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json()).toMatchObject({ valid: true, summary: { userLinksCount: 1, apiKeysCount: 0, credentialsCount: 0 } });
    expect(f.recordAudit).not.toHaveBeenCalled();
  });

  it("rejects unprivileged import before parsing or invoking storage", async () => {
    const f = fixture("USER");
    const response = await f.app.inject({ method: "POST", url: "/api/configuration/import", payload: { bundle: "invalid" } });
    expect(response.statusCode).toBe(403);
    expect(f.importBundle).not.toHaveBeenCalled();
    expect(f.recordAudit).not.toHaveBeenCalled();
  });

  it("returns validation details for invalid inspection without executing an import", async () => {
    const f = fixture("ADMIN");
    const response = await f.app.inject({ method: "POST", url: "/api/configuration/inspect", payload: { bundle: { format: "invalid" } } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ valid: false, error: "Invalid configuration bundle structure." });
    expect(f.importBundle).not.toHaveBeenCalled();
  });
});
