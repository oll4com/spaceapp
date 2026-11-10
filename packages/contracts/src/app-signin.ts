import { z } from "zod";

// Sign-in for Space's own mobile apps (plan clipboard:VLBu2ge110ho step 4, Nous decision 2026-10-23): RFC 8252 with PKCE (S256 only).
// The app opens GET /api/auth/google/start?app=<id>&challenge=<S256>&state=<state> in the system browser; after the usual Google
// sign-in Space redirects to the app's fixed redirect URI with a one-time code, and the app redeems code + verifier at
// POST /api/auth/app-handoff for its own device session. The redirect URI never comes from the request.

/** Each app's exact redirect URI: a private-use scheme equal to its package id (RFC 8252 §7.1). Adding an app is a reviewed change. */
export const APP_SIGNIN_REDIRECT_URIS = { nous: "com.oll4.spaceapp.nous:/oauth2redirect", spaceapp: "com.oll4.spaceapp:/oauth2redirect" } as const;
export type AppSignInId = keyof typeof APP_SIGNIN_REDIRECT_URIS;
export const appSignInIdSchema = z.enum(Object.keys(APP_SIGNIN_REDIRECT_URIS) as [AppSignInId, ...AppSignInId[]]);

/**
 * SpaceApp Android's Web tab (plan clipboard:1cZ-YxU8zS2O R8): Google refuses its consent page inside a WebView, so connector consent and
 * Google account linking finish in the phone's browser, which has none of the WebView's cookies. A flow the WebView started (its user agent
 * names the app) is marked in the signed OAuth state; a callback that reaches the phone's browser without the state cookie goes back to the
 * app at this fixed URI, and the app opens the callback in its WebView, where the state, PKCE and session cookies are. The code alone does nothing.
 */
export const APP_WEBVIEW_RETURN_URIS = { spaceapp: "com.oll4.spaceapp:/oauth-return" } as const;
export type AppWebViewId = keyof typeof APP_WEBVIEW_RETURN_URIS;
export const appWebViewIdSchema = z.enum(Object.keys(APP_WEBVIEW_RETURN_URIS) as [AppWebViewId, ...AppWebViewId[]]);
/** The app whose WebView sent the request (SpaceApp Android 0.2.6+ appends `SpaceApp-Android/<version>` to its user agent), else null. */
export function appWebViewOf(userAgent: string | string[] | undefined): AppWebViewId | null {
  return /\bSpaceApp-Android\/\d/.test(String(userAgent ?? "")) ? "spaceapp" : null;
}
/** The callback (its path and query: state, code or error) handed back to the app's WebView. */
export function appWebViewReturnUrl(app: AppWebViewId, callbackPathAndQuery: string): string {
  return `${APP_WEBVIEW_RETURN_URIS[app]}?to=${encodeURIComponent(callbackPathAndQuery)}`;
}

/** A device session lasts a fixed 30 days (no refresh, no sliding renewal); then the app signs in again. */
export const APP_DEVICE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Live device sessions per app and user; a newer sign-in revokes the oldest beyond it. */
export const APP_DEVICE_SESSIONS_MAX = 5;
/** A phone paired over the mobile channel holds read only until its owner allows it within this window; then it is revoked (Nous Pro security review P1-5). */
export const MOBILE_PAIRING_CONFIRM_MS = 10 * 60_000;
/** A one-time code lives this long and is used once. */
export const APP_HANDOFF_CODE_TTL_MS = 2 * 60 * 1000;

// base64url(SHA-256(verifier)): 43 characters; the verifier itself 43-128 characters of RFC 7636's unreserved set.
export const appSignInChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const appSignInStateSchema = z.string().regex(/^[A-Za-z0-9._~-]{16,128}$/);
export const appSignInVerifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);

export const appHandoffRedeemSchema = z.object({
  app: appSignInIdSchema,
  code: z.string().min(1).max(256),
  codeVerifier: appSignInVerifierSchema,
  deviceName: z.string().trim().min(1).max(80)
}).strict();
export type AppHandoffRedeem = z.infer<typeof appHandoffRedeemSchema>;

export const appDeviceSessionIdSchema = z.string().regex(/^appdev:[A-Za-z0-9_-]{6,80}$/);
export const appDeviceSessionSchema = z.object({
  id: appDeviceSessionIdSchema,
  app: appSignInIdSchema,
  deviceName: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  /** A phone paired over the mobile channel (ADR-013): what it may do now, what it asked for, and when its owner allowed it. */
  paired: z.object({ scopes: z.array(z.string()), requestedScopes: z.array(z.string()), allowedAt: z.string().nullable(), lastSeenAt: z.string().nullable(),
    decide: z.enum(["TRUSTED_ENVIRONMENT", "STRONGBOX"]).nullable() }).strict().optional()
}).strict();
export type AppDeviceSession = z.infer<typeof appDeviceSessionSchema>;
