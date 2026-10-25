import { describe, expect, it } from "vitest";
import {
  InMemoryStreamingRepository,
  StreamingSettingsVersionConflictError,
  loadMigrations
} from "../src/index.js";

describe("streaming repository", () => {
  it("persists only opaque credential references and deduplicates platform accounts", async () => {
    const repository = new InMemoryStreamingRepository();
    const authorization = await repository.upsertAuthorization({
      id: "streaming-auth:one",
      provider: "YOUTUBE",
      externalGrantId: "grant-one",
      credentialRef: "streaming-credential:one",
      status: "ACTIVE",
      scopes: ["youtube.readonly"]
    });
    await repository.upsertAccount({
      id: "streaming-account:one",
      authorizationId: authorization.id,
      provider: "YOUTUBE",
      externalAccountId: "channel-one",
      displayName: "Channel One",
      badge: "@channel-one"
    });
    const duplicate = await repository.upsertAccount({
      id: "streaming-account:duplicate",
      authorizationId: authorization.id,
      provider: "YOUTUBE",
      externalAccountId: "channel-one",
      displayName: "Renamed Channel",
      badge: "@channel-one"
    });
    expect(duplicate.id).toBe("streaming-account:one");
    expect(await repository.listAccounts()).toHaveLength(1);
    expect(JSON.stringify(await repository.listAuthorizations())).not.toContain("accessToken");
  });

  it("consumes OAuth attempts once and rejects expired or session-mismatched state", async () => {
    const repository = new InMemoryStreamingRepository();
    await repository.createOAuthAttempt({
      id: "streaming-attempt:one",
      provider: "TWITCH",
      stateHash: "a".repeat(64),
      sessionHash: "b".repeat(64),
      verifierCredentialRef: "streaming-verifier:one",
      redirectUri: "https://space.example/api/admin/streaming/providers/TWITCH/oauth/callback",
      expiresAt: "2026-08-11T10:10:00.000Z"
    });
    expect(await repository.consumeOAuthAttempt({
      stateHash: "a".repeat(64),
      sessionHash: "c".repeat(64),
      consumedAt: "2026-08-11T10:05:00.000Z"
    })).toBeNull();
    expect(await repository.consumeOAuthAttempt({
      stateHash: "a".repeat(64),
      sessionHash: "b".repeat(64),
      consumedAt: "2026-08-11T10:05:00.000Z"
    })).toMatchObject({ id: "streaming-attempt:one" });
    expect(await repository.consumeOAuthAttempt({
      stateHash: "a".repeat(64),
      sessionHash: "b".repeat(64),
      consumedAt: "2026-08-11T10:06:00.000Z"
    })).toBeNull();
  });

  it("uses optimistic overlay settings versions", async () => {
    const repository = new InMemoryStreamingRepository();
    const saved = await repository.updateOverlaySettings({
      expectedVersion: 1,
      tiles: [{ metricKey: "space.rooms", accountId: null }],
      customTextEnabled: true,
      customText: "Live now",
      updatedBy: "user:operator",
      updatedAt: "2026-08-11T10:00:00.000Z"
    });
    expect(saved.version).toBe(2);
    await expect(repository.updateOverlaySettings({
      expectedVersion: 1,
      tiles: [],
      customTextEnabled: false,
      customText: "",
      updatedBy: "user:operator",
      updatedAt: "2026-08-11T10:01:00.000Z"
    })).rejects.toBeInstanceOf(StreamingSettingsVersionConflictError);
  });

  it("adds the secret-free streaming migration after system analytics", async () => {
    const migration = (await loadMigrations()).find((entry) => entry.id === "0079_streaming_integrations");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS streaming_oauth_authorizations");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS streaming_platform_accounts");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS streaming_oauth_attempts");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS streaming_overlay_settings");
    expect(migration?.sql).toContain("credential_ref text NOT NULL UNIQUE");
    expect(migration?.sql).not.toMatch(/access_token|refresh_token|client_secret/i);
  });
});
