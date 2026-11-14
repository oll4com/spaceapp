import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { afterAll, describe, expect, it } from "vitest";
import { encodeMobilePairQr, noiseKeyPair, vaultBase64url as b64 } from "@space/contracts";
import { connectorSealContext, createConnectorCrypto } from "../src/dot-connectors.js";
import { registerInstanceLinks } from "../src/instance-link/routes.js";

// Space Link behind Cloudflare Access (Nous 13/11, a Service Auth policy on the other side's channel, never a bypass): a link keeps the
// Vault key ids of the service token and sends their values as CF-Access-Client-Id/Secret on pairing and on every connect.
describe("Space Link through Cloudflare Access", () => {
  const owner = "user:access";
  const seen: Array<Record<string, unknown>> = [];
  // The other side as Access would pass it: it records the upgrade's headers and refuses the Noise handshake.
  const peer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  peer.on("connection", (socket, request) => { seen.push({ ...request.headers }); socket.close(4401); });
  const values: Record<string, string> = { "vault_key:clientIdKey01": "client-id.access", "vault_key:secretKey0001": "SYNTHETIC-access-secret" };
  const access = { clientId: "vault_key:clientIdKey01", clientSecret: "vault_key:secretKey0001" };
  const audits: unknown[] = [];
  const crypto = createConnectorCrypto({ key: randomBytes(32).toString("base64"), legacySecrets: [] });
  const app = Fastify();
  app.addHook("onRequest", async (request) => { request.user = { id: owner } as never; });
  const { repository } = registerInstanceLinks(app, {
    store: { recordAuditEvent: async (event: unknown) => { audits.push(event); }, upsertUser: async () => ({ id: owner }), listAuditEventsSince: async () => [] } as never,
    crypto, databaseUrl: null, routeOptions: {}, assertPerson: () => undefined, version: "1.0.0", vaultKey: async (_owner, id) => values[id] ?? null
  });
  afterAll(async () => { await app.close(); peer.close(); });

  it("sends the Vault's service token on pairing and reconnect, refuses a key the Vault does not keep, and never answers or audits a value", async () => {
    if (!peer.address()) await once(peer, "listening");
    const origin = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;
    const code = encodeMobilePairQr({ v: 1, o: b64.encode(randomBytes(8)), u: [origin], r: null, k: b64.encode(randomBytes(32)), i: b64.encode(randomBytes(32)),
      c: b64.encode(randomBytes(16)), n: "Hetzner", x: Math.floor(Date.now() / 1000) + 120 });
    const pair = (payload: unknown) => app.inject({ method: "POST", url: "/api/instance-links", payload });

    const paired = await pair({ code, access });
    expect(paired.json()).toMatchObject({ error: { code: "INSTANCE_LINK" } });
    expect(seen.at(-1)).toMatchObject({ "cf-access-client-id": "client-id.access", "cf-access-client-secret": "SYNTHETIC-access-secret" });
    expect(paired.body).not.toContain("SYNTHETIC");

    const missing = await pair({ code, access: { ...access, clientSecret: "vault_key:notKeptKey01" } });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toMatchObject({ code: "VAULT_KEY_UNAVAILABLE", message: expect.stringContaining("vault_key:notKeptKey01") });
    expect(seen).toHaveLength(1);
    expect((await pair({ code, access: { clientId: "client-id.access", clientSecret: "SYNTHETIC" } })).statusCode).toBe(400);

    await pair({ code });
    expect(seen.at(-1)).not.toHaveProperty("cf-access-client-id");

    // A kept link connects with them too (its IK reconnect), and lists only the key ids.
    const id = "link:accessLink01";
    await repository.create({ id, ownerUserId: owner, label: "Hetzner", origins: [origin], noisePublic: b64.encode(randomBytes(32)), identityPublic: b64.encode(randomBytes(32)),
      deviceId: "appdev:x", scopes: ["read"], accessKeys: access, sealedDevicePrivate: crypto.seal(b64.encode(noiseKeyPair().privateKey), connectorSealContext("instance-link", owner, id)) });
    expect((await app.inject({ method: "POST", url: `/api/instance-links/${id}/check` })).statusCode).toBe(502);
    expect(seen.at(-1)).toMatchObject({ "cf-access-client-id": "client-id.access", "cf-access-client-secret": "SYNTHETIC-access-secret" });
    expect((await app.inject({ method: "GET", url: "/api/instance-links" })).json().links).toEqual([expect.objectContaining({ id, access })]);
    expect(JSON.stringify(audits)).not.toContain("SYNTHETIC");
  });
});
