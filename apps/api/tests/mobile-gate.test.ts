import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { MOBILE_ROUTE_SCOPES, mobileAdminOpSigningInput, mobileAnswerSigningInput, mobileGoalContentHash } from "@space/contracts";
import { InMemoryAppDeviceSessionRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, defaultSessionRevocationStore, sessionIdHash, signMobileSession, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { createMobileChecks, MOBILE_SIG_HEADER } from "../src/mobile/checks.js";
import { MOBILE_INVOKE_HEADER, mobileInvokeSecret, setMobileChecks } from "../src/mobile/gate.js";
import { isOperatorPerson } from "../src/queue-operator-grants.js";
import { registeredRoutes } from "./route-tree.js";

// Nous Pro 1b-4a (ADR-013 §5-7, design §6.1, security review P0-1, P2-3): a phone's channel session runs only with the in-process secret,
// only on MOBILE_ROUTE_SCOPES for its scopes, and is the operator in person only on the routes marked `person`.
const secret = "mobile-gate-test-secret-1234567890";
const operator = { id: "user:operator", email: "operator@example.test", role: "ADMIN" as const };
const GATE_CODES = ["MOBILE_INVOKE", "MOBILE_SESSION", "MOBILE_SCOPE_DENIED", "MOBILE_BODY"];

describe("the mobile gate", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  const phone = (scopes: string[], options: { sid?: string; nowMs?: number; invoke?: string | null; device?: string; app?: typeof app } = {}) => {
    const token = signMobileSession(operator, secret, { sid: options.sid ?? randomBytes(32).toString("hex"), app: "nous", device: options.device ?? "appdev:phone0001", scopes }, options.nowMs);
    const invoke = options.invoke === undefined ? mobileInvokeSecret(options.app ?? app)! : options.invoke;
    return { cookie: `${cookieName}=${token}`, "x-space-csrf-token": createCsrfToken(token, secret)!, ...(invoke === null ? {} : { [MOBILE_INVOKE_HEADER]: invoke }) };
  };
  const code = (response: { body: string }) => { try { return JSON.parse(response.body)?.error?.code as string | undefined; } catch { return undefined; } };
  beforeAll(async () => {
    const store = new InMemorySpaceStore();
    await store.upsertUser(operator);
    app = await createApp({ store, config: getApiConfig({ SPACE_LOG_LEVEL: "silent" }), auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  it("needs the in-process secret and a live session", async () => {
    expect(code(await app.inject({ method: "GET", url: "/api/nous", headers: phone(["read"], { invoke: null }) }))).toBe("MOBILE_INVOKE");
    expect(code(await app.inject({ method: "GET", url: "/api/nous", headers: phone(["read"], { invoke: "guess" }) }))).toBe("MOBILE_INVOKE");
    expect(GATE_CODES).not.toContain(code(await app.inject({ method: "GET", url: "/api/nous", headers: phone(["read"]) })));
    expect(code(await app.inject({ method: "GET", url: "/api/nous", headers: phone(["read"], { nowMs: Date.now() - 2 * 3600_000 }) }))).toBe("MOBILE_SESSION");
    // Revoking the device revokes its session id, and with it every channel session minted from it.
    const sid = randomBytes(32).toString("hex");
    defaultSessionRevocationStore.revokeSessionHash(sessionIdHash(sid), Date.now() + 3600_000);
    expect(code(await app.inject({ method: "GET", url: "/api/nous", headers: phone(["read"], { sid }) }))).toBe("MOBILE_SESSION");
  });

  // CODE-2 (MASVS L2, plan clipboard:kTV3y2lwO-99 step 7): an app session whose X-Space-Client names a Nous app below the floor gets 426,
  // except the routes its own update needs; the phone channel and the Google device session alike, never a web session.
  it("answers 426 to a Nous app below the update floor, except its update and sign-in routes", async () => {
    const old = { "x-space-client": "app=NOUS_ANDROID; v=0.2.21; os=android; form=PHONE" };
    const response = await app.inject({ method: "GET", url: "/api/nous", headers: { ...phone(["read"]), ...old } });
    expect(response.statusCode).toBe(426);
    expect(JSON.parse(response.body).error).toMatchObject({ code: "APP_UPDATE_REQUIRED", details: { minVersion: "0.2.22", minVersionCode: 222 } });
    expect(code(await app.inject({ method: "GET", url: "/api/artifacts/artifact:x/file", headers: { ...phone(["read"]), ...old } }))).not.toBe("APP_UPDATE_REQUIRED");
    expect(code(await app.inject({ method: "GET", url: "/api/nous", headers: { ...phone(["read"]), "x-space-client": "app=NOUS_ANDROID; v=0.2.22" } }))).not.toBe("APP_UPDATE_REQUIRED");
    expect(code(await app.inject({ method: "GET", url: "/api/nous", headers: phone(["read"]) }))).not.toBe("APP_UPDATE_REQUIRED");
    const device = signSession(operator, secret, Date.now(), { sid: randomBytes(32).toString("hex"), app: "nous" });
    expect(code(await app.inject({ method: "GET", url: "/api/nous", headers: { cookie: `${cookieName}=${device}`, ...old } }))).toBe("APP_UPDATE_REQUIRED");
    expect(code(await app.inject({ method: "GET", url: "/api/auth/devices", headers: { cookie: `${cookieName}=${device}`, ...old } }))).not.toBe("APP_UPDATE_REQUIRED");
    const web = signSession(operator, secret);
    expect(code(await app.inject({ method: "GET", url: "/api/nous", headers: { cookie: `${cookieName}=${web}`, ...old } }))).not.toBe("APP_UPDATE_REQUIRED");
  });

  it("allows a scope's routes only, query rules on the parsed query, body rules on the parsed body", async () => {
    expect(code(await app.inject({ method: "POST", url: "/api/nous/messages", headers: phone(["read"]), payload: { content: "hi" } }))).toBe("MOBILE_SCOPE_DENIED");
    expect(GATE_CODES).not.toContain(code(await app.inject({ method: "GET", url: "/api/clipboard-items?source=PLAN", headers: phone(["read"]) })));
    expect(code(await app.inject({ method: "GET", url: "/api/clipboard-items?source=COPY", headers: phone(["read"]) }))).toBe("MOBILE_SCOPE_DENIED");
    expect(code(await app.inject({ method: "GET", url: "/api/clipboard-items?source=PLAN&source=COPY", headers: phone(["read"]) }))).toBe("MOBILE_SCOPE_DENIED");
    expect(code(await app.inject({ method: "GET", url: "/api/user-settings", headers: phone(["read", "act", "decide"]) }))).toBe("MOBILE_SCOPE_DENIED");
    expect(code(await app.inject({ method: "PATCH", url: "/api/nous/settings", headers: phone(["read", "act"]), payload: { enabled: false, mayPromote: true } }))).toBe("MOBILE_BODY");
    expect(GATE_CODES).not.toContain(code(await app.inject({ method: "PATCH", url: "/api/nous/settings", headers: phone(["read", "act"]), payload: { dockTabs: { done: false } } })));
    expect(code(await app.inject({ method: "POST", url: "/api/notifications/notif:x/answer", headers: phone(["read", "act"]), payload: { option: "A", always: true } }))).toBe("MOBILE_BODY");
    expect(code(await app.inject({ method: "POST", url: "/api/nous/away", headers: phone(["read", "act"]), payload: { grant: ["PROMOTE"] } }))).toBe("MOBILE_BODY");
    // Operator 6/11 (nous_msg:781819c5): the Nous app reads token usage and signatures; saving or signing needs act.
    for (const url of ["/api/nous/token-usage?period=week", "/api/signatures", "/api/signatures/sig:x/image", "/api/signature-requests?status=PENDING"]) {
      expect(GATE_CODES, url).not.toContain(code(await app.inject({ method: "GET", url, headers: phone(["read"]) })));
    }
    expect(code(await app.inject({ method: "POST", url: "/api/signatures", headers: phone(["read"]), payload: {} }))).toBe("MOBILE_SCOPE_DENIED");
    expect(code(await app.inject({ method: "POST", url: "/api/signature-requests/sigreq:x/sign", headers: phone(["read"]), payload: {} }))).toBe("MOBILE_SCOPE_DENIED");
    expect(GATE_CODES).not.toContain(code(await app.inject({ method: "POST", url: "/api/signature-requests/sigreq:x/sign", headers: phone(["read", "act"]), payload: {} })));
  });

  it("lists the operator's saved signatures to his phone (6/11: the 0.2.27 proof read [] through a UI_PROOF session, which gets none by design)", async () => {
    const web = signSession(operator, secret);
    const onePixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const saved = await app.inject({ method: "POST", url: "/api/signatures", headers: { cookie: `${cookieName}=${web}`, "x-space-csrf-token": createCsrfToken(web, secret)! },
      payload: { png: onePixel, label: "From the computer" } });
    expect(saved.statusCode, saved.body).toBe(200);
    const listed = (await app.inject({ method: "GET", url: "/api/signatures", headers: phone(["read"]) })).json() as { signatures: Array<{ label: string; isDefault: boolean }> };
    expect(listed.signatures).toContainEqual(expect.objectContaining({ label: "From the computer", isDefault: true }));
  });

  // C4 (internal MASVS review 1/11): every phone reaches the API from its channel's peer address, so the limit counts each device on its own.
  it("counts a phone's requests per device, apart from the address it shares", async () => {
    const store = new InMemorySpaceStore();
    await store.upsertUser(operator);
    const limited = await createApp({ store, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_API_RATE_LIMIT_MAX: "2" }), auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
    try {
      await limited.ready();
      const status = async (device?: string) => (await limited.inject({ method: "GET", url: "/api/nous",
        headers: device ? phone(["read"], { device, app: limited }) : { cookie: "" } })).statusCode;
      const first = [await status("appdev:phoneA"), await status("appdev:phoneA"), await status("appdev:phoneA")];
      expect(first.slice(0, 2)).not.toContain(429);
      expect(first[2]).toBe(429);
      expect(await status("appdev:phoneB")).not.toBe(429);
      expect(await status()).not.toBe(429);
    } finally { await limited.close(); }
  });

  // Nous Pro step 7 (plan clipboard:kTV3y2lwO-99): the gate ran the checks only for artifact, ask and decision rules, so a goal's delete (C9)
  // reached its handler with no signature.
  it("runs the goal delete's signature check", async () => {
    const store = new InMemorySpaceStore();
    await store.upsertUser(operator);
    const gated = await createApp({ store, config: getApiConfig({ SPACE_LOG_LEVEL: "silent" }), auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
    try {
      await gated.ready();
      const key = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const devices = new InMemoryAppDeviceSessionRepository();
      await devices.createPaired({ id: "appdev:phone1", ownerUserId: operator.id, app: "nous", deviceName: "Pixel", sidSha256: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z",
        noisePublic: "n".repeat(43), decidePublicSpki: key.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
        decideSecurityLevel: "TRUSTED_ENVIRONMENT", requestedScopes: ["read", "act", "decide"] });
      const goal = { id: "nous_goal:abc123", text: "Ship Nous Pro." };
      setMobileChecks(gated, createMobileChecks({ devices, artifact: async () => { throw new Error("unused"); }, notification: async () => null,
        decision: async () => null, goal: async (_owner, id) => (id === goal.id ? goal : null) }));
      const remove = (sig?: string) => gated.inject({ method: "DELETE", url: `/api/nous/goals/${goal.id}`,
        headers: { ...phone(["read", "act", "decide"], { device: "appdev:phone1", app: gated }), ...(sig ? { [MOBILE_SIG_HEADER]: sig } : {}) } });
      expect(code(await remove())).toBe("DECIDE_SIGNATURE");
      const sig = sign("sha256", mobileAnswerSigningInput("goal-delete", goal.id, mobileGoalContentHash(goal), "delete"), { key: key.privateKey, dsaEncoding: "der" }).toString("base64url");
      const passed = await remove(sig);
      expect([...GATE_CODES, "DECIDE_SIGNATURE", "MOBILE_DECIDE_REQUIRED"]).not.toContain(code(passed));
      expect(passed.statusCode).toBe(404); // the handler ran: no such goal in this store
    } finally { await gated.close(); }
  });

  // Nous settings' ops in the Nous app (operator nous_msg:7f3a38f5): a paired ADMIN phone with decide and the signature reaches the op's own
  // handler; no signature, act only or a non-ADMIN account stops at the gate. Dev config: promote answers 409 there, so no queue runs.
  it("lets a paired ADMIN phone run an ADMIN op only with the decide signature", async () => {
    const store = new InMemorySpaceStore(), member = { id: "user:member", email: "member@example.test", role: "USER" as const };
    await store.upsertUser(operator);
    await store.upsertUser(member);
    const gated = await createApp({ store, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_INSTANCE: "dev" }), auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
    try {
      await gated.ready();
      const key = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const devices = new InMemoryAppDeviceSessionRepository();
      for (const [id, owner] of [["appdev:phone1", operator.id], ["appdev:phone2", member.id]]) {
        await devices.createPaired({ id: id!, ownerUserId: owner!, app: "nous", deviceName: "Pixel", sidSha256: id!.slice(-1).repeat(64), expiresAt: "2099-01-01T00:00:00.000Z",
          noisePublic: id!.slice(-1).repeat(43), decidePublicSpki: key.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
          decideSecurityLevel: "TRUSTED_ENVIRONMENT", requestedScopes: ["read", "act", "decide"] });
      }
      setMobileChecks(gated, createMobileChecks({ devices, artifact: async () => { throw new Error("unused"); }, notification: async () => null,
        decision: async () => null, goal: async () => null }));
      const restart = { service: "browser-host" };
      const call = (url: string, payload: object | undefined, scopes: string[], withSig: boolean, device = "appdev:phone1", user = operator) => {
        const token = signMobileSession(user, secret, { sid: randomBytes(32).toString("hex"), app: "nous", device, scopes });
        const sig = sign("sha256", mobileAdminOpSigningInput("POST", url, payload ?? null), { key: key.privateKey, dsaEncoding: "der" }).toString("base64url");
        return gated.inject({ method: "POST", url, ...(payload ? { payload } : {}), headers: { cookie: `${cookieName}=${token}`,
          "x-space-csrf-token": createCsrfToken(token, secret)!, [MOBILE_INVOKE_HEADER]: mobileInvokeSecret(gated)!, ...(withSig ? { [MOBILE_SIG_HEADER]: sig } : {}) } });
      };
      const promote = (scopes: string[], withSig: boolean, device?: string, user?: typeof operator) => call("/api/admin/releases/promote", undefined, scopes, withSig, device, user);
      expect(code(await promote(["read", "act", "decide"], false))).toBe("DECIDE_SIGNATURE");
      expect(code(await promote(["read", "act"], true))).toBe("MOBILE_SCOPE_DENIED");
      expect(code(await promote(["read", "act", "decide"], true, "appdev:phone2", member as never))).toBe("ADMIN_REQUIRED");
      const passed = await promote(["read", "act", "decide"], true);
      expect(passed.statusCode).toBe(409); // the handler ran, past its own person check: dev does not manage releases
      expect(code(passed)).toBe("RELEASE_ACTION_FAILED");
      // Nous settings' server ops: the same bar, the body signed too; dev answers NOT_MANAGED_HERE, so nothing runs.
      expect(code(await call("/api/admin/server-ops/restart", restart, ["read", "act", "decide"], false))).toBe("DECIDE_SIGNATURE");
      expect(code(await call("/api/admin/server-ops/restart", restart, ["read", "act", "decide"], true, "appdev:phone2", member as never))).toBe("ADMIN_REQUIRED");
      expect(code(await call("/api/admin/server-ops/restart", restart, ["read", "act", "decide"], true))).toBe("NOT_MANAGED_HERE");
    } finally { await gated.close(); }
  });

  it("a phone is the operator in person only where its route says so", () => {
    expect(isOperatorPerson({ ...operator, mobile: { device: "appdev:x", person: false } })).toBe(false);
    expect(isOperatorPerson({ ...operator, mobile: { device: "appdev:x", person: true } })).toBe(true);
    expect(isOperatorPerson(operator)).toBe(true);
  });

  it("refuses every registered route the allowlist does not name, whatever the scopes (plugin routes too)", async () => {
    const all = phone(["read", "act", "decide", "admin"]);
    const missed: string[] = [];
    // printRoutes names a shared path segment's parameter after the first route that registered it (:roomId for /api/rooms/:id/agent-files/chunks).
    const shape = (route: string) => route.replace(/:[A-Za-z0-9_]+/g, ":");
    const allowed = new Set(Object.keys(MOBILE_ROUTE_SCOPES).map(shape));
    for (const route of registeredRoutes(app.printRoutes({ commonPrefix: false }))) {
      if (allowed.has(shape(route))) continue;
      const [method, path] = route.split(" ") as [string, string];
      const url = path.replace(/:[A-Za-z0-9_]+/g, "x").replace(/\*/g, "x");
      const body = method === "GET" || method === "DELETE" ? {} : { payload: {} };
      const response = await app.inject({ method: method as "GET", url, headers: all, ...body });
      if (code(response) !== "MOBILE_SCOPE_DENIED") missed.push(`${route} ${response.statusCode}`);
    }
    expect(missed).toEqual([]);
  }, 600_000);
});
