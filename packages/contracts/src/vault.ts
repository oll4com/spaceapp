import { z } from "zod";
import { getDomain } from "tldts";
import { vaultGeneratePolicySchema, vaultPasswordPolicySchema } from "./vault-password.js";
import { noRepeatedValues } from "./array-rules.js";

// Vault contracts (plan clipboard:vEYtT6-bEN0J step 2, ADR-012). Everything here is ciphertext, public keys or
// non-secret metadata: no schema has a field that can hold a plaintext secret, a VRK share, a password or the ARK.

export const VAULT_FORMAT_VERSION = 1;
export const VAULT_FIELD_ROLES = ["USERNAME", "PASSWORD", "OTP"] as const;
/** What a fill typed and what stayed disabled or read-only (Oracle 7/11: a confirm box the site opens late), so an agent never submits past an empty box. */
const filledRole = z.enum([...VAULT_FIELD_ROLES, "NEW_PASSWORD", "CONFIRM_PASSWORD"]);
export const vaultFillFieldsSchema = z.object({ filled: z.array(filledRole), disabled: z.array(filledRole) }).strict();
export const VAULT_APPROVAL_MODES = ["ASSIST", "RULES", "FULL"] as const;
/** What each envelope protects; part of the AEAD associated data, so an envelope never opens in another role. */
export const VAULT_ENVELOPE_PURPOSES = [
  "PASSWORD_SHARE", "RECOVERY_SHARE", "SERVER_SHARE", "ITEM_KEY", "ITEM_FIELD", "FILL_KEY", "FILL_FIELD", "TRANSPORT", "INBOX_KEY"
] as const;
/** The only results an agent ever receives (design: VaultAgentResult). */
// APPROVAL_REQUESTED stays for audit records written before per-use approvals were removed (2026-10-18).
// TAKEN and USED: an API key the operator handed to agents (vault-handoff.ts, 2026-10-22).
export const VAULT_AGENT_STATUSES = ["FILLED", "SUBMITTED", "BLOCKED", "EXPIRED", "REVOKED", "ORIGIN_MISMATCH", "RATE_LIMITED", "APPROVAL_REQUESTED", "LISTED", "SAVED", "TAKEN", "USED"] as const;
export const VAULT_AUDIT_ACTIONS = [
  "ENROLL", "UNLOCK", "LOCK", "PASSWORD_ROTATE", "RECOVERY_SET", "RECOVERY_USE", "ITEM_SAVE", "ITEM_DELETE",
  "DELEGATE", "REVOKE", "FILL", "APPROVAL", "EPOCH_BUMP", "AGENT_LIST", "GENERATE", "SIGNUP_GRANT", "INBOX_SET", "KEY_HANDOFF"
] as const;
export const VAULT_NONCE_PURPOSES = ["UNLOCK_CHALLENGE", "FILL_USE", "REQUEST"] as const;
/**
 * Technical bounds, not policy limits (agents get every login, operator rule 2026-10-20): a delegation of this many logins is
 * about 2 MB of signed claims, far above any real Chrome export, and the broker socket's API bodies and answers stay in memory.
 */
export const VAULT_DELEGATION_TECHNICAL_MAX_ITEMS = 10_000;
export const VAULT_BROKER_API_MAX_BYTES = 8 * 1024 * 1024;

export type VaultFieldRole = (typeof VAULT_FIELD_ROLES)[number];
export type VaultApprovalMode = (typeof VAULT_APPROVAL_MODES)[number];
export type VaultEnvelopePurpose = (typeof VAULT_ENVELOPE_PURPOSES)[number];
export type VaultNoncePurpose = (typeof VAULT_NONCE_PURPOSES)[number];

