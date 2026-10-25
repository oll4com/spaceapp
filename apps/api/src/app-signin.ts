import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  APP_DEVICE_SESSION_TTL_SECONDS, APP_DEVICE_SESSIONS_MAX, APP_HANDOFF_CODE_TTL_MS, APP_SIGNIN_REDIRECT_URIS, appDeviceSessionIdSchema, appHandoffRedeemSchema,
  appSignInChallengeSchema, appSignInIdSchema, appSignInStateSchema, type AppDeviceSession, type AppSignInId, type AuthUser
} from "@space/contracts";
import { InMemoryAppDeviceSessionRepository, PostgresAppDeviceSessionRepository, type AppDeviceSessionRecord, type AppDeviceSessionRepository } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import { cookieName, operatorSessionTtlSeconds, sessionIdHash, sessionIdOfToken, signSession, signedSessionPayload, verifySession, type SessionRevocationStore } from "./auth.js";
import { createDesktopAuthHandoffStore } from "./desktop-auth-handoffs.js";
import { sendApiError } from "./http-errors.js";
import { recordAudit } from "./request-audit.js";

// Sign-in for Space's own mobile apps (plan clipboard:VLBu2ge110ho step 4; design step4-mobile-signin-design.md): RFC 8252 with
// PKCE. The start route keeps {app, challenge, state} in a cookie of the system browser; after the usual Google sign-in Space
// sends that browser to the app's fixed redirect URI with a one-time code, and the app redeems code + verifier + app here for a
// device session of its own (fixed 30 days, listed in Settings > Account > Devices). The session never travels in a URL.

export const APP_SIGNIN_COOKIE = "space_oauth_app_handoff";

export interface AppSignInBinding { app: AppSignInId; challenge: string; state: string }

/** The start route's app, challenge and state, or null when one is missing or malformed (S256 only: no method parameter). */
export function parseAppSignInBinding(input: { app?: unknown; challenge?: unknown; state?: unknown }): AppSignInBinding | null {
  const app = appSignInIdSchema.safeParse(input.app), challenge = appSignInChallengeSchema.safeParse(input.challenge), state = appSignInStateSchema.safeParse(input.state);
  return app.success && challenge.success && state.success ? { app: app.data, challenge: challenge.data, state: state.data } : null;
}
export const encodeAppSignInCookie = (binding: AppSignInBinding) => Buffer.from(JSON.stringify(binding)).toString("base64url");
export function decodeAppSignInCookie(value: unknown): AppSignInBinding | null {
  if (typeof value !== "string" || value.length > 600) return null;
  try { return parseAppSignInBinding(JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>); } catch { return null; }
}
/** Only the app's own redirect URI from the contracts map; the request adds nothing but the code and its state. */
export function appSignInRedirect(binding: AppSignInBinding, code: string): string {
  const url = new URL(APP_SIGNIN_REDIRECT_URIS[binding.app]);
  url.searchParams.set("code", code);
  url.searchParams.set("state", binding.state);
  return url.toString();
}

const codeKey = (code: string) => createHash("sha256").update(code).digest("hex");
const publicRow = (row: AppDeviceSessionRecord): AppDeviceSession => ({ id: row.id, app: row.app, deviceName: row.deviceName, createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt });

export interface AppSignInOptions {
  store: Pick<SpaceStore, "upsertUser" | "recordAuditEvent">;
  repository: AppDeviceSessionRepository;
  revocations: Pick<SessionRevocationStore, "revokeSessionHash">;
  sessionSecret: string;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  persistRevocation: (pending: Promise<void>) => Promise<void>;
  now?: () => number;
}
export type AppSignIn = ReturnType<typeof createAppSignIn>;

/** The composition root's one call: the repository (PostgreSQL when the store is), the module and its routes. */
export function registerAppSignIn(app: FastifyInstance, options: Omit<AppSignInOptions, "repository"> & { databaseUrl: string | null | undefined }): AppSignIn {
  const repository = options.databaseUrl ? PostgresAppDeviceSessionRepository.fromConnectionString(options.databaseUrl) : new InMemoryAppDeviceSessionRepository();
  const signIn = createAppSignIn({ ...options, repository });
  signIn.register(app);
  return signIn;
}

