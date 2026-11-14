import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import {
  LINK_APP, MOBILE_FRAME_MAX_PLAINTEXT, MOBILE_UPDATE_REQUIRED_CLOSE, MobileNoiseHandshake, decodeMobileFrame, decodeMobilePairQr, encodeMobileFrame, mobileFrames, mobileHandshakePrologue,
  mobilePairedSchema, mobilePairingPsk, mobileRotationStatementSchema, mobileWelcomeSchema, noiseKeyPair, vaultBase64url as b64, verifyMobileRotation,
  type MobileFrame, type MobileNoiseTransport
} from "@space/contracts";

// Space Link (ADR-014): this SpaceApp's side of another SpaceApp's mobile channel (apps/api/src/mobile/channel.ts there), as the Nous
// app's phone does it: XXpsk3 from a pairing code once, then IK on the pinned instance key, then requests into that SpaceApp's API.

/** The other side ends an unfinished handshake after 30 s (mobile/channel.ts HANDSHAKE_MS). */
const HANDSHAKE_MS = 30_000;
/** It pings every 30 s; 120 s without a frame from it means it is gone (its PING_MS, SILENCE_MS). */
const PING_MS = 30_000, SILENCE_MS = 120_000;
/** Its channel refuses an answer over 64 MiB (mobile/channel.ts RESPONSE_MAX_BYTES), so a longer one is a hostile side: it fails here. */
const ANSWER_MAX_BYTES = 64 * 1024 * 1024;
/** A Noise message is at most 65,535 bytes (the frame and its 16-byte tag), so ws never buffers a bigger one. */
const MESSAGE_MAX_BYTES = MOBILE_FRAME_MAX_PLAINTEXT + 16;
const CLOSES: Record<number, string> = {
  4400: "it refused a message", 4401: "the pairing code is unknown or used; make a new one there", 4403: "it refused this link (removed there, expired, or not this key)",
  4408: "the time ran out, or the two clocks differ by over 5 minutes", 4409: "it saw this connect before", 4410: "the session reached its 24 hours"
};
const utf8 = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export class InstanceLinkError extends Error {}

/** The keys and address a link keeps (instance_links), the private key opened. */
export interface LinkKeys { origins: readonly string[]; noisePublic: string; identityPublic: string; deviceId: string; devicePrivate: Uint8Array }

/**
 * One WebSocket to the other SpaceApp at the first of its addresses that answers: its binary messages in order, until it closes.
 * `headers`: a Cloudflare Access service token in front of its channel (CF-Access-Client-Id/Secret); Noise still authenticates on top.
 */
async function dial(origins: readonly string[], path: string, headers: Record<string, string>) {
  let failure: unknown = new Error("no address");
  for (const origin of origins) {
    const ws = new WebSocket(`${origin.replace(/^http/, "ws")}${path}`, { headers, handshakeTimeout: HANDSHAKE_MS, maxPayload: MESSAGE_MAX_BYTES });
    const inbox: Uint8Array[] = [];
    let wake = () => {}, closed: number | null = null;
    ws.on("message", (data: Buffer, binary: boolean) => { if (binary) inbox.push(new Uint8Array(data)); wake(); });
    ws.on("close", (code: number) => { closed = code; wake(); });
    try { await once(ws, "open"); } catch (error) { failure = error; ws.terminate(); continue; }
    ws.on("error", () => undefined); // its close follows
    return {
      ws,
      closed: () => closed,
      /** The next message; within `ms` when given, else until the socket closes. */
      async next(ms?: number): Promise<Uint8Array> {
        const until = ms === undefined ? Infinity : Date.now() + ms;
        while (!inbox.length) {
          if (closed !== null) throw new InstanceLinkError(`That SpaceApp closed the link: ${closed === MOBILE_UPDATE_REQUIRED_CLOSE ? "it needs a newer SpaceApp here" : CLOSES[closed] ?? `code ${closed}`}.`);
          if (Date.now() >= until) { ws.terminate(); throw new InstanceLinkError("That SpaceApp did not answer in time."); }
          await new Promise<void>((resolve) => { wake = resolve; if (until !== Infinity) setTimeout(resolve, until - Date.now()).unref(); });
        }
        return inbox.shift()!;
      }
    };
  }
  throw new InstanceLinkError(`No address of that SpaceApp answered (${origins.join(", ")}): ${failure instanceof Error ? failure.message : String(failure)}.`);
}

