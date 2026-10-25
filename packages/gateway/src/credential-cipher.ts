import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Provider credentials (OAuth tokens, API keys) are stored as `v1.<iv>.<tag>.<ciphertext>` (base64url),
 * AES-256-GCM with a key derived from the gateway key file and the account id as additional data,
 * so a ciphertext copied onto another account does not decrypt.
 */
export interface CredentialCipher {
  encrypt(plaintext: string, accountId: string): string;
  decrypt(envelope: string, accountId: string): string;
}

const version = "v1";

export function createCredentialCipher(keyMaterial: Buffer): CredentialCipher {
  if (keyMaterial.length < 32) throw new Error("Gateway encryption key must be at least 32 bytes.");
  const key = Buffer.from(hkdfSync("sha256", keyMaterial, Buffer.alloc(0), "space-gateway-credentials-v1", 32));
  return {
    encrypt(plaintext, accountId) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(accountId, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [version, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
    },
    decrypt(envelope, accountId) {
      const [envelopeVersion, iv, tag, ciphertext, extra] = envelope.split(".");
      if (envelopeVersion !== version || !iv || !tag || ciphertext === undefined || extra !== undefined) {
        throw new Error("Unsupported credential envelope.");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(accountId, "utf8"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    }
  };
}

/** Reads the key file (base64 of at least 32 random bytes, created once by the deploy). Its contents are never logged. */
export async function loadCredentialCipher(path: string): Promise<CredentialCipher> {
  const raw = (await readFile(path, "utf8")).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error("Gateway encryption key file must hold base64.");
  return createCredentialCipher(Buffer.from(raw, "base64"));
}
