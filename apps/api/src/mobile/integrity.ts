import { createGoogleAccessToken, loadFcmServiceAccount } from "../notifications/fcm.js";
import { MOBILE_APP_SIGNERS } from "./attestation.js";

// Play Integrity (MASVS L2 RESILIENCE-1/2/4, plan clipboard:kTV3y2lwO-99 step 7; developer.android.com/google/play/integrity/verdicts, read
// 2/11/2026): beside the decide key's attestation, Google's own verdict that this is our Play-recognized app, signed with our release key, on
// a device that meets device integrity, bound to this pairing or this signed answer by the request hash. The token is decoded on Google's
// server with a service account of the Cloud project linked to the Play Console app (SPACE_PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE).
// shortcut: no file configured means no check (no Cloud project yet, the operator's); once one is, a missing or failed verdict refuses decide.

export const MOBILE_INTEGRITY_HEADER = "x-space-mobile-integrity";
const SCOPE = "https://www.googleapis.com/auth/playintegrity";
const FRESH_MS = 5 * 60_000;
export const MOBILE_APP_PACKAGES: Readonly<Record<string, string>> = { nous: "com.oll4.spaceapp.nous", spaceapp: "com.oll4.spaceapp" };

type Verdict = {
  requestDetails?: { requestPackageName?: string; requestHash?: string; timestampMillis?: string | number };
  appIntegrity?: { appRecognitionVerdict?: string; packageName?: string; certificateSha256Digest?: string[] };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
};
export type IntegrityResult = { ok: true } | { ok: false; reason: string };
export type PlayIntegrity = { verify(input: { token: string | undefined; app: string; requestHash: string }): Promise<IntegrityResult> };

/** Why a decoded verdict does not pass, or null. Every field Google may leave out fails closed. */
export function playIntegrityProblem(verdict: Verdict | undefined, expected: { packageName: string; requestHash: string; now: number }): string | null {
  const details = verdict?.requestDetails, app = verdict?.appIntegrity;
  if (details?.requestPackageName !== expected.packageName) return "PACKAGE";
  if (details.requestHash !== expected.requestHash) return "REQUEST_HASH";
  if (!(Math.abs(expected.now - Number(details.timestampMillis)) <= FRESH_MS)) return "STALE";
  if (app?.appRecognitionVerdict !== "PLAY_RECOGNIZED" || app.packageName !== expected.packageName) return "APP_NOT_RECOGNIZED";
  // Google sends the certificate digests base64 (web-safe); our signers are hex.
  const signer = MOBILE_APP_SIGNERS[expected.packageName];
  if (!signer || !(app.certificateSha256Digest ?? []).some((digest) => Buffer.from(digest, "base64").toString("hex") === signer)) return "SIGNER";
  const device = verdict?.deviceIntegrity?.deviceRecognitionVerdict ?? [];
  if (!device.includes("MEETS_DEVICE_INTEGRITY") && !device.includes("MEETS_STRONG_INTEGRITY")) return "DEVICE";
  return null;
}

/** The checker, or null when no service account file is configured. A configured file that does not load refuses every verdict. */
export function createPlayIntegrity(file: string | null, options: { fetch?: typeof fetch; now?: () => number } = {}): PlayIntegrity | null {
  if (!file) return null;
  // Looked up per call, not at start, so a stubbed global fetch (tests) is the one used.
  const fetchImpl: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init), now = options.now ?? Date.now;
  const token = loadFcmServiceAccount(file).then((account) => account && createGoogleAccessToken(account, SCOPE, { fetch: fetchImpl, now }));
  return {
    async verify({ token: integrityToken, app, requestHash }) {
      const packageName = MOBILE_APP_PACKAGES[app];
      if (!packageName) return { ok: false, reason: "PACKAGE" };
      if (!integrityToken) return { ok: false, reason: "NO_TOKEN" };
      const accessToken = await token;
      if (!accessToken) return { ok: false, reason: "NOT_CONFIGURED" };
      try {
        const response = await fetchImpl(`https://playintegrity.googleapis.com/v1/${packageName}:decodeIntegrityToken`, {
          method: "POST", headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
          body: JSON.stringify({ integrityToken }), signal: AbortSignal.timeout(10_000) });
        if (response.status === 401) accessToken.reset();
        if (!response.ok) return { ok: false, reason: response.status === 400 ? "TOKEN_INVALID" : "UNAVAILABLE" };
        const body = await response.json() as { tokenPayloadExternal?: Verdict };
        const problem = playIntegrityProblem(body.tokenPayloadExternal, { packageName, requestHash, now: now() });
        return problem ? { ok: false, reason: problem } : { ok: true };
      } catch {
        return { ok: false, reason: "UNAVAILABLE" };
      }
    }
  };
}
