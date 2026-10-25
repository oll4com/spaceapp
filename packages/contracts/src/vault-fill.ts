import { z } from "zod";
import {
  VAULT_AGENT_STATUSES, VAULT_FIELD_ROLES, vaultSignupGrantCertificateSchema, vaultSymmetricEnvelopeSchema, vaultTransportEnvelopeSchema, vaultUseCapabilitySchema
} from "./vault.js";

// The Browser Host's sealed fill (plan clipboard:vEYtT6-bEN0J step 3, ADR-012): what the API asks the host and what comes
// back. The request carries ciphertext and a broker-signed one-time capability; the answer carries a status, a short reason
// code and, for a generated password, only the password sealed to the operator's inbox key.

const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/);

/**
 * Whether the host must start from a fresh document (a reload) before it looks for fields: false only when the API knows no
 * agent session scripted or changed this document in the page's own world (the CDP proxy's document marks); absent or true
 * reloads, the safe default (Vault review 2026-10-22).
 */
const freshDocument = z.boolean().optional();

export const vaultHostFillRequestSchema = z.object({
  mode: z.enum(["FILL", "TOTP", "GENERATE"]),
  capability: vaultUseCapabilitySchema,
  /** The delegation's fill key under the ARK-derived generation key; only the broker opens it. */
  keyEnvelope: vaultSymmetricEnvelopeSchema,
  /** The item's fill fields under the fill key. */
  fieldEnvelopes: z.partialRecord(z.enum(VAULT_FIELD_ROLES), vaultSymmetricEnvelopeSchema),
  freshDocument
}).strict();
export type VaultHostFillRequest = z.infer<typeof vaultHostFillRequestSchema>;

/**
 * NEW_ACCOUNT under the operator's sign-up grant (option B): no item or delegation exists yet, so the host is bound to this
 * pane, target, frame and exact origin by the request and re-checks them on the live page; the broker generates the password
 * and checks the grant, site, daily cap and expiry. The host learns the password only to type it, through its own reply key.
 */
export const vaultHostSignupRequestSchema = z.object({
  mode: z.literal("SIGNUP"), certificate: vaultSignupGrantCertificateSchema, ownerUserId: z.string().min(1).max(200),
  vaultId: z.string().regex(/^vault:[A-Za-z0-9_-]{16,64}$/), paneId: z.string().min(1).max(200), targetId: z.string().min(1).max(128),
  frameId: z.string().min(1).max(128), origin: z.string().max(300), roles: z.array(z.enum(["NEW_PASSWORD", "CONFIRM_PASSWORD"])).min(1).max(2),
  inboxPublicKey: z.string().regex(/^[A-Za-z0-9_-]{40,80}$/), submit: z.boolean(), freshDocument
}).strict();
export type VaultHostSignupRequest = z.infer<typeof vaultHostSignupRequestSchema>;

export const vaultHostFillResultSchema = z.object({
  status: z.enum(VAULT_AGENT_STATUSES), reason: code.nullable(), sealedGenerated: vaultTransportEnvelopeSchema.nullable(),
  /** True once a value entered the page, whatever happened after: the API then keeps the fence (absent from hosts before 2026-10-22). */
  typed: z.boolean().optional(),
  /** The top frame's document the fill ran in: the host reloads the page first, so it differs from the one the API fenced (absent from older hosts). */
  document: z.string().max(128).nullable().optional()
}).strict();
export type VaultHostFillResult = z.infer<typeof vaultHostFillResultSchema>;

/** The pane's live page as the host sees it, for the broker's use capability. */
export const vaultHostTargetSchema = z.object({
  eligible: z.boolean(), reason: code.nullable(), targetId: z.string().max(128).nullable(), frameId: z.string().max(128).nullable(), origin: z.string().max(300).nullable(),
  /** The top frame's document (CDP loaderId); it changes only when a new document loads. Absent from hosts started before 2026-10-18. */
  document: z.string().max(128).nullable().optional(),
  /** True from a host that takes `freshDocument` in fill requests (2026-10-22); the API sends the field only then, so an older host's strict schema never sees it. */
  freshDocument: z.boolean().optional()
}).strict();
export type VaultHostTarget = z.infer<typeof vaultHostTargetSchema>;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** RFC 4648 base32 (authenticator keys), spaces and padding ignored; null when it is not base32. */
export function decodeVaultBase32(input: string): Uint8Array | null {
  const clean = input.replace(/[\s=]/g, "").toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    buffer = (buffer << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) { bytes.push((buffer >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(bytes);
}

/** RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits by default), computed where it is filled and never returned. */
export async function vaultTotp(secret: Uint8Array, at: Date, options: { digits?: number; periodSeconds?: number } = {}): Promise<string> {
  const digits = options.digits ?? 6;
  const counter = Math.floor(at.getTime() / 1000 / (options.periodSeconds ?? 30));
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const key = await globalThis.crypto.subtle.importKey("raw", new Uint8Array(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}
