import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizationUrl, CODEX_OAUTH_CLIENT_ID, CodexOAuthError, exchangeAuthorizationCode, exchangeDeviceToken, extractCodexClaims,
  generatePkcePair, parseAuthorizationCallback, parseCodexAuthJson, pkceChallenge, refreshAccessToken, requestDeviceCode, shouldRefresh
} from "../src/providers/codex/oauth.js";

function jwt(payload: Record<string, unknown>): string {
  return ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");
}

const idToken = jwt({
  email: "dev@example.test", sub: "auth0|1", exp: 1_900_000_000,
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus", chatgpt_user_id: "user-9", organization_name: "Team" }
});

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Codex OAuth (codex-lb parity)", () => {
  it("builds the PKCE authorization URL exactly like the Codex CLI", () => {
    expect(pkceChallenge("verifier")).toBe("iMnq5o6zALKXGivsnlom_0F5_WYda32GHkxlV7mq7hQ");
    const { verifier, challenge } = generatePkcePair();
    expect(pkceChallenge(verifier)).toBe(challenge);
    const url = new URL(buildAuthorizationUrl({ state: "s1", codeChallenge: challenge }));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code", client_id: CODEX_OAUTH_CLIENT_ID, redirect_uri: "http://localhost:1455/auth/callback",
      scope: "openid profile email offline_access", code_challenge_method: "S256", state: "s1",
      codex_cli_simplified_flow: "true", originator: "codex_chatgpt_desktop"
    });
  });

  it("reads the pasted callback URL and reports sign-in errors", () => {
    expect(parseAuthorizationCallback("http://localhost:1455/auth/callback?code=abc&state=s1")).toEqual({ code: "abc", state: "s1" });
    expect(() => parseAuthorizationCallback("http://localhost:1455/auth/callback?error=access_denied")).toThrow(CodexOAuthError);
    expect(() => parseAuthorizationCallback("not a url")).toThrow(/full address/);
  });

  it("exchanges an authorization code with a form body", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { access_token: "at", refresh_token: "rt", id_token: idToken }));
    expect(await exchangeAuthorizationCode({ code: "c", codeVerifier: "v", fetchImpl })).toEqual({ accessToken: "at", refreshToken: "rt", idToken });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(String(init.body)).toContain("grant_type=authorization_code");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
    await expect(exchangeAuthorizationCode({ code: "c", codeVerifier: "v", fetchImpl: vi.fn(async () => respond(400, { error: "invalid_grant", error_description: "Code expired" })) }))
      .rejects.toMatchObject({ code: "invalid_grant", message: "Code expired", statusCode: 400 });
  });

  it("runs the device code flow: request, pending, then tokens", async () => {
    const device = await requestDeviceCode({ fetchImpl: vi.fn(async () => respond(200, { device_auth_id: "d1", usercode: "ABCD-1234", interval: "5", expires_in: 600 })) });
    expect(device).toEqual({ verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234", deviceAuthId: "d1", intervalSeconds: 5, expiresInSeconds: 600 });
    await expect(requestDeviceCode({ fetchImpl: vi.fn(async () => respond(404, {})) })).rejects.toMatchObject({ code: "device_auth_unavailable" });
    expect(await exchangeDeviceToken({ deviceAuthId: "d1", userCode: "ABCD-1234", fetchImpl: vi.fn(async () => respond(403, {})) })).toBeNull();
    expect(await exchangeDeviceToken({ deviceAuthId: "d1", userCode: "ABCD-1234", fetchImpl: vi.fn(async () => respond(400, { error: "authorization_pending" })) })).toBeNull();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respond(200, { authorization_code: "code-1", code_verifier: "ver-1" }))
      .mockResolvedValueOnce(respond(200, { access_token: "at", refresh_token: "rt", id_token: idToken }));
    expect(await exchangeDeviceToken({ deviceAuthId: "d1", userCode: "ABCD-1234", fetchImpl })).toMatchObject({ accessToken: "at" });
    expect(String((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body)).toContain(encodeURIComponent("https://auth.openai.com/deviceauth/callback"));
  });

  it("refreshes with a JSON body and returns the new identity", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { access_token: "at2", refresh_token: "rt2", id_token: idToken }));
    const result = await refreshAccessToken("rt1", { fetchImpl });
    expect(result).toMatchObject({ accessToken: "at2", refreshToken: "rt2", claims: { accountId: "acct-1", planType: "plus", email: "dev@example.test" } });
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      grant_type: "refresh_token", client_id: CODEX_OAUTH_CLIENT_ID, refresh_token: "rt1", scope: "openid profile email"
    });
    await expect(refreshAccessToken("rt1", { fetchImpl: vi.fn(async () => respond(401, { error: { code: "refresh_token_reused", message: "reused" } })) }))
      .rejects.toMatchObject({ code: "refresh_token_reused" });
    await expect(refreshAccessToken("rt1", { fetchImpl: vi.fn(async () => { throw new TypeError("fetch failed"); }) }))
      .rejects.toMatchObject({ code: "transport_error" });
  });

  it("reads id_token claims and auth.json files", () => {
    expect(extractCodexClaims(idToken)).toEqual({
      accountId: "acct-1", email: "dev@example.test", planType: "plus", workspaceId: null, workspaceLabel: "Team", seatType: null,
      chatgptUserId: "user-9", expiresAtMs: 1_900_000_000_000
    });
    expect(extractCodexClaims("garbage").accountId).toBeNull();
    const parsed = parseCodexAuthJson(JSON.stringify({ tokens: { id_token: idToken, access_token: "at", refresh_token: "rt", account_id: "acct-from-file" }, last_refresh: "2026-10-01T00:00:00Z" }));
    expect(parsed.claims.accountId).toBe("acct-from-file");
    expect(parsed.lastRefreshMs).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(() => parseCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: "sk-x" }))).toThrow(/no ChatGPT tokens/);
    expect(shouldRefresh(Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-10-09T00:00:01Z"))).toBe(true);
    expect(shouldRefresh(Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-10-08T00:00:00Z"))).toBe(false);
  });
});