const b64url = (min: number, max: number) => z.string().min(min).max(max).regex(/^[A-Za-z0-9_-]+$/);
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}:[A-Za-z0-9_-]{16,64}$`));
export const vaultIdSchema = id("vault");
export const vaultItemIdSchema = id("vault_item");
export const vaultDelegationIdSchema = id("vault_delegation");
export const vaultAuditIdSchema = id("vault_audit");
export const vaultPendingIdSchema = id("vault_pending");
export const vaultSignupGrantIdSchema = id("vault_grant");
const ownerSchema = z.string().min(1).max(200);
const keyVersion = z.number().int().min(1).max(1_000_000);
const isoDate = z.string().datetime();

/** AES-256-GCM under a symmetric key; 12-byte nonce, ciphertext includes the tag. */
export const vaultSymmetricEnvelopeSchema = z.object({
  v: z.literal(1), alg: z.literal("A256GCM"), purpose: z.enum(VAULT_ENVELOPE_PURPOSES), keyVersion,
  nonce: b64url(16, 16), ct: b64url(22, 16_384)
}).strict();
/** Sealed to an X25519 public key (an operator browser's ephemeral key or the broker's transport key). */
export const vaultTransportEnvelopeSchema = z.object({
  v: z.literal(1), alg: z.literal("X25519-HKDF-A256GCM"), purpose: z.literal("TRANSPORT"), keyVersion,
  epk: b64url(40, 80), nonce: b64url(16, 16), ct: b64url(22, 16_384)
}).strict();
export const vaultEnvelopeSchema = z.union([vaultSymmetricEnvelopeSchema, vaultTransportEnvelopeSchema]);
export type VaultSymmetricEnvelope = z.infer<typeof vaultSymmetricEnvelopeSchema>;
export type VaultTransportEnvelope = z.infer<typeof vaultTransportEnvelopeSchema>;

/** Argon2id, run only in the operator's browser; the server stores these non-secret parameters. */
export const vaultKdfParamsSchema = z.object({
  alg: z.literal("argon2id"), version: z.literal(0x13), memoryKiB: z.number().int().min(19_456).max(1_048_576),
  iterations: z.number().int().min(2).max(10), parallelism: z.number().int().min(1).max(4), salt: b64url(22, 88), keyLength: z.literal(32)
}).strict();
export type VaultKdfParams = z.infer<typeof vaultKdfParamsSchema>;
export const VAULT_KDF_DEFAULTS = { alg: "argon2id", version: 0x13, memoryKiB: 65_536, iterations: 3, parallelism: 1, keyLength: 32 } as const;

/** Everything about an associated-data context; an envelope opened under any other context fails. */
export interface VaultAadContext {
  purpose: VaultEnvelopePurpose;
  ownerUserId: string;
  vaultId: string;
  keyVersion: number;
  itemId?: string | null;
  field?: VaultFieldRole | null;
  generation?: number | null;
}

/** Deterministic JSON (sorted keys) for AAD, signatures and digests. */
export function vaultCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(vaultCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${vaultCanonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function vaultAad(context: VaultAadContext): Uint8Array {
  return new TextEncoder().encode(vaultCanonicalJson({
    v: VAULT_FORMAT_VERSION, purpose: context.purpose, ownerUserId: context.ownerUserId, vaultId: context.vaultId,
    keyVersion: context.keyVersion, itemId: context.itemId ?? null, field: context.field ?? null, generation: context.generation ?? null
  }));
}

export type VaultOriginWarning = "INSECURE_HTTP" | "IP_LITERAL" | "PUNYCODE";

/**
 * Exact origin (scheme, lower-case IDNA host, explicit non-default port). Paths are dropped; credentials, wildcards,
 * non-web schemes and trailing-dot hosts are refused. Warnings need the operator's explicit acceptance per item.
 */
export function canonicalVaultOrigin(input: string): { origin: string; warnings: VaultOriginWarning[] } | null {
  if (input.includes("*")) return null;
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname || url.hostname.endsWith(".")) return null;
  const warnings: VaultOriginWarning[] = [];
  if (url.protocol === "http:") warnings.push("INSECURE_HTTP");
  if (url.hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) warnings.push("IP_LITERAL");
  if (url.hostname.split(".").some((label) => label.startsWith("xn--"))) warnings.push("PUNYCODE");
  return { origin: url.origin, warnings };
}

const canonicalOrigin = z.string().max(300).refine((value) => canonicalVaultOrigin(value)?.origin === value, "Not an exact canonical origin.");

/**
 * An item's login page (operator 4/11 16:33 BKK, nous_msg:cc5aba71: Shopflix's origin answers 500, its login page is a path): a
 * plain address, never a secret, on one of the item's own origins, so it changes neither where a login fills nor what matches.
 */
export function vaultLoginPageProblem(loginPage: string, origins: readonly string[]): string | null {
  let url: URL;
  try { url = new URL(loginPage); } catch { return "The login page is not a web address."; }
  if (url.username || url.password) return "The login page must not carry a username or password.";
  return origins.includes(url.origin) ? null : `The login page must be on the item's own site (${origins.join(", ")}).`;
}
const loginPageField = z.string().trim().min(1).max(2000);
/** Where the Vault opens an item: its login page when it has one, else its first origin. */
export const vaultItemLink = (item: { origins: readonly string[]; loginPage?: string | null }) => item.loginPage ?? item.origins[0] ?? null;

// approvalMode and maxFillsPerHour are kept so stored items keep parsing; nothing enforces them since the one-switch
// decision (2026-10-18: no per-use approval, no hourly limit; vault-protection.test.ts "no hourly limit").
export const vaultItemPolicySchema = z.object({
  agentUse: z.boolean(), approvalMode: z.enum(VAULT_APPROVAL_MODES), submitAllowed: z.boolean(),
  maxFillsPerHour: z.number().int().min(1).max(60), acceptedOriginRisks: z.array(canonicalOrigin).max(10),
  /** Generator policy for this item; absent means VAULT_PASSWORD_DEFAULTS narrowed by the field. */
  passwordPolicy: vaultPasswordPolicySchema.optional()
}).strict();

