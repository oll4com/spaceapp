import { createHash, X509Certificate, type KeyObject } from "node:crypto";
import type { AppDeviceSessionRecord, AppDeviceSessionRepository } from "@space/db";

// The decide key's Android Key Attestation (plan clipboard:kTV3y2lwO-99 phase 1b, ADR-013 §3, Nous Pro security review P2-6): a phone gets
// `decide` only for a P-256 signing key that a TEE or StrongBox made for our own app, bound to biometrics on every use and to this pairing.
// Schema and roots from source.android.com/docs/security/features/keystore/attestation and developer.android.com
// /privacy-and-security/security-key-attestation (read 31/10/2026). Google's status list of revoked and suspended attestation certificates
// (android.googleapis.com/attestation/status, lowercase hex serials) is read at most daily; with no list known, decide is refused. A paired
// phone keeps its chain's serials, so a key Google revokes or suspends later loses decide at the next re-check (recheckDecideKeys, C6).

/** SHA-256 of the SPKI of Google's two hardware attestation roots: the RSA 4096 root (four certificates share it) and Key Attestation CA1 (P-384, 2025). */
export const GOOGLE_ATTESTATION_ROOT_KEYS = new Set([
  "feb2ea7551ee316ed4bb443c8293b884dbfdea40b603ee3e4f4a897e4580fbae",
  "3ee44512a1af2beb39c889490c60ea3f82e43f5d5a5532f5ab9419f676cd07ec"
]);
/** Our apps' release signing certificates (scripts/space-app-studio-build.mjs RELEASE_KEYS): only these packages may hold a decide key. */
export const MOBILE_APP_SIGNERS: Readonly<Record<string, string>> = {
  "com.oll4.spaceapp.nous": "fd4581c014540252394c80a0584404b02846d2379562aafd1e3e3c9fe314beb6",
  "com.oll4.spaceapp": "3a05ad527f584885b0a20f622c4dbbda912cd5d590a33de28a59c7d250b7192e"
};

const ATTESTATION_OID = "1.3.6.1.4.1.11129.2.1.17";
export const ATTESTATION_STATUS_URL = "https://android.googleapis.com/attestation/status";
const STATUS_TTL_MS = 24 * 3600_000, STATUS_STALE_MS = 7 * 24 * 3600_000;
const serialKey = (hex: string) => hex.toLowerCase().replace(/^0+(?=.)/, "");

/** Google's attestation status list, fetched at most once a day; a failed fetch keeps the last list for 7 days, then none is known (null). */
export function createAttestationStatusList(options: { fetch?: typeof fetch; now?: () => number } = {}) {
  const get: typeof fetch = (url, init) => (options.fetch ?? fetch)(url, init), now = options.now ?? (() => Date.now());
  let list: { serials: Set<string>; at: number } | null = null;
  let pending: Promise<void> | null = null;
  async function refresh() {
    const response = await get(ATTESTATION_STATUS_URL, { signal: AbortSignal.timeout(5_000) });
    const body = response.ok ? await response.json() as { entries?: unknown } : null;
    if (!body?.entries || typeof body.entries !== "object") throw new Error("No attestation status list.");
    list = { serials: new Set(Object.keys(body.entries).map(serialKey)), at: now() };
  }
  return {
    async revoked(): Promise<ReadonlySet<string> | null> {
      if (!list || now() - list.at > STATUS_TTL_MS) await (pending ??= refresh().catch(() => undefined).finally(() => { pending = null; }));
      return list && now() - list.at <= STATUS_STALE_MS ? list.serials : null;
    }
  };
}
export type AttestationStatusList = ReturnType<typeof createAttestationStatusList>;
/** A chain's certificate serials as the status list keys them: kept with a decide key, so a later revocation reaches it (C6). */
export const attestationSerials = (chain: readonly string[]) => chain.map((der) => serialKey(new X509Certificate(Buffer.from(der, "base64url")).serialNumber));

/**
 * C6 (internal MASVS review 1/11): every live paired phone whose kept decide chain is now on Google's status list loses decide (it keeps read and
 * act). No list known changes nothing: a pairing refuses decide then, and a phone's working decide is not dropped for Google's outage. The list is
 * read only when some phone has serials to check; phones paired before the serials were kept (migration 0281) are not re-checked.
 */
