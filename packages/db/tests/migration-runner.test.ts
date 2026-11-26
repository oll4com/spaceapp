import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { applyMigration, applyPendingMigrations } from "../src/migration-runner.js";

const migration = {
  id: "0029_independent_cli_host",
  filename: "0029_independent_cli_host.sql",
  sql: "SELECT migrate()"
};

describe("applyMigration", () => {
  it.each([0, -1, 1.5, Infinity, NaN])("rejects an invalid retry budget %s instead of silently skipping a migration", async (maxAttempts) => {
    let queries = 0;
    const client = { query: async () => { queries++; return { rowCount: 1 }; } } as unknown as Pick<pg.Client, "query">;
    await expect(applyMigration(client, migration, { maxAttempts })).rejects.toThrow(/maxAttempts/);
    expect(queries).toBe(0);
  });

  it("does not repeat a transaction after an ambiguous COMMIT failure", async () => {
    const calls: string[] = [];
    const failure = Object.assign(new Error("connection lost after COMMIT"), { code: "ECONNRESET" });
    const client = { query: async (sql: string) => {
      calls.push(sql);
      if (sql === "COMMIT") throw failure;
      return { rowCount: 1 };
    } } as unknown as Pick<pg.Client, "query">;
    await expect(applyMigration(client, migration)).rejects.toBe(failure);
    expect(calls.filter((sql) => sql === migration.sql)).toHaveLength(1);
  });
  it("retries the complete transaction after a PostgreSQL deadlock", async () => {
    const calls: string[] = [];
    let migrationAttempts = 0;
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql === migration.sql && migrationAttempts++ === 0) {
          throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        }
        return { rowCount: 1 };
      })
    } as unknown as Pick<pg.Client, "query">;
    const sleep = vi.fn(async () => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await applyMigration(client, migration, { sleep });

    expect(calls).toEqual([
      "BEGIN",
      migration.sql,
      "ROLLBACK",
      "BEGIN",
      migration.sql,
      "INSERT INTO space_schema_migrations (id, filename) VALUES ($1, $2)",
      "COMMIT"
    ]);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("does not retry a non-transaction database error", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "42501" });
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === migration.sql) throw error;
        return { rowCount: 1 };
      })
    } as unknown as Pick<pg.Client, "query">;
    const sleep = vi.fn(async () => undefined);

    await expect(applyMigration(client, migration, { sleep })).rejects.toBe(error);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("statement-per-transaction migrations", () => {
  const perStatement = { id: "0379_split", filename: "0379_split.sql",
    sql: "-- header\n-- space:migration statement-per-transaction\nSET LOCAL lock_timeout = '10s';\nUPDATE a SET x = 1;\nALTER TABLE a ALTER COLUMN x SET DEFAULT 1;\n" };
  const recorder = (fail?: (sql: string) => unknown) => {
    const calls: string[] = [];
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql.startsWith("INSERT INTO space_schema_migrations") ? "INSERT history" : sql);
      const error = fail?.(sql); if (error) throw error;
      return { rowCount: 1 };
    }) } as unknown as Pick<pg.Client, "query">;
    return { calls, client };
  };

  it("commits each statement on its own with the SET LOCAL prelude, recording history with the last", async () => {
    const { calls, client } = recorder();
    await applyMigration(client, perStatement);
    expect(calls).toEqual([
      "BEGIN", "SET LOCAL lock_timeout = '10s';\nUPDATE a SET x = 1;", "COMMIT",
      "BEGIN", "SET LOCAL lock_timeout = '10s';\nALTER TABLE a ALTER COLUMN x SET DEFAULT 1;", "INSERT history", "COMMIT"
    ]);
  });

  it("retries only the deadlocked statement, not the ones already committed", async () => {
    let failed = false;
    const { calls, client } = recorder((sql) => sql.includes("ALTER TABLE") && !failed && (failed = true)
      ? Object.assign(new Error("deadlock detected"), { code: "40P01" }) : undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await applyMigration(client, perStatement, { sleep: async () => undefined });
    expect(calls.filter((sql) => sql.includes("UPDATE a"))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes("ALTER TABLE"))).toHaveLength(2);
    expect(calls.filter((sql) => sql === "INSERT history")).toHaveLength(1);
  });

  it("refuses a multi-line statement before running anything", async () => {
    const { calls, client } = recorder();
    await expect(applyMigration(client, { ...perStatement, sql: perStatement.sql + "UPDATE b\nSET y = 1;\n" })).rejects.toThrow(/one complete statement per line/);
    expect(calls).toEqual([]);
  });
});

describe("applyPendingMigrations", () => {
  it("applies only unrecorded migrations, in the given order, and leaves recorded history alone", async () => {
    const recorded = new Set(["0001_first", "0094_removed_file"]);
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
        if (sql.startsWith("SELECT id FROM space_schema_migrations")) return { rowCount: recorded.has(String(values?.[0])) ? 1 : 0 };
        if (sql.startsWith("INSERT INTO space_schema_migrations")) recorded.add(String(values?.[0]));
        return { rowCount: 1 };
      })
    } as unknown as Pick<pg.Client, "query">;
    const migrations = ["0001_first", "0002_second", "0003_third"].map((id) => ({ id, filename: `${id}.sql`, sql: `SELECT '${id}'` }));
    const onApplied = vi.fn();

    await expect(applyPendingMigrations(client, migrations, { onApplied })).resolves.toEqual({ applied: ["0002_second", "0003_third"] });
    expect(calls[0]).toBe("CREATE TABLE IF");
    expect(calls).not.toContain("DELETE FROM space_schema_migrations");
    expect(onApplied.mock.calls.map(([migration]) => migration.id)).toEqual(["0002_second", "0003_third"]);
    expect([...recorded].sort()).toEqual(["0001_first", "0002_second", "0003_third", "0094_removed_file"]);
    await expect(applyPendingMigrations(client, migrations, { onApplied })).resolves.toEqual({ applied: [] });
  });
});
