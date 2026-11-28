import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { hashGatewayApiKey } from "@space/gateway";
import { nousCloudView, readNousCloud, registerNousCloudRoutes, type NousCloudGateway } from "../src/nous-cloud-routes.js";
import { nousOpsNousCloudText } from "../src/nous/ops-views.js";

// Nous Cloud telemetry (docs/agents/nous-cloud-telemetry.md): oll4.com's cloud-stats answer → the ADMIN view.
const now = Date.parse("2026-11-27T16:30:00Z");
const sec = (at: string) => Date.parse(at) / 1000;
const raw = {
  at: sec("2026-11-27T16:30:00Z"), days: 90,
  installs: [
    {
      person: 5, name: "Operator test", email: "operator-test@example.invalid", invite: "f91d383f650fc052", revoked: null, appVersion: 604, appSeen: sec("2026-11-26T14:00:00Z"),
      lastEvent: { at: sec("2026-11-27T16:21:57Z"), event: "usage", seconds: 300 },
      lastAppEvent: { at: sec("2026-11-27T15:39:16Z"), event: "cloud-opened", version: "0.1.8", device: "SM-S938B Android 17" },
      lastError: { at: sec("2026-11-27T12:34:01Z"), event: "cloud-error", version: "0.1.4", device: "SM-S938B Android 17", reason: "day-limit" },
      days: [
        { d: "2026-11-26", seconds: 0, events: { activated: 1 } },
        { d: "2026-11-27", seconds: 14400, events: { usage: 48, "cloud-error": 1 } },
        { d: "2026-11-10", seconds: 600, events: { usage: 2 } }
      ],
      box: {
        at: sec("2026-11-27T16:28:44Z"), usdPerHour: 0.3312, disk: [28_060_000_000, 10_700_000_000], mem: [8_340_000_000, 2_800_000_000], uptime: 14287.5, version: "1.2.4",
        db: {
          turns: [
            { d: "2026-11-27", m: "opencode/big-pickle", n: 21, e: 1, tk: 1_880_051, c: 0 },
            { d: "2026-11-26", m: "anthropic/claude-sonnet-5-5", n: 2, e: 0, tk: 1000, c: 0.25 },
            { d: "2026-10-01", m: "opencode/big-pickle", n: 9, e: 9, tk: 9, c: 9 }
          ],
          clis: [{ d: "2026-11-27", m: "google/gemini-3.8-flash", n: 2, tk: 500, c: 0 }],
          lastError: { at: "2026-11-27T16:09:00.000+00:00", text: "Transport: The socket connection was closed unexpectedly" },
          lastTurn: "2026-11-27T16:20:00+00:00", logins: 6, lastLogin: "2026-11-27T06:05:00+00:00", dbBytes: 40_400_000
        }
      }
    },
    {
      person: 7, name: "Operator test 2", email: "nous2@example.invalid", invite: "46e099c66b5a2a7c", revoked: null, appVersion: null, appSeen: null,
      lastEvent: { at: sec("2026-11-27T15:00:00Z"), event: "usage", seconds: 300 },
      lastAppEvent: { at: sec("2026-11-27T14:00:00Z"), event: "cloud-page-open", version: "web", device: "Android 10" },
      lastError: null, days: [{ d: "2026-11-27", seconds: 2400, events: { usage: 8 } }], box: null
    },
    { person: 6, name: "Lab", email: "lab@example.invalid", invite: "b2d8f88bcb05c15a", revoked: sec("2026-11-26T12:00:00Z"), lastEvent: { at: sec("2026-11-26T11:00:00Z"), event: "usage" }, days: [], box: null }
  ]
};