/** Non-secret item metadata; usernames are secret fields, never metadata. */
export const vaultItemMetadataSchema = z.object({
  id: vaultItemIdSchema, label: z.string().trim().min(1).max(80), origins: z.array(canonicalOrigin).min(1).max(10),
  fieldRoles: z.array(z.enum(VAULT_FIELD_ROLES)).min(1).max(3), policy: vaultItemPolicySchema,
  /** PENDING: created or changed by an agent's generated password; the operator keeps or discards it. */
  status: z.enum(["ACTIVE", "PENDING"]).default("ACTIVE"),
  /** The owner's Google account the login belongs to (a Chrome import's source account, migration 0240); null: none. */
  googleAccountId: z.string().regex(/^google_account:[A-Za-z0-9_-]{1,80}$/).nullable().default(null),
  /**
   * HMAC of the first origin and the lower-case username under a key derived from the VRK, made in the unlocked browser: two
   * items with the same site and username have the same key, so a fill can prefer the pane's Google account. Never sent to agents.
   */
  loginKey: b64url(22, 22).nullable().default(null),
  /** The page to open for this login (vaultLoginPageProblem); null: its first origin. */
  loginPage: loginPageField.nullable().default(null)
}).strict().superRefine((item, context) => {
  const pageProblem = item.loginPage ? vaultLoginPageProblem(item.loginPage, item.origins) : null;
  if (pageProblem) context.addIssue({ code: "custom", message: pageProblem, path: ["loginPage"] });
  for (const origin of item.origins) {
    if (canonicalVaultOrigin(origin)!.warnings.length > 0 && !item.policy.acceptedOriginRisks.includes(origin)) {
      context.addIssue({ code: "custom", message: `Origin ${origin} needs the operator's explicit acceptance.`, path: ["origins"] });
    }
  }
  if (new Set(item.fieldRoles).size !== item.fieldRoles.length) context.addIssue({ code: "custom", message: "Duplicate field role.", path: ["fieldRoles"] });
});
export type VaultItemMetadata = z.infer<typeof vaultItemMetadataSchema>;

export const vaultItemRecordSchema = z.object({
  metadata: vaultItemMetadataSchema, keyVersion, dekEnvelope: vaultSymmetricEnvelopeSchema,
  fields: z.partialRecord(z.enum(VAULT_FIELD_ROLES), vaultSymmetricEnvelopeSchema),
  /** Earlier field envelopes (same item key) kept after a password change until the operator confirms the new one. */
  history: z.array(z.object({ fields: z.partialRecord(z.enum(VAULT_FIELD_ROLES), vaultSymmetricEnvelopeSchema), replacedAt: isoDate }).strict()).max(5).default([])
}).strict();
export type VaultItemRecord = z.infer<typeof vaultItemRecordSchema>;
export type VaultItemRecordInput = z.input<typeof vaultItemRecordSchema>;

/** Saving many items at once (a Chrome import): a technical bound per request (about 2 KB an item), the dock sends batches. */
export const VAULT_ITEM_BATCH_MAX = 100;
export const vaultItemBatchRequestSchema = z.object({ items: z.array(vaultItemRecordSchema).min(1).max(VAULT_ITEM_BATCH_MAX) }).strict();
/** The operator's explicit delete of items (one, or the dead-site list), signed by the unlocked dock (vaultOperatorRequestMessage). */
export const vaultItemDeleteRequestSchema = z.object({
  ids: z.array(vaultItemIdSchema).min(1).max(VAULT_DELEGATION_TECHNICAL_MAX_ITEMS), epoch: z.number().int().min(1), operatorSignature: b64url(86, 86)
}).strict();
/** Which login sites still exist: the dock sends its items' origins in batches; only the owner's own origins are checked. */
export const VAULT_SITE_CHECK_BATCH_MAX = 50;
export const vaultSiteCheckRequestSchema = z.object({ origins: z.array(z.string().max(300)).min(1).max(VAULT_SITE_CHECK_BATCH_MAX) }).strict();

export const vaultRecoverySchema = z.object({ keyVersion, envelope: vaultSymmetricEnvelopeSchema, createdAt: isoDate }).strict();
export type VaultRecovery = z.infer<typeof vaultRecoverySchema>;
/** Setting the recovery envelope: the stored shape plus the unlocked dock's signature over it (vaultOperatorRequestMessage). */
export const vaultRecoverySetRequestSchema = vaultRecoverySchema.extend({ epoch: z.number().int().min(1), operatorSignature: b64url(86, 86) }).strict();

