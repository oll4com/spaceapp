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
const owner = "user:devices-test";
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
}

describe("app device sessions", () => {
  contract("in memory", async () => new InMemoryAppDeviceSessionRepository());
  describe.skipIf(!address && !socket)("in PostgreSQL", () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      if (socket) {
        if (!/^\/home\/spaceapp-user\/agent-workspace\/reports\/[^/]+\/continuation-pg-socket$/.test(socket)) throw Error("Disposable test socket required.");
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
        await client.query("INSERT INTO users (id, email, role) VALUES ($1, $2, 'ADMIN') ON CONFLICT (id) DO NOTHING", [owner, "devices-test@example.test"]);
        await client.query("DELETE FROM app_device_sessions WHERE owner_user_id = $1", [owner]);
      } finally { client.release(); }
    });
    afterAll(async () => { await pool?.end(); });
    contract("postgres", async () => Object.assign(new PostgresAppDeviceSessionRepository(pool), { dispose: async () => undefined }));
  });
});
