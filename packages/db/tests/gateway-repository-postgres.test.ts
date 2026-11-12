import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool } from "../src/space-store.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresGatewayRepository } from "../src/gateway-repository.js";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

it.skipIf(postgresUnavailable)("stores Space Gateway settings, keys, logs and daily rollups without plaintext secrets", async () => {
  const migrations = await loadMigrations();
  const target = migrations.find(item => item.id === "0185_space_gateway_output_policy");
  expect(target, "Space Gateway migration must exist").toBeDefined();
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const name = `space-gateway-${randomUUID()}`;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const pool = createSpacePgPool(`postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}`, { max: 4 });
  let created = false;
  try {
    docker(["run", "--tmpfs", "/var/lib/postgresql/data", "--detach", "--rm", "--pull=never", "--name", name, "--network", "none", "--mount", `type=bind,source=${socket},target=/var/run/postgresql`,
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "pgvector/pgvector:0.8.7-pg17-trixie", "-c", "listen_addresses="]);
    created = true;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if (docker(["exec", name, "cat", "/proc/1/comm"]) !== "postgres") throw Error(); await pool.query("SELECT 1"); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!ready) throw Error("Owned PostgreSQL did not become ready.");
    for (const item of migrations.filter(item => item.id <= target!.id)) await pool.query(item.sql);
    // Re-running the migrations is a no-op.
    for (const item of migrations.filter(item => item.id >= "0184" && item.id <= target!.id)) await pool.query(item.sql);
    // The request log's Anthropic request id (token usage page), twice: it is a no-op the second time.
    for (let run = 0; run < 2; run += 1) await pool.query(migrations.find(item => item.id === "0204_token_usage_routes")!.sql);

    const repository = new PostgresGatewayRepository(pool);
    const settings = await repository.getSettings();
    expect(settings).toMatchObject({ routingStrategy: "CAPACITY_WEIGHTED", compressionMode: "OFF", compressionCodeText: "ON", planPriority: ["plus", "prolite", "pro"],
      requestLogRetentionDays: 30 });
    const updated = await repository.updateSettings({ routingStrategy: "ROUND_ROBIN", compressionMode: "ON", compressionCodeText: "ON", planPriority: ["pro"] });
    expect(updated).toMatchObject({ routingStrategy: "ROUND_ROBIN", compressionMode: "ON", compressionCodeText: "ON", planPriority: ["pro"], stickyThreadsEnabled: true });
    await expect(repository.updateSettings({ routingStrategy: "RANDOM" as never })).rejects.toThrow();
    await expect(repository.updateSettings({ compressionCodeText: "ALWAYS" as never })).rejects.toThrow();
    await expect(repository.updateSettings({ compressionMode: "SHADOW" as never })).rejects.toThrow();
    // Migration 0185 fills the untouched per-provider object with the Phase A defaults; an update replaces it.
    expect(settings.compressionProviders).toEqual({ CLAUDE: { mode: "OFF", outputPolicy: "LEAN" }, ANTIGRAVITY: { mode: "OFF", outputPolicy: "LEAN" },
      CODEX: { outputPolicy: "OFF" } });
    expect((await repository.updateSettings({ compressionProviders: { CODEX: { mode: "ON", profile: "CACHE", outputPolicy: "BOTH" } } })).compressionProviders)
      .toEqual({ CODEX: { mode: "ON", profile: "CACHE", outputPolicy: "BOTH" } });
    expect((await repository.getSettings()).compressionProviders).toEqual({ CODEX: { mode: "ON", profile: "CACHE", outputPolicy: "BOTH" } });
    await expect(pool.query(`UPDATE space_gateway_settings SET compression_providers='[]'::jsonb`)).rejects.toThrow();

    await pool.query(`INSERT INTO space_gateway_accounts(account_id,provider,label,email,external_account_id,plan_type,credentials_encrypted,source)
      VALUES ($1,'CODEX','Team A','a@example.test','chatgpt-a','plus','v1.iv.tag.ct','OAUTH')`, [`gw_account:${"1".repeat(32)}`]);
    await pool.query(`INSERT INTO space_gateway_usage_windows(account_id,usage_window,used_percent,reset_at,window_minutes)
      VALUES ($1,'PRIMARY',42.5,'2030-01-01T00:00:00Z',300)`, [`gw_account:${"1".repeat(32)}`]);
    await expect(pool.query(`INSERT INTO space_gateway_accounts(account_id,provider,label,external_account_id,credentials_encrypted,source)
      VALUES ($1,'CODEX','Dup','chatgpt-a','x','OAUTH')`, [`gw_account:${"2".repeat(32)}`])).rejects.toThrow();
    const [account] = await repository.listAccounts();
    expect(account).toMatchObject({ provider: "CODEX", status: "ACTIVE", primaryWindow: { usedPercent: 42.5, windowMinutes: 300 },
      secondaryWindow: { usedPercent: null } });
    expect(await repository.setAccountStatus(account!.id, "PAUSED", "Operator paused")).toMatchObject({ status: "PAUSED", statusReason: "Operator paused" });

    const keyId = `gw_key:${"b".repeat(32)}`;
    const key = await repository.createApiKey({ keyId, name: "Codex CLI", keyHash: "c".repeat(64), keyPrefix: "sk-sgw-abcdefgh",
      trafficClass: "INTERACTIVE", allowedModels: ["gpt-5.6-sol"], enforcedModel: null, allowedReasoningEfforts: ["high", "xhigh"],
      enforcedReasoningEffort: null, accountIds: [account!.id], compressionOverride: "ON",
      limits: [{ limitType: "TOTAL_TOKENS", limitWindow: "DAILY", maxValue: 1_000_000, modelFilter: null, resetAt: "2030-01-02T00:00:00.000Z" }],
      expiresAt: null, createdBy: "user:admin", outputPolicyOverride: "OFF" });
    expect(key.outputPolicyOverride).toBe("OFF");
    expect((await repository.updateApiKey(keyId, { outputPolicyOverride: "LEAN" }))?.outputPolicyOverride).toBe("LEAN");
    expect((await repository.updateApiKey(keyId, { name: "Codex CLI" }))?.outputPolicyOverride).toBe("LEAN");
    expect((await repository.updateApiKey(keyId, { outputPolicyOverride: null }))?.outputPolicyOverride).toBeNull();
    await expect(pool.query(`UPDATE space_gateway_api_keys SET output_policy_override='LOUD' WHERE key_id=$1`, [keyId])).rejects.toThrow();
    expect(key).toMatchObject({ accountScopeEnabled: true, accountIds: [account!.id], allowedReasoningEfforts: ["high", "xhigh"],
      limits: [{ limitType: "TOTAL_TOKENS", maxValue: 1_000_000, currentValue: 0 }] });
    expect((await repository.findApiKeyByHash("c".repeat(64)))?.id).toBe(keyId);
    expect(await repository.findApiKeyByHash("d".repeat(64))).toBeNull();
    await repository.settleApiKeyUsage(keyId, { inputTokens: 600, outputTokens: 50, costMicros: 1200, model: "gpt-5.6-sol", at: "2030-01-01T12:00:00.000Z" });
    expect((await repository.findApiKeyByHash("c".repeat(64)))?.limits[0]).toMatchObject({ currentValue: 650, resetAt: "2030-01-02T00:00:00.000Z" });
    // After the window resets, counting starts again from this request and the next reset moves on.
    await repository.settleApiKeyUsage(keyId, { inputTokens: 10, outputTokens: 5, costMicros: 0, model: null, at: "2030-01-03T08:00:00.000Z" });
    const settled = await repository.findApiKeyByHash("c".repeat(64));
    expect(settled?.limits[0]).toMatchObject({ currentValue: 15, resetAt: "2030-01-04T00:00:00.000Z" });
    expect(settled?.lastUsedAt).toBe("2030-01-03T08:00:00.000Z");
    expect(await repository.updateApiKey(keyId, { isActive: false })).toMatchObject({ isActive: false, name: "Codex CLI" });
    await expect(pool.query(`UPDATE space_gateway_api_keys SET allowed_reasoning_efforts='{turbo}' WHERE key_id=$1`, [keyId])).rejects.toThrow();

    const base = { provider: "CODEX" as const, accountId: account!.id, apiKeyId: keyId, model: "gpt-5.6-sol", reasoningEffort: "high",
      serviceTier: null, transport: "http", errorCode: null, latencyMs: 900, firstTokenMs: 300, cachedInputTokens: 10, reasoningTokens: null,
      compressionTokensSaved: 5, stickyKind: null, stickyKeyHash: null };
    await repository.insertRequestLogs([
      { ...base, requestId: "r1", requestedAt: "2030-01-01T10:00:00.000Z", status: "success", inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
      { ...base, requestId: "r2", requestedAt: "2030-01-01T11:00:00.000Z", status: "error", errorCode: "upstream_error", inputTokens: null,
        outputTokens: null, costUsd: null, reasoningTokens: 4 }
    ]);
    const logs = await repository.listRequestLogs({ limit: 10 });
    expect(logs.map(log => log.requestId)).toEqual(["r2", "r1"]);
    expect(logs[1]).toMatchObject({ inputTokens: 100, costUsd: 0.01, reasoningTokens: null });
    expect(await repository.listRequestLogs({ limit: 10, beforeId: Number(logs[0]!.id) })).toHaveLength(1);
    expect(await repository.usageSince("2030-01-01T00:00:00.000Z")).toEqual({ requests: 2, errors: 1, inputTokens: 100, outputTokens: 20,
      costUsd: 0.01, compressionTokensSaved: 10 });
    expect(await repository.requestStatsSince("2030-01-01T00:00:00.000Z")).toEqual({ total: 2, failed: 1, rateLimited: 0, cached: 2, cacheCreationTokens: 0, byProvider: { CODEX: 2 },
      byModel: { "gpt-5.6-sol": 2 }, inputTokens: 100, cachedInputTokens: 20, outputTokens: 20, compressionTokensSaved: 10,
      latency: { count: 2, averageMs: 900, minMs: 900, maxMs: 900 }, ttfb: { count: 2, averageMs: 300, minMs: 300, maxMs: 300 } });
    const daily = (await pool.query(`SELECT requests, errors, input_tokens, reasoning_reported FROM space_gateway_usage_daily`)).rows;
    expect(daily).toEqual([{ requests: "2", errors: "1", input_tokens: "100", reasoning_reported: "1" }]);

    const report = await repository.usageReport("2030-01-01", "2030-01-31");
    expect(report.days).toEqual([expect.objectContaining({ key: "2030-01-01", requests: 2, errors: 1, inputTokens: 100, cachedInputTokens: 20, reasoningReported: 1, costUsd: 0.01 })]);
    expect(report.models.map(row => row.key)).toEqual(["gpt-5.6-sol"]);
    expect(report.accounts.map(row => row.key)).toEqual([account!.id]);
    expect((await repository.usageReport("2030-02-01", "2030-02-28")).days).toEqual([]);
    expect(report.providers.map(row => row.key)).toEqual(["CODEX"]);
    expect(await repository.accountDailyUsage("2030-01-01", "2030-01-31")).toEqual([{ day: "2030-01-01", accountId: account!.id, model: "gpt-5.6-sol", tokens: 120, costUsd: 0.01 }]);
    // One request id refused on Claude and served on Codex is a Space-pool fallback (March, outside the ranges above).
    await repository.insertRequestLogs([
      { ...base, provider: "CLAUDE", requestId: "r3", requestedAt: "2030-03-01T10:00:00.000Z", status: "error", errorCode: "rate_limit_error", inputTokens: null,
        outputTokens: null, costUsd: null },
      { ...base, requestId: "r3", requestedAt: "2030-03-01T10:00:01.000Z", status: "success", inputTokens: 10, outputTokens: 2, costUsd: 0.001 }
    ]);
    expect(await repository.providerFallbacks("2030-03-01", "2030-03-01")).toEqual([{ fromProvider: "CLAUDE", toProvider: "CODEX", requests: 1, served: 1 }]);
    expect(await repository.providerFallbacks("2030-01-01", "2030-01-31")).toEqual([]);

    await repository.recordCompression([
      { hour: "2030-01-01T10:15:00.000Z", mode: "ON", provider: "CODEX", strategy: "smart_crusher", requests: 0, modifiedRequests: 0, blocks: 2,
        rejectedBlocks: 1, errorBlocks: 0, timedOut: 0, originalTokens: 1000, compressedTokens: 300, overheadMs: 12, maxOverheadMs: 8 },
      { hour: "2030-01-01T10:45:00.000Z", mode: "ON", provider: "CODEX", strategy: "smart_crusher", requests: 0, modifiedRequests: 0, blocks: 1,
        rejectedBlocks: 0, errorBlocks: 0, timedOut: 0, originalTokens: 500, compressedTokens: 100, overheadMs: 5, maxOverheadMs: 9 }
    ]);
    expect(await repository.compressionSince("2030-01-01T10:30:00.000Z")).toEqual([expect.objectContaining({
      hour: "2030-01-01T10:00:00.000Z", blocks: 3, rejectedBlocks: 1, originalTokens: 1500, compressedTokens: 400, overheadMs: 17, maxOverheadMs: 9 })]);

    expect(await repository.speedDefaults()).toEqual({ models: {}, updatedAt: null });
    expect((await repository.setSpeedDefault("gpt-6-astra", "fast")).models).toEqual({ "gpt-6-astra": "fast" });
    await repository.setSpeedDefault("gpt-5.5", "fast");
    const speeds = await repository.setSpeedDefault("gpt-6-astra", "standard");
    expect(speeds.models).toEqual({ "gpt-5.5": "fast" });
    expect(speeds.updatedAt).not.toBeNull();


    // Accounts: upsert by upstream identity, locked credential updates, usage windows and runtime state.
    const teamB = await repository.upsertAccount({ accountId: `gw_account:${"3".repeat(32)}`, provider: "CODEX", label: "Team B",
      email: "b@example.test", externalAccountId: "chatgpt-b", planType: "pro", credentialsEncrypted: "v1.one", credentialsExpiresAt: null,
      source: "OAUTH", sourceRef: null, lastRefreshAt: "2030-01-01T00:00:00.000Z" });
    expect(teamB).toMatchObject({ status: "ACTIVE", planType: "pro", credentialsEncrypted: "v1.one" });
    await repository.setAccountStatus(teamB.id, "PAUSED", "Operator");
    const again = await repository.upsertAccount({ accountId: `gw_account:${"4".repeat(32)}`, provider: "CODEX", label: "Ignored",
      email: "b@example.test", externalAccountId: "chatgpt-b", planType: null, credentialsEncrypted: "v1.two", credentialsExpiresAt: null,
      source: "OAUTH", sourceRef: null, lastRefreshAt: null });
    expect(again).toMatchObject({ id: teamB.id, label: "Team B", planType: "pro", credentialsEncrypted: "v1.two", status: "PAUSED" });
    await repository.setAccountStatus(teamB.id, "ACTIVE", null);
    // Two concurrent refreshes run one after the other; the second sees the first one's rotated token.
    const seen: string[] = [];
    await Promise.all(["v1.three", "v1.four"].map(next => repository.withAccountCredentialLock(teamB.id, async current => {
      seen.push(current.credentialsEncrypted);
      await new Promise(resolve => setTimeout(resolve, 50));
      return { credentialsEncrypted: next, lastRefreshAt: "2030-01-02T00:00:00.000Z" };
    })));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe("v1.two");
    expect(["v1.three", "v1.four"]).toContain(seen[1]);
    const statusChange = await repository.withAccountCredentialLock(teamB.id, async () => ({ status: "REAUTH_REQUIRED", statusReason: "Refresh token was reused - re-login required" }));
    expect(statusChange).toMatchObject({ status: "REAUTH_REQUIRED", statusReason: expect.stringContaining("re-login") });
    expect(await repository.withAccountCredentialLock(`gw_account:${"9".repeat(32)}`, async () => null)).toBeNull();
    await repository.saveUsageWindows(teamB.id, [{ window: "PRIMARY", usedPercent: 120, resetAt: "2030-01-01T05:00:00.000Z", windowMinutes: 300 },
      { window: "SECONDARY", usedPercent: null, resetAt: null, windowMinutes: null }, { quotaKey: "gpt-6", window: "PRIMARY", usedPercent: 5, resetAt: null, windowMinutes: null }]);
    const withUsage = (await repository.listAccounts()).find(account => account.id === teamB.id)!;
    expect(withUsage.primaryWindow).toEqual({ usedPercent: 100, resetAt: "2030-01-01T05:00:00.000Z", windowMinutes: 300 });
    expect(withUsage.quotaGroups).toEqual([{ key: "gpt-6", primaryWindow: { usedPercent: 5, resetAt: null, windowMinutes: null },
      secondaryWindow: { usedPercent: null, resetAt: null, windowMinutes: null } }]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM space_gateway_usage_history WHERE account_id=$1`, [teamB.id])).rows[0].n).toBe(2);
    // Weekly peaks: a reset hour's highest sample before that reset; a sample taken after its reset is stale.
    for (const [usedPercent, resetAt] of [[40, "2999-01-08T00:00:00.100Z"], [55, "2999-01-08T00:30:00.000Z"], [0, "2020-01-08T00:00:00.000Z"]] as const) {
      await repository.saveUsageWindows(teamB.id, [{ window: "SECONDARY", usedPercent, resetAt, windowMinutes: 10080 }]);
    }
    expect(await repository.weeklyPeaks("2020-01-01", "2999-12-31")).toEqual([{ accountId: teamB.id, quotaKey: "", resetAt: "2999-01-08T00:30:00.000Z",
      usedPercent: 55, lastSampleAt: expect.any(String) }]);
    // Pace day start (plan clipboard:DotwYXVD2N3n): the last sample of that week at or before the time, else its first one after.
    expect(await repository.weekUsedAt(teamB.id, "2020-01-01T00:00:00.000Z", "2999-01-08T00:15:00.000Z")).toBe(40);
    expect(await repository.weekUsedAt(teamB.id, "2020-01-01T00:00:00.000Z", "2999-01-09T00:00:00.000Z")).toBeNull();
    await repository.recordAccountState(teamB.id, { status: "RATE_LIMITED", statusReason: "Try again in 30s", blockedUntil: "2030-01-01T00:00:30.000Z" });
    await repository.touchAccounts([teamB.id], "2030-01-01T00:00:00.000Z");
    expect((await repository.listAccounts()).find(account => account.id === teamB.id)).toMatchObject({ status: "RATE_LIMITED", blockedUntil: "2030-01-01T00:00:30.000Z", lastUsedAt: "2030-01-01T00:00:00.000Z" });
    await repository.setAccountStatus(teamB.id, "PAUSED", null);
    await repository.recordAccountState(teamB.id, { status: "ACTIVE", statusReason: null, blockedUntil: null });
    expect((await repository.listAccounts()).find(account => account.id === teamB.id)?.status).toBe("PAUSED");
    await repository.saveResetCredits(teamB.id, 2);
    expect((await repository.listAccounts()).find(account => account.id === teamB.id)?.resetCreditsAvailable).toBe(2);

    // Sticky bindings: upsert by key hash, expiry, skipped for unknown accounts, removed with the account.
    const keyA = "a".repeat(64), keyB = "b".repeat(64);
    await repository.saveStickyBindings([
      { keyHash: keyA, kind: "STICKY_THREAD", provider: "CODEX", accountId: teamB.id, expiresAt: "2030-01-02T00:00:00.000Z" },
      { keyHash: keyB, kind: "CONTINUATION", provider: "CODEX", accountId: `gw_account:${"8".repeat(32)}`, expiresAt: null }
    ]);
    await repository.saveStickyBindings([{ keyHash: keyA, kind: "PROMPT_CACHE", provider: "CODEX", accountId: teamB.id, expiresAt: "2030-01-03T00:00:00.000Z" }]);
    expect(await repository.findStickyBinding(keyA, "2030-01-02T12:00:00.000Z")).toEqual({ keyHash: keyA, kind: "PROMPT_CACHE", provider: "CODEX",
      accountId: teamB.id, expiresAt: "2030-01-03T00:00:00.000Z" });
    expect(await repository.findStickyBinding(keyB, "2030-01-01T00:00:00.000Z")).toBeNull();
    expect(await repository.findStickyBinding(keyA, "2030-01-04T00:00:00.000Z")).toBeNull();
    expect(await repository.pruneStickyBindings("2030-01-02T00:00:00.000Z")).toBe(0);
    await repository.saveStickyBindings([{ keyHash: keyB, kind: "STICKY_THREAD", provider: "CODEX", accountId: teamB.id, expiresAt: null }]);
    expect(await repository.pruneStickyBindings("2030-01-04T00:00:00.000Z")).toBe(1);
    expect(await repository.deleteAccount(teamB.id)).toBe(true);
    expect(await repository.findStickyBinding(keyB, "2030-01-01T00:00:00.000Z")).toBeNull();
    expect(await repository.deleteAccount(teamB.id)).toBe(false);

    // Deleting a key keeps its log rows but detaches them.
    expect(await repository.deleteApiKey(keyId)).toBe(true);
    expect((await repository.listRequestLogs({ limit: 10 }))[0]!.apiKeyId).toBeNull();
  } finally {
    await pool.end();
    if (created) docker(["stop", "--time", "5", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