describe("Nous Cloud telemetry", () => {
  it("merges usage, turns and CLI events by day inside the window, with sandbox cost from the hourly rate", () => {
    const view = nousCloudView(raw, 7, now);
    const [box, thai, lab] = view.installs;
    expect(box).toMatchObject({ person: 5, status: "running", lastSeen: "2026-11-27T16:28:44.000Z", logins: 6, lastLogin: "2026-11-27T06:05:00.000Z",
      app: { version: "0.1.8", device: "SM-S938B Android 17", build: 604 },
      sandbox: { uptimeSeconds: 14287.5, version: "1.2.4", dbBytes: 40_400_000, disk: { size: 28_060_000_000, used: 10_700_000_000 }, memory: { total: 8_340_000_000, used: 2_800_000_000 } },
      lastError: { source: "sandbox", text: "Transport: The socket connection was closed unexpectedly", at: "2026-11-27T16:09:00.000Z" } });
    expect(box!.days.map((day) => day.d)).toEqual(["2026-11-27", "2026-11-26"]);
    expect(box!.days[0]).toMatchObject({ sandboxSeconds: 14400, requests: 23, errors: 1, tokens: 1_880_551, modelCostUsd: 0, events: { usage: 48, "cloud-error": 1 } });
    expect(box!.days[0]!.sandboxCostUsd).toBeCloseTo(4 * 0.3312);
    expect(box!.totals).toMatchObject({ requests: 25, errors: 1, tokens: 1_881_551, modelCostUsd: 0.25, sandboxSeconds: 14400 });
    expect(box!.models).toEqual([
      { model: "opencode/big-pickle", source: "nous", requests: 21, errors: 1, tokens: 1_880_051, costUsd: 0, free: true },
      { model: "anthropic/claude-sonnet-5-5", source: "nous", requests: 2, errors: 0, tokens: 1000, costUsd: 0.25, free: false },
      { model: "google/gemini-3.8-flash", source: "cli", requests: 2, errors: 0, tokens: 500, costUsd: 0, free: true }
    ]);
    expect(thai).toMatchObject({ status: "asleep", sandbox: null, lastError: null, totals: { sandboxSeconds: 2400, sandboxCostUsd: null, requests: 0 }, app: { device: "Android 10", build: null } });
    expect(lab).toMatchObject({ status: "revoked", revokedAt: "2026-11-26T12:00:00.000Z" });
    expect(JSON.stringify(view)).not.toMatch(/f91d383f650fc052|46e099c66b5a2a7c|invite/);
  });

  it("falls back to the app's latest error when the sandbox has none newer", () => {
    const noBoxError = { installs: [{ ...raw.installs[0], box: { ...raw.installs[0]!.box, db: { ...raw.installs[0]!.box!.db, lastError: null } } }] };
    expect(nousCloudView(noBoxError, 7, now).installs[0]!.lastError).toEqual({ at: "2026-11-27T12:34:01.000Z", text: "day-limit · app 0.1.4", source: "app" });
  });

  it("serves ADMIN only, sends the key only as a header, and tells Nous the same", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-cloud-"));
    writeFileSync(join(dir, "key"), "k".repeat(64) + "\n");
    const calls: Array<{ url: string; key: string | null }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, key: new Headers(init?.headers).get("x-oll4-key") });
      return new Response(JSON.stringify(raw));
    }) as typeof fetch;
    const report = await readNousCloud(3, fake, join(dir, "key"));
    expect(calls).toEqual([{ url: "https://oll4.com/beta/api/cloud-stats?days=3", key: "k".repeat(64) }]);
    expect(JSON.stringify(report)).not.toContain("k".repeat(64));
    await expect(readNousCloud(3, fake, join(dir, "missing"))).rejects.toThrow("not configured");

    const app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("onRequest", async (request) => {
      const role = request.headers["x-test-role"];
      (request as unknown as { user: unknown }).user = role ? { id: "user:proof", role } : null;
    });
    registerNousCloudRoutes(app, { routeOptions: {}, read: async (days) => nousCloudView(raw, days, now) });
    expect((await app.inject({ url: "/api/admin/nous-cloud?days=2", headers: { "x-test-role": "USER" } })).statusCode).toBe(403);
    const admin = await app.inject({ url: "/api/admin/nous-cloud?days=2", headers: { "x-test-role": "ADMIN" } });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().days).toBe(2);
    await app.close();

    expect(JSON.parse(await nousOpsNousCloudText({ nousCloud: async (days) => nousCloudView(raw, days, now) }, {})).installs).toHaveLength(3);
    expect(await nousOpsNousCloudText({}, {})).toContain("not available");
  });

  describe("Gateway for Nous Cloud boxes (plan clipboard:yw_pvUb_616N steps 2-3)", () => {
    const BOX_KEY = "sk-sgw-boxkeyboxkeyboxkeyboxkeyboxkey01";
    const keys = new Map<string, { name: string; isActive: boolean; expiresAt: string | null; allowedProviders?: string[] }>([
      [hashGatewayApiKey(BOX_KEY), { name: "Nous Cloud f91d383f650fc052", isActive: true, expiresAt: null, allowedProviders: ["codex"] }],
      [hashGatewayApiKey("sk-sgw-operatorkeyoperatorkeyoperator01"), { name: "Operator laptop", isActive: true, expiresAt: null, allowedProviders: ["codex"] }],
      [hashGatewayApiKey("sk-sgw-openkeyopenkeyopenkeyopenkey0001"), { name: "Nous Cloud open", isActive: true, expiresAt: null, allowedProviders: [] }],
      [hashGatewayApiKey("sk-sgw-revokedrevokedrevokedrevoked001"), { name: "Nous Cloud old", isActive: false, expiresAt: null, allowedProviders: ["codex"] }]
    ]);
    function setup(service?: NousCloudGateway["service"], provisionKeyFile?: string) {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("data: {\"x\":1}\n\ndata: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "no=1" } });
      }) as unknown as typeof fetch;
      const app = Fastify();
      registerNousCloudRoutes(app, { routeOptions: {}, fetchImpl, provisionKeyFile, gateway: { url: "http://127.0.0.1:4920/", keyByHash: async (hash) => keys.get(hash) ?? null, service } });
      return { app, calls };
    }

    it("forwards only /pools/space model routes, with the box's own key and the providers' headers", async () => {
      const { app, calls } = setup();
      const answer = await app.inject({ method: "POST", url: "/api/nous-cloud/gateway/v1/chat/completions", payload: { model: "auto", stream: true, messages: [] },
        headers: { authorization: `Bearer ${BOX_KEY}`, "x-space-gateway-route": "CLAUDE_API_KEY", "x-space-internal-token": "guess", "openai-beta": "b" } });
      expect(answer.statusCode).toBe(200);
      expect(answer.headers["content-type"]).toBe("text/event-stream");
      expect(answer.headers["set-cookie"]).toBeUndefined();
      expect(answer.body).toContain("[DONE]");
      expect(calls[0]!.url).toBe("http://127.0.0.1:4920/pools/space/v1/chat/completions");
      const sent = calls[0]!.init.headers as Record<string, string>;
      expect(sent).toMatchObject({ authorization: `Bearer ${BOX_KEY}`, "openai-beta": "b", "content-type": "application/json" });
      expect(sent["x-space-gateway-route"]).toBeUndefined();
      expect(sent["x-space-internal-token"]).toBeUndefined();
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ model: "auto", stream: true, messages: [] });
      expect((await app.inject({ method: "GET", url: "/api/nous-cloud/gateway/v1/models", headers: { "x-api-key": BOX_KEY } })).statusCode).toBe(200);
      expect(calls[1]!.url).toBe("http://127.0.0.1:4920/pools/space/v1/models");
      for (const url of ["/api/nous-cloud/gateway/v1/embeddings", "/api/nous-cloud/gateway/v1/../v1/admin", "/api/nous-cloud/gateway/v1/chat/completions/../../x"]) {
        expect((await app.inject({ method: "POST", url, payload: {}, headers: { authorization: `Bearer ${BOX_KEY}` } })).statusCode, url).toBe(404);
      }
      expect(calls).toHaveLength(2);
    });

    it("refuses every key that is not an active Nous Cloud key with a provider list", async () => {
      const { app, calls } = setup();
      for (const key of [null, "sk-sgw-operatorkeyoperatorkeyoperator01", "sk-sgw-openkeyopenkeyopenkeyopenkey0001", "sk-sgw-revokedrevokedrevokedrevoked001", "sk-sgw-unknownunknownunknownunknown01"]) {
        const answer = await app.inject({ method: "POST", url: "/api/nous-cloud/gateway/v1/messages", payload: {}, headers: key ? { authorization: `Bearer ${key}` } : {} });
        expect(answer.statusCode, String(key)).toBe(401);
      }
      expect(calls).toHaveLength(0);
    });

    it("lets only the provisioner create, rotate and revoke an account's key, keeping the admin's lists on rotate", async () => {
      const dir = mkdtempSync(join(tmpdir(), "nous-cloud-provision-"));
      writeFileSync(join(dir, "key"), "provision-secret\n");
      const stored: Array<Record<string, unknown> & { id: string; name: string; isActive: boolean }> = [];
      let serial = 0;
      const service = () => ({
        listApiKeys: async () => ({ data: stored }),
        createApiKey: async (input: Record<string, unknown>) => {
          const key = { ...input, id: `gwkey:${++serial}`, isActive: true } as (typeof stored)[number];
          stored.push(key);
          return { key, plainKey: `sk-sgw-plain${serial}` };
        },
        regenerateApiKey: async (id: string) => ({ key: stored.find((key) => key.id === id)!, plainKey: `sk-sgw-plain${++serial}` }),
        updateApiKey: async (id: string, patch: Record<string, unknown>) => Object.assign(stored.find((key) => key.id === id)!, patch)
      }) as unknown as NonNullable<NousCloudGateway["service"]>;
      const { app } = setup(service, join(dir, "key"));
      const url = "/api/nous-cloud/accounts/f91d383f650fc052/gateway-key";
      const provisioner = { "x-space-provision-key": "provision-secret" };

      expect((await app.inject({ method: "POST", url })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url, headers: { "x-space-provision-key": "wrong" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "DELETE", url, headers: { "x-space-provision-key": "wrong" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/nous-cloud/accounts/BAD..id/gateway-key", headers: provisioner })).statusCode).toBeGreaterThanOrEqual(400);

      const first = (await app.inject({ method: "POST", url, headers: provisioner })).json();
      expect(first).toEqual({ keyId: "gwkey:1", plainKey: "sk-sgw-plain1", path: "/api/nous-cloud/gateway/v1", rotated: false });
      expect(stored[0]).toMatchObject({ name: "Nous Cloud f91d383f650fc052", trafficClass: "BACKGROUND", allowedProviders: ["codex"],
        limits: [{ limitType: "COST_USD", limitWindow: "DAILY", maxValue: 5_000_000, modelFilter: null }] });

      stored[0]!.allowedModels = ["gpt-cheap"];
      expect((await app.inject({ method: "DELETE", url, headers: provisioner })).json()).toEqual({ revoked: true });
      expect(stored[0]!.isActive).toBe(false);
      const second = (await app.inject({ method: "POST", url, headers: provisioner })).json();
      expect(second).toMatchObject({ keyId: "gwkey:1", rotated: true });
      expect(second.plainKey).not.toBe(first.plainKey);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ isActive: true, allowedModels: ["gpt-cheap"] });
    });

    it("has no account-key routes without a provisioner key file", async () => {
      const service = (() => { throw new Error("must not be reached"); }) as unknown as NonNullable<NousCloudGateway["service"]>;
      const { app } = setup(service, join(tmpdir(), "nous-cloud-no-such-key"));
      expect((await app.inject({ method: "POST", url: "/api/nous-cloud/accounts/f91d383f650fc052/gateway-key", headers: { "x-space-provision-key": "" } })).statusCode).toBe(401);
    });
  });
});
