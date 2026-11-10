import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { describe, expect, it } from "vitest";
import {
  MOBILE_NOISE_REKEY_EVERY, MobileNoiseError, MobileNoiseHandshake, NoiseCipherState, mobileInstanceFingerprint, mobilePairingPsk,
  mobileWordsOfferId, noiseKeyPair, type MobileNoisePattern
} from "../src/mobile-noise.js";
import vectors from "./fixtures/noise-vectors.json" with { type: "json" };

const hex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (start: number, length: number) => Uint8Array.from({ length }, (_, index) => start + index);

type Vector = (typeof vectors.vectors)[number] & { init_remote_static?: string; init_psks?: string[]; resp_psks?: string[] };

describe("mobile Noise (Cacophony vectors)", () => {
  it.each(vectors.vectors as Vector[])("$protocol_name: every handshake and transport message", (vector) => {
    const pattern = vector.protocol_name.split("_")[1] as MobileNoisePattern;
    const initiator = new MobileNoiseHandshake({
      pattern, initiator: true, prologue: hex(vector.init_prologue), s: noiseKeyPair(hex(vector.init_static)), e: noiseKeyPair(hex(vector.init_ephemeral)),
      ...(vector.init_remote_static ? { rs: hex(vector.init_remote_static) } : {}), ...(vector.init_psks ? { psk: hex(vector.init_psks[0]!) } : {})
    });
    const responder = new MobileNoiseHandshake({
      pattern, initiator: false, prologue: hex(vector.resp_prologue), s: noiseKeyPair(hex(vector.resp_static)), e: noiseKeyPair(hex(vector.resp_ephemeral)),
      ...(vector.resp_psks ? { psk: hex(vector.resp_psks[0]!) } : {})
    });
    let index = 0;
    for (; !initiator.complete; index++) {
      const { payload, ciphertext } = vector.messages[index]!;
      const [writer, reader] = index % 2 === 0 ? [initiator, responder] : [responder, initiator];
      expect(toHex(writer.writeMessage(hex(payload)))).toBe(ciphertext);
      expect(toHex(reader.readMessage(hex(ciphertext)))).toBe(payload);
    }
    expect(responder.complete).toBe(true);
    expect(toHex(initiator.handshakeHash)).toBe(vector.handshake_hash);
    expect(toHex(responder.handshakeHash)).toBe(vector.handshake_hash);
    expect(toHex(responder.remoteStatic!)).toBe(toHex(noiseKeyPair(hex(vector.init_static)).publicKey));
    const [first, second] = [initiator.split(), responder.split()];
    for (; index < vector.messages.length; index++) {
      const { payload, ciphertext } = vector.messages[index]!;
      const [writer, reader] = index % 2 === 0 ? [first, second] : [second, first];
      expect(toHex(writer.encrypt(hex(payload)))).toBe(ciphertext);
      expect(toHex(reader.decrypt(hex(ciphertext)))).toBe(payload);
    }
  });
});

