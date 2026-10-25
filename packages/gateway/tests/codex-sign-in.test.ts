import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool } from "../src/accounts/account-pool.js";
import { registerCodexSignInRoutes } from "../src/admin/codex-sign-in.js";
import { createCredentialCipher } from "../src/credential-cipher.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 5));
const jwt = (payload: Record<string, unknown>) => ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "s"].join(".");
const idToken = jwt({ email: "dev@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus", chatgpt_user_id: "user-1" } });
const tokens = { access_token: jwt({ exp: 1_900_000_000 }), refresh_token: "rt", id_token: idToken };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function setup(fetchImpl: typeof fetch) {
  const repository = new InMemoryGatewayRepository();
  const pool = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() } });
  const app = Fastify();
  registerCodexSignInRoutes(app, { repository, pool, cipher: () => cipher, internalToken: "internal-secret", fetchImpl });
  const call = (url: string, payload: unknown = {}, token = "internal-secret") => app.inject({ method: "POST", url, payload: payload as object,
    headers: token ? { "x-space-internal-token": token } : {} });
  return { repository, app, call };
}

const usageBody = () => json(200, { plan_type: "plus", rate_limit: { primary_window: { used_percent: 20, reset_at: 1_900_000_000, limit_window_seconds: 18000 }, secondary_window: { used_percent: 5 } } });

describe("Codex sign-in (gateway admin)", () => {
  it("only answers the Space API with the internal token", async () => {
    const { call } = setup(vi.fn() as unknown as typeof fetch);
    expect((await call("/__space-gateway/admin/codex/browser", {}, "")).statusCode).toBe(403);
    expect((await call("/__space-gateway/admin/codex/browser", {}, "wrong-secret-x")).statusCode).toBe(403);
    const ok = await call("/__space-gateway/admin/codex/browser");
    expect(ok.json().authorizationUrl).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  });

  it("signs in with a device code and stores encrypted credentials with live usage", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(200, { device_auth_id: "dev-1", user_code: "ABCD-EFGH", interval: 5, expires_in: 600 }))
      .mockResolvedValueOnce(json(400, { error: "authorization_pending" }))
      .mockResolvedValueOnce(json(200, tokens))
      .mockResolvedValueOnce(usageBody());
    const { call, repository } = setup(fetchImpl as unknown as typeof fetch);
    const started = (await call("/__space-gateway/admin/codex/device")).json();
    expect(started).toMatchObject({ userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/codex/device", intervalSeconds: 5 });
    expect(JSON.stringify(started)).not.toContain("dev-1");
    expect((await call(`/__space-gateway/admin/codex/device/${started.flowId}/poll`)).json()).toEqual({ status: "PENDING" });
    const connected = (await call(`/__space-gateway/admin/codex/device/${started.flowId}/poll`)).json();
    expect(connected).toMatchObject({ status: "CONNECTED", account: { provider: "CODEX", email: "dev@example.test", planType: "plus" } });
    expect(JSON.stringify(connected)).not.toContain("rt");
    const [account] = await repository.listAccounts();
    expect(account).toMatchObject({ externalAccountId: "acct-1:user-1", source: "OAUTH", primaryWindow: { usedPercent: 20, windowMinutes: 300 } });
    expect(JSON.parse(cipher.decrypt(account!.credentialsEncrypted, account!.id))).toMatchObject({ refreshToken: "rt", upstreamAccountId: "acct-1" });
    expect((await call(`/__space-gateway/admin/codex/device/${started.flowId}/poll`)).json()).toEqual({ status: "EXPIRED" });
  });

  it("completes browser sign-in only for the matching state", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(200, tokens)).mockResolvedValueOnce(usageBody());
    const { call, repository } = setup(fetchImpl as unknown as typeof fetch);
    const flow = (await call("/__space-gateway/admin/codex/browser")).json();
    const state = new URL(flow.authorizationUrl).searchParams.get("state");
    const mismatch = await call(`/__space-gateway/admin/codex/browser/${flow.flowId}/complete`, { callbackUrl: "http://localhost:1455/auth/callback?code=c&state=other" });
    expect(mismatch.statusCode).toBe(422);
    const done = await call(`/__space-gateway/admin/codex/browser/${flow.flowId}/complete`, { callbackUrl: `http://localhost:1455/auth/callback?code=c&state=${state}` });
    expect(done.json()).toMatchObject({ status: "CONNECTED" });
    expect(await repository.listAccounts()).toHaveLength(1);
  });

  it("imports auth.json and keeps one account per upstream identity", async () => {
    const fetchImpl = vi.fn(async () => usageBody());
    const { call, repository } = setup(fetchImpl as unknown as typeof fetch);
    const authJson = JSON.stringify({ tokens: { id_token: idToken, access_token: tokens.access_token, refresh_token: "rt-file", account_id: "acct-1" }, last_refresh: "2030-01-01T00:00:00Z" });
    const imported = (await call("/__space-gateway/admin/codex/import", { authJson })).json();
    expect(imported).toMatchObject({ status: "CONNECTED", account: { provider: "CODEX" } });
    expect(imported.account).not.toHaveProperty("source");
    expect((await call("/__space-gateway/admin/codex/import", { authJson })).statusCode).toBe(200);
    const accounts = await repository.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ source: "IMPORT_AUTH_JSON", lastRefreshAt: "2030-01-01T00:00:00.000Z" });
    expect(JSON.parse(cipher.decrypt(accounts[0]!.credentialsEncrypted, accounts[0]!.id)).refreshToken).toBe("rt-file");
    expect((await call("/__space-gateway/admin/codex/import", { authJson: "{}" })).statusCode).toBe(422);
  });

  it("tests an account with one tiny real request", async () => {
    const stream = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n'
      + 'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.5","usage":{"input_tokens":12,"output_tokens":2}}}\n\n';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(usageBody())
      .mockResolvedValueOnce(new Response(stream, { status: 200 }));
    const { call, repository } = setup(fetchImpl as unknown as typeof fetch);
    await call("/__space-gateway/admin/codex/import", { authJson: JSON.stringify({ tokens: { id_token: idToken, access_token: tokens.access_token, refresh_token: "rt" } }) });
    const [account] = await repository.listAccounts();
    const result = (await call(`/__space-gateway/admin/accounts/${account!.id}/test`, { model: "gpt-5.5" })).json();
    expect(result).toMatchObject({ ok: true, model: "gpt-5.5", status: 200, usage: { inputTokens: 12, outputTokens: 2 }, error: null });
    const [, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["user-agent"]).toBe("space-gateway-account-test");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "gpt-5.5", stream: true, store: false, instructions: "Reply with OK only." });
    expect((await call(`/__space-gateway/admin/accounts/gw_account:${"0".repeat(32)}/test`)).statusCode).toBe(404);
  });
});
