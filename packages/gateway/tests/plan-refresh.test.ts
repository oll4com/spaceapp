import { describe, expect, it } from "vitest";
import { GATEWAY_FREE_PLAN_PAUSE_REASON } from "@space/contracts";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type CredentialRefresher } from "../src/accounts/account-pool.js";
import { antigravityAccountActions } from "../src/admin/antigravity-sign-in.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { createAntigravityRefresher } from "../src/providers/antigravity/credentials.js";
import { startAntigravityUsagePoller } from "../src/providers/antigravity/usage-refresh.js";
import { createClaudeRefresher } from "../src/providers/claude/credentials.js";

// 31/10: three Google AI Pro accounts lapsed to free and still read "google-ai-pro" (the plan was read only at sign-in).
const cipher = createCredentialCipher(Buffer.alloc(32, 5));
const nowMs = Date.parse("2030-01-10T00:00:00Z");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function pool(provider: "ANTIGRAVITY" | "CLAUDE", planType: string, refresher: CredentialRefresher) {
  const repository = new InMemoryGatewayRepository();
  const accountId = `gw_account:${"7".repeat(32)}`;
  const stored = { accessToken: "at-1", refreshToken: "rt-1", idToken: null, upstreamAccountId: "project-1", accessExpiresAtMs: nowMs - 1 };
  await repository.upsertAccount({ accountId, provider, label: "A", email: null, externalAccountId: "ext-1", planType,
    credentialsEncrypted: cipher.encrypt(JSON.stringify(stored), accountId), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: null });
  const accounts = new AccountPool({ provider, repository, cipher: () => cipher, refresher, now: () => nowMs });
  return { repository, accounts, account: async () => (await repository.listAccounts()).find((item) => item.id === accountId)! };
}

describe("plan re-read on token refresh", () => {
  const google = (tier: () => Response) => (async (url: string) => (String(url).includes("loadCodeAssist") ? tier() : json({ access_token: "at-2", expires_in: 3600 }))) as unknown as typeof fetch;

  it("pauses an Antigravity account whose Google AI Pro lapsed to free, and keeps the plan when the tier read fails", async () => {
    const lapsed = await pool("ANTIGRAVITY", "google-ai-pro", createAntigravityRefresher({ now: () => nowMs, fetchImpl: google(() => json({ currentTier: { id: "free-tier" } })) }));
    await expect(lapsed.accounts.credentials(await lapsed.account())).rejects.toMatchObject({ code: "free_plan_paused" });
    expect(await lapsed.account()).toMatchObject({ planType: "free", status: "PAUSED", statusReason: GATEWAY_FREE_PLAN_PAUSE_REASON });

    const transient = await pool("ANTIGRAVITY", "google-ai-pro", createAntigravityRefresher({ now: () => nowMs, fetchImpl: google(() => json({}, 503)) }));
    expect(await transient.accounts.credentials(await transient.account())).toMatchObject({ accessToken: "at-2" });
    expect(await transient.account()).toMatchObject({ planType: "google-ai-pro", status: "ACTIVE" });

    const stillPro = await pool("ANTIGRAVITY", "google-ai-pro", createAntigravityRefresher({ now: () => nowMs,
      fetchImpl: google(() => json({ paidTier: { id: "g1-pro-tier", name: "Google AI Pro" }, currentTier: { id: "standard-tier" } })) }));
    await stillPro.accounts.credentials(await stillPro.account());
    expect(await stillPro.account()).toMatchObject({ planType: "google-ai-pro", status: "ACTIVE" });
  });

  it("automatically unpauses a free-paused Antigravity account when it upgrades or renews Google AI Pro (nth/mes, 2026-11-08)", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("loadCodeAssist")) {
        return json({ cloudaicompanionProject: "project-1", paidTier: { id: "g1-pro-tier", name: "Google AI Pro" }, currentTier: { id: "standard-tier" } });
      }
      if (String(url).includes("retrieveUserQuotaSummary")) {
        return json({ groups: [{ displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 1 }, { window: "weekly", remainingFraction: 1 }] }] });
      }
      return json({ access_token: "at-2", expires_in: 3600 });
    }) as unknown as typeof fetch;

    const upgraded = await pool("ANTIGRAVITY", "free", createAntigravityRefresher({ now: () => nowMs, fetchImpl }));
    // Trigger initial free-plan auto-pause.
    await upgraded.accounts.accounts();
    expect(await upgraded.account()).toMatchObject({ planType: "free", status: "PAUSED", statusReason: GATEWAY_FREE_PLAN_PAUSE_REASON });

    // Background usage poller re-checks free-paused accounts and restores renewed Google AI Pro accounts to ACTIVE.
    const poller = startAntigravityUsagePoller({ repository: upgraded.repository, pool: upgraded.accounts, intervalMs: 60_000, fetchImpl });
    try {
      await poller.runOnce();
    } finally {
      poller.stop();
    }
    expect(await upgraded.account()).toMatchObject({
      planType: "google-ai-pro",
      status: "ACTIVE",
      statusReason: null,
      quotaGroups: [{ key: "gemini", primaryWindow: { usedPercent: 0 }, secondaryWindow: { usedPercent: 0 } }]
    });

    // Account test action also unpauses a free-paused account that renewed its subscription, while preserving admin pauses.
    const tested = await pool("ANTIGRAVITY", "free", createAntigravityRefresher({ now: () => nowMs, fetchImpl }));
    await tested.accounts.accounts();
    const res = await antigravityAccountActions({ repository: tested.repository, pool: tested.accounts, fetchImpl, now: () => nowMs }).test(await tested.account(), {});
    expect(res).toMatchObject({ ok: true, planType: "google-ai-pro" });
    expect(await tested.account()).toMatchObject({ planType: "google-ai-pro", status: "ACTIVE", statusReason: null });
  });

  it("pauses a Claude account whose profile now shows a free plan, and keeps the plan when the profile read fails", async () => {
    const claude = (profile: () => Response) => (async (url: string) => (String(url).includes("/oauth/profile") ? profile()
      : json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 28_800 }))) as unknown as typeof fetch;
    const lapsed = await pool("CLAUDE", "max20x", createClaudeRefresher({ now: () => nowMs, fetchImpl: claude(() => json({ organization: { organization_type: "claude_free" } })) }));
    await expect(lapsed.accounts.credentials(await lapsed.account())).rejects.toMatchObject({ code: "free_plan_paused" });
    expect(await lapsed.account()).toMatchObject({ planType: "free", status: "PAUSED" });

    const transient = await pool("CLAUDE", "max20x", createClaudeRefresher({ now: () => nowMs, fetchImpl: claude(() => json({}, 500)) }));
    expect(await transient.accounts.credentials(await transient.account())).toMatchObject({ accessToken: "at-2" });
    expect(await transient.account()).toMatchObject({ planType: "max20x", status: "ACTIVE" });
  });
});
