import { request } from "node:http";
import {
  vaultBase64url, vaultDelegationCertificateSchema, vaultSignupGrantCertificateSchema, vaultSymmetricEnvelopeSchema, vaultTransportEnvelopeSchema, vaultUseCapabilitySchema,
  verifyVaultCertificate, type VaultSymmetricEnvelope, type VaultTransportEnvelope
} from "@space/contracts";
import type { SealedFillBroker } from "./sealed-fill.js";
import { z } from "zod";
import { GitControlError } from "../source-control/errors.js";

// The API's side of the Vault fill broker (ADR-012): JSON over HTTP on the broker's unix socket, which only the API user
// may open. The API relays ciphertext only: the server share reaches the broker sealed to its transport key and returns
// sealed to the operator browser's reply key. Every failure is VAULT_BROKER_UNAVAILABLE; nothing falls back.

export const VAULT_BROKER_SOCKET_PATH = "/run/space-vault-broker/broker.sock";
/** The Browser Host's own broker socket (H2 Option A): only there does /v1/fill answer, sealed to the caller's reply key. */
export const VAULT_BROKER_HOST_SOCKET_PATH = "/run/space-vault-broker/host.sock";

// GitControlError is the API's generic coded error (the error handler answers its code and status).
export class VaultBrokerUnavailableError extends GitControlError {
  constructor() { super("VAULT_BROKER_UNAVAILABLE", "The Vault broker is not installed or not running; the operator's install step enables it.", 503); }
}

export class VaultBrokerRefusedError extends GitControlError {
  /** The broker's reason code (an upper-case word, never a value), for the audit and the agent's fixed status. */
  constructor(readonly reason = "REFUSED") { super("VAULT_BROKER_REFUSED", "The Vault broker refused the request.", 409); }
}