/** A delegation's fill material: item handle -> field role -> envelope under the delegation's fill key. */
export const vaultFillEnvelopesSchema = z.record(vaultItemIdSchema, z.partialRecord(z.enum(VAULT_FIELD_ROLES), vaultSymmetricEnvelopeSchema));
export type VaultFillEnvelopes = z.infer<typeof vaultFillEnvelopesSchema>;

/** What enrollment and password rotation store: the browser's password envelope and the broker's server share. */
export const vaultEnrollmentSchema = z.object({
  vaultId: vaultIdSchema, kdf: vaultKdfParamsSchema, passwordEnvelope: vaultSymmetricEnvelopeSchema,
  serverShareEnvelope: vaultSymmetricEnvelopeSchema, unlockPublicKey: b64url(40, 120), unlockKeyVersion: keyVersion
}).strict();
export type VaultEnrollment = z.infer<typeof vaultEnrollmentSchema>;

const signed = <T extends z.ZodType>(claims: T) => z.object({ claims, sig: b64url(86, 86), keyVersion }).strict();

/** Signed by the broker's delegation key when the operator delegates items to agents. */
export const vaultDelegationClaimsSchema = z.object({
  v: z.literal(1), kind: z.literal("DELEGATION"), certId: vaultDelegationIdSchema, ownerUserId: ownerSchema, vaultId: vaultIdSchema,
  generation: z.number().int().min(1), unlockEpoch: z.number().int().min(1),
  items: z.array(z.object({
    handle: vaultItemIdSchema, origins: z.array(canonicalOrigin).min(1).max(10), fields: z.array(z.enum(VAULT_FIELD_ROLES)).min(1).max(3),
    approvalMode: z.enum(VAULT_APPROVAL_MODES), submit: z.boolean()
  }).strict()).min(1).max(VAULT_DELEGATION_TECHNICAL_MAX_ITEMS),
  envelopeDigest: b64url(43, 43), issuedAt: isoDate, expiresAt: isoDate
}).strict();
export const vaultDelegationCertificateSchema = signed(vaultDelegationClaimsSchema);
export type VaultDelegationClaims = z.infer<typeof vaultDelegationClaimsSchema>;

/** One fill: the broker binds a delegation to one live target and frame and a one-time nonce. */
export const vaultUseClaimsSchema = z.object({
  v: z.literal(1), kind: z.literal("USE"), certId: vaultDelegationIdSchema, ownerUserId: ownerSchema, vaultId: vaultIdSchema,
  generation: z.number().int().min(1), epoch: z.number().int().min(1), handle: vaultItemIdSchema, origin: canonicalOrigin,
  fields: z.array(z.enum(VAULT_FIELD_ROLES)).min(1).max(3), submit: z.boolean(), paneId: z.string().min(1).max(200),
  targetId: z.string().min(1).max(128), pageId: z.string().min(1).max(128), frameId: z.string().min(1).max(128),
  nonce: b64url(22, 64), issuedAt: isoDate, expiresAt: isoDate,
  /** Generate fills only: the fields to fill and the operator's PENDING inbox key the generated password is sealed to. */
  generate: z.object({ roles: z.array(z.enum(["NEW_PASSWORD", "CONFIRM_PASSWORD"])).min(1).max(2), inboxPublicKey: b64url(40, 80) }).strict().optional()
}).strict();
export const vaultUseCapabilitySchema = signed(vaultUseClaimsSchema);
export type VaultUseClaims = z.infer<typeof vaultUseClaimsSchema>;

const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/);
/** A CDP method ("Runtime.callFunctionOn") or UNKNOWN / UNKNOWN_DOCUMENT: what made a page dirty before a Vault fill (28/10). */
export const vaultDirtiedBySchema = z.string().regex(/^[A-Z][A-Za-z_]{0,30}(\.[A-Za-z]{1,40})?$/);
/**
 * The only shape an agent-facing Vault answer may take; auditId is null only when the owner has no vault to audit in. `reason`
 * (2026-10-22) is the audit's short code, so a fill can be acted on: FIELD_NOT_FOUND_AFTER_RELOAD says the page was reloaded
 * first and the field was gone; redo the steps with navigate, click, type and press only, then fill again.
 */
