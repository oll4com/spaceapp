import { createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  MOBILE_FRAME_MAX_PLAINTEXT, MOBILE_PAIR_PREFIX, MOBILE_ROUTE_SCOPES, NOUS_APP_MIN_VERSION, decodeMobileFrame, decodeMobilePairQr, encodeMobileFrame, encodeMobilePairQr,
  mobileAnswerSigningInput, mobileAppUpdateRequired, mobileAppVersionCode, mobileAskContentHash, mobileIntegrityRequestHash, mobilePairRequestSchema, mobileBodyProblem, mobileDecisionContentHash, mobileFrames, mobileHandshakePrologue, mobileRouteAllows, signMobileRotation,
  verifyMobileRotation, type MobilePairQr, type MobileRotationStatement
} from "../src/mobile-channel.js";
import { MobileNoiseHandshake, noiseKeyPair } from "../src/mobile-noise.js";
import { vaultBase64url } from "../src/vault-crypto.js";

const b64 = (length: number, fill = 7) => vaultBase64url.encode(new Uint8Array(length).fill(fill));
const qr = (patch: Partial<MobilePairQr> = {}): MobilePairQr => ({
  v: 1, o: b64(8), u: ["https://space.example.com:4911"], r: null, k: b64(32, 1), i: b64(32, 2), c: b64(16, 3), n: "Home", x: 2_000_000_000, ...patch
});
const rawQr = (value: unknown) => MOBILE_PAIR_PREFIX + vaultBase64url.encode(new TextEncoder().encode(JSON.stringify(value)));

describe("the pairing QR", () => {
  it("round-trips and is plain text, never a link", () => {
    const text = encodeMobilePairQr(qr());
    expect(text.startsWith("SPACEAPP-PAIR:1:")).toBe(true);
    expect(decodeMobilePairQr(text, 1_900_000_000)).toEqual(qr());
    expect(decodeMobilePairQr(encodeMobilePairQr(qr({ u: ["http://192.168.1.20:4911"] })), 1)).toMatchObject({ u: ["http://192.168.1.20:4911"] });
    expect(decodeMobilePairQr(encodeMobilePairQr(qr({ u: [], r: b64(32, 9) })), 1).r).toBe(b64(32, 9));
  });
  it("refuses another version, a public http origin, a short key, an unknown field, an expired offer and another prefix", () => {
    expect(() => decodeMobilePairQr(rawQr({ ...qr(), v: 2 }), 1)).toThrow();
    expect(() => decodeMobilePairQr(rawQr({ ...qr(), u: ["http://space.example.com"] }), 1)).toThrow();
    expect(() => decodeMobilePairQr(rawQr({ ...qr(), u: ["https://space.example.com/path"] }), 1)).toThrow();
    expect(() => decodeMobilePairQr(rawQr({ ...qr(), k: b64(31) }), 1)).toThrow();
    expect(() => decodeMobilePairQr(rawQr({ ...qr(), extra: 1 }), 1)).toThrow();
    expect(() => decodeMobilePairQr(rawQr({ ...qr(), u: [], r: null }), 1)).toThrow();
    expect(() => decodeMobilePairQr(encodeMobilePairQr(qr()), 2_000_000_000)).toThrow("expired");
    expect(() => decodeMobilePairQr("spaceapp://pair?x=1", 1)).toThrow("Not a SpaceApp pairing code");
  });
});

