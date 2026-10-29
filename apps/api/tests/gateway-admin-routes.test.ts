import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryGatewayRepository } from "@space/db";
import { hashGatewayApiKey } from "@space/gateway";
import { createCsrfToken, signSession } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createGatewayAdminService } from "../src/gateway/gateway-service.js";

const sessionSecret = "gateway-admin-test-secret";
const apps: FastifyInstance[] = [];
const accountId = `gw_account:${"1".repeat(32)}`;

function authHeaders(role: "USER" | "OPERATOR" | "ADMIN") {
  const session = signSession({ id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role }, sessionSecret);
  return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };
}

async function setup(fetchImpl: typeof fetch = vi.fn(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED 127.0.0.1:4920") }); }) as unknown as typeof fetch, internalToken: string | null = null,
  antigravityProfileSource?: { list(): Promise<{ profileId: string; tokenPath: string }[]>; read(path: string): Promise<string> }, spaceOpenAiKeyFile?: string,
  spaceClaudeKeyFile?: string) {
  const repository = new InMemoryGatewayRepository();
  repository.accounts.push({
    id: accountId, provider: "CODEX", label: "Team A", alias: null, email: "a@example.test", planType: "plus", status: "ACTIVE", statusReason: null,
    priority: 100, warmupEnabled: false, resetCreditsAvailable: 1, primaryWindow: { usedPercent: 40, resetAt: null, windowMinutes: 300 },
    secondaryWindow: { usedPercent: 10, resetAt: null, windowMinutes: 10080 }, lastRefreshAt: null, lastUsedAt: null,
    createdAt: "2026-10-11T00:00:00.000Z", externalAccountId: "chatgpt-a", credentialsEncrypted: "v1.secret-envelope",
    credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, blockedUntil: null
  });
  const store = new InMemorySpaceStore();
  const app = await createApp({
    store,
    config: getApiConfig({}),
    auth: { sessionSecret, devLogin: false, secureCookies: false },
    gatewayAdminService: createGatewayAdminService({ repository, gatewayUrl: "http://127.0.0.1:4920", fetchImpl, internalToken, antigravityProfileSource, spaceOpenAiKeyFile,
      spaceClaudeKeyFile })
  });
  apps.push(app);
  return { app, repository, store };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Space Gateway admin routes", () => {
  it("are limited to administrators", async () => {
    const { app } = await setup();
    for (const role of ["USER", "OPERATOR"] as const) {
      const response = await app.inject({ url: "/api/admin/gateway/status", headers: authHeaders(role) });
      // A USER reaches only its own rooms' routes; everything else is not found (MU-001).
      expect(response.statusCode).toBe(role === "USER" ? 404 : 403);
    }
    expect((await app.inject({ url: "/api/admin/gateway/status" })).statusCode).toBe(401);
  });

  it("reports a stopped service and never returns credential envelopes", async () => {
    const { app } = await setup();
    const status = (await app.inject({ url: "/api/admin/gateway/status", headers: authHeaders("ADMIN") })).json();
    expect(status.service).toMatchObject({ state: "NOT_INSTALLED", error: "Space Gateway is not running." });
    expect(status.accounts).toEqual({ total: 1, active: 1, byProvider: [{ provider: "CODEX", total: 1, active: 1 }] });
    // The Claude API-key account's pace to the monthly budget: none without a budget and Anthropic billing (plan clipboard:nUloPOH3blDT step 6).
    expect(status.apiBudget).toBeNull();
    const accounts = await app.inject({ url: "/api/admin/gateway/accounts", headers: authHeaders("ADMIN") });
    expect(accounts.body).not.toContain("secret-envelope");
    expect(accounts.body).not.toContain("chatgpt-a");
    expect(accounts.json().data[0]).toMatchObject({ id: accountId, primaryWindow: { usedPercent: 40 } });
  });

  it("reports the Claude API key account and what went through it", async () => {
    const { app, repository } = await setup();
    const none = (await app.inject({ url: "/api/admin/gateway/claude-api-key", headers: authHeaders("ADMIN") })).json();
    expect(none).toMatchObject({ fallbackEnabled: false, account: null });
    const keyId = `gw_account:${"d".repeat(32)}`;
    repository.accounts.push({ ...repository.accounts[0]!, id: keyId, provider: "CLAUDE", label: "Claude API key …kkkk", email: null, planType: "api",
      source: "API_KEY", sourceRef: "space-claude", externalAccountId: "key:k", lastUsedAt: "2026-10-13T08:00:00.000Z",
      primaryWindow: { usedPercent: null, resetAt: null, windowMinutes: null }, secondaryWindow: { usedPercent: null, resetAt: null, windowMinutes: null } });
    await repository.updateSettings({ claudeApiKeyFallback: true });
    await repository.insertRequestLogs([{ requestId: "req_key_1", requestedAt: "2026-10-13T08:00:00.000Z", provider: "CLAUDE", accountId: keyId, apiKeyId: null,
      model: "claude-sonnet-4-5", reasoningEffort: null, requestedServiceTier: null, serviceTier: null, transport: "http", upstreamTransport: "http", status: "success",
      errorCode: null, errorMessage: null, latencyMs: 900, firstTokenMs: null, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: null,
      costUsd: 0.0045, compressionTokensSaved: null, stickyKind: null, stickyKeyHash: null, planType: "api", stickyKeySource: null, cacheCreationTokens: null,
      clientName: "Claude Code", project: null, compressionTokensBefore: null, compressionTokensAfter: null, compressionDetail: null, source: null, cacheBust: null }]);
    const used = (await app.inject({ url: "/api/admin/gateway/claude-api-key", headers: authHeaders("ADMIN") })).json();
    expect(used).toMatchObject({ fallbackEnabled: true, account: { id: keyId, label: "Claude API key …kkkk", status: "ACTIVE", lastUsedAt: "2026-10-13T08:00:00.000Z", requests: 1, costUsd: 0.0045 } });
    expect(JSON.stringify(used)).not.toContain("secret-envelope");
    expect((await app.inject({ url: "/api/admin/gateway/claude-api-key", headers: authHeaders("OPERATOR") })).statusCode).toBe(403);
  });

  it("reads the running service state from the gateway status endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: "0.2.5", startedAt: "2026-10-11T10:00:00.000Z", inFlightRequests: 2, draining: false, listen: "127.0.0.1:4920" })));
    const { app } = await setup(fetchImpl as unknown as typeof fetch);
    const status = (await app.inject({ url: "/api/admin/gateway/status", headers: authHeaders("ADMIN") })).json();
    expect(status.service).toEqual({ state: "RUNNING", version: "0.2.5", startedAt: "2026-10-11T10:00:00.000Z", inFlightRequests: 2, listen: "127.0.0.1:4920", error: null });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4920/__space-gateway/status", expect.anything());
  });

  it("shows the LAN listener next to the loopback address", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: "0.2.6", startedAt: "2026-10-12T10:00:00.000Z", inFlightRequests: 0, draining: false, listen: "127.0.0.1:4920", lanListen: "192.0.2.207:4925" })));
    const { app } = await setup(fetchImpl as unknown as typeof fetch);
    const status = (await app.inject({ url: "/api/admin/gateway/status", headers: authHeaders("ADMIN") })).json();
    expect(status.service.listen).toBe("127.0.0.1:4920, LAN 192.0.2.207:4925");
  });

  it("creates a key once, stores only its hash, and audits key changes", async () => {
    const { app, repository, store } = await setup();
    const created = await app.inject({
      method: "POST", url: "/api/admin/gateway/keys", headers: authHeaders("ADMIN"),
      payload: { name: "Codex CLI", accountIds: [accountId], allowedReasoningEfforts: ["high"], limits: [{ limitType: "TOTAL_TOKENS", limitWindow: "DAILY", maxValue: 1000 }] }
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    const body = created.json();
    expect(body.plainKey).toMatch(/^sk-sgw-/);
    expect(body.key).toMatchObject({ name: "Codex CLI", accountScopeEnabled: true, accountIds: [accountId], keyPrefix: body.plainKey.slice(0, 15) });
    expect(body.key).not.toHaveProperty("keyHash");
    expect(repository.keys[0]!.keyHash).toBe(hashGatewayApiKey(body.plainKey));
    const listed = await app.inject({ url: "/api/admin/gateway/keys", headers: authHeaders("ADMIN") });
    expect(listed.body).not.toContain(body.plainKey);

    const disabled = await app.inject({ method: "PATCH", url: `/api/admin/gateway/keys/${body.key.id}`, headers: authHeaders("ADMIN"), payload: { isActive: false } });
    expect(disabled.json().isActive).toBe(false);
    const removed = await app.inject({ method: "DELETE", url: `/api/admin/gateway/keys/${body.key.id}`, headers: authHeaders("ADMIN") });
    expect(removed.json()).toEqual({ id: body.key.id, deleted: true });
    const actions = (await store.listAuditEvents?.({ limit: 20 }) ?? []).map((event: { action: string }) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["admin.gateway.key.create", "admin.gateway.key.update", "admin.gateway.key.delete"]));
  });

  it("scopes a key to the Codex accounts with one enforced model, then rotates it in place (summary-tools-key)", async () => {
    const { app, repository } = await setup();
    const scope = { trafficClass: "BACKGROUND", allowedModels: ["gpt-5.6-luna"], enforcedModel: "gpt-5.6-luna", accountIds: [accountId] };
    const created = await app.inject({ method: "POST", url: "/api/admin/gateway/keys", headers: authHeaders("ADMIN"), payload: { name: "space-summary-tools", ...scope } });
    expect(created.statusCode).toBe(201);
    const { key, plainKey } = created.json();
    expect(key).toMatchObject({ name: "space-summary-tools", ...scope });
    const patched = await app.inject({ method: "PATCH", url: `/api/admin/gateway/keys/${key.id}`, headers: authHeaders("ADMIN"), payload: { ...scope, isActive: true } });
    expect(patched.json()).toMatchObject({ id: key.id, isActive: true, enforcedModel: "gpt-5.6-luna" });
    const rotated = await app.inject({ method: "POST", url: `/api/admin/gateway/keys/${key.id}/regenerate`, headers: authHeaders("ADMIN"), payload: {} });
    expect(rotated.json().key.id).toBe(key.id);
    expect(rotated.json().plainKey).toMatch(/^sk-sgw-/);
    expect(rotated.json().plainKey).not.toBe(plainKey);
    expect(repository.keys.find((entry) => entry.id === key.id)!.keyHash).toBe(hashGatewayApiKey(rotated.json().plainKey));
  });

  it("rejects keys scoped to unknown accounts", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "POST", url: "/api/admin/gateway/keys", headers: authHeaders("ADMIN"),
      payload: { name: "Ghost", accountIds: [`gw_account:${"9".repeat(32)}`] } });
    expect(response.statusCode).toBe(422);
  });

  it("pauses accounts and validates settings updates", async () => {
    const { app } = await setup();
    const paused = await app.inject({ method: "PATCH", url: `/api/admin/gateway/accounts/${accountId}`, headers: authHeaders("ADMIN"), payload: { paused: true } });
    expect(paused.json()).toMatchObject({ status: "PAUSED", statusReason: "Paused by an administrator." });
    const settings = await app.inject({ method: "PATCH", url: "/api/admin/gateway/settings", headers: authHeaders("ADMIN"), payload: { routingStrategy: "FILL_FIRST", compressionMode: "ON" } });
    expect(settings.json()).toMatchObject({ routingStrategy: "FILL_FIRST", compressionMode: "ON" });
    // Shadow is no longer a compression setting.
    const shadow = await app.inject({ method: "PATCH", url: "/api/admin/gateway/settings", headers: authHeaders("ADMIN"), payload: { compressionMode: "SHADOW" } });
    expect(shadow.statusCode).toBeGreaterThanOrEqual(400);
    const invalid = await app.inject({ method: "PATCH", url: "/api/admin/gateway/settings", headers: authHeaders("ADMIN"), payload: { routingStrategy: "RANDOM" } });
    expect(invalid.statusCode).toBe(422);
    const empty = await app.inject({ method: "PATCH", url: "/api/admin/gateway/settings", headers: authHeaders("ADMIN"), payload: {} });
    expect(empty.statusCode).toBe(422);
    // Per-provider compression and output policy replace the whole object; unknown providers and fields are refused.
    const providers = { CLAUDE: { mode: "OFF", outputPolicy: "LEAN" }, CODEX: { profile: "CACHE", timeBudgetMs: 400 } };
    const perProvider = await app.inject({ method: "PATCH", url: "/api/admin/gateway/settings", headers: authHeaders("ADMIN"), payload: { compressionProviders: providers } });
    expect(perProvider.json().compressionProviders).toEqual(providers);
    expect((await app.inject({ url: "/api/admin/gateway/settings", headers: authHeaders("ADMIN") })).json().compressionProviders).toEqual(providers);
    for (const payload of [{ compressionProviders: { OPENAI_API: { mode: "ON" } } }, { compressionProviders: { CLAUDE: { outputPolicy: "LOUD" } } },
      { compressionProviders: { CLAUDE: { recoverable: true } } }]) {
      expect((await app.inject({ method: "PATCH", url: "/api/admin/gateway/settings", headers: authHeaders("ADMIN"), payload })).statusCode).toBe(422);
    }
  });

  it("keeps a key's output policy override", async () => {
    const { app } = await setup();
    const created = (await app.inject({ method: "POST", url: "/api/admin/gateway/keys", headers: authHeaders("ADMIN"),
      payload: { name: "Space jobs", outputPolicyOverride: "OFF" } })).json();
    expect(created.key.outputPolicyOverride).toBe("OFF");
    const updated = await app.inject({ method: "PATCH", url: `/api/admin/gateway/keys/${created.key.id}`, headers: authHeaders("ADMIN"), payload: { outputPolicyOverride: null } });
    expect(updated.json().outputPolicyOverride).toBeNull();
    const defaulted = (await app.inject({ method: "POST", url: "/api/admin/gateway/keys", headers: authHeaders("ADMIN"), payload: { name: "CLI" } })).json();
    expect(defaulted.key.outputPolicyOverride).toBeNull();
  });

  it("refuses to resume a free-plan account", async () => {
    const { app, repository } = await setup();
    Object.assign(repository.accounts[0]!, { planType: "free", status: "PAUSED", statusReason: "Free plan: paused automatically." });
    const resume = await app.inject({ method: "PATCH", url: `/api/admin/gateway/accounts/${accountId}`, headers: authHeaders("ADMIN"),
      payload: { paused: false, alias: "Spare" } });
    expect(resume.statusCode).toBe(409);
    expect(resume.json()).toMatchObject({ error: { code: "GATEWAY_ACCOUNT_FREE_PLAN" } });
    expect(repository.accounts[0]).toMatchObject({ status: "PAUSED", alias: null });
    // On a paid plan again (a new sign-in), it resumes.
    repository.accounts[0]!.planType = "plus";
    const paid = await app.inject({ method: "PATCH", url: `/api/admin/gateway/accounts/${accountId}`, headers: authHeaders("ADMIN"), payload: { paused: false } });
    expect(paid.json()).toMatchObject({ status: "ACTIVE", statusReason: null });
  });

  it("pages request logs with a numeric cursor", async () => {
    const { app, repository } = await setup();
    await repository.insertRequestLogs(Array.from({ length: 3 }, (_, index) => ({
      requestId: `r${index}`, requestedAt: `2026-10-11T0${index}:00:00.000Z`, provider: "CODEX" as const, accountId, apiKeyId: null,
      model: "gpt-5.6-sol", reasoningEffort: null, serviceTier: null, transport: "http", status: "success", errorCode: null, latencyMs: 10,
      firstTokenMs: 5, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: null, costUsd: 0, compressionTokensSaved: null,
      stickyKind: null, stickyKeyHash: null
    })));
    const first = (await app.inject({ url: "/api/admin/gateway/logs?limit=2", headers: authHeaders("ADMIN") })).json();
    expect(first.data.map((row: { requestId: string }) => row.requestId)).toEqual(["r2", "r1"]);
    expect(first.nextCursor).toBe(first.data[1].id);
    const second = (await app.inject({ url: `/api/admin/gateway/logs?limit=2&cursor=${first.nextCursor}`, headers: authHeaders("ADMIN") })).json();
    expect(second).toMatchObject({ data: [{ requestId: "r0" }], nextCursor: null });
    expect((await app.inject({ url: "/api/admin/gateway/logs?cursor=abc", headers: authHeaders("ADMIN") })).statusCode).toBe(422);
  });

  it("relays Codex sign-in to the gateway with the internal token and audits new accounts", async () => {
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/poll")
      ? { status: "CONNECTED", account: { id: accountId, provider: "CODEX", label: "a@example.test", email: "a@example.test", planType: "plus", status: "ACTIVE" } }
      : { flowId: "f".repeat(32), verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH", intervalSeconds: 5, expiresInSeconds: 600 }), { status: 200 }));
    const { app, store } = await setup(fetchImpl as unknown as typeof fetch, "internal-secret");
    const started = await app.inject({ method: "POST", url: "/api/admin/gateway/codex/device", headers: authHeaders("ADMIN") });
    expect(started.json()).toMatchObject({ userCode: "ABCD-EFGH" });
    expect(started.headers["cache-control"]).toBe("no-store");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4920/__space-gateway/admin/codex/device");
    expect((init.headers as Record<string, string>)["x-space-internal-token"]).toBe("internal-secret");
    const polled = await app.inject({ method: "POST", url: `/api/admin/gateway/codex/device/${"f".repeat(32)}/poll`, headers: authHeaders("ADMIN") });
    expect(polled.json()).toMatchObject({ status: "CONNECTED" });
    expect((await app.inject({ method: "POST", url: "/api/admin/gateway/codex/device/not-a-flow/poll", headers: authHeaders("ADMIN") })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: "/api/admin/gateway/codex/device", headers: authHeaders("OPERATOR") })).statusCode).toBe(403);
    const actions = (await store.listAuditEvents?.({ limit: 20 }) ?? []).map((event: { action: string }) => event.action);
    expect(actions).toContain("admin.gateway.account.add");
  });

  it("relays Claude sign-in with the pasted code", async () => {
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/complete")
      ? { status: "CONNECTED", account: { id: accountId, provider: "CLAUDE", label: "max@example.test", email: null, planType: "max20x", status: "ACTIVE" } }
      : { flowId: "c".repeat(32), authorizationUrl: "https://claude.com/cai/oauth/authorize?state=s" }), { status: 200 }));
    const { app, store } = await setup(fetchImpl as unknown as typeof fetch, "internal-secret");
    const started = await app.inject({ method: "POST", url: "/api/admin/gateway/claude/browser", headers: authHeaders("ADMIN") });
    expect(started.json()).toMatchObject({ flowId: "c".repeat(32) });
    const done = await app.inject({ method: "POST", url: `/api/admin/gateway/claude/browser/${"c".repeat(32)}/complete`, headers: authHeaders("ADMIN"),
      payload: { code: "abcdefgh#s" } });
    expect(done.json()).toMatchObject({ status: "CONNECTED", account: { provider: "CLAUDE" } });
    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:4920/__space-gateway/admin/claude/browser/${"c".repeat(32)}/complete`);
    expect(JSON.parse(String(init.body))).toEqual({ code: "abcdefgh#s" });
    expect((await app.inject({ method: "POST", url: `/api/admin/gateway/claude/browser/${"c".repeat(32)}/complete`, headers: authHeaders("ADMIN"),
      payload: { code: "" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: "/api/admin/gateway/claude/browser", headers: authHeaders("OPERATOR") })).statusCode).toBe(403);
    const events = (await store.listAuditEvents?.({ limit: 20 }) ?? []) as Array<{ action: string; metadata?: Record<string, unknown> }>;
    expect(events.some((event) => event.action === "admin.gateway.account.add" && event.metadata?.provider === "CLAUDE")).toBe(true);
  });

  it("lists signed-in Antigravity profiles and hands one profile's sign-in to the gateway", async () => {
    const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;
    const files: Record<string, string> = {
      "/p/main": JSON.stringify({ token: { refresh_token: "rt-main" }, id_token: idToken("main@example.com") }),
      "/p/work": JSON.stringify({ token: { refresh_token: "rt-work" }, id_token: idToken("work@example.com") })
    };
    const source = { list: async () => [{ profileId: "main", tokenPath: "/p/main" }, { profileId: "work", tokenPath: "/p/work" }, { profileId: "empty", tokenPath: "/p/none" }],
      read: async (path: string) => { if (!(path in files)) throw new Error("missing"); return files[path]!; } };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "CONNECTED", account: { id: accountId, provider: "ANTIGRAVITY", label: "work@example.com" } })));
    const { app, repository } = await setup(fetchImpl as unknown as typeof fetch, "internal-secret", source);
    repository.accounts.push({ ...repository.accounts[0]!, id: `gw_account:${"e".repeat(32)}`, provider: "ANTIGRAVITY", email: "main@example.com", externalAccountId: "sub-main" });
    const listed = await app.inject({ method: "GET", url: "/api/admin/gateway/antigravity/profiles", headers: authHeaders("ADMIN") });
    expect(listed.json()).toEqual({ data: [{ profileId: "main", email: "main@example.com", inGateway: true }, { profileId: "work", email: "work@example.com", inGateway: false }] });
    expect(listed.body).not.toContain("rt-");
    const imported = await app.inject({ method: "POST", url: "/api/admin/gateway/antigravity/import", headers: authHeaders("ADMIN"), payload: { profileId: "work" } });
    expect(imported.json()).toMatchObject({ status: "CONNECTED" });
    expect(imported.body).not.toContain("rt-work");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4920/__space-gateway/admin/antigravity/import");
    expect(JSON.parse(String(init.body))).toEqual({ tokenJson: files["/p/work"], sourceRef: "work" });
    expect((await app.inject({ method: "POST", url: "/api/admin/gateway/antigravity/import", headers: authHeaders("ADMIN"), payload: { profileId: "empty" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/admin/gateway/antigravity/profiles", headers: authHeaders("OPERATOR") })).statusCode).toBe(403);
  });

  it("adds an OpenAI API key, pasted or from the server's Space key, without echoing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-openai-key-"));
    const keyFile = join(directory, "space-openai-voice.key");
    await writeFile(keyFile, `sk-proj-${"s".repeat(40)}\n`);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "CONNECTED", account: { id: accountId, provider: "OPENAI_API", label: "OpenAI API key …ssss" } })));
    const { app } = await setup(fetchImpl as unknown as typeof fetch, "internal-secret", undefined, keyFile);
    const fromSpace = await app.inject({ method: "POST", url: "/api/admin/gateway/api-key/add", headers: authHeaders("ADMIN"), payload: { provider: "OPENAI_API", useSpaceKey: true } });
    expect(fromSpace.json()).toMatchObject({ status: "CONNECTED" });
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ provider: "OPENAI_API", apiKey: `sk-proj-${"s".repeat(40)}`, sourceRef: "space-openai-voice" });
    const pasted = await app.inject({ method: "POST", url: "/api/admin/gateway/api-key/add", headers: authHeaders("ADMIN"), payload: { provider: "OPENAI_API", apiKey: `sk-proj-${"p".repeat(40)}`, label: "Embeddings" } });
    expect(pasted.body).not.toContain("sk-proj");
    expect(JSON.parse(String((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toMatchObject({ apiKey: `sk-proj-${"p".repeat(40)}`, label: "Embeddings" });
    expect((await app.inject({ method: "POST", url: "/api/admin/gateway/api-key/add", headers: authHeaders("ADMIN"), payload: { provider: "OPENAI_API" } })).statusCode).toBe(422);
    const pool = await app.inject({ method: "POST", url: "/api/admin/gateway/api-key/add", headers: authHeaders("ADMIN"), payload: { provider: "OPENROUTER", apiKey: `sk-or-v1-${"o".repeat(40)}` } });
    expect(pool.json()).toMatchObject({ status: "CONNECTED" });
    expect(JSON.parse(String((fetchImpl.mock.calls[2] as unknown as [string, RequestInit])[1].body))).toEqual({ provider: "OPENROUTER", apiKey: `sk-or-v1-${"o".repeat(40)}` });
    // Only OpenAI has a server key to reuse.
    expect((await app.inject({ method: "POST", url: "/api/admin/gateway/api-key/add", headers: authHeaders("ADMIN"), payload: { provider: "DEEPSEEK", useSpaceKey: true } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: "/api/admin/gateway/api-key/add", headers: authHeaders("OPERATOR"), payload: { provider: "OPENAI_API", useSpaceKey: true } })).statusCode).toBe(403);
    await rm(directory, { recursive: true, force: true });
  });

  it("adds the server's Claude key, or a pasted one, as the gateway's per-token fallback without echoing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-claude-key-"));
    const keyFile = join(directory, "space-claude.key");
    const claudeKey = `sk-ant-api03-${"c".repeat(60)}`;
    await writeFile(keyFile, `${claudeKey}\n`);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "CONNECTED", account: { id: accountId, provider: "CLAUDE", label: "Claude API key …cccc" } })));
    const { app } = await setup(fetchImpl as unknown as typeof fetch, "internal-secret", undefined, undefined, keyFile);
    const fromSpace = await app.inject({ method: "POST", url: "/api/admin/gateway/api-key/add", headers: authHeaders("ADMIN"), payload: { provider: "CLAUDE", useSpaceKey: true } });
    expect(fromSpace.json()).toMatchObject({ status: "CONNECTED" });
    expect(fromSpace.body).not.toContain("sk-ant");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4920/__space-gateway/admin/api-key/add");
    expect(JSON.parse(String(init.body))).toEqual({ provider: "CLAUDE", apiKey: claudeKey, sourceRef: "space-claude" });
    const pasted = await app.inject({ method: "POST", url: "/api/admin/gateway/api-key/add", headers: authHeaders("ADMIN"), payload: { provider: "CLAUDE", apiKey: `sk-ant-api03-${"p".repeat(60)}` } });
    expect(pasted.json()).toMatchObject({ status: "CONNECTED" });
    expect(JSON.parse(String((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ provider: "CLAUDE", apiKey: `sk-ant-api03-${"p".repeat(60)}` });
    // A server without a readable Claude key says so instead of forwarding an empty key.
    const missing = await setup(fetchImpl as unknown as typeof fetch, "internal-secret", undefined, undefined, join(directory, "absent.key"));
    const absent = await missing.app.inject({ method: "POST", url: "/api/admin/gateway/api-key/add", headers: authHeaders("ADMIN"), payload: { provider: "CLAUDE", useSpaceKey: true } });
    expect(absent.statusCode).toBe(404);
    expect(absent.json()).toMatchObject({ error: { code: "space_key_missing" } });
    await rm(directory, { recursive: true, force: true });
  });

  it("adds a pasted Google AI key for Space Memory embeddings, never the server's Live key", async () => {
    const googleKey = `AIza${"g".repeat(35)}`;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "CONNECTED", account: { id: accountId, provider: "GOOGLE_AI", label: "Google AI API key …gggg" } })));
    const { app } = await setup(fetchImpl as unknown as typeof fetch, "internal-secret");
    const pasted = await app.inject({ method: "POST", url: "/api/admin/gateway/api-key/add", headers: authHeaders("ADMIN"), payload: { provider: "GOOGLE_AI", apiKey: googleKey } });
    expect(pasted.json()).toMatchObject({ status: "CONNECTED" });
    expect(pasted.body).not.toContain("AIza");
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ provider: "GOOGLE_AI", apiKey: googleKey });
    // The Live pane's Google key is not for embeddings (operator decision 2026-10-18): there is no server key to reuse.
    expect((await app.inject({ method: "POST", url: "/api/admin/gateway/api-key/add", headers: authHeaders("ADMIN"), payload: { provider: "GOOGLE_AI", useSpaceKey: true } })).statusCode).toBe(422);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("hands the Anthropic admin key to the gateway, audits only its hint and reports the bill (operator request 2026-10-18)", async () => {
    const adminKey = `sk-ant-admin01-${"a".repeat(40)}`;
    const status = { configured: true, keyHint: "…aaaa", savedAt: "2030-01-10T11:00:00.000Z", lastSyncAt: "2030-01-10T11:00:01.000Z", lastError: null, upstream: [] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(status)));
    const { app, repository, store } = await setup(fetchImpl as unknown as typeof fetch, "internal-secret");
    expect((await app.inject({ url: "/api/admin/gateway/anthropic-admin", headers: authHeaders("ADMIN") })).json()).toEqual({ configured: false, keyHint: null,
      savedAt: null, lastSyncAt: null, lastError: null, upstream: [] });
    expect((await app.inject({ method: "PUT", url: "/api/admin/gateway/anthropic-admin", headers: authHeaders("OPERATOR"), payload: { adminKey } })).statusCode).toBe(403);
    const rejected = await app.inject({ method: "PUT", url: "/api/admin/gateway/anthropic-admin", headers: authHeaders("ADMIN"), payload: { adminKey: "sk-ant-api03-nope" } });
    expect(rejected.statusCode).toBe(422);
    expect(fetchImpl).not.toHaveBeenCalled();
    const saved = await app.inject({ method: "PUT", url: "/api/admin/gateway/anthropic-admin", headers: authHeaders("ADMIN"), payload: { adminKey } });
    expect(saved.json()).toEqual(status);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4920/__space-gateway/admin/anthropic-admin/save");
    expect(JSON.parse(String(init.body))).toEqual({ adminKey });
    const audit = JSON.stringify(await store.listAuditEvents({ limit: 20 }));
    expect(audit).toContain("admin.gateway.anthropic-admin.save");
    expect(audit).not.toContain(adminKey);

    await repository.saveAnthropicAdminKey({ keyEncrypted: "v1.sealed", keyHint: "…aaaa", at: "2030-01-10T11:00:00.000Z" });
    const read = await app.inject({ url: "/api/admin/gateway/anthropic-admin", headers: authHeaders("ADMIN") });
    expect(read.json()).toMatchObject({ configured: true, keyHint: "…aaaa" });
    expect(read.body).not.toContain("v1.sealed");
    const billing = await app.inject({ url: "/api/admin/gateway/anthropic-billing?days=7", headers: authHeaders("ADMIN") });
    expect(billing.json()).toMatchObject({ status: { configured: true }, days: [] });
    expect((await app.inject({ url: "/api/admin/gateway/anthropic-billing?days=90", headers: authHeaders("ADMIN") })).statusCode).toBe(422);
    expect((await app.inject({ method: "DELETE", url: "/api/admin/gateway/anthropic-admin", headers: authHeaders("ADMIN") })).statusCode).toBe(200);
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toBe("http://127.0.0.1:4920/__space-gateway/admin/anthropic-admin/remove");
  });

  it("starts with Codex quotas from Space Gateway and closes cleanly", async () => {
    // Regression: this setting once made createApp touch the Fastify app before it existed, and the API did not start.
    const app = await createApp({
      store: new InMemorySpaceStore(),
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false }
    });
    try {
      const response = await app.inject({ method: "GET", url: "/api/admin/codex-usage-accounts", headers: authHeaders("ADMIN") });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ source: "space-gateway", data: [] });
      const credits = await app.inject({ method: "GET", url: "/api/admin/codex-reset-credits", headers: authHeaders("ADMIN") });
      expect(credits.json()).toMatchObject({ source: "space-gateway" });
      // The codex-lb route switch no longer applies.
      const targets = await app.inject({ method: "GET", url: "/api/admin/provider-switch-targets", headers: authHeaders("ADMIN") });
      expect(targets.json()).toMatchObject({ data: [] });
      const switched = await app.inject({ method: "POST", url: "/api/admin/provider-switches", headers: authHeaders("ADMIN"), payload: { providerId: "headroom-gateway" } });
      expect(switched.statusCode).toBe(409);
      expect(switched.body).toContain("Space Gateway");
    } finally {
      await app.close();
    }
  });

  it("reports a missing internal token and deletes accounts", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "POST", url: "/api/admin/gateway/codex/browser", headers: authHeaders("ADMIN") });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "gateway_admin_unavailable" } });
    expect((await app.inject({ method: "DELETE", url: `/api/admin/gateway/accounts/${accountId}`, headers: authHeaders("ADMIN") })).json()).toEqual({ id: accountId, deleted: true });
    expect((await app.inject({ method: "DELETE", url: `/api/admin/gateway/accounts/${accountId}`, headers: authHeaders("ADMIN") })).statusCode).toBe(404);
  });

  it("reports daily, per-model and per-account totals", async () => {
    const { app, repository } = await setup();
    await repository.insertRequestLogs([0, 1].map((index) => ({
      requestId: `rep${index}`, requestedAt: `2026-10-0${index + 1}T10:00:00.000Z`, provider: "CODEX" as const, accountId, apiKeyId: null,
      model: "gpt-5.5", reasoningEffort: null, serviceTier: null, transport: "http", status: index ? "error" : "success", errorCode: null, latencyMs: 1,
      firstTokenMs: 1, inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: null, costUsd: 0.5, compressionTokensSaved: null,
      stickyKind: null, stickyKeyHash: null
    })));
    const report = (await app.inject({ url: "/api/admin/gateway/reports?from=2026-10-01&to=2026-10-31", headers: authHeaders("ADMIN") })).json();
    expect(report.days.map((row: { key: string }) => row.key)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(report.totals).toMatchObject({ requests: 2, errors: 1, inputTokens: 20, costUsd: 1 });
    expect(report.models).toEqual([expect.objectContaining({ key: "gpt-5.5", requests: 2 })]);
    expect((await app.inject({ url: "/api/admin/gateway/reports?from=2026-10-31&to=2026-10-01", headers: authHeaders("ADMIN") })).statusCode).toBe(422);
    expect((await app.inject({ url: "/api/admin/gateway/reports?from=2026-10-01", headers: authHeaders("ADMIN") })).statusCode).toBe(422);
  });

  it("summarizes applied and shadow compression", async () => {
    const { app, repository } = await setup();
    const hour = new Date().toISOString();
    const base = { hour, provider: "CODEX", requests: 0, modifiedRequests: 0, blocks: 0, rejectedBlocks: 0, errorBlocks: 0, timedOut: 0,
      originalTokens: 0, compressedTokens: 0, overheadMs: 0, maxOverheadMs: 0 };
    await repository.recordCompression([
      { ...base, mode: "ON", strategy: "", requests: 4, modifiedRequests: 2, originalTokens: 1000, compressedTokens: 400, overheadMs: 20, maxOverheadMs: 9 },
      { ...base, mode: "ON", strategy: "smart_crusher", blocks: 2, originalTokens: 1000, compressedTokens: 400 },
      { ...base, mode: "SHADOW", strategy: "", requests: 1, modifiedRequests: 1, originalTokens: 200, compressedTokens: 150, overheadMs: 3, maxOverheadMs: 3 }
    ]);
    const stats = (await app.inject({ url: "/api/admin/gateway/compression-stats?hours=24", headers: authHeaders("ADMIN") })).json();
    expect(stats.applied).toMatchObject({ requests: 4, modifiedRequests: 2, blocks: 2, tokensSaved: 600, savingsPercent: 60, averageOverheadMs: 5, maxOverheadMs: 9 });
    expect(stats.shadow).toMatchObject({ requests: 1, tokensSaved: 50, savingsPercent: 25 });
    expect(stats.byStrategy).toEqual([expect.objectContaining({ mode: "ON", strategy: "smart_crusher", tokensSaved: 600 })]);
    expect(stats.byProvider).toEqual([{ provider: "CODEX", requests: 4, modifiedRequests: 2, originalTokens: 1000, compressedTokens: 400, tokensSaved: 600,
      savingsPercent: 60 }]);
    expect(stats.history).toHaveLength(1);
  });
});
