import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_VERSION = 2;

function sessionSecret(): string {
  const secret = process.env.SPACE_SESSION_SECRET;
  if (!secret) throw new Error("Stored database passwords need SPACE_SESSION_SECRET, which is not set.");
  return secret;
}

// A purpose-bound key (review F6, 2026-10-14): the session secret also signs sessions.
function getEncryptionKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionSecret(), "", "space:databases:credentials:v2", 32));
}

// Payloads without a version were encrypted with the plain SHA-256 of the session secret; they are
// still read, and the next save of the connection writes them with the current key.
function legacyEncryptionKey(): Buffer {
  return createHash("sha256").update(sessionSecret()).digest();
}

export function encryptSecret(plainText: string): string {
  if (!plainText) return "";
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return JSON.stringify({
    v: KEY_VERSION,
    iv: iv.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    tag: authTag.toString("base64")
  });
}

/** Throws instead of returning an empty password, so a connection never silently loses its credentials (review F7). */
export function decryptSecret(encryptedPayload: string | null | undefined): string {
  if (!encryptedPayload) return "";
  sessionSecret();
  try {
    const parsed = JSON.parse(encryptedPayload) as { v?: number; iv: string; ciphertext: string; tag: string };
    const key = parsed.v === KEY_VERSION ? getEncryptionKey() : legacyEncryptionKey();
    // A full 16-byte tag is required: GCM would otherwise accept a truncated one (external review 2026-10-16).
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, "base64"), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    return decipher.update(Buffer.from(parsed.ciphertext, "base64")) + decipher.final("utf8");
  } catch {
    throw new Error(
      "CREDENTIAL_UNREADABLE: The stored password of this connection cannot be read, for example after a restore on another host. Enter the password again in the connection settings."
    );
  }
}