/**
 * Pairs with the SpaceApp whose `SPACEAPP-PAIR:` code its person made (Settings > Mobile app there): XXpsk3 with the code, then this
 * SpaceApp asks for read and act as a server of app spaceapp-link. The other side holds it at read until its person allows it.
 */
export async function pairInstanceLink(code: string, deviceName: string, appVersion: string, headers: Record<string, string> = {}) {
  const qr = decodeMobilePairQr(code.trim(), Math.floor(Date.now() / 1000));
  // shortcut: direct addresses only; a relay-only code needs the SpaceApp relay's Pro licence here too. Add the relay when a managed SpaceApp has no reachable address.
  if (!qr.u.length) throw new InstanceLinkError("This code reaches its SpaceApp through the relay only; make a Direct code there.");
  const offerId = b64.decode(qr.o), device = noiseKeyPair();
  const handshake = new MobileNoiseHandshake({ pattern: "XXpsk3", initiator: true, prologue: mobileHandshakePrologue("pair", offerId, null), s: device,
    psk: mobilePairingPsk(b64.decode(qr.c), b64.decode(qr.k), b64.decode(qr.i), offerId) });
  const socket = await dial(qr.u, `/api/mobile/channel?m=pair&o=${qr.o}`, headers);
  try {
    socket.ws.send(handshake.writeMessage());
    const said = JSON.parse(text(handshake.readMessage(await socket.next(HANDSHAKE_MS)))) as { i?: unknown };
    if (said.i !== qr.i || b64.encode(handshake.remoteStatic!) !== qr.k) throw new InstanceLinkError("That SpaceApp answered with other keys than its code; nothing was paired.");
    socket.ws.send(handshake.writeMessage(utf8(JSON.stringify({ deviceName, app: LINK_APP, appVersion, platform: "server", wantScopes: ["read", "act"] }))));
    const transport = handshake.split();
    const frame = decodeMobileFrame(transport.decrypt(await socket.next(HANDSHAKE_MS)));
    const { op, ...header } = frame.header;
    if (frame.type !== "ctl" || op !== "paired") throw new InstanceLinkError("That SpaceApp did not confirm the pairing.");
    const paired = mobilePairedSchema.parse(header);
    socket.ws.send(transport.encrypt(encodeMobileFrame({ type: "ctl", header: { op: "bye" }, body: new Uint8Array(0) })));
    return { label: qr.n, origins: qr.u, noisePublic: qr.k, identityPublic: qr.i, deviceId: paired.deviceId, scopes: paired.scopes, pending: paired.pending ?? [],
      devicePrivate: device.privateKey };
  } finally { socket.ws.close(1000); }
}

/** An open link: requests into the other SpaceApp's API as this link's device, answered by status and parsed JSON (text otherwise). */
export interface InstanceLinkSession {
  scopes: string[];
  /** The other side's new keys when it answered with a routine rotation signed by the identity key this link pinned. */
  rotated: { noisePublic: string; identityPublic: string } | null;
  closed(): boolean;
  request(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown, requestId?: string): Promise<{ status: number; body: unknown }>;
  close(): void;
}

