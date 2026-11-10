import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { GatewayAdminService } from "../src/gateway/gateway-service.js";
import { registerGatewayAdminRoutes } from "../src/gateway/gateway-routes.js";
import { vaultKeyReader, type VaultModule } from "../src/vault/wiring.js";

// `space-admin-action gateway-api-key-add --vault-key` (nous_msg:71a41c2e): the server reads the kept Vault key; the caller never sees it.
async function setup(vaultKey: Parameters<typeof registerGatewayAdminRoutes>[1]["vaultKey"], answer = { status: "CONNECTED", account: { id: "gw_account:1", provider: "AMD_TOKEN_LAB" } }) {
  const app = Fastify();
  app.addHook("preHandler", async (request) => { (request as { user?: unknown }).user = { role: "ADMIN" }; });
  const addOpenAiApiKey = vi.fn(async () => ({ status: 200, body: answer }));
  const recordAudit = vi.fn(async () => undefined);
  registerGatewayAdminRoutes(app, { service: { addOpenAiApiKey } as unknown as GatewayAdminService, recordAudit, routeOptions: {}, vaultKey });
  await app.ready();
  return { app, addOpenAiApiKey, recordAudit };
}
const add = (app: Awaited<ReturnType<typeof setup>>["app"], payload: object) => app.inject({ method: "POST", url: "/api/admin/gateway/api-key/add", payload });

describe("Gateway API key from the Vault", () => {
  it("adds the kept key the Vault hands over, marks it used and never returns it", async () => {
    const key = `tl-${"k".repeat(40)}`;
    const used = vi.fn(async () => undefined);
    const vaultKey = vi.fn(async () => ({ value: key, used }));
    const { app, addOpenAiApiKey, recordAudit } = await setup(vaultKey, { status: "CONNECTED", account: { id: "gw_account:1", provider: "AMD_TOKEN_LAB", label: `AMD …${key}` } as never });
    const answer = await add(app, { provider: "AMD_TOKEN_LAB", vaultKeyId: "vault_key:-BQyIyriDiE49Vslrdwmtw" });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).not.toContain(key);
    expect(vaultKey).toHaveBeenCalledWith(expect.anything(), "vault_key:-BQyIyriDiE49Vslrdwmtw");
    expect(addOpenAiApiKey).toHaveBeenCalledWith({ provider: "AMD_TOKEN_LAB", apiKey: key });
    expect(used).toHaveBeenCalledOnce();
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ metadata: { provider: "AMD_TOKEN_LAB", method: "vault-key", vaultKeyId: "vault_key:-BQyIyriDiE49Vslrdwmtw" } }));
  });

  it("refuses when the Vault does not hand the key over, without calling the gateway", async () => {
    const { app, addOpenAiApiKey } = await setup(async () => ({ reason: "AGENT_ACCESS_OFF" }));
    const answer = await add(app, { provider: "AMD_TOKEN_LAB", vaultKeyId: "vault_key:-BQyIyriDiE49Vslrdwmtw" });
    expect([answer.statusCode, answer.json().error.code]).toEqual([409, "VAULT_KEY_UNAVAILABLE"]);
    expect(answer.body).toContain("AGENT_ACCESS_OFF");
    expect(addOpenAiApiKey).not.toHaveBeenCalled();
    const noVault = await setup(undefined);
    expect((await add(noVault.app, { provider: "AMD_TOKEN_LAB", vaultKeyId: "vault_key:-BQyIyriDiE49Vslrdwmtw" })).statusCode).toBe(409);
  });

  it("reads the key through the Vault agent's own key-take, as pane space-admin-action, and marks it used only when asked", async () => {
    const call = vi.fn(async ({ path }: { path: string }) => (path === "key-take" ? { status: "TAKEN", value: "tl-secret" } : { status: "USED" }));
    const read = vaultKeyReader({ upsertUser: async () => ({ id: "user:op" }) }, () => ({ agent: { call } }) as unknown as VaultModule);
    const request = { user: { role: "ADMIN" }, id: "req:1" } as never;
    const kept = await read(request, "vault_key:abcdefgh");
    expect(kept).toMatchObject({ value: "tl-secret" });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ owner: "user:op", paneId: "space-admin-action", path: "key-take", body: { id: "vault_key:abcdefgh" } }));
    expect(call).toHaveBeenCalledTimes(1);
    await (kept as { used(): Promise<unknown> }).used();
    expect(call).toHaveBeenLastCalledWith(expect.objectContaining({ path: "key-used" }));
    call.mockResolvedValueOnce({ status: "BLOCKED", reason: "AGENT_ACCESS_OFF" } as never);
    expect(await read(request, "vault_key:abcdefgh")).toEqual({ reason: "AGENT_ACCESS_OFF" });
  });
});

describe("Vault keys reconciled with Space Gateway (7/11: Inception's key, saved before its pool took it, never joined)", () => {
  it("offers each kept free-provider key that is no account yet, once per run, and leaves joined, paid and unlabelled keys alone", async () => {
    const { gatewayVaultKeyReconciler } = await import("../src/gateway/gateway-service.js");
    const known = new Set(["jina-key-already-joined"]);
    const apiKeyKnown = vi.fn(async (_provider: string, key: string) => (key === "gateway-down" ? null : known.has(key)));
    const addOpenAiApiKey = vi.fn(async (input: { apiKey?: string }) => (input.apiKey === "rejected-key" ? { status: 422, body: { error: { code: "api_key_rejected" } } }
      : { status: 200, body: { status: "CONNECTED" } }));
    const log = { info: vi.fn(), warn: vi.fn() };
    const reconcile = gatewayVaultKeyReconciler({ apiKeyKnown, addOpenAiApiKey } as unknown as GatewayAdminService, log);
    const keys = [
      { owner: "user:operator", id: "vault_key:inception01", label: "Inception Labs API key (free 100M tokens)", value: "inception-key" },
      { owner: "user:operator", id: "vault_key:jina000001", label: "Jina AI API key (free 10M tokens)", value: "jina-key-already-joined" },
      { owner: "user:operator", id: "vault_key:silicon001", label: "SiliconFlow API key (space-gateway)", value: "rejected-key" },
      { owner: "user:operator", id: "vault_key:groq000001", label: "Groq API key", value: "gateway-down" },
      { owner: "user:operator", id: "vault_key:openai0001", label: "OpenAI API key (paid)", value: "openai-key" },
      { owner: "user:operator", id: "vault_key:server0001", label: "vm221 macOS spaceadmin password", value: "a-password" }
    ];
    expect(await reconcile(keys)).toEqual({ offered: 2, joined: 1 });
    expect(addOpenAiApiKey.mock.calls.map(([input]) => [input.provider, input.apiKey])).toEqual([["INCEPTION", "inception-key"], ["SILICONFLOW", "rejected-key"]]);
    // Only free-labelled keys ever reach the gateway, even to ask whether they are known; the log never carries a key.
    expect(apiKeyKnown.mock.calls.map(([provider]) => provider)).toEqual(["INCEPTION", "JINA", "SILICONFLOW", "GROQ"]);
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).not.toMatch(/inception-key|rejected-key|a-password/);
  });
});
