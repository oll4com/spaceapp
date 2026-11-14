import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { encodeMobilePairQr, mobileOriginSchema, mobileScopeSchema, vaultBase64url } from "@space/contracts";
import { InMemoryMobileInstanceKeyRepository, PostgresMobileInstanceKeyRepository } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import { ConnectorError, type ConnectorCrypto } from "../dot-connectors.js";
import { sendApiError } from "../http-errors.js";
import { recordAudit } from "../request-audit.js";
import { createMobileInstanceKeys } from "./instance-key.js";
import { createMobileOffers } from "./pairing.js";

// Settings > Mobile app (plan clipboard:kTV3y2lwO-99 phase 1b, ADR-013): a person only. The device-session check refuses proof, automation
// and broker sessions; a phone's own session (the `app` claim) is refused too, except an ADMIN's SpaceApp Android session (R10, SpaceApp
// Android 0.2.13 Settings > Devices), whose step-up is an in-app Google sign-in (POST /api/auth/app/step-up, auth-routes.ts).

const rotateSchema = z.object({ compromised: z.boolean().optional() }).strict();
const pairingSchema = z.object({ scopes: z.array(mobileScopeSchema.exclude(["admin"])).max(3).optional(), transport: z.enum(["DIRECT", "RELAY"]).optional() }).strict();
const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
/** This server's address as the browser reached it: the origin the phone dials directly. */
const requestOrigin = (request: FastifyRequest) => new URL(`${header(request.headers["x-forwarded-proto"]) ?? request.protocol}://${header(request.headers["x-forwarded-host"]) ?? request.headers.host}`).origin;