describe("the handshake prologue (design §2.2, §3.1)", () => {
  it("binds the mode, the offer and the rid, with 32 zero bytes for no rid", () => {
    const offer = new Uint8Array(8).fill(5), rid = new Uint8Array(32).fill(9);
    const pair = mobileHandshakePrologue("pair", offer, null);
    expect(new TextDecoder().decode(pair.subarray(0, 17))).toBe("spaceapp-mobile/1");
    expect([...pair.subarray(17)]).toEqual([1, ...offer, ...new Uint8Array(32)]);
    expect([...mobileHandshakePrologue("ik", null, rid).subarray(17)]).toEqual([2, ...rid]);
    expect(() => mobileHandshakePrologue("pair", new Uint8Array(7), null)).toThrow();
    expect(() => mobileHandshakePrologue("ik", offer, null)).toThrow();
    expect(() => mobileHandshakePrologue("ik", null, new Uint8Array(31))).toThrow();
  });
  it("a handshake moved to another rid fails", () => {
    const run = (appOffer: number) => {
      const s = noiseKeyPair(), app = new MobileNoiseHandshake({ pattern: "IK", initiator: true, prologue: mobileHandshakePrologue("ik", null, new Uint8Array(32).fill(appOffer)), s: noiseKeyPair(), rs: s.publicKey });
      const instance = new MobileNoiseHandshake({ pattern: "IK", initiator: false, prologue: mobileHandshakePrologue("ik", null, new Uint8Array(32).fill(1)), s });
      instance.readMessage(app.writeMessage(new Uint8Array(0)));
    };
    expect(() => run(1)).not.toThrow();
    expect(() => run(2)).toThrow();
  });
  it("the paired control frame is a control op", () => {
    const frame = { type: "ctl" as const, header: { op: "paired", deviceId: "appdev:x", scopes: ["read"] }, body: new Uint8Array(0) };
    expect(decodeMobileFrame(encodeMobileFrame(frame))).toEqual(frame);
  });
});

describe("frames", () => {
  it("round-trip every type with strict headers", () => {
    const frames = [
      { type: "req" as const, header: { id: 1, m: "POST", p: "/api/nous/messages", h: { "content-type": "application/json", "x-space-client": "app=NOUS_ANDROID; v=0.2.22; os=ANDROID; form=PHONE; view=/; vp=412x915" } }, body: new TextEncoder().encode('{"content":"hi"}') },
      { type: "res" as const, header: { id: 1, s: 200 }, body: new Uint8Array([1, 2]) },
      { type: "chunk" as const, header: { id: 1, seq: 1, more: false }, body: new Uint8Array(3) },
      { type: "evt" as const, header: { type: "NOTIFICATION_CREATED", ids: { notificationId: "n:1" } }, body: new Uint8Array(0) },
      { type: "ctl" as const, header: { op: "push-handle", handle: "abc" }, body: new Uint8Array(0) }
    ];
    for (const frame of frames) expect(decodeMobileFrame(encodeMobileFrame(frame))).toEqual(frame);
    expect(() => encodeMobileFrame({ type: "req", header: { id: 1, m: "POST", p: "/api/x", h: { cookie: "a" } }, body: new Uint8Array(0) })).toThrow();
    expect(() => decodeMobileFrame(Uint8Array.of(9, 0, 0, 0, 0))).toThrow("Bad frame");
    expect(() => encodeMobileFrame({ type: "req", header: { id: 1, m: "GET", p: "/api/x", h: { "x-space-client": "a".repeat(301) } }, body: new Uint8Array(0) })).toThrow();
  });
  it("splits a body over 64 KiB into chunk frames that each fit one Noise message", () => {
    const body = Uint8Array.from({ length: 200_000 }, (_, index) => index % 251);
    const frames = mobileFrames("res", { id: 7, s: 200 }, body);
    expect(frames[0]).toMatchObject({ type: "res", header: { id: 7, s: 200, more: true } });
    expect(frames.slice(1).map((frame) => frame.header.seq)).toEqual(frames.slice(1).map((_, index) => index + 1));
    expect(frames.at(-1)!.header.more).toBe(false);
    for (const frame of frames) expect(encodeMobileFrame(frame).length).toBeLessThanOrEqual(MOBILE_FRAME_MAX_PLAINTEXT);
    expect(Buffer.concat(frames.map((frame) => frame.body))).toEqual(Buffer.from(body));
    expect(mobileFrames("req", { id: 2, m: "GET", p: "/api/nous" }, new Uint8Array(10))).toHaveLength(1);
  });
});

