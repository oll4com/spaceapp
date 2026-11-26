import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { noiseKeyPair, vaultBase64url as b64 } from "@space/contracts";

// The other SpaceApp, as connectInstanceLink would give it: `old` is one built before Λ4, whose strict frame schema refuses
// x-space-link-request and closes 4400 before running anything (spaceapp-hz on 0.2.5, 15/11).
const peer = vi.hoisted(() => ({ old: true, connects: 0, sent: [] as Array<{ m: string; p: string; rid?: string; session: number }> }));
vi.mock("../src/instance-link/client.js", async (actual) => ({
  ...(await actual<typeof import("../src/instance-link/client.js")>()),
  connectInstanceLink: async () => {
    const session = ++peer.connects;
    let code: number | null = null;
    return {
      scopes: ["read", "act"], rotated: null, closed: () => code, close: () => { code = 1000; },
      async request(m: string, p: string, _body: unknown, rid?: string) {
        if (code !== null) throw new Error("closed");
        if (peer.old && rid) { code = 4400; throw new Error("That SpaceApp closed the link: it refused a message."); }
        peer.sent.push({ m, p, rid, session });
        return { status: 200, body: p === "/api/control/v1/inspect" ? [{ id: "room:a", name: "Main" }] : { ok: true } };
      }
    };
  }
}));
const { connectorSealContext, createConnectorCrypto } = await import("../src/dot-connectors.js");
const { instanceLinksFor, registerInstanceLinks } = await import("../src/instance-link/routes.js");
const { LinkNotSentError } = await import("../src/instance-link/preflight.js");

describe("Space Link to a SpaceApp built before Λ4", () => {
  it("acts without the trace header where it is refused, never sending the act twice, and keeps it where it is taken", async () => {
    const owner = "user:linker", id = "link:oldPeerLink1";
    const store = { recordAuditEvent: async () => undefined, upsertUser: async () => ({ id: owner }), listAuditEventsSince: async () => [] };
    const crypto = createConnectorCrypto({ key: randomBytes(32).toString("base64"), legacySecrets: [] });
    const app = Fastify();
    const { repository } = registerInstanceLinks(app, { store: store as never, crypto, databaseUrl: null, routeOptions: {}, assertPerson: () => undefined, version: "1.0.0" });
    await repository.create({ id, ownerUserId: owner, label: "Hetzner", origins: ["http://127.0.0.1:9"], noisePublic: b64.encode(randomBytes(32)),
      identityPublic: b64.encode(randomBytes(32)), deviceId: "appdev:x", scopes: ["read", "act"], accessKeys: null,
      sealedDevicePrivate: crypto.seal(b64.encode(noiseKeyPair().privateKey), connectorSealContext("instance-link", owner, id)) });
    const links = instanceLinksFor(store)!;
    const open = { roomId: "room:a", requestId: "r1", actions: [{ kind: "resource", operation: "panes.open", input: { typeId: "claude" } }] };
    const commands = (session: number, rid: unknown) => ({ m: "POST", p: "/api/control/v1/commands", rid, session });

    expect(await links.request(owner, id, "POST", "/api/control/v1/commands", open)).toMatchObject({ status: 200 });
    expect(await links.request(owner, id, "POST", "/api/control/v1/commands", open)).toMatchObject({ status: 200 });
    // Its rooms are read once (the act names room:a); the probe broke the first session; both acts ran once each, on the second, without the
    // header; no second probe.
    expect(peer.sent).toEqual([{ m: "POST", p: "/api/control/v1/inspect", rid: undefined, session: 1 }, commands(2, undefined), commands(2, undefined)]);
    expect(peer.connects).toBe(2);

    // Once it is updated, the next session's probe passes and acts carry the trace again.
    peer.old = false; peer.sent.length = 0;
    await app.close();
    const fresh = Fastify();
    const again = registerInstanceLinks(fresh, { store: store as never, crypto, databaseUrl: null, routeOptions: {}, assertPerson: () => undefined, version: "1.0.0" });
    await again.repository.create({ ...(await repository.get(owner, id))! });
    expect(await instanceLinksFor(store)!.request(owner, id, "POST", "/api/control/v1/commands", open)).toMatchObject({ status: 200 });
    expect(peer.sent).toEqual([{ m: "POST", p: "/api/control/v1/inspect", rid: undefined, session: 3 },
      { m: "GET", p: "/api/auth/me", rid: expect.stringMatching(/^lnk:/), session: 3 }, commands(3, expect.stringMatching(/^lnk:/))]);
    // Daily Nous errors 26/11 11:15Z: a route it does not serve is held as not sent (space_remote refuses, never fails), and nothing reaches it.
    peer.sent.length = 0;
    const unserved = instanceLinksFor(store)!.request(owner, id, "GET", "/api/not-a-link-route");
    await expect(unserved).rejects.toBeInstanceOf(LinkNotSentError);
    await expect(unserved).rejects.toThrow("Not sent: GET /api/not-a-link-route is not a route a linked SpaceApp serves. It answers only GET /api/auth/me");
    expect(peer.sent).toEqual([]);
    await fresh.close();
  });
});