export const vaultAgentResultSchema = z.object({ status: z.enum(VAULT_AGENT_STATUSES), auditId: vaultAuditIdSchema.nullable(), reason: code.nullable().default(null),
  /** FILLED/SUBMITTED: the fields typed and the ones still disabled (reason FIELD_DISABLED: never submitted, the page needs a look first). */
  fields: vaultFillFieldsSchema.optional(),
  /** FIELD_NOT_FOUND_AFTER_RELOAD: the CDP method that made the page dirty (Runtime.callFunctionOn = browser_evaluate), never page text. */
  dirtiedBy: vaultDirtiedBySchema.optional(),
  /** R20-7: a fill typed into a fresh document after a reload; the page's other fields and steps are gone and need redoing. */
  reloaded: z.literal(true).optional(),
  /** SIGNIN_WORKS: Space's own sentence (the stored sign-in's last SUCCESS and method), never page text. */
  message: z.string().max(400).optional() }).strict();
export type VaultAgentResult = z.infer<typeof vaultAgentResultSchema>;

/** Audit payload: ids, enums and short codes only, so no secret or page text can be written into it. */
export const vaultAuditEventSchema = z.object({
  actor: z.enum(["OPERATOR", "AGENT", "BROKER", "SYSTEM"]), action: z.enum(VAULT_AUDIT_ACTIONS),
  result: z.enum(["OK", ...VAULT_AGENT_STATUSES]), reason: code.nullable().default(null),
  itemId: vaultItemIdSchema.nullable().default(null), origin: canonicalOrigin.nullable().default(null),
  fields: z.array(z.enum(VAULT_FIELD_ROLES)).max(3).default([]), paneId: z.string().max(200).nullable().default(null)
}).strict();
export type VaultAuditEvent = z.input<typeof vaultAuditEventSchema>;
export type VaultAuditRecord = z.output<typeof vaultAuditEventSchema>;

// Agent requests (bridge /api/cli/space-vault/*, MCP space_vault). Session, owner and origin always come from the verified
// bridge and the live browser session; a named browser pane must be in the caller's room and the owner's. No selector, URL,
// script or stored value is accepted (a save carries only the login the agent itself created).
export const VAULT_GENERATE_ROLES = ["NEW_PASSWORD", "CONFIRM_PASSWORD"] as const;
export const vaultAgentEmptyRequestSchema = z.object({}).strict();
/** The browser pane in the caller's room to fill; default: the caller's own browser, else the room's first browser pane. */
const targetPaneId = z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/).optional();
export const vaultAgentFillRequestSchema = z.object({
  handle: vaultItemIdSchema, fields: z.array(z.enum(["USERNAME", "PASSWORD"])).min(1).max(2), submit: z.boolean().default(false), targetPaneId
}).strict();
export const vaultAgentTotpRequestSchema = z.object({ handle: vaultItemIdSchema, submit: z.boolean().default(false), targetPaneId }).strict();
/** Generate a password inside the fill path and fill it; the agent learns only the handle of the (PENDING) item. */
export const vaultAgentGenerateRequestSchema = z.object({
  purpose: z.enum(["NEW_ACCOUNT", "CHANGE_PASSWORD"]),
  /** CHANGE_PASSWORD: the item whose password changes. */
  handle: vaultItemIdSchema.optional(),
  /** NEW_ACCOUNT: the label of the item to create. */
  label: z.string().trim().min(1).max(80).optional(),
  /** NEW_ACCOUNT: the account name the agent typed (it already knows it); stored encrypted. */
  username: z.string().trim().min(1).max(320).optional(),
  roles: z.array(z.enum(VAULT_GENERATE_ROLES)).min(1).max(2).default(["NEW_PASSWORD"]),
  submit: z.boolean().default(false),
  /** The site's stated password rules its field attributes do not carry (queue item 37). */
  policy: vaultGeneratePolicySchema.optional(),
  /** The operator's explicit order for a reset at a site whose stored sign-in works (nous_msg:fe72e061): its Nous message id, audited. */
  operatorOrder: z.string().regex(/^nous_msg:[A-Za-z0-9_-]{6,80}$/).optional(),
  targetPaneId
}).strict().superRefine((request, context) => {
  if (request.purpose === "CHANGE_PASSWORD" && !request.handle) context.addIssue({ code: "custom", message: "CHANGE_PASSWORD needs the item handle.", path: ["handle"] });
  if (request.purpose === "NEW_ACCOUNT" && (request.handle || !request.label)) context.addIssue({ code: "custom", message: "NEW_ACCOUNT needs a label and no handle.", path: ["label"] });
});
/** space_vault_list filters: a site (address or host; its subdomains too) and a Google account address. */
export const vaultAgentListRequestSchema = z.object({
  site: z.string().trim().min(1).max(2000).optional(),
  account: z.string().trim().min(1).max(320).optional()
}).strict();
export const vaultAgentAuditRequestSchema = z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict();
export type VaultAgentGenerateRequest = z.infer<typeof vaultAgentGenerateRequestSchema>;