describe("what a phone may reach", () => {
  it("allows each listed route only with its scope, on the exact matched pattern", () => {
    for (const [key, rule] of Object.entries(MOBILE_ROUTE_SCOPES)) {
      const [method, pattern] = key.split(" ") as [string, string];
      expect(mobileRouteAllows([rule.scope], method, pattern, rule.query ?? {}), key).toBe(rule);
      expect(mobileRouteAllows(["read", "act", "decide"].filter((scope) => scope !== rule.scope), method, pattern, rule.query ?? {}), key).toBeNull();
    }
  });
  it("refuses unlisted routes, the admin scope's reach and unmatched requests", () => {
    const all = ["read", "act", "decide", "admin"];
    for (const [method, pattern] of [["PUT", "/api/user-settings"], ["GET", "/api/space-vault/items"], ["POST", "/api/admin/releases/hotfixes/:ticketId/approve"],
      ["GET", "/api/auth/devices"], ["POST", "/api/mobile/pairing"], ["POST", "/api/control/v1/execute"], ["DELETE", "/api/artifacts/:id"],
      ["GET", "/api/artifacts/:id/download"], ["POST", "/api/nous/decisions/vault-broker-reinstall"], ["GET", "/api/nous/messages/:id"]] as const) {
      expect(mobileRouteAllows(all, method, pattern), `${method} ${pattern}`).toBeNull();
    }
    expect(mobileRouteAllows(all, "GET", undefined)).toBeNull();
    expect(mobileRouteAllows(all, "get", "/api/nous")).not.toBeNull();
  });
  it("checks query rules on the parsed query: one exact value, never an array or another value", () => {
    expect(mobileRouteAllows(["read"], "GET", "/api/clipboard-items", { source: "PLAN", page: "1" })).not.toBeNull();
    expect(mobileRouteAllows(["read"], "GET", "/api/clipboard-items", { source: "COPY" })).toBeNull();
    expect(mobileRouteAllows(["read"], "GET", "/api/clipboard-items", { source: ["PLAN", "COPY"] })).toBeNull();
    expect(mobileRouteAllows(["read"], "GET", "/api/clipboard-items", {})).toBeNull();
    expect(mobileRouteAllows(["read"], "GET", "/api/artifacts", { collection: "ROOM_MEDIA" })).toBeNull();
  });
  it("marks the person routes and the per-request checks", () => {
    expect(MOBILE_ROUTE_SCOPES["POST /api/nous/pane-board/:paneId/answer"]).toMatchObject({ person: true, body: "noAlways" });
    expect(MOBILE_ROUTE_SCOPES["POST /api/notifications/:id/answer"]).toMatchObject({ person: true, body: "noAlways", askRisk: true });
    expect(MOBILE_ROUTE_SCOPES["POST /api/nous/decisions/:id/answer"]).toMatchObject({ scope: "decide", decisionSignature: true });
    expect(MOBILE_ROUTE_SCOPES["DELETE /api/nous/goals/:id"]).toMatchObject({ scope: "decide", goalSignature: true });
    expect(MOBILE_ROUTE_SCOPES["GET /api/artifacts/:id/file"]).toMatchObject({ artifactById: true });
    expect(MOBILE_ROUTE_SCOPES["POST /api/notifications/:id/read"]?.person).toBeUndefined();
  });
  // Operator 6/11 (nous_msg:781819c5): token usage and the saved signatures from the Nous app; signing and the library are in person.
  it("lets the phone read token usage and signatures, and save, change, delete and sign in person", () => {
    for (const route of ["GET /api/nous/token-usage", "GET /api/signatures", "GET /api/signatures/:id/image", "GET /api/signature-requests"]) {
      expect(MOBILE_ROUTE_SCOPES[route], route).toEqual({ scope: "read" });
    }
    for (const route of ["POST /api/signatures", "PATCH /api/signatures/:id", "DELETE /api/signatures/:id", "POST /api/signature-requests/:id/sign"]) {
      expect(MOBILE_ROUTE_SCOPES[route], route).toEqual({ scope: "act", person: true });
    }
    expect(MOBILE_ROUTE_SCOPES["POST /api/signature-requests/:id/cancel"]).toEqual({ scope: "act" });
    // The old default-signature routes, the phone number and signing an Agent File without a request stay on the computer.
    for (const route of ["PUT /api/signature", "DELETE /api/signature", "PUT /api/signature/details", "POST /api/artifacts/:id/sign"]) expect(MOBILE_ROUTE_SCOPES[route], route).toBeUndefined();
    expect(mobileRouteAllows(["read"], "POST", "/api/signatures")).toBeNull();
  });
  it("body rules", () => {
    expect(mobileBodyProblem("settingsEnabledAndTabs", { enabled: false })).toBeNull();
    expect(mobileBodyProblem("settingsEnabledAndTabs", { dockTabs: { done: false } })).toBeNull();
    expect(mobileBodyProblem("settingsEnabledAndTabs", { enabled: true, mayPromote: true })).toMatch(/only enabled and dockTabs/);
    expect(mobileBodyProblem("awayNoGrant", { until: "2026-11-01T00:00:00Z" })).toBeNull();
    expect(mobileBodyProblem("awayNoGrant", { grant: ["PROMOTE"] })).toMatch(/computer/);
    expect(mobileBodyProblem("noAlways", { option: "Approve" })).toBeNull();
    expect(mobileBodyProblem("noAlways", { option: "Approve", always: false })).toMatch(/computer/);
    expect(mobileBodyProblem("noAlways", [])).toMatch(/JSON object/);
  });
});

