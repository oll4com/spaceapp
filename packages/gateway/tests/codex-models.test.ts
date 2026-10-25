import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type StoredCredentials } from "../src/accounts/account-pool.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { registerCodexModelRoutes } from "../src/providers/codex/models.js";
import { createGatewayServer } from "../src/server.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 6));

async function setup(allowedModels: string[] = []) {
  const repository = new InMemoryGatewayRepository();
  const id = `gw_account:${"1".repeat(32)}`;
  const credentials: StoredCredentials = { accessToken: "at", refreshToken: null, idToken: null, upstreamAccountId: "acct-1", accessExpiresAtMs: null };
  await repository.upsertAccount({ accountId: id, provider: "CODEX", label: "A", email: null, externalAccountId: "acct-1", planType: "plus",
    credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), id), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: null });
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: `gw_key:${"2".repeat(32)}`, name: "k", keyHash, keyPrefix, trafficClass: "INTERACTIVE", allowedModels,
    enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, limits: [], expiresAt: null, createdBy: null });
  const pool = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() } });
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ models: [{ slug: "gpt-5.5", display_name: "GPT-5.5" }, { slug: "gpt-5.6-sol" }] })));
  const server = createGatewayServer({ repository, version: "t", credentialKeyPresent: () => true,
    routes: (app, helpers) => registerCodexModelRoutes(app, helpers, { pool, fetchImpl: fetchImpl as unknown as typeof fetch }) });
  const get = (url: string) => server.app.inject({ url, headers: { authorization: `Bearer ${plainKey}`, "user-agent": "codex_cli_rs/0.150.1" } });
  return { get, fetchImpl };
}

describe("model catalog", () => {
  it("serves the Codex catalog and an OpenAI list, cached per client version", async () => {
    const { get, fetchImpl } = await setup();
    expect((await get("/backend-api/codex/models?client_version=0.150.1")).json()).toEqual({ models: [{ slug: "gpt-5.5", display_name: "GPT-5.5" }, { slug: "gpt-5.6-sol" }] });
    const list = (await get("/v1/models")).json();
    expect(list.object).toBe("list");
    expect(list.data.map((model: { id: string }) => model.id)).toEqual(["gpt-5.5", "gpt-5.6-sol"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.150.1");
    expect((init.headers as Record<string, string>)).toMatchObject({ authorization: "Bearer at", "chatgpt-account-id": "acct-1", "user-agent": "codex_cli_rs/0.150.1" });
  });

  it("shows keys only their allowed models", async () => {
    const { get } = await setup(["gpt-5.5"]);
    expect((await get("/v1/models")).json().data).toEqual([{ id: "gpt-5.5", object: "model", created: 0, owned_by: "openai" }]);
  });
});
