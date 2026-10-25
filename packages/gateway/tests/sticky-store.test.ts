import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { StickyStore } from "../src/accounts/sticky-store.js";

const account = `gw_account:${"a".repeat(32)}`;
const key = "f".repeat(64);

async function repositoryWithAccount() {
  const repository = new InMemoryGatewayRepository();
  await repository.upsertAccount({ accountId: account, provider: "CODEX", label: "A", email: null, externalAccountId: "a", planType: "plus",
    credentialsEncrypted: "v1.x.y.z", credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: null });
  return repository;
}

describe("sticky store", () => {
  it("survives a restart through storage and expires after its time to live", async () => {
    const repository = await repositoryWithAccount();
    let now = Date.parse("2030-01-01T00:00:00Z");
    const first = new StickyStore({ repository, provider: "CODEX", kind: "STICKY_THREAD", ttlMs: 60_000, now: () => now });
    first.set(key, account);
    expect(await first.get(key)).toBe(account);
    await first.flush();
    const restarted = new StickyStore({ repository, provider: "CODEX", kind: "STICKY_THREAD", ttlMs: 60_000, now: () => now });
    expect(await restarted.get(key)).toBe(account);
    now += 61_000;
    const later = new StickyStore({ repository, provider: "CODEX", kind: "STICKY_THREAD", ttlMs: 60_000, now: () => now });
    expect(await later.get(key)).toBeUndefined();
    expect(await repository.pruneStickyBindings(new Date(now).toISOString())).toBe(1);
  });

  it("asks storage once per unknown key a minute and treats storage failures as no binding", async () => {
    const repository = await repositoryWithAccount();
    const find = vi.spyOn(repository, "findStickyBinding").mockRejectedValueOnce(new Error("down"));
    const errors: unknown[] = [];
    const store = new StickyStore({ repository, provider: "CODEX", kind: "STICKY_THREAD", onError: (error) => errors.push(error) });
    expect(await store.get(key)).toBeUndefined();
    expect(await store.get(key)).toBeUndefined();
    expect(find).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    store.set(key, account);
    expect(await store.get(key)).toBe(account);
  });

  it("skips bindings to accounts that no longer exist", async () => {
    const repository = new InMemoryGatewayRepository();
    const store = new StickyStore({ repository, provider: "CLAUDE", kind: "PROMPT_CACHE" });
    store.set(key, account);
    await store.flush();
    expect(repository.sticky.size).toBe(0);
  });
});
