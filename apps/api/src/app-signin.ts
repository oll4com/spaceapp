import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  APP_DEVICE_SESSION_TTL_SECONDS, APP_DEVICE_SESSIONS_MAX, APP_HANDOFF_CODE_TTL_MS, APP_SIGNIN_REDIRECT_URIS, appDeviceSessionIdSchema, appHandoffRedeemSchema,
  appSignInChallengeSchema, appSignInIdSchema, appSignInStateSchema, type AppDeviceSession, type AppSignInId, type AuthUser, type NotificationRaiseInput, type SpaceNotification
} from "@space/contracts";
import { InMemoryAppDeviceSessionRepository, PostgresAppDeviceSessionRepository, type AppDeviceSessionRecord, type AppDeviceSessionRepository } from "@space/db";
import { makeSpaceId, type SpaceStore } from "@space/runtime";
import { cookieName, operatorSessionTtlSeconds, sessionIdHash, sessionIdOfToken, signSession, signedSessionPayload, verifySession, type SessionRevocationStore } from "./auth.js";
import { createDesktopAuthHandoffStore } from "./desktop-auth-handoffs.js";
import type { ConnectorCrypto } from "./dot-connectors.js";
import { sendApiError } from "./http-errors.js";
export { installMobileGate } from "./mobile/gate.js";
import { MOBILE_PAIRING_CONFIRM_MS, registerMobileChannel } from "./mobile/channel.js";
import { createMobileChecks } from "./mobile/checks.js";
import { createPlayIntegrity } from "./mobile/integrity.js";
import { setMobileChecks } from "./mobile/gate.js";
import { registerMobileRoutes } from "./mobile/routes.js";
import { createMobileWake } from "./mobile/wake.js";
import type { MobileWake } from "./notifications/service.js";
import { linkLease } from "./instance-link/lease.js";
import { registerInstanceLinks } from "./instance-link/routes.js";
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

export const MOBILE_STEP_UP_MS = 5 * 60_000;
export const MOBILE_STEP_UP_TICKET_MS = 2 * 60_000;
export interface StepUpTicket { sessionHash: string; userId: string; email: string; state: string }
/** The app's own redirect URI with the step-up's outcome and the state it sent (R10b). */
export const appStepUpReturn = (result: "done" | "failed", state: string) =>
  `${APP_SIGNIN_REDIRECT_URIS.spaceapp}?${new URLSearchParams({ stepUp: result, state })}`;
const codeKey = (code: string) => createHash("sha256").update(code).digest("hex");
const publicRow = (row: AppDeviceSessionRecord): AppDeviceSession => ({ id: row.id, app: row.app, deviceName: row.deviceName, createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt,
  ...(row.noisePublic ? { paired: { scopes: row.scopes ?? [], requestedScopes: row.requestedScopes ?? [], allowedAt: row.confirmedAt, lastSeenAt: row.lastSeenAt, decide: row.decideSecurityLevel } } : {}) });

export interface AppSignInOptions {
  store: Pick<SpaceStore, "upsertUser" | "recordAuditEvent" | "getControlActor" | "getArtifact" | "getOwnerCredentials">;
  repository: AppDeviceSessionRepository;
  revocations: Pick<SessionRevocationStore, "revokeSessionHash">;
  sessionSecret: string;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  persistRevocation: (pending: Promise<void>) => Promise<void>;
  /** A paired phone's URGENT "New device paired" card, resolved when it is allowed, revoked or expires (Nous Pro 1b-5a). */
  notifications?: { raise(input: NotificationRaiseInput): Promise<unknown>; resolve(owner: string, dedupeKey: string, reason?: string): Promise<number>;
    get(owner: string, id: string): Promise<SpaceNotification | null>; setWake?(sender: MobileWake | null): void };
  /** Nous Pro phase 2b: the SpaceApp relay and push service (SPACE_MOBILE_RELAY_URL, SPACE_MOBILE_PUSH_URL); unset: off. */
  mobileRelayUrl?: string | null;
  mobilePushUrl?: string | null;
  /** Demo mode (SPACE_MOBILE_DEMO=1 on a public install): "Try the demo"'s standing offer, phones allowed at once (mobile/routes.ts, channel.ts). */
  mobileDemo?: boolean;
  /** Play Integrity's service account file (SPACE_PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE); null or absent: not checked. */
  playIntegrityFile?: string | null;
  /** An open Nous decision, for a phone's signed answer (design §7). */
  decision?: Parameters<typeof createMobileChecks>[0]["decision"];
  goal?: Parameters<typeof createMobileChecks>[0]["goal"];
  now?: () => number;
}
export type AppSignIn = ReturnType<typeof createAppSignIn>;

