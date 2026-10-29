import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { InMemoryStreamingRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { StreamingCredentialStore } from "../src/streaming-credential-store.js";
import { StreamingService } from "../src/streaming-service.js";
import { createSetupSelectedServiceAdapters } from "../src/setup-selected-services.js";
import { createProductionSetupActionAdapter } from "../src/setup-production-actions.js";
import type { StreamingProviderAdapter } from "../src/streaming-providers.js";

it("checks only an authorized streaming account, detects token rotation and rejects revoked provider access without publishing", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-streaming-")); let revoked = false; const requests: string[] = [];
  const upstream = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`); response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(revoked ? [] : [{ externalAccountId: "owned-channel", displayName: "Owned channel", badge: "Channel", grantSubject: "owned-grant" }]));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const credentials = new StreamingCredentialStore(root); await credentials.initialize();
  const repository = new InMemoryStreamingRepository();
  const token = { accessToken: "fixture-access-token", refreshToken: "fixture-refresh-token", expiresAt: "2099-01-01T00:00:00.000Z", tokenType: "Bearer", scopes: [], grantSubject: "owned-grant" };
  await writeFile(credentials.clientPath("YOUTUBE"), JSON.stringify({ clientId: "fixture-client", clientSecret: "fixture-secret", redirectUri: "https://space.example/callback" }), { mode: 0o600 });
  await credentials.writeCredential("streaming-credential:owned", token);
  const authorization = await repository.upsertAuthorization({ id: "streaming-auth:owned", provider: "YOUTUBE", externalGrantId: "owned-grant", credentialRef: "streaming-credential:owned", status: "ACTIVE", scopes: [] });
  await repository.upsertAccount({ id: "streaming-account:owned", authorizationId: authorization.id, provider: "YOUTUBE", externalAccountId: "owned-channel", displayName: "Owned channel", badge: "Channel" });
  const adapter: StreamingProviderAdapter = {
    provider: "YOUTUBE", authorizationUrl: () => origin,
    exchangeCode: async () => { throw Error("No login in a connection check"); },
    refreshToken: async () => { throw Error("Fixture token is current"); },
    revoke: async () => { throw Error("Checks must not revoke a grant"); },
    discoverAccounts: async () => { const response = await fetch(`${origin}/owned-accounts`); return response.json(); },
    collectMetrics: async () => ({})
  };
  const service = new StreamingService({ repository, credentialStore: credentials, store: new InMemorySpaceStore(),
    adapters: { YOUTUBE: adapter, TWITCH: { ...adapter, provider: "TWITCH" }, TIKTOK: { ...adapter, provider: "TIKTOK" }, X: { ...adapter, provider: "X" }, DISCORD: { ...adapter, provider: "DISCORD" } } });
  try {
    const checks = createSetupSelectedServiceAdapters({ databases: { listConnections: async () => [], getConnection: async () => { throw Error(); }, getAdapter: async () => { throw Error(); } }, streaming: service } as Parameters<typeof createSetupSelectedServiceAdapters>[0]);
    const check = checks["dock:streaming"]; expect(check).toBeDefined();
    expect(await check!.list("user:owner")).toEqual([{ id: "streaming-account:owned", label: "YOUTUBE · Owned channel" }]);
    await expect(check!.inspect("user:owner", "unapproved-account")).rejects.toThrow(); expect(requests).toEqual([]);
    const first = await check!.inspect("user:owner", "streaming-account:owned"); expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await check!.inspect("user:owner", "streaming-account:owned")).toBe(first);
    await credentials.writeCredential("streaming-credential:owned", { ...token, accessToken: "rotated-fixture-token" });
    expect(await check!.inspect("user:owner", "streaming-account:owned")).not.toBe(first);
    revoked = true; await expect(check!.inspect("user:owner", "streaming-account:owned")).rejects.toThrow();
    expect(requests.every(request => request === "GET /owned-accounts")).toBe(true);
    expect((await repository.getOverlaySettings()).version).toBe(1);
  } finally { await service.dispose(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

it("does not issue a Streaming metrics receipt when its data source fails despite a verified destination", async () => {
  const adapter = createProductionSetupActionAdapter({ task: { actionId: "VERIFY_STREAMING", featureId: "widget:streaming-metrics" },
    ownerId: "user:owner", plan: { catalogVersion: "first-setup-v2.0" }, store: new InMemorySpaceStore(), connections: {},
    selectedServiceFingerprint: async () => "b".repeat(64), capabilityChecks: { "widget:streaming-metrics": async () => { throw Error("Metrics source is unavailable"); } }
  } as Parameters<typeof createProductionSetupActionAdapter>[0]);
  expect(adapter).not.toBeNull();
  await expect(adapter!.inspect()).rejects.toThrow("Metrics source is unavailable");
});