/** A site for an agent-saved login: an exact origin without risk warnings (http, IP address, punycode need the operator). */
export function vaultAgentSaveSite(input: string): string | null {
  const parsed = canonicalVaultOrigin(input);
  return parsed && parsed.warnings.length === 0 ? parsed.origin : null;
}
/**
 * A login an agent (or Nous) created and saves: it already knows these values, since it registered the account. The API seals
 * them to the operator's inbox key at once and it is fillable at once, Vault locked or not; the dock files it as an item when it is next unlocked.
 */
export const vaultAgentSaveRequestSchema = z.object({
  /** Only with loginPage: set (or with null clear) the login page of a saved login; no value changes, no unlock. */
  handle: vaultItemIdSchema.optional(),
  site: z.string().trim().min(1).max(2000).refine((value) => vaultAgentSaveSite(value) !== null, "Not a web address Space can save (https, no IP address or punycode name).").optional(),
  username: z.string().trim().min(1).max(320).optional(),
  password: z.string().min(1).max(512).optional(),
  label: z.string().trim().min(1).max(80).optional(),
  loginPage: loginPageField.nullable().optional()
}).strict().superRefine((value, context) => {
  const issue = (message: string, path: string) => context.addIssue({ code: "custom", message, path: [path] });
  if (value.handle) {
    if (value.site || value.username || value.password || value.label) issue("With handle, send only loginPage.", "handle");
    if (value.loginPage === undefined) issue("With handle, loginPage is required (null clears it).", "loginPage");
    return;
  }
  for (const field of ["site", "username", "label"] as const) if (!value[field]) issue(`${field} is required for a new login.`, field);
  const origin = value.site ? vaultAgentSaveSite(value.site) : null;
  const problem = value.loginPage && origin ? vaultLoginPageProblem(value.loginPage, [origin]) : null;
  if (problem) issue(problem, "loginPage");
});

/** space_vault_status: whether the operator lets agents and Nous use the Vault, and how many items are handed to them. */
export const vaultAgentStatusResultSchema = z.object({
  status: z.literal("LISTED"), auditId: vaultAuditIdSchema.nullable(), agentAccess: z.boolean(), delegatedItems: z.number().int().min(0)
}).strict();
/** space_vault_audit: this pane's recent Vault attempts, ids and result codes only. */
export const vaultAgentAuditResultSchema = z.object({
  status: z.literal("LISTED"), auditId: vaultAuditIdSchema.nullable(),
  entries: z.array(z.object({
    at: isoDate, action: z.enum(VAULT_AUDIT_ACTIONS), result: z.enum(["OK", ...VAULT_AGENT_STATUSES]), reason: code.nullable(), itemId: vaultItemIdSchema.nullable()
  }).strict()).max(50)
}).strict();

/** The dock's one switch: agents and Nous may use the Vault (operator decision 2026-10-18). Off revokes their access. */
export const vaultAgentAccessRequestSchema = z.object({ enabled: z.boolean() }).strict();

// Operator requests (/api/space-vault/*). Bodies carry ciphertext and public keys only; the browser does every decrypt.
const b64urlField = (min: number, max: number) => z.string().min(min).max(max).regex(/^[A-Za-z0-9_-]+$/);
/** Enrollment: the server share arrives sealed to the broker's transport key, so the API never sees it. */
export const vaultEnrollRequestSchema = z.object({
  vaultId: vaultIdSchema, kdf: vaultKdfParamsSchema, passwordEnvelope: vaultSymmetricEnvelopeSchema,
  sealedServerShare: vaultTransportEnvelopeSchema, unlockPublicKey: b64urlField(40, 120), unlockKeyVersion: keyVersion
}).strict();
export const vaultUnlockRequestSchema = z.object({
  challenge: b64urlField(22, 64), replyPublicKey: b64urlField(40, 80), signature: b64urlField(86, 86)
}).strict();
export const vaultPasswordRotateRequestSchema = z.object({
  expectedEpoch: z.number().int().min(1), kdf: vaultKdfParamsSchema, passwordEnvelope: vaultSymmetricEnvelopeSchema,
  unlockPublicKey: b64urlField(40, 120), unlockKeyVersion: keyVersion,
  /** A new master password set with the recovery key (audited as RECOVERY_USE). */
  recovery: z.boolean().optional(),
  /** The current unlock key's signature over this request (vaultOperatorRequestMessage "password"). */
  operatorSignature: b64urlField(86, 86)
}).strict();
export const vaultAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50), beforeSeq: z.coerce.number().int().min(1).optional()
}).strict();

