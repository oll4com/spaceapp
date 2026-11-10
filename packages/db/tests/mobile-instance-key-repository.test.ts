import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations } from "../src/migrations.js";
import { applyMigration } from "../src/migration-runner.js";
import { InMemoryMobileInstanceKeyRepository, PostgresMobileInstanceKeyRepository, type MobileInstanceKeyRepository } from "../src/mobile-instance-key-repository.js";

// The mobile channel's instance keys (migration 0274, ADR-013 §2, security review P2-4): one ACTIVE pair; a routine rotation keeps the old
// pair answering IK for 30 days, a compromise retires every pair at once; nothing is deleted (class A). PostgreSQL runs only against a
// disposable, explicitly provided loopback database (same gate as the device session suite).
const address = process.env.SPACE_CONTINUATION_TEST_DATABASE_URL;
const socket = process.env.SPACE_CONTINUATION_TEST_PG_SOCKET;
const day = 86400_000;
const keys = (n: number) => ({ id: `mobkey:pair000${n}`, noisePublic: String(n).repeat(43), identityPublic: String(n + 1).repeat(43), sealedPrivate: "s".repeat(120) });

function contract(name: string, make: () => Promise<MobileInstanceKeyRepository>) {
  it(`${name}: one active pair, routine and compromise rotations`, async () => {
    const repository = await make();
    const now = Date.now(), at = new Date(now).toISOString();
    expect(await repository.active()).toBeNull();
    await expect(repository.rotate({ ...keys(1), rotationStatement: null, compromised: false, nowIso: at })).rejects.toThrow("no active keys");
    expect(await repository.create(keys(1))).toMatchObject({ id: "mobkey:pair0001", status: "ACTIVE", rotationStatement: null });
    await expect(repository.create(keys(2))).rejects.toThrow();

    const second = await repository.rotate({ ...keys(2), rotationStatement: "R1", compromised: false, nowIso: at });
    expect(second).toMatchObject({ status: "ACTIVE", rotationStatement: "R1" });
    expect((await repository.active())?.id).toBe("mobkey:pair0002");
    const answering = await repository.answering(at);
    expect(answering.map((row) => [row.id, row.status])).toEqual([["mobkey:pair0002", "ACTIVE"], ["mobkey:pair0001", "RETIRING"]]);
    expect(Date.parse(answering[1]!.retiringUntil!)).toBe(now + 30 * day);
    // 30 days on, the retiring pair no longer answers.
    expect((await repository.answering(new Date(now + 31 * day).toISOString())).map((row) => row.id)).toEqual(["mobkey:pair0002"]);

    const third = await repository.rotate({ ...keys(3), rotationStatement: "R2", compromised: true, nowIso: at });
    expect(third).toMatchObject({ status: "ACTIVE", rotationStatement: null });
    expect((await repository.answering(at)).map((row) => row.id)).toEqual(["mobkey:pair0003"]);
    await repository.dispose();
  });
}

describe("mobile instance keys", () => {
  contract("in memory", async () => new InMemoryMobileInstanceKeyRepository());
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
        // A disposable database: this suite owns the table's rows.
        await client.query("DELETE FROM mobile_instance_keys");
      } finally { client.release(); }
    });
    afterAll(async () => { await pool?.end(); });
    contract("postgres", async () => Object.assign(new PostgresMobileInstanceKeyRepository(pool), { dispose: async () => undefined }));
  });
});
