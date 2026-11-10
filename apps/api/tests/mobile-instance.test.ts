import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMobilePairQr, mobileInstanceFingerprint, noiseKeyPair, vaultBase64url, verifyMobileRotation } from "@space/contracts";
import { InMemoryMobileInstanceKeyRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, hashPassword, signSession, signSessionWithTtl } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { createConnectorCrypto } from "../src/dot-connectors.js";
import { createMobileInstanceKeys } from "../src/mobile/instance-key.js";
import { createMobileOffers, MOBILE_OFFER_TTL_MS } from "../src/mobile/pairing.js";

// Nous Pro 1b-3 (plan clipboard:kTV3y2lwO-99, ADR-013 §2-3, design §1-2, security review P1-5, P2-2, P2-4): the installation's mobile channel
// keys, the step-up (a fresh Google sign-in of the person's own account) and the pairing offers it unlocks.
const secret = "mobile-instance-test-secret-1234567890";
const clientId = "mobile-step-up-client";
const FP = /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}$/;
type Offer = Exclude<ReturnType<ReturnType<typeof createMobileOffers>["create"]>, { refused: unknown }>;

describe("mobile instance keys", () => {
  it("seal, open, and rotate with a statement the pinned identity key verifies; a compromise signs nothing", async () => {
    const repository = new InMemoryMobileInstanceKeyRepository();
    const keys = createMobileInstanceKeys({ repository, crypto: createConnectorCrypto({ key: "k".repeat(40), legacySecrets: [] }) });
    expect(await keys.status()).toEqual({ configured: false });
    const first = await keys.setUp();
    expect(first).toMatchObject({ created: true, fingerprint: expect.stringMatching(FP) });
    expect(await keys.setUp()).toEqual({ created: false, fingerprint: first.fingerprint });
    const stored = (await repository.active())!;
    expect(stored.sealedPrivate).not.toContain(stored.noisePublic);
    const opened = keys.open(stored);
    expect(vaultBase64url.encode(noiseKeyPair(opened.noise.privateKey).publicKey)).toBe(stored.noisePublic);
    expect(mobileInstanceFingerprint(opened.noise.publicKey, opened.identity.publicKey)).toBe(first.fingerprint);

    const routine = await keys.rotate(false);
    expect(routine.oldFingerprint).toBe(first.fingerprint);
    const next = (await repository.active())!;
    const { statement, signature } = JSON.parse(next.rotationStatement!);
    expect(statement).toMatchObject({ v: 1, oldFp: first.fingerprint, newIS: next.noisePublic, newII: next.identityPublic });
    expect(verifyMobileRotation(statement, signature, opened.identity.publicKey)).toBe(true);
    expect(verifyMobileRotation(statement, signature, keys.open(next).identity.publicKey)).toBe(false);
    expect((await keys.status()).retiring).toEqual([{ fingerprint: first.fingerprint, until: expect.any(String) }]);

    await keys.rotate(true);
    expect((await repository.active())!.rotationStatement).toBeNull();
    expect((await keys.status()).retiring).toEqual([]);
    // Another connector key cannot open the pair (a restore without the key file): the channel sees the red screen, never wrong keys.
    const other = createMobileInstanceKeys({ repository, crypto: createConnectorCrypto({ key: "x".repeat(40), legacySecrets: [] }) });
    const latest = (await repository.active())!;
    expect(() => other.open(latest)).toThrow();
  });
});