/** Delegate items to agents: fill fields sealed under a fresh fill key, the key sealed to the broker. */
export const vaultDelegateRequestSchema = z.object({
  items: z.array(z.object({
    handle: vaultItemIdSchema, origins: z.array(canonicalOrigin).min(1).max(10), fields: z.array(z.enum(VAULT_FIELD_ROLES)).min(1).max(3),
    approvalMode: z.enum(VAULT_APPROVAL_MODES), submit: z.boolean()
  }).strict()).min(1).max(VAULT_DELEGATION_TECHNICAL_MAX_ITEMS),
  fillEnvelopes: vaultFillEnvelopesSchema,
  sealedFillKey: vaultTransportEnvelopeSchema,
  /** Signed by the operator with the items: the next generation, the epoch it was unlocked in and the end of the delegation. */
  generation: z.number().int().min(1),
  unlockEpoch: z.number().int().min(1),
  expiresAt: isoDate,
  /** The unlocked dock's Ed25519 signature (the vault's unlock key) over vaultDelegationOperatorMessage: proof of the master password. */
  operatorSignature: b64url(86, 86),
  /** The inbox's private key sealed to the broker (operator request 2026-10-20): logins agents save join the delegation at once. */
  sealedInboxKey: vaultTransportEnvelopeSchema.optional()
}).strict();

/**
 * What the operator's unlock key signs to delegate: the exact items with the origins they may be filled at, fields,
 * approval modes, the fill envelopes' digest, the generation, the unlock epoch and the expiry (review 2026-10-17 H1, M2).
 */
export function vaultDelegationOperatorMessage(input: {
  ownerUserId: string; vaultId: string; envelopeDigest: string; generation: number; unlockEpoch: number; expiresAt: string;
  items: Array<{ handle: string; origins: string[]; fields: string[]; approvalMode: string; submit: boolean }>;
}): Uint8Array {
  return new TextEncoder().encode(vaultCanonicalJson({ v: 2, kind: "space-vault-delegate", ownerUserId: input.ownerUserId, vaultId: input.vaultId,
    envelopeDigest: input.envelopeDigest, generation: input.generation, unlockEpoch: input.unlockEpoch, expiresAt: input.expiresAt,
    items: input.items.map(({ handle, origins, fields, approvalMode, submit }) => ({ handle, origins: [...origins].sort(), fields: [...fields].sort(), approvalMode, submit })) }));
}

/** space_vault_list while agent access is on: what an agent may know of a delegated item. */
export const vaultAgentListItemSchema = z.object({
  handle: vaultItemIdSchema, label: z.string().max(80), origins: z.array(z.string().max(300)).max(10), fields: z.array(z.enum(VAULT_FIELD_ROLES)).max(3),
  /** The Google account's address the login belongs to (a Chrome import's source account); absent: none. */
  account: z.string().max(320).optional(),
  /** The page to open before a fill; absent: the first origin. */
  loginPage: z.string().max(2000).optional()
}).strict();
export const vaultAgentListResultSchema = z.object({
  status: z.literal("LISTED"), auditId: vaultAuditIdSchema.nullable(), items: z.array(vaultAgentListItemSchema).max(VAULT_DELEGATION_TECHNICAL_MAX_ITEMS)
}).strict();

/** The operator's inbox key: generated passwords arrive sealed to it while the Vault is locked. */
export const vaultInboxKeyRequestSchema = z.object({ publicKey: b64url(40, 80), privateKeyEnvelope: vaultSymmetricEnvelopeSchema }).strict();
/** Setting the inbox key: the stored shape plus the unlocked dock's signature over it (vaultOperatorRequestMessage "inbox"). */
export const vaultInboxKeySetRequestSchema = vaultInboxKeyRequestSchema.extend({ epoch: z.number().int().min(1), operatorSignature: b64url(86, 86) }).strict();

// Operator routes that change keys or delete logins carry the unlocked dock's unlock-key signature (Vault review 2026-10-22):
// a session cookie alone can no longer swap the inbox key (which every password agents generate is sealed to), replace the
// password or recovery envelope, or delete logins. The API verifies against the enrolled unlock public key, as the broker
// does for delegations; the signed body names the current epoch, so a lock, revoke or password change voids older signatures.
export const VAULT_OPERATOR_SIGNED_KINDS = ["inbox", "password", "recovery", "item-delete"] as const;
export type VaultOperatorSignedKind = (typeof VAULT_OPERATOR_SIGNED_KINDS)[number];
/** The bytes the unlock key signs: the kind, owner and vault, and the request body without its signature, as canonical JSON. */
export function vaultOperatorRequestMessage(kind: VaultOperatorSignedKind, input: { ownerUserId: string; vaultId: string } & Record<string, unknown>): Uint8Array {
  const { operatorSignature: _signature, ...body } = input;
  return new TextEncoder().encode(vaultCanonicalJson({ v: 1, kind: `space-vault-${kind}`, ...body }));
}

