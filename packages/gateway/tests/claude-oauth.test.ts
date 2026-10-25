import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool } from "../src/accounts/account-pool.js";
import { claudeAccountActions, registerClaudeSignInRoutes } from "../src/admin/claude-sign-in.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { compressAnthropicBodyAsync } from "../src/compression/engine.js";
import { createClaudeRefresher } from "../src/providers/claude/credentials.js";
import {
  buildClaudeAuthorizationUrl, ClaudeOAuthError, exchangeClaudeCode, parseClaudeAuthorizationCode, refreshClaudeToken
} from "../src/providers/claude/oauth.js";
import { claudePlanLabel, parseClaudeUsage } from "../src/providers/claude/usage.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 6));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tokenPayload = { access_token: "sk-ant-oat-access", refresh_token: "sk-ant-ort-refresh", expires_in: 28800, scope: "user:inference user:profile",
  account: { uuid: "acc-uuid", email_address: "max@example.com" }, organization: { uuid: "org-uuid", name: "Max Org" } };

describe("Claude OAuth", () => {
  it("builds the authorization address of the manual-code flow", () => {
    const url = new URL(buildClaudeAuthorizationUrl({ challenge: "challenge", state: "state" }));
    expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ code: "true", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", response_type: "code",
      redirect_uri: "https://platform.claude.com/oauth/code/callback", code_challenge: "challenge", code_challenge_method: "S256", state: "state" });
    expect(url.search).toContain("scope=user%3Aprofile%20user%3Ainference");
  });

  it("accepts a pasted code#state or a callback address", () => {
    expect(parseClaudeAuthorizationCode(" abcdefgh123#st ")).toEqual({ code: "abcdefgh123", state: "st" });
    expect(parseClaudeAuthorizationCode("https://platform.claude.com/oauth/code/callback?code=abcdefgh123&state=st")).toEqual({ code: "abcdefgh123", state: "st" });
    expect(() => parseClaudeAuthorizationCode("bad")).toThrow(ClaudeOAuthError);
  });

  it("exchanges the code and refreshes with rotation", async () => {
    const fetchImpl = vi.fn(async () => json(tokenPayload));
    const tokens = await exchangeClaudeCode({ code: "abc", state: "st", verifier: "v", fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 });
    expect(tokens).toMatchObject({ accessToken: "sk-ant-oat-access", refreshToken: "sk-ant-ort-refresh", expiresAtMs: 1_000 + 28_800_000,
      accountUuid: "acc-uuid", email: "max@example.com", organizationUuid: "org-uuid" });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ grant_type: "authorization_code", code: "abc", state: "st", code_verifier: "v" });

    const refresher = createClaudeRefresher({ fetchImpl: (async () => json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 100 })) as unknown as typeof fetch });
    const stored = { accessToken: "old", refreshToken: "old-refresh", idToken: null, upstreamAccountId: "acc-uuid", accessExpiresAtMs: 2_000 };
    expect(refresher.needsRefresh({} as never, stored, 1_000)).toBe(true);
    expect(refresher.needsRefresh({} as never, { ...stored, accessExpiresAtMs: 10 * 60_000 + 1_000 }, 1_000)).toBe(false);
    expect(await refresher.refresh(stored)).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", upstreamAccountId: "acc-uuid" });
  });

  it("marks a rejected refresh token for a new sign-in", async () => {
    const fetchImpl = (async () => json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400)) as unknown as typeof fetch;
    await expect(refreshClaudeToken({ accessToken: "a", refreshToken: "r", expiresAtMs: null, scopes: [], accountUuid: null, email: null,
      organizationUuid: null, organizationName: null }, { fetchImpl })).rejects.toMatchObject({ code: "invalid_refresh_token", statusCode: 400 });
  });

  it("reads plan and usage windows", () => {
    expect(claudePlanLabel("max", "default_claude_max_20x")).toBe("max20x");
    expect(claudePlanLabel("pro", null)).toBe("pro");
    expect(parseClaudeUsage({ five_hour: { utilization: 37.5, resets_at: "2030-01-10T05:00:00Z" }, seven_day: { utilization: 12 } }))
      .toMatchObject({ fiveHourUsedPercent: 37.5, fiveHourResetAt: "2030-01-10T05:00:00.000Z", weeklyUsedPercent: 12 });
  });
});

