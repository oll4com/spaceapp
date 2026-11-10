import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { InMemoryAppDeviceSessionRepository } from "@space/db";
import { describe, expect, it } from "vitest";
import {
  ATTESTATION_STATUS_URL, GOOGLE_ATTESTATION_ROOT_KEYS, MOBILE_APP_SIGNERS, attestationSerials, createAttestationStatusList, recheckDecideKeys, verifyDecideKeyAttestation
} from "../src/mobile/attestation.js";

// Nous Pro 1b-3c (ADR-013 §3, security review P2-6): the decide key's Android Key Attestation. The fixture's chains were made once with
// openssl (a test root and one leaf per variant whose attestation extension was DER-encoded by a separate encoder, gen.py in
// ~/agent-workspace/active/20261031-nous-pro/attestation/gen); the test pins that root instead of Google's.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/mobile-attestation-chains.json", import.meta.url), "utf8")) as {
  challengeHex: string; rootSpkiSha256: string; variants: Record<string, { chain: string[]; decidePublicSpki: string }>;
};
const challenge = Uint8Array.from(Buffer.from(fixture.challengeHex, "hex"));
const roots = new Set([fixture.rootSpkiSha256]);
const check = (name: string, patch: Partial<Parameters<typeof verifyDecideKeyAttestation>[0]> = {}) =>
  verifyDecideKeyAttestation({ ...fixture.variants[name]!, challenge, roots, revoked: new Set<string>(), ...patch });