export function registerMobileRoutes(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "recordAuditEvent" | "upsertUser" | "getOwnerCredentials">; crypto: ConnectorCrypto; databaseUrl: string | null | undefined;
  routeOptions: Pick<RouteShorthandOptions, "config">; assertPerson: (request: FastifyRequest) => void;
  /** A fresh Google sign-in or SpaceApp password for this web session (security review P1-5): set up and pairing need it. */
  stepUp: { fresh(request: FastifyRequest): boolean };
  /** Revokes every user's paired phones and closes their channels; answers their ids (C3). */
  revokePaired: () => Promise<string[]>;
  /** The SpaceApp relay is configured (SPACE_MOBILE_RELAY_URL): RELAY offers exist, and each new one makes the relay client listen on it. */
  relay?: { offered(): void } | null;
  /** Demo mode (SPACE_MOBILE_DEMO=1 on a public install, the store-review demo instance): GET /api/mobile/demo-offer exists. */
  demo?: boolean;
}) {
  const repository = options.databaseUrl ? PostgresMobileInstanceKeyRepository.fromConnectionString(options.databaseUrl) : new InMemoryMobileInstanceKeyRepository();
  const keys = createMobileInstanceKeys({ repository, crypto: options.crypto });
  const offers = createMobileOffers();
  const person = (request: FastifyRequest) => {
    options.assertPerson(request);
    if (request.appSession && !(request.appSession === "spaceapp" && request.user?.role === "ADMIN")) {
      throw Object.assign(new Error("Set up the mobile app from SpaceApp on a computer (Settings > Mobile app)."), { statusCode: 403 });
    }
  };
  const steppedUp = (request: FastifyRequest, reply: FastifyReply) => {
    if (options.stepUp.fresh(request)) return true;
    if (request.appSession) {
      sendApiError(reply, 403, "STEP_UP_REQUIRED", "Confirm it is you: sign in to Google in the app again, then pair the phone within 5 minutes.",
        { stepUpUrl: "/api/auth/app/step-up" });
    } else {
      sendApiError(reply, 401, "STEP_UP_REQUIRED", "Confirm it is you with your SpaceApp password or a new Google sign-in, then pair the phone within 5 minutes.",
        { stepUpUrl: "/api/auth/google/start?stepUp=mobile", passwordUrl: "/api/auth/step-up/password" });
    }
    return false;
  };
  // No connector key on this server: 503 CONNECTOR_KEY_MISSING, as the connectors answer (dot-connectors.ts).
  const sealing = async <T>(reply: FastifyReply, work: () => Promise<T>): Promise<T | null> => {
    try { return await work(); } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      sendApiError(reply, error.status, error.code, error.message);
      return null;
    }
  };

  app.get("/api/mobile/instance", options.routeOptions, async (request) => {
    person(request);
    return keys.status();
  });
  app.post("/api/mobile/instance", options.routeOptions, async (request, reply) => {
    person(request);
    if (!steppedUp(request, reply)) return reply;
    const result = await sealing(reply, () => keys.setUp());
    if (!result) return reply;
    if (result.created) await recordAudit(options.store, request, { action: "mobile.instance.created", targetType: "mobile_instance", targetId: result.fingerprint });
    return keys.status();
  });
  app.post("/api/mobile/rotate", options.routeOptions, async (request, reply) => {
    person(request);
    const input = rotateSchema.safeParse(request.body ?? {});
    if (!input.success) throw Object.assign(new Error("The body takes only compromised (true or false)."), { statusCode: 400 });
    const compromised = input.data.compromised === true;
    const result = await sealing(reply, () => keys.rotate(compromised));
    if (!result) return reply;
    // Exposed keys: every phone paired under them, any user's (the keys are the installation's; only an ADMIN reaches this route, USERs get
    // 404 from owned-resource-access.ts), is revoked and its live session ends; each pairs again (C3, review P2-4).
    const revokedDevices = compromised ? await options.revokePaired() : [];
    await recordAudit(options.store, request, { action: "mobile.instance.rotated", targetType: "mobile_instance", targetId: result.fingerprint,
      metadata: { compromised, oldFingerprint: result.oldFingerprint, revokedDevices } });
    return keys.status();
  });
  // A pairing offer: the QR text goes only into this answer, never into events, logs or the audit row (security review P1-5).
  app.post("/api/mobile/pairing", options.routeOptions, async (request, reply) => {
    person(request);
    if (!steppedUp(request, reply)) return reply;
    const input = pairingSchema.safeParse(request.body ?? {});
    if (!input.success) return sendApiError(reply, 400, "INVALID_INPUT", "The body takes only scopes (read, act, decide) and transport (DIRECT, RELAY).");
    const relay = input.data.transport === "RELAY";
    if (relay && !options.relay) return sendApiError(reply, 409, "MOBILE_RELAY_OFF", "This SpaceApp has no relay configured; pair over its own address.");
    const scopes = [...new Set(["read" as const, ...(input.data.scopes ?? ["act", "decide"])])];
    const origin = requestOrigin(request);
    // A RELAY offer needs no address the phone can dial: the QR then names only the rendezvous id.
    const direct = mobileOriginSchema.safeParse(origin).success;
    if (!direct && !relay) {
      return sendApiError(reply, 409, "MOBILE_ORIGIN", "A phone reaches SpaceApp over https (or http on a private network); open SpaceApp at its https address to pair.");
    }
    // Pair a phone sets the keys up itself when there are none (7/11: a confirmed step-up still answered 409 MOBILE_NOT_SET_UP on an install
    // without keys, and Set up was a step of its own); the same step-up covers both.
    let active = await repository.active();
    if (!active) {
      const created = await sealing(reply, () => keys.setUp());
      if (!created) return reply;
      if (created.created) await recordAudit(options.store, request, { action: "mobile.instance.created", targetType: "mobile_instance", targetId: created.fingerprint, metadata: { via: "pairing" } });
      active = await repository.active();
      if (!active) return sendApiError(reply, 409, "MOBILE_NOT_SET_UP", "The mobile keys could not be set up; try Pair a phone again.");
    }
    const offer = offers.create(request.user!.id, scopes, `SpaceApp ${new URL(origin).hostname}`.slice(0, 40), relay);
    if ("refused" in offer) {
      return offer.refused === "LOCKED"
        ? sendApiError(reply, 429, "MOBILE_PAIRING_LOCKED", "Too many failed pairing attempts; try again in 15 minutes.")
        : sendApiError(reply, 429, "MOBILE_OFFERS_LIMIT", "Three pairing codes are open; close one or let it expire.");
    }
    const qr = encodeMobilePairQr({ v: 1, o: vaultBase64url.encode(offer.offerId), u: direct ? [origin] : [], r: offer.rid && vaultBase64url.encode(offer.rid), k: active.noisePublic,
      i: active.identityPublic, c: vaultBase64url.encode(offer.code), n: offer.label, x: Math.floor(offer.expiresAt / 1000) });
    await recordAudit(options.store, request, { action: "mobile.pairing.offered", targetType: "mobile_offer", targetId: vaultBase64url.encode(offer.offerId), metadata: { scopes, transport: relay ? "RELAY" : "DIRECT" } });
    if (relay) options.relay?.offered();
    return { offerId: vaultBase64url.encode(offer.offerId), qr, fingerprint: (await keys.status()).fingerprint, scopes, expiresAt: new Date(offer.expiresAt).toISOString() };
  });
  // Demo mode's "Try the demo" (store-review demo instance, plan kTV3y2lwO-99 step 9): the day's standing offer, public by design. It pairs
  // only with this instance, as its owner, read only (operator 13/11, plan step 18: offers.demo's scopes).
  if (options.demo) app.get("/api/mobile/demo-offer", options.routeOptions, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const owner = (await options.store.getOwnerCredentials())?.user.id;
    const active = await repository.active();
    if (!owner || !active) return sendApiError(reply, 409, "MOBILE_NOT_SET_UP", "The demo is not set up yet.");
    const origin = requestOrigin(request);
    if (!mobileOriginSchema.safeParse(origin).success) return sendApiError(reply, 409, "MOBILE_ORIGIN", "The demo pairs over https only.");
    const offer = offers.demo(owner, `SpaceApp ${new URL(origin).hostname}`.slice(0, 40));
    const qr = encodeMobilePairQr({ v: 1, o: vaultBase64url.encode(offer.offerId), u: [origin], r: null, k: active.noisePublic, i: active.identityPublic,
      c: vaultBase64url.encode(offer.code), n: offer.label, x: Math.floor(offer.expiresAt / 1000) });
    return { qr, fingerprint: (await keys.status()).fingerprint, scopes: offer.scopes, expiresAt: new Date(offer.expiresAt).toISOString() };
  });
  app.delete("/api/mobile/pairing/:offerId", options.routeOptions, async (request) => {
    person(request);
    return { cancelled: offers.cancel(request.user!.id, (request.params as { offerId: string }).offerId) };
  });
  app.addHook("onClose", async () => { await repository.dispose(); });
  return { keys, offers, repository };
}
