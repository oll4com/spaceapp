import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mobileAdminOpSigningInput, mobileAnswerSigningInput, mobileAskContentHash, mobileDecisionContentHash, mobileGoalContentHash, mobileIntegrityRequestHash, LINK_APP, signNousLinkAnswer, vaultBase64url, type NousLinkAnswerStatement, type Artifact, type InboxEvent, type MobileRouteRule, type SpaceNotification } from "@space/contracts";
import { InMemoryAppDeviceSessionRepository } from "@space/db";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { createMobileChecks, MOBILE_SIG_HEADER } from "../src/mobile/checks.js";
import { MOBILE_INTEGRITY_HEADER, type PlayIntegrity } from "../src/mobile/integrity.js";

// Nous Pro 1b-5c (ADR-013 §6-7, design §6.2, §7, security review P1-2, P1-4): what a phone's request passes before its handler.
const owner = "user:operator";
const decideKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const spki = decideKey.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const askBody = { option: "Approve" };
const notification = (ask: Record<string, unknown> = {}, source = "MAIL_COPILOT") => ({ id: "notif:1", source, title: "Send the reply?", body: "To the bank.", payload: { ask: { question: "Send it?",
  options: ["Approve", "Decline"], recommended: "Approve", answer: { kind: "COPILOT_DECISION" }, ...ask } } }) as unknown as SpaceNotification;
const goal = { id: "nous_goal:abc1", text: "Ship Nous Pro." };
const decision = (category: string) => ({ id: "nd:1", category, title: "Publish 1.2.0", body: "Ready.", recommendation: "Yes", action: { kind: "RELEASE_APPROVE" }, refs: null });

async function checks(records: { notification?: SpaceNotification; category?: string; linked?: string; integrity?: PlayIntegrity; asks?: string[] } = {}) {
  const devices = new InMemoryAppDeviceSessionRepository();
  await devices.createPaired({ id: "appdev:phone1", ownerUserId: owner, app: "nous", deviceName: "Pixel", sidSha256: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z",
    noisePublic: "n".repeat(43), decidePublicSpki: spki, decideSecurityLevel: "TRUSTED_ENVIRONMENT", requestedScopes: ["read", "act", "decide"] });
  return createMobileChecks({ devices,
    artifact: async (id) => { if (id === "gone") throw new Error("not found"); return { id, storageUri: id === "agent" ? "space-artifact://agent-files/x" : "space-artifact://media/x" } as Artifact; },
    notification: async () => records.notification ?? null, decision: async () => (records.category ? decision(records.category) : null),
    goal: async (_owner, id) => (id === goal.id ? goal : null), integrity: records.integrity,
    inboxAsks: async (_owner, id) => (id === "thread:1" ? (records.asks ?? []).map((ref) => ({ ref, type: "ASK" }) as InboxEvent) : null),
    linkedDecision: async (_owner, linkId, id) => (records.linked && linkId === "link:1" && id === "nd:1" ? decision(records.linked) : null) });
}
const request = (id: string, scopes: string[], body: unknown = {}, sig?: string, integrity?: string) =>
  ({ user: { id: owner }, params: { id }, body, headers: { ...(sig ? { [MOBILE_SIG_HEADER]: sig } : {}), ...(integrity ? { [MOBILE_INTEGRITY_HEADER]: integrity } : {}) },
    mobileDevice: { id: "appdev:phone1", scopes, person: true } }) as unknown as FastifyRequest;
const signed = (kind: "decide" | "ask" | "goal-delete", id: string, hash: string, answer: unknown) =>
  sign("sha256", mobileAnswerSigningInput(kind, id, hash, answer), { key: decideKey.privateKey, dsaEncoding: "der" }).toString("base64url");
const rule = (patch: Partial<MobileRouteRule>): MobileRouteRule => ({ scope: "act", ...patch });