describe("decide key attestation", () => {
  it("accepts a TEE or StrongBox P-256 signing key of our app that needs a biometric on every use", () => {
    expect(check("tee")).toEqual({ ok: true, securityLevel: "TRUSTED_ENVIRONMENT", packageName: "com.oll4.spaceapp.nous" });
    expect(check("strongbox")).toEqual({ ok: true, securityLevel: "STRONGBOX", packageName: "com.oll4.spaceapp.nous" });
  });

  it("refuses software keys, other uses, keys without a per-use biometric, other apps and other signers", () => {
    expect(check("software")).toEqual({ ok: false, reason: "SECURITY_LEVEL" });
    expect(check("verifyOnly")).toEqual({ ok: false, reason: "PURPOSE" });
    expect(check("noAuth")).toEqual({ ok: false, reason: "USER_AUTH" });
    expect(check("password")).toEqual({ ok: false, reason: "USER_AUTH" });
    expect(check("timeout")).toEqual({ ok: false, reason: "USER_AUTH" });
    expect(check("otherApp")).toEqual({ ok: false, reason: "APPLICATION" });
    expect(check("wrongDigest")).toEqual({ ok: false, reason: "APPLICATION" });
  });

  it("binds the key, the pairing's challenge, the pinned root and the chain's signatures and dates", () => {
    expect(check("tee", { decidePublicSpki: fixture.variants.strongbox!.decidePublicSpki })).toEqual({ ok: false, reason: "KEY_MISMATCH" });
    expect(check("tee", { challenge: new Uint8Array(32) })).toEqual({ ok: false, reason: "CHALLENGE" });
    expect(check("tee", { roots: GOOGLE_ATTESTATION_ROOT_KEYS })).toEqual({ ok: false, reason: "ROOT_UNKNOWN" });
    expect(check("tee", { chain: [fixture.variants.tee!.chain[0]!, fixture.variants.strongbox!.chain[0]!] })).toEqual({ ok: false, reason: "CHAIN_SIGNATURE" });
    expect(check("tee", { now: new Date("2020-01-01T00:00:00Z") })).toEqual({ ok: false, reason: "CERT_TIME" });
    expect(check("tee", { signers: { "com.oll4.spaceapp": MOBILE_APP_SIGNERS["com.oll4.spaceapp"]! } })).toEqual({ ok: false, reason: "APPLICATION" });
    expect(check("tee", { chain: [fixture.variants.tee!.chain[0]!] })).toEqual({ ok: false, reason: "CHAIN_LENGTH" });
    expect(check("tee", { chain: ["bm90LWEtY2VydA", fixture.variants.tee!.chain[1]!] })).toEqual({ ok: false, reason: "MALFORMED" });
  });

  // C1 (internal MASVS review 1/11, ~/agent-workspace/active/20261102-nous-pro-security/attestation-gen/gen-c1.sh): any app's genuine
  // attested key can sign a "leaf" with a copied KeyDescription, so every issuer must be a CA and only the leaf may carry the extension.
  it("refuses a leaf signed by another leaf and an attestation extension above the leaf; accepts an intermediate CA", () => {
    expect(check("forgedUnderLeaf")).toEqual({ ok: false, reason: "CHAIN_NOT_CA" });
    expect(check("extensionOnCa")).toEqual({ ok: false, reason: "ATTESTATION_NOT_LEAF" });
    expect(check("intermediate")).toEqual({ ok: true, securityLevel: "TRUSTED_ENVIRONMENT", packageName: "com.oll4.spaceapp.nous" });
  });

  // C6 (internal MASVS review 1/11, attestation-gen-c6/gen-c6.py): a phone with an unlocked bootloader or an unverified boot can be told
  // anything by its own system, so decide needs a locked device whose boot was verified (Google's key or the owner's own, self-signed).
  it("needs a locked bootloader and a verified boot (RootOfTrust)", () => {
    expect(check("selfSigned")).toEqual({ ok: true, securityLevel: "TRUSTED_ENVIRONMENT", packageName: "com.oll4.spaceapp.nous" });
    expect(check("unlocked")).toEqual({ ok: false, reason: "BOOT_STATE" });
    expect(check("unverified")).toEqual({ ok: false, reason: "BOOT_STATE" });
    expect(check("noRootOfTrust")).toEqual({ ok: false, reason: "BOOT_STATE" });
  });

  it("pins Google's two attestation root keys and our two apps' release signers", () => {
    expect([...GOOGLE_ATTESTATION_ROOT_KEYS].every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
    expect(GOOGLE_ATTESTATION_ROOT_KEYS.size).toBe(2);
    expect(Object.keys(MOBILE_APP_SIGNERS).sort()).toEqual(["com.oll4.spaceapp", "com.oll4.spaceapp.nous"]);
  });

  it("refuses a chain with a certificate on Google's status list, and refuses when no list is known", () => {
    const leaf = new X509Certificate(Buffer.from(fixture.variants.tee!.chain[0]!, "base64url"));
    // The list writes serials in lowercase hex without leading zeros; Node gives them in uppercase.
    const listed = leaf.serialNumber.toLowerCase().replace(/^0+(?=.)/, "");
    expect(check("tee", { revoked: new Set([listed]) })).toEqual({ ok: false, reason: "REVOKED" });
    expect(check("tee", { revoked: null })).toEqual({ ok: false, reason: "STATUS_UNAVAILABLE" });
  });
});

describe("Google's attestation status list", () => {
  it("reads the serials at most daily, keeps the last list through a failed fetch for 7 days, then knows none", async () => {
    let clock = 0, answer: Response | Error = Response.json({ entries: { "0abc": { status: "REVOKED", reason: "KEY_COMPROMISE" }, "1f4363f4": { status: "SUSPENDED" } } });
    const urls: string[] = [];
    const list = createAttestationStatusList({ now: () => clock, fetch: (async (url: string) => { urls.push(url); if (answer instanceof Error) throw answer; return answer; }) as typeof fetch });
    expect([...(await list.revoked())!]).toEqual(["abc", "1f4363f4"]);
    expect(urls).toEqual([ATTESTATION_STATUS_URL]);
    clock += 3600_000;
    await list.revoked();
    expect(urls).toHaveLength(1);
    answer = new Error("offline");
    clock += 25 * 3600_000;
    expect(await list.revoked()).not.toBeNull();
    expect(urls).toHaveLength(2);
    clock += 7 * 24 * 3600_000;
    expect(await list.revoked()).toBeNull();
    const none = createAttestationStatusList({ fetch: (async () => new Response("down", { status: 503 })) as typeof fetch });
    expect(await none.revoked()).toBeNull();
  });
});


// C6 (internal MASVS review, plan clipboard:kTV3y2lwO-99 step 7): Google may revoke or suspend an attestation key after a phone paired with it
// (a leaked keybox), so the decide chain's serials are kept and re-checked; a phone whose chain is listed keeps read and act, never decide.
describe("decide keys re-checked against the status list", () => {
  const nowIso = new Date().toISOString(), expiresAt = new Date(Date.now() + 86400_000).toISOString();
  async function phones() {
    const devices = new InMemoryAppDeviceSessionRepository();
    const paired = async (id: string, char: string, decideSerials: string[] | null) => {
      await devices.createPaired({ id, ownerUserId: "user:operator", app: "nous", deviceName: id, sidSha256: char.repeat(64), expiresAt, noisePublic: char.toUpperCase().repeat(43),
        decidePublicSpki: decideSerials ? "S".repeat(122) : null, decideSecurityLevel: decideSerials ? "STRONGBOX" : null, decideSerials,
        requestedScopes: decideSerials ? ["read", "act", "decide"] : ["read", "act"] });
      await devices.confirm("user:operator", id, nowIso);
    };
    await paired("appdev:listed01", "a", ["abc", "1f"]);
    await paired("appdev:clean001", "b", ["de", "ad"]);
    await paired("appdev:nodecide", "c", null);
    return devices;
  }

  it("keeps each chain's serials as the status list writes them", () => {
    const serials = attestationSerials(fixture.variants.tee!.chain);
    expect(serials).toHaveLength(fixture.variants.tee!.chain.length);
    expect(serials[0]).toBe(new X509Certificate(Buffer.from(fixture.variants.tee!.chain[0]!, "base64url")).serialNumber.toLowerCase().replace(/^0+(?=.)/, ""));
  });

  it("drops decide from a phone whose chain is now listed; no list known or no decide phone changes nothing", async () => {
    const devices = await phones();
    let reads = 0;
    const listing = (serials: string[] | null) => ({ revoked: async () => { reads += 1; return serials && new Set(serials); } });
    expect(await recheckDecideKeys({ devices, status: listing(null), nowIso })).toEqual([]);
    const dropped = await recheckDecideKeys({ devices, status: listing(["1f"]), nowIso });
    expect(dropped.map((row) => row.id)).toEqual(["appdev:listed01"]);
    const rows = await devices.list("user:operator");
    expect(rows.find((row) => row.id === "appdev:listed01")).toMatchObject({ scopes: ["read", "act"], decidePublicSpki: null, decideSerials: null, revokedAt: null });
    expect(rows.find((row) => row.id === "appdev:clean001")).toMatchObject({ scopes: ["read", "act", "decide"], decideSerials: ["de", "ad"] });
    // With no decide key left to check, the list is not read at all.
    await devices.dropDecide("appdev:clean001");
    reads = 0;
    expect(await recheckDecideKeys({ devices, status: listing(["de"]), nowIso })).toEqual([]);
    expect(reads).toBe(0);
  });
});
