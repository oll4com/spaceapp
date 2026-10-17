import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamingCredentialStore } from "../src/credential-store.js";
import { StreamingTokenManager } from "../src/token-manager.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("StreamingTokenManager", () => {
  it("reports a revoked or expired sign-in as REAUTH_REQUIRED", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-streaming-token-"));
    roots.push(root);
    const credentialStore = new StreamingCredentialStore(root);
    await credentialStore.initialize();
    await writeFile(credentialStore.clientPath("YOUTUBE"), JSON.stringify({ clientId: "c", clientSecret: "s", redirectUri: "https://space.example/cb" }), { mode: 0o600 });
    await credentialStore.writeCredential("streaming-credential:expired", { accessToken: "old", refreshToken: "refresh", expiresAt: "2000-01-01T00:00:00.000Z" });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const manager = new StreamingTokenManager({ credentialStore, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(manager.getToken("YOUTUBE", "streaming-credential:expired")).rejects.toMatchObject({ code: "REAUTH_REQUIRED", transient: false });
  });
});