export async function recheckDecideKeys(input: { devices: Pick<AppDeviceSessionRepository, "livePaired" | "dropDecide">;
  status: Pick<AttestationStatusList, "revoked">; nowIso: string }): Promise<AppDeviceSessionRecord[]> {
  const phones = (await input.devices.livePaired(null, input.nowIso)).filter((row) => row.decideSerials?.length);
  const revoked = phones.length ? await input.status.revoked() : null;
  const dropped: AppDeviceSessionRecord[] = [];
  for (const row of phones) {
    const next = revoked && row.decideSerials!.some((serial) => revoked.has(serial)) ? await input.devices.dropDecide(row.id) : null;
    if (next) dropped.push(next);
  }
  return dropped;
}
const KM_PURPOSE_SIGN = 2, KM_ALGORITHM_EC = 3, KM_EC_CURVE_P256 = 1, KM_AUTH_FINGERPRINT = 2;

interface Tlv { cls: number; constructed: boolean; tag: number; value: Buffer; end: number }
function readTlv(buffer: Buffer, at: number): Tlv {
  const first = buffer[at]!;
  let tag = first & 0x1f, pos = at + 1;
  if (tag === 0x1f) { tag = 0; let byte; do { byte = buffer[pos++]!; tag = (tag << 7) | (byte & 0x7f); } while (byte & 0x80); }
  let length = buffer[pos++]!;
  if (length & 0x80) { const count = length & 0x7f; if (count > 4) throw Error("DER length"); length = 0; for (let n = 0; n < count; n++) length = length * 256 + buffer[pos++]!; }
  if (pos + length > buffer.length) throw Error("DER truncated");
  return { cls: first >> 6, constructed: Boolean(first & 0x20), tag, value: buffer.subarray(pos, pos + length), end: pos + length };
}
const children = (value: Buffer) => { const out: Tlv[] = []; for (let at = 0; at < value.length;) { const tlv = readTlv(value, at); out.push(tlv); at = tlv.end; } return out; };
const integer = (tlv: Tlv) => { if (tlv.value.length > 6) throw Error("DER integer"); return tlv.value.reduce((sum, byte) => sum * 256 + byte, 0); };
const oid = (value: Buffer) => {
  const parts = [Math.floor(value[0]! / 40), value[0]! % 40];
  for (let at = 1, part = 0; at < value.length; at++) { part = part * 128 + (value[at]! & 0x7f); if (!(value[at]! & 0x80)) { parts.push(part); part = 0; } }
  return parts.join(".");
};

/** The attestation extension's value (the DER of KeyDescription), or null. */
function attestationExtension(cert: X509Certificate): Buffer | null {
  const tbs = children(readTlv(cert.raw, 0).value)[0]!;
  const extensions = children(tbs.value).find((tlv) => tlv.cls === 2 && tlv.tag === 3);
  if (!extensions) return null;
  for (const extension of children(children(extensions.value)[0]!.value)) {
    const parts = children(extension.value);
    if (oid(parts[0]!.value) === ATTESTATION_OID) return parts.at(-1)!.value;
  }
  return null;
}
/** An AuthorizationList as tag → the EXPLICIT inner value. */
const authorizations = (list: Tlv) => new Map(children(list.value).map((entry) => [entry.tag, readTlv(entry.value, 0)]));
const spkiSha256 = (key: KeyObject) => createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");

export type DecideKeyAttestation = { ok: true; securityLevel: "TRUSTED_ENVIRONMENT" | "STRONGBOX"; packageName: string } | { ok: false; reason: string };

/**
 * Checks the chain (leaf first, DER as base64url) for the decide key `decidePublicSpki` (DER, base64url): every certificate valid now and
 * signed by the next, the last one a pinned Google root; the leaf's key is the decide key; the attestation names the pairing's `challenge`,
 * a TEE or StrongBox, a P-256 signing key that needs a biometric on every use, one of `signers`' packages with its signing digest, and a
 * locked phone with a verified boot (C6).
 */