describe("mobile Noise state", () => {
  const pair = () => {
    const responderStatic = noiseKeyPair(bytes(1, 32));
    const initiator = new MobileNoiseHandshake({ pattern: "IK", initiator: true, prologue: bytes(0, 4), s: noiseKeyPair(bytes(40, 32)), rs: responderStatic.publicKey });
    const responder = new MobileNoiseHandshake({ pattern: "IK", initiator: false, prologue: bytes(0, 4), s: responderStatic });
    responder.readMessage(initiator.writeMessage());
    initiator.readMessage(responder.writeMessage());
    return { app: initiator.split(), instance: responder.split() };
  };

  it("REKEY replaces the key with ENCRYPT(k, 2^64-1, empty, zeros)[0..32] (Noise §11.3)", () => {
    const key = bytes(7, 32);
    const state = new NoiseCipherState(key);
    state.rekey();
    const maxNonce = new Uint8Array(12).fill(0xff, 4);
    const rekeyed = chacha20poly1305(key, maxNonce, new Uint8Array(0)).encrypt(new Uint8Array(32)).slice(0, 32);
    expect(toHex(state.encrypt(new Uint8Array(0), bytes(9, 5)))).toBe(toHex(chacha20poly1305(rekeyed, new Uint8Array(12), new Uint8Array(0)).encrypt(bytes(9, 5))));
  });

  it(`both sides rekey after every ${MOBILE_NOISE_REKEY_EVERY} messages of a direction, with no signal`, () => {
    const { app, instance } = pair();
    const plain = bytes(3, 16);
    let last = new Uint8Array(0);
    for (let n = 1; n <= MOBILE_NOISE_REKEY_EVERY + 1; n++) {
      last = app.encrypt(plain);
      expect(toHex(instance.decrypt(last))).toBe(toHex(plain));
    }
    // A side whose count is off by one rekey cannot read message 10,001.
    const stale = pair();
    for (let n = 1; n <= MOBILE_NOISE_REKEY_EVERY; n++) stale.instance.decrypt(stale.app.encrypt(plain));
    stale.instance.rekeyReceive();
    expect(() => stale.instance.decrypt(stale.app.encrypt(plain))).toThrow(MobileNoiseError);
  });

  it("a replayed, reordered or altered transport frame fails, and the nonce does not move", () => {
    const { app, instance } = pair();
    const one = app.encrypt(bytes(1, 3));
    const two = app.encrypt(bytes(2, 3));
    expect(() => instance.decrypt(two)).toThrow("Noise: DECRYPT");
    const altered = one.slice(); altered[0]! ^= 1;
    expect(() => instance.decrypt(altered)).toThrow("Noise: DECRYPT");
    expect(toHex(instance.decrypt(one))).toBe(toHex(bytes(1, 3)));
    expect(() => instance.decrypt(one)).toThrow("Noise: DECRYPT");
    expect(toHex(instance.decrypt(two))).toBe(toHex(bytes(2, 3)));
  });

  it("XXpsk3 with a wrong code fails on message 3, at the instance", () => {
    const instanceStatic = noiseKeyPair(bytes(1, 32));
    const app = new MobileNoiseHandshake({ pattern: "XXpsk3", initiator: true, prologue: bytes(0, 4), s: noiseKeyPair(bytes(40, 32)), psk: bytes(5, 32) });
    const instance = new MobileNoiseHandshake({ pattern: "XXpsk3", initiator: false, prologue: bytes(0, 4), s: instanceStatic, psk: bytes(6, 32) });
    instance.readMessage(app.writeMessage());
    app.readMessage(instance.writeMessage());
    expect(toHex(app.remoteStatic!)).toBe(toHex(instanceStatic.publicKey));
    expect(() => instance.readMessage(app.writeMessage(bytes(1, 4)))).toThrow("Noise: DECRYPT");
  });

  it("a different prologue (another offer or rendezvous id) fails the handshake", () => {
    const responderStatic = noiseKeyPair(bytes(1, 32));
    const app = new MobileNoiseHandshake({ pattern: "IK", initiator: true, prologue: bytes(0, 4), s: noiseKeyPair(bytes(40, 32)), rs: responderStatic.publicKey });
    const instance = new MobileNoiseHandshake({ pattern: "IK", initiator: false, prologue: bytes(1, 4), s: responderStatic });
    expect(() => instance.readMessage(app.writeMessage())).toThrow("Noise: DECRYPT");
  });

  it("refuses out-of-turn messages, a missing psk and IK without the pinned key", () => {
    const s = noiseKeyPair(bytes(1, 32));
    expect(() => new MobileNoiseHandshake({ pattern: "XXpsk3", initiator: true, prologue: new Uint8Array(0), s })).toThrow("Noise: STATE");
    expect(() => new MobileNoiseHandshake({ pattern: "IK", initiator: true, prologue: new Uint8Array(0), s })).toThrow("Noise: STATE");
    const responder = new MobileNoiseHandshake({ pattern: "IK", initiator: false, prologue: new Uint8Array(0), s });
    expect(() => responder.writeMessage()).toThrow("Noise: STATE");
    expect(() => responder.split()).toThrow("Noise: STATE");
    expect(() => responder.readMessage(bytes(0, 10))).toThrow("Noise: BAD_MESSAGE");
  });
});

describe("mobile pairing derivations (expected values computed independently with Python's hashlib, hmac and base64)", () => {
  const instanceNoise = bytes(0, 32);
  const instanceIdentity = bytes(32, 32);
  const offerId = bytes(0, 8);
  const words = "abandon ability able about above absent absorb abstract";
  it("the psk from a 16-byte code and from 8 words", () => {
    expect(toHex(mobilePairingPsk(bytes(100, 16), instanceNoise, instanceIdentity, offerId))).toBe("e68ce97d0f7af28e314da7295cf89eb4acc0fb2225554a58b7d511598a7b6e66");
    expect(toHex(mobilePairingPsk(words, instanceNoise, instanceIdentity, offerId))).toBe("8e9eb65d74d8c258b3a2f5ddf91c32ef63f64826b92675153c3b7e814763d59b");
  });
  it("the words-mode offer id", () => {
    expect(toHex(mobileWordsOfferId(words))).toBe("d9b6ee2c30fc0c8f");
  });
  it("the instance fingerprint", () => {
    expect(mobileInstanceFingerprint(instanceNoise, instanceIdentity)).toBe("3XEN-WSR7-6KCS-N62K-UWP6-AV54");
  });
});
