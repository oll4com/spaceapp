import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createPublicKey, createSign, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  LINK_APP, MobileNoiseHandshake, decodeMobileFrame, decodeMobilePairQr, encodeMobileFrame, encodeMobilePairQr, mobileHandshakePrologue, mobileIntegrityRequestHash, mobilePairingPsk, noiseKeyPair, vaultBase64url as b64,
  type MobileFrame, type MobileNoiseTransport, type MobilePairQr
} from "@space/contracts";
import { InMemoryAppDeviceSessionRepository } from "@space/db";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { persistAgentFile } from "../src/cli-agent-files.js";
import { noteOperatorPaneInput } from "../src/queue-operator-grants.js";
import { InstanceLinkError } from "../src/instance-link/client.js";
import { instanceLinksFor } from "../src/instance-link/routes.js";
import { cookieName, createCsrfToken, hashPassword, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { MOBILE_APP_SIGNERS, verifyDecideKeyAttestation } from "../src/mobile/attestation.js";
import { MOBILE_DEMO_DEVICES_MAX } from "../src/mobile/channel.js";

// The attestation fixture's challenge never matches a live handshake: one pairing below takes a passing attestation to reach Play Integrity.
vi.mock("../src/mobile/attestation.js", async (original) => {
  const actual = await original<typeof import("../src/mobile/attestation.js")>();
  return { ...actual, verifyDecideKeyAttestation: vi.fn(actual.verifyDecideKeyAttestation) };
});

// Nous Pro 1b-5a (plan clipboard:kTV3y2lwO-99, ADR-013 §3, design §2.2, security review P1-5, P2-2, P2-6): pairing a phone over
// wss /api/mobile/channel with Noise XXpsk3, the phone side played by the contracts' own handshake.
const secret = "mobile-channel-test-secret-1234567890";
const clientId = "mobile-channel-client";
const operator = { id: "user:operator", email: "operator@example.test", role: "ADMIN" as const };
const attestation = JSON.parse(readFileSync(new URL("./fixtures/mobile-attestation-chains.json", import.meta.url), "utf8")).variants.tee as { chain: string[]; decidePublicSpki: string };
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const raw = (key: KeyObject) => Buffer.from(key.export({ format: "jwk" }).x!, "base64url");
const listenOn = (server: Server) => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`127.0.0.1:${(server.address() as AddressInfo).port}`)));

/**
 * The SpaceApp relay and push service (Nous Pro phase 2b) for these tests: oll4-cloud's own, spawned from OLL4_CLOUD_DIR's build with a test
 * licence key (no network to Google: push has no FCM key, so a wake of a handle it does not know answers 410), or else in-test fakes that
 * follow the same protocol (design §5, §8.1) and check the instance's signatures, without the licence check that lives in the relay.
 */
async function cloud(licenceKey: KeyObject) {
  const dir = process.env.OLL4_CLOUD_DIR;
  const wakes: unknown[] = [];
  const children: ChildProcess[] = [];
  if (dir) {
    let woken = 0;
    const start = async (service: string) => {
      const probe = createServer();
      const port = (await listenOn(probe)).split(":")[1]!;
      await new Promise((resolve) => probe.close(resolve));
      const child = spawn(process.execPath, [join(dir, `dist/${service}/main.js`)], { env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: port,
        OLL4_LICENSE_PUBLIC_KEYS: `test:${raw(licenceKey).toString("base64url")}` }, stdio: ["ignore", "pipe", "inherit"] });
      children.push(child);
      await new Promise((resolve, reject) => {
        child.once("exit", (code) => reject(new Error(`oll4-cloud ${service} exited (${code}) before it started`)));
        child.stdout!.on("data", (data: Buffer) => {
          if (data.includes(`${service}.started`)) resolve(null);
          // Push has no FCM key here: a wake of a registered handle reaches FCM's sender and fails there, never the network.
          woken += data.toString().split("push.fcm_failed").length - 1;
        });
      });
      return `127.0.0.1:${port}`;
    };
    return { relay: `ws://${await start("relay")}`, push: `http://${await start("push")}`, wakes: null, woken: () => woken, dropListener: null, instanceCloses: null,
      close: async () => { for (const child of children) child.kill(); } };
  }
  const signed = (identity: string, signature: string, ...parts: Buffer[]) =>
    verify(null, Buffer.concat(parts), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: identity }, format: "jwk" }), Buffer.from(signature, "base64url"));
  const relay = createServer();
  const wss = new WebSocketServer({ server: relay });
  const listeners = new Map<string, { socket: WebSocket; rids: string[] }>();
  const pending = new Map<string, { device: WebSocket; identity: string }>();
  const instanceCloses: number[] = [];
  const first = (ws: WebSocket, next: (message: Record<string, unknown>, nonce: Buffer) => void) => {
    const nonce = randomBytes(32);
    ws.once("message", (data: RawData) => next(JSON.parse(String(data)), nonce));
    ws.send(JSON.stringify({ t: "challenge", nonce: nonce.toString("base64url") }));
  };
  wss.on("connection", (ws, request) => {
    const url = new URL(request.url!, "http://relay");
    const accept = /^\/v1\/accept\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
    if (url.pathname === "/v1/listen") return first(ws, (message, nonce) => {
      const rids = message.rids as string[], identity = message.identity as string;
      if (!signed(identity, message.sig as string, Buffer.from("spaceapp-relay-listen-v1"), nonce, ...[...rids].sort().map((rid) => Buffer.from(rid, "base64url")))) return ws.close(4401);
      listeners.get(identity)?.socket.close(4409, "replaced");
      listeners.set(identity, { socket: ws, rids });
      ws.on("close", () => { if (listeners.get(identity)?.socket === ws) listeners.delete(identity); });
      ws.send(JSON.stringify({ t: "listening", rids: rids.length }));
    });
    if (url.pathname === "/v1/connect") return first(ws, (message) => {
      const identity = (message.claim as { identity: string }).identity, rid = url.searchParams.get("rid")!;
      const listener = listeners.get(identity);
      if (message.t !== "connect" || !listener?.rids.includes(rid)) return ws.close(4404, "instance-offline");
      const sid = randomBytes(16).toString("base64url");
      pending.set(sid, { device: ws, identity });
      listener.socket.send(JSON.stringify({ t: "incoming", sid, rid }));
    });
    const waiting = accept && pending.get(accept[1]!);
    if (!waiting || !signed(waiting.identity, url.searchParams.get("sig")!, Buffer.from("spaceapp-relay-accept-v1"), Buffer.from(accept[1]!))) return ws.close(4401);
    pending.delete(accept[1]!);
    ws.on("close", (code) => instanceCloses.push(code));
    // As oll4-cloud's relay (PEER_CLOSE_OFFSET): one side's own 4400-4499 reaches the other as 4500-4599 (the instance's 4403 is the phone's
    // 4503, pair again), any other close as 1000 "peer-closed".
    for (const [from, to] of [[waiting.device, ws], [ws, waiting.device]] as const) {
      from.on("message", (data: RawData, isBinary: boolean) => { if (isBinary) to.send(data, { binary: true }); });
      from.on("close", (code: number) => (code >= 4400 && code <= 4499 ? to.close(code + 100, "peer-code") : to.close(1000, "peer-closed")));
    }
    waiting.device.send(JSON.stringify({ t: "ready" }));
  });
  // Registers any phone (the licence check is oll4-cloud's); a wake of a handle it does not know answers 410 handle-gone.
  const handles = new Set<string>();
  const push = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk; });
    request.on("end", () => {
      if (request.url === "/v1/handles") { const pushHandle = randomBytes(16).toString("base64url"); handles.add(pushHandle); return void response.end(JSON.stringify({ pushHandle })); }
      const wake = JSON.parse(body) as { h: string; w: string };
      wakes.push(wake);
      response.writeHead(handles.has(wake.h) ? 202 : 410).end();
    });
  });
  return { relay: `ws://${await listenOn(relay)}`, push: `http://${await listenOn(push)}`, wakes: wakes as Array<{ h: string; w: string }>,
    woken: () => (wakes as Array<{ h: string }>).filter((wake) => handles.has(wake.h)).length,
    /** The relay drops the instance's listener (a relay restart): the instance listens again. */
    instanceCloses,
    dropListener: (identity: string) => listeners.get(identity)?.socket.close(1012),
    close: async () => { wss.close(); relay.close(); push.close(); } };
}

