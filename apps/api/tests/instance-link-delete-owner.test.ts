import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it, vi } from "vitest";
import { noiseKeyPair, vaultBase64url as b64 } from "@space/contracts";
import { connectorSealContext, createConnectorCrypto } from "../src/dot-connectors.js";

// The session's AI callbacks, as routes.ts hands them to linkAiServe: what a peer's AI request would read.
const served: { key?: () => Promise<string | null>; lending?: () => boolean } = {};
vi.mock("../src/instance-link/ai-lend.js", async (actual) => ({ ...(await actual<object>()),
  linkAiServe: (_url: string, key: () => Promise<string | null>, lending: () => boolean) => { Object.assign(served, { key, lending }); return async () => undefined; } }));
vi.mock("../src/instance-link/client.js", async (actual) => ({ ...(await actual<object>()),
  connectInstanceLink: async () => ({ scopes: ["read"], rotated: null, closed: () => null, close: () => undefined, request: async () => ({ status: 200, body: null }) }) }));
const { registerInstanceLinks } = await import("../src/instance-link/routes.js");

// REV1127-001: another person's DELETE of a link id they do not own answers 404 and leaves the owner's lending and lent key alone.
describe("removing a linked SpaceApp", () => {
  const owner = "user:owner";
  const id = "link:ownerLink0001";
  const crypto = createConnectorCrypto({ key: randomBytes(32).toString("base64"), legacySecrets: [] });
  let regenerated = 0;
  const key = { id: "gwkey:1", name: `Space Link AI: Hetzner (${id})`, isActive: true };
  const gateway = { url: "http://127.0.0.1:1", service: () => ({
    listApiKeys: async () => ({ data: [key] }), createApiKey: async () => ({ plainKey: "SYNTHETIC-created" }),
    updateApiKey: async (_id: string, patch: { isActive: boolean }) => { key.isActive = patch.isActive; },
    regenerateApiKey: async () => ({ plainKey: `SYNTHETIC-${++regenerated}` }), serves: async () => false
  }) };
  const app = Fastify();
  app.addHook("onRequest", async (request) => { request.user = { id: String(request.headers["x-user"] ?? owner) } as never; });
  const { repository } = registerInstanceLinks(app, {
    store: { recordAuditEvent: async () => undefined, upsertUser: async () => ({ id: owner }), listAuditEventsSince: async () => [] } as never,
    crypto, databaseUrl: null, routeOptions: {}, assertPerson: () => undefined, version: "1.0.0", gateway: gateway as never
  });
  afterAll(async () => { await app.close(); });

  it("refuses another person's id before touching the owner's lending", async () => {
    await repository.create({ id, ownerUserId: owner, label: "Hetzner", origins: ["http://127.0.0.1:1"], noisePublic: b64.encode(randomBytes(32)),
      identityPublic: b64.encode(randomBytes(32)), deviceId: "appdev:x", scopes: ["read"], accessKeys: null,
      sealedDevicePrivate: crypto.seal(b64.encode(noiseKeyPair().privateKey), connectorSealContext("instance-link", owner, id)) });
    expect((await app.inject({ method: "POST", url: `/api/instance-links/${id}/ai`, payload: { on: true } })).json()).toMatchObject({ ai: true });
    expect(served.lending?.()).toBe(true);
    expect(await served.key?.()).toBe("SYNTHETIC-1");

    expect((await app.inject({ method: "DELETE", url: `/api/instance-links/${id}`, headers: { "x-user": "user:other" } })).statusCode).toBe(404);
    expect(served.lending?.()).toBe(true);
    expect(await served.key?.()).toBe("SYNTHETIC-1"); // not regenerated: the peer's key in use stays valid

    expect((await app.inject({ method: "DELETE", url: `/api/instance-links/${id}` })).statusCode).toBe(200);
    expect(served.lending?.()).toBe(false);
    expect(await served.key?.()).toBeNull();
  });
});
