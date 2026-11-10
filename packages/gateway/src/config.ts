import { loadLanAccess, type LanAccess } from "./lan-access.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

/** Gateway-only settings, read from the install root's .env by the space-gateway unit. */
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
  /** NGW_MODE=nous: the Nous Gateway profile (tenant keys, shared ledger); null keeps the Space Gateway as it is. */
  ngw: { region: string; kms: { keyName: string; wrappedFile: string; credentialConfigFile: string } | null;
    /** The mTLS admin listener (nous/admin.ts); null leaves administration closed. */
    admin: { host: string; port: number; certFile: string; keyFile: string; caFile: string } | null } | null;
}

export const defaultGatewayPort = 4920;
export const defaultGatewayEncryptionKeyFile = `${SPACE_INSTALL_ROOT}/secrets/space-gateway-encryption.key`;

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Gateway setting out of range: ${raw}`);
  return value;
}

function loadNgwProfile(env: NodeJS.ProcessEnv): GatewayConfig["ngw"] {
  const mode = env.NGW_MODE?.trim();
  if (!mode) return null;
  if (mode !== "nous") throw new Error("NGW_MODE must be 'nous' or unset.");
  const region = env.NGW_REGION?.trim() ?? "";
  if (!/^[a-z0-9-]{2,16}$/.test(region)) throw new Error("NGW_REGION must name this installation's region (e.g. eu1).");
  // The KMS key provider replaces the key file once its key is named (runbook I-2.1, I-2.5); all three settings or none.
  const keyName = env.NGW_KMS_KEY_NAME?.trim(), wrappedFile = env.NGW_CREDENTIAL_KEY_WRAPPED_FILE?.trim(), credentialConfigFile = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (keyName && (!wrappedFile || !credentialConfigFile)) throw new Error("NGW_KMS_KEY_NAME needs NGW_CREDENTIAL_KEY_WRAPPED_FILE and GOOGLE_APPLICATION_CREDENTIALS.");
  const kms = keyName ? { keyName, wrappedFile: wrappedFile!, credentialConfigFile: credentialConfigFile! } : null;
  const listen = env.NGW_ADMIN_LISTEN?.trim();
  if (!listen) return { region, kms, admin: null };
  const match = /^([0-9.]+|\[[0-9a-fA-F:]+\]):(\d+)$/.exec(listen);
  const certFile = env.NGW_ADMIN_TLS_CERT?.trim(), keyFile = env.NGW_ADMIN_TLS_KEY?.trim(), caFile = env.NGW_ADMIN_CLIENT_CA?.trim();
  if (!match || !certFile || !keyFile || !caFile) throw new Error("NGW_ADMIN_LISTEN (address:port) needs NGW_ADMIN_TLS_CERT, NGW_ADMIN_TLS_KEY and NGW_ADMIN_CLIENT_CA.");
  return { region, kms, admin: { host: match[1]!.replace(/^\[|\]$/g, ""), port: boundedInt(match[2], 0, 1024, 65535), certFile, keyFile, caFile } };
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
  const ngw = loadNgwProfile(env);
  // K5-listener: NGW_MODE=nous answers only its tenant surface, so it listens on SPACE_GATEWAY_HOST (the wg-int address) itself.
  if (ngw && (lan || lanError)) throw new Error("NGW_MODE=nous listens on SPACE_GATEWAY_HOST (its wg-int address); unset the LAN listener settings.");
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
    internalToken: env.SPACE_GATEWAY_ADMIN_TOKEN?.trim() || env.SPACE_INTERNAL_API_TOKEN?.trim() || null,
    ngw
  };
}