export function verifyDecideKeyAttestation(input: {
  chain: readonly string[]; decidePublicSpki: string; challenge: Uint8Array; now?: Date;
  /** Google's revoked and suspended certificate serials (createAttestationStatusList); null when none is known, which refuses. */
  revoked: ReadonlySet<string> | null;
  roots?: ReadonlySet<string>; signers?: Readonly<Record<string, string>>;
}): DecideKeyAttestation {
  const refuse = (reason: string): DecideKeyAttestation => ({ ok: false, reason });
  try {
    if (input.chain.length < 2 || input.chain.length > 8) return refuse("CHAIN_LENGTH");
    const certs = input.chain.map((der) => new X509Certificate(Buffer.from(der, "base64url")));
    const now = input.now ?? new Date();
    for (const [index, cert] of certs.entries()) {
      if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) return refuse("CERT_TIME");
      // Above the leaf only CAs without an attestation extension (C1, internal review 1/11): any app's genuine attested key can sign a
      // "leaf" carrying a copied KeyDescription, so a chain whose issuer is itself a key certificate proves nothing.
      if (index > 0 && !cert.ca) return refuse("CHAIN_NOT_CA");
      if (index > 0 && attestationExtension(cert)) return refuse("ATTESTATION_NOT_LEAF");
      const issuer = certs[index + 1] ?? cert;
      if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) return refuse("CHAIN_SIGNATURE");
    }
    if (!(input.roots ?? GOOGLE_ATTESTATION_ROOT_KEYS).has(spkiSha256(certs.at(-1)!.publicKey))) return refuse("ROOT_UNKNOWN");
    if (!input.revoked) return refuse("STATUS_UNAVAILABLE");
    if (certs.some((cert) => input.revoked!.has(serialKey(cert.serialNumber)))) return refuse("REVOKED");
    const leaf = certs[0]!;
    if (!leaf.publicKey.export({ type: "spki", format: "der" }).equals(Buffer.from(input.decidePublicSpki, "base64url"))) return refuse("KEY_MISMATCH");
    const extension = attestationExtension(leaf);
    if (!extension) return refuse("NO_ATTESTATION");
    const [, attestationLevel, , keyMintLevel, challenge, , software, hardware] = children(readTlv(extension, 0).value);
    const level = integer(attestationLevel!);
    if (level < 1 || level > 2 || integer(keyMintLevel!) !== level) return refuse("SECURITY_LEVEL");
    if (!challenge!.value.equals(Buffer.from(input.challenge))) return refuse("CHALLENGE");
    const enforced = authorizations(hardware!);
    if (!children(enforced.get(1)?.value ?? Buffer.alloc(0)).some((purpose) => integer(purpose) === KM_PURPOSE_SIGN)) return refuse("PURPOSE");
    if (enforced.get(2) === undefined || integer(enforced.get(2)!) !== KM_ALGORITHM_EC || enforced.get(10) === undefined || integer(enforced.get(10)!) !== KM_EC_CURVE_P256) return refuse("ALGORITHM");
    // A biometric on every use: no noAuthRequired, the fingerprint authenticator, and no time window.
    if (enforced.has(503) || !enforced.get(504) || !(integer(enforced.get(504)!) & KM_AUTH_FINGERPRINT) || (enforced.get(505) && integer(enforced.get(505)!) !== 0)) return refuse("USER_AUTH");
    const applicationId = authorizations(software!).get(709) ?? enforced.get(709);
    if (!applicationId) return refuse("APPLICATION");
    const [packages, digests] = children(readTlv(applicationId.value, 0).value);
    const digestSet = new Set(children(digests!.value).map((digest) => digest.value.toString("hex")));
    const signers = input.signers ?? MOBILE_APP_SIGNERS;
    const packageName = children(packages!.value).map((info) => children(info.value)[0]!.value.toString("utf8")).find((name) => Object.hasOwn(signers, name) && digestSet.has(signers[name]!));
    if (!packageName) return refuse("APPLICATION");
    // C6 (internal review 1/11): a locked bootloader and a verified boot, Google's key or the owner's own (RootOfTrust, tag 704:
    // verifiedBootKey, deviceLocked, verifiedBootState 0 VERIFIED or 1 SELF_SIGNED); an unlocked phone's system can tell the TEE anything.
    const [, locked, bootState] = children(enforced.get(704)?.value ?? Buffer.alloc(0));
    if (!locked?.value[0] || !bootState || integer(bootState) > 1) return refuse("BOOT_STATE");
    return { ok: true, securityLevel: level === 2 ? "STRONGBOX" : "TRUSTED_ENVIRONMENT", packageName };
  } catch {
    return refuse("MALFORMED");
  }
}
