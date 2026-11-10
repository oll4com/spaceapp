import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2s } from "@noble/hashes/blake2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";

// Mobile channel crypto (plan clipboard:kTV3y2lwO-99 phase 1b, ADR-013): Noise rev 34 with 25519, ChaChaPoly and BLAKE2s, for the two
// patterns the mobile channel uses: XXpsk3 to pair, IK to connect. One copy runs in the API and, vendored, in the app (as vault-crypto.ts
// does), and both pass the Cacophony vectors. Pure: no I/O, no clock; randomness only through noiseKeyPair() without a key.

export type MobileNoisePattern = "XXpsk3" | "IK";
export interface NoiseKeyPair { privateKey: Uint8Array; publicKey: Uint8Array }

export class MobileNoiseError extends Error {
  constructor(readonly code: "DECRYPT" | "BAD_MESSAGE" | "STATE" | "NONCE") { super(`Noise: ${code}`); }
}

const DHLEN = 32;
const TAGLEN = 16;
const MAX_NONCE = 2n ** 64n - 1n;
/** Both sides REKEY() a direction after this many messages, so no signal is needed (design §3.2). */
export const MOBILE_NOISE_REKEY_EVERY = 10_000;

const PATTERNS: Record<MobileNoisePattern, { pre: { responder: boolean }; messages: string[][]; psk: boolean }> = {
  XXpsk3: { pre: { responder: false }, messages: [["e"], ["e", "ee", "s", "es"], ["s", "se", "psk"]], psk: true },
  IK: { pre: { responder: true }, messages: [["e", "es", "s", "ss"], ["e", "ee", "se"]], psk: false },
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
const empty = new Uint8Array(0);
const hmacHash = (key: Uint8Array, data: Uint8Array) => hmac(blake2s, key, data);
function noiseHkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const temp = hmacHash(chainingKey, ikm);
  const out1 = hmacHash(temp, Uint8Array.of(1));
  const out2 = hmacHash(temp, concat(out1, Uint8Array.of(2)));
  return outputs === 2 ? [out1, out2] : [out1, out2, hmacHash(temp, concat(out2, Uint8Array.of(3)))];
}

export function noiseKeyPair(privateKey: Uint8Array = x25519.utils.randomSecretKey()): NoiseKeyPair {
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

export class NoiseCipherState {
  private key: Uint8Array | null = null;
  private counter = 0n;
  constructor(key?: Uint8Array) { if (key) this.key = key; }
  hasKey(): boolean { return this.key !== null; }
  /** The next nonce; transport messages use it implicitly, so a replayed, dropped or reordered frame fails to decrypt. */
  get nonce(): bigint { return this.counter; }
  private nonce12(n: bigint): Uint8Array {
    const out = new Uint8Array(12);
    new DataView(out.buffer).setBigUint64(4, n, true);
    return out;
  }
  private next(): bigint {
    if (this.counter >= MAX_NONCE) throw new MobileNoiseError("NONCE");
    return this.counter++;
  }
  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext;
    return chacha20poly1305(this.key, this.nonce12(this.next()), ad).encrypt(plaintext);
  }
  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext;
    // The nonce advances only after a good tag (Noise §5.1).
    let plaintext: Uint8Array;
    try { plaintext = chacha20poly1305(this.key, this.nonce12(this.counter), ad).decrypt(ciphertext); }
    catch { throw new MobileNoiseError("DECRYPT"); }
    this.next();
    return plaintext;
  }
  rekey(): void {
    if (!this.key) throw new MobileNoiseError("STATE");
    this.key = chacha20poly1305(this.key, this.nonce12(MAX_NONCE), empty).encrypt(new Uint8Array(32)).slice(0, 32);
  }
}