describe("Claude sign-in routes", () => {
  async function setup(fetchImpl: typeof fetch) {
    const repository = new InMemoryGatewayRepository();
    const pool = new AccountPool({ provider: "CLAUDE", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() } });
    const app = Fastify();
    registerClaudeSignInRoutes(app, { repository, pool, cipher: () => cipher, internalToken: "internal-token", fetchImpl });
    const call = (url: string, payload: Record<string, unknown> = {}, token = "internal-token") =>
      app.inject({ method: "POST", url, payload, headers: { "x-space-internal-token": token }, remoteAddress: "127.0.0.1" });
    return { repository, pool, call };
  }

  it("signs in a Claude account, stores its plan and usage, and keeps tokens encrypted", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/oauth/token")) return json(tokenPayload);
      if (url.endsWith("/api/oauth/profile")) return json({ account: { uuid: "acc-uuid", email: "max@example.com" },
        organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } });
      return json({ five_hour: { utilization: 25 }, seven_day: { utilization: 5 } });
    }) as unknown as typeof fetch;
    const { repository, call } = await setup(fetchImpl);
    expect((await call("/__space-gateway/admin/claude/browser", {}, "wrong")).statusCode).toBe(403);
    const started = (await call("/__space-gateway/admin/claude/browser")).json() as { flowId: string; authorizationUrl: string };
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const mismatch = await call(`/__space-gateway/admin/claude/browser/${started.flowId}/complete`, { code: "abcdefgh123#other" });
    expect(mismatch.statusCode).toBe(422);
    const done = await call(`/__space-gateway/admin/claude/browser/${started.flowId}/complete`, { code: `abcdefgh123#${state}` });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "CONNECTED", account: { provider: "CLAUDE", label: "max@example.com", planType: "max20x" } });
    const [account] = await repository.listAccounts();
    expect(account).toMatchObject({ provider: "CLAUDE", externalAccountId: "org-uuid:acc-uuid", primaryWindow: { usedPercent: 25, windowMinutes: 300 } });
    expect(account!.credentialsEncrypted).not.toContain("sk-ant");
    expect(JSON.parse(cipher.decrypt(account!.credentialsEncrypted, account!.id))).toMatchObject({ accessToken: "sk-ant-oat-access", refreshToken: "sk-ant-ort-refresh" });
    const again = await call(`/__space-gateway/admin/claude/browser/${started.flowId}/complete`, { code: `abcdefgh123#${state}` });
    expect(again.json()).toMatchObject({ error: { code: "flow_expired" } });
  });

  it("tests an account with a token check that spends no usage", async () => {
    const fetchImpl = vi.fn(async () => json({ account: { uuid: "acc-uuid" }, organization: { organization_type: "claude_pro" } })) as unknown as typeof fetch;
    const { repository, pool } = await setup(fetchImpl);
    const id = `gw_account:${"d".repeat(32)}`;
    await repository.upsertAccount({ accountId: id, provider: "CLAUDE", label: "Pro", email: null, externalAccountId: "acc-uuid", planType: null,
      credentialsEncrypted: cipher.encrypt(JSON.stringify({ accessToken: "t", refreshToken: "r", idToken: null, upstreamAccountId: "acc-uuid", accessExpiresAtMs: null }), id),
      credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: null });
    const [account] = await repository.listAccounts();
    const result = await claudeAccountActions({ repository, pool, fetchImpl }).test(account!, {});
    expect(result).toMatchObject({ ok: true, status: 200, planType: "pro" });
  });
});

describe("Anthropic conversation compression", () => {
  const run = vi.fn(async (text: string) => ({ replacement: text.slice(0, 600), action: { kind: "compressed" as const, strategy: "log_compressor" as const,
    contentType: "build" as const, originalBytes: text.length, compressedBytes: 600, originalTokens: Math.ceil(text.length / 4), compressedTokens: 150 } }));
  const big = "x".repeat(4000);

  it("compresses a tool result that carries a cache marker and keeps the marker", async () => {
    const body = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: big, cache_control: { type: "ephemeral" } }] }] };
    const outcome = await compressAnthropicBodyAsync(body, { run, timeBudgetMs: 1000 });
    expect(outcome.modified).toBe(true);
    const block = (outcome.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[0]!;
    expect((block.content as string).length).toBe(600);
    expect(block.cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0]!.content[0]!.content).toBe(big);
  });

  it("compresses tool results in every message but never the user's text, thinking or tool_use blocks", async () => {
    const body = { messages: [
      { role: "user", content: big },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t", name: "Bash", input: { command: big } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: big }] },
      { role: "assistant", content: [{ type: "text", text: "more" }] },
      { role: "user", content: [{ type: "thinking", thinking: big }, { type: "text", text: big }, { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: big }, { type: "image", source: {} }] }] }
    ] };
    const outcome = await compressAnthropicBodyAsync(body, { run, timeBudgetMs: 1000 });
    expect(outcome.modified).toBe(true);
    const messages = outcome.body.messages as Array<{ content: unknown }>;
    expect(messages[0]!.content).toBe(big);
    expect(messages[1]).toBe(body.messages[1]);
    expect(((messages[2]!.content as Array<Record<string, unknown>>)[0]!.content as string).length).toBe(600);
    const latest = messages[4]!.content as Array<Record<string, unknown>>;
    expect(latest[0]!.thinking).toBe(big);
    expect(latest[1]!.text).toBe(big);
    expect(latest[2]!.content).toEqual([{ type: "text", text: big.slice(0, 600) }, { type: "image", source: {} }]);
    expect(body.messages[4]!.content).not.toBe(latest);
    expect(outcome.blocks.map((block) => `${block.itemIndex}:${block.blockType}`)).toEqual(["2:tool_result#0", "4:tool_result#2#0"]);
  });
});
