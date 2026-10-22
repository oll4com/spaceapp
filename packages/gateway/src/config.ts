import { loadLanAccess, type LanAccess } from "./lan-access.js";

/** Gateway-only settings, read from /opt/spaceapp/.env by the space-gateway unit. */
export interface GatewayConfig {
  host: string;
  port: number;
  /** A second listener for other internal machines, or null (loopback only). */
  lan: LanAccess | null;
  /** Why the LAN settings were not usable; LAN access stays off and loopback keeps working. */
  lanError: string | null;
  databaseUrl: string | null;
  encryptionKeyFile: string;
  drainTimeoutMs: number;
  /** How long a worker replaced by a newer one may finish its open streams (it no longer accepts new ones). */
  reloadDrainTimeoutMs: number;
  retentionIntervalMs: number;
  usagePollIntervalMs: number;
  compressionWorkers: number;
  /** Shared with the Space API; required for the gateway's admin endpoints. */
  internalToken: string | null;
}

export const defaultGatewayPort = 4920;
export const defaultGatewayEncryptionKeyFile = "/opt/spaceapp/secrets/space-gateway-encryption.key";

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Gateway setting out of range: ${raw}`);
  return value;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const host = env.SPACE_GATEWAY_HOST?.trim() || "127.0.0.1";
  let lan: LanAccess | null = null;
  let lanError: string | null = null;
  try {
    lan = loadLanAccess(env);
  } catch (error) {
    lanError = error instanceof Error ? error.message : "Invalid LAN settings.";
  }
  if (!/^[0-9a-fA-F:.]+$/.test(host)) throw new Error("SPACE_GATEWAY_HOST must be an IP address.");
  return {
    host,
    port: boundedInt(env.SPACE_GATEWAY_PORT, defaultGatewayPort, 1024, 65535),
    lan,
    lanError,
    databaseUrl: env.SPACE_DATABASE_URL?.trim() || null,
    encryptionKeyFile: env.SPACE_GATEWAY_ENCRYPTION_KEY_FILE?.trim() || defaultGatewayEncryptionKeyFile,
    drainTimeoutMs: boundedInt(env.SPACE_GATEWAY_DRAIN_TIMEOUT_MS, 30_000, 0, 600_000),
    reloadDrainTimeoutMs: boundedInt(env.SPACE_GATEWAY_RELOAD_DRAIN_TIMEOUT_MS, 900_000, 0, 3_600_000),
    retentionIntervalMs: boundedInt(env.SPACE_GATEWAY_RETENTION_INTERVAL_MS, 3_600_000, 60_000, 86_400_000),
    usagePollIntervalMs: boundedInt(env.SPACE_GATEWAY_USAGE_POLL_INTERVAL_MS, 300_000, 30_000, 3_600_000),
    compressionWorkers: boundedInt(env.SPACE_GATEWAY_COMPRESSION_WORKERS, 2, 1, 16),
    // The admin credential has its own variable (security addendum step 9); unset, it is the API's internal token.
    internalToken: env.SPACE_GATEWAY_ADMIN_TOKEN?.trim() || env.SPACE_INTERNAL_API_TOKEN?.trim() || null
  };
}
