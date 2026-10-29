import { z } from "zod";

// Sign-in for Space's own mobile apps (plan clipboard:VLBu2ge110ho step 4, Nous decision 2026-10-23): RFC 8252 with PKCE (S256 only).
// The app opens GET /api/auth/google/start?app=<id>&challenge=<S256>&state=<state> in the system browser; after the usual Google
// sign-in Space redirects to the app's fixed redirect URI with a one-time code, and the app redeems code + verifier at
// POST /api/auth/app-handoff for its own device session. The redirect URI never comes from the request.

/** Each app's exact redirect URI: a private-use scheme equal to its package id (RFC 8252 §7.1). Adding an app is a reviewed change. */
export const APP_SIGNIN_REDIRECT_URIS = { nous: "com.oll4.spaceapp.nous:/oauth2redirect" } as const;
export type AppSignInId = keyof typeof APP_SIGNIN_REDIRECT_URIS;
export const appSignInIdSchema = z.enum(Object.keys(APP_SIGNIN_REDIRECT_URIS) as [AppSignInId, ...AppSignInId[]]);

/** A device session lasts a fixed 30 days (no refresh, no sliding renewal); then the app signs in again. */
export const APP_DEVICE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Live device sessions per app and user; a newer sign-in revokes the oldest beyond it. */
export const APP_DEVICE_SESSIONS_MAX = 5;
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
  revokedAt: z.string().nullable()
}).strict();
export type AppDeviceSession = z.infer<typeof appDeviceSessionSchema>;
