import { generateKeyPairSync, sign } from "node:crypto";
import { mobileAdminOpSigningInput, mobileAnswerSigningInput, mobileAskContentHash, mobileDecisionContentHash, mobileGoalContentHash, mobileIntegrityRequestHash, type Artifact, type MobileRouteRule, type SpaceNotification } from "@space/contracts";
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

async function checks(records: { notification?: SpaceNotification; category?: string; integrity?: PlayIntegrity } = {}) {
  const devices = new InMemoryAppDeviceSessionRepository();
  await devices.createPaired({ id: "appdev:phone1", ownerUserId: owner, app: "nous", deviceName: "Pixel", sidSha256: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z",
    noisePublic: "n".repeat(43), decidePublicSpki: spki, decideSecurityLevel: "TRUSTED_ENVIRONMENT", requestedScopes: ["read", "act", "decide"] });
  return createMobileChecks({ devices,
    artifact: async (id) => { if (id === "gone") throw new Error("not found"); return { id, storageUri: id === "agent" ? "space-artifact://agent-files/x" : "space-artifact://media/x" } as Artifact; },
    notification: async () => records.notification ?? null, decision: async () => (records.category ? decision(records.category) : null),
    goal: async (_owner, id) => (id === goal.id ? goal : null), integrity: records.integrity });
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

  // C9 (internal MASVS review 1/11): a goal's delete is class A, so it takes the decide signature over the goal's own text.
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
