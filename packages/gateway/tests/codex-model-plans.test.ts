import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type StoredCredentials } from "../src/accounts/account-pool.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { CodexModelPlans } from "../src/providers/codex/model-plans.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 3));

async function poolWith(plans: Array<[string, string]>) {
  const repository = new InMemoryGatewayRepository();
  for (const [index, plan] of plans.entries()) {
    const id = `gw_account:${String(index + 1).repeat(32)}`;
    const credentials: StoredCredentials = { accessToken: `token-${plan[0]}`, refreshToken: null, idToken: null, upstreamAccountId: plan[0], accessExpiresAtMs: null };
    await repository.upsertAccount({ accountId: id, provider: "CODEX", label: plan[0], email: null, externalAccountId: plan[0], planType: plan[1],
      credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), id), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: null });
  }
  return { repository, pool: new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() } }) };
}

describe("Codex model plans", () => {
  it("learns which plans offer which models from one account per plan", async () => {
    const { pool } = await poolWith([["plus-a", "plus"], ["plus-b", "plus"], ["lite-a", "prolite"]]);
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const account = (init.headers as Record<string, string>)["chatgpt-account-id"];
      const models = account === "lite-a"
        ? [{ slug: "gpt-5.5" }, { slug: "gpt-5.3-codex-spark" }, { slug: "gpt-6-astra", available_in_plans: ["pro", "Pro Lite"] }]
        : [{ slug: "gpt-5.5" }];
      return new Response(JSON.stringify({ models }));
    }) as unknown as typeof fetch;
    const plans = new CodexModelPlans({ pool, fetchImpl });
    await plans.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect([...plans.plansFor("gpt-5.5")!].sort()).toEqual(["plus", "prolite"]);
    expect([...plans.plansFor("GPT-5.3-codex-spark")!]).toEqual(["prolite"]);
    expect([...plans.plansFor("gpt-6-astra")!].sort()).toEqual(["pro", "prolite"]);
    expect(plans.plansFor("unknown-model")).toBeNull();
    const accounts = await pool.accounts();
    expect(plans.eligible(accounts, "gpt-5.3-codex-spark").map((account) => account.label)).toEqual(["lite-a"]);
    expect(plans.eligible(accounts, "unknown-model")).toHaveLength(3);
  });

  it("keeps a plan's previous models when its catalog cannot be read", async () => {
    const { pool } = await poolWith([["plus-a", "plus"], ["lite-a", "prolite"]]);
    let plusDown = false;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const account = (init.headers as Record<string, string>)["chatgpt-account-id"];
      if (account === "plus-a" && plusDown) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ models: [{ slug: "gpt-5.5" }] }));
    }) as unknown as typeof fetch;
    let now = 0;
    const plans = new CodexModelPlans({ pool, fetchImpl, now: () => now });
    await plans.refresh();
    plusDown = true;
    now += 10 * 60_000;
    await plans.refresh();
    expect([...plans.plansFor("gpt-5.5")!].sort()).toEqual(["plus", "prolite"]);
  });
});
