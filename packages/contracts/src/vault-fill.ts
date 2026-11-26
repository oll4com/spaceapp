import { z } from "zod";
import {
  VAULT_AGENT_STATUSES, VAULT_FIELD_ROLES, vaultSignupGrantCertificateSchema, vaultSymmetricEnvelopeSchema, vaultTransportEnvelopeSchema, vaultUseCapabilitySchema, vaultFillFieldsSchema
} from "./vault.js";
import { vaultGeneratePolicySchema } from "./vault-password.js";

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
  mode: z.enum(["FILL", "TOTP", "GENERATE", "CARD"]),
  capability: vaultUseCapabilitySchema,
  /** The delegation's fill key under the ARK-derived generation key; only the broker opens it. */
  keyEnvelope: vaultSymmetricEnvelopeSchema,
  /** The item's fill fields under the fill key. */
  fieldEnvelopes: z.partialRecord(z.enum(VAULT_FIELD_ROLES), vaultSymmetricEnvelopeSchema),
  freshDocument,
  /** GENERATE: the site's stated rules; sent only to a host whose target says `generatePolicy` (queue item 37). */
  policy: vaultGeneratePolicySchema.optional()
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
  inboxPublicKey: z.string().regex(/^[A-Za-z0-9_-]{40,80}$/), submit: z.boolean(), freshDocument,
  /** The site's stated rules, merged into the field the broker generates for; only to a host that says `generatePolicy`. */
  policy: vaultGeneratePolicySchema.optional()
}).strict();
export type VaultHostSignupRequest = z.infer<typeof vaultHostSignupRequestSchema>;

/**
 * OTP_QR: the host reads the setup QR on this pane's live page (bound like a sign-up to its target, frame and exact origin) and
 * answers the authenticator key only sealed to the inbox key, in `sealedGenerated`; it never leaves the host in plaintext.
 */
export const vaultHostOtpQrRequestSchema = z.object({
  mode: z.literal("OTP_QR"), ownerUserId: z.string().min(1).max(200), vaultId: z.string().regex(/^vault:[A-Za-z0-9_-]{16,64}$/), paneId: z.string().min(1).max(200),
  targetId: z.string().min(1).max(128), frameId: z.string().min(1).max(128), origin: z.string().max(300), inboxPublicKey: z.string().regex(/^[A-Za-z0-9_-]{40,80}$/)
}).strict();

export const vaultHostFillResultSchema = z.object({
  status: z.enum(VAULT_AGENT_STATUSES), reason: code.nullable(), sealedGenerated: vaultTransportEnvelopeSchema.nullable(),
  /** True once a value entered the page, whatever happened after: the API then keeps the fence (absent from hosts before 2026-10-22). */
  typed: z.boolean().optional(),
  /** The top frame's document the fill ran in: the host reloads the page first, so it differs from the one the API fenced (absent from older hosts). */
  document: z.string().max(128).nullable().optional(),
  /** FILLED/SUBMITTED: the fields typed and the ones that stayed disabled (absent from hosts before 2026-11-07). */
  fields: vaultFillFieldsSchema.optional()
}).strict();
export type VaultHostFillResult = z.infer<typeof vaultHostFillResultSchema>;

/** The pane's live page as the host sees it, for the broker's use capability. */
export const vaultHostTargetSchema = z.object({
  eligible: z.boolean(), reason: code.nullable(), targetId: z.string().max(128).nullable(), frameId: z.string().max(128).nullable(), origin: z.string().max(300).nullable(),
  /** The top frame's document (CDP loaderId); it changes only when a new document loads. Absent from hosts started before 2026-10-18. */
  document: z.string().max(128).nullable().optional(),
  /** True from a host that takes `freshDocument` in fill requests (2026-10-22); the API sends the field only then, so an older host's strict schema never sees it. */
  freshDocument: z.boolean().optional(),
  /** True from a host that takes a generate `policy` (queue item 37, after its guarded restart); the API sends one only then. */
  generatePolicy: z.boolean().optional(),
  /** True from a host that fills cards (mode CARD, payment frames included); the API sends a card fill only then. */
  cards: z.boolean().optional(),
  /** True from a host that reads a setup QR (mode OTP_QR); the API asks only then. */
  otpQr: z.boolean().optional()
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

export const VAULT_OTP_ALGORITHMS = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" } as const;
export interface VaultOtp { secret: Uint8Array; digits: number; periodSeconds: number; algorithm: keyof typeof VAULT_OTP_ALGORITHMS; issuer: string | null; account: string | null }

/**
 * An authenticator key as stored in a Vault item's OTP field: a base32 key, or an otpauth://totp/ URI (Google Authenticator's
 * Key URI format: secret, issuer, digits 6-8, period, algorithm SHA1/SHA256/SHA512). Null when it is neither, or HOTP.
 */
export function parseVaultOtp(value: string): VaultOtp | null {
  const text = value.trim();
  if (!/^otpauth:/i.test(text)) {
    const secret = decodeVaultBase32(text);
    return secret?.length ? { secret, digits: 6, periodSeconds: 30, algorithm: "SHA1", issuer: null, account: null } : null;
  }
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.host.toLowerCase() !== "totp") return null;
  const query = url.searchParams;
  const secret = decodeVaultBase32(query.get("secret") ?? "");
  const digits = Number(query.get("digits") ?? 6);
  const periodSeconds = Number(query.get("period") ?? 30);
  const algorithm = (query.get("algorithm") ?? "SHA1").toUpperCase();
  if (!secret?.length || ![6, 7, 8].includes(digits) || !Number.isInteger(periodSeconds) || periodSeconds < 1 || periodSeconds > 3600 || !(algorithm in VAULT_OTP_ALGORITHMS)) return null;
  let label: string;
  try { label = decodeURIComponent(url.pathname.replace(/^\/+/, "")); } catch { return null; }
  const colon = label.indexOf(":");
  return { secret, digits, periodSeconds, algorithm: algorithm as VaultOtp["algorithm"], issuer: query.get("issuer") || (colon > 0 ? label.slice(0, colon).trim() : null),
    account: (colon >= 0 ? label.slice(colon + 1) : label).trim() || null };
}

/** What the OTP field keeps: the bare key when the URI asks for the defaults (every Browser Host reads that), else the URI itself. */
export function vaultOtpStoredValue(value: string): string | null {
  const otp = parseVaultOtp(value);
  if (!otp) return null;
  if (!/^otpauth:/i.test(value.trim())) return value.replace(/[\s=]/g, "").toUpperCase();
  const defaults = otp.digits === 6 && otp.periodSeconds === 30 && otp.algorithm === "SHA1";
  return defaults ? new URL(value.trim()).searchParams.get("secret")!.replace(/[\s=]/g, "").toUpperCase() : value.trim();
}

/** RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits by default), computed where it is filled and never returned. */
export async function vaultTotp(secret: Uint8Array, at: Date, options: { digits?: number; periodSeconds?: number; algorithm?: VaultOtp["algorithm"] } = {}): Promise<string> {
  const digits = options.digits ?? 6;
  const counter = Math.floor(at.getTime() / 1000 / (options.periodSeconds ?? 30));
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const key = await globalThis.crypto.subtle.importKey("raw", new Uint8Array(secret), { name: "HMAC", hash: VAULT_OTP_ALGORITHMS[options.algorithm ?? "SHA1"] }, false, ["sign"]);
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}
