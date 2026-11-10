import type { PgClientLike } from "./space-store.js";

// pg reports a connection lost between statements (57P01 while idle in a transaction) only as the client's
// 'error' event; the next statement then fails "not queryable" with no code. The pool's onConnect keeps it here.
const connectionErrors = new WeakMap<object, unknown>();

/** Called by the pool's listener on every connection it opens: remembers the first error that connection reported. */
export function keepConnectionError(client: object, error: unknown): void {
  if (!connectionErrors.has(client)) connectionErrors.set(client, error);
}

/**
 * Rolls back after a failed transaction step without hiding that step's error: when the connection is lost
 * (for example a PostgreSQL restart) ROLLBACK fails too, and the server has already rolled back with the
 * session. `failed` is then true, so the caller releases the client as broken instead of reusing it.
 * `error` is what the caller throws: the step's own error, or the connection's (57P01) when the step only
 * got pg's codeless "not queryable" (CORE-002). CORE-011 found the pattern; the 1.1.5 review, the other sites.
 */
export async function rollbackKeepingError(client: PgClientLike, error: unknown): Promise<{ failed: boolean; error: unknown }> {
  try {
    await client.query("ROLLBACK");
    return { failed: false, error };
  } catch {
    const codeless = (error as { code?: unknown } | null)?.code === undefined;
    return { failed: true, error: codeless && connectionErrors.has(client) ? connectionErrors.get(client) : error };
  }
}