/** The composition root's one call: the repository (PostgreSQL when the store is), the module and its routes. */
export function registerAppSignIn(app: FastifyInstance, options: Omit<AppSignInOptions, "repository"> & { databaseUrl: string | null | undefined; crypto?: ConnectorCrypto;
  /** This SpaceApp's version, sent as a link's appVersion to the SpaceApps it manages (Space Link, ADR-014). */
  version?: string;
  events?: Parameters<typeof registerMobileChannel>[1]["events"] } & Pick<Parameters<typeof registerMobileChannel>[1], "google" | "gmailFetch">): AppSignIn {
  const repository = options.databaseUrl ? PostgresAppDeviceSessionRepository.fromConnectionString(options.databaseUrl) : new InMemoryAppDeviceSessionRepository();
  const signIn = createAppSignIn({ ...options, repository });
  signIn.register(app);
  // Settings > Mobile app (Nous Pro 1b, ADR-013): the Devices person check. The mobile gate itself is installed by app.ts.
  if (options.crypto) {
    // The channel registers after the routes, so a revoke reaches its live sessions through this late binding.
    let channel: ReturnType<typeof registerMobileChannel> | undefined;
    const integrity = createPlayIntegrity(options.playIntegrityFile ?? null);
    // Every revoke (Settings › Devices, a held phone's expiry, the per-app cap, C3) ends the phone's open channel at once (plan kTV3y2lwO-99 item 5).
    signIn.onRevoked((ids) => channel?.closeDevices(ids));
    const revokePaired = async () => (await signIn.revokePaired()).map((row) => row.id);
    const mobile = registerMobileRoutes(app, { store: options.store, crypto: options.crypto, databaseUrl: options.databaseUrl, routeOptions: options.routeOptions, assertPerson: signIn.assertPerson, stepUp: signIn.stepUp, revokePaired,
      relay: options.mobileRelayUrl ? { offered: () => channel?.relayOffered() } : null, demo: options.mobileDemo === true });
    channel = registerMobileChannel(app, { keys: mobile.keys, keyRepository: mobile.repository, offers: mobile.offers, devices: repository, store: options.store, notifications: options.notifications,
      sessionSecret: options.sessionSecret, routeOptions: options.routeOptions, events: options.events, expireHeld: signIn.expireHeld, revokeDevice: signIn.revokeDevice, now: options.now,
      google: options.google, gmailFetch: options.gmailFetch, relayUrl: options.mobileRelayUrl, integrity });
    // Space Link's Remote mark (ADR-014): the sessions open on this SpaceApp now, its linked SpaceApps' Nous and its phones. A person on a
    // computer only: a phone or a link never reads another device's address.
    // Lease (lease.ts): which link manages this SpaceApp now; Take back holds every link at reading until Give back.
    const lease = linkLease(options.store, options.now);
    const liveOwner = (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return void sendApiError(reply, 401, "UNAUTHORIZED", "Sign in to see your devices.");
      signIn.assertPerson(request);
      if (request.appSession) return void sendApiError(reply, 403, "MOBILE_ALLOW_FROM_COMPUTER", "Open SpaceApp on a computer to see who is connected.");
      return request.user.id;
    };
    const liveAnswer = (owner: string) => ({ sessions: channel!.live(owner), lease: lease.holder(owner), takenBackAt: lease.takenBackAt(owner) });
    app.get("/api/auth/devices/live", options.routeOptions, async (request, reply) => {
      const owner = liveOwner(request, reply);
      return owner ? liveAnswer(owner) : reply;
    });
    for (const [path, action] of [["take-back", "instance_link.taken_back"], ["give-back", "instance_link.given_back"]] as const) {
      app.post(`/api/auth/devices/live/${path}`, options.routeOptions, async (request, reply) => {
        const owner = liveOwner(request, reply);
        if (!owner) return reply;
        if (path === "take-back") lease.takeBack(owner); else lease.giveBack(owner);
        await recordAudit(options.store, request, { action, targetType: "user", targetId: owner });
        return liveAnswer(owner);
      });
    }
    if (options.mobilePushUrl) options.notifications?.setWake?.(createMobileWake({ url: options.mobilePushUrl, devices: repository, log: app.log }));
    setMobileChecks(app, createMobileChecks({ devices: repository, artifact: async (id) => options.store.getArtifact(id),
      notification: async (owner, id) => (await options.notifications?.get(owner, id)) ?? null, decision: options.decision ?? (async () => null),
      goal: options.goal ?? (async () => null), integrity }));
    // Space Link (ADR-014): the other SpaceApps this one manages, each paired as a spaceapp-link device of it.
    registerInstanceLinks(app, { store: options.store, crypto: options.crypto, databaseUrl: options.databaseUrl, routeOptions: options.routeOptions,
      assertPerson: signIn.assertPerson, version: options.version ?? "0.0.0" });
  }
  return signIn;
}

