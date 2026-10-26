import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryAppDeviceSessionRepository } from "@space/db";
import { appSignInRedirect, parseAppSignInBinding } from "../src/app-signin.js";
import { renewSessionIfDue, signSessionWithTtl, signSession, signedSessionPayload } from "../src/auth.js";
import { createDesktopAuthHandoffStore } from "../src/desktop-auth-handoffs.js";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";

// Sign-in for the Nous Android app (plan clipboard:VLBu2ge110ho step 4, Nous decision 2026-10-23): RFC 8252 with PKCE (S256), a
// one-time code sent only to com.oll4.spaceapp.nous:/oauth2redirect, redeemed with code + verifier + app for a fixed 30-day device
// session of its own, listed and revocable in Settings > Account > Devices. The old ?mobile=true and desktop paths stay as they were.
const secret = "app-signin-test-secret-1234567890";
const clientId = "app-signin-client";
const googleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...googleKey.publicKey.export({ format: "jwk" }), kid: "app-kid", alg: "RS256", use: "sig" }] };
function idToken(sub: string) {
  const claims = { sub, email: `${sub}@example.test`, aud: clientId, iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 600, email_verified: true };
  const body = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "app-kid", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return { claims, token: `${body}.${createSign("RSA-SHA256").update(body).sign(googleKey.privateKey).toString("base64url")}` };
}
function google(token: string) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ id_token: token });
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json(jwks, { headers: { "cache-control": "public, max-age=3600" } });
    throw Error("Unexpected external request in the app sign-in test");
  }));
}
afterEach(() => vi.unstubAllGlobals());
const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
const appState = () => randomBytes(16).toString("base64url");

