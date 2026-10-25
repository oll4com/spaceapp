import { describe, expect, it } from "vitest";
import { SessionRevocationStore, signSessionWithTtl, verifySession, type SessionRevocationPersistence } from "../src/auth.js";

/** In-memory stand-in for the durable table: survives a "restart" (a new store instance). */
function fakePersistence() {
  const signatures = new Map<string, number>();
  const userEpochs = new Map<string, number>();
  const writes: string[] = [];
  const persistence: SessionRevocationPersistence = {
    load: async (nowMs) => ({
      signatures: [...signatures].filter(([, expiresAt]) => expiresAt > nowMs),
      userEpochs: [...userEpochs]
    }),
    revokeSignature: async (hash, expiresAt) => { writes.push(hash); signatures.set(hash, expiresAt); },
    revokeUser: async (userId, epoch) => { userEpochs.set(userId, epoch); },
    pruneExpired: async (nowMs) => {
      let removed = 0;
      for (const [hash, expiresAt] of signatures) if (expiresAt <= nowMs) { signatures.delete(hash); removed++; }
      return removed;
    }
  };
  return { persistence, signatures, writes };
}

describe("session revocations survive an API restart (SEC-011)", () => {
  const secret = "test-secret-with-enough-length";
  const user = { id: "user:restart", email: "restart@space.test", role: "ADMIN" as const };

  it("keeps a logged-out token revoked in a new store loaded from persistence", async () => {
    const durable = fakePersistence();
    const token = signSessionWithTtl(user, secret, 3600);
    const other = signSessionWithTtl(user, secret, 7200);
    const before = new SessionRevocationStore();
    try {
      await before.attachPersistence(durable.persistence);
      await before.revokeToken(token);
      expect(verifySession(token, secret, before)).toBeNull();
    } finally { before.close(); }

    const restarted = new SessionRevocationStore();
    try {
      expect(verifySession(token, secret, restarted)).toMatchObject({ id: user.id }); // the old gap
      await restarted.attachPersistence(durable.persistence);
      expect(verifySession(token, secret, restarted)).toBeNull();
      expect(verifySession(other, secret, restarted)).toMatchObject({ id: user.id });
    } finally { restarted.close(); }
  });

  it("persists only a SHA-256 of the signature, never the token", async () => {
    const durable = fakePersistence();
    const token = signSessionWithTtl(user, secret, 3600);
    const store = new SessionRevocationStore();
    try {
      await store.attachPersistence(durable.persistence);
      await store.revokeToken(token);
    } finally { store.close(); }
    expect(durable.writes).toHaveLength(1);
    expect(durable.writes[0]).toMatch(/^[0-9a-f]{64}$/);
    for (const part of token.split(".")) expect(durable.writes[0]).not.toContain(part);
  });

  it("keeps 'log out everywhere' across a restart for sessions issued before it", async () => {
    const durable = fakePersistence();
    const oldToken = signSessionWithTtl(user, secret, 3600);
    const store = new SessionRevocationStore();
    try {
      await store.attachPersistence(durable.persistence);
      await store.revokeUser(user.id, Date.now() + 1000);
    } finally { store.close(); }
    const restarted = new SessionRevocationStore();
    try {
      await restarted.attachPersistence(durable.persistence);
      expect(verifySession(oldToken, secret, restarted)).toBeNull();
    } finally { restarted.close(); }
  });

  it("does not resurrect expired revocations", async () => {
    const durable = fakePersistence();
    const token = signSessionWithTtl(user, secret, 3600);
    const store = new SessionRevocationStore();
    try {
      await store.attachPersistence(durable.persistence);
      await store.revokeToken(token, Date.now() - 1);
    } finally { store.close(); }
    const restarted = new SessionRevocationStore();
    try {
      await restarted.attachPersistence(durable.persistence);
      expect(verifySession(token, secret, restarted)).toMatchObject({ id: user.id });
    } finally { restarted.close(); }
  });
});
