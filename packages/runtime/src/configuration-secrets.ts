import { createCipheriv, createDecipheriv, randomBytes, scrypt, type ScryptOptions } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EncryptedConfigSecrets, ImportConfigResult, SpaceConfigBundle } from "@space/contracts";

// Allowlist: only third-party provider keys travel; instance keys (gateway encryption/internal
// tokens, sessions, harness gateway keys) are bound to the source host and never leave it.
const portableApiKeyName = /^(claude|anthropic|codex|openai|gemini|google|deepseek|openrouter|qwen|kimi|grok|xai|opencode|autohand|elevenlabs|vercel|jev)([-_][a-z0-9_-]+)?$/;
export function isPortableApiKeyName(name: string): boolean {
  return portableApiKeyName.test(name) && !/(gateway|session|internal)/.test(name);
}

export class ConfigSecretsError extends Error {
  readonly code = "WRONG_PASSPHRASE_OR_TAMPERED";
  constructor() {
    super("Wrong passphrase, or the backup file was changed. Nothing was imported.");
  }
}

/** A CLI login as captured on export: auth-file basenames mapped to base64 contents. */
export interface CliAuthCapture {
  files: Record<string, string>;
  capturedAt: string;
  sourcePlatform: string;
}

export interface ConfigSecretsPayload {
  apiKeys?: Record<string, string>;
  cliAuth?: Record<string, CliAuthCapture>;
}

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: ScryptOptions) => Promise<Buffer>;
const kdfParams = { N: 131072, r: 8, p: 1 } as const;
const kdfOptions = { ...kdfParams, maxmem: 256 * 1024 * 1024 };
const configSecretsAad = (version: string) => `spaceapp-configuration-bundle/${version}`;

export async function encryptConfigSecrets(payload: ConfigSecretsPayload, passphrase: string, version: string): Promise<EncryptedConfigSecrets> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const aad = configSecretsAad(version);
  const key = await scryptAsync(passphrase, salt, 32, kdfOptions);
  const plain = Buffer.from(JSON.stringify(payload), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    return {
      alg: "AES-256-GCM",
      kdf: { name: "scrypt", ...kdfParams, salt: salt.toString("base64") },
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      aad
    };
  } finally {
    key.fill(0);
    plain.fill(0);
  }
}

/** Throws ConfigSecretsError for a wrong passphrase or any change to the blob, its AAD or the bundle version. */
export async function decryptConfigSecrets(blob: EncryptedConfigSecrets, passphrase: string, version: string): Promise<ConfigSecretsPayload> {
  const aad = configSecretsAad(version);
  if (blob.aad !== aad) throw new ConfigSecretsError();
  const key = await scryptAsync(passphrase, Buffer.from(blob.kdf.salt, "base64"), 32, kdfOptions);
  let plain: Buffer | null = null;
  try {
    const sealed = Buffer.from(blob.ciphertext, "base64");
    if (sealed.length < 17) throw new ConfigSecretsError();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.nonce, "base64"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as ConfigSecretsPayload;
  } catch {
    throw new ConfigSecretsError();
  } finally {
    key.fill(0);
    plain?.fill(0);
  }
}

/** Moves every secret into the encrypted blob; the plaintext bundle keeps names only. No passphrase, no secrets. */
export async function sealConfigBundle(bundle: SpaceConfigBundle, secrets: ConfigSecretsPayload, passphrase: string | undefined): Promise<SpaceConfigBundle> {
  const apiKeyNames = Object.keys(secrets.apiKeys ?? {});
  const cliAuthRuntimes = Object.keys(secrets.cliAuth ?? {});
  if (!apiKeyNames.length && !cliAuthRuntimes.length) return bundle;
  if (!passphrase || passphrase.length < 12) {
    throw new Error("A passphrase of at least 12 characters is required to export API keys or CLI logins.");
  }
  return {
    ...bundle,
    metadata: { ...bundle.metadata, apiKeysCount: apiKeyNames.length, credentialsCount: cliAuthRuntimes.length },
    sections: {
      apiKeys: { included: apiKeyNames.length > 0, encrypted: true, names: apiKeyNames },
      cliAuth: { included: cliAuthRuntimes.length > 0, encrypted: true, runtimes: cliAuthRuntimes }
    },
    encrypted: await encryptConfigSecrets(secrets, passphrase, bundle.version)
  };
}

