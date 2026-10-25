import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Space Gateway API keys: `sk-sgw-<43 base64url chars>`, stored only as SHA-256 hex with a 15-char display prefix. */
export const gatewayKeyPrefixLength = 15;

export function hashGatewayApiKey(plainKey: string): string {
  return createHash("sha256").update(plainKey, "utf8").digest("hex");
}

export function generateGatewayApiKey(): { plainKey: string; keyHash: string; keyPrefix: string } {
  const plainKey = `sk-sgw-${randomBytes(32).toString("base64url")}`;
  return { plainKey, keyHash: hashGatewayApiKey(plainKey), keyPrefix: plainKey.slice(0, gatewayKeyPrefixLength) };
}

/** Accepts `Authorization: Bearer <key>` and `x-api-key: <key>` (Anthropic clients send the latter). */
export function readPresentedApiKey(headers: Record<string, string | string[] | undefined>): string | null {
  const pick = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() || null;
  const authorization = pick(headers.authorization);
  if (authorization) {
    const match = /^Bearer\s+(\S{8,512})$/i.exec(authorization);
    return match ? match[1]! : null;
  }
  const apiKey = pick(headers["x-api-key"]);
  return apiKey && apiKey.length >= 8 && apiKey.length <= 512 ? apiKey : null;
}

export function sameKeyHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