describe("what the decide key signs (expected hashes computed independently with Python's json and hashlib)", () => {
  const decision = { id: "nous_decision:abc123", category: "RELEASE", title: "Publish 1.2.0", body: "Candidate 0123abcd.", recommendation: "Approve",
    action: { kind: "RELEASE_APPROVE", train: "rt:1" } };
  it("the decision and ask content hashes", () => {
    expect(mobileDecisionContentHash(decision)).toBe("d0df6cf382ef4227bca6b5c988a50680d909253923fdb5fe36d7f94dd5f68cf2");
    expect(mobileAskContentHash({ id: "notif:1", question: "Send the invoice?", options: ["Send", "Hold"], recommended: "Send" }))
      .toBe("39be0ead49e0122c2280fa25d780082bfe7f36366ea5abce31ba68d2996f3df9");
  });
  it("the signing input, signed by a P-256 key and verified by node:crypto as the channel will", () => {
    const input = mobileAnswerSigningInput("decide", decision.id, mobileDecisionContentHash(decision), { answer: "approve", note: "ok" });
    expect(new TextDecoder().decode(input)).toBe("spaceapp-decide-v1\nnous_decision:abc123\nd0df6cf382ef4227bca6b5c988a50680d909253923fdb5fe36d7f94dd5f68cf2\n"
      + "f80020aca9e0f94642b85fa9c1822d246ddbf20a2395cc23684104364f1a32e2");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const signature = nodeSign("sha256", input, { key: privateKey, dsaEncoding: "der" });
    const spki = createPublicKey({ key: publicKey.export({ type: "spki", format: "der" }), format: "der", type: "spki" });
    expect(nodeVerify("sha256", input, { key: spki, dsaEncoding: "der" }, signature)).toBe(true);
    const otherAnswer = mobileAnswerSigningInput("decide", decision.id, mobileDecisionContentHash(decision), { answer: "decline" });
    expect(nodeVerify("sha256", otherAnswer, { key: spki, dsaEncoding: "der" }, signature)).toBe(false);
    expect(new TextDecoder().decode(mobileAnswerSigningInput("ask", "notif:1", "h", {})).startsWith("spaceapp-ask-v1\n")).toBe(true);
  });
});

