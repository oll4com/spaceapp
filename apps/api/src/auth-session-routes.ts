import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { SpaceStore } from "@space/runtime";
import type { UserRoleCache } from "./admin-user-routes.js";
import {
  createCsrfToken,
  csrfHeaderName,
  cookieName,
  operatorSessionTtlSeconds,
  signedSessionPayload,
  signSession,
  verifySession,
  type AuthConfig
} from "./auth.js";
import type { SpaceApiConfig } from "./config.js";
import { sendApiError } from "./http-errors.js";

/**
 * The signed-in session: who the caller is (refreshing the role from the database and re-signing the
 * cookie on a role change) and the CSRF token for its writes.
 */
export function registerAuthSessionRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  auth: AuthConfig;
  userRoleCache: UserRoleCache;
  routeOptions: RouteShorthandOptions;
}) {
  const { config, store, auth, userRoleCache, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/auth/me", defaultRouteRateLimitOptions, async (request, reply) => {
    const setupStatus = auth.devLogin
      ? { setupRequired: false }
      : await store.getOwnerSetupStatus();
    let user = request.user;
    if (user && store.getControlActor) {
      const dbActor = await store.getControlActor(user.id);
      if (dbActor) {
        userRoleCache.set(user.id, { role: dbActor.role, cachedAt: Date.now() });
        const cookieUser = verifySession(request.cookies[cookieName], auth.sessionSecret);
        const needsCookieRefresh = !cookieUser || cookieUser.role !== dbActor.role;
        user = {
          ...user,
          email: dbActor.email,
          role: dbActor.role,
          googleId: dbActor.googleId ?? null,
          avatarUrl: dbActor.avatarUrl ?? null
        };
        if (needsCookieRefresh && auth.sessionSecret) {
          // A role change re-signs the session but keeps it the same session: its issue time and the client's CSRF token.
          const current = request.cookies[cookieName];
          const token = signSession(user, auth.sessionSecret, Date.now(), { iat: signedSessionPayload(current, auth.sessionSecret)?.iat,
            lc: createCsrfToken(current, auth.sessionSecret) ?? undefined });
          reply.setCookie(cookieName, token, {
            httpOnly: true,
            secure: auth.secureCookies,
            sameSite: "lax",
            path: "/",
            maxAge: operatorSessionTtlSeconds
          });
        }
      }
    }
    const settings = user ? await store.getUserSettings(user.id) : null;
    return {
      user,
      isAuthenticated: Boolean(user),
      isSetupRequired: setupStatus.setupRequired,
      googleAuthEnabled: Boolean(auth.googleClientId), optionalModules: [...config.optionalModules],
      settings
    };
  });

  // The user owner-scoped records (clipboard, Nous, Agent Files) land on for this session, resolved the way those routes do (upsertUser,
  // e-mail first; it writes nothing for an unchanged row). /api/auth/me cannot show it: it names the session id. `space-admin-action whoami`
  // reads it so the access check fails when a stable broker session lands on another row again (12/11: user:dev-operator).
  app.get("/api/auth/owner", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user) return sendApiError(reply, 401, "UNAUTHENTICATED", "Authentication is required.");
    return { ownerId: (await store.upsertUser(request.user)).id };
  });

  app.get("/api/auth/csrf", defaultRouteRateLimitOptions, async (request, reply) => {
    const csrfToken = createCsrfToken(request.cookies[cookieName], auth.sessionSecret);
    if (!csrfToken) {
      return sendApiError(reply, 401, "UNAUTHENTICATED", "Authentication is required.");
    }
    return { csrfToken, headerName: csrfHeaderName };
  });
}