describe("pairing a phone over the channel", () => {
  const dir = mkdtempSync(join(tmpdir(), "space-mobile-channel-"));
  writeFileSync(join(dir, "connector.key"), "c".repeat(48));
  // Play Integrity's service account (MASVS L2 step 7), a throwaway key; Google is faked per test.
  writeFileSync(join(dir, "play-integrity.json"), JSON.stringify({ type: "service_account", project_id: "test", client_email: "pi@test.iam.gserviceaccount.com",
    private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) }));
  const googleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const store = new InMemorySpaceStore();
  const eventBus = new SpaceEventBus();
  let app: Awaited<ReturnType<typeof createApp>>;
  const licenceKey = generateKeyPairSync("ed25519").privateKey;
  let services: Awaited<ReturnType<typeof cloud>>;
  const as = (token: string) => ({ cookie: `${cookieName}=${token}`, "x-space-csrf-token": createCsrfToken(token, secret)! });
  const person = as(signSession(operator, secret));
  const phone = as(signSession(operator, secret, Date.now(), { app: "nous" }));
  // C5: the operator's own connected Gmail, faked; every message it sends is kept here.
  const sentMail: string[] = [];
  const google = { googleConfigured: true, googleAccounts: async () => [{ email: operator.email, capabilities: ["MAIL_COMPOSE" as const] }], googleAccessToken: async () => "gmail-token" };
  const gmailFetch = (async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith("/messages/send")) return new Response("{}", { status: 404 });
    sentMail.push(Buffer.from(JSON.parse(String(init?.body)).raw, "base64url").toString("utf8"));
    return Response.json({ id: "m1", threadId: "t1" });
  }) as typeof fetch;

  /** The step-up the offer needs: a fresh sign-in of the operator's own Google account, Google answered by a stub. */
  async function stepUp() {
    const start = await app.inject({ method: "GET", url: "/api/auth/google/start?stepUp=mobile&json=true", headers: person });
    const state = new URL(start.json().authUrl).searchParams.get("state")!;
    const claims = { sub: "google-operator", email: operator.email, aud: clientId, iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 600,
      email_verified: true, auth_time: Math.floor(Date.now() / 1000) };
    const body = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "k", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    const idToken = `${body}.${createSign("RSA-SHA256").update(body).sign(googleKey.privateKey).toString("base64url")}`;
    const jwks = { keys: [{ ...googleKey.publicKey.export({ format: "jwk" }), kid: "k", alg: "RS256", use: "sig" }] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "https://oauth2.googleapis.com/token" ? Response.json({ id_token: idToken })
      : Response.json(jwks, { headers: { "cache-control": "public, max-age=3600" } })));
    const cookies = start.cookies.filter((cookie) => cookie.value).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const callback = await app.inject({ method: "GET", url: `/api/auth/google/callback?code=c&state=${encodeURIComponent(state)}`, headers: { cookie: `${person.cookie}; ${cookies}` } });
    vi.unstubAllGlobals();
    expect(callback.headers.location).toBe("/?mobileStepUp=ok");
  }
  const offer = async (): Promise<MobilePairQr> =>
    decodeMobilePairQr((await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: person, payload: {} })).json().qr, Math.floor(Date.now() / 1000));

  /** A Pro licence for a fresh device key, signed with the test licence key; the device key signs its proofs. */
  function licence() {
    const deviceKey = generateKeyPairSync("ed25519"), now = Math.floor(Date.now() / 1000);
    const head = `SAL1.${Buffer.from(JSON.stringify({ v: 1, kid: "test", jti: randomBytes(16).toString("base64url"), plan: "PRO", iat: now, nbf: now, exp: now + 3600,
      dk: createHash("sha256").update(raw(deviceKey.publicKey)).digest("base64url"), inst: 1 })).toString("base64url")}`;
    return { license: `${head}.${sign(null, Buffer.from(head), licenceKey).toString("base64url")}`, dl: raw(deviceKey.publicKey).toString("base64url"),
      pop: (...parts: Buffer[]) => sign(null, Buffer.concat(parts), deviceKey.privateKey).toString("base64url") };
  }
  /**
   * A phone's socket through the relay to rendezvous id `rid` (Nous Pro phase 2b): the relay's challenge answered with a Pro licence, the
   * device key's proof and the instance identity it pins, as the Nous app does; open once the relay says ready (a close code otherwise).
   */
  async function viaRelay(qr: MobilePairQr, rid: string, onInit: (socket: WebSocket) => void) {
    const { license, dl, pop } = licence();
    const ws = new WebSocket(`${services.relay}/v1/connect?rid=${rid}`);
    onInit(ws);
    await new Promise((resolve) => {
      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        const message = JSON.parse(String(data));
        if (message.t === "ready") resolve(null);
        if (message.t === "challenge") ws.send(JSON.stringify({ t: "connect", license, dl, claim: { identity: qr.i },
          pop: pop(Buffer.from("spaceapp-relay-connect-v1"), Buffer.from(message.nonce, "base64url"), Buffer.from(rid, "base64url")) }));
      });
      ws.on("close", resolve);
    });
    return ws;
  }
  /** One phone socket: the raw messages in, its close code, and after the handshake the decrypted frames and requests. */
  async function open(url: string, relayed?: { qr: MobilePairQr; rid: string }) {
    const inbox: Uint8Array[] = [];
    const state: { closed?: number; reason?: string } = {};
    const onInit = (socket: WebSocket) => {
      socket.on("message", (data: Buffer, isBinary: boolean) => { if (isBinary) inbox.push(new Uint8Array(data)); });
      socket.on("close", (closeCode: number, reason: Buffer) => { state.closed = closeCode; state.reason = String(reason); });
    };
    const ws = relayed ? await viaRelay(relayed.qr, relayed.rid, onInit) : await app.injectWS(url, {}, { onInit });
    let transport: MobileNoiseTransport | null = null, read = 0, nextId = 1;
    const frames: MobileFrame[] = [];
    const drain = () => { while (transport && read < inbox.length) frames.push(decodeMobileFrame(transport.decrypt(inbox[read++]!))); };
    const phone = {
      ws, inbox, state, frames: () => (drain(), frames),
      /** Waits for the n-th raw message, or the close. */
      async message(index: number) { await vi.waitFor(() => expect(inbox.length > index || state.closed !== undefined).toBe(true)); return inbox[index]; },
      begin(next: MobileNoiseTransport, consumed: number) { transport = next; read = consumed; },
      send(frame: MobileFrame) { ws.send(transport!.encrypt(encodeMobileFrame(frame))); },
      async request(m: string, p: string, body?: unknown) {
        const id = nextId++;
        ws.send(transport!.encrypt(encodeMobileFrame({ type: "req", header: { id, m, p, ...(body === undefined ? {} : { h: { "content-type": "application/json" } }) },
          body: body === undefined ? new Uint8Array(0) : json(body) })));
        await vi.waitFor(() => expect(phone.frames().some((frame) => frame.type === "res" && frame.header.id === id) || state.closed !== undefined).toBe(true));
        const res = frames.find((frame) => frame.type === "res" && frame.header.id === id);
        return { status: res?.header.s as number | undefined, body: res ? JSON.parse(text(res.body)) : null };
      }
    };
    return phone;
  }
  /** The phone's side of XXpsk3: the close code if it ended, the Paired control frame, and the open session. */
  async function pair(qr: MobilePairQr, request: Record<string, unknown> = {}, code = qr.c, relayed = false) {
    const offerId = b64.decode(qr.o), device = noiseKeyPair();
    const handshake = new MobileNoiseHandshake({ pattern: "XXpsk3", initiator: true, prologue: mobileHandshakePrologue("pair", offerId, relayed ? b64.decode(qr.r!) : null), s: device,
      psk: mobilePairingPsk(b64.decode(code), b64.decode(qr.k), b64.decode(qr.i), offerId) });
    const phone = await open(`/api/mobile/channel?m=pair&o=${qr.o}`, relayed ? { qr, rid: qr.r! } : undefined);
    phone.ws.send(handshake.writeMessage());
    const second = await phone.message(0);
    if (!second) return { closed: phone.state.closed, paired: null, phone, device };
    expect(JSON.parse(text(handshake.readMessage(second)))).toEqual({ i: qr.i });
    expect(b64.encode(handshake.remoteStatic!)).toBe(qr.k);
    phone.ws.send(handshake.writeMessage(json({ deviceName: "Pixel 10", app: "nous", appVersion: "0.3.0", platform: "android", wantScopes: ["read", "act", "decide"], ...request })));
    if (!(await phone.message(1))) return { closed: phone.state.closed, paired: null, phone, device };
    phone.begin(handshake.split(), 1);
    return { closed: phone.state.closed, paired: phone.frames()[0]!.header, phone, device };
  }
  /** The phone's IK connect with its pinned instance key; the Welcome, or the close code. */
  async function connect(qr: MobilePairQr, device: ReturnType<typeof noiseKeyPair>, hello: Record<string, unknown>, replay?: Uint8Array, rid?: string) {
    const handshake = new MobileNoiseHandshake({ pattern: "IK", initiator: true, prologue: mobileHandshakePrologue("ik", null, rid ? b64.decode(rid) : null), s: device, rs: b64.decode(qr.k) });
    const phone = await open("/api/mobile/channel?m=ik", rid ? { qr, rid } : undefined);
    const first = replay ?? handshake.writeMessage(json({ appVersion: "0.3.0", ts: Date.now(), nonce: b64.encode(randomBytes(16)), ...hello }));
    phone.ws.send(first);
    const second = await phone.message(0);
    if (!second || replay) return { closed: phone.state.closed, welcome: null, phone, first };
    const welcome = JSON.parse(text(handshake.readMessage(second)));
    phone.begin(handshake.split(), 1);
    return { closed: phone.state.closed, welcome, phone, first };
  }
  const audit = async (action: string, targetId?: string) => (await store.listAuditEvents()).find((event) => event.action === action && (!targetId || event.targetId === targetId));
  const cards = async () => (await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers: person })).json().notifications
    .filter((card: { kind: string }) => card.kind === "MOBILE_PAIRED") as Array<{ title: string; severity: string; payload: { deviceId: string } }>;

  beforeAll(async () => {
    services = await cloud(licenceKey);
    await store.upsertUser(operator);
    await store.linkGoogleAccount(operator.id, { sub: "google-operator", email: operator.email });
    app = await createApp({ store, eventBus, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: join(dir, "connector.key"),
      SPACE_MOBILE_RELAY_URL: services.relay, SPACE_MOBILE_PUSH_URL: services.push, SPACE_PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE: join(dir, "play-integrity.json"), SPACE_ARTIFACT_ROOT: dir }),
      auth: { sessionSecret: secret, devLogin: false, secureCookies: false, googleClientId: clientId }, mailCopilotGoogle: google, mailCopilotGmailFetch: gmailFetch });
    await app.ready();
    await stepUp();
    expect((await app.inject({ method: "POST", url: "/api/mobile/instance", headers: person, payload: {} })).json()).toMatchObject({ configured: true });
  });
  afterAll(async () => { await app?.close(); await services?.close(); });

  it("pairs with the code, held with read only and an URGENT card until the person allows it", async () => {
    const { closed, paired, phone: session } = await pair(await offer());
    expect(closed).toBeUndefined();
    expect(paired).toMatchObject({ op: "paired", deviceId: expect.stringMatching(/^appdev:/), scopes: ["read"], pending: ["read", "act"], rid: null, instanceLabel: "SpaceApp localhost" });
    const deviceId = paired!.deviceId as string;
    // The session goes on as a channel: a held phone reads, and nothing more.
    expect(await session.request("GET", "/api/auth/me")).toMatchObject({ status: 200, body: { user: { id: operator.id } } });
    expect(await session.request("POST", "/api/nous/messages", { content: "hi" })).toMatchObject({ status: 403, body: { error: { code: "MOBILE_SCOPE_DENIED" } } });
    session.ws.terminate();
    expect(await cards()).toEqual([expect.objectContaining({ title: "New device paired: Pixel 10", severity: "URGENT", payload: { deviceId } })]);
    // C5 (internal MASVS review 1/11): the pairing is also e-mailed to the operator's sign-in address from their own Gmail.
    await vi.waitFor(async () => expect(await audit("mobile.pairing.mailed", deviceId)).toMatchObject({ metadata: { result: "SENT", from: operator.email } }));
    const mail = sentMail[0]!;
    expect(mail).toMatch(new RegExp(`^To: ${operator.email}\r$`, "m"));
    expect(mail).toMatch(/^Subject: New device paired with SpaceApp: Pixel 10\r$/m);
    expect(await audit("mobile.pairing.completed", deviceId)).toMatchObject({ metadata: { requestedScopes: ["read", "act"], decide: "none" } });

    expect((await app.inject({ method: "POST", url: `/api/auth/devices/${deviceId}/allow`, headers: phone })).statusCode).toBe(403);
    const allowed = await app.inject({ method: "POST", url: `/api/auth/devices/${deviceId}/allow`, headers: person });
    expect(allowed.statusCode).toBe(200);
    expect(await audit("mobile.pairing.allowed", deviceId)).toMatchObject({ metadata: { scopes: ["read", "act"] } });
    expect(await cards()).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/api/auth/devices/${deviceId}/allow`, headers: person })).statusCode).toBe(404);
  });

  it("connects a paired phone with IK: the Hello checks, a replay, the allowed scopes, and a revoke that ends it", async () => {
    const qr = await offer();
    const { paired, phone: pairing, device } = await pair(qr);
    pairing.ws.terminate();
    const deviceId = paired!.deviceId as string;
    expect((await connect(qr, noiseKeyPair(), { deviceId })).closed).toBe(4403);
    expect((await connect(qr, device, { deviceId: "appdev:someone-else" })).closed).toBe(4403);
    expect((await connect(qr, device, { deviceId, ts: Date.now() - 301_000 })).closed).toBe(4408);
    const held = await connect(qr, device, { deviceId });
    expect(held.welcome).toMatchObject({ scopes: ["read"], limits: { maxFrame: 65_535, maxInFlight: 16 } });
    expect((await connect(qr, device, { deviceId }, held.first)).closed).toBe(4409);
    expect(await held.phone.request("GET", "/api/%2e%2e/admin/users")).toMatchObject({ status: 400, body: { error: { code: "MOBILE_BAD_PATH" } } });
    expect(await held.phone.request("GET", "/api/user-settings")).toMatchObject({ status: 403, body: { error: { code: "MOBILE_SCOPE_DENIED" } } });
    // The per-request checks run for injected requests: no room media by id.
    expect(await held.phone.request("GET", "/api/artifacts/art_media/file")).toMatchObject({ status: 403, body: { error: { code: "MOBILE_SCOPE_DENIED" } } });
    held.phone.ws.terminate();

    expect((await app.inject({ method: "POST", url: `/api/auth/devices/${deviceId}/allow`, headers: person })).statusCode).toBe(200);
    const allowed = await connect(qr, device, { deviceId });
    expect(allowed.welcome.scopes).toEqual(["read", "act"]);
    expect((await allowed.phone.request("POST", "/api/notifications/read-all", {})).status).toBe(200);
    // An upload in chunk frames is one request once its last chunk is in; the app's X-Space-Client rides in the frame (plan 4TXfIZzj8ITW step 5).
    allowed.phone.send({ type: "req", header: { id: 90, m: "POST", p: "/api/notifications/read-all", h: { "content-type": "application/json", "x-space-client": "app=NOUS_ANDROID; v=0.2.22" }, more: true }, body: new TextEncoder().encode("{") });
    allowed.phone.send({ type: "chunk", header: { id: 90, seq: 1, more: false }, body: new TextEncoder().encode("}") });
    await vi.waitFor(() => expect(allowed.phone.frames().find((frame) => frame.type === "res" && frame.header.id === 90)?.header.s).toBe(200));
    // C8: a JSON body is re-serialized whatever the media type's parameters (the frame schema already pins header names to lower case).
    allowed.phone.send({ type: "req", header: { id: 91, m: "POST", p: "/api/notifications/read-all", h: { "content-type": "application/json; charset=utf-8" } }, body: new TextEncoder().encode("{") });
    await vi.waitFor(() => expect(allowed.phone.frames().some((frame) => frame.type === "res" && frame.header.id === 91)).toBe(true));
    expect(JSON.parse(text(allowed.phone.frames().find((frame) => frame.type === "res" && frame.header.id === 91)!.body))).toMatchObject({ error: { code: "MOBILE_BAD_BODY" } });
    // Events as ids only, never another owner's.
    allowed.phone.send({ type: "ctl", header: { op: "sub", topic: "events" }, body: new Uint8Array(0) });
    await vi.waitFor(() => {
      for (const ownerUserId of ["user:someone-else", operator.id]) eventBus.publish({ id: `ev_${ownerUserId}`, roomId: null, paneId: null, turnId: null, workflowId: null, traceId: "req:t",
        type: "NOTIFICATION_CREATED", message: "Created.", payload: { notificationId: "notif:mine", ownerUserId, title: "secret" }, createdAt: new Date().toISOString() } as never);
      // The test's own event: a notification the requests above created may come first.
      expect(allowed.phone.frames().filter((frame) => frame.type === "evt").map((frame) => frame.header as { ids?: Record<string, string> }).find((evt) => evt.ids?.notificationId === "notif:mine")).toEqual({ type: "NOTIFICATION_CREATED", ids: { notificationId: "notif:mine" } });
    });
    // The revoke alone ends the open channel, with no request from the phone (plan kTV3y2lwO-99 item 5).
    expect((await app.inject({ method: "POST", url: `/api/auth/devices/${deviceId}/revoke`, headers: person })).statusCode).toBe(200);
    await vi.waitFor(() => expect(allowed.phone.state.closed).toBe(4403));
    expect((await connect(qr, device, { deviceId })).closed).toBe(4403);
  });

  // Space Link (ADR-014): another SpaceApp's Nous pairs as a device of app spaceapp-link, held like a phone, then reaches LINK_ROUTE_SCOPES only.
  it("a SpaceApp link pairs as a server, is held until allowed, and reaches Space Control's state and panes, never screens, Nous or the Vault", async () => {
    const qr = await offer();
    const { paired, phone: pairing, device } = await pair(qr, { deviceName: "SpaceApp vm207", app: LINK_APP, appVersion: "1.3.0", platform: "server", wantScopes: ["read", "act"] });
    pairing.ws.terminate();
    const deviceId = paired!.deviceId as string;
    expect(paired).toMatchObject({ scopes: ["read"], pending: ["read", "act"] });
    expect(await cards()).toContainEqual(expect.objectContaining({ title: "New SpaceApp link: SpaceApp vm207", severity: "URGENT", payload: { deviceId } }));
    expect((await app.inject({ method: "POST", url: `/api/auth/devices/${deviceId}/allow`, headers: person })).statusCode).toBe(200);
    const link = (await connect(qr, device, { deviceId, appVersion: "1.3.0" })).phone;
    const denied = { status: 403, body: { error: { code: "MOBILE_SCOPE_DENIED" } } }, refused = { status: 400, body: { error: { code: "MOBILE_BODY" } } };
    expect(await link.request("GET", "/api/auth/me")).toMatchObject({ status: 200, body: { user: { id: operator.id } } });
    expect((await link.request("POST", "/api/control/v1/inspect", { section: "STATE" })).status).not.toBe(403);
    expect(await link.request("POST", "/api/control/v1/inspect", { section: "CONTENT" })).toMatchObject(refused);
    expect(await link.request("POST", "/api/control/v1/commands", { roomId: "room:a", requestId: "r1", actions: [{ kind: "cli", runtimeId: "codex", enabled: false }] })).toMatchObject(refused);
    expect(await link.request("POST", "/api/control/v1/commands", { roomId: "room:a", requestId: "r1", userExplicitlyAuthorized: true, actions: [{ kind: "pane", operation: "close", target: {} }] })).toMatchObject(refused);
    // An encoded byte the router decodes still names no link route, so it never gets round the lease (security review 13/11).
    expect(await link.request("POST", "/api/control/v1/comm%61nds", { roomId: "room:a", requestId: "r1", actions: [] })).toMatchObject(denied);
    // The phone's routes are not the link's: no Nous chat, no notifications, no Vault, no settings.
    for (const [m, p] of [["GET", "/api/nous"], ["POST", "/api/notifications/read-all"], ["GET", "/api/space-vault/items"], ["GET", "/api/user-settings"]] as const) {
      expect(await link.request(m, p, m === "POST" ? {} : undefined), `${m} ${p}`).toMatchObject(denied);
    }
    link.ws.terminate();
    expect((await app.inject({ method: "POST", url: `/api/auth/devices/${deviceId}/revoke`, headers: person })).statusCode).toBe(200);
  });

  // Space Link slice 2 (ADR-014): this SpaceApp's own client pairs with a listening SpaceApp (here itself, on a real socket) from the code
  // its person pastes, keeps the device key sealed, connects with IK once allowed, and forgets the key when the link is removed.
  it("links another SpaceApp from its pairing code, connects once allowed, and forgets the link when removed", async () => {
    const origin = `http://${await app.listen({ port: 0, host: "127.0.0.1" }).then((url) => new URL(url).host)}`;
    const code = encodeMobilePairQr({ ...(await offer()), u: [origin], r: null });
    expect((await app.inject({ method: "POST", url: "/api/instance-links", headers: phone, payload: { code } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/instance-links", headers: person, payload: { code: "SPACEAPP-PAIR:1:bad" } })).statusCode).toBe(400);
    const linked = await app.inject({ method: "POST", url: "/api/instance-links", headers: person, payload: { code } });
    expect(linked.json()).toMatchObject({ link: { id: expect.stringMatching(/^link:/), origins: [origin], scopes: ["read"], connected: false }, pending: ["read", "act"] });
    expect(linked.body).not.toContain(code.slice(16));
    const { id, deviceId } = linked.json().link as { id: string; deviceId: string };
    expect(await cards()).toContainEqual(expect.objectContaining({ title: expect.stringMatching(/^New SpaceApp link: SpaceApp /), payload: { deviceId } }));
    expect(await audit("instance_link.paired", id)).toMatchObject({ metadata: { deviceId, pending: ["read", "act"] } });
    expect((await app.inject({ method: "POST", url: `/api/auth/devices/${deviceId}/allow`, headers: person })).statusCode).toBe(200);
    const checked = await app.inject({ method: "POST", url: `/api/instance-links/${id}/check`, headers: person });
    expect(checked.json()).toMatchObject({ status: 200, scopes: ["read", "act"], link: { connected: true, scopes: ["read", "act"], lastSeenAt: expect.any(String) } });
    // A second check reuses the open session.
    expect((await app.inject({ method: "POST", url: `/api/instance-links/${id}/check`, headers: person })).json()).toMatchObject({ status: 200 });
    expect((await app.inject({ method: "GET", url: "/api/instance-links", headers: person })).json().links).toEqual([expect.objectContaining({ id, connected: true })]);
    expect((await app.inject({ method: "GET", url: "/api/instance-links", headers: person })).body).not.toContain("sealed");
    // Slice 3: what Nous's space_remote calls, by the link's name; this side sends only the link's routes, the other side keeps its gates.
    const links = instanceLinksFor(store)!;
    const label = (await links.list(operator.id))[0]!.label;
    expect(await links.request(operator.id, label, "GET", "/api/rooms")).toMatchObject({ status: 200, link: { id }, rttMs: expect.any(Number) });
    await expect(links.request(operator.id, id, "GET", "/api/space-vault/items")).rejects.toThrow(/answers only GET \/api\/auth\/me/);
    await expect(links.request(operator.id, id, "GET", "/api/control/v1/layout/../../space-vault/items")).rejects.toThrow(InstanceLinkError);
    await expect(links.request(operator.id, "nope", "GET", "/api/rooms")).rejects.toThrow("No linked SpaceApp is nope.");
    await expect(links.request("user:other", id, "GET", "/api/rooms")).rejects.toThrow(InstanceLinkError);
    // Λ7: each linked SpaceApp's own load, read through its link; a phone never reaches it.
    expect((await app.inject({ method: "GET", url: "/api/instance-links/load?range=24h", headers: person })).json())
      .toMatchObject({ instances: [{ link: { id }, error: null, load: { range: "24h", target: expect.any(Number) } }] });
    expect((await app.inject({ method: "GET", url: "/api/instance-links/load?range=1y", headers: person })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/instance-links/load", headers: phone })).statusCode).toBe(403);
    // Λ6: Nous's world reads each link's overview in the background, never waiting for it.
    expect(await links.peers(operator.id)).toEqual([expect.objectContaining({ link: expect.objectContaining({ id }), at: null })]);
    expect(await vi.waitFor(async () => { const [peer] = await links.peers(operator.id); expect(peer!.at).not.toBeNull(); return peer; }))
      .toMatchObject({ error: null, overview: { live: { agents: expect.any(Object) }, plans: expect.any(Array) } });
    expect(await links.request(operator.id, id, "POST", "/api/control/v1/commands", { roomId: "room:a", requestId: "r2", userExplicitlyAuthorized: true,
      actions: [{ kind: "pane", operation: "close", target: {} }] })).toMatchObject({ status: 400, body: { error: { code: "MOBILE_BODY" } } });
    // Λ4: that act is audited on both sides under one trace id; the reads above are not. History lists this side's rows.
    const acted = await vi.waitFor(async () => {
      const rows = (await store.listAuditEvents()).filter((event) => event.action === "instance_link.request");
      const outs = rows.filter((row) => row.targetType === "instance_link");
      expect(outs).toHaveLength(1);
      return rows.filter((row) => row.traceId === outs[0]!.traceId);
    });
    const out = acted.find((row) => row.targetType === "instance_link")!;
    expect(acted).toHaveLength(2);
    expect(out).toMatchObject({ targetId: id, traceId: expect.stringMatching(/^lnk:/), metadata: { via: "link-out", method: "POST", path: "/api/control/v1/commands", status: 400 } });
    expect(acted.find((row) => row.targetType === "app_device")).toMatchObject({ targetId: deviceId, traceId: out.traceId, metadata: { via: "link", status: 400 } });
    expect((await app.inject({ method: "GET", url: `/api/instance-links/${id}/history`, headers: person })).json().events).toEqual([
      expect.objectContaining({ action: "instance_link.request", requestId: out.traceId }), expect.objectContaining({ action: "instance_link.paired" })]);
    expect((await app.inject({ method: "GET", url: "/api/instance-links/link:none/history", headers: person })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/instance-links/${id}/history`, headers: phone })).statusCode).toBe(403);
    // Slice 4, the Remote mark: the managed side (here the same SpaceApp) sees the link's session, address, scopes and last request; a phone never does.
    expect((await app.inject({ method: "GET", url: "/api/auth/devices/live", headers: person })).json().sessions).toContainEqual(expect.objectContaining({ deviceId,
      app: "spaceapp-link", ip: expect.stringMatching(/127\.0\.0\.1/), scopes: ["read", "act"], since: expect.any(String),
      last: { method: "POST", path: "/api/control/v1/commands", at: expect.any(String) } }));
    expect((await app.inject({ method: "GET", url: "/api/auth/devices/live", headers: phone })).statusCode).toBe(403);
    // Slice 5, the lease: that act took it; Take back holds the link at reading (and B's Nous works again) until Give back.
    const close = { roomId: "room:a", requestId: "r3", actions: [{ kind: "pane", operation: "close", target: {} }] };
    expect((await app.inject({ method: "GET", url: "/api/auth/devices/live", headers: person })).json()).toMatchObject({ lease: { deviceId }, takenBackAt: null });
    expect((await app.inject({ method: "POST", url: "/api/auth/devices/live/take-back", headers: phone, payload: {} })).statusCode).toBe(403);
    // Λ9, the Nous app's mark: the same reading without any address; a phone takes management back (Give back stays on a computer).
    const status = await app.inject({ method: "GET", url: "/api/instance-links/status", headers: phone });
    expect(status.json()).toMatchObject({ remote: [expect.objectContaining({ deviceId, app: "spaceapp-link", scopes: ["read", "act"], last: expect.any(Object) })],
      lease: { deviceId }, takenBackAt: null, managing: [{ id, label, scopes: ["read", "act"], lastSeenAt: expect.any(String) }] });
    expect(status.json().remote[0]).not.toHaveProperty("ip");
    expect((await app.inject({ method: "POST", url: "/api/instance-links/status/take-back", headers: phone, payload: {} })).json()).toMatchObject({ lease: null, takenBackAt: expect.any(String) });
    expect((await app.inject({ method: "POST", url: "/api/auth/devices/live/take-back", headers: person, payload: {} })).json()).toMatchObject({ lease: null, takenBackAt: expect.any(String) });
    expect(await audit("instance_link.taken_back", operator.id)).toBeDefined();
    expect(await links.request(operator.id, id, "POST", "/api/control/v1/commands", close)).toMatchObject({ status: 409, body: { error: { code: "LINK_TAKEN_BACK" } } });
    expect((await links.request(operator.id, id, "GET", "/api/rooms")).status).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/devices/live/give-back", headers: person, payload: {} })).json()).toMatchObject({ takenBackAt: null });
    expect((await links.request(operator.id, id, "POST", "/api/control/v1/commands", close)).status).not.toBe(409);
    // Λ5 human wins per pane: a pane the operator in person just sent a line to is theirs; the link's act on it waits, others go on.
    const held = store.createPane({ roomId: store.createRoom({ name: "Held", initialPaneCount: 0 }).id, title: "Builder", mode: "TERMINAL" });
    noteOperatorPaneInput(held.id, "keep going\r");
    expect(await links.request(operator.id, id, "POST", "/api/control/v1/commands", { ...close, roomId: held.roomId, requestId: "r4" }))
      .toMatchObject({ status: 409, body: { error: { code: "HELD_BY_OPERATOR" } } });
    expect((await links.request(operator.id, id, "POST", "/api/control/v1/commands", { ...close, roomId: held.roomId, requestId: "r5",
      actions: [{ kind: "pane", operation: "close", target: { paneIds: ["pane:notheld1"] } }] })).body).not.toMatchObject({ error: { code: "HELD_BY_OPERATOR" } });
    expect((await app.inject({ method: "DELETE", url: `/api/instance-links/${id}`, headers: person })).json()).toEqual({ ok: true });
    expect(await audit("instance_link.removed", id)).toBeDefined();
    expect((await app.inject({ method: "GET", url: "/api/instance-links", headers: person })).json().links).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/api/instance-links/${id}/check`, headers: person })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/auth/devices/${deviceId}/revoke`, headers: person })).statusCode).toBe(200);
  });

  // Nous Pro phase 2b (plan clipboard:kTV3y2lwO-99 step 6, design §5, §8.1): a phone behind NAT pairs and connects through the instance's
  // outbound relay listener, bound to its rendezvous id, and a Pro phone's push handle is woken with an opaque id only.
  it("pairs and connects a phone through the relay on its own rendezvous id, and wakes it through the push service", async () => {
    const direct = await offer();
    const { paired: directPaired, phone: directPairing, device: directDevice } = await pair(direct);
    directPairing.ws.terminate();
    // Each new pairing raises an URGENT card, which wakes; the phones it pairs leave with the test.
    const extra = [directPaired!.deviceId as string];
    const urgent = async () => { const paired = await pair(await offer()); paired.phone.ws.terminate(); extra.push(paired.paired!.deviceId as string); };
    const qr = decodeMobilePairQr((await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: person, payload: { transport: "RELAY" } })).json().qr, Math.floor(Date.now() / 1000));
    expect(qr).toMatchObject({ r: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), u: ["http://localhost"] });
    // The instance listens on the offer's rid at once; until it does, the relay answers instance-offline (4404) and nothing is claimed.
    const relayedPair = await vi.waitFor(async () => { const attempt = await pair(qr, {}, qr.c, true); expect(attempt.closed).not.toBe(4404); return attempt; }, { interval: 300 });
    expect(relayedPair.closed).toBeUndefined();
    expect(relayedPair.paired).toMatchObject({ op: "paired", scopes: ["read"], rid: qr.r });
    const deviceId = relayedPair.paired!.deviceId as string;
    expect(await relayedPair.phone.request("GET", "/api/auth/me")).toMatchObject({ status: 200, body: { user: { id: operator.id } } });
    expect(await audit("mobile.pairing.completed", deviceId)).toMatchObject({ metadata: { via: "relay" } });
    relayedPair.phone.ws.terminate();
    expect((await app.inject({ method: "POST", url: `/api/auth/devices/${deviceId}/allow`, headers: person })).statusCode).toBe(200);

    // IK through the relay on the device's own rendezvous id only: another phone on that rid is refused.
    // The relay passes the instance's 4403 to the phone as 4503; the fake relay sees the instance's 4403.
    const refused = await connect(qr, directDevice, { deviceId: directPaired!.deviceId }, undefined, qr.r!);
    expect(refused).toMatchObject({ welcome: null, closed: 4503 });
    if (services.instanceCloses) expect(services.instanceCloses.at(-1)).toBe(4403);
    let session = await connect(qr, relayedPair.device, { deviceId }, undefined, qr.r!);
    expect(session.welcome).toMatchObject({ scopes: ["read", "act"] });
    if (services.dropListener) {
      // The relay restarts: the instance listens again after its backoff and the phone comes back.
      session.phone.ws.terminate();
      services.dropListener(qr.i);
      session = await vi.waitFor(async () => { const again = await connect(qr, relayedPair.device, { deviceId }, undefined, qr.r!); expect(again.welcome).toBeTruthy(); return again; },
        { timeout: 5000, interval: 400 });
    }

    // The phone registers with push (its licence) and gives the instance only the opaque handle; an URGENT card wakes it.
    const { license, dl, pop } = licence();
    const handle = (await (await fetch(`${services.push}/v1/handles`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fcmToken: "fcm-test-token", license, dl, pop: pop(Buffer.from("spaceapp-push-v1"), Buffer.from("fcm-test-token")) }) })).json()).pushHandle as string;
    session.phone.send({ type: "ctl", header: { op: "push-handle", handle }, body: new Uint8Array(0) });
    await session.phone.request("GET", "/api/auth/me");
    const woken = services.woken();
    await urgent();
    await vi.waitFor(() => expect(services.woken()).toBe(woken + 1));
    if (services.wakes) {
      expect(services.wakes.at(-1)).toEqual({ h: handle, w: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/) });
      // A handle the push service no longer knows (410) is forgotten: the next card wakes nothing.
      const gone = randomBytes(16).toString("base64url");
      session.phone.send({ type: "ctl", header: { op: "push-handle", handle: gone }, body: new Uint8Array(0) });
      await session.phone.request("GET", "/api/auth/me");
      await urgent();
      await vi.waitFor(() => expect(services.wakes!.filter((wake) => wake.h === gone)).toHaveLength(1));
      await urgent();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(services.wakes.filter((wake) => wake.h === gone)).toHaveLength(1);
    }
    session.phone.ws.terminate();

    // Cleo/Oscar 3/11 (lab): a relay-only phone revoked while offline got the relay's 4404 (instance offline) forever, because the instance's
    // listener dropped its rid at the next sync. Its rid stays listened until the row is pruned, so its next connect gets 4503 (pair again).
    expect((await app.inject({ method: "POST", url: `/api/auth/devices/${deviceId}/revoke`, headers: person })).statusCode).toBe(200);
    // A new RELAY offer makes the listener sync again; once a phone pairs on it, the listen after the revoke is the relay's.
    const next = decodeMobilePairQr((await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: person, payload: { transport: "RELAY" } })).json().qr, Math.floor(Date.now() / 1000));
    const nextPair = await vi.waitFor(async () => { const attempt = await pair(next, {}, next.c, true); expect(attempt.closed).not.toBe(4404); return attempt; }, { interval: 300 });
    nextPair.phone.ws.terminate();
    extra.push(nextPair.paired!.deviceId as string);
    expect(await connect(qr, relayedPair.device, { deviceId }, undefined, qr.r!)).toMatchObject({ welcome: null, closed: 4503 });
    if (services.instanceCloses) expect(services.instanceCloses.at(-1)).toBe(4403);
    for (const id of extra) expect((await app.inject({ method: "POST", url: `/api/auth/devices/${id}/revoke`, headers: person })).statusCode).toBe(200);
  });

  // C2 (internal MASVS review 1/11): chunks count against the buffered-bytes caps and an upload holds a request slot from its first frame.
  it("drops an upload whose chunks pass the channel's cap, holds uploads to the channel's slots, and skips a refused upload's chunks", async () => {
    const qr = await offer();
    const { paired, phone: pairing, device } = await pair(qr);
    pairing.ws.terminate();
    const { phone: held } = await connect(qr, device, { deviceId: paired!.deviceId });
    const part = new Uint8Array(60_000);
    const upload = (id: number, chunks: number, last = true) => {
      held.send({ type: "req", header: { id, m: "POST", p: "/api/notifications/read-all", more: true }, body: part });
      for (let seq = 1; seq <= chunks; seq++) held.send({ type: "chunk", header: { id, seq, more: !(last && seq === chunks) }, body: part });
    };
    // Three uploads of 401 × 60,000 bytes (each under 25 MiB) pass the 64 MiB a channel buffers: the third is dropped with busy.
    upload(1, 400, false);
    upload(2, 400, false);
    upload(3, 400);
    await vi.waitFor(() => expect(held.frames().some((frame) => frame.type === "ctl" && frame.header.op === "busy" && frame.header.id === 3)).toBe(true), { timeout: 30_000 });
    // Uploads 1 and 2 hold two of the 16 slots: 14 more fit, the next is refused and its chunk skipped, not a protocol error.
    for (let id = 10; id < 24; id++) upload(id, 1, false);
    upload(30, 1);
    await vi.waitFor(() => expect(held.frames().find((frame) => frame.type === "res" && frame.header.id === 30)?.header.s).toBe(429));
    expect(held.state.closed).toBeUndefined();
    // A phone that leaves more refused uploads half sent than it has slots misuses the channel.
    for (let id = 40; id < 57; id++) upload(id, 0, false);
    await vi.waitFor(() => expect(held.state.closed).toBe(4400));
  });

  it("serves an Agent File up to 64 MiB in one answer, refuses more but serves it in Range pieces (13/11: 0.2.37 got 413 on the APK in Shared)", async () => {
    const room = store.createRoom({ name: "Files", initialPaneCount: 0 }, undefined, operator.id);
    const stage = async (name: string, size: number) => {
      const bytes = randomBytes(size);
      writeFileSync(join(dir, `staged-${name}`), bytes);
      const { artifact } = await persistAgentFile({ store, artifactRoot: dir, roomId: room.id, paneId: null, cliSessionId: null, runtimeId: "user",
        originalFilename: name, declaredMimeType: "application/vnd.android.package-archive", sourcePath: join(dir, `staged-${name}`),
        traceId: "trace:range", source: "AGENT_OUTPUT", folder: "Apps/Android" });
      return { bytes, path: `/api/artifacts/${encodeURIComponent(artifact.id)}/file` };
    };
    const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const fits = await stage("Nous-Android-9.9.8.apk", 60 * 1024 * 1024);
    const over = await stage("Nous-Android-9.9.9.apk", 70 * 1024 * 1024);
    const qr = await offer();
    const { paired, phone: pairing, device } = await pair(qr);
    pairing.ws.terminate();
    const { phone } = await connect(qr, device, { deviceId: paired!.deviceId });
    let nextId = 500;
    // The res frame and its chunk frames, joined, as the app reassembles them.
    const get = async (path: string, range?: string) => {
      const id = nextId++;
      phone.send({ type: "req", header: { id, m: "GET", p: path, ...(range ? { h: { range } } : {}) }, body: new Uint8Array(0) });
      const mine = () => phone.frames().filter((frame) => frame.header.id === id);
      await vi.waitFor(() => expect(mine().some((frame) => !frame.header.more)).toBe(true), { timeout: 30_000 });
      const frames = mine();
      return { status: frames[0]!.header.s, headers: frames[0]!.header.h as Record<string, string>, body: Buffer.concat(frames.map((frame) => frame.body)) };
    };
    // 0.2.37's Save to Downloads: one GET, no range.
    const whole = await get(fits.path);
    expect(whole.status).toBe(200);
    expect(sha(whole.body)).toBe(sha(fits.bytes));
    const refused = await get(over.path);
    expect(refused.status).toBe(413);
    expect(JSON.parse(refused.body.toString())).toMatchObject({ error: { code: "MOBILE_TOO_LARGE" } });
    const piece = 16 * 1024 * 1024;
    const parts: Buffer[] = [];
    for (let at = 0; at < over.bytes.length; at += piece) {
      const end = Math.min(at + piece, over.bytes.length) - 1;
      const part = await get(over.path, `bytes=${at}-${end}`);
      expect(part.status).toBe(206);
      expect(part.headers["content-range"]).toBe(`bytes ${at}-${end}/${over.bytes.length}`);
      parts.push(part.body);
    }
    expect(sha(Buffer.concat(parts))).toBe(sha(over.bytes));
    expect(phone.state.closed).toBeUndefined();
    phone.ws.terminate();
  }, 120_000);

  it("serves Nous 0.2.37's plain HTTPS update download (cookie mobile:<device>) as its open channel's request, and nothing else (nous_msg:268bc034)", async () => {
    const room = store.createRoom({ name: "Apps", initialPaneCount: 0 }, undefined, operator.id);
    const bytes = randomBytes(3 * 1024 * 1024);
    const file = async (originalFilename: string) => {
      writeFileSync(join(dir, `staged-${originalFilename}`), bytes);
      return (await persistAgentFile({ store, artifactRoot: dir, roomId: room.id, paneId: null, cliSessionId: null, runtimeId: "user", originalFilename,
        declaredMimeType: "application/octet-stream", sourcePath: join(dir, `staged-${originalFilename}`), traceId: "trace:bridge", source: "AGENT_OUTPUT", folder: "Apps/Android" })).artifact;
    };
    const apk = await file("Nous-Android-9.9.8.apk");
    const other = await file("notes.bin");
    const qr = await offer();
    const { paired, phone: pairing, device } = await pair(qr);
    pairing.ws.terminate();
    const deviceId = paired!.deviceId;
    const { phone } = await connect(qr, device, { deviceId });
    // The address the channel came from, as Settings › Devices shows it (injectWS has none: 0.0.0.0).
    const live = await app.inject({ method: "GET", url: "/api/auth/devices/live", headers: person });
    const address = (live.json() as { sessions: Array<{ deviceId: string; ip: string }> }).sessions.find((session) => session.deviceId === deviceId)!.ip;
    // As apk-install.ts sends it: okhttp, the channel token as both cookies, no invoke header, from the channel's own address.
    const download = (id: string, extra: { device?: string; remoteAddress?: string; range?: string } = {}) => app.inject({
      method: "GET", url: `/api/artifacts/${encodeURIComponent(id)}/file`, remoteAddress: extra.remoteAddress ?? address,
      headers: { cookie: `space_session=mobile:${extra.device ?? deviceId}; space_session_dev=mobile:${extra.device ?? deviceId}`, "user-agent": "okhttp/4.12.0",
        ...(extra.range ? { range: extra.range } : {}) } });
    const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    const whole = await download(apk.id);
    expect(whole.statusCode).toBe(200);
    expect(sha(whole.rawPayload)).toBe(sha(bytes));
    const resumed = await download(apk.id, { range: `bytes=1000-${bytes.length - 1}` });
    expect(resumed.statusCode).toBe(206);
    expect(sha(resumed.rawPayload)).toBe(sha(bytes.subarray(1000)));
    // Another address, another device, another file: still no session.
    expect((await download(apk.id, { remoteAddress: "10.9.9.9" })).statusCode).toBe(401);
    expect((await download(apk.id, { device: "app_device:other" })).statusCode).toBe(401);
    expect((await download(other.id)).statusCode).toBe(401);
    // A revoked device's channel ends, and its download with it.
    expect((await app.inject({ method: "POST", url: `/api/auth/devices/${deviceId}/revoke`, headers: person })).statusCode).toBe(200);
    await vi.waitFor(() => expect(phone.state.closed).toBeDefined());
    expect((await download(apk.id)).statusCode).toBe(401);
  });

  it("a wrong code fails at message 3, counts toward the lock and burns the offer", async () => {
    const qr = await offer();
    expect((await pair(qr, {}, b64.encode(new Uint8Array(16).fill(9)))).closed).toBe(4401);
    expect(await audit("mobile.pairing.failed")).toMatchObject({ metadata: { reason: "WRONG_CODE" } });
    expect((await pair(qr)).closed).toBe(4401);
    expect((await pair({ ...qr, o: b64.encode(new Uint8Array(8)) })).closed).toBe(4401);
  });

  it("a phone that leaves before message 3 leaves a failed row naming the stage it reached (9/11: ten stable offers left no trace)", async () => {
    const qr = await offer(), offerId = b64.decode(qr.o);
    const failed = async (reason: string) => (await store.listAuditEvents()).filter((event) => event.action === "mobile.pairing.failed" && event.metadata.reason === reason);
    const silent = await open(`/api/mobile/channel?m=pair&o=${qr.o}`);
    silent.ws.terminate();
    await vi.waitFor(async () => expect(await failed("NO_MESSAGE_1")).toHaveLength(1));
    const handshake = new MobileNoiseHandshake({ pattern: "XXpsk3", initiator: true, prologue: mobileHandshakePrologue("pair", offerId, null), s: noiseKeyPair(),
      psk: mobilePairingPsk(b64.decode(qr.c), b64.decode(qr.k), b64.decode(qr.i), offerId) });
    const halfway = await open(`/api/mobile/channel?m=pair&o=${qr.o}`);
    halfway.ws.send(handshake.writeMessage());
    expect(await halfway.message(0)).toBeDefined();
    halfway.ws.terminate();
    await vi.waitFor(async () => expect(await failed("NO_MESSAGE_3")).toHaveLength(1));
    expect((await app.inject({ method: "DELETE", url: `/api/mobile/pairing/${qr.o}`, headers: person })).statusCode).toBeLessThan(300);
  });

  it("gives no decide for a key whose attestation does not hold for this handshake", async () => {
    // Google's status list answers from here: nothing leaves the test.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ entries: {} })));
    const { paired } = await pair(await offer(), { decidePubSpki: attestation.decidePublicSpki, decideAttestation: attestation.chain });
    expect(fetch).toHaveBeenCalledWith("https://android.googleapis.com/attestation/status", expect.anything());
    vi.unstubAllGlobals();
    expect(paired).toMatchObject({ pending: ["read", "act"] });
    expect((await audit("mobile.pairing.completed", paired!.deviceId as string))!.metadata.decide).toMatch(/^refused /);
  });

  // CODE-2 (MASVS L2, plan clipboard:kTV3y2lwO-99 step 7): a Nous app below the floor neither pairs nor connects; the close says what to install.
  it("closes 4426 for a Nous app below the update floor, at pairing and at connect", async () => {
    const old = await pair(await offer(), { appVersion: "0.2.21" });
    expect(old).toMatchObject({ closed: 4426, paired: null });
    expect(JSON.parse(old.phone.state.reason!)).toEqual({ code: "APP_UPDATE_REQUIRED", minVersion: "0.2.22", minVersionCode: 222 });
    expect(await audit("mobile.pairing.failed")).toMatchObject({ metadata: { reason: "APP_UPDATE_REQUIRED" } });
    const qr = await offer();
    const { paired, phone: pairing, device } = await pair(qr, { appVersion: "0.2.22" });
    pairing.ws.terminate();
    const deviceId = paired!.deviceId as string;
    expect((await connect(qr, device, { deviceId, appVersion: "0.2.21" })).closed).toBe(4426);
    const current = await connect(qr, device, { deviceId, appVersion: "0.2.22" });
    expect(current.welcome).toMatchObject({ scopes: ["read"] });
    current.phone.ws.terminate();
  });

  // RESILIENCE (MASVS L2 step 7): with Play Integrity configured, decide also needs Google's verdict for this pairing's handshake hash.
  it("grants decide at pairing only with a Play Integrity verdict bound to this handshake", async () => {
    const verdict = (requestHash: string, device: string) => ({ tokenPayloadExternal: {
      requestDetails: { requestPackageName: "com.oll4.spaceapp.nous", requestHash, timestampMillis: String(Date.now()) },
      appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.oll4.spaceapp.nous",
        certificateSha256Digest: [Buffer.from(MOBILE_APP_SIGNERS["com.oll4.spaceapp.nous"]!, "hex").toString("base64url")] },
      deviceIntegrity: { deviceRecognitionVerdict: [device] } } });
    const decoded: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "at", expires_in: 3600 });
      if (!url.endsWith(":decodeIntegrityToken")) return Response.json({ entries: {} });
      const token = JSON.parse(String(init?.body)).integrityToken as string;
      decoded.push(token);
      const challenge = vi.mocked(verifyDecideKeyAttestation).mock.calls.at(-1)![0].challenge;
      return Response.json(verdict(mobileIntegrityRequestHash("pair", challenge), token.startsWith("good") ? "MEETS_DEVICE_INTEGRITY" : "MEETS_BASIC_INTEGRITY"));
    }));
    const passing = { ok: true, securityLevel: "TRUSTED_ENVIRONMENT", packageName: "com.oll4.spaceapp.nous" } as const;
    const decideKey = { decidePubSpki: attestation.decidePublicSpki, decideAttestation: attestation.chain };
    try {
      vi.mocked(verifyDecideKeyAttestation).mockReturnValueOnce(passing);
      const good = await pair(await offer(), { ...decideKey, integrityToken: "good.a.b.c.d" });
      expect(good.paired).toMatchObject({ pending: ["read", "act", "decide"] });
      expect(await audit("mobile.pairing.completed", good.paired!.deviceId as string)).toMatchObject({ metadata: { decide: "TRUSTED_ENVIRONMENT", integrity: "ok" } });
      good.phone.ws.terminate();
      vi.mocked(verifyDecideKeyAttestation).mockReturnValueOnce(passing);
      const basic = await pair(await offer(), { ...decideKey, integrityToken: "rooted.a.b.c.d" });
      expect(basic.paired).toMatchObject({ pending: ["read", "act"] });
      expect(await audit("mobile.pairing.completed", basic.paired!.deviceId as string)).toMatchObject({ metadata: { integrity: "refused DEVICE" } });
      basic.phone.ws.terminate();
      vi.mocked(verifyDecideKeyAttestation).mockReturnValueOnce(passing);
      const none = await pair(await offer(), decideKey);
      expect(none.paired).toMatchObject({ pending: ["read", "act"] });
      expect(await audit("mobile.pairing.completed", none.paired!.deviceId as string)).toMatchObject({ metadata: { integrity: "refused NO_TOKEN" } });
      none.phone.ws.terminate();
      expect(decoded).toEqual(["good.a.b.c.d", "rooted.a.b.c.d"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("revokes a held phone its owner did not allow within 10 minutes and closes its open channel", async () => {
    const { paired, phone } = await pair(await offer());
    const later = Date.now() + 11 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      expect((await app.inject({ method: "POST", url: `/api/auth/devices/${paired!.deviceId}/allow`, headers: person })).json())
        .toMatchObject({ error: { code: "MOBILE_PAIRING_EXPIRED" } });
    } finally { vi.restoreAllMocks(); }
    await vi.waitFor(() => expect(phone.state.closed).toBe(4403));
    expect(await audit("mobile.pairing.expired", paired!.deviceId as string)).toBeDefined();
    expect((await cards()).map((card) => card.payload.deviceId)).not.toContain(paired!.deviceId);
  });

  // Plan step 9 (demo-instance-plan §4): SPACE_MOBILE_DEMO on a public install serves one public offer a day; every phone pairs read only (step 18)
  // at once, raises no card, and past MOBILE_DEMO_DEVICES_MAX live phones the oldest is revoked.
  it("demo mode: the day's public offer pairs every phone read only, without a card, and revokes the oldest past the cap", async () => {
    expect((await app.inject({ method: "GET", url: "/api/mobile/demo-offer" })).statusCode).toBe(404);
    const owned = new InMemorySpaceStore();
    owned.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" });
    const owner = owned.claimOwnerSetup({ tokenHash: "a".repeat(64), email: "owner@example.test", passwordHash: await hashPassword("demo owner words"), now: new Date().toISOString() }).user;
    const demo = await createApp({ store: owned, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: join(dir, "connector.key"),
      SPACE_MOBILE_DEMO: "1", SPACE_PUBLIC_DISTRIBUTION: "true" }), auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
    const shared = app;
    app = demo;
    try {
      const web = as(signSession(owner, secret));
      expect((await demo.inject({ method: "GET", url: "/api/mobile/demo-offer" })).json()).toMatchObject({ error: { code: "MOBILE_NOT_SET_UP" } });
      expect((await demo.inject({ method: "POST", url: "/api/auth/step-up/password", headers: web, payload: { password: "demo owner words" } })).statusCode).toBe(200);
      expect((await demo.inject({ method: "POST", url: "/api/mobile/instance", headers: web, payload: {} })).json()).toMatchObject({ configured: true });
      const answer = (await demo.inject({ method: "GET", url: "/api/mobile/demo-offer" })).json();
      expect(answer).toMatchObject({ scopes: ["read"], fingerprint: expect.any(String) });
      expect((await demo.inject({ method: "GET", url: "/api/mobile/demo-offer" })).json().qr).toBe(answer.qr);
      const qr = decodeMobilePairQr(answer.qr, Math.floor(Date.now() / 1000));
      const first = await pair(qr), second = await pair(qr);
      for (const one of [first, second]) expect(one.paired).toMatchObject({ op: "paired", scopes: ["read"], pending: [], rid: null });
      expect(await second.phone.request("POST", "/api/notifications/read-all", {})).toMatchObject({ status: 403 });
      second.phone.ws.terminate();
      const firstId = first.paired!.deviceId as string, secondId = second.paired!.deviceId as string;
      expect((await demo.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers: web })).json().notifications
        .filter((card: { kind: string }) => card.kind === "MOBILE_PAIRED")).toEqual([]);
      expect((await owned.listAuditEvents()).find((event) => event.action === "mobile.pairing.completed" && event.targetId === firstId)?.metadata).toMatchObject({ demo: true });
      // The cap without 500 pairings: the live list is padded to the cap, so the next phone revokes the oldest, whose channel closes.
      const live = InMemoryAppDeviceSessionRepository.prototype.livePaired;
      const padded = vi.spyOn(InMemoryAppDeviceSessionRepository.prototype, "livePaired").mockImplementation(async function (this: InMemoryAppDeviceSessionRepository, ...args) {
        const rows = await live.apply(this, args);
        return [...rows, ...Array.from({ length: MOBILE_DEMO_DEVICES_MAX - rows.length }, () => rows.at(-1)!)];
      });
      let third: Awaited<ReturnType<typeof pair>>;
      try { third = await pair(qr); } finally { padded.mockRestore(); }
      expect(third.paired).toMatchObject({ scopes: ["read"] });
      third.phone.ws.terminate();
      await vi.waitFor(() => expect(first.phone.state.closed).toBe(4403));
      expect((await connect(qr, first.device, { deviceId: firstId })).closed).toBe(4403);
      const still = await connect(qr, second.device, { deviceId: secondId });
      expect(still.welcome).toMatchObject({ scopes: ["read"] });
      still.phone.ws.terminate();
    } finally {
      app = shared;
      await demo.close();
    }
  });

  // C3 (internal MASVS review 1/11, review P2-4): exposed instance keys revoke the owner's paired phones and end their live sessions, audited.
  it("a compromised rotation revokes every paired phone of the owner and closes its live channel", async () => {
    const qr = await offer();
    const { paired, phone: pairing, device } = await pair(qr);
    pairing.ws.terminate();
    const deviceId = paired!.deviceId as string;
    const idle = await connect(qr, device, { deviceId });
    expect(idle.welcome).toMatchObject({ scopes: ["read"] });
    expect((await app.inject({ method: "POST", url: "/api/mobile/rotate", headers: person, payload: { compromised: true } })).statusCode).toBe(200);
    await vi.waitFor(() => expect(idle.phone.state.closed).toBe(4403));
    const devices = (await app.inject({ method: "GET", url: "/api/auth/devices", headers: person })).json().devices as Array<{ id: string; paired?: unknown; revokedAt: string | null }>;
    expect(devices.filter((row) => row.paired && !row.revokedAt)).toEqual([]);
    expect(await cards()).toEqual([]);
    expect((await audit("mobile.instance.rotated"))!.metadata).toMatchObject({ compromised: true, revokedDevices: expect.arrayContaining([deviceId]) });
  });
}, 300_000);
