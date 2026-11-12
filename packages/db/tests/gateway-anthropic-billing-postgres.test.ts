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

/** Migration 0229 (operator request 2026-10-18): the sealed Anthropic admin key, its sync state and the daily report rows. */
it.skipIf(postgresUnavailable)("stores the sealed Anthropic admin key, the report rows and a real-cost limit value like the in-memory twin", async () => {
  const migrations = await loadMigrations();
  const target = migrations.find(item => item.id === "0229_space_gateway_anthropic_billing");
  expect(target, "Anthropic billing migration must exist").toBeDefined();
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const name = `space-gateway-anthropic-${randomUUID()}`;
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
    await pool.query(target!.sql);

    const repository = new PostgresGatewayRepository(pool);
    expect(await repository.getAnthropicAdmin()).toBeNull();
    await repository.recordAnthropicSync({ at: "2030-01-10T12:00:00.000Z", error: "ignored" });
    expect(await repository.getAnthropicAdmin()).toBeNull();
    await repository.saveAnthropicAdminKey({ keyEncrypted: "v1.iv.tag.ct", keyHint: "…aaaa", at: "2030-01-10T11:00:00.000Z" });
    const upstream = [{ accountId: `gw_account:${"d".repeat(32)}`, apiKeyId: "apikey_gateway", keyName: "Space Gateway", workspaceId: "" }];
    await repository.recordAnthropicSync({ at: "2030-01-10T12:00:00.000Z", error: null, upstream });
    await repository.recordAnthropicSync({ at: "2030-01-10T12:05:00.000Z", error: "anthropic_http_429" });
    expect(await repository.getAnthropicAdmin()).toEqual({ keyEncrypted: "v1.iv.tag.ct", keyHint: "…aaaa", savedAt: "2030-01-10T11:00:00.000Z",
      lastSyncAt: "2030-01-10T12:05:00.000Z", lastError: "anthropic_http_429", upstream });
    // A new key drops the old key's sync state.
    await repository.saveAnthropicAdminKey({ keyEncrypted: "v1.iv2.tag2.ct2", keyHint: "…bbbb", at: "2030-01-10T13:00:00.000Z" });
    expect(await repository.getAnthropicAdmin()).toMatchObject({ keyHint: "…bbbb", lastSyncAt: null, lastError: null, upstream: [] });

    const row = { source: "USAGE" as const, workspaceId: "", apiKeyId: "apikey_gateway", model: "claude-opus-5-5", contextWindow: "0-200k", speed: "standard",
      item: "output_tokens", value: 100_000 };
    await repository.replaceAnthropicUsage("2030-01-09", [{ ...row, day: "2030-01-09" }, { ...row, day: "2030-01-10" }, { ...row, day: "2030-01-10", source: "COST", apiKeyId: "", value: 12.5 }]);
    await repository.replaceAnthropicUsage("2030-01-10", [{ ...row, day: "2030-01-10", value: 200_000 }]);
    expect(await repository.listAnthropicUsage("2030-01-01", "2030-01-31")).toEqual([{ ...row, day: "2030-01-09" }, { ...row, day: "2030-01-10", value: 200_000 }]);

    const keyId = `gw_key:${"b".repeat(32)}`;
    await repository.createApiKey({ keyId, name: "Claude API credits (CLIs)", keyHash: "c".repeat(64), keyPrefix: "sk-sgw-abcdefgh", trafficClass: "INTERACTIVE",
      allowedModels: [], enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null,
      limits: [{ limitType: "COST_USD", limitWindow: "DAILY", maxValue: 200_000_000, modelFilter: null, resetAt: "2030-01-11T00:00:00.000Z" },
        { limitType: "COST_USD", limitWindow: "DAILY", maxValue: 5_000_000, modelFilter: "claude-opus-5-5", resetAt: "2030-01-11T00:00:00.000Z" }],
      expiresAt: null, createdBy: null });
    await repository.setApiKeyLimitValue(keyId, { limitType: "COST_USD", limitWindow: "DAILY" }, 15_000_000.4, "2030-01-10T12:00:00.000Z");
    // A window that has already reset is left to the next request's settle.
    await repository.setApiKeyLimitValue(keyId, { limitType: "COST_USD", limitWindow: "DAILY" }, 99, "2030-01-11T00:00:00.000Z");
    expect((await repository.listApiKeys())[0]!.limits.map((limit) => [limit.modelFilter, limit.currentValue])).toEqual([[null, 15_000_000], ["claude-opus-5-5", 0]]);

    expect(await repository.deleteAnthropicAdminKey()).toBe(true);
    expect(await repository.deleteAnthropicAdminKey()).toBe(false);
  } finally {
    await pool.end();
    if (created) docker(["stop", "--time", "5", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