describe("pairing offers", () => {
  it("live 120 s, 3 per owner, claimed once and synchronously, locked after 5 failures; only the owner cancels", () => {
    let now = 1_000_000;
    const offers = createMobileOffers(() => now);
    const first = offers.create("user:a", ["read"]) as Offer;
    expect(first.code).toHaveLength(16);
    expect(first.offerId).toHaveLength(8);
    offers.create("user:a", ["read"]); offers.create("user:a", ["read"]);
    expect(offers.create("user:a", ["read"])).toEqual({ refused: "LIVE_OFFERS" });
    expect(offers.create("user:b", ["read"])).not.toHaveProperty("refused");
    expect(offers.claim(first.offerId)).toMatchObject({ owner: "user:a" });
    expect(offers.claim(first.offerId)).toBeNull();
    const second = offers.create("user:a", ["read"]) as Offer;
    expect(offers.cancel("user:b", Buffer.from(second.offerId).toString("base64url"))).toBe(false);
    expect(offers.cancel("user:a", Buffer.from(second.offerId).toString("base64url"))).toBe(true);
    const late = offers.create("user:c", ["read"]) as Offer;
    now += MOBILE_OFFER_TTL_MS;
    expect(offers.claim(late.offerId)).toBeNull();
    for (let n = 0; n < 5; n++) offers.failed("user:d");
    expect(offers.create("user:d", ["read"])).toEqual({ refused: "LOCKED" });
    now += 15 * 60_000 + 1;
    expect(offers.create("user:d", ["read"])).not.toHaveProperty("refused");
  });

  it("demo mode's standing offer: one per UTC day, claimed by every phone, accepted 120 s past midnight, never counted as a live offer", () => {
    const day = 24 * 3600_000;
    let now = 20_000 * day + day - 60_000;
    const offers = createMobileOffers(() => now);
    const today = offers.demo("user:a", "SpaceApp demo");
    expect(today).toMatchObject({ standing: true, rid: null, expiresAt: 20_001 * day + MOBILE_OFFER_TTL_MS });
    expect(offers.demo("user:a", "SpaceApp demo")).toBe(today);
    expect(offers.claim(today.offerId)).toBe(today);
    expect(offers.claim(today.offerId)).toBe(today);
    for (let n = 0; n < 3; n++) expect(offers.create("user:a", ["read"])).not.toHaveProperty("refused");
    now += 2 * 60_000;
    const tomorrow = offers.demo("user:a", "SpaceApp demo");
    expect(tomorrow.code).not.toEqual(today.code);
    expect(offers.claim(today.offerId)).toBe(today);
    now += MOBILE_OFFER_TTL_MS;
    expect(offers.claim(today.offerId)).toBeNull();
    expect(offers.claim(tomorrow.offerId)).toBe(tomorrow);
  });
});