describe("a phone's per-request checks", () => {
  it("opens Agent Files by id, never room media or a missing artifact", async () => {
    const check = await checks();
    expect(await check(request("agent", ["read"]), rule({ scope: "read", artifactById: true }))).toBeNull();
    expect(await check(request("media", ["read"]), rule({ scope: "read", artifactById: true }))).toMatchObject({ code: "MOBILE_SCOPE_DENIED" });
    expect(await check(request("gone", ["read"]), rule({ scope: "read", artifactById: true }))).toMatchObject({ code: "MOBILE_SCOPE_DENIED" });
  });

  it("a needs-you answer: a NONE ask passes; a risky one needs decide and the device's signature over what it showed", async () => {
    const askRisk = rule({ askRisk: true });
    for (const ask of [{ risk: "NONE" }, { answer: { kind: "ACK" } }, { answer: { kind: "NOUS" } }, { answer: { kind: "PANE" } }]) {
      expect(await (await checks({ notification: notification(ask) }))(request("notif:1", ["read", "act"], askBody), askRisk), JSON.stringify(ask)).toBeNull();
    }
    expect(await (await checks({ notification: notification({}, "SECURITY_COPILOT") }))(request("notif:1", ["read", "act"], askBody), askRisk)).toMatchObject({ code: "MOBILE_DECIDE_REQUIRED" });
    const check = await checks({ notification: notification() });
    expect(await check(request("notif:1", ["read", "act"], askBody), askRisk)).toMatchObject({ code: "MOBILE_DECIDE_REQUIRED" });
    expect(await check(request("notif:1", ["read", "act", "decide"], askBody), askRisk)).toMatchObject({ code: "DECIDE_SIGNATURE" });
    const hash = mobileAskContentHash({ id: "notif:1", question: "Send it?", options: ["Approve", "Decline"], recommended: "Approve", body: "To the bank." });
    expect(await check(request("notif:1", ["read", "act", "decide"], askBody, signed("ask", "notif:1", hash, askBody)), askRisk)).toBeNull();
    // Another answer than the one signed, or a signature over other content, is refused.
    expect(await check(request("notif:1", ["read", "act", "decide"], { option: "Decline" }, signed("ask", "notif:1", hash, askBody)), askRisk)).toMatchObject({ code: "DECIDE_SIGNATURE" });
    expect(await check(request("notif:1", ["read", "act", "decide"], askBody, signed("ask", "notif:1", "0".repeat(64), askBody)), askRisk)).toMatchObject({ code: "DECIDE_SIGNATURE" });
  });

  it("a RELEASE, DESTRUCTIVE or EXTERNAL decision needs the signature over its content; other categories do not", async () => {
    const answer = { answer: "APPROVE" }, decisionRule = rule({ scope: "decide", decisionSignature: true });
    expect(await (await checks({ category: "DIRECTION" }))(request("nd:1", ["read", "decide"], answer), decisionRule)).toBeNull();
    const check = await checks({ category: "RELEASE" });
    expect(await check(request("nd:1", ["read", "decide"], answer), decisionRule)).toMatchObject({ code: "DECIDE_SIGNATURE" });
    const sig = signed("decide", "nd:1", mobileDecisionContentHash(decision("RELEASE")), answer);
    expect(await check(request("nd:1", ["read", "decide"], answer, sig), decisionRule)).toBeNull();
    // The same signature for the ask of the same id is another statement.
    expect(await check(request("nd:1", ["read", "decide"], answer, signed("ask", "nd:1", mobileDecisionContentHash(decision("RELEASE")), answer)), decisionRule))
      .toMatchObject({ code: "DECIDE_SIGNATURE" });
  });

  // Space Link v2 step 9c (ADR-014 v2): the superior's person answers a decision here under the superior's identity key, over the decision as it stands.
  it("takes a superior's signed answer only from the superior, made out to this SpaceApp, over the unchanged decision and recent", async () => {
    const devices = new InMemoryAppDeviceSessionRepository();
    const at = "2026-11-15T06:00:00.000Z", now = Date.parse(at), own = vaultBase64url.encode(randomBytes(32));
    await devices.createPaired({ id: "appdev:link1", ownerUserId: owner, app: LINK_APP, deviceName: "SpaceApp boss", sidSha256: "b".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z",
      noisePublic: "m".repeat(43), decidePublicSpki: null, decideSecurityLevel: null, requestedScopes: ["read", "act"] });
    await devices.confirm(owner, "appdev:link1", at);
    await devices.setLinkScopes(owner, "appdev:link1", ["read", "act", "manage", "nous"], at);
    const boss = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as { d: string; x: string };
    let open: ReturnType<typeof decision> | null = decision("DESTRUCTIVE");
    const check = createMobileChecks({ devices, artifact: async () => { throw new Error("none"); }, notification: async () => null, decision: async () => open,
      goal: async () => null, ownIdentity: async () => own, now: () => now });
    const answerRule = rule({ scope: "nous", superior: true, superiorSignature: true });
    const statement = (patch: Partial<NousLinkAnswerStatement> = {}): NousLinkAnswerStatement =>
      ({ v: 1, to: own, decisionId: "nd:1", contentHash: mobileDecisionContentHash(decision("DESTRUCTIVE")), answer: "APPROVE", at, ...patch });
    const send = (body: NousLinkAnswerStatement, key = vaultBase64url.decode(boss.d)) =>
      check({ user: { id: owner }, params: { id: "nd:1" }, body: { statement: body, signature: signNousLinkAnswer(body, key) }, headers: {},
        mobileDevice: { id: "appdev:link1", scopes: ["read", "act", "manage", "nous"], person: false } } as unknown as FastifyRequest, answerRule);
    // Before its Nous is superior here, nothing it signs counts.
    expect(await send(statement())).toMatchObject({ code: "NOUS_NOT_SUPERIOR" });
    await devices.setNousSuperior("appdev:link1", { identityPublic: boss.x, label: "SpaceApp boss", host: "boss", chain: [], since: at, at });
    expect(await send(statement())).toBeNull();
    // Another key, another SpaceApp, another decision's content, or an old statement: refused.
    for (const [body, key] of [[statement(), randomBytes(32)], [statement({ to: vaultBase64url.encode(randomBytes(32)) })], [statement({ contentHash: "0".repeat(64) })],
      [statement({ at: "2026-11-15T05:00:00.000Z" })], [statement({ decisionId: "nd:2" })]] as Array<[NousLinkAnswerStatement, Uint8Array?]>) {
      expect(await send(body, key), JSON.stringify(body)).toMatchObject({ code: "NOUS_LINK_ANSWER_SIGNATURE" });
    }
    // Answered here first: the first answer wins.
    open = null;
    expect(await send(statement())).toMatchObject({ code: "DECISION_NOT_OPEN" });
  });

  // Nik 15/11 (contract v2/mobile-act-contract.md): the inbox's verbs sign each ask they touch as that ask's own route does; no weaker path.
  it("an inbox act signs the ask it answers or the signed decision it dismisses; Done signs nothing; an unknown Thread is refused", async () => {
    const actRule = rule({ scope: "decide", person: true, inboxActSignature: true }), scopes = ["read", "act", "decide"];
    const answer = { verb: "APPROVE", askId: "nous_decision:1" }, dismiss = { verb: "DISMISS" };
    const hash = mobileDecisionContentHash(decision("RELEASE"));
    let check = await checks({ category: "RELEASE", asks: ["nous_decision:1"] });
    expect(await check(request("thread:1", scopes, answer), actRule)).toMatchObject({ code: "DECIDE_SIGNATURE" });
    expect(await check(request("thread:1", scopes, answer, signed("decide", "nous_decision:1", hash, answer)), actRule)).toBeNull();
    expect(await check(request("thread:1", scopes, dismiss), actRule)).toMatchObject({ code: "DECIDE_SIGNATURE" });
    expect(await check(request("thread:1", scopes, dismiss, signed("decide", "nous_decision:1", hash, dismiss)), actRule)).toBeNull();
    // The answer's signature does not dismiss, and Done touches no ask.
    expect(await check(request("thread:1", scopes, dismiss, signed("decide", "nous_decision:1", hash, answer)), actRule)).toMatchObject({ code: "DECIDE_SIGNATURE" });
    expect(await check(request("thread:1", scopes, { verb: "DONE" }), actRule)).toBeNull();
    expect(await check(request("thread:2", scopes, { verb: "DONE" }), actRule)).toMatchObject({ status: 404 });
    expect(await (await checks({ category: "DIRECTION", asks: ["nous_decision:1"] }))(request("thread:1", scopes, answer), actRule)).toBeNull();
    check = await checks({ category: "DESTRUCTIVE", asks: ["nous_decision:1", "nous_decision:2"] });
    expect(await check(request("thread:1", scopes, dismiss), actRule)).toMatchObject({ status: 409, code: "INBOX_SIGN_ONE" });
    // A risky card's answer signs as POST /api/notifications/:id/answer does; its dismiss is an ack, unsigned there too.
    check = await checks({ notification: { ...notification(), id: "notification:1" }, asks: ["notification:1"] });
    const card = { verb: "ANSWER", askId: "notification:1", option: "Approve" };
    const cardHash = mobileAskContentHash({ id: "notification:1", question: "Send it?", options: ["Approve", "Decline"], recommended: "Approve", body: "To the bank." });
    expect(await check(request("thread:1", scopes, card), actRule)).toMatchObject({ code: "DECIDE_SIGNATURE" });
    expect(await check(request("thread:1", scopes, card, signed("ask", "notification:1", cardHash, card)), actRule)).toBeNull();
    expect(await check(request("thread:1", scopes, dismiss), actRule)).toBeNull();
  });

  // C9 (internal MASVS review 1/11): a goal's delete is class A, so it takes the decide signature over the goal's own text.
  it("a linked Nous's decision from the phone: the same signature rule, over the decision as this SpaceApp read it; a closed one is refused", async () => {
    const answer = { answer: "APPROVE" }, linkedRule = rule({ scope: "decide", linkedDecisionSignature: true });
    const linked = (sig?: string, decisionId = "nd:1") => ({ ...request("link:1", ["read", "act", "decide"], answer, sig), params: { id: "link:1", decisionId } }) as unknown as FastifyRequest;
    expect(await (await checks({ linked: "DIRECTION" }))(linked(), linkedRule)).toBeNull();
    const check = await checks({ linked: "RELEASE" });
    expect(await check(linked(), linkedRule)).toMatchObject({ code: "DECIDE_SIGNATURE" });
    expect(await check(linked(signed("decide", "nd:1", mobileDecisionContentHash(decision("RELEASE")), answer)), linkedRule)).toBeNull();
    expect(await check(linked(signed("decide", "nd:1", mobileDecisionContentHash(decision("RELEASE")), { answer: "DECLINE" })), linkedRule)).toMatchObject({ code: "DECIDE_SIGNATURE" });
    expect(await check(linked(undefined, "nd:2"), linkedRule)).toMatchObject({ status: 404 });
  });

  it("deletes a goal only with the decide signature over its text", async () => {
    const check = await checks(), goalRule = rule({ scope: "decide", goalSignature: true });
    expect(await check(request(goal.id, ["read", "decide"], undefined), goalRule)).toMatchObject({ code: "DECIDE_SIGNATURE" });
    expect(await check(request(goal.id, ["read", "act"], undefined, signed("goal-delete", goal.id, mobileGoalContentHash(goal), "delete")), goalRule)).toMatchObject({ code: "MOBILE_DECIDE_REQUIRED" });
    expect(await check(request(goal.id, ["read", "decide"], undefined, signed("goal-delete", goal.id, mobileGoalContentHash(goal), "delete")), goalRule)).toBeNull();
    expect(await check(request(goal.id, ["read", "decide"], undefined, signed("goal-delete", goal.id, mobileGoalContentHash({ ...goal, text: "Other." }), "delete")), goalRule))
      .toMatchObject({ code: "DECIDE_SIGNATURE" });
    // A goal the lookup cannot find never reaches the handler unsigned (Nous 16855): refused, signed or not.
    expect(await check(request("nous_goal:gone", ["read", "decide"], undefined), goalRule)).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await check(request("nous_goal:gone", ["read", "decide"], undefined, signed("goal-delete", "nous_goal:gone", mobileGoalContentHash({ id: "nous_goal:gone", text: "" }), "delete")), goalRule))
      .toMatchObject({ status: 404 });
  });
  // Nous settings' ops from the Nous app (operator nous_msg:7f3a38f5): an ADMIN user, decide, and the signature over the method, path and body.
  it("runs an ADMIN operation only for an ADMIN with the decide signature over its method, path and body", async () => {
    const check = await checks(), adminRule = rule({ scope: "decide", person: true, adminSignature: true }), body = { confirm: true };
    const op = (role: string, scopes: string[], sig?: string, url = "/api/admin/ops/restart?x=1", sent: unknown = body) =>
      ({ ...request("", scopes, sent, sig), method: "POST", url, user: { id: owner, role } }) as unknown as FastifyRequest;
    const sig = sign("sha256", mobileAdminOpSigningInput("POST", "/api/admin/ops/restart", body), { key: decideKey.privateKey, dsaEncoding: "der" }).toString("base64url");
    expect(await check(op("ADMIN", ["read", "act", "decide"], sig), adminRule)).toBeNull();
    expect(await check(op("OPERATOR", ["read", "act", "decide"], sig), adminRule)).toMatchObject({ status: 403, code: "ADMIN_REQUIRED" });
    expect(await check(op("ADMIN", ["read", "act"], sig), adminRule)).toMatchObject({ code: "MOBILE_DECIDE_REQUIRED" });
    expect(await check(op("ADMIN", ["read", "act", "decide"]), adminRule)).toMatchObject({ code: "DECIDE_SIGNATURE" });
    // The signature names one operation and one body.
    expect(await check(op("ADMIN", ["read", "act", "decide"], sig, "/api/admin/ops/clean-disk"), adminRule)).toMatchObject({ code: "DECIDE_SIGNATURE" });
    expect(await check(op("ADMIN", ["read", "act", "decide"], sig, undefined, { confirm: true, services: ["all"] }), adminRule)).toMatchObject({ code: "DECIDE_SIGNATURE" });
  });
  // MASVS L2 RESILIENCE (plan clipboard:kTV3y2lwO-99 step 7): with Play Integrity configured, a signed answer also needs Google's verdict for
  // this app and phone, bound to exactly what was signed; it is checked after the signature, so a bad signature never costs a Google call.
  it("a signed answer needs Google's Play Integrity verdict over its signing input, once configured", async () => {
    const answer = { answer: "APPROVE" }, decisionRule = rule({ scope: "decide", decisionSignature: true });
    const asked: Array<{ token?: string; app: string; requestHash: string }> = [];
    const integrity: PlayIntegrity = { verify: async (input) => { asked.push(input); return input.token === "good" ? { ok: true } : { ok: false, reason: input.token ? "DEVICE" : "NO_TOKEN" }; } };
    const check = await checks({ category: "RELEASE", integrity });
    const hash = mobileDecisionContentHash(decision("RELEASE")), sig = signed("decide", "nd:1", hash, answer);
    expect(await check(request("nd:1", ["read", "decide"], answer, sig), decisionRule)).toMatchObject({ code: "PLAY_INTEGRITY", message: expect.stringContaining("NO_TOKEN") });
    expect(await check(request("nd:1", ["read", "decide"], answer, sig, "bad"), decisionRule)).toMatchObject({ status: 403, code: "PLAY_INTEGRITY" });
    expect(await check(request("nd:1", ["read", "decide"], answer, sig, "good"), decisionRule)).toBeNull();
    expect(asked.at(-1)).toEqual({ token: "good", app: "nous", requestHash: mobileIntegrityRequestHash("decide", mobileAnswerSigningInput("decide", "nd:1", hash, answer)) });
    const calls = asked.length;
    expect(await check(request("nd:1", ["read", "decide"], { answer: "DECLINE" }, sig, "good"), decisionRule)).toMatchObject({ code: "DECIDE_SIGNATURE" });
    expect(asked).toHaveLength(calls);
  });
});
