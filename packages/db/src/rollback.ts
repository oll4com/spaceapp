import type { PgClientLike } from "./space-store.js";

/**
 * Rolls back after a failed transaction step without hiding that step's error: when the connection is lost
 * (for example a PostgreSQL restart) ROLLBACK fails too, and the server has already rolled back with the
 * session. Returns true in that case, so the caller releases the client as broken instead of reusing it.
 * CORE-011 fixed this in withTransaction; the 1.1.5 internal review found the plain pattern at other sites.
 */
export async function rollbackKeepingError(client: PgClientLike): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return false;
  } catch {
    return true;
  }
}
