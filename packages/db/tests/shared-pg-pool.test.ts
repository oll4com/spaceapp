import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDedicatedSpacePgPool, createSpacePgPool, SHARED_SPACE_PG_POOL_MAX } from "../src/space-store.js";

// Pools connect lazily, so nothing here reaches a database.
const url = "postgres://space@127.0.0.1:1/shared_pool_test";
const options = { socketPath: "/nonexistent/socket" };

const poolEnv = ["SPACE_DATABASE_SHARED_POOL_MAX", "SPACE_DATABASE_POOL_MAX", "SPACE_DATABASE_POOL_IDLE_TIMEOUT_MS"] as const;
const savedEnv = Object.fromEntries(poolEnv.map((name) => [name, process.env[name]]));

describe("shared Space pg pool", () => {
  beforeEach(() => { for (const name of poolEnv) delete process.env[name]; });
  afterEach(() => {
    for (const name of poolEnv) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  it("gives every caller of one connection string the same pool, capped and ended by the last handle", async () => {
    const a = createSpacePgPool(url, { ...options, max: 2 });
    const b = createSpacePgPool(url, { ...options, max: 3 });
    expect(a.options).toBe(b.options);
    expect(a.options.max).toBe(5);
    expect(a.options.idleTimeoutMillis).toBe(10_000);

    const many = Array.from({ length: 10 }, () => createSpacePgPool(url, { ...options, max: 10 }));
    expect(a.options.max).toBe(SHARED_SPACE_PG_POOL_MAX);
    await Promise.all(many.map((pool) => pool.end()));
    expect(a.options.max).toBe(5);

    await a.end();
    await a.end();
    expect(b.ended).toBe(false);
    expect(b.options.max).toBe(3);
    await b.end();
    expect(b.ended).toBe(true);

    const fresh = createSpacePgPool(url, options);
    expect(fresh.ended).toBe(false);
    expect(fresh.options).not.toBe(b.options);
    await fresh.end();
  });

  it("takes its cap from SPACE_DATABASE_SHARED_POOL_MAX and its idle timeout from SPACE_DATABASE_POOL_IDLE_TIMEOUT_MS", async () => {
    process.env.SPACE_DATABASE_SHARED_POOL_MAX = "6";
    process.env.SPACE_DATABASE_POOL_IDLE_TIMEOUT_MS = "15000";
    const a = createSpacePgPool(url, { ...options, max: 2 });
    expect(a.options.idleTimeoutMillis).toBe(15_000);
    expect(a.options.max).toBe(2);
    const b = createSpacePgPool(url, { ...options, max: 10 });
    expect(a.options.max).toBe(6);
    await b.end();
    expect(a.options.max).toBe(2);
    await a.end();

    process.env.SPACE_DATABASE_SHARED_POOL_MAX = "not-a-number";
    const invalid = createSpacePgPool(url, { ...options, max: 30 });
    expect(invalid.options.max).toBe(SHARED_SPACE_PG_POOL_MAX);
    await invalid.end();
  });

  it("ignores SPACE_DATABASE_POOL_MAX, which sized the old store pool, not the shared one", async () => {
    process.env.SPACE_DATABASE_POOL_MAX = "6";
    const pool = createSpacePgPool(url, { ...options, max: 30 });
    expect(pool.options.max).toBe(SHARED_SPACE_PG_POOL_MAX);
    expect(SHARED_SPACE_PG_POOL_MAX).toBe(20);
    expect(pool.options.fallback_application_name).toMatch(/^space:/);
    await pool.end();
  });

  it("keeps other connection strings and dedicated pools apart", async () => {
    const shared = createSpacePgPool(url, options);
    const other = createSpacePgPool(`${url}_other`, options);
    const dedicated = createDedicatedSpacePgPool(url, { ...options, max: 4 });
    expect(other.options).not.toBe(shared.options);
    expect(dedicated.options).not.toBe(shared.options);
    expect(dedicated.options.max).toBe(4);
    await Promise.all([shared.end(), other.end(), dedicated.end()]);
  });
});