export function createAppSignIn(options: AppSignInOptions) {
  if (APP_DEVICE_SESSION_TTL_SECONDS !== operatorSessionTtlSeconds) throw new Error("A device session must be the 30-day persistent session.");
  const now = options.now ?? Date.now;
  const handoffs = createDesktopAuthHandoffStore({ ttlMs: APP_HANDOFF_CODE_TTL_MS, now });
  const revokeRow = (row: AppDeviceSessionRecord) =>
    options.persistRevocation(options.revocations.revokeSessionHash(row.sidSha256, Date.parse(row.expiresAt) + 24 * 3600_000)).catch(() => undefined);

  /** Proof, automation and agent broker sessions never see or revoke devices: a person in Settings only. */
  function assertPerson(request: FastifyRequest): void {
    const session = verifySession(request.cookies[cookieName], options.sessionSecret);
    const user = request.user as (AuthUser & { brokerScope?: string }) | undefined;
    if (!session || session.id.startsWith("user:operator-proof") || session.id.startsWith("user:proof") || session.proofScope || session.automationScope
      || user?.proofScope || user?.automationScope || user?.brokerScope || request.sessionPrincipal?.startsWith("user:operator-proof")) {
      throw Object.assign(new Error("Only you, signed in to Space, manage your devices (Settings > Account > Devices)."), { statusCode: 403 });
    }
  }

  return {
    /** After the Google callback resolved the user: a device session and its one-time code, sent to the app's redirect URI. */
    async issue(binding: AppSignInBinding, user: AuthUser, request: FastifyRequest): Promise<string> {
      const token = signSession(user, options.sessionSecret, now(), { app: binding.app });
      const code = randomBytes(32).toString("base64url");
      handoffs.store(codeKey(code), { token, user: { id: user.id, email: user.email ?? "", role: user.role }, code, codeChallenge: binding.challenge, app: binding.app });
      await recordAudit(options.store, request, { action: "auth.app_handoff.issued", targetType: "user", targetId: user.id, actorUserId: user.id, metadata: { app: binding.app } });
      return appSignInRedirect(binding, code);
    },
    /** Logout of a device session marks its row revoked (logout already revoked the token itself). */
    async loggedOut(token: string | undefined): Promise<void> {
      const payload = signedSessionPayload(token, options.sessionSecret);
      const sid = payload?.app ? sessionIdOfToken(token) : null;
      if (sid) await options.repository.revokeBySid(sessionIdHash(sid), new Date(now()).toISOString()).catch(() => null);
    },
    register(app: FastifyInstance): void {
      // Class B (record-retention): device-session rows that ended more than 30 days ago.
      const prune = setInterval(() => void options.repository.pruneEnded(new Date(now()).toISOString()).catch(() => 0), 6 * 3600_000);
      prune.unref();
      app.addHook("onClose", async () => { clearInterval(prune); await options.repository.dispose(); });
      const strict = { config: { ...options.routeOptions.config, rateLimit: { max: 10, timeWindow: "15 minutes" } } };
      // Public: the app has no session yet. Code, verifier and app are checked together; any mismatch burns the code.
      app.post("/api/auth/app-handoff", strict, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const input = appHandoffRedeemSchema.safeParse(request.body ?? {});
        const entry = input.success ? handoffs.redeem(codeKey(input.data.code), input.data.code, input.data.codeVerifier, input.data.app) : null;
        if (!input.success || !entry) {
          await recordAudit(options.store, request, { action: "auth.app_handoff.failed", targetType: "app", targetId: input.success ? input.data.app : null,
            metadata: { reason: input.success ? "CODE_OR_VERIFIER" : "MALFORMED" } }).catch(() => undefined);
          return { authenticated: false };
        }
        const { app: appId, deviceName } = input.data;
        const sid = sessionIdOfToken(entry.token)!;
        const expiresAt = new Date(signedSessionPayload(entry.token, options.sessionSecret)!.exp * 1000).toISOString();
        // At most APP_DEVICE_SESSIONS_MAX live sessions per app: the oldest go.
        const live = await options.repository.live(entry.user.id, appId, new Date(now()).toISOString());
        for (const old of live.slice(0, Math.max(0, live.length - APP_DEVICE_SESSIONS_MAX + 1))) {
          if (await options.repository.revoke(entry.user.id, old.id, new Date(now()).toISOString())) await revokeRow(old);
        }
        const row = await options.repository.create({ id: `appdev:${randomBytes(12).toString("base64url")}`, ownerUserId: entry.user.id, app: appId, deviceName,
          sidSha256: sessionIdHash(sid), expiresAt });
        await recordAudit(options.store, request, { action: "auth.app_handoff.redeemed", targetType: "app_device_session", targetId: row.id, actorUserId: entry.user.id,
          metadata: { app: appId } });
        return { authenticated: true, token: entry.token, user: { id: entry.user.id, email: entry.user.email }, deviceSessionId: row.id, expiresAt };
      });
      app.get("/api/auth/devices", options.routeOptions, async (request, reply) => {
        if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Sign in to see your devices.");
        assertPerson(request);
        return { devices: (await options.repository.list(request.user.id)).map(publicRow) };
      });
      app.post("/api/auth/devices/:id/revoke", options.routeOptions, async (request, reply: FastifyReply) => {
        if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Sign in to revoke a device.");
        assertPerson(request);
        const id = appDeviceSessionIdSchema.safeParse((request.params as { id?: unknown }).id);
        const row = id.success ? await options.repository.revoke(request.user.id, id.data, new Date(now()).toISOString()) : null;
        if (!row) return sendApiError(reply, 404, "DEVICE_NOT_FOUND", "This device is not signed in.");
        await revokeRow(row);
        await recordAudit(options.store, request, { action: "auth.device_session.revoked", targetType: "app_device_session", targetId: row.id, metadata: { app: row.app } });
        return { device: publicRow(row) };
      });
    }
  };
}
