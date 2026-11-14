import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "../src/index.js";

describe("single-owner setup", () => {
  it("stores only a token hash, accepts it once before expiry, and persists the owner password hash", () => {
    const store = new InMemorySpaceStore();
    const tokenHash = "a".repeat(64);
    const expiresAt = "2026-07-23T12:15:00.000Z";

    expect(store.initializeOwnerSetup({ tokenHash, expiresAt })).toEqual({
      setupRequired: true,
      expiresAt
    });
    expect(store.getOwnerSetupStatus()).toEqual({
      setupRequired: true,
      expiresAt
    });

    const claimed = store.claimOwnerSetup({
      tokenHash,
      email: "owner@example.com",
      passwordHash: "scrypt$32768$8$1$salt$hash",
      now: "2026-07-23T12:00:00.000Z"
    });

    expect(claimed).toMatchObject({
      user: {
        id: "user:owner",
        email: "owner@example.com",
        role: "ADMIN"
      },
      onboarding: {
        onboardingVersion: 2,
        isComplete: false,
        completedAt: null
      }
    });
    expect(claimed.onboarding.starterRoomId).toMatch(/^room:/);
    expect(store.getOwnerCredentials()).toEqual({
      user: claimed.user,
      passwordHash: "scrypt$32768$8$1$salt$hash"
    });
    expect(store.getOwnerSetupStatus()).toEqual({
      setupRequired: false,
      expiresAt: null
    });
    expect(() => store.claimOwnerSetup({
      tokenHash,
      email: "other@example.com",
      passwordHash: "replacement",
      now: "2026-07-23T12:01:00.000Z"
    })).toThrow(/already claimed/i);
  });

  it("rejects mismatched and expired setup token hashes without creating an owner", () => {
    const store = new InMemorySpaceStore();
    store.initializeOwnerSetup({
      tokenHash: "a".repeat(64),
      expiresAt: "2026-07-23T12:15:00.000Z"
    });

    expect(() => store.claimOwnerSetup({
      tokenHash: "b".repeat(64),
      email: "owner@example.com",
      passwordHash: "hash",
      now: "2026-07-23T12:00:00.000Z"
    })).toThrow(/token/i);
    expect(() => store.claimOwnerSetup({
      tokenHash: "a".repeat(64),
      email: "owner@example.com",
      passwordHash: "hash",
      now: "2026-07-23T12:16:00.000Z"
    })).toThrow(/expired/i);
    expect(store.getOwnerCredentials()).toBeNull();
  });

  it("takes the token file again at every start until an owner is claimed (light browser step 6b)", () => {
    const store = new InMemorySpaceStore();
    store.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2026-07-23T12:15:00.000Z" });
    expect(store.initializeOwnerSetup({ tokenHash: "b".repeat(64), expiresAt: "2026-07-23T12:30:00.000Z" }))
      .toEqual({ setupRequired: true, expiresAt: "2026-07-23T12:30:00.000Z" });
    const claim = (tokenHash: string) => store.claimOwnerSetup({ tokenHash, email: "owner@example.com", passwordHash: "hash", now: "2026-07-23T12:20:00.000Z" });
    expect(() => claim("a".repeat(64))).toThrow(/token/i);
    claim("b".repeat(64));
    expect(store.initializeOwnerSetup({ tokenHash: "c".repeat(64), expiresAt: "2026-07-23T13:00:00.000Z" }))
      .toEqual({ setupRequired: false, expiresAt: null });
  });
});
