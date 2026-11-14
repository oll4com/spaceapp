import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import type { WebSocket } from "ws";
import {
  LINK_APP, MOBILE_PAIRING_CONFIRM_MS, isAgentFileArtifact, MOBILE_UPDATE_REQUIRED_CLOSE, MobileNoiseHandshake, decodeMobileFrame, encodeMobileFrame, mobileAppUpdateRequired, mobileFrames, mobileHandshakePrologue, mobileHelloSchema,
  mobileIntegrityRequestHash, mobilePairRequestSchema, mobilePairingPsk, vaultBase64url, type MobileUpdateRequired, type MobileFrame, type MobileNoiseTransport, type NotificationRaiseInput
} from "@space/contracts";
import type { AppDeviceSessionRecord, AppDeviceSessionRepository, MobileDeviceScope, MobileInstanceKeyRepository } from "@space/db";
import { makeSpaceId, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import { cookieName, createCsrfToken, csrfHeaderName, sessionIdHash, signMobileSession } from "../auth.js";
import { recordAudit } from "../request-audit.js";
import { requestIpForLog } from "../request-helpers.js";
import { heldPaneReached, linkLease } from "../instance-link/lease.js";
import { OPERATOR_TURN_GRACE_MS, operatorHeldPanes } from "../queue-operator-grants.js";
import { linkRoute } from "../instance-link/routes.js";
import { attestationSerials, createAttestationStatusList, recheckDecideKeys, verifyDecideKeyAttestation, type AttestationStatusList } from "./attestation.js";
import { mailPairingNotice } from "./pairing-mail.js";
import type { MailCopilotGoogleAccess } from "../mail-copilot/service.js";
import { MOBILE_SIG_HEADER } from "./checks.js";
import { MOBILE_INVOKE_HEADER, mobileInvokeSecret } from "./gate.js";
import { MOBILE_INTEGRITY_HEADER, type PlayIntegrity } from "./integrity.js";
import type { MobileInstanceKeys } from "./instance-key.js";
import type { MobileOffers } from "./pairing.js";
import { startMobileRelay } from "./relay-client.js";

// The phone's channel (plan clipboard:kTV3y2lwO-99 phase 1b-5, ADR-013 §3-6, design §2.2, §3, §6.1): one Noise session per socket at
// wss /api/mobile/channel. ?m=pair&o=<offer> runs XXpsk3 as the responder (1b-5a): the offer is claimed on message 3 before any await
// (security review P2-2), a wrong code counts toward the lock, the device is held with read only until its owner allows it within
// 10 minutes (P1-5), and decide counts only with an Android Key Attestation over this handshake (P2-6). ?m=ik connects a paired device
// (1b-5b). Either way the session then carries `req` frames into this API through app.inject with a one-hour channel session and the
// process's secret header, so the mobile gate (gate.ts) and every route's own checks apply as to any request.

export const MOBILE_PAIRED_MAX = 10;
/** Demo mode's live phones (one shared demo CT's memory and sockets, not a per-person cap): past it the oldest is revoked. */
export const MOBILE_DEMO_DEVICES_MAX = 500;
export { MOBILE_PAIRING_CONFIRM_MS };
export const MOBILE_DEVICE_IDLE_MS = 90 * 24 * 3600_000;
const HANDSHAKE_MS = 30_000;
const NOISE_MESSAGE_MAX = 65_535;
const HELLO_WINDOW_MS = 300_000;
const REPLAY_WINDOW_MS = 600_000;
const IN_FLIGHT_MAX = 16;
/** The Nous app's own limit for one answer (RESPONSE_MAX in its mobile-channel.ts, every version so far): more it refuses, so a larger file
 * comes in Range pieces (13/11: 0.2.37 saves a whole file from Shared in one GET, so 32 MiB here stopped every APK). */
const RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const ROW_RECHECK_MS = 10_000;
/** How often the paired decide keys meet Google's status list again (C6); the list itself is fetched at most daily. */
const DECIDE_RECHECK_MS = 3600_000;
const PING_MS = 30_000, SILENCE_MS = 120_000, REKEY_MS = 3600_000, SESSION_MS = 24 * 3600_000, TOKEN_RENEW_MS = 50 * 60_000;
/** Uploads up to the attachment limit; buffered bytes per channel and for all of them (security review P2-5). */
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024, CHANNEL_BUFFER_MAX = 64 * 1024 * 1024, PROCESS_BUFFER_MAX = 512 * 1024 * 1024;

/**
 * The device's session id: it never leaves the server and is not stored (only its hash, so the usual revoke kills every token minted from
 * it). shortcut: derived from the session secret, so a changed secret makes every phone pair again; store it sealed if secrets ever rotate.
 */
export const mobileDeviceSid = (sessionSecret: string, deviceId: string) => createHmac("sha256", sessionSecret).update(`spaceapp-mobile-sid-v1:${deviceId}`).digest("hex");

const bytesOf = (raw: Buffer | ArrayBuffer | Buffer[]) => new Uint8Array(Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer));
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const parse = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as unknown;
/** Design §6.1: an /api/ path, no traversal (encoded dots too), no backslash or encoded slash. */
/** CODE-2: an app below the floor is told the minimum in the close reason (at most 123 bytes), before anything else happens. */
const closeForUpdate = (socket: WebSocket, update: MobileUpdateRequired) => socket.close(MOBILE_UPDATE_REQUIRED_CLOSE, JSON.stringify(update));
const pathProblem = (path: string) => !path.startsWith("/api/") || path.length > 2048 || /\.\.|\\|%2e|%2f|%5c/i.test(path);
type Begin = (transport: MobileNoiseTransport, row: AppDeviceSessionRecord) => void;
/** The socket's peer: the upgrade request on the direct route; none through the relay, whose sessions log their peer as "relay". */
type Peer = { request: FastifyRequest | null; ip: string };
/**
 * An open session as its owner sees it (Space Link's Remote mark, ADR-014): who, from which address ("relay" through the relay), since
 * when, what it may do, its last request (method and path, never the query or body) and the last ping's round trip.
 */
