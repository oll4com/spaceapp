import { expect, it } from "vitest";
import { disposablePostgresUnavailableReason, startDisposablePostgres } from "./support/disposable-postgres.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSignaturesRepository } from "../src/signatures-repository.js";

// Migration 0302 (nous_msg:781819c5ba0440fbbee8682c): the one stored signature becomes the first saved one and the default, nothing is lost;
// then many per owner, one default, an explicit delete passing the default on.
it.skipIf(disposablePostgresUnavailableReason() !== null)("moves the stored signature into the library as the default and keeps many with one default", async () => {
  const migrations = await loadMigrations();
  const sql = (id: string) => migrations.find((item) => item.id === id)!.sql;
  const server = await startDisposablePostgres("saved-signatures");
  const pool = server.pool("postgres", 2);
  try {
    await pool.query(sql("0297_signatures"));
    const drawn = Buffer.from("89504e47-operator", "utf8");
    await pool.query("INSERT INTO owner_signatures VALUES ('user:operator', $1, 300, 90, '+66 1', '2026-11-04T12:00:00Z'), ('user:other', NULL, NULL, NULL, '+30 2', '2026-11-04T12:00:00Z')", [drawn]);
    await pool.query(sql("0302_saved_signatures"));
    await pool.query(sql("0302_saved_signatures"));
    const { rows: moved } = await pool.query("SELECT owner_user_id, label, png, width, height, is_default, created_at FROM saved_signatures");
    expect(moved).toEqual([{ owner_user_id: "user:operator", label: "Signature", png: drawn, width: 300, height: 90, is_default: true, created_at: new Date("2026-11-04T12:00:00Z") }]);
    expect((await pool.query("SELECT owner_user_id, png, phone FROM owner_signatures ORDER BY owner_user_id")).rows)
      .toEqual([{ owner_user_id: "user:operator", png: drawn, phone: "+66 1" }, { owner_user_id: "user:other", png: null, phone: "+30 2" }]);

    const repository = new PostgresSignaturesRepository(pool);
    const [first] = await repository.listSignatures("user:operator");
    const second = await repository.addSignature("user:operator", Buffer.from("second"), { width: 10, height: 4 }, { label: "Initials" }, "2026-11-05T00:00:00Z");
    const other = await repository.addSignature("user:other", Buffer.from("other"), { width: 10, height: 4 }, { label: "Theirs" });
    expect([second.isDefault, other.isDefault]).toEqual([false, true]);
    expect((await repository.getSignature("user:operator"))?.png).toEqual(drawn);
    expect((await repository.updateSignature("user:operator", second.id, { isDefault: true }))?.isDefault).toBe(true);
    expect((await repository.getSignature("user:operator"))?.png).toEqual(Buffer.from("second"));
    expect(await repository.getSignature("user:other", second.id)).toBeNull();
    expect(await repository.deleteSignature("user:other", second.id)).toBeNull();
    expect((await repository.deleteSignature("user:operator", second.id))?.id).toBe(second.id);
    expect(await repository.listSignatures("user:operator")).toMatchObject([{ id: first!.id, isDefault: true }]);
    expect(await repository.getPhone("user:operator")).toBe("+66 1");
  } finally {
    await server.stop();
  }
}, 120_000);