describe("Nous Android app sign-in", () => {
  const store = new InMemorySpaceStore();
  const logs: string[] = [];
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    app = await createApp({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "false" }), auth: { sessionSecret: secret, devLogin: false, secureCookies: false, googleClientId: clientId },
      logStream: new Writable({ write(chunk, _encoding, callback) { logs.push(String(chunk)); callback(); } }) });
    vi.unstubAllEnvs();
  }, 30_000);
  afterAll(async () => { await app?.close(); }, 30_000);

  function linkedOwner(role: "ADMIN" | "USER" = "ADMIN") {
    const actor = store.upsertUser({ id: `user:${randomUUID()}`, email: `${randomUUID()}@example.test`, role });
    const { claims, token } = idToken(`${actor.id}-sub`);
    store.linkGoogleAccount(actor.id, claims);
    return { actor, token };
  }
  async function signIn(startPath: string, googleToken: string) {
    const start = await app.inject({ method: "GET", url: startPath });
    const state = start.cookies.find(c => c.name === "space_oauth_state")?.value;
    const cookies = start.cookies.filter(c => c.value).map(c => `${c.name}=${c.value}`).join("; ");
    google(googleToken);
    const callback = await app.inject({ method: "GET", url: `/api/auth/google/callback?code=test-code&state=${encodeURIComponent(state ?? "")}`, headers: { cookie: cookies } });
    return { start, callback };
  }
  const startPath = (challenge: string, state: string, appId = "nous") => `/api/auth/google/start?app=${appId}&challenge=${challenge}&state=${state}`;
  // Each redeem from its own address: the route allows 10 per 15 minutes per address (checked below).
  let address = 0;
  const redeem = (payload: object, remoteAddress = `10.9.${Math.floor(++address / 250)}.${address % 250}`) => app.inject({ method: "POST", url: "/api/auth/app-handoff", payload, remoteAddress });
  const asSession = (token: string) => ({ cookie: `space_session=${token}` });
  async function appSession() {
    const owner = linkedOwner();
    const { verifier, challenge } = pkce(), state = appState();
    const { callback } = await signIn(startPath(challenge, state), owner.token);
    const code = new URL(callback.headers.location as string).searchParams.get("code")!;
    const redeemed = await redeem({ app: "nous", code, codeVerifier: verifier, deviceName: "Pixel 9" });
    return { owner, callback, code, verifier, redeemed, web: callback.cookies.find(c => c.name === "space_session")?.value ?? "" };
  }

  it("refuses an unknown app, a missing or malformed challenge or state, before any Google step", async () => {
    const { challenge } = pkce();
    for (const url of [startPath(challenge, appState(), "other"), `/api/auth/google/start?app=nous&state=${appState()}`, startPath("plain-not-a-challenge", appState()),
      `/api/auth/google/start?app=nous&challenge=${challenge}`, startPath(challenge, "short")]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code).toBe("APP_HANDOFF_UNBOUND");
      expect(res.cookies.find(c => c.name === "space_oauth_state")?.value ?? "").toBe("");
    }
  });

  it("sends only a one-time code to the app's fixed redirect URI and redeems it once for a separate 30-day device session", async () => {
    const { owner, callback, code, verifier, redeemed, web } = await appSession();
    expect(callback.statusCode).toBe(302);
    const location = callback.headers.location as string;
    expect(location.startsWith("com.oll4.spaceapp.nous:/oauth2redirect?")).toBe(true);
    expect([...new URL(location).searchParams.keys()].sort()).toEqual(["code", "state"]);
    // The browser keeps today's web cookie; neither it nor the app's session is in the URL.
    expect(web).not.toBe("");
    expect(location).not.toContain(web);
    expect(redeemed.statusCode).toBe(200);
    const body = redeemed.json();
    expect(body).toMatchObject({ authenticated: true, user: { id: owner.actor.id }, deviceSessionId: expect.stringMatching(/^appdev:/) });
    expect(location).not.toContain(body.token);
    const device = signedSessionPayload(body.token, secret)!, browser = signedSessionPayload(web, secret)!;
    expect(device.app).toBe("nous");
    expect(device.sid).not.toBe(browser.sid);
    expect(device.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(30 * 86400 - 60);
    // Fixed 30 days: never renewed, unlike a web session.
    expect(renewSessionIfDue(body.token, secret, Date.now() + 20 * 86400_000)).toBeNull();
    expect(renewSessionIfDue(web, secret, Date.now() + 20 * 86400_000)).not.toBeNull();
    expect((await redeem({ app: "nous", code, codeVerifier: verifier, deviceName: "Pixel 9" })).json()).toEqual({ authenticated: false });
    // The device session works on the API like a session cookie.
    expect((await app.inject({ method: "GET", url: "/api/auth/devices", headers: asSession(body.token) })).statusCode).toBe(200);
  });

  it("burns the code on a wrong verifier, and the right one fails after it", async () => {
    const owner = linkedOwner();
    const { verifier, challenge } = pkce();
    const { callback } = await signIn(startPath(challenge, appState()), owner.token);
    const code = new URL(callback.headers.location as string).searchParams.get("code")!;
    expect((await redeem({ app: "nous", code, codeVerifier: pkce().verifier, deviceName: "x" })).json()).toEqual({ authenticated: false });
    expect((await redeem({ app: "nous", code, codeVerifier: verifier, deviceName: "x" })).json()).toEqual({ authenticated: false });
  });

  it("checks app, code and verifier together in the store: any mismatch burns the code", () => {
    const handoffs = createDesktopAuthHandoffStore();
    const { verifier, challenge } = pkce();
    const user = { id: "user:a", email: "a@example.test", role: "ADMIN" };
    handoffs.store("k".repeat(64), { token: "t", user, code: "c".repeat(43), codeChallenge: challenge, app: "nous" });
    expect(handoffs.redeem("k".repeat(64), "c".repeat(43), verifier, "other")).toBeNull();
    expect(handoffs.redeem("k".repeat(64), "c".repeat(43), verifier, "nous")).toBeNull();
    handoffs.store("j".repeat(64), { token: "t", user, code: "d".repeat(43), codeChallenge: challenge, app: "nous" });
    // A desktop redeem (no app) never takes an app's code.
    expect(handoffs.redeem("j".repeat(64), "d".repeat(43), verifier)).toBeNull();
    handoffs.store("m".repeat(64), { token: "t", user, code: "e".repeat(43), codeChallenge: challenge, app: "nous" });
    expect(handoffs.redeem("m".repeat(64), "e".repeat(43), verifier, "nous")).toMatchObject({ token: "t", app: "nous" });
  });

  it("lists the device in Settings for a person, revokes it there, and refuses proof sessions", async () => {
    const { redeemed, web } = await appSession();
    const { token, deviceSessionId } = redeemed.json();
    const csrf = (await app.inject({ method: "GET", url: "/api/auth/csrf", headers: asSession(web) })).json().csrfToken as string;
    const listed = await app.inject({ method: "GET", url: "/api/auth/devices", headers: asSession(web) });
    expect(listed.json().devices).toEqual([expect.objectContaining({ id: deviceSessionId, app: "nous", deviceName: "Pixel 9", revokedAt: null })]);
    expect(JSON.stringify(listed.json())).not.toMatch(/sid|token/i);
    const proof = signSessionWithTtl({ id: "user:operator-proof", email: "proof@example.test", role: "ADMIN" }, secret, 600);
    expect((await app.inject({ method: "GET", url: "/api/auth/devices", headers: asSession(proof) })).statusCode).toBe(403);
    const revoked = await app.inject({ method: "POST", url: `/api/auth/devices/${encodeURIComponent(deviceSessionId)}/revoke`, headers: { ...asSession(web), "x-space-csrf-token": csrf } });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().device.revokedAt).toEqual(expect.any(String));
    expect((await app.inject({ method: "GET", url: "/api/auth/devices", headers: asSession(token) })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/auth/devices/${encodeURIComponent(deviceSessionId)}/revoke`, headers: { ...asSession(web), "x-space-csrf-token": csrf } })).statusCode).toBe(404);
  });

  it("marks the device revoked when the app signs out, and keeps at most five live devices per app", async () => {
    const first = await appSession();
    const { token, deviceSessionId } = first.redeemed.json();
    const csrf = (await app.inject({ method: "GET", url: "/api/auth/csrf", headers: asSession(token) })).json().csrfToken as string;
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...asSession(token), "x-space-csrf-token": csrf }, payload: {} })).statusCode).toBeLessThan(400);
    const web = first.web;
    expect((await app.inject({ method: "GET", url: "/api/auth/devices", headers: asSession(web) })).json().devices.find((row: { id: string }) => row.id === deviceSessionId).revokedAt).toEqual(expect.any(String));
    // Six sign-ins of one owner: the oldest live one is revoked.
    const owner = linkedOwner();
    const tokens: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const { verifier, challenge } = pkce();
      const { callback } = await signIn(startPath(challenge, appState()), owner.token);
      tokens.push((await redeem({ app: "nous", code: new URL(callback.headers.location as string).searchParams.get("code")!, codeVerifier: verifier, deviceName: `Phone ${index}` })).json().token);
    }
    expect((await app.inject({ method: "GET", url: "/api/auth/devices", headers: asSession(tokens[0]!) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/devices", headers: asSession(tokens[5]!) })).json().devices.filter((row: { revokedAt: string | null }) => !row.revokedAt)).toHaveLength(5);
  });

  it("limits redeem attempts to 10 per 15 minutes per address", async () => {
    const answers = [];
    for (let index = 0; index < 11; index += 1) answers.push((await redeem({ app: "nous", code: "x".repeat(43), codeVerifier: pkce().verifier, deviceName: "x" }, "10.200.0.1")).statusCode);
    expect(answers.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(answers[10]).toBe(429);
  });

  it("gives an app code only to the operator's account while multi-user is off", async () => {
    const user = linkedOwner("USER");
    const { challenge } = pkce();
    const { callback } = await signIn(startPath(challenge, appState()), user.token);
    expect(callback.statusCode).toBe(302);
    expect(String(callback.headers.location)).toMatch(/^\/\?authError=/);
  });

  it("leaves the old mobile and plain web sign-ins as they were", async () => {
    const owner = linkedOwner();
    const mobile = await signIn("/api/auth/google/start?mobile=true", owner.token);
    expect(mobile.callback.body).toContain("spaceapp://auth/callback?token=");
    const web = await signIn("/api/auth/google/start", owner.token);
    expect(web.callback.headers.location).toBe("/");
    expect(web.callback.cookies.find(c => c.name === "space_session")?.value).toBeTruthy();
  });

  it("never writes a code, verifier or session of the flow into the API log", async () => {
    const { code, verifier, redeemed, web } = await appSession();
    const output = logs.join("");
    expect(output.length).toBeGreaterThan(0);
    for (const secretValue of [code, verifier, redeemed.json().token, web]) expect(output).not.toContain(secretValue);
  });

  it("builds the redirect only from the contracts map", () => {
    const { challenge } = pkce();
    const binding = parseAppSignInBinding({ app: "nous", challenge, state: "s".repeat(20) })!;
    expect(appSignInRedirect(binding, "abc")).toBe(`com.oll4.spaceapp.nous:/oauth2redirect?code=abc&state=${"s".repeat(20)}`);
    // A redirect the caller names is never read.
    expect(parseAppSignInBinding({ app: "nous", challenge, state: "s".repeat(20), redirect: "https://evil.example" } as never)).toEqual(binding);
    expect(new InMemoryAppDeviceSessionRepository()).toBeTruthy();
    expect(signSession({ id: "user:x", email: "x@example.test", role: "ADMIN" }, secret, Date.now(), { app: "nous" })).toMatch(/\./);
  });
});
