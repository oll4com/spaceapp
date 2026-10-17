import { describe, expect, it, vi } from "vitest";
import { rollbackKeepingError } from "../src/rollback.js";
import { PostgresGoogleAccountsRepository } from "../src/google-accounts-repository.js";

// CORE-011 at the other transaction sites (1.1.5 internal review, 2026-10-16): when the connection is lost,
// ROLLBACK fails too. The step's own error must reach the caller and the broken client must not be reused.
function lostConnectionPool(stepError: Error) {
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql === "BEGIN") return { rows: [], rowCount: 0 };
      if (sql === "ROLLBACK") throw new Error("Connection terminated unexpectedly");
      throw stepError;
    }),
    release
  };
  return { pool: { connect: vi.fn(async () => client), query: client.query }, release };
}

describe("rollbackKeepingError", () => {
  it("reports a failed ROLLBACK instead of throwing it", async () => {
    await expect(rollbackKeepingError({ query: vi.fn(async () => ({ rows: [] })) } as never)).resolves.toBe(false);
    await expect(rollbackKeepingError({ query: vi.fn(async () => { throw new Error("lost"); }) } as never)).resolves.toBe(true);
  });

  it("keeps the step's error and discards the client at a repository transaction", async () => {
    const stepError = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
    const { pool, release } = lostConnectionPool(stepError);
    const repository = new PostgresGoogleAccountsRepository(pool as never);
    await expect(repository.link("user:owner", { sub: "sub", email: "owner@example.test" } as never)).rejects.toBe(stepError);
    expect(release).toHaveBeenCalledWith(true);
  });
});
