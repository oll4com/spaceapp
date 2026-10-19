import type {} from "./request-context.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { acceptUserInviteInputSchema, type AuthUser, loginInputSchema } from "@space/contracts";
import { type GoogleAccount, nowIso, SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import {
  type AuthConfig, authenticateLogin, buildGoogleAuthUrl, cookieName, defaultSessionRevocationStore,
  exchangeGoogleCode, generatePkcePair, hashPassword, operatorSessionTtlSeconds, signOAuthState, signSession, signSessionWithTtl,
  verifyGoogleIdToken, verifyOAuthState, verifyPassword, verifySession
} from "./auth.js";
import { operatorBrowserActor } from "./browser-actors.js";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import type { GoogleAccountBrowserCheckResult } from "./browser-sessions.js";
import type { SpaceApiConfig } from "./config.js";
import { completeConnectorCallback, type ConnectorOAuthStateTools, type ConnectorService } from "./dot-connectors.js";
import type { GoogleBrowserStatusSummary } from "./google-browser-session-check.js";
import { sendApiError } from "./http-errors.js";
import { createDesktopAuthHandoffStore, isValidDesktopAuthHandoffId } from "./desktop-auth-handoffs.js";
import { recordAudit } from "./request-audit.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";
import { instanceSecretDirectories } from "./instance-storage.js";

/**
 * Operator login/logout and Google sign-in (OAuth, linked accounts, desktop handoff); the parent retains
 * authentication hooks, CSRF, errors and rate limits.
 */
export function registerAuthRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  auth: AuthConfig;
  store: SpaceStore;
  browserSessionManager: BrowserSessionManagerWithHostHealth;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  googleAccountBrowserStatuses: (accounts: GoogleAccount[]) => Promise<Map<string, GoogleBrowserStatusSummary>>;
  dotsAuthenticatedOwner: (request: FastifyRequest) => Promise<string>;
  connectorStateTools: ConnectorOAuthStateTools;
  connectorServiceRef: { current: ConnectorService | null };
  persistRevocation: (pending: Promise<void>) => Promise<void>;
}) {
  const { config, auth, store, browserSessionManager, routeOptions: defaultRouteRateLimitOptions,
    googleAccountBrowserStatuses, dotsAuthenticatedOwner, connectorStateTools, connectorServiceRef,
    persistRevocation } = options;
  // Hashes a throwaway password once, so a sign-in for an email without an account costs the same scrypt time and the
  // answer time does not reveal which emails exist (security review 2026-10-17).
  let decoyHash: Promise<string> | null = null;
  app.post("/api/auth/login", {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "15 minutes"
      }
    }
  }, async (request, reply) => {
    const input = parseBody(loginInputSchema, request.body);
    const ownerCredentials = await store.getOwnerCredentials();
    let hashed = false;
    const verify = (passwordHash: string) => { hashed = true; return verifyPassword(input.password, passwordHash); };
    let user = ownerCredentials &&
      input.email.toLowerCase() === ownerCredentials.user.email.toLowerCase() &&
      await verify(ownerCredentials.passwordHash)
        ? ownerCredentials.user
        : null;
    if (!user && config.multiUserEnabled && store.getPasswordUser) {
      // Invited users sign in with their own password; a disabled user has none here.
      const account = await store.getPasswordUser(input.email);
      if (account && account.user.id !== ownerCredentials?.user.id && await verify(account.passwordHash)) {
        user = account.user;
      }
    }
    if (!user && !hashed && (ownerCredentials || config.multiUserEnabled)) await verify(await (decoyHash ??= hashPassword(randomBytes(16).toString("hex"))));
    if (!user && (auth.devLogin || !ownerCredentials)) {
      user = await authenticateLogin(input, auth);
    }
    if (!user) {
      await recordAudit(store, request, {
        action: "auth.login.failed",
        targetType: "auth",
        metadata: { result: "failed" }
      });
      return sendApiError(reply, 401, "INVALID_CREDENTIALS", "Email or password is not valid.");
    }

    const persistedUser = await store.upsertUser(user);
    await recordAudit(store, request, {
      actorUserId: persistedUser.id,
      action: "auth.login.succeeded",
      targetType: "user",
      targetId: persistedUser.id,
      metadata: { role: persistedUser.role, devLogin: persistedUser.id === "user:dev-operator" }
    });
    const token = signSession(persistedUser, auth.sessionSecret);
    reply.setCookie(cookieName, token, {
      httpOnly: true,
      secure: auth.secureCookies,
      sameSite: "lax",
      path: "/",
      maxAge: operatorSessionTtlSeconds
    });
    reply.clearCookie("space_logged_out", { path: "/" });
    return { user: persistedUser, isAuthenticated: true, isSetupRequired: false, optionalModules: [...config.optionalModules] };
  });
  // Accepting an invite creates the invited account with its own password and signs it in (SPACE_MULTI_USER_ENABLED).
  app.post("/api/auth/invites/accept", {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "15 minutes"
      }
    }
  }, async (request, reply) => {
    if (!config.multiUserEnabled || !store.acceptUserInvite) {
      return sendApiError(reply, 404, "MULTI_USER_DISABLED", "Multi-user accounts are not enabled on this installation.");
    }
    const input = parseBody(acceptUserInviteInputSchema, request.body);
    const user = await store.acceptUserInvite({
      tokenSha256: createHash("sha256").update(input.token).digest("hex"),
      passwordHash: await hashPassword(input.password),
      now: nowIso()
    });
    if (!user) {
      await recordAudit(store, request, { action: "user.invite.accept_failed", targetType: "user_invite", metadata: { result: "failed" } });
      return sendApiError(reply, 400, "INVITE_INVALID", "This invite is not valid, was already used or has expired.");
    }
    await recordAudit(store, request, {
      actorUserId: user.id, action: "user.invite.accepted", targetType: "user", targetId: user.id, metadata: { role: user.role }
    });
    reply.setCookie(cookieName, signSession(user, auth.sessionSecret), {
      httpOnly: true,
      secure: auth.secureCookies,
      sameSite: "lax",
      path: "/",
      maxAge: operatorSessionTtlSeconds
    });
    return { user, isAuthenticated: true, isSetupRequired: false, optionalModules: [...config.optionalModules] };
  });
  // A revocation takes effect at once; the answer says whether it was saved (external review 2026-10-16).
  const revocationsSaved = async (...pending: Promise<void>[]) =>
    (await Promise.allSettled(pending.map(persistRevocation))).every((result) => result.status === "fulfilled");
  const logoutNotSaved = (reply: FastifyReply) => sendApiError(reply, 503, "LOGOUT_NOT_SAVED",
    "You are logged out here, but the logout could not be saved yet; Space keeps retrying. Until it is saved, an API restart would accept this session again.");
  app.post("/api/auth/logout", defaultRouteRateLimitOptions, async (request, reply) => {
    const currentToken = request.cookies[cookieName];
    const body = (request.body ?? {}) as { revokeAll?: boolean };
    const saved = await revocationsSaved(
      ...(currentToken ? [defaultSessionRevocationStore.revokeToken(currentToken)] : []),
      ...(body.revokeAll && request.user ? [defaultSessionRevocationStore.revokeUser(request.user.id)] : [])
    );
    if (request.user) {
      await recordAudit(store, request, {
        action: "auth.logout",
        targetType: "user",
        targetId: request.user.id,
        metadata: { role: request.user.role, revokedAll: Boolean(body.revokeAll) }
      });
    }
    reply.setCookie("space_logged_out", "1", {
      httpOnly: false,
      secure: auth.secureCookies,
      sameSite: "lax",
      path: "/",
      maxAge: 86400 * 30
    });
    reply.clearCookie(cookieName, { path: "/" });
    if (!saved) return logoutNotSaved(reply);
    return { ok: true };
  });
  app.post("/api/auth/logout-all", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user) {
      return sendApiError(reply, 401, "UNAUTHORIZED", "Authentication required to revoke all sessions.");
    }
    const currentToken = request.cookies[cookieName];
    const saved = await revocationsSaved(
      defaultSessionRevocationStore.revokeUser(request.user.id),
      ...(currentToken ? [defaultSessionRevocationStore.revokeToken(currentToken)] : [])
    );
    await recordAudit(store, request, {
      actorUserId: request.user.id,
      action: "auth.logout_all",
      targetType: "user",
      targetId: request.user.id,
      metadata: { role: request.user.role }
    });
    reply.setCookie("space_logged_out", "1", {
      httpOnly: false,
      secure: auth.secureCookies,
      sameSite: "lax",
      path: "/",
      maxAge: 86400 * 30
    });
    reply.clearCookie(cookieName, { path: "/" });
    if (!saved) return logoutNotSaved(reply);
    return { ok: true, message: "All user sessions have been revoked." };
  });
  const handleGetLogout = async (request: FastifyRequest, reply: FastifyReply) => {
    const currentToken = request.cookies[cookieName];
    const saved = await revocationsSaved(...(currentToken ? [defaultSessionRevocationStore.revokeToken(currentToken)] : []));
    if (request.user) {
      await recordAudit(store, request, {
        actorUserId: request.user.id,
        action: "auth.logout",
        targetType: "user",
        targetId: request.user.id,
        metadata: { role: request.user.role, source: "get_logout" }
      });
    }
    reply.setCookie("space_logged_out", "1", {
      httpOnly: false,
      secure: auth.secureCookies,
      sameSite: "lax",
      path: "/",
      maxAge: 86400 * 30
    });
    reply.clearCookie(cookieName, { path: "/" });
    if (!saved) return logoutNotSaved(reply);
    return reply.redirect("/?login");
  };
  app.get("/api/auth/logout", defaultRouteRateLimitOptions, handleGetLogout);
  app.get("/logout", defaultRouteRateLimitOptions, handleGetLogout);
  app.post("/api/auth/google/configure", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user || request.user.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "Configuring Google OAuth requires the ADMIN role.");
    }
    const body = (request.body ?? {}) as { clientId?: string; clientSecret?: string };
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
    if (!clientId || !clientSecret) {
      return sendApiError(reply, 400, "INVALID_INPUT", "Both Google Client ID and Client Secret are required.");
    }
    auth.googleClientId = clientId;
    auth.googleClientSecret = clientSecret;
    let saved = false;
    for (const dir of instanceSecretDirectories()) {
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(
          `${dir}/google-oauth.json`,
          JSON.stringify({ clientId, clientSecret, updatedAt: new Date().toISOString() }, null, 2),
          { mode: 0o600 }
        );
        saved = true;
      } catch (error) {
        request.log.warn({ err: error, dir }, "google oauth config not written");
      }
    }
    if (!saved) {
      return sendApiError(reply, 500, "GOOGLE_OAUTH_NOT_SAVED", "Google OAuth works until the API restarts, but saving it failed.");
    }
    await recordAudit(store, request, {
      actorUserId: request.user.id,
      action: "auth.google.configure",
      targetType: "system",
      targetId: "google_oauth"
    });
    return { ok: true, googleAuthEnabled: true };
  });
  async function resolveOrRegisterGoogleUser(info: { email: string; sub: string; name?: string; picture?: string }, _requestId: string): Promise<AuthUser> {
    const user = await store.getUserByGoogleId?.(info.sub);
    if (!user) throw new Error("This Google account is not linked to any SpaceApp user. Please log in with your credentials and link your Google account in Settings.");
    // Login only reads membership. Only the authenticated linking flow can create it.
    return user;
  }
  function isGoogleProofSession(request: FastifyRequest): boolean {
    const session = verifySession(request.cookies[cookieName], auth.sessionSecret);
    return Boolean(session && (session.id.startsWith("user:operator-proof") || session.id.startsWith("user:proof") || session.proofScope || session.automationScope));
  }
  async function hasAlternativeGoogleLogin(userId: string): Promise<boolean> {
    const owner = await store.getOwnerCredentials();
    if (owner) return owner.user.id === userId;
    if (!auth.operatorEmail || !auth.operatorPasswordHash) return false;
    // Mirror the existing password route's persisted operator identity.
    const operator = await store.getControlActor("user:operator", auth.operatorEmail);
    return operator?.id === userId && operator.email.toLowerCase() === auth.operatorEmail.toLowerCase();
  }
  app.get("/api/auth/google/accounts", defaultRouteRateLimitOptions, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const accounts = await store.listGoogleAccounts(request.user!.id);
    const statuses = await googleAccountBrowserStatuses(accounts);
    return { accounts: accounts.map(account => ({ ...account, ...statuses.get(account.id)! })) };
  });
  // Checks the account's own persistent browser profile with Google. Only the
  // classified state is returned; cookies, emails and tokens stay in Chrome.
  app.post("/api/auth/google/accounts/:id/browser-check", defaultRouteRateLimitOptions, async (request, reply) => {
    if (isGoogleProofSession(request)) return sendApiError(reply, 403, "FORBIDDEN", "Proof sessions cannot check external accounts.");
    const { id } = parseQuery(idParamSchema, request.params);
    const account = (await store.listGoogleAccounts(request.user!.id)).find(candidate => candidate.id === id);
    if (!account) throw new SpaceNotFoundError("Google account not found.");
    let check: GoogleAccountBrowserCheckResult;
    try {
      check = browserSessionManager.checkGoogleAccount
        ? await browserSessionManager.checkGoogleAccount({ ownerUserId: account.ownerUserId, accountId: account.id }, true, operatorBrowserActor(request))
        : { status: "UNKNOWN", reason: "BROWSER_UNAVAILABLE", checkedAt: nowIso(), connectedAt: null };
    } catch (error) {
      if (error instanceof SpaceNotFoundError) throw error;
      // An unavailable or older Browser Host is not evidence of a Google logout.
      check = { status: "UNKNOWN", reason: "BROWSER_UNAVAILABLE", checkedAt: nowIso(), connectedAt: null };
    }
    await recordAudit(store, request, { action: "auth.google.browser_check", targetType: "google_account", targetId: id, metadata: { status: check.status, reason: check.reason } });
    const statuses = await googleAccountBrowserStatuses([account]);
    return { account: { ...account, ...statuses.get(account.id)! }, check };
  });
  app.patch("/api/auth/google/accounts/:id", defaultRouteRateLimitOptions, async (request, reply) => {
    if (isGoogleProofSession(request)) return sendApiError(reply, 403, "FORBIDDEN", "Proof sessions cannot manage external accounts.");
    const { id } = parseQuery(idParamSchema, request.params);
    parseBody(z.object({ isPrimary: z.literal(true) }).strict(), request.body);
    const account = await store.setPrimaryGoogleAccount(request.user!.id, id);
    await recordAudit(store, request, { action: "auth.google.primary", targetType: "google_account", targetId: id });
    return { account };
  });
  app.delete("/api/auth/google/accounts/:id", defaultRouteRateLimitOptions, async (request, reply) => {
    if (isGoogleProofSession(request)) return sendApiError(reply, 403, "FORBIDDEN", "Proof sessions cannot manage external accounts.");
    const { id } = parseQuery(idParamSchema, request.params);
    await store.removeGoogleAccount(request.user!.id, id, await hasAlternativeGoogleLogin(request.user!.id));
    await recordAudit(store, request, { action: "auth.google.unlink", targetType: "google_account", targetId: id });
    return { ok: true };
  });
  const desktopAuthHandoffs = createDesktopAuthHandoffStore();
  function escapeHtml(str: string): string {
    return str.replace(/[&<>'"]/g, (tag) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    }[tag] || tag));
  }
  const connectorStatePurpose = (state: string | undefined): string | null => {
    try { return (JSON.parse(Buffer.from(verifyOAuthState(state, auth.sessionSecret) ?? "", "base64url").toString("utf8")) as { purpose?: string }).purpose ?? null; }
    catch { return null; }
  };
  const startGoogleOAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!auth.googleClientId) {
      return sendApiError(reply, 400, "GOOGLE_AUTH_DISABLED", "Google authentication is not configured on this server.");
    }
    const query = request.query as Record<string, string> | undefined;
    const linking = query?.link === "true" || request.routeOptions.url === "/api/auth/google/accounts/link";
    if (linking && !request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Sign in before linking a Google account.");
    if (linking && isGoogleProofSession(request)) return sendApiError(reply, 403, "FORBIDDEN", "Proof sessions cannot link external accounts.");
    const pkce = generatePkcePair();
    const rawState = Buffer.from(JSON.stringify({
      nonce: randomBytes(16).toString("hex"), expiresAt: Date.now() + 600_000,
      userId: linking ? request.user!.id : null,
      sessionHash: linking ? createHash("sha256").update(request.cookies[cookieName]!).digest("hex") : null,
      codeChallenge: pkce.codeChallenge
    })).toString("base64url");
    const state = signOAuthState(rawState, auth.sessionSecret);
    const signedPkce = signOAuthState(pkce.codeVerifier, auth.sessionSecret);
    const forwardedProto = request.headers["x-forwarded-proto"];
    const forwardedHost = request.headers["x-forwarded-host"];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers["host"] ?? `127.0.0.1:${config.port}`;
    const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ?? (auth.secureCookies ? "https" : "http");
    const redirectUri = auth.googleRedirectUri || `${String(proto).split(",")[0]!.trim()}://${String(host).split(",")[0]!.trim()}/api/auth/google/callback`;

    reply.setCookie("space_oauth_state", state, {
      httpOnly: true,
      secure: auth.secureCookies,
      sameSite: "lax",
      path: "/",
      maxAge: 600
    });

    reply.setCookie("space_oauth_pkce", signedPkce, {
      httpOnly: true,
      secure: auth.secureCookies,
      sameSite: "lax",
      path: "/",
      maxAge: 600
    });

    const authUrl = buildGoogleAuthUrl({
      clientId: auth.googleClientId,
      redirectUri,
      state,
      codeChallenge: pkce.codeChallenge
    });

    const desktopHandoff = query?.desktopHandoff;
    if (isValidDesktopAuthHandoffId(desktopHandoff)) {
      reply.setCookie("space_oauth_desktop_handoff", desktopHandoff, {
        httpOnly: true,
        secure: auth.secureCookies,
        sameSite: "lax",
        path: "/",
        maxAge: 600
      });
    } else {
      reply.clearCookie("space_oauth_desktop_handoff", { path: "/" });
    }

    if (query?.mobile === "true" || query?.handoff === "true") {
      reply.setCookie("space_oauth_mobile", "true", {
        httpOnly: true,
        secure: auth.secureCookies,
        sameSite: "lax",
        path: "/",
        maxAge: 600
      });
    } else {
      reply.clearCookie("space_oauth_mobile", { path: "/" });
    }

    if (linking && request.user) {
      if (request.user.id.startsWith("user:operator-proof") || request.user.id.startsWith("user:proof")) {
        return sendApiError(reply, 403, "FORBIDDEN", "Proof sessions cannot link external accounts.");
      }
      const linkToken = signSessionWithTtl(request.user, auth.sessionSecret, 600);
      reply.setCookie("space_oauth_link_user", linkToken, {
        httpOnly: true,
        secure: auth.secureCookies,
        sameSite: "lax",
        path: "/",
        maxAge: 600
      });
    } else {
      reply.clearCookie("space_oauth_link_user", { path: "/" });
    }

    if (query?.json === "true" || request.headers.accept?.includes("application/json")) {
      return { authUrl };
    }
    return reply.redirect(authUrl);
  };
  app.get("/api/auth/google/start", defaultRouteRateLimitOptions, startGoogleOAuth);
  app.get("/api/auth/google/accounts/link", defaultRouteRateLimitOptions, startGoogleOAuth);
  app.get("/api/auth/google/callback", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!auth.googleClientId) {
      return sendApiError(reply, 400, "GOOGLE_AUTH_DISABLED", "Google authentication is not configured on this server.");
    }
    // Email/calendar connections reuse this registered callback; their signed state says so.
    if (connectorStatePurpose((request.query as Record<string, string> | undefined)?.state) === "connector") {
      return completeConnectorCallback(request, reply, connectorServiceRef.current, { authenticatedOwner: dotsAuthenticatedOwner, state: connectorStateTools });
    }
    const query = request.query as Record<string, string> | undefined;
    const code = query?.code;
    const state = query?.state;
    const savedState = request.cookies["space_oauth_state"];
    const pkceCookie = request.cookies["space_oauth_pkce"];
    const linkCookie = request.cookies["space_oauth_link_user"];
    const desktopHandoff = request.cookies["space_oauth_desktop_handoff"];
    for (const name of ["space_oauth_state", "space_oauth_pkce", "space_oauth_link_user", "space_oauth_desktop_handoff", "space_oauth_mobile"]) reply.clearCookie(name, { path: "/" });
    const verifiedState = verifyOAuthState(state, auth.sessionSecret);
    let transaction: { userId: string | null; sessionHash: string | null; codeChallenge: string; expiresAt: number } | null = null;
    try {
      transaction = z.object({ userId: z.string().nullable(), sessionHash: z.string().nullable(), codeChallenge: z.string().min(43), expiresAt: z.number() })
        .parse(JSON.parse(Buffer.from(verifiedState ?? "", "base64url").toString("utf8")));
    } catch { /* Reject malformed and legacy transactions; a fresh start is safe. */ }
    const errorKey = transaction?.userId || linkCookie ? "googleLinkError" : "authError";
    const fail = (message: string) => reply.redirect(`/?${errorKey}=${encodeURIComponent(message)}`);
    if (!state || state !== savedState || !verifiedState || !transaction || transaction.expiresAt <= Date.now()) {
      return fail("Invalid or expired Google OAuth state. Try signing in again.");
    }
    if (query?.error) return fail("Google authentication was cancelled or failed.");
    if (!code) return fail("Google authorization code is missing. Try signing in again.");
    const codeVerifier = verifyOAuthState(pkceCookie, auth.sessionSecret);
    if (!codeVerifier || createHash("sha256").update(codeVerifier).digest("base64url") !== transaction.codeChallenge) {
      return fail("Invalid or expired Google PKCE session. Try signing in again.");
    }
    let linkUser: AuthUser | null = null;
    if (transaction.userId) {
      linkUser = verifySession(linkCookie, auth.sessionSecret);
      if (!linkUser || linkUser.id !== transaction.userId || isGoogleProofSession(request) || !request.user || request.user.id !== transaction.userId ||
        transaction.sessionHash !== createHash("sha256").update(request.cookies[cookieName] ?? "").digest("hex")) {
        return fail("You must be actively logged into the original account linking session. Please try again.");
      }
    } else if (linkCookie) {
      return fail("Invalid account linking session. Please try again.");
    }

    const forwardedProto = request.headers["x-forwarded-proto"];
    const forwardedHost = request.headers["x-forwarded-host"];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers["host"] ?? `127.0.0.1:${config.port}`;
    const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ?? (auth.secureCookies ? "https" : "http");
    const redirectUri = auth.googleRedirectUri || `${String(proto).split(",")[0]!.trim()}://${String(host).split(",")[0]!.trim()}/api/auth/google/callback`;

    try {
      const googleInfo = await exchangeGoogleCode({
        code,
        clientId: auth.googleClientId,
        clientSecret: auth.googleClientSecret,
        redirectUri,
        codeVerifier
      });

      if (linkUser) {
        const linkUserId = linkUser.id;
        await store.linkGoogleAccount(linkUserId, googleInfo);
        await recordAudit(store, request, {
          actorUserId: linkUserId,
          action: "auth.google.link",
          targetType: "user",
          targetId: linkUserId,
          metadata: { googleSub: googleInfo.sub, email: googleInfo.email }
        });
        request.log.info({
          event: "SECURITY_OAUTH_ACCOUNT_LINKED",
          userId: linkUserId,
          googleSub: googleInfo.sub,
          email: googleInfo.email
        }, `[SECURITY_AUDIT] User ${linkUserId} linked Google account ${googleInfo.email}`);
        return reply.redirect("/?googleLinked=true");
      }

      const user = await resolveOrRegisterGoogleUser(googleInfo, request.requestIdForSpace);
      await recordAudit(store, request, {
        actorUserId: user.id,
        action: "auth.google.login",
        targetType: "user",
        targetId: user.id,
        metadata: { role: user.role }
      });

      const token = signSession(user, auth.sessionSecret);
      reply.clearCookie("space_oauth_state", { path: "/" });
      reply.clearCookie("space_logged_out", { path: "/" });
      reply.setCookie(cookieName, token, {
        httpOnly: true,
        secure: auth.secureCookies,
        sameSite: "lax",
        path: "/",
        maxAge: operatorSessionTtlSeconds
      });

      if (isValidDesktopAuthHandoffId(desktopHandoff)) {
        desktopAuthHandoffs.store(desktopHandoff, {
          token,
          user: { id: user.id, email: user.email, role: user.role }
        });
        reply.type("text/html; charset=utf-8");
        const safeEmail = escapeHtml(user.email || "operator");
        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SpaceApp - Sign In Complete</title>
  <style>
    body { background-color: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 1rem; box-sizing: border-box; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 2.5rem; text-align: center; max-width: 440px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    h1 { color: #58a6ff; font-size: 1.5rem; margin-top: 0.75rem; margin-bottom: 0.5rem; }
    p { color: #8b949e; line-height: 1.5; font-size: 0.95rem; }
    .badge { display: inline-block; padding: 0.35rem 0.85rem; background: #238636; color: #fff; border-radius: 20px; font-weight: 600; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">✓ Connected</div>
    <h1>Signed in successfully</h1>
    <p>You have signed in to SpaceApp as <strong>${safeEmail}</strong>.</p>
    <p>You can close this tab and return to your SpaceApp desktop window.</p>
    <script>
      try { window.location.href = "spaceapp://auth-complete"; } catch(e) {}
      setTimeout(() => { try { window.close(); } catch(e) {} }, 4000);
    </script>
  </div>
</body>
</html>`;
      }

      if (request.cookies["space_oauth_mobile"] === "true") {
        reply.clearCookie("space_oauth_mobile", { path: "/" });
        const callbackUrl = `spaceapp://auth/callback?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email || "")}`;
        return reply.type("text/html; charset=utf-8").send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SpaceApp</title>
<script>
window.location.href = "${callbackUrl}";
setTimeout(function() { window.location.href = "${callbackUrl}"; }, 500);
</script>
</head>
<body style="background:#0d1117;color:#c9d1d9;font-family:sans-serif;text-align:center;padding:40px 20px;">
<div style="max-width:400px;margin:0 auto;background:#161b22;padding:30px;border-radius:12px;border:1px solid #30363d;">
<h2 style="color:#58a6ff;margin-top:0;">Authentication Successful</h2>
<p>Returning to SpaceApp Mobile...</p>
<p><a href="${callbackUrl}" style="display:inline-block;padding:12px 24px;background:#238636;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;margin-top:15px;">Open SpaceApp</a></p>
</div>
</body>
</html>`);
      }

      return reply.redirect("/");
    } catch (err) {
      request.log.warn({ event: "GOOGLE_OAUTH_FAILED" }, "Google OAuth callback failed");
      const clientMessage = err instanceof SpaceConflictError || (err instanceof Error && err.message.includes("not linked"))
        ? err.message : "Google authentication failed. Please try again or sign in with your password.";
      return fail(clientMessage);
    }
  });
  app.get("/api/auth/desktop-handoff", defaultRouteRateLimitOptions, async (request, reply) => {
    const query = request.query as Record<string, string> | undefined;
    const handoffId = query?.handoffId;
    if (!isValidDesktopAuthHandoffId(handoffId)) {
      return sendApiError(reply, 400, "INVALID_HANDOFF_ID", "A valid handoffId is required.");
    }
    // Single use and time-limited: an unclaimed sign-in expires on its own.
    const entry = desktopAuthHandoffs.take(handoffId);
    if (!entry) {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      token: entry.token,
      user: entry.user
    };
  });
  app.post("/api/auth/google/unlink", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user) {
      return sendApiError(reply, 401, "UNAUTHORIZED", "Authentication required to unlink Google account.");
    }
    if (isGoogleProofSession(request)) return sendApiError(reply, 403, "FORBIDDEN", "Proof sessions cannot manage external accounts.");
    const primary = (await store.listGoogleAccounts(request.user.id)).find(account => account.isPrimary);
    if (primary) await store.removeGoogleAccount(request.user.id, primary.id, await hasAlternativeGoogleLogin(request.user.id));
    await recordAudit(store, request, {
      actorUserId: request.user.id,
      action: "auth.google.unlink",
      targetType: "user",
      targetId: request.user.id
    });
    request.log.info({
      event: "SECURITY_OAUTH_ACCOUNT_UNLINKED",
      userId: request.user.id
    }, `[SECURITY_AUDIT] User ${request.user.id} unlinked their Google account`);
    return { ok: true };
  });
  app.post("/api/auth/google/credential", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!auth.googleClientId) {
      return sendApiError(reply, 400, "GOOGLE_AUTH_DISABLED", "Google authentication is not configured on this server.");
    }
    const body = z.object({ credential: z.string().min(1) }).parse(request.body);
    try {
      const googleInfo = await verifyGoogleIdToken({
        idToken: body.credential,
        clientId: auth.googleClientId
      });
      const user = await resolveOrRegisterGoogleUser(googleInfo, request.requestIdForSpace);
      await recordAudit(store, request, {
        actorUserId: user.id,
        action: "auth.google.credential_login",
        targetType: "user",
        targetId: user.id,
        metadata: { role: user.role }
      });
      const token = signSession(user, auth.sessionSecret);
      reply.clearCookie("space_logged_out", { path: "/" });
      reply.setCookie(cookieName, token, {
        httpOnly: true,
        secure: auth.secureCookies,
        sameSite: "lax",
        path: "/",
        maxAge: operatorSessionTtlSeconds
      });
      return { user, isAuthenticated: true, isSetupRequired: false, optionalModules: [...config.optionalModules] };
    } catch (err) {
      request.log.error({ err }, "Google credential verification failed");
      return sendApiError(reply, 401, "INVALID_CREDENTIALS", err instanceof Error ? err.message : "Google token verification failed.");
    }
  });
}