/** Connects with Noise IK on the pinned instance key, with a fresh hello the other side checks for time and replay. */
export async function connectInstanceLink(keys: LinkKeys, appVersion: string, headers: Record<string, string> = {}): Promise<InstanceLinkSession> {
  const handshake = new MobileNoiseHandshake({ pattern: "IK", initiator: true, prologue: mobileHandshakePrologue("ik", null, null), s: noiseKeyPair(keys.devicePrivate),
    rs: b64.decode(keys.noisePublic) });
  const socket = await dial(keys.origins, "/api/mobile/channel?m=ik", headers);
  let transport: MobileNoiseTransport, welcome;
  try {
    socket.ws.send(handshake.writeMessage(utf8(JSON.stringify({ deviceId: keys.deviceId, appVersion, ts: Date.now(), nonce: b64.encode(randomBytes(16)) }))));
    welcome = mobileWelcomeSchema.parse(JSON.parse(text(handshake.readMessage(await socket.next(HANDSHAKE_MS)))));
    transport = handshake.split();
  } catch (error) { socket.ws.terminate(); throw error; }
  let rotated: InstanceLinkSession["rotated"] = null;
  if (welcome.rotation) {
    const { statement, signature } = JSON.parse(welcome.rotation) as { statement: unknown; signature: string };
    const parsed = mobileRotationStatementSchema.safeParse(statement);
    if (parsed.success && verifyMobileRotation(parsed.data, signature, b64.decode(keys.identityPublic))) rotated = { noisePublic: parsed.data.newIS, identityPublic: parsed.data.newII };
  }
  const session = { scopes: welcome.scopes as string[], rotated };
  const send = (frame: MobileFrame) => { if (socket.ws.readyState === WebSocket.OPEN) socket.ws.send(transport.encrypt(encodeMobileFrame(frame))); };
  const waiting = new Map<number, { status: number; parts: Uint8Array[]; size: number; resolve: (answer: { status: number; body: unknown }) => void; reject: (error: Error) => void }>();
  let nextId = 1, heard = Date.now();
  const silence = setInterval(() => { if (Date.now() - heard > SILENCE_MS) socket.ws.terminate(); }, PING_MS);
  silence.unref();
  const finish = (id: number) => {
    const entry = waiting.get(id)!;
    waiting.delete(id);
    const raw = text(Buffer.concat(entry.parts));
    let body: unknown = raw || null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON: the text */ }
    entry.resolve({ status: entry.status, body });
  };
  void (async () => {
    try {
      for (;;) {
        const frame = decodeMobileFrame(transport.decrypt(await socket.next()));
        heard = Date.now();
        const id = Number(frame.header.id);
        if (frame.type === "ctl") {
          const op = frame.header.op;
          if (op === "ping") send({ type: "ctl", header: { op: "pong" }, body: new Uint8Array(0) });
          else if (op === "rekey") transport.rekeyReceive();
          else if (op === "scopes" && Array.isArray(frame.header.scopes)) session.scopes = frame.header.scopes.map(String);
          else if (op === "busy" && waiting.has(id)) { waiting.get(id)!.reject(new InstanceLinkError("That SpaceApp is busy; try again in a moment.")); waiting.delete(id); }
          else if (op === "bye") socket.ws.close(1000);
        } else if ((frame.type === "res" || frame.type === "chunk") && waiting.has(id)) {
          const entry = waiting.get(id)!;
          if (frame.type === "res") entry.status = Number(frame.header.s);
          entry.parts.push(frame.body);
          entry.size += frame.body.length;
          if (entry.size > ANSWER_MAX_BYTES) { waiting.delete(id); entry.reject(new InstanceLinkError("That SpaceApp's answer is over 64 MiB.")); }
          else if (!frame.header.more) finish(id);
        }
      }
    } catch (error) {
      clearInterval(silence);
      socket.ws.terminate();
      for (const entry of waiting.values()) entry.reject(error instanceof InstanceLinkError ? error : new InstanceLinkError("The link to that SpaceApp broke."));
      waiting.clear();
    }
  })();
  return {
    get scopes() { return session.scopes; },
    rotated,
    closed: () => socket.closed() !== null,
    request(method, path, body, requestId) {
      if (socket.closed() !== null) return Promise.reject(new InstanceLinkError("The link to that SpaceApp is closed."));
      const id = nextId++;
      const answer = new Promise<{ status: number; body: unknown }>((resolve, reject) => waiting.set(id, { status: 0, parts: [], size: 0, resolve, reject }));
      // Its pings keep a hung request's socket alive: an answer not complete within the silence window fails, so no Nous turn or background read waits forever.
      setTimeout(() => { const entry = waiting.get(id); if (entry) { waiting.delete(id); entry.reject(new InstanceLinkError("That SpaceApp did not answer in time.")); } }, SILENCE_MS).unref();
      const h = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(requestId ? { "x-space-link-request": requestId } : {}) };
      const header = { id, m: method, p: path, ...(Object.keys(h).length ? { h } : {}) };
      for (const frame of mobileFrames("req", header, body === undefined ? new Uint8Array(0) : utf8(JSON.stringify(body)))) send(frame);
      return answer;
    },
    close() { send({ type: "ctl", header: { op: "bye" }, body: new Uint8Array(0) }); socket.ws.close(1000); }
  };
}
