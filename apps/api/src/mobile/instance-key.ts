import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mobileInstanceFingerprint, noiseKeyPair, signMobileRotation, vaultBase64url, type MobileRotationStatement } from "@space/contracts";
import type { MobileInstanceKeyRecord, MobileInstanceKeyRepository } from "@space/db";
import { connectorSealContext, type ConnectorCrypto } from "../dot-connectors.js";

// The installation's mobile channel keys (plan clipboard:kTV3y2lwO-99 phase 1b, ADR-013 §2, design §1): a Noise static key (X25519) and
// an identity key (Ed25519), made only when a person sets up Settings > Mobile app, sealed with the connector key. The private halves
// leave this module only to the channel (1b-5); no answer, log or audit row carries them.

export interface MobileInstanceKeyPair { noise: { privateKey: Uint8Array; publicKey: Uint8Array }; identity: { privateKey: Uint8Array; publicKey: Uint8Array } }
export interface MobileInstanceStatus {
  configured: boolean;
  fingerprint?: string;
  createdAt?: string;
  /** Older pairs still answering devices that have not reconnected since a routine rotation. */
  retiring?: Array<{ fingerprint: string; until: string }>;
}

const b64 = vaultBase64url;
const fingerprintOf = (row: Pick<MobileInstanceKeyRecord, "noisePublic" | "identityPublic">) => mobileInstanceFingerprint(b64.decode(row.noisePublic), b64.decode(row.identityPublic));
const sealContext = (id: string) => connectorSealContext("mobile-instance-key", "instance", id);

function newKeys() {
  const noise = noiseKeyPair();
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as { d: string; x: string };
  return { id: `mobkey:${randomBytes(12).toString("base64url")}`, noise, identity: { privateKey: b64.decode(jwk.d), publicKey: b64.decode(jwk.x) } };
}

export function createMobileInstanceKeys(options: { repository: MobileInstanceKeyRepository; crypto: ConnectorCrypto; now?: () => number }) {
  const now = options.now ?? Date.now;
  const seal = (keys: ReturnType<typeof newKeys>) => ({
    id: keys.id, noisePublic: b64.encode(keys.noise.publicKey), identityPublic: b64.encode(keys.identity.publicKey),
    sealedPrivate: options.crypto.seal(JSON.stringify({ noise: b64.encode(keys.noise.privateKey), identity: b64.encode(keys.identity.privateKey) }), sealContext(keys.id))
  });
  /** The channel's view of a stored pair (1b-5). Throws when the connector key cannot open it (another key, or a restore without it). */
  function open(row: MobileInstanceKeyRecord): MobileInstanceKeyPair {
    const sealed = JSON.parse(options.crypto.open(row.sealedPrivate, sealContext(row.id))) as { noise: string; identity: string };
    return { noise: { privateKey: b64.decode(sealed.noise), publicKey: b64.decode(row.noisePublic) }, identity: { privateKey: b64.decode(sealed.identity), publicKey: b64.decode(row.identityPublic) } };
  }
  return {
    open,
    async status(): Promise<MobileInstanceStatus> {
      const answering = await options.repository.answering(new Date(now()).toISOString());
      const active = answering.find((row) => row.status === "ACTIVE");
      if (!active) return { configured: false };
      return { configured: true, fingerprint: fingerprintOf(active), createdAt: active.createdAt,
        retiring: answering.filter((row) => row.status === "RETIRING").map((row) => ({ fingerprint: fingerprintOf(row), until: row.retiringUntil! })) };
    },
    /** Settings > Mobile app's first set-up; idempotent. `created` says whether this call made the keys. */
    async setUp(): Promise<{ created: boolean; fingerprint: string }> {
      const active = await options.repository.active();
      if (active) return { created: false, fingerprint: fingerprintOf(active) };
      return { created: true, fingerprint: fingerprintOf(await options.repository.create(seal(newKeys()))) };
    },
    /**
     * Routine: the new pair carries a statement signed by the old identity key, and the old pair answers 30 days more. Compromised
     * (security review P2-4): no statement (a stolen identity key could sign one), every older pair retires now, every device pairs again.
     */
    async rotate(compromised: boolean): Promise<{ oldFingerprint: string; fingerprint: string }> {
      const active = await options.repository.active();
      if (!active) throw Object.assign(new Error("Set up the mobile app first."), { statusCode: 409 });
      const next = newKeys(), at = new Date(now()).toISOString();
      let rotationStatement: string | null = null;
      if (!compromised) {
        const statement: MobileRotationStatement = { v: 1, oldFp: fingerprintOf(active), newIS: b64.encode(next.noise.publicKey), newII: b64.encode(next.identity.publicKey), at };
        rotationStatement = JSON.stringify({ statement, signature: signMobileRotation(statement, open(active).identity.privateKey) });
      }
      const row = await options.repository.rotate({ ...seal(next), rotationStatement, compromised, nowIso: at });
      return { oldFingerprint: fingerprintOf(active), fingerprint: fingerprintOf(row) };
    }
  };
}
export type MobileInstanceKeys = ReturnType<typeof createMobileInstanceKeys>;
