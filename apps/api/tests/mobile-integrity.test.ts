import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOBILE_APP_SIGNERS } from "../src/mobile/attestation.js";
import { createPlayIntegrity, playIntegrityProblem } from "../src/mobile/integrity.js";

// MASVS L2 RESILIENCE (plan clipboard:kTV3y2lwO-99 step 7): Google's Play Integrity verdict, decoded on Google's server, must name our
// Play-recognized app with our signer on a device that meets integrity, for exactly this request, within 5 minutes. Nothing leaves the test.
const now = Date.UTC(2026, 10, 2, 12);
const packageName = "com.oll4.spaceapp.nous";
const requestHash = "h".repeat(43);
const verdict = (patch: { requestDetails?: object; appIntegrity?: object; deviceIntegrity?: object } = {}) => ({
  requestDetails: { requestPackageName: packageName, requestHash, timestampMillis: String(now - 60_000), ...patch.requestDetails },
  appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName, certificateSha256Digest: [Buffer.from(MOBILE_APP_SIGNERS[packageName]!, "hex").toString("base64url")], ...patch.appIntegrity },
  deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"], ...patch.deviceIntegrity }
});

describe("the Play Integrity verdict", () => {
  const expected = { packageName, requestHash, now };
  it("passes our recognized app on a device meeting integrity, for this request", () => {
    expect(playIntegrityProblem(verdict(), expected)).toBeNull();
    expect(playIntegrityProblem(verdict({ deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY", "MEETS_STRONG_INTEGRITY"] } }), expected)).toBeNull();
  });
  it("refuses everything else, failing closed on a missing field", () => {
    expect(playIntegrityProblem(undefined, expected)).toBe("PACKAGE");
    expect(playIntegrityProblem(verdict({ requestDetails: { requestPackageName: "com.example" } }), expected)).toBe("PACKAGE");
    expect(playIntegrityProblem(verdict({ requestDetails: { requestHash: "x".repeat(43) } }), expected)).toBe("REQUEST_HASH");
    expect(playIntegrityProblem(verdict({ requestDetails: { timestampMillis: String(now - 6 * 60_000) } }), expected)).toBe("STALE");
    expect(playIntegrityProblem(verdict({ requestDetails: { timestampMillis: undefined } }), expected)).toBe("STALE");
    expect(playIntegrityProblem(verdict({ appIntegrity: { appRecognitionVerdict: "UNRECOGNIZED_VERSION" } }), expected)).toBe("APP_NOT_RECOGNIZED");
    expect(playIntegrityProblem(verdict({ appIntegrity: { certificateSha256Digest: [Buffer.alloc(32, 1).toString("base64url")] } }), expected)).toBe("SIGNER");
    expect(playIntegrityProblem(verdict({ deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"] } }), expected)).toBe("DEVICE");
    expect(playIntegrityProblem(verdict({ deviceIntegrity: { deviceRecognitionVerdict: undefined } }), expected)).toBe("DEVICE");
  });
});

describe("the checker", () => {
  let dir = "", keyFile = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "play-integrity-"));
    keyFile = join(dir, "service-account.json");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(keyFile, JSON.stringify({ type: "service_account", project_id: "test", client_email: "pi@test.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  const google = (decode: () => Response) => {
    const calls: Array<{ url: string; body: string; authorization?: string }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), authorization: (init.headers as Record<string, string>).authorization });
      return url === "https://oauth2.googleapis.com/token" ? Response.json({ access_token: "at-1", expires_in: 3600 }) : decode();
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  };

  it("is off without a service account file", () => {
    expect(createPlayIntegrity(null)).toBeNull();
  });

  it("decodes the token on Google's server for the app's package and checks the verdict", async () => {
    const { calls, fetch } = google(() => Response.json({ tokenPayloadExternal: verdict() }));
    const integrity = createPlayIntegrity(keyFile, { fetch, now: () => now })!;
    expect(await integrity.verify({ token: "t.o.k.e.n", app: "nous", requestHash })).toEqual({ ok: true });
    expect(calls.at(-1)).toMatchObject({ url: `https://playintegrity.googleapis.com/v1/${packageName}:decodeIntegrityToken`, authorization: "Bearer at-1" });
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ integrityToken: "t.o.k.e.n" });
    expect(await integrity.verify({ token: "t.o.k.e.n", app: "nous", requestHash: "y".repeat(43) })).toEqual({ ok: false, reason: "REQUEST_HASH" });
    expect(await integrity.verify({ token: undefined, app: "nous", requestHash })).toEqual({ ok: false, reason: "NO_TOKEN" });
    expect(await integrity.verify({ token: "t", app: "other", requestHash })).toEqual({ ok: false, reason: "PACKAGE" });
  });

  it("refuses when Google refuses the token, cannot be reached, or the key does not load", async () => {
    expect(await createPlayIntegrity(keyFile, { fetch: google(() => new Response("{}", { status: 400 })).fetch, now: () => now })!
      .verify({ token: "t", app: "nous", requestHash })).toEqual({ ok: false, reason: "TOKEN_INVALID" });
    expect(await createPlayIntegrity(keyFile, { fetch: google(() => new Response("{}", { status: 503 })).fetch, now: () => now })!
      .verify({ token: "t", app: "nous", requestHash })).toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect(await createPlayIntegrity(join(dir, "missing.json"), { fetch: google(() => Response.json({})).fetch })!
      .verify({ token: "t", app: "nous", requestHash })).toEqual({ ok: false, reason: "NOT_CONFIGURED" });
  });
});