export function createAppSignIn(options: AppSignInOptions) {
  if (APP_DEVICE_SESSION_TTL_SECONDS !== operatorSessionTtlSeconds) throw new Error("A device session must be the 30-day persistent session.");
  const now = options.now ?? (() => Date.now());
  const handoffs = createDesktopAuthHandoffStore({ ttlMs: APP_HANDOFF_CODE_TTL_MS, now });
  // Step-up marks (Nous Pro security review P1-5): a fresh Google sign-in for this web session, valid 5 minutes. Keyed by the session
  // cookie's SHA-256, in memory: a restart only asks again.
  const stepUps = new Map<string, number>();
  const sessionKey = (request: FastifyRequest) => createHash("sha256").update(request.cookies[cookieName] ?? "").digest("hex");
  // R10b: a phone's step-up runs in the system browser, which lacks the app's session; a one-time ticket (2 minutes, kept only as its
  // SHA-256) carries that session's hash, its user and the app's state from /api/auth/app/step-up/start to /api/auth/google/start.
  const tickets = new Map<string, StepUpTicket & { until: number }>();
  const ticketKey = (ticket: string) => createHash("sha256").update(ticket).digest("hex");
  const stepUp = {
    mark(sessionHash: string) {
      for (const [key, until] of stepUps) if (until <= now()) stepUps.delete(key);
      stepUps.set(sessionHash, now() + MOBILE_STEP_UP_MS);
    },
    fresh: (request: FastifyRequest) => (stepUps.get(sessionKey(request)) ?? 0) > now(),
    issue(entry: StepUpTicket): string {
      for (const [key, held] of tickets) if (held.until <= now()) tickets.delete(key);
      const ticket = randomBytes(32).toString("base64url");
      tickets.set(ticketKey(ticket), { ...entry, until: now() + MOBILE_STEP_UP_TICKET_MS });
      return ticket;
    },
    /** Single use: deleted before its expiry is read, so a reused or expired ticket answers null. */
    take(ticket: string): StepUpTicket | null {
      const key = ticketKey(ticket), held = tickets.get(key);
      tickets.delete(key);
      return held && held.until > now() ? { sessionHash: held.sessionHash, userId: held.userId, email: held.email, state: held.state } : null;
    }
  };
  let closeChannels: (ids: ReadonlySet<string>) => void = () => undefined;
  const revokeRow = (row: AppDeviceSessionRecord) => {
    closeChannels(new Set([row.id]));
    return options.persistRevocation(options.revocations.revokeSessionHash(row.sidSha256, Date.parse(row.expiresAt) + 24 * 3600_000)).catch(() => undefined);
  };

  /** Proof, automation and agent broker sessions never see or revoke devices: a person in Settings only. */
  function assertPerson(request: FastifyRequest): void {
    const session = verifySession(request.cookies[cookieName], options.sessionSecret);
    const user = request.user as (AuthUser & { brokerScope?: string }) | undefined;
    if (!session || session.id.startsWith("user:operator-proof") || session.id.startsWith("user:proof") || session.proofScope || session.automationScope
      || user?.proofScope || user?.automationScope || user?.brokerScope || request.sessionPrincipal?.startsWith("user:operator-proof") || request.mobileDevice) {
      throw Object.assign(new Error("Only you, signed in to Space, manage your devices (Settings > Account > Devices)."), { statusCode: 403 });
    }
  }

  const pairedCard = (row: AppDeviceSessionRecord) => `mobile:paired:${row.id}`;
  /** A held phone its owner did not allow within 10 minutes is revoked (design §2.2); a no-op once allowed or revoked. */
  async function expireHeld(owner: string, id: string, request?: FastifyRequest) {
    const held = (await options.repository.list(owner)).find((row) => row.id === id && row.noisePublic && !row.confirmedAt && !row.revokedAt);
    const row = held ? await options.repository.revoke(owner, id, new Date(now()).toISOString()) : null;
    if (!row) return null;
    await revokeRow(row);
    await options.notifications?.resolve(owner, pairedCard(row), "expired").catch(() => 0);
    const audit = { action: "mobile.pairing.expired", targetType: "app_device_session", targetId: row.id, actorUserId: owner };
    // A phone that paired through the relay has no request to audit with.
    await (request ? recordAudit(options.store, request, audit) : options.store.recordAuditEvent({ ...audit, traceId: makeSpaceId("trace"), metadata: { via: "relay" } }));
    return row;
  }

  return {
    assertPerson,
    stepUp,
    expireHeld,
    /** The mobile channel's close for revoked devices (it registers after these routes). */
    onRevoked(close: (ids: ReadonlySet<string>) => void) { closeChannels = close; },
    /** One device revoked with its session and open channel (demo mode's oldest phone past its cap). */
    async revokeDevice(owner: string, id: string) {
      const row = await options.repository.revoke(owner, id, new Date(now()).toISOString());
      if (row) await revokeRow(row);
      return row;
    },
    /** Every live paired phone of every user, revoked with its session (a compromised rotation of the installation's keys, C3): each pairs again. */
    async revokePaired() {
      const at = new Date(now()).toISOString(), revoked: AppDeviceSessionRecord[] = [];
      for (const live of await options.repository.livePaired(null, at)) {
        const row = await options.repository.revoke(live.ownerUserId, live.id, at);
        if (!row) continue;
        await revokeRow(row);
        await options.notifications?.resolve(row.ownerUserId, pairedCard(row), "revoked").catch(() => 0);
        revoked.push(row);
      }
      return revoked;
    },
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
        if (row.noisePublic) await options.notifications?.resolve(request.user.id, pairedCard(row), "revoked").catch(() => 0);
        await recordAudit(options.store, request, { action: "auth.device_session.revoked", targetType: "app_device_session", targetId: row.id, metadata: { app: row.app } });
        return { device: publicRow(row) };
      });
      // A paired phone holds read only until its owner allows it here, within 10 minutes (Nous Pro security review P1-5). A phone never reaches it.
      app.post("/api/auth/devices/:id/allow", options.routeOptions, async (request, reply: FastifyReply) => {
        if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Sign in to allow a device.");
        assertPerson(request);
        if (request.appSession) return sendApiError(reply, 403, "MOBILE_ALLOW_FROM_COMPUTER", "Allow a phone from SpaceApp on a computer (Settings > Account > Devices).");
        const id = appDeviceSessionIdSchema.safeParse((request.params as { id?: unknown }).id);
        const held = id.success ? (await options.repository.list(request.user.id)).find((row) => row.id === id.data && row.noisePublic && !row.revokedAt && !row.confirmedAt) : null;
        if (!held) return sendApiError(reply, 404, "DEVICE_NOT_FOUND", "No paired device waits for you to allow it.");
        if (Date.parse(held.createdAt) + MOBILE_PAIRING_CONFIRM_MS <= now()) {
          await expireHeld(request.user.id, held.id, request);
          return sendApiError(reply, 410, "MOBILE_PAIRING_EXPIRED", "It waited more than 10 minutes, so it was revoked; pair the phone again.");
        }
        const row = await options.repository.confirm(request.user.id, held.id, new Date(now()).toISOString());
        if (!row) return sendApiError(reply, 404, "DEVICE_NOT_FOUND", "No paired device waits for you to allow it.");
        await options.notifications?.resolve(request.user.id, pairedCard(row), "allowed").catch(() => 0);
        await recordAudit(options.store, request, { action: "mobile.pairing.allowed", targetType: "app_device_session", targetId: row.id, metadata: { scopes: row.scopes } });
        return { device: publicRow(row) };
      });
    }
  };
}
