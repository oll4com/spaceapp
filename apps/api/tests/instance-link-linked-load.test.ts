import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { noiseKeyPair, vaultBase64url as b64, type NousLoad } from "@space/contracts";
import { linkedLoadRow, type LinkedLoadInput } from "../src/instance-link/linked-load.js";

// A SpaceApp on 0.2.5 as connectInstanceLink gives it: /api/nous/load is not in its link's routes (403), its SYSTEM_HEALTH inspect is.
const sent = vi.hoisted(() => [] as Array<{ m: string; p: string; body: unknown; rid?: string }>);
vi.mock("../src/instance-link/client.js", async (actual) => ({
  ...(await actual<typeof import("../src/instance-link/client.js")>()),
  connectInstanceLink: async () => ({
    scopes: ["read", "act"], rotated: null, closed: () => null, close: () => undefined,
    async request(m: string, p: string, body: unknown, rid?: string) {
      sent.push({ m, p, body, rid });
      if (p.startsWith("/api/nous/load")) return { status: 403, body: { error: { code: "MOBILE_SCOPE_DENIED", message: "Not for this device." } } };
      if (p === "/api/control/v1/inspect") return { status: 200, body: { section: "SYSTEM_HEALTH", metrics: [{ id: "cpu", value: 21 }, { id: "memory", value: 64 }] } };
      return { status: 200, body: { overview: { live: { agents: { running: 2, total: 3 } } } } };
    }
  })
}));
const { connectorSealContext, createConnectorCrypto } = await import("../src/dot-connectors.js");
const { registerInstanceLinks } = await import("../src/instance-link/routes.js");

const load = (overall: number): NousLoad => ({ at: "2026-11-15T02:00:00.000Z", overall, target: 90, level: "BUSY", limit: null, range: "1h", series: [],
  averages: { hour: { value: null, previous: null }, today: { value: null, previous: null }, week: { value: null, previous: null }, month: { value: null, previous: null }, bestDay: null },
  parts: [
    { key: "cpu", label: "CPU", percent: 40, detail: "8 cores" }, { key: "memory", label: "Memory", percent: 55, detail: "17.6 of 32 GiB in use" },
    { key: "load", label: "Load", percent: 30, detail: "2.4 on 8 cores (5 min)" }, { key: "pressure", label: "Pressure", percent: 5, detail: "this VM: stalls cpu 1%, memory 0%, io 5% · swap 0%" },
    { key: "tokens", label: "Tokens", percent: 70, detail: "Claude Max 70%" }, { key: "panes", label: "CLI panes", percent: 50, detail: "2 of 4 working" }
  ] });
const input = (id: string, origin: string, rest: Partial<LinkedLoadInput>): LinkedLoadInput =>
  ({ link: { id, label: id.slice(5), origins: [origin] }, load: null, health: null, agents: null, answered: false, answeredAt: null, error: null, ...rest });

describe("a linked SpaceApp's load row", () => {
  it("maps one link that answers its load: CPU, Memory, Load, Pressure and CLI panes, never its tokens", () => {
    expect(linkedLoadRow(input("link:hz", "https://example.invalid", { load: load(62), answered: true, answeredAt: "2026-11-15T02:00:01.000Z" }))).toEqual({
      id: "link:hz", label: "hz", host: "example.invalid", answering: true, answeredAt: "2026-11-15T02:00:01.000Z", overall: 62, level: "BUSY", error: null,
      parts: load(62).parts.filter((part) => part.key !== "tokens") });
  });

  it("maps three links: one on its load, one built before /api/nous/load on its health and overview, one not answering", () => {
    const rows = [
      input("link:a", "https://a.example:4911", { load: load(80), answered: true, answeredAt: "2026-11-15T02:00:00.000Z" }),
      input("link:b", "https://b.example", { answered: true, answeredAt: "2026-11-15T02:00:00.000Z", agents: { running: 3, total: 5 },
        health: [{ id: "cpu", value: 12.345 }, { id: "memory", value: 47 }, { id: "memory-used", value: 8 * 2 ** 30, total: 16 * 2 ** 30 }, { id: "swap", value: 3 }] }),
      input("link:c", "https://c.example", { error: "That SpaceApp did not answer.", answeredAt: "2026-11-15T01:10:00.000Z", agents: { running: 9, total: 9 } })
    ].map(linkedLoadRow);
    expect(rows.map((row) => [row.host, row.answering, row.overall])).toEqual([["a.example", true, 80], ["b.example", true, null], ["c.example", false, null]]);
    expect(rows[1]!.parts).toEqual([
      { key: "cpu", label: "CPU", percent: 12.3, detail: "in use" }, { key: "memory", label: "Memory", percent: 47, detail: "8.0 of 16 GiB in use" },
      { key: "panes", label: "CLI panes", percent: 60, detail: "3 of 5 working" }]);
    // The one not answering stays listed with when it last answered and why, without its last overview's panes.
    expect(rows[2]).toMatchObject({ answering: false, answeredAt: "2026-11-15T01:10:00.000Z", error: "That SpaceApp did not answer.", parts: [] });
    expect(rows.filter((row) => row.answering)).toHaveLength(2);
  });
});

describe("GET /api/instance-links/load against a SpaceApp built before its link reached /api/nous/load", () => {
  it("reads its SYSTEM_HEALTH inspect instead, never an act, and shows its CPU and Memory as answering", async () => {
    const owner = "user:loader", id = "link:oldLoadLink1";
    const store = { recordAuditEvent: async () => undefined, upsertUser: async () => ({ id: owner }), listAuditEventsSince: async () => [] };
    const crypto = createConnectorCrypto({ key: randomBytes(32).toString("base64"), legacySecrets: [] });
    const app = Fastify();
    app.addHook("onRequest", async (request) => { request.user = { id: owner } as never; });
    const { repository } = registerInstanceLinks(app, { store: store as never, crypto, databaseUrl: null, routeOptions: {}, assertPerson: () => undefined, version: "1.0.0" });
    await repository.create({ id, ownerUserId: owner, label: "Hetzner", origins: ["https://example.invalid"], noisePublic: b64.encode(randomBytes(32)),
      identityPublic: b64.encode(randomBytes(32)), deviceId: "appdev:x", scopes: ["read", "act"], accessKeys: null,
      sealedDevicePrivate: crypto.seal(b64.encode(noiseKeyPair().privateKey), connectorSealContext("instance-link", owner, id)) });
    const { row } = (await app.inject({ method: "GET", url: "/api/instance-links/load" })).json().instances[0];
    expect(row).toMatchObject({ id, host: "example.invalid", answering: true, answeredAt: expect.any(String), overall: null, error: null,
      parts: [{ key: "cpu", percent: 21 }, { key: "memory", percent: 64 }] });
    expect(sent.filter((frame) => frame.p !== "/api/nous/overview")).toEqual([{ m: "GET", p: "/api/nous/load?range=1h", body: undefined, rid: undefined },
      { m: "POST", p: "/api/control/v1/inspect", body: { section: "SYSTEM_HEALTH" }, rid: undefined }]);
    await app.close();
  });
});