export interface VaultBroker {
  transportKey(): Promise<{ publicKey: string; keyVersion: number }>;
  /** The broker's audit chain, read only: times, ops, results and hashes of its newest entries (no ids, no values). */
  audit?(): Promise<{ head: string; total: number; entries: Array<{ at: string; op: string; result: string; hash: string }> }>;
  /** Broker opens the share sealed to its transport key and seals it under the ARK for this owner and vault. */
  sealServerShare(input: { ownerUserId: string; vaultId: string; keyVersion: number; sealedServerShare: VaultTransportEnvelope; unlockPublicKey: string }): Promise<VaultSymmetricEnvelope>;
  /**
   * Broker verifies the signed challenge against the enrolled key, then returns the server share sealed to the reply key
   * (sealToVaultPublicKey with scope {ownerUserId, vaultId, keyVersion: 1}).
   */
  /** The broker's Ed25519 key that signs delegation and use certificates (SPKI, base64url). */
  delegationKey(): Promise<{ publicKey: string; keyVersion: number }>;
  /**
   * Broker opens the fill key sealed to its transport key, wraps it under the ARK-derived key of the next generation and
   * signs the delegation certificate. The API verifies that signature itself before storing anything.
   */
  delegate(input: {
    ownerUserId: string; vaultId: string; generation: number; unlockEpoch: number; envelopeDigest: string; expiresAt: string;
    items: Array<{ handle: string; origins: string[]; fields: string[]; approvalMode: string; submit: boolean }>; sealedFillKey: VaultTransportEnvelope;
    /** The operator's unlock-key signature over the delegation, and what pins that key (the vault's server share). */
    operatorSignature: string; unlockPublicKey: string; serverShareEnvelope: VaultSymmetricEnvelope;
    /** The inbox's private key sealed to the transport key; the answer then carries it wrapped for this generation. */
    sealedInboxKey?: VaultTransportEnvelope;
  }): Promise<{ certificate: unknown; keyEnvelope: VaultSymmetricEnvelope; inboxKeyEnvelope?: VaultSymmetricEnvelope }>;
  /**
   * A login agents saved, created or changed joins the active delegation without an unlock: the broker opens the inbox entry,
   * seals its fields under the delegation's fill key and signs the extended certificate (same generation).
   */
  delegatePending(input: {
    ownerUserId: string; vaultId: string; certificate: unknown; keyEnvelope: VaultSymmetricEnvelope; inboxKeyEnvelope: VaultSymmetricEnvelope;
    entry: { handle: string; origin: string; sealedUsername: VaultTransportEnvelope | null; sealedPassword: VaultTransportEnvelope | null };
  }): Promise<{ certificate: z.infer<typeof vaultDelegationCertificateSchema>; fieldEnvelopes: Partial<Record<"USERNAME" | "PASSWORD", VaultSymmetricEnvelope>> }>;
  /**
   * One fill: the broker checks the delegation and generation, records a one-time nonce and signs a use capability bound to
   * this pane's live target, frame and exact origin (as the Browser Host reported them).
   */
  issueUse(input: {
    ownerUserId: string; vaultId: string; certificate: unknown; epoch: number; handle: string; fields: string[]; submit: boolean; paneId: string;
    targetId: string; pageId: string; frameId: string; origin: string; generate?: { roles: string[]; inboxPublicKey: string };
  }): Promise<{ capability: unknown }>;
  /** Browser Host only: consumes the capability's nonce once and returns the fields sealed to the host's reply key. */
  openFill(input: { capability: unknown; keyEnvelope: unknown; fieldEnvelopes: unknown; replyPublicKey: string }): Promise<VaultTransportEnvelope>;
  /** Raises the vault's lowest valid delegation generation: every older certificate and capability stops working. */
  revoke(input: { ownerUserId: string; vaultId: string; generation: number }): Promise<{ generation: number }>;
  unlock(input: {
    ownerUserId: string; vaultId: string; epoch: number; challenge: string; replyPublicKey: string; signature: string;
    unlockPublicKey: string; serverShareEnvelope: VaultSymmetricEnvelope;
  }): Promise<VaultTransportEnvelope>;
  /** Certifies a sign-up grant the operator's unlock key signed (sites, daily cap, expiry). */
  signupGrant(input: {
    ownerUserId: string; vaultId: string; grantId: string; sites: string[]; dailyCap: number; unlockEpoch: number; expiresAt: string;
    operatorSignature: string; unlockPublicKey: string; serverShareEnvelope: VaultSymmetricEnvelope;
  }): Promise<{ certificate: unknown }>;
  /** NEW_ACCOUNT under a grant: a generated password sealed to the inbox key and, for the fill, to the reply key. */
  signup(input: {
    ownerUserId: string; vaultId: string; certificate: unknown; origin: string; paneId: string; roles: Array<"NEW_PASSWORD" | "CONFIRM_PASSWORD">;
    inboxPublicKey: string; replyPublicKey: string; field?: { minLength: number | null; maxLength: number | null };
  }): Promise<{ sealedPassword: VaultTransportEnvelope; sealedFields: VaultTransportEnvelope }>;
  signupRevoke(input: { ownerUserId: string; vaultId: string; grantId: string }): Promise<{ revoked: true }>;
  /** A one-site, one-use sign-up grant minted under the active delegation, for a site the operator signed no grant for. */
  signupAutoGrant(input: { ownerUserId: string; vaultId: string; certificate: unknown; origin: string }): Promise<{ certificate: z.infer<typeof vaultSignupGrantCertificateSchema> }>;
}

const transportKeySchema = z.object({ publicKey: z.string().regex(/^[A-Za-z0-9_-]{40,80}$/), keyVersion: z.number().int().min(1) }).strict();

function call<T>(socketPath: string, method: "GET" | "POST", path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request({ socketPath, method, path, timeout: 5_000, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { if (text.length < 64_000) text += chunk; });
      response.on("end", () => {
        // A refusal (bad signature, consumed challenge) names no broker detail to the caller.
        if (response.statusCode === 400 || response.statusCode === 403) {
          let reason: unknown;
          try { reason = (JSON.parse(text) as { error?: unknown }).error; } catch { /* no reason */ }
          return reject(new VaultBrokerRefusedError(typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(reason) ? reason : undefined));
        }
        if (response.statusCode !== 200) return reject(new VaultBrokerUnavailableError());
        try { resolve(schema.parse(JSON.parse(text))); } catch { reject(new VaultBrokerUnavailableError()); }
      });
    });
    outgoing.on("timeout", () => outgoing.destroy());
    outgoing.on("error", () => reject(new VaultBrokerUnavailableError()));
    outgoing.end(payload);
  });
}