describe("the rotation statement (RFC 8032 test key 1)", () => {
  const secret = Uint8Array.from(Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"));
  const pinned = Uint8Array.from(Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex"));
  const statement: MobileRotationStatement = { v: 1, oldFp: "3XEN-WSR7-6KCS-N62K-UWP6-AV54", newIS: b64(32, 4), newII: b64(32, 5), at: "2026-10-31T11:00:00.000Z" };
  it("signs with the old identity key and verifies with the pinned one, also by node:crypto", () => {
    expect(Buffer.from(ed25519.getPublicKey(secret)).toString("hex")).toBe(Buffer.from(pinned).toString("hex"));
    const signature = signMobileRotation(statement, secret);
    expect(verifyMobileRotation(statement, signature, pinned)).toBe(true);
    const spki = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pinned)]), format: "der", type: "spki" });
    const signed = new TextEncoder().encode(`spaceapp-rotate-v1\n{"at":"${statement.at}","newII":"${statement.newII}","newIS":"${statement.newIS}","oldFp":"${statement.oldFp}","v":1}`);
    expect(nodeVerify(null, signed, spki, Buffer.from(vaultBase64url.decode(signature)))).toBe(true);
  });
  it("refuses a changed statement, another key and a bad signature", () => {
    const signature = signMobileRotation(statement, secret);
    expect(verifyMobileRotation({ ...statement, newIS: b64(32, 6) }, signature, pinned)).toBe(false);
    expect(verifyMobileRotation(statement, signature, ed25519.getPublicKey(new Uint8Array(32).fill(1)))).toBe(false);
    expect(verifyMobileRotation(statement, "not-a-signature", pinned)).toBe(false);
  });
});

describe("MASVS L2 core gaps (plan clipboard:kTV3y2lwO-99 step 7)", () => {
  it("CODE-2: a Nous app below the floor must update; other apps and newer ones pass", () => {
    expect(mobileAppVersionCode("0.2.18")).toBe(218);
    expect(mobileAppVersionCode("1.12.3")).toBe(11_203);
    expect(mobileAppVersionCode("0.2")).toBeNull();
    expect(mobileAppUpdateRequired("nous", NOUS_APP_MIN_VERSION)).toBeNull();
    expect(mobileAppUpdateRequired("nous", "0.3.0")).toBeNull();
    expect(mobileAppUpdateRequired("nous", "0.2.17")).toEqual({ code: "APP_UPDATE_REQUIRED", minVersion: "0.2.18", minVersionCode: 218 });
    expect(mobileAppUpdateRequired("nous", "dev")).toMatchObject({ code: "APP_UPDATE_REQUIRED" });
    expect(mobileAppUpdateRequired("spaceapp", "0.0.1")).toBeNull();
  });
  it("RESILIENCE: the integrity request hash binds its purpose and data; the token rides in the pair request and a req frame", () => {
    const data = new Uint8Array(32).fill(5);
    expect(mobileIntegrityRequestHash("pair", data)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mobileIntegrityRequestHash("pair", data)).not.toBe(mobileIntegrityRequestHash("decide", data));
    expect(mobileIntegrityRequestHash("pair", data)).not.toBe(mobileIntegrityRequestHash("pair", new Uint8Array(32)));
    const token = ["a", "b", "c", "d", "e"].map((part) => part.repeat(20)).join(".");
    const pair = { deviceName: "Pixel", app: "nous", appVersion: "0.2.21", platform: "android", wantScopes: ["read"] } as const;
    expect(mobilePairRequestSchema.parse({ ...pair, integrityToken: token }).integrityToken).toBe(token);
    expect(() => mobilePairRequestSchema.parse({ ...pair, integrityToken: "not a token" })).toThrow();
    const frame = { type: "req", header: { id: 1, m: "POST", p: "/api/nous/decisions/x/answer", sig: "s".repeat(86), int: token }, body: new Uint8Array(0) } as const;
    expect(decodeMobileFrame(encodeMobileFrame(frame))).toEqual(frame);
  });
});
