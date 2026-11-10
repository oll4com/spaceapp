import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations } from "../src/migrations.js";
import { applyMigration } from "../src/migration-runner.js";
import { InMemoryAppDeviceSessionRepository, PostgresAppDeviceSessionRepository, type AppDeviceSessionRepository } from "../src/app-device-session-repository.js";

// Mobile device sessions (migration 0245, plan clipboard:VLBu2ge110ho step 4): the Settings > Account > Devices rows keep only the
// session id's SHA-256, revoke once, list live ones per app, and are pruned 30 days after they ended (class B). PostgreSQL runs
// only against a disposable, explicitly provided loopback database (same gate as the session revocation suite).
const address = process.env.SPACE_CONTINUATION_TEST_DATABASE_URL;
const socket = process.env.SPACE_CONTINUATION_TEST_PG_SOCKET;
const owner = "user:devices-test", otherOwner = "user:devices-test-other";
const day = 86400_000;

function contract(name: string, make: () => Promise<AppDeviceSessionRepository>) {
  it(`${name}: creates, lists, revokes once and prunes ended rows`, async () => {
    const repository = await make();
    const now = Date.now(), at = new Date(now).toISOString();
    const hash = (char: string) => char.repeat(64);
    const live = await repository.create({ id: "appdev:live0001", ownerUserId: owner, app: "nous", deviceName: "Pixel 9", sidSha256: hash("a"), expiresAt: new Date(now + 30 * day).toISOString() });
    expect(live).toMatchObject({ id: "appdev:live0001", app: "nous", revokedAt: null, sidSha256: hash("a") });
    await repository.create({ id: "appdev:old00001", ownerUserId: owner, app: "nous", deviceName: "Old", sidSha256: hash("b"), expiresAt: new Date(now - 31 * day).toISOString() });
    await expect(repository.create({ id: "appdev:dupe0001", ownerUserId: owner, app: "nous", deviceName: "Dupe", sidSha256: hash("a"), expiresAt: new Date(now + day).toISOString() })).rejects.toThrow();
    expect((await repository.live(owner, "nous", at)).map((row) => row.id)).toEqual(["appdev:live0001"]);
    expect(await repository.revoke("user:someone-else", "appdev:live0001", at)).toBeNull();
    expect((await repository.revoke(owner, "appdev:live0001", at))?.revokedAt).toEqual(expect.any(String));
    expect(await repository.revoke(owner, "appdev:live0001", at)).toBeNull();
    expect(await repository.revokeBySid(hash("a"), at)).toBeNull();
    expect((await repository.list(owner)).map((row) => row.id).sort()).toEqual(["appdev:live0001", "appdev:old00001"]);
    // Only the row that ended more than 30 days ago goes.
    expect(await repository.pruneEnded(at)).toBe(1);
    expect((await repository.list(owner)).map((row) => row.id)).toEqual(["appdev:live0001"]);
    await repository.dispose();
  });

  // Nous Pro 1b (migration 0274, ADR-013 §3 and §8, security review P1-5): a paired device is held with read only until the owner allows it,
  // is found by its Noise key, and never counts toward the sign-in cap (which revokes the oldest rows live() returns).
  it(`${name}: a paired device is held, confirmed once, touched, and kept out of the sign-in cap`, async () => {
    const repository = await make();
    const now = Date.now(), at = new Date(now).toISOString();
    const key = (char: string) => char.repeat(43);
    const signIn = await repository.create({ id: "appdev:sign0001", ownerUserId: owner, app: "nous", deviceName: "Pixel", sidSha256: "c".repeat(64), expiresAt: new Date(now + 30 * day).toISOString() });
    expect(signIn).toMatchObject({ noisePublic: null, scopes: null, confirmedAt: null });
    const paired = await repository.createPaired({ id: "appdev:pair0001", ownerUserId: owner, app: "nous", deviceName: "Pixel (paired)", sidSha256: "d".repeat(64),
      expiresAt: new Date(now + 90 * day).toISOString(), noisePublic: key("N"), decidePublicSpki: "S".repeat(122), decideSecurityLevel: "STRONGBOX", requestedScopes: ["read", "act", "decide"] });
    expect(paired).toMatchObject({ scopes: ["read"], requestedScopes: ["read", "act", "decide"], confirmedAt: null, decideSecurityLevel: "STRONGBOX" });
    await expect(repository.createPaired({ id: "appdev:pair0002", ownerUserId: owner, app: "nous", deviceName: "Clone", sidSha256: "e".repeat(64),
      expiresAt: new Date(now + day).toISOString(), noisePublic: key("N"), decidePublicSpki: null, decideSecurityLevel: null, requestedScopes: ["read"] })).rejects.toThrow();
    expect((await repository.live(owner, "nous", at)).map((row) => row.id)).toEqual(["appdev:sign0001"]);
    expect((await repository.livePaired(owner, at)).map((row) => row.id)).toEqual(["appdev:pair0001"]);
    expect((await repository.byNoisePublic(key("N")))?.id).toBe("appdev:pair0001");
    expect(await repository.byNoisePublic(key("X"))).toBeNull();
    expect(await repository.confirm("user:someone-else", "appdev:pair0001", at)).toBeNull();
    expect(await repository.confirm(owner, "appdev:sign0001", at)).toBeNull();
    expect(await repository.confirm(owner, "appdev:pair0001", at)).toMatchObject({ scopes: ["read", "act", "decide"], confirmedAt: expect.any(String) });
    expect(await repository.confirm(owner, "appdev:pair0001", at)).toBeNull();
    const later = new Date(now + day).toISOString(), until = new Date(now + 91 * day).toISOString();
    expect(await repository.touch("appdev:pair0001", later, until)).toMatchObject({ lastSeenAt: later, expiresAt: until });
    expect(await repository.touch("appdev:sign0001", later, until)).toBeNull();
    expect((await repository.revoke(owner, "appdev:pair0001", at))?.revokedAt).toEqual(expect.any(String));
    expect(await repository.touch("appdev:pair0001", later, until)).toBeNull();
    expect(await repository.livePaired(owner, at)).toEqual([]);
    await repository.dispose();
  });

  // C3 and C6 (internal MASVS review, plan clipboard:kTV3y2lwO-99 step 7): every owner's live paired phones at once (the instance keys are the
  // installation's), the decide chain's serials kept, and decide dropped from one phone (Google revoked its chain) while its other scopes stay.
  it(`${name}: lists every owner's paired phones, keeps the decide chain's serials and drops decide`, async () => {
    const repository = await make();
    const now = Date.now(), at = new Date(now).toISOString(), expiresAt = new Date(now + 90 * day).toISOString();
    await repository.createPaired({ id: "appdev:mine0001", ownerUserId: owner, app: "nous", deviceName: "Mine", sidSha256: "f".repeat(64), expiresAt,
      noisePublic: "M".repeat(43), decidePublicSpki: "S".repeat(122), decideSecurityLevel: "TRUSTED_ENVIRONMENT", decideSerials: ["1a", "2b"], requestedScopes: ["read", "act", "decide"] });
    await repository.createPaired({ id: "appdev:them0001", ownerUserId: otherOwner, app: "nous", deviceName: "Theirs", sidSha256: "9".repeat(64), expiresAt,
      noisePublic: "P".repeat(43), decidePublicSpki: null, decideSecurityLevel: null, decideSerials: null, requestedScopes: ["read"] });
    expect(await repository.confirm(owner, "appdev:mine0001", at)).toMatchObject({ scopes: ["read", "act", "decide"], decideSerials: ["1a", "2b"] });
    expect((await repository.livePaired(null, at)).map((row) => row.id)).toEqual(expect.arrayContaining(["appdev:mine0001", "appdev:them0001"]));
    expect((await repository.livePaired(owner, at)).map((row) => row.id)).toEqual(["appdev:mine0001"]);
    expect(await repository.dropDecide("appdev:mine0001")).toMatchObject({ scopes: ["read", "act"], requestedScopes: ["read", "act"], decidePublicSpki: null,
      decideSecurityLevel: null, decideSerials: null, revokedAt: null });
    expect(await repository.dropDecide("appdev:mine0001")).toBeNull();
    expect(await repository.dropDecide("appdev:them0001")).toBeNull();
    await repository.revoke(owner, "appdev:mine0001", at);
    await repository.revoke(otherOwner, "appdev:them0001", at);
    await repository.dispose();
  });

  // Cleo/Oscar 3/11 (plan clipboard:kTV3y2lwO-99): a relay phone revoked or expired keeps its rid for the relay listener until it is pruned,
  // most recently ended first, so its next connect is refused by the instance (4503 at the phone) instead of meeting no listener (4404).
  it(`${name}: lists ended relay phones' rendezvous ids until they are pruned`, async () => {
    const repository = await make();
    const now = Date.now(), at = new Date(now).toISOString(), rid = () => randomBytes(32).toString("base64url");
    const [live, revoked, expired] = [rid(), rid(), rid()];
    const paired = (id: string, expiresAt: number, rendezvousId: string) => repository.createPaired({ id, ownerUserId: owner, app: "nous", deviceName: id,
      sidSha256: randomBytes(32).toString("hex"), expiresAt: new Date(expiresAt).toISOString(), noisePublic: rid(), decidePublicSpki: null, decideSecurityLevel: null,
      requestedScopes: ["read"], rendezvousId });
    await paired("appdev:rlive001", now + 90 * day, live);
    await paired("appdev:rrevk001", now + 90 * day, revoked);
    await paired("appdev:rexpd001", now - 2 * day, expired);
    await repository.revoke(owner, "appdev:rrevk001", new Date(now - day).toISOString());
    const ended = (await repository.endedRendezvousIds(at)).filter((id) => [live, revoked, expired].includes(id));
    expect(ended).toEqual([revoked, expired]);
    await repository.pruneEnded(new Date(now + 28 * day + 12 * 3600_000).toISOString());
    expect((await repository.endedRendezvousIds(at)).filter((id) => [live, revoked, expired].includes(id))).toEqual([revoked]);
    await repository.revoke(owner, "appdev:rlive001", at);
    await repository.pruneEnded(new Date(now + 31 * day).toISOString());
    await repository.dispose();
  });
}