describe("Settings > Mobile app routes", () => {
  const dir = mkdtempSync(join(tmpdir(), "space-mobile-instance-"));
  const keyFile = join(dir, "connector.key");
  writeFileSync(keyFile, "c".repeat(48));
  const googleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = { keys: [{ ...googleKey.publicKey.export({ format: "jwk" }), kid: "step-kid", alg: "RS256", use: "sig" }] };
  const operator = { id: "user:operator", email: "operator@example.test", role: "ADMIN" as const };
  const store = new InMemorySpaceStore();
  let app: Awaited<ReturnType<typeof createApp>>;
  let bare: Awaited<ReturnType<typeof createApp>>;
  const as = (token: string) => ({ cookie: `${cookieName}=${token}`, "x-space-csrf-token": createCsrfToken(token, secret)! });
  const person = as(signSession(operator, secret));
  const phone = as(signSession(operator, secret, Date.now(), { app: "nous" }));
  // A UI_PROOF broker session: refused by uiProofDeniedRoutes ("* /api/mobile") before the route's own person check.
  const proof = as(signSessionWithTtl({ id: "user:operator-proof", email: "proof@example.test", role: "ADMIN", brokerScope: "UI_PROOF" }, secret, 60));
  /** A Google ID token for `sub`; `nonce` is the auth request's (a step-up's own), `iat` when Google issued it (default now). */
  function google(sub: string, authTime: number | null, issued: { nonce?: string; iat?: number } = {}) {
    const claims = { sub, email: `${sub}@example.test`, aud: clientId, iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 600, email_verified: true,
      iat: issued.iat ?? Math.floor(Date.now() / 1000), ...(issued.nonce === undefined ? {} : { nonce: issued.nonce }), ...(authTime === null ? {} : { auth_time: authTime }) };
    const body = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "step-kid", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    const token = `${body}.${createSign("RSA-SHA256").update(body).sign(googleKey.privateKey).toString("base64url")}`;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ id_token: token });
      if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json(jwks, { headers: { "cache-control": "public, max-age=3600" } });
      throw Error("Unexpected external request in the step-up test");
    }));
    return token;
  }
  /**
   * Starts the step-up as `headers` on `target`, answers it as Google account `sub`, and returns where the callback sends the browser.
   * The ID token carries the step-up's own nonce unless `token.nonce` names another (null: none, as an older sign-in's token).
   */
  async function stepUp(headers: Record<string, string>, sub = "google-operator", authTime: number | null = Math.floor(Date.now() / 1000),
    callbackHeaders = headers, target = app, token: { nonce?: string | null; iat?: number } = {}) {
    const start = await target.inject({ method: "GET", url: "/api/auth/google/start?stepUp=mobile&json=true", headers });
    if (start.statusCode !== 200) return { status: start.statusCode, location: "" };
    const authUrl = new URL(start.json().authUrl);
    expect(authUrl.searchParams.get("prompt")).toBe("login");
    expect(authUrl.searchParams.get("max_age")).toBe("0");
    expect(JSON.parse(authUrl.searchParams.get("claims")!)).toEqual({ id_token: { auth_time: { essential: true } } });
    expect(authUrl.searchParams.get("login_hint")).toBe(operator.email);
    const nonce = authUrl.searchParams.get("nonce")!;
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    const cookies = start.cookies.filter((cookie) => cookie.value).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    google(sub, authTime, { nonce: token.nonce === undefined ? nonce : token.nonce ?? undefined, iat: token.iat });
    const callback = await target.inject({ method: "GET", url: `/api/auth/google/callback?code=c&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`,
      headers: { cookie: `${callbackHeaders.cookie}; ${cookies}` } });
    return { status: callback.statusCode, location: String(callback.headers.location ?? "") };
  }
  beforeAll(async () => {
    const auth = { sessionSecret: secret, devLogin: false, secureCookies: false, googleClientId: clientId };
    await store.upsertUser(operator);
    await store.linkGoogleAccount(operator.id, { sub: "google-operator", email: "operator@example.test" });
    await store.upsertUser({ id: "user:other", email: "other@example.test", role: "USER" });
    await store.linkGoogleAccount("user:other", { sub: "google-other", email: "other@example.test" });
    app = await createApp({ store, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile }), auth });
    bare = await createApp({ store, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: join(dir, "missing.key") }), auth });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => { await app?.close(); await bare?.close(); });

  it("a phone, a proof session and no session cannot set up, rotate, step up or pair", async () => {
    expect((await app.inject({ method: "GET", url: "/api/mobile/instance" })).statusCode).toBe(401);
    for (const headers of [phone, proof]) {
      for (const [method, url] of [["GET", "/api/mobile/instance"], ["POST", "/api/mobile/instance"], ["POST", "/api/mobile/rotate"], ["POST", "/api/mobile/pairing"]] as const) {
        expect((await app.inject({ method, url, headers, ...(method === "POST" ? { payload: {} } : {}) })).statusCode, url).toBe(403);
      }
      expect((await stepUp(headers)).status).toBe(403);
    }
  });

  it("the step-up takes a fresh sign-in of the person's own Google account, in the same session", async () => {
    expect((await app.inject({ method: "POST", url: "/api/mobile/instance", headers: person, payload: {} })).json())
      .toMatchObject({ error: { code: "STEP_UP_REQUIRED", details: { stepUpUrl: "/api/auth/google/start?stepUp=mobile" } } });
    expect((await stepUp(person, "google-other")).location).toMatch(/mobileStepUpError=/);
    expect((await stepUp(person, "google-operator", Math.floor(Date.now() / 1000) - 301)).location).toMatch(/mobileStepUpError=/);
    expect((await stepUp(person, "google-operator", null, person, app, { nonce: null })).location).toMatch(/mobileStepUpError=/);
    const otherSession = as(signSession(operator, secret, Date.now() - 1000));
    expect((await stepUp(person, "google-operator", Math.floor(Date.now() / 1000), otherSession)).location).toMatch(/mobileStepUpError=/);
    expect((await app.inject({ method: "POST", url: "/api/mobile/instance", headers: person, payload: {} })).statusCode).toBe(401);
    expect(await stepUp(person)).toEqual({ status: 302, location: "/?mobileStepUp=ok" });
    // The mark is this session's only.
    expect((await app.inject({ method: "POST", url: "/api/mobile/instance", headers: otherSession, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/mobile/instance", headers: person, payload: {} })).json()).toMatchObject({ configured: true });
  });

  it("the password step-up takes the person's own SpaceApp password, marks only this web session and is refused to a phone or proof session", async () => {
    // ADR-013's open item: an install without Google sign-in (or a Google ID token without auth_time) confirms with the password.
    const owned = new InMemorySpaceStore();
    owned.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" });
    const owner = owned.claimOwnerSetup({ tokenHash: "a".repeat(64), email: "owner@example.test", passwordHash: await hashPassword("right horse battery"), now: new Date().toISOString() }).user;
    await owned.upsertUser({ id: "user:other", email: "other@example.test", role: "USER" });
    const local = await createApp({ store: owned, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile }), auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
    try {
      const web = as(signSession(owner, secret)), otherSession = as(signSession(owner, secret, Date.now() - 1000));
      const confirm = (headers: Record<string, string>, password: string) => local.inject({ method: "POST", url: "/api/auth/step-up/password", headers, payload: { password } });
      expect((await local.inject({ method: "POST", url: "/api/mobile/instance", headers: web, payload: {} })).json())
        .toMatchObject({ error: { code: "STEP_UP_REQUIRED", details: { passwordUrl: "/api/auth/step-up/password" } } });
      expect((await confirm(web, "wrong")).json()).toMatchObject({ error: { code: "STEP_UP_FAILED" } });
      // Another user's session with the owner's password, a phone and a proof session get no mark.
      expect((await confirm(as(signSession({ id: "user:other", email: "other@example.test", role: "USER" }, secret)), "right horse battery")).statusCode).toBe(403);
      expect((await confirm(as(signSession(owner, secret, Date.now(), { app: "nous" })), "right horse battery")).statusCode).toBe(403);
      expect((await confirm(proof, "right horse battery")).statusCode).toBe(403);
      expect((await local.inject({ method: "POST", url: "/api/mobile/instance", headers: web, payload: {} })).statusCode).toBe(401);
      expect((await confirm(web, "right horse battery")).json()).toMatchObject({ steppedUp: true });
      expect((await local.inject({ method: "POST", url: "/api/mobile/instance", headers: otherSession, payload: {} })).statusCode).toBe(401);
      expect((await local.inject({ method: "POST", url: "/api/mobile/instance", headers: web, payload: {} })).json()).toMatchObject({ configured: true });
      const audit = (await owned.listAuditEvents()).filter((event) => event.action.startsWith("auth.step_up"));
      expect(audit.map((event) => event.action)).toContain("auth.step_up");
      expect(JSON.stringify(audit)).not.toContain("right horse battery");
    } finally { await local.close(); }
  });

  it("the password step-up takes the .env operator password that login accepts on an install with no owner row", async () => {
    // Stable 7/11: login took the SPACE_OPERATOR_PASSWORD_HASH password, the step-up answered STEP_UP_FAILED to it.
    const local = await createApp({ store: new InMemorySpaceStore(), config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile }),
      auth: { sessionSecret: secret, devLogin: false, secureCookies: false, operatorEmail: operator.email, operatorPasswordHash: await hashPassword("env operator words") } });
    try {
      const web = as(signSession(operator, secret));
      const confirm = (headers: Record<string, string>, password: string) => local.inject({ method: "POST", url: "/api/auth/step-up/password", headers, payload: { password } });
      expect((await local.inject({ method: "POST", url: "/api/auth/login", payload: { email: operator.email, password: "env operator words" } })).statusCode).toBe(200);
      expect((await confirm(web, "wrong")).json()).toMatchObject({ error: { code: "STEP_UP_FAILED" } });
      expect((await confirm(as(signSession({ id: "user:other", email: operator.email, role: "ADMIN" }, secret)), "env operator words")).statusCode).toBe(403);
      expect((await confirm(web, "env operator words")).json()).toMatchObject({ steppedUp: true });
      expect((await local.inject({ method: "POST", url: "/api/mobile/instance", headers: web, payload: {} })).json()).toMatchObject({ configured: true });
    } finally { await local.close(); }
  });

  it("the .env operator's password steps up the users row login signs them in as, whose id is not user:operator", async () => {
    // Stable 7/11 after 0b39425635: login (upsertUser by email) and the Google sign-in give the operator's own row; the step-up wanted "user:operator".
    const rows = new InMemorySpaceStore();
    const row = await rows.upsertUser({ id: "user:operator-row", email: operator.email.toUpperCase(), role: "ADMIN" });
    const local = await createApp({ store: rows, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile }),
      auth: { sessionSecret: secret, devLogin: false, secureCookies: false, operatorEmail: operator.email, operatorPasswordHash: await hashPassword("env operator words") } });
    try {
      const login = await local.inject({ method: "POST", url: "/api/auth/login", payload: { email: operator.email, password: "env operator words" } });
      expect(login.json().user.id).toBe(row.id);
      const confirm = (user: typeof operator, password: string) =>
        local.inject({ method: "POST", url: "/api/auth/step-up/password", headers: as(signSession(user, secret)), payload: { password } });
      expect((await confirm({ ...row, role: "ADMIN" }, "wrong")).json()).toMatchObject({ error: { code: "STEP_UP_FAILED" } });
      // A session of another id with the operator's email is not the row login gives.
      expect((await confirm({ ...operator, id: "user:stale" }, "env operator words")).statusCode).toBe(403);
      expect((await confirm({ ...row, role: "ADMIN" }, "env operator words")).json()).toMatchObject({ steppedUp: true });
      expect((await rows.listAuditEvents()).filter((event) => event.action.startsWith("auth.step_up")).map((event) => event.action))
        .toEqual(expect.arrayContaining(["auth.step_up_failed", "auth.step_up"]));
    } finally { await local.close(); }
  });

  it("set up, rotate and pair: the QR pins the instance keys and carries the code only in the answer", async () => {
    expect((await stepUp(person)).location).toBe("/?mobileStepUp=ok");
    const created = await app.inject({ method: "POST", url: "/api/mobile/instance", headers: person, payload: {} });
    expect(created.json()).toMatchObject({ configured: true, fingerprint: expect.stringMatching(FP) });
    expect(created.body).not.toMatch(/sealed|private/i);
    expect((await app.inject({ method: "POST", url: "/api/mobile/rotate", headers: person, payload: { compromised: "yes" } })).statusCode).toBe(400);
    const rotated = (await app.inject({ method: "POST", url: "/api/mobile/rotate", headers: person, payload: {} })).json();
    expect(rotated.retiring).toEqual([{ fingerprint: created.json().fingerprint, until: expect.any(String) }]);

    expect((await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: person, payload: { scopes: ["admin"] } })).statusCode).toBe(400);
    const offer = (await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: person, payload: {} })).json();
    expect(offer).toMatchObject({ scopes: ["read", "act", "decide"], fingerprint: rotated.fingerprint });
    const qr = decodeMobilePairQr(offer.qr, Math.floor(Date.now() / 1000));
    expect(qr).toMatchObject({ o: offer.offerId, u: ["http://localhost"], r: null, n: "SpaceApp localhost" });
    expect(mobileInstanceFingerprint(vaultBase64url.decode(qr.k), vaultBase64url.decode(qr.i))).toBe(rotated.fingerprint);
    const audit = (await store.listAuditEvents()).filter((event) => event.action === "mobile.pairing.offered");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(qr.c);
    expect((await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: person, payload: { scopes: ["read"] } })).json().scopes).toEqual(["read"]);
    await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: person, payload: {} });
    expect((await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: person, payload: {} })).json()).toMatchObject({ error: { code: "MOBILE_OFFERS_LIMIT" } });
    expect((await app.inject({ method: "DELETE", url: `/api/mobile/pairing/${offer.offerId}`, headers: person })).json()).toEqual({ cancelled: true });
    const plainHttp = { ...person, "x-forwarded-proto": "http", "x-forwarded-host": "space.example.com" };
    // Nous Pro phase 2b: no relay configured here, so a relay offer is refused and the direct route needs the instance's https origin.
    expect((await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: person, payload: { transport: "RELAY" } })).json()).toMatchObject({ error: { code: "MOBILE_RELAY_OFF" } });
    expect((await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: plainHttp, payload: {} })).json()).toMatchObject({ error: { code: "MOBILE_ORIGIN" } });
    expect((await app.inject({ method: "POST", url: "/api/mobile/rotate", headers: person, payload: { compromised: true } })).json().retiring).toEqual([]);
  });

  it("an ADMIN SpaceApp Android session sets up and pairs after an in-app step-up of its own Google account (R10, SpaceApp Android 0.2.13)", async () => {
    const spaceapp = as(signSession(operator, secret, Date.now(), { app: "spaceapp" }));
    const otherPhone = as(signSession(operator, secret, Date.now() - 1000, { app: "spaceapp" }));
    const userPhone = as(signSession({ id: "user:other", email: "other@example.test", role: "USER" }, secret, Date.now(), { app: "spaceapp" }));
    const appStepUp = (headers: Record<string, string>, idToken: string) => app.inject({ method: "POST", url: "/api/auth/app/step-up", headers, payload: { idToken } });
    const now = () => Math.floor(Date.now() / 1000);
    expect((await app.inject({ method: "GET", url: "/api/mobile/instance", headers: spaceapp })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: spaceapp, payload: {} })).json())
      .toMatchObject({ error: { code: "STEP_UP_REQUIRED", details: { stepUpUrl: "/api/auth/app/step-up" } } });
    expect((await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: spaceapp, payload: {} })).statusCode).toBe(403);
    // Not the operator's Google account, an old sign-in, no sign-in time, a phone that is not SpaceApp Android: no mark.
    expect((await appStepUp(spaceapp, google("google-other", now()))).statusCode).toBe(403);
    expect((await appStepUp(spaceapp, google("google-operator", now() - 301))).statusCode).toBe(403);
    expect((await appStepUp(spaceapp, google("google-operator", null))).statusCode).toBe(403);
    expect((await appStepUp(phone, google("google-operator", now()))).statusCode).toBe(403);
    expect((await appStepUp(person, google("google-operator", now()))).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: spaceapp, payload: {} })).statusCode).toBe(403);
    expect((await appStepUp(spaceapp, google("google-operator", now()))).json()).toMatchObject({ steppedUp: true });
    // The mark is this session's only.
    expect((await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: otherPhone, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/mobile/instance", headers: spaceapp, payload: {} })).json()).toMatchObject({ configured: true });
    const offer = await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: spaceapp, payload: {} });
    expect(offer.statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/mobile/pairing/${offer.json().offerId}`, headers: spaceapp })).json()).toEqual({ cancelled: true });
    expect((await app.inject({ method: "POST", url: "/api/mobile/rotate", headers: spaceapp, payload: {} })).statusCode).toBe(200);
    // A non-admin SpaceApp Android session: never a step-up, and the four routes refuse it as they refuse that user on the web.
    expect((await appStepUp(userPhone, google("google-other", now()))).statusCode).toBe(403);
    const userWeb = as(signSession({ id: "user:other", email: "other@example.test", role: "USER" }, secret));
    for (const [method, url] of [["GET", "/api/mobile/instance"], ["POST", "/api/mobile/instance"], ["POST", "/api/mobile/rotate"], ["POST", "/api/mobile/pairing"]] as const) {
      const call = (headers: Record<string, string>) => app.inject({ method, url, headers, ...(method === "POST" ? { payload: {} } : {}) });
      const refused = (await call(userPhone)).statusCode;
      expect([403, 404], url).toContain(refused);
      expect(refused, url).toBe((await call(userWeb)).statusCode);
    }
    expect((await store.listAuditEvents()).find((event) => event.action === "auth.step_up" && event.metadata?.via === "spaceapp")).toMatchObject({ metadata: { purpose: "mobile", via: "spaceapp" } });
  });

  it("a SpaceApp Android session steps up in the phone's system browser with a one-time ticket (R10b)", async () => {
    const spaceapp = as(signSession(operator, secret, Date.now() - 5000, { app: "spaceapp" }));
    const otherPhone = as(signSession(operator, secret, Date.now() - 6000, { app: "spaceapp" }));
    const userPhone = as(signSession({ id: "user:other", email: "other@example.test", role: "USER" }, secret, Date.now(), { app: "spaceapp" }));
    const state = "phone-state-0123456789";
    const begin = (headers: Record<string, string>, body: unknown = { state }) => app.inject({ method: "POST", url: "/api/auth/app/step-up/start", headers, payload: body as object });
    const pairing = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/api/mobile/pairing", headers, payload: {} });
    // The system browser has no SpaceApp session: only the start and callback cookies travel between the two.
    async function browser(url: string, sub: string, authTime = Math.floor(Date.now() / 1000), cookies = true) {
      const start = await app.inject({ method: "GET", url: `${url}&json=true` });
      if (start.statusCode !== 200) return { status: start.statusCode, location: "" };
      const authUrl = new URL(start.json().authUrl);
      expect([authUrl.searchParams.get("prompt"), authUrl.searchParams.get("max_age"), authUrl.searchParams.get("login_hint"), authUrl.searchParams.get("claims")])
        .toEqual(["login", "0", operator.email, '{"id_token":{"auth_time":{"essential":true}}}']);
      google(sub, authTime, { nonce: authUrl.searchParams.get("nonce")! });
      const callback = await app.inject({ method: "GET", url: `/api/auth/google/callback?code=c&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`,
        headers: cookies ? { cookie: start.cookies.filter((cookie) => cookie.value).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") } : {} });
      return { status: callback.statusCode, location: String(callback.headers.location ?? "") };
    }
    for (const headers of [person, phone, proof, userPhone]) expect((await begin(headers)).statusCode).toBe(403);
    expect((await begin(spaceapp, { state: "short" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/auth/google/start?stepUp=mobile&ticket=made-up&json=true" })).statusCode).toBe(403);

    // Another Google account: back to the app with stepUp=failed, no mark; the used ticket then answers 403.
    const first = (await begin(spaceapp)).json().url as string;
    expect(first).toMatch(/^\/api\/auth\/google\/start\?stepUp=mobile&ticket=[A-Za-z0-9_-]{43}$/);
    expect(await browser(first, "google-other")).toEqual({ status: 302, location: `com.oll4.spaceapp:/oauth2redirect?stepUp=failed&state=${state}` });
    expect((await pairing(spaceapp)).json()).toMatchObject({ error: { code: "STEP_UP_REQUIRED" } });
    expect((await browser(first, "google-operator")).status).toBe(403);
    // An old Google sign-in fails too; a ticket past its 2 minutes answers 403.
    expect((await browser((await begin(spaceapp)).json().url, "google-operator", Math.floor(Date.now() / 1000) - 301)).location).toMatch(/stepUp=failed/);
    // The browser lost the start's cookies: failed too. Each refusal leaves its reason, never an address (auth.step_up_failed, Nous 4/11).
    expect((await browser((await begin(spaceapp)).json().url, "google-operator", Math.floor(Date.now() / 1000), false)).location).toMatch(/stepUp=failed/);
    const refused = (await store.listAuditEvents()).filter((event) => event.action === "auth.step_up_failed");
    expect(refused.filter((event) => event.metadata?.via === "spaceapp-browser").map((event) => event.metadata?.reason))
      .toEqual(expect.arrayContaining(["WRONG_GOOGLE_ACCOUNT", "AUTH_TIME_STALE", "STATE_COOKIE_MISSING"]));
    expect(refused.every((event) => event.actorUserId === operator.id && !JSON.stringify(event).includes("@"))).toBe(true);
    const late = (await begin(spaceapp)).json().url as string;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
    expect((await app.inject({ method: "GET", url: `${late}&json=true` })).statusCode).toBe(403);
    clock.mockRestore();

    expect(await browser((await begin(spaceapp)).json().url, "google-operator")).toEqual({ status: 302, location: `com.oll4.spaceapp:/oauth2redirect?stepUp=done&state=${state}` });
    const offer = await pairing(spaceapp);
    expect(offer.statusCode).toBe(200);
    // The mark is that app session's only.
    expect((await pairing(otherPhone)).statusCode).toBe(403);
    await app.inject({ method: "DELETE", url: `/api/mobile/pairing/${offer.json().offerId}`, headers: spaceapp });
    expect((await store.listAuditEvents()).filter((event) => event.action === "auth.step_up" && event.metadata?.via === "spaceapp-browser")).toHaveLength(1);
  });

  it("7/11 without auth_time (no Session age claims in Google's console): the step-up's own nonce and a fresh iat pass and pair; an older sign-in never", async () => {
    // Stable 7/11 05:46Z: the operator's Google step-up ran without an error and came back AUTH_TIME_MISSING, so Pair a phone stayed locked.
    const session = as(signSession(operator, secret, Date.now() - 7000));
    const nowS = () => Math.floor(Date.now() / 1000);
    const refusedFor = async (token: { nonce?: string | null; iat?: number }) => {
      const seen = new Set((await store.listAuditEvents()).map((event) => event.id));
      const result = await stepUp(session, "google-operator", null, session, app, token);
      expect(result.location).toMatch(/mobileStepUpError=/);
      return (await store.listAuditEvents()).find((event) => !seen.has(event.id) && event.action === "auth.step_up_failed")?.metadata?.reason;
    };
    // A token of an older sign-in: no nonce, another request's nonce, or this nonce with an iat before the step-up started.
    expect(await refusedFor({ nonce: null })).toBe("NONCE_MISMATCH");
    expect(await refusedFor({ nonce: "0".repeat(32) })).toBe("NONCE_MISMATCH");
    expect(await refusedFor({ iat: nowS() - 120 })).toBe("IAT_OUTSIDE_STEP_UP");
    expect(await refusedFor({ iat: nowS() + 600 })).toBe("IAT_OUTSIDE_STEP_UP");
    expect((await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: session, payload: {} })).json()).toMatchObject({ error: { code: "STEP_UP_REQUIRED" } });
    // Its own nonce, issued now: confirmed, and Pair a phone gives an offer.
    const seen = new Set((await store.listAuditEvents()).map((event) => event.id));
    expect(await stepUp(session, "google-operator", null)).toEqual({ status: 302, location: "/?mobileStepUp=ok" });
    expect((await store.listAuditEvents()).find((event) => !seen.has(event.id) && event.action === "auth.step_up")).toMatchObject({ metadata: { purpose: "mobile", fresh: "nonce_iat" } });
    const pairing = await app.inject({ method: "POST", url: "/api/mobile/pairing", headers: session, payload: {} });
    expect(pairing.statusCode).toBe(200);
    expect(pairing.json()).toMatchObject({ offerId: expect.any(String), qr: expect.any(String) });
    await app.inject({ method: "DELETE", url: `/api/mobile/pairing/${pairing.json().offerId}`, headers: session });
    // A stale auth_time is still refused whatever the nonce says.
    expect((await stepUp(session, "google-operator", nowS() - 301)).location).toMatch(/mobileStepUpError=/);
  });

  it("7/11 the operator's path: password Confirm, then Pair a phone reaches the QR on an install without keys (no 409 MOBILE_NOT_SET_UP, no Set up step)", async () => {
    const rows = new InMemorySpaceStore();
    const local = await createApp({ store: rows, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile }),
      auth: { sessionSecret: secret, devLogin: false, secureCookies: false, operatorEmail: operator.email, operatorPasswordHash: await hashPassword("env operator words") } });
    try {
      const login = await local.inject({ method: "POST", url: "/api/auth/login", payload: { email: operator.email, password: "env operator words" } });
      const web = as(login.cookies.find((cookie) => cookie.name === cookieName)!.value);
      const pair = () => local.inject({ method: "POST", url: "/api/mobile/pairing", headers: web, payload: {} });
      expect((await local.inject({ method: "GET", url: "/api/mobile/instance", headers: web })).json()).toEqual({ configured: false });
      // Before the step-up: 401 and no keys made.
      expect((await pair()).json()).toMatchObject({ error: { code: "STEP_UP_REQUIRED" } });
      expect((await local.inject({ method: "GET", url: "/api/mobile/instance", headers: web })).json()).toEqual({ configured: false });
      expect((await local.inject({ method: "POST", url: "/api/auth/step-up/password", headers: web, payload: { password: "env operator words" } })).statusCode).toBe(200);
      const offer = await pair();
      expect(offer.statusCode).toBe(200);
      const body = offer.json();
      expect(body).toMatchObject({ offerId: expect.any(String), qr: expect.any(String), fingerprint: expect.stringMatching(FP) });
      expect(decodeMobilePairQr(body.qr, Math.floor(Date.now() / 1000))).toMatchObject({ v: 1 });
      expect((await local.inject({ method: "GET", url: "/api/mobile/instance", headers: web })).json()).toMatchObject({ configured: true, fingerprint: body.fingerprint });
      expect((await rows.listAuditEvents()).find((event) => event.action === "mobile.instance.created")).toMatchObject({ metadata: { via: "pairing" } });
      // The keys stay: the next offer reuses them.
      const next = await pair();
      expect(next.json().fingerprint).toBe(body.fingerprint);
      for (const id of [body.offerId, next.json().offerId]) await local.inject({ method: "DELETE", url: `/api/mobile/pairing/${id}`, headers: web });
    } finally { await local.close(); }
  });

  it("the password step-up checks the .env password with .env's email, not the session's (d130a43784: a Google sign-in carries the users row's)", async () => {
    const local = await createApp({ store: new InMemorySpaceStore(), config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile }),
      auth: { sessionSecret: secret, devLogin: false, secureCookies: false, operatorEmail: operator.email, operatorPasswordHash: await hashPassword("env operator words") } });
    try {
      const web = as(signSession({ ...operator, email: "row-email@example.com" }, secret));
      const confirm = (password: string) => local.inject({ method: "POST", url: "/api/auth/step-up/password", headers: web, payload: { password } });
      expect((await confirm("wrong")).json()).toMatchObject({ error: { code: "STEP_UP_FAILED" } });
      expect((await confirm("env operator words")).json()).toMatchObject({ steppedUp: true });
    } finally { await local.close(); }
  });

  it("answers 503 CONNECTOR_KEY_MISSING without a connector key, and makes nothing", async () => {
    expect((await stepUp(person, "google-operator", Math.floor(Date.now() / 1000), person, bare)).location).toBe("/?mobileStepUp=ok");
    const response = await bare.inject({ method: "POST", url: "/api/mobile/instance", headers: person, payload: {} });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "CONNECTOR_KEY_MISSING" } });
    expect((await bare.inject({ method: "GET", url: "/api/mobile/instance", headers: person })).json()).toEqual({ configured: false });
  });
}, 300_000);
