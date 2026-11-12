import type {} from "./request-context.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { acceptUserInviteInputSchema, appWebViewIdSchema, appWebViewOf, appWebViewReturnUrl, type AppWebViewId, type AuthUser, loginInputSchema } from "@space/contracts";
import { type GoogleAccount, nowIso, SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import {
  type AuthConfig, authenticateLogin, buildGoogleAuthUrl, cookieName, defaultSessionRevocationStore,
  exchangeGoogleCode, generatePkcePair, googleRedirectUriFor, googleStepUpRefusal, hashPassword, operatorSessionTtlSeconds, requestOrigin, signOAuthState, signSession, signSessionWithTtl,
  verifyGoogleIdToken, verifyOAuthState, verifyPassword, verifySession
} from "./auth.js";
import { operatorBrowserActor } from "./browser-actors.js";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import type { GoogleAccountBrowserCheckResult } from "./browser-sessions.js";
import type { SpaceApiConfig } from "./config.js";
import { completeConnectorCallback, type ConnectorOAuthStateTools, type ConnectorService } from "./dot-connectors.js";
import type { GoogleBrowserStatusSummary } from "./google-browser-session-check.js";
import { sendApiError } from "./http-errors.js";
import { createDesktopAuthHandoffStore, decodeDesktopAuthHandoffCookie, desktopAuthHandoffRedirect, encodeDesktopAuthHandoffCookie, parseDesktopAuthHandoffBinding } from "./desktop-auth-handoffs.js";
import { recordAudit } from "./request-audit.js";
import { APP_SIGNIN_COOKIE, appStepUpReturn, decodeAppSignInCookie, encodeAppSignInCookie, parseAppSignInBinding, type AppSignIn, type StepUpTicket } from "./app-signin.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

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
  /** Space's own mobile apps (app-signin.ts): absent, an app start link is refused. */
  appSignIn?: AppSignIn;
  /** Sends the owner one transactional mail (Forgot password); filled once Mail Campaigns exists, null: no reset by mail. */
  passwordResetMail?: { current: ((owner: string, to: string, subject: string, text: string) => Promise<void>) | null };
}) {
  const { config, auth, store, browserSessionManager, routeOptions: defaultRouteRateLimitOptions,
    googleAccountBrowserStatuses, dotsAuthenticatedOwner, connectorStateTools, connectorServiceRef,
    persistRevocation } = options;
  // Hashes a throwaway password once, so a sign-in for an email without an account costs the same scrypt time and the
  // answer time does not reveal which emails exist (security review 2026-10-17).
  let decoyHash: Promise<string> | null = null;
  // Fingerprint of the .env operator hash, stored when Settings replaces it (adoptOwnerPassword).
  const envPasswordSha256 = auth.operatorPasswordHash ? createHash("sha256").update(auth.operatorPasswordHash).digest("hex") : null;
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
    await options.appSignIn?.loggedOut(currentToken);
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
    for (const dir of [`${SPACE_INSTALL_ROOT}/secrets`, "/var/lib/spaceapp"]) {
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
  // Host-side recovery: a SPACE_OPERATOR_PASSWORD_HASH other than the one Settings replaced (fingerprint) becomes the owner's password at start.
  app.addHook("onReady", async () => {
    try {
      const owner = await store.getOwnerCredentials();
      if (!owner?.envPasswordSha256 || !envPasswordSha256 || owner.envPasswordSha256 === envPasswordSha256) return;
      const restored = await store.adoptOwnerPassword(owner.user.id, auth.operatorPasswordHash!, envPasswordSha256);
      app.log.warn({ restored }, "A new SPACE_OPERATOR_PASSWORD_HASH replaced the owner's password set in Settings.");
    } catch (error) {
      app.log.error({ err: error }, "Could not apply a new SPACE_OPERATOR_PASSWORD_HASH to the owner's password.");
    }
  });
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
    // A step-up before pairing a phone (Nous Pro security review P1-5): the person signed in here signs in to Google again (claims auth_time,
    // max_age=0, its own nonce); the callback checks auth_time (or, without it, that nonce and a fresh iat) and that the Google account is
    // theirs, then marks this session for 5 minutes.
    const stepUp = query?.stepUp === "mobile";
    // R10b: the phone's system browser has no SpaceApp session; its ticket (POST /api/auth/app/step-up/start) names the app session.
    let ticket: StepUpTicket | null = null;
    if (stepUp && query?.ticket !== undefined) {
      if (!options.appSignIn || linking || query.app !== undefined || query.desktopHandoff !== undefined || query.mobile !== undefined) {
        return sendApiError(reply, 403, "FORBIDDEN", "Start confirming it is you from SpaceApp on your phone again.");
      }
      ticket = options.appSignIn.stepUp.take(query.ticket);
      if (!ticket) return sendApiError(reply, 403, "STEP_UP_TICKET_INVALID", "This link was used or expired; start confirming it is you from SpaceApp on your phone again.");
    } else if (stepUp) {
      if (!request.user || !options.appSignIn) return sendApiError(reply, 401, "UNAUTHORIZED", "Sign in to SpaceApp before confirming it is you.");
      options.appSignIn.assertPerson(request);
      if (request.appSession || linking || query?.app !== undefined || query?.desktopHandoff !== undefined || query?.mobile !== undefined) {
        return sendApiError(reply, 403, "FORBIDDEN", "Confirm it is you from SpaceApp in a browser on your computer.");
      }
    }
    // Login screen › Forgot password? (operator 13/11, nous_msg 01:50 BKK): no mail channel for sign-in mail exists here, so the reset is a
    // fresh sign-in of the linked Google account (checked like a step-up); the callback marks the new session, which may then set a password.
    const reset = query?.reset === "password";
    if (reset && (!options.appSignIn || stepUp || linking || query?.app !== undefined || query?.desktopHandoff !== undefined || query?.mobile !== undefined || query?.handoff !== undefined)) {
      return sendApiError(reply, 400, "RESET_UNAVAILABLE", "Reset your password from the SpaceApp sign-in page in a browser.");
    }
    // A desktop sign-in must name the desktop app's loopback port and PKCE challenge; a bare handoff id would hand the
    // session to whoever chose it (run-spaceapp 1.1.7 review, Codex finding 1).
    const desktopBinding = query?.desktopHandoff === undefined ? null
      : parseDesktopAuthHandoffBinding({ handoffId: query.desktopHandoff, port: query.desktopPort, codeChallenge: query.desktopChallenge });
    if (query?.desktopHandoff !== undefined && !desktopBinding) {
      return sendApiError(reply, 400, "DESKTOP_HANDOFF_UNBOUND", "This desktop sign-in link is not bound to a SpaceApp desktop app. Update the desktop app and start the sign-in from it again.");
    }
    // A mobile app names itself, its S256 challenge and its state; its redirect URI comes from the contracts map, never the link.
    const appBinding = query?.app === undefined ? null : parseAppSignInBinding({ app: query.app, challenge: query.challenge, state: query.state });
    if (query?.app !== undefined && (!appBinding || !options.appSignIn)) {
      return sendApiError(reply, 400, "APP_HANDOFF_UNBOUND", "This app sign-in link names an unknown app or lacks its S256 challenge and state. Start the sign-in from the app again.");
    }
    const pkce = generatePkcePair();
    const nonce = randomBytes(16).toString("hex");
    const rawState = Buffer.from(JSON.stringify({
      nonce, expiresAt: Date.now() + 600_000,
      userId: ticket?.userId ?? (linking || stepUp ? request.user!.id : null),
      sessionHash: ticket?.sessionHash ?? (linking || stepUp ? createHash("sha256").update(request.cookies[cookieName]!).digest("hex") : null),
      codeChallenge: pkce.codeChallenge,
      // A step-up sends its nonce to Google too: an ID token without auth_time passes only with this nonce and an iat after startedAt.
      ...(stepUp ? { stepUp: true, startedAt: Date.now() } : {}),
      ...(reset ? { reset: true, startedAt: Date.now() } : {}),
      ...(ticket ? { appState: ticket.state } : {}),
      // SpaceApp Android's Web tab: linking finishes in the phone's browser and comes back to the WebView (APP_WEBVIEW_RETURN_URIS).
      ...(linking && !stepUp && appWebViewOf(request.headers["user-agent"]) ? { webView: appWebViewOf(request.headers["user-agent"]) } : {})
    })).toString("base64url");
    const state = signOAuthState(rawState, auth.sessionSecret);
    const signedPkce = signOAuthState(pkce.codeVerifier, auth.sessionSecret);
    const redirectUri = googleRedirectUriFor(request, auth, config.port);

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
      codeChallenge: pkce.codeChallenge,
      ...(stepUp ? { reauth: { loginHint: ticket?.email ?? request.user!.email, nonce } } : reset ? { reauth: { nonce } } : {})
    });

    if (desktopBinding) {
      reply.setCookie("space_oauth_desktop_handoff", encodeDesktopAuthHandoffCookie(desktopBinding), {
        httpOnly: true,
        secure: auth.secureCookies,
        sameSite: "lax",
        path: "/",
        maxAge: 600
      });
    } else {
      reply.clearCookie("space_oauth_desktop_handoff", { path: "/" });
    }
    if (appBinding) {
      reply.setCookie(APP_SIGNIN_COOKIE, encodeAppSignInCookie(appBinding), { httpOnly: true, secure: auth.secureCookies, sameSite: "lax", path: "/", maxAge: 600 });
    } else {
      reply.clearCookie(APP_SIGNIN_COOKIE, { path: "/" });
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
  // The step-up of an ADMIN's SpaceApp Android session (R10, SpaceApp Android 0.2.13): Google refuses its web sign-in inside the app, so the
  // app signs in to Google itself and sends the id token. Checked like the web's callback (the person's own Google account, signed in at
  // most 5 minutes ago) and marks only this session (mobile/routes.ts).
  // Written at each route so the limit stays visible to CodeQL and route-rate-limits.test.ts.
  const appStepUpRateLimit = { max: 10, timeWindow: "15 minutes" };
  /** An ADMIN's SpaceApp Android session, a person's: null when it may step up, else the reply already sent. */
  const appStepUpRefused = (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Sign in to SpaceApp first.");
    options.appSignIn?.assertPerson(request);
    if (!options.appSignIn || request.appSession !== "spaceapp" || request.user.role !== "ADMIN" || isGoogleProofSession(request)) {
      return sendApiError(reply, 403, "FORBIDDEN", "Only an administrator's SpaceApp Android session confirms it is you here.");
    }
    return null;
  };
  // R10b: Android's native Google sign-in gives no auth_time, so the phone runs the web's step-up in its system browser with a ticket;
  // the callback marks this session and sends the browser back to the app (com.oll4.spaceapp:/oauth2redirect?stepUp=done|failed&state=).
  app.post("/api/auth/app/step-up/start", { config: { ...defaultRouteRateLimitOptions.config, rateLimit: appStepUpRateLimit } }, async (request, reply) => {
    const refused = appStepUpRefused(request, reply);
    if (refused) return refused;
    const input = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }).strict().safeParse(request.body ?? {});
    if (!input.success) return sendApiError(reply, 400, "INVALID_INPUT", "The body takes only state (16-64 letters, digits, - or _).");
    const ticket = options.appSignIn!.stepUp.issue({ sessionHash: createHash("sha256").update(request.cookies[cookieName] ?? "").digest("hex"),
      userId: request.user!.id, email: request.user!.email, state: input.data.state });
    return { url: `/api/auth/google/start?stepUp=mobile&ticket=${ticket}` };
  });
  app.post("/api/auth/app/step-up", { config: { ...defaultRouteRateLimitOptions.config, rateLimit: appStepUpRateLimit } }, async (request, reply) => {
    const refused = appStepUpRefused(request, reply);
    if (refused) return refused;
    const user = request.user!, signIn = options.appSignIn!;
    const input = z.object({ idToken: z.string().min(1).max(16_384) }).strict().safeParse(request.body ?? {});
    if (!input.success) return sendApiError(reply, 400, "INVALID_INPUT", "The body takes only idToken (a Google id token).");
    const googleInfo = await verifyGoogleIdToken({ idToken: input.data.idToken, clientId: auth.googleClientId }).catch(() => null);
    const owner = googleInfo ? await store.getUserByGoogleId?.(googleInfo.sub) : null;
    const refusal = googleInfo && owner?.id === user.id ? googleStepUpRefusal(googleInfo) : null;
    if (!googleInfo || owner?.id !== user.id || refusal) {
      return sendApiError(reply, 403, "STEP_UP_FAILED", refusal?.message ?? "Sign in with your own Google account, with its password, to confirm it is you.");
    }
    signIn.stepUp.mark(createHash("sha256").update(request.cookies[cookieName] ?? "").digest("hex"));
    await recordAudit(store, request, { actorUserId: user.id, action: "auth.step_up", targetType: "user", targetId: user.id, metadata: { purpose: "mobile", via: "spaceapp" } });
    return { steppedUp: true, until: new Date(Date.now() + 5 * 60_000).toISOString() };
  });
  // A step-up with the person's own SpaceApp password (ADR-013's open item: installs without Google sign-in, and Google accounts whose
  // ID token carries no auth_time): typing it proves what a fresh Google sign-in proves. A web session of a person only; marks this session.
  app.post("/api/auth/step-up/password", { config: { ...defaultRouteRateLimitOptions.config, rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Sign in to SpaceApp first.");
    options.appSignIn?.assertPerson(request);
    if (!options.appSignIn || request.appSession || isGoogleProofSession(request)) {
      return sendApiError(reply, 403, "FORBIDDEN", "Confirm it is you from SpaceApp on a computer.");
    }
    const input = z.object({ password: z.string().min(1).max(1024) }).strict().safeParse(request.body ?? {});
    if (!input.success) return sendApiError(reply, 400, "INVALID_INPUT", "The body takes only password.");
    const user = request.user;
    const owner = await store.getOwnerCredentials();
    const account = owner?.user.id === user.id ? owner : await store.getPasswordUser?.(user.email) ?? null;
    // A Google-only account has no password: hash a decoy so the answer takes the same time.
    const matches = await verifyPassword(input.data.password, account?.user.id === user.id ? account.passwordHash : await (decoyHash ??= hashPassword(randomBytes(16).toString("hex"))));
    // An install whose operator lives only in .env (no owner row, as stable) signs in through authenticateLogin: the step-up takes the same password.
    // With .env's email, not the session's: a Google sign-in's session carries the users row's email, which can differ (d130a43784, stable 7/11).
    const envEmail = user.id === "user:operator" && auth.operatorEmail ? auth.operatorEmail : user.email;
    const envLogin = auth.devLogin || !owner ? await authenticateLogin({ email: envEmail, password: input.data.password }, auth) : null;
    // Login stores that user under the row holding its email (upsertUser), whose id need not be "user:operator" (stable 7/11): compare that row.
    const envOperator = envLogin !== null && (await store.getControlActor(envLogin.id, envLogin.email))?.id === user.id;
    if (!envOperator && (!matches || account?.user.id !== user.id)) {
      await recordAudit(store, request, { actorUserId: user.id, action: "auth.step_up_failed", targetType: "user", targetId: user.id, metadata: { purpose: "mobile", via: "password" } });
      return sendApiError(reply, 403, "STEP_UP_FAILED", "That is not your SpaceApp password.");
    }
    options.appSignIn.stepUp.mark(createHash("sha256").update(request.cookies[cookieName] ?? "").digest("hex"));
    await recordAudit(store, request, { actorUserId: user.id, action: "auth.step_up", targetType: "user", targetId: user.id, metadata: { purpose: "mobile", via: "password" } });
    return { steppedUp: true, until: new Date(Date.now() + 5 * 60_000).toISOString() };
  });
  // Settings → Login password (operator 12/11, nous_msg:ab7d29cfda7e438b8bbb1e9a): the owner or an invited user changes their own password,
  // proven by the current one or by this session's fresh step-up (Google or password, 5 minutes). Same hash column as `owner reset-password`.
  app.post("/api/auth/password", { config: { ...defaultRouteRateLimitOptions.config, rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Sign in to SpaceApp first.");
    options.appSignIn?.assertPerson(request);
    if (request.appSession || isGoogleProofSession(request)) return sendApiError(reply, 403, "FORBIDDEN", "Change your password from SpaceApp on a computer.");
    const input = z.object({ currentPassword: z.string().min(1).max(1024).optional(), newPassword: acceptUserInviteInputSchema.shape.password }).strict()
      .safeParse(request.body ?? {});
    if (!input.success) return sendApiError(reply, 400, "INVALID_INPUT", "The new password needs 12 to 500 characters.");
    const user = request.user;
    const owner = await store.getOwnerCredentials();
    const isOwner = owner?.user.id === user.id;
    // The operator defined only in .env signs in as the users row holding SPACE_OPERATOR_EMAIL (upsertUser): its new password becomes the
    // owner's stored one, which wins over the .env hash from then on (task 12/11). The .env hash stays the host's recovery (the onReady hook).
    const envRow = !owner && envPasswordSha256 && auth.operatorEmail ? await store.getControlActor(user.id, auth.operatorEmail) : null;
    const envOperator = envRow?.id === user.id && envRow.email.toLowerCase() === auth.operatorEmail?.toLowerCase();
    const account = isOwner ? owner : envOperator ? { user, passwordHash: auth.operatorPasswordHash! } : await store.getPasswordUser?.(user.email) ?? null;
    if (account?.user.id !== user.id || (!isOwner && !envOperator && !store.updateUserPassword)) {
      // A Google-only account has no password to replace.
      return sendApiError(reply, 409, "PASSWORD_NOT_STORED", "This account has no SpaceApp password to change: it signs in with Google.");
    }
    if (input.data.currentPassword !== undefined) {
      if (!await verifyPassword(input.data.currentPassword, account.passwordHash)) {
        await recordAudit(store, request, { actorUserId: user.id, action: "auth.password_change_failed", targetType: "user", targetId: user.id, metadata: { reason: "wrong_current" } });
        return sendApiError(reply, 401, "INVALID_CREDENTIALS", "Your current password is not right.");
      }
    } else if (!options.appSignIn?.stepUp.fresh(request)) {
      return sendApiError(reply, 403, "STEP_UP_REQUIRED", "Type your current password, or confirm it is you with Google first.", { stepUpUrl: "/api/auth/google/start?stepUp=mobile" });
    }
    const passwordHash = await hashPassword(input.data.newPassword);
    if (isOwner) await store.updateOwnerPassword(passwordHash);
    else if (!await (envOperator ? store.adoptOwnerPassword(user.id, passwordHash, envPasswordSha256!) : store.updateUserPassword!(user.id, passwordHash))) {
      return sendApiError(reply, 409, "PASSWORD_NOT_STORED", "This account has no stored password to replace.");
    }
    // Every other session ends (as logout-all), even one issued this second (iat is whole seconds); this one gets a cookie issued at the epoch.
    const epochMs = (Math.floor(Date.now() / 1000) + 1) * 1000;
    const currentToken = request.cookies[cookieName];
    const saved = await revocationsSaved(defaultSessionRevocationStore.revokeUser(user.id, epochMs),
      ...(currentToken ? [defaultSessionRevocationStore.revokeToken(currentToken)] : []));
    reply.setCookie(cookieName, signSession(user, auth.sessionSecret, epochMs), { httpOnly: true, secure: auth.secureCookies, sameSite: "lax", path: "/", maxAge: operatorSessionTtlSeconds });
    await recordAudit(store, request, { actorUserId: user.id, action: "auth.password_changed", targetType: "user", targetId: user.id,
      metadata: { role: user.role, via: input.data.currentPassword !== undefined ? "current_password" : "step_up", otherSessionsEnded: saved, ...(envOperator ? { replacedEnvPassword: true } : {}) } });
    if (!saved) return sendApiError(reply, 503, "LOGOUT_NOT_SAVED", "Your password changed and your other sessions ended, but that could not be saved yet; Space keeps retrying. Until it is saved, an API restart would accept them again.");
    return { ok: true };
  });

  // Forgot password by mail (operator 13/11, Nous option A): a single-use link to the owner's stored address, sent through the
  // owner's Mail Campaigns sender as one transactional mail. Only the owner (or the .env operator) has one; invited users ask the owner.
  // shortcut: pending links live in memory, so an API restart voids them (fail closed); move them to the store if that bites.
  const passwordResets = new Map<string, { tokenHash: string; bindHash: string; passwordSha: string; expiresAt: number }>();
  const resetRequestTimes = new Map<string, number[]>();
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const RESET_COOKIE = "space_pwreset", RESET_PATH = "/api/auth/password-reset", RESET_TTL_MS = 30 * 60_000;
  async function resetAccount(): Promise<{ userId: string; email: string; passwordHash: string; env: boolean } | null> {
    const owner = await store.getOwnerCredentials();
    if (owner) return { userId: owner.user.id, email: owner.user.email, passwordHash: owner.passwordHash, env: false };
    if (!auth.operatorEmail || !auth.operatorPasswordHash) return null;
    const row = await store.getControlActor("user:operator", auth.operatorEmail);
    return row?.email.toLowerCase() === auth.operatorEmail.toLowerCase() ? { userId: row.id, email: auth.operatorEmail, passwordHash: auth.operatorPasswordHash, env: true } : null;
  }
  // The link's origin is the configured Google redirect's, never the request's Host (a forged Host would mail a poisoned link); a request
  // on another host (a clone with a copied .env, or dev without one) mails nothing.
  function resetLinkOrigin(request: FastifyRequest): string | null {
    try {
      const configured = new URL(auth.googleRedirectUri ?? "");
      return configured.protocol === "https:" && new URL(requestOrigin(request, auth.secureCookies, config.port)).hostname === configured.hostname ? configured.origin : null;
    } catch { return null; }
  }
  const signedInRefusal = (reply: FastifyReply) => sendApiError(reply, 403, "SIGNED_IN", "You are signed in: change your password in Settings, Login password.");
  app.post(`${RESET_PATH}/request`, { config: { ...defaultRouteRateLimitOptions.config, rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.user) return signedInRefusal(reply);
    const input = z.object({ email: z.string().trim().min(3).max(320) }).strict().safeParse(request.body ?? {});
    if (!input.success) return sendApiError(reply, 400, "INVALID_INPUT", "Type the email you sign in with.");
    // Binds the link to this browser: whoever reads the mail elsewhere (an agent reading the mailbox) cannot use it.
    const bind = randomBytes(32).toString("base64url");
    reply.setCookie(RESET_COOKIE, bind, { httpOnly: true, secure: auth.secureCookies, sameSite: "strict", path: RESET_PATH, maxAge: RESET_TTL_MS / 1000 });
    // The answer never waits for the lookup or the mail, so neither its words nor its time say whether the account exists.
    void mailPasswordReset(request, input.data.email, sha256(bind)).catch((error) => request.log.error({ err: error }, "The password reset mail could not be sent."));
    return { ok: true };
  });
  async function mailPasswordReset(request: FastifyRequest, email: string, bindHash: string) {
    const account = await resetAccount();
    if (!account || email.toLowerCase() !== account.email.toLowerCase()) return;
    const now = Date.now();
    const recent = (resetRequestTimes.get(account.userId) ?? []).filter((at) => at > now - 60 * 60_000);
    const origin = resetLinkOrigin(request), send = options.passwordResetMail?.current;
    const refused = recent.length >= 3 ? "account_rate_limit" : !origin ? "untrusted_origin" : !send ? "no_sender" : null;
    if (!refused) resetRequestTimes.set(account.userId, [...recent, now]);
    await recordAudit(store, request, { actorUserId: account.userId, action: "auth.password_reset_requested", targetType: "user", targetId: account.userId,
      metadata: { mailed: !refused, ...(refused ? { reason: refused } : {}) } });
    if (refused) return;
    const token = randomBytes(32).toString("base64url");
    passwordResets.set(account.userId, { tokenHash: sha256(token), bindHash, passwordSha: sha256(account.passwordHash), expiresAt: now + RESET_TTL_MS });
    await send!(account.userId, account.email, "Reset your SpaceApp password", [
      `Someone asked to reset the password you use to sign in to SpaceApp at ${origin}.`, "",
      "To choose a new one, open this link within 30 minutes, in the same browser where you asked for it:", `${origin}/#password-reset=${token}`, "",
      "The link works once. If you did not ask for it, ignore this mail: your password stays as it is."].join("\n"));
  }
  app.post(`${RESET_PATH}/complete`, { config: { ...defaultRouteRateLimitOptions.config, rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    // Like assertPerson: no session at all, so no agent, broker, proof or capture session (nor a signed-in person, who uses Settings).
    if (request.user) return signedInRefusal(reply);
    const input = z.object({ token: z.string().min(32).max(200), newPassword: acceptUserInviteInputSchema.shape.password }).strict().safeParse(request.body ?? {});
    if (!input.success) return sendApiError(reply, 400, "INVALID_INPUT", "The new password needs 12 to 500 characters.");
    const account = await resetAccount();
    const pending = account ? passwordResets.get(account.userId) : undefined;
    const bind = request.cookies[RESET_COOKIE];
    if (!account || !pending || pending.tokenHash !== sha256(input.data.token)) {
      return sendApiError(reply, 400, "RESET_LINK_INVALID", "This reset link does not work any more: it was used, it expired, or a newer one was sent. Ask for a new one.");
    }
    passwordResets.delete(account.userId);  // single use: a try with the right token spends it, whatever else fails
    const reason = pending.expiresAt <= Date.now() ? "expired" : pending.passwordSha !== sha256(account.passwordHash) ? "password_changed" : !bind || sha256(bind) !== pending.bindHash ? "other_browser" : null;
    if (reason) {
      await recordAudit(store, request, { actorUserId: account.userId, action: "auth.password_reset_failed", targetType: "user", targetId: account.userId, metadata: { reason } });
      return sendApiError(reply, 400, "RESET_LINK_INVALID", reason === "other_browser"
        ? "Open the reset link in the same browser where you asked for it. Ask for a new one there." : "This reset link does not work any more. Ask for a new one.");
    }
    const passwordHash = await hashPassword(input.data.newPassword);
    if (account.env ? !await store.adoptOwnerPassword(account.userId, passwordHash, envPasswordSha256!) : (await store.updateOwnerPassword(passwordHash), false)) {
      return sendApiError(reply, 409, "PASSWORD_NOT_STORED", "This account has no stored password to replace.");
    }
    const saved = await revocationsSaved(defaultSessionRevocationStore.revokeUser(account.userId, (Math.floor(Date.now() / 1000) + 1) * 1000));
    reply.clearCookie(RESET_COOKIE, { path: RESET_PATH });
    await recordAudit(store, request, { actorUserId: account.userId, action: "auth.password_reset", targetType: "user", targetId: account.userId,
      metadata: { via: "mail", otherSessionsEnded: saved, ...(account.env ? { replacedEnvPassword: true } : {}) } });
    void options.passwordResetMail?.current?.(account.userId, account.email, "Your SpaceApp password was reset", [
      `Your SpaceApp password was reset at ${new Date().toISOString()} through a reset link, and every session signed in with the old one ended.`, "",
      "If this was not you, sign in with Google if you can, set a new password in Settings, and check Settings for devices and sessions."].join("\n"))
      .catch((error) => request.log.error({ err: error }, "The password reset notice could not be sent."));
    if (!saved) return sendApiError(reply, 503, "LOGOUT_NOT_SAVED", "Your password changed, but ending the old sessions could not be saved yet; Space keeps retrying. Sign in with the new password.");
    return { ok: true };
  });
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
    const desktopHandoff = decodeDesktopAuthHandoffCookie(request.cookies["space_oauth_desktop_handoff"]);
    const appHandoff = decodeAppSignInCookie(request.cookies[APP_SIGNIN_COOKIE]);
    for (const name of ["space_oauth_state", "space_oauth_pkce", "space_oauth_link_user", "space_oauth_desktop_handoff", "space_oauth_mobile", APP_SIGNIN_COOKIE]) reply.clearCookie(name, { path: "/" });
    const verifiedState = verifyOAuthState(state, auth.sessionSecret);
    let transaction: { nonce?: string; userId: string | null; sessionHash: string | null; codeChallenge: string; expiresAt: number; stepUp?: boolean; reset?: boolean; startedAt?: number;
      appState?: string; webView?: AppWebViewId } | null = null;
    try {
      transaction = z.object({ nonce: z.string().min(16).optional(), userId: z.string().nullable(), sessionHash: z.string().nullable(), codeChallenge: z.string().min(43),
        expiresAt: z.number(), stepUp: z.literal(true).optional(), reset: z.literal(true).optional(), startedAt: z.number().optional(), appState: z.string().optional(), webView: appWebViewIdSchema.optional() })
        .parse(JSON.parse(Buffer.from(verifiedState ?? "", "base64url").toString("utf8")));
    } catch { /* Reject malformed and legacy transactions; a fresh start is safe. */ }
    // SpaceApp Android: a link started in the Web tab ended in the phone's browser, without the WebView's cookies; the WebView finishes it.
    if (!savedState && state && transaction?.webView && transaction.expiresAt > Date.now()) return reply.redirect(appWebViewReturnUrl(transaction.webView, request.url));
    const errorKey = transaction?.stepUp ? "mobileStepUpError" : transaction?.userId || linkCookie ? "googleLinkError" : "authError";
    // A phone's step-up (R10b, its state signed in the transaction) ends in the app whatever went wrong.
    const appState = transaction?.stepUp ? transaction.appState : undefined;
    // A refused step-up leaves its reason code in the log and the audit (auth.step_up_failed): never a code, token or address (R10b, Nous 4/11).
    const fail = async (message: string, reason: string) => {
      if (transaction?.stepUp) {
        request.log.warn({ event: "MOBILE_STEP_UP_FAILED", reason }, "Mobile step-up refused");
        await recordAudit(store, request, { actorUserId: transaction.userId, action: "auth.step_up_failed", targetType: "user", targetId: transaction.userId,
          metadata: { purpose: "mobile", reason, ...(appState ? { via: "spaceapp-browser" } : {}) } })
          .catch(() => request.log.warn({ event: "MOBILE_STEP_UP_AUDIT_FAILED", reason }, "Mobile step-up refusal not audited")); // the redirect still goes back
      }
      return reply.redirect(appState ? appStepUpReturn("failed", appState) : `/?${errorKey}=${encodeURIComponent(message)}`);
    };
    if (!state || state !== savedState || !verifiedState || !transaction || transaction.expiresAt <= Date.now()) {
      return fail("Invalid or expired Google OAuth state. Try signing in again.",
        !savedState ? "STATE_COOKIE_MISSING" : state !== savedState ? "STATE_MISMATCH" : transaction ? "STATE_EXPIRED" : "STATE_INVALID");
    }
    if (query?.error) return fail("Google authentication was cancelled or failed.", "GOOGLE_ERROR");
    if (!code) return fail("Google authorization code is missing. Try signing in again.", "CODE_MISSING");
    const codeVerifier = verifyOAuthState(pkceCookie, auth.sessionSecret);
    if (!codeVerifier || createHash("sha256").update(codeVerifier).digest("base64url") !== transaction.codeChallenge) {
      return fail("Invalid or expired Google PKCE session. Try signing in again.", codeVerifier ? "PKCE_MISMATCH" : "PKCE_COOKIE_MISSING");
    }
    let linkUser: AuthUser | null = null;
    if (transaction.stepUp && appState) {
      // The phone's system browser: its ticket named the app session and user; no SpaceApp session here.
      if (!options.appSignIn || !transaction.userId || !transaction.sessionHash || isGoogleProofSession(request) || linkCookie) {
        return fail("", !options.appSignIn ? "APP_SIGNIN_OFF" : linkCookie ? "LINK_COOKIE" : isGoogleProofSession(request) ? "PROOF_SESSION" : "TICKET_INCOMPLETE");
      }
    } else if (transaction.stepUp) {
      // The same person in the same browser session that asked for the step-up.
      if (!options.appSignIn || !request.user || request.user.id !== transaction.userId || isGoogleProofSession(request) || request.appSession || linkCookie ||
        transaction.sessionHash !== createHash("sha256").update(request.cookies[cookieName] ?? "").digest("hex")) {
        return fail("Sign in to SpaceApp in this browser, then confirm it is you again.", "BROWSER_SESSION_MISMATCH");
      }
    } else if (transaction.userId) {
      linkUser = verifySession(linkCookie, auth.sessionSecret);
      if (!linkUser || linkUser.id !== transaction.userId || isGoogleProofSession(request) || !request.user || request.user.id !== transaction.userId ||
        transaction.sessionHash !== createHash("sha256").update(request.cookies[cookieName] ?? "").digest("hex")) {
        return fail("You must be actively logged into the original account linking session. Please try again.", "LINK_SESSION_MISMATCH");
      }
    } else if (linkCookie) {
      return fail("Invalid account linking session. Please try again.", "LINK_COOKIE");
    }

    const redirectUri = googleRedirectUriFor(request, auth, config.port);

    try {
      const googleInfo = await exchangeGoogleCode({
        code,
        clientId: auth.googleClientId,
        clientSecret: auth.googleClientSecret,
        redirectUri,
        codeVerifier
      });

      if (transaction.stepUp) {
        const owner = await store.getUserByGoogleId?.(googleInfo.sub);
        if (owner?.id !== transaction.userId) return fail("Sign in with your own Google account, with its password, to confirm it is you.", "WRONG_GOOGLE_ACCOUNT");
        const refusal = googleStepUpRefusal(googleInfo, undefined, transaction.nonce && transaction.startedAt !== undefined
          ? { nonce: transaction.nonce, startedAtS: Math.floor(transaction.startedAt / 1000) } : undefined);
        if (refusal) return fail(refusal.message, refusal.reason);
        options.appSignIn!.stepUp.mark(transaction.sessionHash!);
        await recordAudit(store, request, { actorUserId: transaction.userId!, action: "auth.step_up", targetType: "user", targetId: transaction.userId!,
          metadata: { purpose: "mobile", fresh: googleInfo.authTime !== undefined ? "auth_time" : "nonce_iat", ...(appState ? { via: "spaceapp-browser" } : {}) } });
        return reply.redirect(appState ? appStepUpReturn("done", appState) : "/?mobileStepUp=ok");
      }

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

      if (transaction.reset) {
        const refusal = googleStepUpRefusal(googleInfo, undefined, transaction.nonce && transaction.startedAt !== undefined
          ? { nonce: transaction.nonce, startedAtS: Math.floor(transaction.startedAt / 1000) } : undefined);
        if (refusal) return fail(refusal.message, refusal.reason);
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
      if (transaction.reset) {
        // The start refused app, desktop and phone hand-offs: this browser's new session may set a password without the old one for 5 minutes.
        options.appSignIn!.stepUp.mark(createHash("sha256").update(token).digest("hex"));
        await recordAudit(store, request, { actorUserId: user.id, action: "auth.step_up", targetType: "user", targetId: user.id, metadata: { purpose: "password_reset", via: "google_sign_in" } });
        return reply.redirect("/?mobileStepUp=ok");
      }

      if (desktopHandoff) {
        // The one-time code goes only to the desktop app's loopback listener on this machine; the app redeems it with
        // the PKCE verifier it kept (POST /api/auth/desktop-handoff).
        const handoffCode = randomBytes(32).toString("base64url");
        desktopAuthHandoffs.store(desktopHandoff.handoffId, {
          token,
          user: { id: user.id, email: user.email, role: user.role },
          code: handoffCode,
          codeChallenge: desktopHandoff.codeChallenge
        });
        return reply.redirect(desktopAuthHandoffRedirect(desktopHandoff, handoffCode));
      }

      if (appHandoff && options.appSignIn) {
        // Owner only while multi-user is off (Nous decision 2026-10-23).
        if (!config.multiUserEnabled && user.role !== "ADMIN") return fail("App sign-in is only for the operator's own account.", "NOT_OPERATOR");
        return reply.redirect(await options.appSignIn.issue(appHandoff, user, request));
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
      return fail(clientMessage, "GOOGLE_EXCHANGE_FAILED");
    }
  });
  app.post("/api/auth/desktop-handoff", defaultRouteRateLimitOptions, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = (request.body ?? {}) as Record<string, unknown>;
    // Single use and time-limited: a wrong code or verifier burns the handoff, an unclaimed one expires on its own.
    const entry = desktopAuthHandoffs.redeem(String(body.handoffId ?? ""), body.code, body.codeVerifier);
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
