import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool } from "../src/accounts/account-pool.js";
import { registerAccountAdminRoutes } from "../src/admin/account-admin.js";
import { detectClient, detectProject } from "../src/client-detect.js";
import { createCredentialCipher } from "../src/credential-cipher.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 7));
const jwt = (payload: Record<string, unknown>) => ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "s"].join(".");
const idToken = jwt({ email: "dev@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" } });

async function setup(provider: "CODEX" | "ANTIGRAVITY" = "CODEX") {
  const repository = new InMemoryGatewayRepository();
  const accountId = `gw_account:${"3".repeat(32)}`;
  const credentials = { accessToken: "at-secret", refreshToken: provider === "CODEX" ? "rt-secret" : null, idToken: provider === "CODEX" ? idToken : null,
    upstreamAccountId: "acct-1", accessExpiresAtMs: Date.parse("2030-01-01T00:00:00.000Z") };
  await repository.upsertAccount({ accountId, provider, label: "Team", email: "dev@example.test", externalAccountId: "acct-1", planType: "plus",
    credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), accountId), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null,
    lastRefreshAt: "2029-12-30T00:00:00.000Z" });
  const app = Fastify();
  registerAccountAdminRoutes(app, { repository, cipher: () => cipher, internalToken: "internal-secret" });
  const call = (url: string, token = "internal-secret") => app.inject({ method: "POST", url, payload: {}, headers: token ? { "x-space-internal-token": token } : {} });
  return { accountId, call, repository };
}

describe("Account admin (gateway)", () => {
  it("reports token status without any token", async () => {
    const { accountId, call } = await setup();
    expect((await call(`/__space-gateway/admin/accounts/${accountId}/token-status`, "")).statusCode).toBe(403);
    const response = await call(`/__space-gateway/admin/accounts/${accountId}/token-status`);
    expect(response.json()).toEqual({ accessExpiresAt: "2030-01-01T00:00:00.000Z", refreshStored: true, idTokenParsed: true });
    expect(response.body).not.toContain("secret");
    expect((await call(`/__space-gateway/admin/accounts/gw_account:${"9".repeat(32)}/token-status`)).statusCode).toBe(404);
  });

  it("reports a token the provider rejected as expired when it was rejected, not when it was issued to expire", async () => {
    const { accountId, call, repository } = await setup();
    await repository.withAccountCredentialLock(accountId, async () => ({ credentialsExpiresAt: "2029-12-31T08:43:17.000Z" }));
    await repository.recordAccountState(accountId, { status: "REAUTH_REQUIRED", statusReason: "Authentication token invalidated", blockedUntil: null });
    const response = await call(`/__space-gateway/admin/accounts/${accountId}/token-status`);
    expect(response.json()).toMatchObject({ accessExpiresAt: "2029-12-31T08:43:17.000Z" });
  });

  it("exports a Codex sign-in as auth.json and refuses other providers", async () => {
    const { accountId, call } = await setup();
    const response = await call(`/__space-gateway/admin/accounts/${accountId}/export`);
    expect(response.headers["cache-control"]).toBe("no-store");
    const authJson = JSON.parse(response.json().authJson);
    expect(authJson).toEqual({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
      tokens: { id_token: idToken, access_token: "at-secret", refresh_token: "", account_id: "acct-1" }, last_refresh: "2029-12-30T00:00:00.000Z" });
    expect(response.body).not.toContain("rt-secret");
    const other = await setup("ANTIGRAVITY");
    expect((await other.call(`/__space-gateway/admin/accounts/${other.accountId}/export`)).json().error.code).toBe("export_unsupported");
  });
});

describe("Client and project detection", () => {
  it("names the program from x-client or the user agent, never echoing the agent string", () => {
    expect(detectClient({ "user-agent": "codex_cli_rs/0.150.1 (Linux 6.12; x86_64)" })).toBe("Codex CLI");
    expect(detectClient({ "user-agent": "claude-cli/2.1.0 (external, cli)" })).toBe("Claude Code");
    expect(detectClient({ "user-agent": "opencode/1.2" })).toBe("OpenCode");
    expect(detectClient({ "user-agent": "curl/8.0" })).toBe("Other");
    expect(detectClient({ "x-client": "mission-control", "user-agent": "codex_cli_rs/1" })).toBe("mission-control");
    expect(detectClient({})).toBeNull();
    expect(detectProject({ "x-space-project": "space%2Fgateway" })).toBe("space/gateway");
    expect(detectProject({ "x-headroom-project": "docs" })).toBe("docs");
    expect(detectProject({})).toBeNull();
  });
});

describe("In-flight requests per account", () => {
  it("counts a request on its current account until the response closes", () => {
    const pool = new AccountPool({ provider: "CODEX", repository: new InMemoryGatewayRepository(), cipher: () => cipher,
      refresher: { needsRefresh: () => false, refresh: vi.fn() } });
    const first = new EventEmitter();
    const second = new EventEmitter();
    pool.markSelected("a", first);
    pool.markSelected("a", second);
    expect(pool.inFlight()).toEqual({ a: 2 });
    // A retry moves the request to another account.
    pool.markSelected("b", first);
    expect(pool.inFlight()).toEqual({ a: 1, b: 1 });
    first.emit("close");
    second.emit("close");
    expect(pool.inFlight()).toEqual({});
    pool.markSelected("c");
    expect(pool.inFlight()).toEqual({});
  });
});
