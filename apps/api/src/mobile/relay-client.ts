import { WebSocket, type RawData } from "ws";
import { mobileRelayAcceptSig, mobileRelayListenSig, vaultBase64url } from "@space/contracts";

// The instance's side of the SpaceApp relay (plan clipboard:kTV3y2lwO-99 phase 2b, design §5): for a SpaceApp behind NAT, one outbound
// control socket per answering identity key to <relay>/v1/listen, signed with that key, naming the rendezvous ids phones may come through.
// On {t:"incoming", sid, rid} it opens <relay>/v1/accept/<sid> and hands that socket to the channel, which runs the same Noise session as
// the direct route on top: the relay only ever splices ciphertext. No new API port, no licence (only the phone carries one), no socket
// at all while no RELAY offer or relay-paired device exists.

/** The relay's own cap on one listen; past it the oldest ids wait. shortcut: one socket per key, split into several listens past 256 ids. */
export const MOBILE_RELAY_RIDS_MAX = 256;
const SYNC_MS = 60_000, BACKOFF_MIN_MS = 1000, BACKOFF_MAX_MS = 60_000, FRAME_MAX = 65_535;

type Identity = { publicKey: Uint8Array; privateKey: Uint8Array };
type Listener = { socket: WebSocket | null; listed: string; failures: number; retry: NodeJS.Timeout | null };

export function startMobileRelay(options: {
  /** The relay's ws(s) origin (SPACE_MOBILE_RELAY_URL). */
  url: string;
  /** The answering identity keys (ACTIVE and RETIRING): a phone that still pins a retiring key reaches it through that key's listener. */
  identities: () => Promise<Identity[]>;
  /** The rendezvous ids, base64url. */
  rids: () => Promise<string[]>;
  /** A spliced socket from a phone on `rid`. */
  accept: (socket: WebSocket, rid: Uint8Array) => void;
  log?: { warn(meta: Record<string, unknown>, message: string): void };
}) {
  const base = options.url.replace(/\/+$/, "");
  const listeners = new Map<string, Listener>();
  let closed = false, syncing: Promise<void> | null = null, again = false;

  function drop(id: string) {
    const listener = listeners.get(id);
    listeners.delete(id);
    if (listener?.retry) clearTimeout(listener.retry);
    listener?.socket?.close(1000);
  }

  function listen(id: string, identity: Identity, rids: string[], listener: Listener) {
    const socket = new WebSocket(`${base}/v1/listen`, { maxPayload: FRAME_MAX, handshakeTimeout: 10_000 });
    const old = listener.socket;
    listener.socket = socket;
    listener.listed = rids.join(",");
    // The relay replaces a listener by identity; closing ours first keeps the old socket's close from counting as a failure.
    old?.close(1000);
    socket.on("message", (data: RawData, isBinary: boolean) => {
      let message: { t?: unknown; nonce?: unknown; sid?: unknown; rid?: unknown };
      try { message = isBinary ? {} : JSON.parse(data.toString()) as typeof message; } catch { message = {}; }
      if (message.t === "challenge" && typeof message.nonce === "string") {
        socket.send(JSON.stringify({ t: "listen", identity: id, rids, sig: mobileRelayListenSig(identity.privateKey, vaultBase64url.decode(message.nonce), rids) }));
      } else if (message.t === "listening") listener.failures = 0;
      else if (message.t === "incoming" && typeof message.sid === "string" && /^[A-Za-z0-9_-]{22}$/.test(message.sid)
        && typeof message.rid === "string" && rids.includes(message.rid)) {
        const rid = vaultBase64url.decode(message.rid);
        const spliced = new WebSocket(`${base}/v1/accept/${message.sid}?sig=${mobileRelayAcceptSig(identity.privateKey, message.sid)}`,
          { maxPayload: FRAME_MAX, handshakeTimeout: 10_000 });
        spliced.on("error", () => undefined);
        spliced.once("open", () => options.accept(spliced, rid));
      }
    });
    socket.on("error", (error) => options.log?.warn({ err: error }, "Mobile relay listener failed."));
    socket.on("close", () => {
      // A replaced or dropped socket is no failure: only the current one retries.
      if (closed || listener.socket !== socket || listeners.get(id) !== listener) return;
      listener.socket = null;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** listener.failures) * (0.5 + Math.random() / 2);
      listener.failures += 1;
      listener.retry = setTimeout(() => { listener.retry = null; refresh(); }, delay);
      listener.retry.unref();
    });
  }

  async function sync() {
    // The cap keeps the caller's order (live rids before ended ones); the sort is only the signature's order.
    const rids = [...new Set(await options.rids())].slice(0, MOBILE_RELAY_RIDS_MAX).sort();
    const identities = rids.length ? await options.identities() : [];
    if (closed) return;
    const wanted = new Map(identities.map((identity) => [vaultBase64url.encode(identity.publicKey), identity]));
    for (const id of listeners.keys()) if (!wanted.has(id)) drop(id);
    for (const [id, identity] of wanted) {
      const listener = listeners.get(id) ?? { socket: null, listed: "", failures: 0, retry: null };
      listeners.set(id, listener);
      // Up with these ids, or waiting out its backoff (the retry syncs again).
      if (listener.retry || (listener.socket && listener.listed === rids.join(","))) continue;
      listen(id, identity, rids, listener);
    }
  }

  /** Recomputes the ids and listens again when they changed; calls during a sync run once more after it. */
  function refresh() {
    if (closed) return;
    if (syncing) { again = true; return; }
    syncing = sync().catch((error: unknown) => options.log?.warn({ err: error }, "Mobile relay sync failed.")).finally(() => {
      syncing = null;
      if (again) { again = false; refresh(); }
    });
  }

  refresh();
  // Expired offers leave the list here (a stale id until then only meets a closed offer); ended devices stay until their row is pruned.
  const timer = setInterval(refresh, SYNC_MS);
  timer.unref();
  return {
    refresh,
    close() {
      closed = true;
      clearInterval(timer);
      for (const id of [...listeners.keys()]) drop(id);
    }
  };
}
