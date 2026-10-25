import type { DatabaseConnection } from "@space/contracts";
import type { DatabaseAdapter } from "./types.js";
import { PostgresAdapter } from "./postgres-adapter.js";
import { MySqlAdapter } from "./mysql-adapter.js";
import { SqliteAdapter } from "./sqlite-adapter.js";

interface CachedAdapter {
  adapter: DatabaseAdapter;
  lastUsed: number;
}

const adapterCache = new Map<string, CachedAdapter>();
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Evict idle adapters every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of adapterCache.entries()) {
    if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
      void entry.adapter.close().catch(() => {});
      adapterCache.delete(id);
    }
  }
}, 60 * 1000).unref();

export function getAdapterForConnection(
  connection: DatabaseConnection,
  decryptedPassword?: string,
  internalConnectionString?: string
): DatabaseAdapter {
  const cached = adapterCache.get(connection.id);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.adapter;
  }

  let adapter: DatabaseAdapter;

  switch (connection.engine) {
    case "POSTGRES":
      adapter = new PostgresAdapter({
        host: connection.host,
        port: connection.port,
        database: connection.database,
        username: connection.username,
        password: decryptedPassword,
        ssl: connection.ssl,
        isReadOnly: connection.isReadOnly,
        connectionString: connection.isInternal ? internalConnectionString : undefined
      });
      break;

    case "MYSQL":
      adapter = new MySqlAdapter({
        host: connection.host,
        port: connection.port,
        database: connection.database,
        username: connection.username,
        password: decryptedPassword,
        ssl: connection.ssl,
        isReadOnly: connection.isReadOnly
      });
      break;

    case "SQLITE":
      adapter = new SqliteAdapter({
        filename: connection.filename,
        isReadOnly: connection.isReadOnly
      });
      break;

    default:
      throw new Error(`Unsupported database engine: ${String(connection.engine)}`);
  }

  adapterCache.set(connection.id, {
    adapter,
    lastUsed: Date.now()
  });

  return adapter;
}

export async function closeAdapterForConnection(connectionId: string): Promise<void> {
  const cached = adapterCache.get(connectionId);
  if (cached) {
    adapterCache.delete(connectionId);
    await cached.adapter.close().catch(() => {});
  }
}
