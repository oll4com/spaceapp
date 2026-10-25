import { describe, expect, it } from "vitest";
import { loadMigrations, PostgresSpaceStore, type PgClientLike, type PgPoolLike } from "../src/index.js";

class PublicWaitlistPool implements PgPoolLike, PgClientLike {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];

  constructor(private readonly outcome: "CREATED" | "DUPLICATE") {}

  async connect(): Promise<PgClientLike> {
    return this;
  }

  release(): void {}

  async query<T = unknown>(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: [{ outcome: this.outcome } as T], rowCount: 1 };
  }
}

describe("Postgres public waitlist", () => {
  it("defines a PII-minimal durable waitlist table in migration 0048", async () => {
    const migration = (await loadMigrations()).find((item) => item.id === "0048_public_waitlist");

    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS public_waitlist_signups");
    expect(migration?.sql).toContain("email text PRIMARY KEY");
    expect(migration?.sql).toContain("consented_at timestamptz NOT NULL");
    expect(migration?.sql).toContain("source text NOT NULL");
    expect(migration?.sql).toContain("created_at timestamptz NOT NULL");
    expect(migration?.sql).not.toContain("normalized_email text");
    expect(migration?.sql).not.toContain("updated_at timestamptz");
    expect(migration?.sql).not.toMatch(/\b(ip|user_agent|useragent)\b/i);
  });

  it("normalizes the unique key without interpolating contact data and reports CREATED", async () => {
    const pool = new PublicWaitlistPool("CREATED");
    const store = new PostgresSpaceStore(pool);

    const outcome = await store.upsertPublicWaitlistSignup({
      email: "  Person@Example.COM  ",
      source: "HOMEPAGE"
    });

    expect(outcome).toBe("CREATED");
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]?.sql).toContain("INSERT INTO public_waitlist_signups");
    expect(pool.calls[0]?.sql).toContain("ON CONFLICT (email) DO NOTHING");
    expect(pool.calls[0]?.sql).not.toContain("Person@Example.COM");
    expect(pool.calls[0]?.values).toEqual(["person@example.com", "HOMEPAGE"]);
  });

  it("returns DUPLICATE for an idempotent conflict", async () => {
    const store = new PostgresSpaceStore(new PublicWaitlistPool("DUPLICATE"));

    await expect(
      store.upsertPublicWaitlistSignup({ email: "person@example.com", source: "HOMEPAGE" })
    ).resolves.toBe("DUPLICATE");
  });
});