export type LiveChannel = { deviceId: string; app: string; name: string; ip: string; since: string; scopes: string[];
  last: { method: string; path: string; at: string } | null; rttMs: number | null };

const bridges = new WeakMap<FastifyInstance, (request: FastifyRequest) => Promise<void>>();
/** Runs before the session hook (app.ts): Nous 0.2.37's update download as its channel's own request (registerMobileChannel). */
export const mobileUpdateBridge = async (app: FastifyInstance, request: FastifyRequest) => { await bridges.get(app)?.(request); };
const CHANNEL_COOKIE = "mobile:";

export function registerMobileChannel(app: FastifyInstance, options: {
  keys: MobileInstanceKeys; keyRepository: MobileInstanceKeyRepository; offers: MobileOffers; devices: AppDeviceSessionRepository;
  store: Pick<SpaceStore, "recordAuditEvent" | "upsertUser" | "getControlActor" | "getPane" | "getArtifact">; notifications?: { raise(input: NotificationRaiseInput): Promise<unknown> };
  sessionSecret: string; routeOptions: Pick<RouteShorthandOptions, "config">; events?: Pick<SpaceEventBus, "subscribe">;
  /** Google's attestation status list (tests give their own). */
  attestationStatus?: AttestationStatusList;
  /** Revokes a device its owner did not allow in time (app-signin.ts); a no-op once it was allowed or revoked. */
  expireHeld: (owner: string, deviceId: string, request?: FastifyRequest) => Promise<unknown>;
  /** Revokes a device and ends its session (app-signin.ts): demo mode's oldest phone past MOBILE_DEMO_DEVICES_MAX. */
  revokeDevice: (owner: string, deviceId: string) => Promise<unknown>;
  /** The owner's connected Gmail for the pairing e-mail (C5); null or absent: only the URGENT card. */
  google?: () => MailCopilotGoogleAccess | null; gmailFetch?: typeof fetch;
  /** The SpaceApp relay (SPACE_MOBILE_RELAY_URL, phase 2b); null or absent: no outbound socket, the direct route only. */
  relayUrl?: string | null;
  /** Play Integrity (integrity.ts); null or absent: no Cloud project configured, decide rests on the key attestation alone. */
  integrity?: PlayIntegrity | null;
  now?: () => number;
}) {
  const now = options.now ?? (() => Date.now());
  const iso = (at = now()) => new Date(at).toISOString();
  const helloSeen = new Map<string, number>();
  const attestationStatus = options.attestationStatus ?? createAttestationStatusList();
  const sidHashOf = (deviceId: string) => sessionIdHash(mobileDeviceSid(options.sessionSecret, deviceId));
  const live = (row: AppDeviceSessionRecord | null): row is AppDeviceSessionRecord => Boolean(row && !row.revokedAt && row.expiresAt > iso() && row.sidSha256 === sidHashOf(row.id));
  const channels = new Set<{ socket: WebSocket; inbound: () => number; deviceId: string; owner: string; live: LiveChannel; session: () => Promise<string | null> }>();
  const lease = linkLease(options.store, now);
  const buffered = () => [...channels].reduce((sum, channel) => sum + channel.socket.bufferedAmount + channel.inbound(), 0);
  const overdue = (row: AppDeviceSessionRecord) => !row.confirmedAt && Date.parse(row.createdAt) + MOBILE_PAIRING_CONFIRM_MS <= now();

  // The real peer, read before the upgrade detaches the socket: injected requests carry it, so none counts as loopback (review P2-1, P3-3).
  const peers = new WeakMap<FastifyRequest, string>();
  // shortcut: Nous 0.2.37 downloads its update APK over plain HTTPS with the cookie `mobile:<device id>` (apk-install.ts), which no session
  // matches (401, nous_msg:268bc034). That one request runs as its channel's own injected request when the device's channel is open from the
  // same address and the file is a Nous APK in Agent Files › Apps/Android; remove once the update floor reaches 0.2.38 (it downloads over the channel).
  bridges.set(app, async (request) => {
    const value = request.cookies[cookieName];
    if (request.method !== "GET" || request.routeOptions.url !== "/api/artifacts/:id/file" || !value?.startsWith(CHANNEL_COOKIE)) return;
    const ip = requestIpForLog(request);
    const channel = [...channels].find((one) => one.deviceId === value.slice(CHANNEL_COOKIE.length) && one.live.ip === ip);
    const artifact = channel ? await Promise.resolve().then(() => options.store.getArtifact((request.params as { id: string }).id)).catch(() => null) : null;
    const meta = artifact?.metadata ?? {};
    if (!channel || !artifact || !isAgentFileArtifact(artifact) || String(meta.folder ?? "").replace(/^\/+|\/+$/g, "").toLowerCase() !== "apps/android"
      || !/^Nous-Android-\d+\.\d+\.\d+\.apk$/i.test(String(meta.originalFilename ?? ""))) return;
    const session = await channel.session();
    if (!session) return;
    request.cookies[cookieName] = session;
    request.headers[MOBILE_INVOKE_HEADER] = mobileInvokeSecret(app)!;
  });
  const onRequest = async (request: FastifyRequest) => { peers.set(request, requestIpForLog(request) ?? "0.0.0.0"); };
  app.get("/api/mobile/channel", { ...options.routeOptions, websocket: true, onRequest }, (socket, request) => {
    const query = request.query as { m?: string; o?: string };
    const peer = { request, ip: peers.get(request) ?? "0.0.0.0" };
    if (query.m === "ik") return open(socket, peer, null, null);
    const offerId = query.m === "pair" && /^[A-Za-z0-9_-]{11}$/.test(query.o ?? "") ? vaultBase64url.decode(query.o!) : null;
    // A peek, not the claim: message 3 claims it.
    const offer = offerId ? options.offers.peek(offerId) : null;
    if (!offerId || !offer) return void socket.close(4401);
    open(socket, peer, { offerId, owner: offer.owner }, null);
  });

  /**
   * One Noise session on a socket, the direct route's or one the relay spliced (design §5): `rid` is the relay rendezvous id the socket came
   * through, bound in the handshake's prologue so a relay cannot move it; null on the direct route.
   */
  function open(socket: WebSocket, peer: Peer, offer: { offerId: Uint8Array; owner: string } | null, rid: Uint8Array | null) {
    let handle: (message: Uint8Array) => Promise<void> | void;
    const timer = setTimeout(() => socket.close(4408), HANDSHAKE_MS);
    timer.unref();
    socket.on("close", () => clearTimeout(timer));
    const begin: Begin = (transport, row) => { clearTimeout(timer); handle = serve(socket, peer, transport, row); };
    handle = offer ? pair(socket, peer, offer.offerId, offer.owner, begin, rid) : connect(socket, peer, begin, rid);
    let chain = Promise.resolve();
    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const message = bytesOf(raw);
      chain = chain.then(() => (message.length > NOISE_MESSAGE_MAX ? socket.close(4400) : handle(message))).catch(() => socket.close(4400));
    });
  }

  function audit(peer: Peer, owner: string, action: string, targetId: string | null, metadata: Record<string, unknown> = {}) {
    const input = { action, targetType: "app_device_session", targetId, actorUserId: owner, metadata: peer.request ? metadata : { ...metadata, via: "relay" } };
    return (peer.request ? recordAudit(options.store, peer.request, input)
      : Promise.resolve(options.store.recordAuditEvent({ ...input, traceId: makeSpaceId("trace") }))).catch(() => undefined);
  }

  function pair(socket: WebSocket, peer: Peer, offerId: Uint8Array, owner: string, begin: Begin, rid: Uint8Array | null) {
    // Every socket on a live offer ends audited, completed or failed (9/11: ten stable offers left neither); a silent close names the stage it reached.
    // Not demo mode's public standing offer: anyone may open a socket on it, and each would write a row.
    let stage = "NO_MESSAGE_1", settled = options.offers.peek(offerId)?.standing === true;
    const fail = (code: number, reason: string, closeWith?: () => void) => { settled = true; void audit(peer, owner, "mobile.pairing.failed", null, { reason }); if (closeWith) closeWith(); else socket.close(code); };
    socket.on("close", (code: number) => { if (!settled) void audit(peer, owner, "mobile.pairing.failed", null, { reason: stage, code }); });
    const instance = options.keyRepository.active().then((row) => (row ? options.keys.open(row) : null));
    let handshake: MobileNoiseHandshake | null = null;
    let challenge: Uint8Array | null = null;
    return async (message: Uint8Array) => {
      if (!handshake) {
        const keys = await instance;
        const offer = options.offers.peek(offerId);
        if (!keys || !offer) return fail(4401, keys ? "OFFER_GONE" : "NOT_SET_UP");
        handshake = new MobileNoiseHandshake({ pattern: "XXpsk3", initiator: false, prologue: mobileHandshakePrologue("pair", offerId, rid), s: keys.noise,
          psk: mobilePairingPsk(offer.code, keys.noise.publicKey, keys.identity.publicKey, offerId) });
        handshake.readMessage(message);
        // Message 2 carries the identity key for words mode, which pins nothing beforehand (design §2.1, review P3-1).
        socket.send(handshake.writeMessage(json({ i: vaultBase64url.encode(keys.identity.publicKey) })));
        challenge = handshake.handshakeHash.slice();
        stage = "NO_MESSAGE_3";
        return;
      }
      if (handshake.complete || !challenge) return void socket.close(4400);
      // The claim before any await: a second message 3 for this offer finds nothing (security review P2-2).
      const claimed = options.offers.claim(offerId);
      if (!claimed) return fail(4401, "OFFER_GONE");
      // A throw from here on (the store, the attestation check) closes 4400 with the offer burned.
      stage = "PAIR_ERROR";
      let pairRequest: ReturnType<typeof mobilePairRequestSchema.parse>;
      try {
        pairRequest = mobilePairRequestSchema.parse(parse(handshake.readMessage(message)));
      } catch {
        // Decrypting message 3 needs the psk: a failure there is a wrong code, counted toward the lock.
        if (!handshake.complete) { options.offers.failed(owner); return fail(4401, "WRONG_CODE"); }
        return fail(4400, "PAIR_REQUEST");
      }
      const update = mobileAppUpdateRequired(pairRequest.app, pairRequest.appVersion);
      if (update) return fail(MOBILE_UPDATE_REQUIRED_CLOSE, update.code, () => closeForUpdate(socket, update));
      const transport = handshake.split();
      // Demo mode's standing offer: nobody reads alerts or allows phones there, so it is allowed at once, unannounced, under its own cap.
      const demo = claimed.standing === true;
      const paired = await options.devices.livePaired(owner, iso());
      // shortcut: the demo owner's own QR pairing still counts the demo phones toward 10; on the demo instance it pairs through the demo offer too.
      if (demo) for (const old of paired.slice(0, Math.max(0, paired.length - MOBILE_DEMO_DEVICES_MAX + 1))) await options.revokeDevice(owner, old.id);
      else if (paired.length >= MOBILE_PAIRED_MAX) return fail(4429, "DEVICE_CAP");
      const attestation = pairRequest.decidePubSpki && pairRequest.decideAttestation
        ? verifyDecideKeyAttestation({ chain: pairRequest.decideAttestation, decidePublicSpki: pairRequest.decidePubSpki, challenge, revoked: await attestationStatus.revoked() }) : null;
      // Play Integrity beside the attestation, for decide only (a phone that fails it still pairs to read and act, like a failed attestation).
      const integrity = attestation?.ok && options.integrity
        ? await options.integrity.verify({ token: pairRequest.integrityToken, app: pairRequest.app, requestHash: mobileIntegrityRequestHash("pair", challenge) }) : null;
      const decide = attestation?.ok && integrity?.ok !== false ? attestation : null;
      const requestedScopes = [...new Set<MobileDeviceScope>(["read", ...pairRequest.wantScopes.filter((scope) => claimed.scopes.includes(scope) && (scope !== "decide" || decide))])];
      const id = `appdev:${randomBytes(12).toString("base64url")}`;
      const expiresAt = iso(now() + MOBILE_DEVICE_IDLE_MS);
      const created = await options.devices.createPaired({ id, ownerUserId: owner, app: pairRequest.app, deviceName: pairRequest.deviceName, sidSha256: sidHashOf(id),
        expiresAt, noisePublic: vaultBase64url.encode(handshake.remoteStatic!), decidePublicSpki: decide ? pairRequest.decidePubSpki! : null,
        decideSecurityLevel: decide?.securityLevel ?? null, decideSerials: decide ? attestationSerials(pairRequest.decideAttestation!) : null, requestedScopes,
        // A RELAY offer's rid is the phone's rendezvous id, also when it paired over the direct address the QR named too.
        rendezvousId: claimed.rid && vaultBase64url.encode(claimed.rid) });
      const row = demo ? (await options.devices.confirm(owner, created.id, iso())) ?? created : created;
      settled = true;
      socket.send(transport.encrypt(encodeMobileFrame({ type: "ctl", body: new Uint8Array(0), header: { op: "paired", deviceId: row.id, scopes: row.scopes ?? ["read"],
        pending: row.confirmedAt ? [] : requestedScopes, rid: row.rendezvousId, expiresAt, instanceLabel: claimed.label } })));
      await audit(peer, owner, "mobile.pairing.completed", row.id, { app: row.app, requestedScopes, decide: decide?.securityLevel ?? (attestation && !attestation.ok ? `refused ${attestation.reason}` : "none"),
        integrity: integrity ? (integrity.ok ? "ok" : `refused ${integrity.reason}`) : options.integrity ? "none" : "not configured", ...(demo ? { demo: true } : {}) });
      if (demo) return begin(transport, row);
      await options.notifications?.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "SYSTEM", kind: "MOBILE_PAIRED", severity: "URGENT",
        title: row.app === LINK_APP ? `New SpaceApp link: ${row.deviceName}` : `New device paired: ${row.deviceName}`, body: "Allow it in Settings > Account > Devices within 10 minutes, or Revoke it. Until then it can only read.",
        link: { surface: "settings", target: "devices" }, dedupeKey: `mobile:paired:${row.id}`, payload: { deviceId: row.id }, telegram: null }).catch(() => undefined);
      void (async () => {
        const to = (await Promise.resolve(options.store.getControlActor(owner)).catch(() => null))?.email;
        const mail = to ? await mailPairingNotice({ google: options.google?.() ?? null, ...(options.gmailFetch ? { fetchImpl: options.gmailFetch } : {}) },
          { owner, to, deviceName: row.deviceName, deviceId: row.id, requestedScopes, instanceLabel: claimed.label, at: iso() }) : { result: "NO_GMAIL" };
        await audit(peer, owner, "mobile.pairing.mailed", row.id, mail);
      })();
      setTimeout(() => void options.expireHeld(owner, row.id, peer.request ?? undefined).catch(() => undefined), MOBILE_PAIRING_CONFIRM_MS).unref();
      begin(transport, row);
    };
  }

  /** Noise IK with the pinned instance key (design §3.1): any key that still answers, ACTIVE first; a retiring one sends the rotation. */
  function connect(socket: WebSocket, peer: Peer, begin: Begin, rid: Uint8Array | null) {
    return async (message: Uint8Array) => {
      for (const [key, at] of helloSeen) if (at <= now() - REPLAY_WINDOW_MS) helloSeen.delete(key);
      const answering = await options.keyRepository.answering(iso());
      let found: { handshake: MobileNoiseHandshake; payload: Uint8Array; status: string } | null = null;
      for (const row of answering) {
        const handshake = new MobileNoiseHandshake({ pattern: "IK", initiator: false, prologue: mobileHandshakePrologue("ik", null, rid), s: options.keys.open(row).noise });
        try { found = { handshake, payload: handshake.readMessage(message), status: row.status }; break; } catch { /* another answering key */ }
      }
      if (!found) return void socket.close(4403);
      const hello = mobileHelloSchema.parse(parse(found.payload));
      const row = await options.devices.byNoisePublic(vaultBase64url.encode(found.handshake.remoteStatic!));
      // Through the relay only on the device's own rendezvous id.
      if (!live(row) || row.id !== hello.deviceId || (rid && row.rendezvousId !== vaultBase64url.encode(rid))) return void socket.close(4403);
      if (overdue(row)) { await options.expireHeld(row.ownerUserId, row.id, peer.request ?? undefined); return void socket.close(4403); }
      if (Math.abs(hello.ts - now()) > HELLO_WINDOW_MS) return void socket.close(4408);
      const seen = `${row.id}:${hello.nonce}`;
      if (helloSeen.has(seen)) return void socket.close(4409);
      helloSeen.set(seen, now());
      const update = mobileAppUpdateRequired(row.app, hello.appVersion);
      if (update) return closeForUpdate(socket, update);
      // expires_at = last seen + 90 days, written at most once an hour (design §4.1).
      const current = !row.lastSeenAt || Date.parse(row.lastSeenAt) <= now() - 3600_000 ? (await options.devices.touch(row.id, iso(), iso(now() + MOBILE_DEVICE_IDLE_MS))) ?? row : row;
      const rotation = found.status === "ACTIVE" ? null : answering.find((key) => key.status === "ACTIVE")?.rotationStatement ?? null;
      socket.send(found.handshake.writeMessage(json({ sessionId: `mobsess:${randomBytes(9).toString("base64url")}`, scopes: current.scopes ?? ["read"], serverTime: now(),
        ...(rotation ? { rotation } : {}), limits: { maxFrame: NOISE_MESSAGE_MAX, maxInFlight: IN_FLIGHT_MAX } })));
      begin(found.handshake.split(), current);
    };
  }

  /** The session: control frames, and requests into this API as the device (design §3.2, §6.1). */
  function serve(socket: WebSocket, peer: Peer, transport: MobileNoiseTransport, first: AppDeviceSessionRecord) {
    let device = first, checkedAt = now(), heard = now(), rekeyedAt = now(), inFlight = 0, pingAt = 0;
    let token = { value: "", scopes: "", at: 0 };
    let unsubscribe: (() => void) | null = null;
    // Uploads in chunk frames, by request id, until their last chunk.
    const uploads = new Map<number, { header: Parameters<typeof dispatch>[0]; parts: Uint8Array[]; size: number; seq: number }>();
    const inbound = () => [...uploads.values()].reduce((sum, upload) => sum + upload.size, 0);
    const overCaps = (more: number) => socket.bufferedAmount + inbound() + more > CHANNEL_BUFFER_MAX || buffered() + more > PROCESS_BUFFER_MAX;
    // Uploads answered busy or refused while their chunks are still on the way: those chunks are skipped, not a protocol error, until the
    // last one or the request sent again. A phone sends its uploads whole, so more than a channel's slots of them is misuse.
    const dropped = new Set<number>();
    const drop = (id: number, more: boolean, answer: () => void) => {
      if (more) { if (dropped.size >= IN_FLIGHT_MAX) return void socket.close(4400); dropped.add(id); }
      answer();
    };
    const channel = { socket, inbound, deviceId: first.id, owner: first.ownerUserId, live: { deviceId: first.id, app: first.app, name: first.deviceName, ip: peer.ip,
      since: iso(), scopes: first.scopes ?? ["read"], last: null, rttMs: null } as LiveChannel, session };
    channels.add(channel);
    const opened = now();
    const send = (frame: MobileFrame) => { if (socket.readyState === socket.OPEN) socket.send(transport.encrypt(encodeMobileFrame(frame))); };
    const control = (header: Record<string, unknown>) => send({ type: "ctl", header, body: new Uint8Array(0) });
    const answer = (id: number, status: number, body: Uint8Array, headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" }) => {
      for (const frame of mobileFrames("res", { id, s: status, h: headers }, body)) send(frame);
    };
    const refuse = (id: number, status: number, code: string, message: string) => answer(id, status, json({ error: { code, message } }));
    const ticker = setInterval(() => {
      if (now() - heard > SILENCE_MS) return socket.close(4408);
      if (now() - opened > SESSION_MS) return socket.close(4410);
      control({ op: "ping" });
      pingAt = now();
      if (now() - rekeyedAt >= REKEY_MS) { control({ op: "rekey" }); transport.rekeySend(); rekeyedAt = now(); }
    }, PING_MS);
    ticker.unref();
    socket.on("close", () => { clearInterval(ticker); unsubscribe?.(); channels.delete(channel); lease.release(channel.owner, channel.deviceId); });

    /** Events as ids only, like /api/events/stream (design §6.1): a record of another owner never reaches this phone. */
    async function subscribe() {
      const user = await options.store.getControlActor(device.ownerUserId);
      if (unsubscribe || !user || !options.events) return;
      unsubscribe = options.events.subscribe((event) => {
        const owner = event.payload.ownerUserId;
        if (typeof owner === "string" ? owner !== user.id : user.role === "USER") return;
        const ids = Object.fromEntries(([["roomId", event.roomId], ["paneId", event.paneId], ...Object.entries(event.payload)] as Array<[string, unknown]>)
          .filter(([key, value]) => key !== "ownerUserId" && /Id$/.test(key) && typeof value === "string" && value.length <= 200));
        send({ type: "evt", header: { type: event.type, ids }, body: new Uint8Array(0) });
      });
    }
    /** The row again at most every 10 s: a revoked or expired device ends the session; a change of scopes is told to the phone. */
    async function fresh(): Promise<AppDeviceSessionRecord | null> {
      if (now() - checkedAt < ROW_RECHECK_MS) return device;
      checkedAt = now();
      const row = await options.devices.byNoisePublic(device.noisePublic!);
      if (!live(row) || row.id !== device.id) return null;
      if (String(row.scopes) !== String(device.scopes)) control({ op: "scopes", scopes: row.scopes });
      channel.live.scopes = row.scopes ?? ["read"];
      return device = row;
    }
    /** The channel session of this device's row now (renewed like an injected request's), or null once it is revoked or expired. */
    async function session(): Promise<string | null> {
      const row = await fresh();
      const user = row ? await options.store.getControlActor(row.ownerUserId) : null;
      return row && user ? mint(row, user) : null;
    }
    function mint(row: AppDeviceSessionRecord, user: Parameters<typeof signMobileSession>[0]) {
      const scopes = row.scopes ?? ["read"];
      if (token.scopes !== String(scopes) || now() - token.at > TOKEN_RENEW_MS) {
        token = { value: signMobileSession(user, options.sessionSecret, { sid: mobileDeviceSid(options.sessionSecret, row.id), app: row.app, device: row.id, scopes }, now()),
          scopes: String(scopes), at: now() };
      }
      return token.value;
    }
    async function dispatch(header: { id: number; m: string; p: string; h?: Record<string, string>; more?: true; sig?: string; int?: string }, body: Uint8Array) {
      if (pathProblem(header.p)) return refuse(header.id, 400, "MOBILE_BAD_PATH", "Only /api/ paths without traversal.");
      const row = await fresh();
      const user = row ? await options.store.getControlActor(row.ownerUserId) : null;
      if (!row || !user) return void socket.close(4403);
      const scopes = row.scopes ?? ["read"];
      channel.live.last = { method: header.m, path: header.p.split("?")[0]!, at: iso() };
      // One linked SpaceApp acts here at a time, and never once this SpaceApp's person took management back (lease.ts).
      const rule = row.app === LINK_APP ? linkRoute(header.m, header.p) : null;
      const acts = !!rule && rule.scope === "act" && scopes.includes("act");
      // A link's act (or a try at a route links never reach) is audited here and on the linking SpaceApp under one trace (Λ4).
      // Its reads are not: the live view shows the last one, and Load reads every 30 s.
      const linkAudit = (status: number) => void (row.app === LINK_APP && rule?.scope !== "read" ? Promise.resolve(options.store.recordAuditEvent({
        actorUserId: row.ownerUserId, traceId: header.h?.["x-space-link-request"] ?? makeSpaceId("trace"), action: "instance_link.request", targetType: "app_device",
        targetId: row.id, metadata: { via: "link", method: header.m, path: header.p.split("?")[0], status, device: row.deviceName } })).catch(() => undefined) : undefined);
      // The gate matches the decoded route, the lease the raw path: a link reaches only what linkRoute names, so comm%61nds never gets round the lease.
      if (row.app === LINK_APP && !rule) { linkAudit(403); return refuse(header.id, 403, "MOBILE_SCOPE_DENIED", "A SpaceApp link does not reach this route."); }
      // Human wins per pane (Λ5): a link's act never reaches a pane the operator in person sent a line to (typed, local composer or pane
      // board) within OPERATOR_TURN_GRACE_MS. shortcut: an AFTER_TURN action accepted before that line still runs after the turn, and a turn
      // longer than the grace is open to links again; check in Space Control's own select() when that matters.
      const heldIds = acts && row.app === LINK_APP && body.length ? operatorHeldPanes() : [];
      if (heldIds.length) {
        const held = (await Promise.all(heldIds.map((id) => Promise.resolve().then(() => options.store.getPane(id)).catch(() => null)))).filter((pane) => pane !== null);
        let json: unknown = null;
        try { json = parse(body); } catch { /* not JSON: the gate's body rule refuses it */ }
        const pane = heldPaneReached(json, held);
        if (pane) {
          linkAudit(409);
          return refuse(header.id, 409, "HELD_BY_OPERATOR", `${pane.paneName ?? pane.id} is the operator's now: links reach it again ${OPERATOR_TURN_GRACE_MS / 60_000} minutes after their last line there.`);
        }
      }
      const refused = acts ? lease.claim(row.ownerUserId, row.id, row.deviceName) : null;
      if (refused) { linkAudit(409); return refuse(header.id, 409, refused.code, refused.message); }
      mint(row, user);
      let payload: string | Buffer | undefined = body.length ? Buffer.from(body) : undefined;
      // A JSON body is parsed once and injected re-serialized, never the phone's bytes (security review P2-3).
      // The media type whatever its parameters (C8); the frame schema pins header names to lower case.
      if (payload && /^application\/json\s*(;|$)/i.test(header.h?.["content-type"] ?? "")) {
        try { payload = JSON.stringify(parse(body)); } catch { return refuse(header.id, 400, "MOBILE_BAD_BODY", "The body is not JSON."); }
      }
      const response = await app.inject({ method: header.m as "GET", url: header.p, payload, remoteAddress: peer.ip,
        headers: { ...header.h, cookie: `${cookieName}=${token.value}`, [csrfHeaderName]: createCsrfToken(token.value, options.sessionSecret)!,
          [MOBILE_INVOKE_HEADER]: mobileInvokeSecret(app)!, ...(header.sig ? { [MOBILE_SIG_HEADER]: header.sig } : {}), ...(header.int ? { [MOBILE_INTEGRITY_HEADER]: header.int } : {}) } });
      linkAudit(response.statusCode);
      if (response.rawPayload.length > RESPONSE_MAX_BYTES) return refuse(header.id, 413, "MOBILE_TOO_LARGE", "Open it on a computer.");
      const headers = Object.fromEntries((["content-type", "content-length", "content-range"] as const)
        .flatMap((name) => (response.headers[name] === undefined ? [] : [[name, String(response.headers[name])]])));
      answer(header.id, response.statusCode, new Uint8Array(response.rawPayload), headers);
      // A revoked device's token stops at the gate at once; its socket goes with it.
      if (response.statusCode === 401 && response.body.includes('"MOBILE_SESSION"')) socket.close(4403);
    }
    return (message: Uint8Array) => {
      heard = now();
      const frame = decodeMobileFrame(transport.decrypt(message));
      if (frame.type === "ctl") {
        const op = frame.header.op;
        if (op === "ping") control({ op: "pong" });
        else if (op === "pong" && pingAt) { channel.live.rttMs = now() - pingAt; pingAt = 0; }
        else if (op === "rekey") transport.rekeyReceive();
        else if (op === "sub" && frame.header.topic === "events") void subscribe().catch(() => undefined);
        else if (op === "unsub") { unsubscribe?.(); unsubscribe = null; }
        else if (op === "cancel") uploads.delete(Number(frame.header.id));
        else if (op === "bye") socket.close(1000);
        // A Pro phone's push handle (design §8.1): stored for wake.ts; null forgets it.
        else if (op === "push-handle" && (frame.header.handle === null || (typeof frame.header.handle === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(frame.header.handle)))) {
          void options.devices.setPushHandle(device.id, frame.header.handle as string | null).catch(() => undefined);
        }
        return;
      }
      let header: Parameters<typeof dispatch>[0], body = frame.body;
      if (frame.type === "chunk") {
        const id = frame.header.id as number;
        if (dropped.has(id)) { if (!frame.header.more) dropped.delete(id); return; }
        const upload = uploads.get(id);
        if (!upload || frame.header.seq !== upload.seq + 1) return void socket.close(4400);
        // Every chunk counts against the buffered-bytes caps too (C2, internal review 1/11): past them the upload is dropped and the
        // phone sends the whole request again after the busy signal.
        if (overCaps(frame.body.length)) { uploads.delete(id); return drop(id, Boolean(frame.header.more), () => control({ op: "busy", id })); }
        upload.parts.push(frame.body); upload.size += frame.body.length; upload.seq += 1;
        if (upload.size > UPLOAD_MAX_BYTES) { uploads.delete(id); return drop(id, Boolean(frame.header.more), () => refuse(id, 413, "MOBILE_TOO_LARGE", "Up to 25 MiB from a phone.")); }
        if (frame.header.more) return;
        uploads.delete(upload.header.id);
        ({ header } = upload); body = Buffer.concat(upload.parts);
      } else if (frame.type === "req") {
        header = frame.header as Parameters<typeof dispatch>[0];
        const { id } = header, more = Boolean(header.more);
        dropped.delete(id);
        // Past the buffered-bytes caps a new request waits: the phone sends it again after the busy signal (security review P2-5).
        if (overCaps(frame.body.length)) return drop(id, more, () => control({ op: "busy", id }));
        // An upload holds one of the channel's request slots from its first frame (C2), so a phone cannot open uploads without end.
        if (inFlight + uploads.size >= IN_FLIGHT_MAX) return drop(id, more, () => refuse(id, 429, "MOBILE_BUSY", "Too many requests at once."));
        if (more) { uploads.set(id, { header: { ...header, more: undefined }, parts: [frame.body], size: frame.body.length, seq: 0 }); return; }
      } else return;
      inFlight += 1;
      void dispatch(header, body).catch(() => refuse(header.id, 500, "MOBILE_CHANNEL", "The request failed.")).finally(() => { inFlight -= 1; });
    };
  }

  // C6 (internal MASVS review 1/11): a decide key whose chain Google revoked or suspended since its phone paired loses decide; the channel's
  // 10 s row check tells the phone, and its owner gets a card.
  async function recheckDecide() {
    for (const row of await recheckDecideKeys({ devices: options.devices, status: attestationStatus, nowIso: iso() })) {
      await Promise.resolve(options.store.recordAuditEvent({ actorUserId: row.ownerUserId, traceId: makeSpaceId("trace"), action: "mobile.decide.revoked",
        targetType: "app_device_session", targetId: row.id, metadata: { reason: "ATTESTATION_REVOKED" } })).catch(() => undefined);
      await options.notifications?.raise({ ownerUserId: row.ownerUserId, roomId: null, paneId: null, source: "SYSTEM", kind: "MOBILE_DECIDE_REVOKED", severity: "ATTENTION",
        title: `Decide removed from ${row.deviceName}`, body: "Google revoked the hardware key attestation this phone paired with, so it no longer approves decisions. "
          + "It still reads and acts. Revoke it in Settings > Account > Devices if you do not know why, or pair it again.",
        link: { surface: "settings", target: "devices" }, dedupeKey: `mobile:decide-revoked:${row.id}`, payload: { deviceId: row.id }, telegram: null }).catch(() => undefined);
    }
  }
  const decideTimer = setInterval(() => void recheckDecide().catch(() => undefined), DECIDE_RECHECK_MS);
  decideTimer.unref();
  // Phase 2b: the relay client listens on every live RELAY offer's rid and every relay-paired device's rendezvous id; a spliced socket is a
  // pairing when its rid is an offer's, otherwise an IK connect bound to that rid.
  const relay = options.relayUrl ? startMobileRelay({
    url: options.relayUrl,
    identities: async () => (await options.keyRepository.answering(iso())).map((row) => options.keys.open(row).identity),
    rids: async () => [...new Set([...options.offers.live().flatMap((offer) => (offer.rid ? [vaultBase64url.encode(offer.rid)] : [])),
      ...(await options.devices.livePaired(null, iso())).flatMap((row) => (row.rendezvousId ? [row.rendezvousId] : [])),
      // A phone revoked or expired while offline keeps its rid listened until its row is pruned: its next connect gets this
      // instance's 4403 (the phone's 4503, pair again), not the relay's 4404 (instance offline) forever. Live rids come first under the cap.
      ...(await options.devices.endedRendezvousIds(iso()))])],
    accept: (socket, rid) => {
      const offer = options.offers.live().find((entry) => entry.rid && Buffer.from(entry.rid).equals(Buffer.from(rid)));
      open(socket, { request: null, ip: "relay" }, offer ? { offerId: offer.offerId, owner: offer.owner } : null, rid);
    },
    log: app.log
  }) : null;
  app.addHook("onClose", async () => { clearInterval(decideTimer); relay?.close(); });

  return {
    /** Ends these devices' live sessions at once (a compromised rotation, C3); an idle channel would otherwise keep its events. */
    closeDevices(ids: ReadonlySet<string>) { for (const channel of channels) if (ids.has(channel.deviceId)) channel.socket.close(4403); },
    /** The owner's open sessions, oldest first. */
    live(owner: string): LiveChannel[] { return [...channels].filter((channel) => channel.owner === owner).map((channel) => ({ ...channel.live })); },
    /** A new RELAY offer: the relay client listens on its rid now, not at the next minute's sync. */
    relayOffered() { relay?.refresh(); }
  };
}
