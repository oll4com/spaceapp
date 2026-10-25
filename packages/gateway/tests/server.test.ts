import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { generateGatewayApiKey, hashGatewayApiKey, readPresentedApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { loadGatewayConfig } from "../src/config.js";
import { createGatewayServer } from "../src/server.js";

async function setup(options: { now?: () => Date } = {}) {
  const repository = new InMemoryGatewayRepository();
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({
    keyId: `gw_key:${"a".repeat(32)}`, name: "Test", keyHash, keyPrefix, trafficClass: "INTERACTIVE", allowedModels: [],
    enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null,
    limits: [], expiresAt: null, createdBy: null
  });
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => false, ...options });
  return { repository, server, plainKey };
}

describe("gateway API keys", () => {
  it("generates sk-sgw keys stored only as a hash and a short prefix", () => {
    const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
    expect(plainKey).toMatch(/^sk-sgw-[A-Za-z0-9_-]{43}$/);
    expect(keyHash).toBe(hashGatewayApiKey(plainKey));
    expect(keyPrefix).toBe(plainKey.slice(0, 15));
    expect(keyHash).not.toContain(plainKey.slice(7));
  });

  it("reads Bearer and x-api-key credentials and rejects malformed headers", () => {
    expect(readPresentedApiKey({ authorization: "Bearer sk-sgw-abcdefgh" })).toBe("sk-sgw-abcdefgh");
    expect(readPresentedApiKey({ "x-api-key": "sk-sgw-abcdefgh" })).toBe("sk-sgw-abcdefgh");
    expect(readPresentedApiKey({ authorization: "Basic abc" })).toBeNull();
    expect(readPresentedApiKey({})).toBeNull();
  });
});

describe("credential cipher", () => {
  const cipher = createCredentialCipher(Buffer.alloc(32, 7));

  it("round-trips and binds the ciphertext to its account", () => {
    const envelope = cipher.encrypt('{"refresh_token":"secret"}', "gw_account:1");
    expect(envelope).toMatch(/^v1\./);
    expect(envelope).not.toContain("secret");
    expect(cipher.decrypt(envelope, "gw_account:1")).toBe('{"refresh_token":"secret"}');
    expect(() => cipher.decrypt(envelope, "gw_account:2")).toThrow();
  });

  it("rejects short keys and tampered envelopes", () => {
    expect(() => createCredentialCipher(Buffer.alloc(16))).toThrow();
    const envelope = cipher.encrypt("x", "a");
    const parts = envelope.split(".");
    parts[3] = Buffer.from("y").toString("base64url");
    expect(() => cipher.decrypt(parts.join("."), "a")).toThrow();
  });
});

describe("gateway config", () => {
  it("defaults to loopback port 4920 and rejects host names", () => {
    expect(loadGatewayConfig({})).toMatchObject({ host: "127.0.0.1", port: 4920, databaseUrl: null });
    expect(() => loadGatewayConfig({ SPACE_GATEWAY_HOST: "example.com" })).toThrow();
    expect(() => loadGatewayConfig({ SPACE_GATEWAY_PORT: "80" })).toThrow();
  });
});

describe("gateway server", () => {
  it("serves health, readiness and non-sensitive status", async () => {
    const { server } = await setup();
    expect((await server.app.inject({ url: "/health" })).json()).toEqual({ status: "ok" });
    expect((await server.app.inject({ url: "/readyz" })).statusCode).toBe(200);
    const status = (await server.app.inject({ url: "/__space-gateway/status" })).json();
    expect(status).toMatchObject({ version: "test", draining: false, credentialKey: "MISSING" });
  });

  it("answers proxy routes with codex-lb style errors", async () => {
    const { server, plainKey } = await setup();
    const missing = await server.app.inject({ method: "POST", url: "/v1/responses", payload: {} });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: { message: expect.any(String), type: "authentication_error", code: "invalid_api_key" } });
    const wrong = await server.app.inject({ method: "POST", url: "/v1/responses", headers: { authorization: "Bearer sk-sgw-wrongwrongwrong" }, payload: {} });
    expect(wrong.statusCode).toBe(401);
    const valid = await server.app.inject({ method: "POST", url: "/backend-api/codex/responses", headers: { authorization: `Bearer ${plainKey}` }, payload: {} });
    expect(valid.statusCode).toBe(503);
    expect(valid.json().error.code).toBe("no_accounts");
  });

  it("rejects disabled and expired keys", async () => {
    const { server, repository, plainKey } = await setup({ now: () => new Date("2030-01-01T00:00:00Z") });
    const key = (await repository.listApiKeys())[0]!;
    await repository.updateApiKey(key.id, { isActive: false });
    expect((await server.app.inject({ url: "/v1/models", headers: { authorization: `Bearer ${plainKey}` } })).json().error.message).toMatch(/disabled/);
    await repository.updateApiKey(key.id, { isActive: true });
    repository.keys[0]!.expiresAt = "2029-01-01T00:00:00.000Z";
    expect((await server.app.inject({ url: "/v1/models", headers: { authorization: `Bearer ${plainKey}` } })).json().error.message).toMatch(/expired/);
  });

  it("stops admitting proxy requests while draining", async () => {
    const { server, plainKey } = await setup();
    server.startDraining();
    const response = await server.app.inject({ url: "/v1/models", headers: { authorization: `Bearer ${plainKey}` } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("gateway_draining");
    expect((await server.app.inject({ url: "/health" })).json()).toEqual({ status: "draining" });
  });

  it("stops counting a request in flight when its client aborts a stream", async () => {
    const repository = new InMemoryGatewayRepository();
    const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => false,
      routes: (app) => { app.get("/v1/stream", async (_request, reply) => { reply.hijack(); reply.raw.writeHead(200); reply.raw.write("start"); return reply; }); } });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const port = (server.app.server.address() as AddressInfo).port;
      await new Promise<void>((resolve) => {
        const request = httpRequest({ host: "127.0.0.1", port, path: "/v1/stream" }, (response) => {
          response.once("data", () => { expect(server.inFlight()).toBe(1); request.destroy(); resolve(); });
        });
        request.end();
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.inFlight()).toBe(0);
    } finally {
      await server.app.close();
    }
  });
});