describe("app device sessions", () => {
  contract("in memory", async () => new InMemoryAppDeviceSessionRepository());
  describe.skipIf(!address && !socket)("in PostgreSQL", () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      if (socket) {
        if (!/^\/var\/lib\/spaceapp-user\/agent-workspace\/reports\/[^/]+\/continuation-pg-socket$/.test(socket)) throw Error("Disposable test socket required.");
        pool = new pg.Pool({ host: socket, database: "postgres", user: "postgres", max: 3 });
      } else {
        const target = new URL(address!);
        if (target.hostname !== "127.0.0.1" || !target.port || target.port === "5432") throw Error("Disposable loopback test database required.");
        pool = new pg.Pool({ connectionString: address, max: 3 });
      }
      const client = await pool.connect();
      try {
        await client.query("CREATE TABLE IF NOT EXISTS space_schema_migrations (id text PRIMARY KEY, filename text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
        for (const migration of await loadMigrations()) {
          if (!(await client.query("SELECT id FROM space_schema_migrations WHERE id = $1", [migration.id])).rowCount) await applyMigration(client, migration);
        }
        await client.query("INSERT INTO users (id, email, role) VALUES ($1, $2, 'ADMIN'), ($3, $4, 'USER') ON CONFLICT (id) DO NOTHING",
          [owner, "devices-test@example.test", otherOwner, "devices-test-other@example.test"]);
        await client.query("DELETE FROM app_device_sessions WHERE owner_user_id = ANY($1)", [[owner, otherOwner]]);
      } finally { client.release(); }
    });
    afterAll(async () => { await pool?.end(); });
    contract("postgres", async () => Object.assign(new PostgresAppDeviceSessionRepository(pool), { dispose: async () => undefined }));
  });
});