export interface ConfigImportHooks {
  /** Writes the decrypted CLI logins where this host's CLIs read them and reports per runtime. */
  applyCliAuth?(cliAuth: Record<string, CliAuthCapture>): Promise<NonNullable<ImportConfigResult["cliAuth"]>>;
}

/** The bundle's secrets: decrypted with the passphrase, or the plaintext API keys of a 1.0.0 bundle. */
export async function openConfigBundleSecrets(bundle: SpaceConfigBundle, passphrase: string | undefined): Promise<{ secrets: ConfigSecretsPayload; warnings: string[] }> {
  if (!bundle.encrypted) return { secrets: { apiKeys: bundle.data.apiKeys }, warnings: [] };
  if (!passphrase) {
    return { secrets: {}, warnings: ["This backup's API keys and CLI logins are encrypted; enter its passphrase to restore them."] };
  }
  return { secrets: await decryptConfigSecrets(bundle.encrypted, passphrase, bundle.version), warnings: [] };
}

export function collectExportableApiKeys(): Record<string, string> {
  const keys: Record<string, string> = {};

  const candidateDirs = [
    process.env.SPACE_SECRETS_ROOT,
    "/opt/spaceapp/secrets",
    "./secrets",
    "/run/spaceapp-secrets/providers",
    "./secrets/providers",
    "/var/lib/spaceapp-cli/imported-credentials"
  ].filter(Boolean) as string[];

  for (const dir of candidateDirs) {
    if (existsSync(dir)) {
      try {
        const files = readdirSync(dir);
        for (const file of files) {
          if (file.endsWith(".key")) {
            const providerName = file.replace(/^space-/, "").replace(/\.key$/, "");
            if (!isPortableApiKeyName(providerName)) continue;
            try {
              const content = readFileSync(join(dir, file), "utf8").trim();
              if (content && !keys[providerName]) {
                keys[providerName] = content;
              }
            } catch {}
          }
        }
      } catch {}
    }
  }

  const envFileCandidates = [
    "/opt/spaceapp/var/deepseek-harness/secrets/providers.env",
    "./var/deepseek-harness/secrets/providers.env"
  ];
  for (const envFile of envFileCandidates) {
    if (existsSync(envFile)) {
      try {
        const lines = readFileSync(envFile, "utf8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
            const [k, ...rest] = trimmed.split("=");
            const val = rest.join("=").trim().replace(/^["']|["']$/g, "");
            if (k && val) {
              const lowerKey = k.toLowerCase().replace(/_api_key|_key$/, "");
              if (isPortableApiKeyName(lowerKey) && !keys[lowerKey]) {
                keys[lowerKey] = val;
              }
            }
          }
        }
      } catch {}
    }
  }

  const envMap: Record<string, string> = {
    DEEPSEEK_API_KEY: "deepseek",
    OPENAI_API_KEY: "codex",
    ANTHROPIC_API_KEY: "claude",
    GEMINI_API_KEY: "gemini",
    QWEN_API_KEY: "qwen",
    KIMI_API_KEY: "kimi",
    XAI_API_KEY: "grok",
    GROK_API_KEY: "grok",
    OPENCODE_API_KEY: "opencode",
    AUTOHAND_API_KEY: "autohand"
  };
  for (const [envVar, providerId] of Object.entries(envMap)) {
    const val = process.env[envVar];
    if (val && !keys[providerId]) {
      keys[providerId] = val.trim();
    }
  }

  return keys;
}

export function writeImportedApiKeys(
  apiKeys: Record<string, string>,
  options: { secretsDir?: string } = {}
): { imported: number; targetDir: string } {
  let targetDir = options.secretsDir;
  if (!targetDir) {
    if (existsSync("/var/lib/spaceapp-cli/imported-credentials")) {
      targetDir = "/var/lib/spaceapp-cli/imported-credentials";
    } else if (existsSync("./secrets")) {
      targetDir = "./secrets/providers";
    } else if (existsSync("/backups")) {
      targetDir = "/backups/providers-secrets";
    } else {
      targetDir = "./secrets/providers";
    }
  }

  try {
    mkdirSync(targetDir, { recursive: true });
  } catch {}

  let imported = 0;
  for (const [provider, key] of Object.entries(apiKeys)) {
    if (key && typeof key === "string" && isPortableApiKeyName(provider)) {
      const fileName = `${provider}.key`;
      const filePath = join(targetDir, fileName);
      try {
        writeFileSync(filePath, key.trim() + "\n", { mode: 0o600 });
        imported++;
      } catch {}
    }
  }
  return { imported, targetDir };
}
