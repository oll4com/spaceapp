import { EventEmitter } from "node:events";
import { afterAll, describe, expect, it, vi } from "vitest";
import { rollbackKeepingError } from "../src/rollback.js";
import { PostgresGoogleAccountsRepository } from "../src/google-accounts-repository.js";
import { PostgresGatewayRepository } from "../src/gateway-repository.js";
import { PostgresVaultRepository } from "../src/vault-repository.js";
import { createSpacePgPool, PostgresSpaceStore } from "../src/space-store.js";

// The real pool's onConnect, called on a fake connection the way pg-pool calls it on every connection it opens.
const pool = createSpacePgPool("postgres://space@db.invalid/rollback-test", { socketPath: "/nonexistent" });
const poolListener = (client: EventEmitter) => (pool.options as { onConnect: (client: EventEmitter) => void }).onConnect(client);
afterAll(() => pool.end());
const shutdownError = () => Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
const notQueryable = () => new Error("Client has encountered a connection error and is not queryable");

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
    const step = new Error("step");
    await expect(rollbackKeepingError({ query: vi.fn(async () => ({ rows: [] })) } as never, step)).resolves.toEqual({ failed: false, error: step });
    await expect(rollbackKeepingError({ query: vi.fn(async () => { throw new Error("lost"); }) } as never, step)).resolves.toEqual({ failed: true, error: step });
  });

  it("hands back the error the connection reported when the step only got pg's codeless \"not queryable\" (CORE-002, every caller)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const shutdown = shutdownError();
    const client = Object.assign(new EventEmitter(), { query: vi.fn(async () => { throw notQueryable(); }) });
    poolListener(client);
    client.emit("error", shutdown);
    client.emit("error", new Error("Connection terminated unexpectedly")); // the first one is the cause
    const rollback = await rollbackKeepingError(client as never, notQueryable());
    expect(rollback).toEqual({ failed: true, error: shutdown });
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    await expect(rollbackKeepingError(client as never, deadlock)).resolves.toEqual({ failed: true, error: deadlock });
    vi.mocked(console.error).mockRestore();
  });

  it("keeps the step's error and discards the client at a repository transaction", async () => {
    const stepError = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
    const { pool, release } = lostConnectionPool(stepError);
    const repository = new PostgresGoogleAccountsRepository(pool as never);
    await expect(repository.link("user:owner", { sub: "sub", email: "owner@example.test" } as never)).rejects.toBe(stepError);
    expect(release).toHaveBeenCalledWith(true);
  });

  it("discards the client at the Vault and Space Gateway transactions too (they swallowed a failed ROLLBACK and reused it)", async () => {
    for (const run of [
      (pool: never) => new PostgresVaultRepository(pool).bumpEpoch("user:owner", "lock"),
      (pool: never) => new PostgresGatewayRepository(pool).replaceAnthropicUsage("2026-11-01", [])
    ]) {
      const stepError = shutdownError();
      const { pool, release } = lostConnectionPool(stepError);
      await expect(run(pool as never)).rejects.toBe(stepError);
      expect(release).toHaveBeenCalledWith(true);
    }
  });

  it("keeps the 57P01 a connection lost between statements reported, not pg's codeless \"not queryable\" (CORE-002)", async () => {
    // c5 public suite, 2/11: under load the graceful restart's 57P01 reached the client after the INSERT completed,
    // as an 'error' event (no active query), so the next statement failed "not queryable" and hid it from callers.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const shutdown = shutdownError();
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN") return { rows: [], rowCount: 0 };
        if (!client.lost) { client.lost = true; client.emit("error", shutdown); return { rows: [], rowCount: 1 }; }
        throw notQueryable();
      }),
      lost: false,
      release: vi.fn()
    });
    poolListener(client);
    const store = new PostgresSpaceStore({ connect: vi.fn(async () => client), query: client.query } as never);
    await expect(store.deleteRoom("room:gone")).rejects.toBe(shutdown);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.listenerCount("error")).toBe(1);
    vi.mocked(console.error).mockRestore();
  });
});