/** A Noise handshake for one of the mobile channel's two patterns (Noise §5.2 and §5.3). */
export class MobileNoiseHandshake {
  private ck: Uint8Array;
  private h: Uint8Array;
  private cipher = new NoiseCipherState();
  private step = 0;
  private readonly tokens: string[][];
  private readonly usesPsk: boolean;
  private e: NoiseKeyPair | null;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null;

  constructor(private readonly options: {
    pattern: MobileNoisePattern; initiator: boolean; prologue: Uint8Array; s: NoiseKeyPair;
    /** IK's initiator knows the responder's static key; the app pins it from the QR. */
    rs?: Uint8Array; psk?: Uint8Array;
    /** Tests only: a fixed ephemeral key (the vectors'). */
    e?: NoiseKeyPair;
  }) {
    const pattern = PATTERNS[options.pattern];
    if (pattern.psk && options.psk?.length !== 32) throw new MobileNoiseError("STATE");
    if (pattern.pre.responder && options.initiator && options.rs?.length !== DHLEN) throw new MobileNoiseError("STATE");
    const name = new TextEncoder().encode(`Noise_${options.pattern}_25519_ChaChaPoly_BLAKE2s`);
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : blake2s(name);
    this.ck = this.h;
    this.tokens = pattern.messages;
    this.usesPsk = pattern.psk;
    this.e = options.e ?? null;
    this.rs = options.rs ?? null;
    this.mixHash(options.prologue);
    if (pattern.pre.responder) this.mixHash(options.initiator ? this.rs! : options.s.publicKey);
  }

  get complete(): boolean { return this.step >= this.tokens.length; }
  /** Whose turn it is: true when this side writes the next message. */
  get writes(): boolean { return (this.step % 2 === 0) === this.options.initiator; }
  get handshakeHash(): Uint8Array { return this.h; }
  get remoteStatic(): Uint8Array | null { return this.rs; }

  private mixHash(data: Uint8Array) { this.h = blake2s(concat(this.h, data)); }
  private mixKey(ikm: Uint8Array) {
    const [ck, key] = noiseHkdf(this.ck, ikm, 2);
    this.ck = ck!; this.cipher = new NoiseCipherState(key!);
  }
  private mixKeyAndHash(ikm: Uint8Array) {
    const [ck, temp, key] = noiseHkdf(this.ck, ikm, 3);
    this.ck = ck!; this.mixHash(temp!); this.cipher = new NoiseCipherState(key!);
  }
  private encryptAndHash(plaintext: Uint8Array) { const out = this.cipher.encrypt(this.h, plaintext); this.mixHash(out); return out; }
  private decryptAndHash(ciphertext: Uint8Array) { const out = this.cipher.decrypt(this.h, ciphertext); this.mixHash(ciphertext); return out; }
  private dh(token: string) {
    const { initiator, s } = this.options;
    const pick = (local: "e" | "s", remote: "e" | "s") => {
      const mine = local === "e" ? this.e : s;
      const theirs = remote === "e" ? this.re : this.rs;
      if (!mine || !theirs) throw new MobileNoiseError("STATE");
      return x25519.getSharedSecret(mine.privateKey, theirs);
    };
    if (token === "ee") return pick("e", "e");
    if (token === "ss") return pick("s", "s");
    if (token === "es") return initiator ? pick("e", "s") : pick("s", "e");
    return initiator ? pick("s", "e") : pick("e", "s"); // se
  }

  writeMessage(payload: Uint8Array = empty): Uint8Array {
    if (this.complete || !this.writes) throw new MobileNoiseError("STATE");
    const parts: Uint8Array[] = [];
    for (const token of this.tokens[this.step]!) {
      if (token === "e") {
        this.e ??= noiseKeyPair();
        parts.push(this.e.publicKey); this.mixHash(this.e.publicKey);
        if (this.usesPsk) this.mixKey(this.e.publicKey);
      } else if (token === "s") parts.push(this.encryptAndHash(this.options.s.publicKey));
      else if (token === "psk") this.mixKeyAndHash(this.options.psk!);
      else this.mixKey(this.dh(token));
    }
    parts.push(this.encryptAndHash(payload));
    this.step++;
    return concat(...parts);
  }

