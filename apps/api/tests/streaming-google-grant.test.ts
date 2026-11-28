import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStreamingRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { StreamingTokenManager, type StreamingProviderAdapter } from "@space/streaming";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamingCredentialStore } from "../src/streaming-credential-store.js";
import { StreamingService } from "../src/streaming-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(channels = [{ grantSubject: "google-sub", externalAccountId: "UC-owned", displayName: "Owned channel", badge: "Channel" }]) {
  const root = await mkdtemp(join(tmpdir(), "space-streaming-google-grant-"));
  roots.push(root);
  const credentials = new StreamingCredentialStore(root);
  await credentials.initialize();
  const repository = new InMemoryStreamingRepository();
  const adapter = {
    provider: "YOUTUBE", authorizationUrl: () => "https://accounts.google.com",
    exchangeCode: async () => { throw Error("unused"); }, revoke: async () => undefined,
    refreshToken: async () => { throw Error("unused"); },
    discoverAccounts: vi.fn(async () => channels), collectMetrics: async () => ({})
  } as unknown as StreamingProviderAdapter;
  const adapters = { YOUTUBE: adapter, TWITCH: adapter, TIKTOK: adapter, X: adapter, DISCORD: adapter };
  const service = new StreamingService({ repository, credentialStore: credentials, store: new InMemorySpaceStore(), adapters });
  return { credentials, repository, adapter, service };
}

const token = { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: "2000-01-01T00:00:00.000Z", tokenType: "Bearer", scopes: ["https://www.googleapis.com/auth/youtube.readonly"], grantSubject: null };
const loginClient = { clientId: "login-client", clientSecret: "login-secret", redirectUri: "https://space.test/api/auth/google/callback" };

describe("Streaming uses the Google sign-in grant when it has none of its own (27/11)", () => {
  it("stores the grant with the login client, refreshes through that client, and an own client file is the fallback", async () => {
    const { credentials, repository, service } = await fixture();
    expect(await service.importYouTubeGrant({ token, client: loginClient })).toBe(true);
    const [authorization] = await repository.listAuthorizations();
    expect(authorization).toMatchObject({ provider: "YOUTUBE", externalGrantId: "google-sub", status: "ACTIVE" });
    expect((await repository.listAccounts())[0]).toMatchObject({ externalAccountId: "UC-owned" });
    expect(await credentials.clientFor("YOUTUBE", authorization!.credentialRef)).toMatchObject({ clientId: "login-client" });

    // The bot's refresh (worker and API) sends the login client, since dev and fresh installs have no Streaming client file.
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "access-2", expires_in: 3600 }));
    const manager = new StreamingTokenManager({ credentialStore: credentials, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await manager.getToken("YOUTUBE", authorization!.credentialRef)).toMatchObject({ accessToken: "access-2", grantSubject: "google-sub" });
    expect(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).toContain("client_id=login-client");

    await writeFile(credentials.clientPath("YOUTUBE"), JSON.stringify({ clientId: "own-client", clientSecret: "own-secret", redirectUri: "https://space.test/cb" }), { mode: 0o600 });
    expect(await credentials.clientFor("YOUTUBE", "streaming-credential:other")).toMatchObject({ clientId: "own-client" });
  });

  it("never replaces an active Streaming connection and skips a Google account with no channel", async () => {
    const own = await fixture();
    await own.repository.upsertAuthorization({ id: "streaming-auth:own", provider: "YOUTUBE", externalGrantId: "own", credentialRef: "streaming-credential:own", status: "ACTIVE", scopes: [] });
    expect(await own.service.importYouTubeGrant({ token, client: loginClient })).toBe(false);
    expect(own.adapter.discoverAccounts).not.toHaveBeenCalled();
    const empty = await fixture([]);
    expect(await empty.service.importYouTubeGrant({ token, client: loginClient })).toBe(false);
    expect(await empty.repository.listAuthorizations()).toEqual([]);
  });
});