/** A login an agent saved or a password it generated in a fill: fillable at once through the delegation; the dock files it as an item when next unlocked. */
export const vaultPendingSecretSchema = z.object({
  id: id("vault_pending"), kind: z.enum(["NEW_ACCOUNT", "CHANGE_PASSWORD"]), handle: vaultItemIdSchema, label: z.string().max(80), origin: canonicalOrigin,
  sealedUsername: vaultTransportEnvelopeSchema.nullable(), sealedPassword: vaultTransportEnvelopeSchema.nullable(), paneId: z.string().max(200).nullable(), createdAt: isoDate,
  /** A new login's login page (on its origin), filed with it; a set by handle before the dock files it lands here too. */
  loginPage: loginPageField.nullable().default(null)
}).strict();
export type VaultPendingSecret = z.infer<typeof vaultPendingSecretSchema>;

// Sign-up grants (operator decision 2026-10-18, NEW_ACCOUNT option B): the operator signs, with the Vault unlock key, the
// exact sites where agents may create new accounts, a daily cap and an expiry. The broker certifies the grant and, on each
// use, checks the site, the day's count and the expiry, generates the password itself and seals it to the inbox key.
export const VAULT_SIGNUP_GRANT_LIMITS = { defaultDailyCap: 3, maxDailyCap: 10, defaultDays: 30, maxDays: 90, maxSites: 20 } as const;

/** A sign-up site: https, an exact host on the default port, no path, wildcard, IP address or punycode name. */
export function vaultSignupSite(input: string): string | null {
  const parsed = canonicalVaultOrigin(input);
  if (!parsed || parsed.warnings.length > 0 || !parsed.origin.startsWith("https://") || new URL(parsed.origin).port) return null;
  return parsed.origin;
}

/**
 * Where a login fills (operator request 2026-10-30, gsis.gr): its exact origins, or a clean https site (no port, IP or punycode)
 * whose registrable domain (private suffixes kept, so foo.github.io never covers bar.github.io) is a clean https origin's of the item.
 */
export function vaultOriginCovers(origins: readonly string[], target: string): boolean {
  if (origins.includes(target)) return true;
  const domain = (site: string) => vaultSignupSite(site) === site ? getDomain(new URL(site).hostname, { allowPrivateDomains: true }) : null;
  const wanted = domain(target);
  return wanted !== null && origins.some((origin) => domain(origin) === wanted);
}
const signupSites =z.array(z.string().max(300).refine((value) => vaultSignupSite(value) === value, "Not an exact https site."))
  .min(1).max(VAULT_SIGNUP_GRANT_LIMITS.maxSites).refine(...noRepeatedValues("Duplicate site."));
const dailyCap = z.number().int().min(1).max(VAULT_SIGNUP_GRANT_LIMITS.maxDailyCap);

export const vaultSignupGrantClaimsSchema = z.object({
  v: z.literal(1), kind: z.literal("SIGNUP_GRANT"), grantId: vaultSignupGrantIdSchema, ownerUserId: ownerSchema, vaultId: vaultIdSchema,
  sites: signupSites, dailyCap, unlockEpoch: z.number().int().min(1), issuedAt: isoDate, expiresAt: isoDate
}).strict();
export const vaultSignupGrantCertificateSchema = signed(vaultSignupGrantClaimsSchema);
export type VaultSignupGrantClaims = z.infer<typeof vaultSignupGrantClaimsSchema>;

/** What the dock sends: the grant and the unlock key's signature over vaultSignupGrantOperatorMessage. */
export const vaultSignupGrantRequestSchema = z.object({
  grantId: vaultSignupGrantIdSchema, sites: signupSites, dailyCap, unlockEpoch: z.number().int().min(1), expiresAt: isoDate, operatorSignature: b64url(86, 86)
}).strict();
export type VaultSignupGrantRequest = z.infer<typeof vaultSignupGrantRequestSchema>;

export function vaultSignupGrantOperatorMessage(input: {
  ownerUserId: string; vaultId: string; grantId: string; sites: string[]; dailyCap: number; unlockEpoch: number; expiresAt: string;
}): Uint8Array {
  return new TextEncoder().encode(vaultCanonicalJson({ v: 1, kind: "space-vault-signup-grant", ownerUserId: input.ownerUserId, vaultId: input.vaultId,
    grantId: input.grantId, sites: [...input.sites].sort(), dailyCap: input.dailyCap, unlockEpoch: input.unlockEpoch, expiresAt: input.expiresAt }));
}

/** A stored grant as the dock lists it. */
export const vaultSignupGrantSchema = z.object({
  id: vaultSignupGrantIdSchema, sites: z.array(z.string().max(300)), dailyCap, createdAt: isoDate, expiresAt: isoDate, revokedAt: isoDate.nullable()
}).strict();
export type VaultSignupGrant = z.infer<typeof vaultSignupGrantSchema>;