  readMessage(message: Uint8Array): Uint8Array {
    if (this.complete || this.writes) throw new MobileNoiseError("STATE");
    let at = 0;
    const take = (length: number) => {
      if (at + length > message.length) throw new MobileNoiseError("BAD_MESSAGE");
      return message.slice(at, at += length);
    };
    for (const token of this.tokens[this.step]!) {
      if (token === "e") {
        this.re = take(DHLEN); this.mixHash(this.re);
        if (this.usesPsk) this.mixKey(this.re);
      } else if (token === "s") this.rs = this.decryptAndHash(take(this.cipher.hasKey() ? DHLEN + TAGLEN : DHLEN));
      else if (token === "psk") this.mixKeyAndHash(this.options.psk!);
      else this.mixKey(this.dh(token));
    }
    const payload = this.decryptAndHash(message.slice(at));
    this.step++;
    return payload;
  }

  /** After the last message: the transport pair, sending and receiving (the initiator sends with the first key). */
  split(): MobileNoiseTransport {
    if (!this.complete) throw new MobileNoiseError("STATE");
    const [first, second] = noiseHkdf(this.ck, empty, 2);
    const [send, receive] = this.options.initiator ? [first!, second!] : [second!, first!];
    return new MobileNoiseTransport(new NoiseCipherState(send), new NoiseCipherState(receive));
  }
}

/** Transport messages, with the count-based rekey both sides apply on their own (design §3.2); the 1-hour rekey is a channel frame. */
export class MobileNoiseTransport {
  private sent = 0;
  private received = 0;
  constructor(private readonly sendState: NoiseCipherState, private readonly receiveState: NoiseCipherState) {}
  encrypt(plaintext: Uint8Array): Uint8Array {
    const out = this.sendState.encrypt(empty, plaintext);
    if (++this.sent % MOBILE_NOISE_REKEY_EVERY === 0) this.sendState.rekey();
    return out;
  }
  decrypt(ciphertext: Uint8Array): Uint8Array {
    const out = this.receiveState.decrypt(empty, ciphertext);
    if (++this.received % MOBILE_NOISE_REKEY_EVERY === 0) this.receiveState.rekey();
    return out;
  }
  /** The channel's time-based rekey: the sender after its {t:"rekey"} frame, the receiver right after reading it. */
  rekeySend(): void { this.sendState.rekey(); }
  rekeyReceive(): void { this.receiveState.rekey(); }
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/** XXpsk3's psk from the QR's 16-byte code, or from the 8 words joined by single spaces (design §2.2). */
export function mobilePairingPsk(code: Uint8Array | string, instanceNoisePublic: Uint8Array, instanceIdentityPublic: Uint8Array, offerId: Uint8Array): Uint8Array {
  return hkdf(blake2s, typeof code === "string" ? utf8(code) : code, utf8("spaceapp-pair-psk-v1"), concat(instanceNoisePublic, instanceIdentityPublic, offerId), 32);
}

/** Words mode's offer id: the app has only the words (design §2.1, review P3-1). */
export function mobileWordsOfferId(words: string): Uint8Array {
  return blake2s(concat(utf8("spaceapp-words-offer-v1"), utf8(words))).slice(0, 8);
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** The instance fingerprint the Settings page and the app show: 24 base32 characters in 6 groups of 4. */
export function mobileInstanceFingerprint(instanceNoisePublic: Uint8Array, instanceIdentityPublic: Uint8Array): string {
  const digest = blake2s(concat(utf8("spaceapp-fp-v1"), instanceNoisePublic, instanceIdentityPublic)).slice(0, 15);
  let bits = 0, value = 0, out = "";
  for (const byte of digest) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  return out.match(/.{4}/g)!.join("-");
}