export function createSocketVaultBroker(socketPath = VAULT_BROKER_SOCKET_PATH): VaultBroker {
  return {
    transportKey: () => call(socketPath, "GET", "/v1/transport-key", undefined, transportKeySchema),
    audit: () => call(socketPath, "GET", "/v1/audit", undefined, z.object({ head: z.string().regex(/^[0-9a-f]{64}$/), total: z.number().int().min(0),
      entries: z.array(z.object({ at: z.string().max(40), op: z.string().max(40), result: z.string().max(60), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).max(200) }).strict()),
    delegationKey: () => call(socketPath, "GET", "/v1/delegation-key", undefined, z.object({ publicKey: z.string().regex(/^[A-Za-z0-9_-]{40,120}$/), keyVersion: z.number().int().min(1) }).strict()),
    issueUse: (input) => call(socketPath, "POST", "/v1/use", input, z.object({ capability: vaultUseCapabilitySchema }).strict()),
    openFill: (input) => call(socketPath, "POST", "/v1/fill", input, z.object({ sealedFields: vaultTransportEnvelopeSchema }).strict()).then((answer) => answer.sealedFields),
    revoke: (input) => call(socketPath, "POST", "/v1/revoke", input, z.object({ generation: z.number().int() }).strict()),
    delegate: (input) => call(socketPath, "POST", "/v1/delegate", input, z.object({ certificate: vaultDelegationCertificateSchema, keyEnvelope: vaultSymmetricEnvelopeSchema,
      inboxKeyEnvelope: vaultSymmetricEnvelopeSchema.optional() }).strict()),
    delegatePending: (input) => call(socketPath, "POST", "/v1/delegate-pending", input, z.object({ certificate: vaultDelegationCertificateSchema,
      fieldEnvelopes: z.object({ USERNAME: vaultSymmetricEnvelopeSchema.optional(), PASSWORD: vaultSymmetricEnvelopeSchema.optional() }).strict() }).strict()),
    sealServerShare: (input) => call(socketPath, "POST", "/v1/server-share", input, z.object({ serverShareEnvelope: vaultSymmetricEnvelopeSchema }).strict())
      .then((answer) => answer.serverShareEnvelope),
    unlock: (input) => call(socketPath, "POST", "/v1/unlock", input, z.object({ sealedServerShare: vaultTransportEnvelopeSchema }).strict())
      .then((answer) => answer.sealedServerShare),
    signupGrant: (input) => call(socketPath, "POST", "/v1/signup-grant", input, z.object({ certificate: vaultSignupGrantCertificateSchema }).strict()),
    signup: (input) => call(socketPath, "POST", "/v1/signup", input, z.object({ sealedPassword: vaultTransportEnvelopeSchema, sealedFields: vaultTransportEnvelopeSchema }).strict()),
    signupRevoke: (input) => call(socketPath, "POST", "/v1/signup-revoke", input, z.object({ revoked: z.literal(true) }).strict()),
    signupAutoGrant: (input) => call(socketPath, "POST", "/v1/signup-auto-grant", input, z.object({ certificate: vaultSignupGrantCertificateSchema }).strict())
  };
}

/** The Browser Host's view of the broker: it verifies capabilities with the broker's own key before asking for any value. */
export function sealedFillBroker(broker: VaultBroker): SealedFillBroker {
  return {
    async verifyUse(capability, now) {
      const key = await broker.delegationKey();
      return verifyVaultCertificate(vaultBase64url.decode(key.publicKey), capability, vaultUseCapabilitySchema, now);
    },
    openFill: (input) => broker.openFill(input),
    signup: (input) => broker.signup(input)
  };
}
