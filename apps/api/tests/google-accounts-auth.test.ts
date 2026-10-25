import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createCsrfToken, exchangeGoogleCode, signSession, verifyGoogleIdToken } from "../src/auth.js";

const secret = "google-registry-test-secret-123456789";
const clientId = "google-registry-client";
const claims = (sub: string, email = `${sub}@example.test`) => ({ sub, email, name: "Test account", aud: clientId, iss: "https://accounts.google.com", exp: Math.floor(Date.now()/1000)+600, email_verified: true });
// Google's signing key and an impostor's: ID tokens are verified locally against the published JWKS (hardening step 11).
const googleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const impostorKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...googleKey.publicKey.export({ format: "jwk" }), kid: "google-test-kid", alg: "RS256", use: "sig" }] };
function signedToken(payload: object, { key = googleKey.privateKey, header = { alg: "RS256", kid: "google-test-kid", typ: "JWT" } as object } = {}) {
  const body = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key).toString("base64url")}`;
}
const certsUrl = "https://www.googleapis.com/oauth2/v3/certs";
let currentToken = "";
function google(payload: object, invalid = false) {
  currentToken = signedToken(payload, invalid ? { key: impostorKey.privateKey } : {});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ id_token: currentToken });
    if (url === certsUrl) return Response.json(jwks, { headers: { "cache-control": "public, max-age=3600" } });
    throw Error("Unexpected external request in Google auth test");
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe("verified Google identity", () => {
  it("rejects a decodable ID token rejected by Google verification", async () => {
    google(claims("untrusted"), true);
    await expect(exchangeGoogleCode({ code: "test-code", clientId, redirectUri: "http://localhost/callback", codeVerifier: "test-verifier" })).rejects.toThrow(/verification/);
  });
  it.each(["aud", "iss", "exp", "email_verified"])("rejects a validly signed token without %s", async key => {
    const payload: Record<string, unknown> = claims("test"); delete payload[key]; google(payload);
    await expect(verifyGoogleIdToken({ idToken: signedToken(payload), clientId })).rejects.toThrow();
  });
  it("accepts only Google's signature, audience, issuer and an unexpired token", async () => {
    google(claims("test"));
    await expect(verifyGoogleIdToken({ idToken: signedToken(claims("test")), clientId })).resolves.toMatchObject({ sub: "test", email: "test@example.test" });
    const bad: Array<[string, string, RegExp]> = [
      ["impostor key", signedToken(claims("test"), { key: impostorKey.privateKey }), /verification failed/],
      ["unknown kid", signedToken(claims("test"), { header: { alg: "RS256", kid: "other" } }), /verification failed/],
      ["alg none", `${Buffer.from(JSON.stringify({ alg: "none", kid: "google-test-kid" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims("test"))).toString("base64url")}.`, /verification failed/],
      ["tampered payload", (() => { const [h, , s] = signedToken(claims("test")).split("."); return `${h}.${Buffer.from(JSON.stringify(claims("admin"))).toString("base64url")}.${s}`; })(), /verification failed/],
      ["other audience", signedToken({ ...claims("test"), aud: "another-client" }), /audience/],
      ["other issuer", signedToken({ ...claims("test"), iss: "https://evil.example" }), /issuer/],
      ["expired", signedToken({ ...claims("test"), exp: Math.floor(Date.now() / 1000) - 1 }), /expired/],
      ["unverified email", signedToken({ ...claims("test"), email_verified: "true" }), /not verified/]
    ];
    for (const [name, idToken, error] of bad) await expect(verifyGoogleIdToken({ idToken, clientId }), name).rejects.toThrow(error);
  });
  it("requires an ID token, not access-token-only user info", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/token") ? Response.json({ access_token: "synthetic" }) : Response.json(claims("test"))));
    await expect(exchangeGoogleCode({ code: "test-code", clientId, redirectUri: "http://localhost/callback", codeVerifier: "test-verifier" })).rejects.toThrow(/ID token|id_token/);
  });
});

describe("Google account management and SSO", () => {
  const store = new InMemorySpaceStore();
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => { app = await createApp({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "false" }), auth: { sessionSecret: secret, devLogin: false, secureCookies: false, googleClientId: clientId } }); }, 30_000);
  afterAll(async () => { await app?.close(); }, 30_000);
  function user(email?: string) {
    const id = `user:${randomUUID()}`;
    const actor = store.upsertUser({ id, email: email ?? `${randomUUID()}@example.test`, role: "ADMIN" });
    const token = signSession(actor, secret);
    return { actor, cookie: `space_session=${token}`, headers: { cookie: `space_session=${token}`, "x-space-csrf-token": createCsrfToken(token, secret)! } };
  }
  async function start(cookie?: string, path = "/api/auth/google/start?link=true") {
    const res = await app.inject({ method: "GET", url: path, headers: cookie ? { cookie } : {} });
    const state = res.cookies.find(c => c.name === "space_oauth_state")?.value;
    return { res, state, cookies: res.cookies.filter(c => c.value).map(c => `${c.name}=${c.value}`) };
  }
  async function callback(flow: Awaited<ReturnType<typeof start>>, cookie?: string, omitted?: string) {
    const cookies = flow.cookies.filter(c => !omitted || !c.startsWith(`${omitted}=`));
    return app.inject({ method: "GET", url: `/api/auth/google/callback?code=test-code&state=${encodeURIComponent(flow.state!)}`, headers: { cookie: [...cookies, ...(cookie ? [cookie] : [])].join("; ") } });
  }
  it("requires an authenticated session to start linking", async () => {
    expect((await start()).res.statusCode).toBe(401);
  });
  it("never grants access by matching email or a legacy-shaped user ID", async () => {
    const { actor } = user("email-match@example.test"); google(claims("new-sub", actor.email));
    const res = await app.inject({ method: "POST", url: "/api/auth/google/credential", payload: { credential: currentToken } });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find(c => c.name === "space_session")).toBeUndefined();
    store.upsertUser({ id: "user:google:unlinked-sub", email: "legacy-id@example.test", role: "ADMIN" }); google(claims("unlinked-sub", "legacy-id@example.test"));
    expect((await app.inject({ method: "POST", url: "/api/auth/google/credential", payload: { credential: currentToken } })).statusCode).toBe(401);
  });
  it("links two accounts idempotently and both sign into the original user without changing rooms or role", async () => {
    const u = user(); const subs = [`${u.actor.id}-a`, `${u.actor.id}-b`];
    const room = store.createRoom({ name: "Google SSO fixture", initialPaneCount: 0 }, "trace:google", u.actor.id);
    for (const sub of [...subs, subs[1]!]) {
      google(claims(sub));
      const linked = await callback(await start(u.cookie), u.cookie);
      expect(linked.headers.location).toBe("/?googleLinked=true");
    }
    const list = await app.inject({ method: "GET", url: "/api/auth/google/accounts", headers: u.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().accounts).toHaveLength(2);
    expect(list.json().accounts.filter((a: { isPrimary: boolean }) => a.isPrimary)).toHaveLength(1);
    for (const sub of subs) {
      google(claims(sub));
      const res = await app.inject({ method: "POST", url: "/api/auth/google/credential", payload: { credential: currentToken } });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ id: u.actor.id, role: "ADMIN", email: u.actor.email, googleId: subs[0] });
      const session = res.cookies.find(c => c.name === "space_session")!;
      const rooms = await app.inject({ method: "GET", url: "/api/rooms", headers: { cookie: `${session.name}=${session.value}` } });
      expect(rooms.statusCode).toBe(200);
      expect(rooms.json().data).toEqual(expect.arrayContaining([expect.objectContaining({ id: room.id, ownerUserId: u.actor.id })]));
      expect((await callback(await start(undefined, "/api/auth/google/start"))).headers.location).toBe("/");
    }
  });
  it.each(["space_oauth_pkce", "space_oauth_link_user"])("rejects a callback missing %s instead of downgrading its intent", async omitted => {
    const u = user(); google(claims(`${u.actor.id}-sub`));
    const res = await callback(await start(u.cookie), u.cookie, omitted);
    expect(res.headers.location).toMatch(/Error=/);
    expect(res.cookies.find(c => c.name === "space_session")).toBeUndefined();
  });
  it("binds the linking transaction to its original active session", async () => {
    const u = user(); const flow = await start(u.cookie); google(claims(`${u.actor.id}-sub`));
    const replacement = `space_session=${signSession(u.actor, secret, Date.now()+2000)}`;
    expect((await callback(flow, replacement)).headers.location).toContain("googleLinkError");
    expect((await callback(flow, user().cookie)).headers.location).toContain("googleLinkError");
    expect((await callback(flow)).headers.location).toContain("googleLinkError");
  });
  it("rejects another user's account and leaves both registries intact", async () => {
    const a = user(), b = user(), sub = `${a.actor.id}-sub`; google(claims(sub));
    expect((await callback(await start(a.cookie), a.cookie)).headers.location).toBe("/?googleLinked=true");
    expect((await callback(await start(b.cookie), b.cookie)).headers.location).toContain("googleLinkError");
    expect((await app.inject({ method: "GET", url: "/api/auth/google/accounts", headers: b.headers })).json().accounts).toEqual([]);
  });
  it("does not recreate membership removed while a Google login is being resolved", async () => {
    const u = user();
    const identity = claims(`${u.actor.id}-race`);
    const account = store.linkGoogleAccount(u.actor.id, identity);
    const original = store.getUserByGoogleId.bind(store);
    const lookup = vi.spyOn(store, "getUserByGoogleId").mockImplementation(sub => {
      const found = original(sub);
      store.removeGoogleAccount(u.actor.id, account.id, true);
      return found;
    });
    try {
      google(identity);
      await app.inject({ method: "POST", url: "/api/auth/google/credential", payload: { credential: currentToken } });
      expect(store.listGoogleAccounts(u.actor.id)).toEqual([]);
      expect(original(identity.sub)).toBeNull();
    } finally { lookup.mockRestore(); }
  });
  it("clears all transaction cookies on provider cancellation", async () => {
    const u = user(), flow = await start(u.cookie);
    const res = await app.inject({ method: "GET", url: `/api/auth/google/callback?error=access_denied&state=${encodeURIComponent(flow.state!)}`, headers: { cookie: flow.cookies.join("; ") } });
    for (const name of ["space_oauth_state", "space_oauth_pkce", "space_oauth_link_user", "space_oauth_mobile", "space_oauth_desktop_handoff"]) expect(res.cookies.find(c => c.name === name)?.value).toBe("");
    expect(res.headers.location).toContain("googleLinkError");
  });
  it("scopes list/primary/delete to the owner and guards the final login including legacy unlink", async () => {
    const a = user(), b = user();
    for (const sub of [`${a.actor.id}-a`, `${a.actor.id}-b`]) { google(claims(sub)); await callback(await start(a.cookie), a.cookie); }
    const list = (await app.inject({ method: "GET", url: "/api/auth/google/accounts", headers: a.headers })).json().accounts;
    expect(list).toHaveLength(2);
    const path = `/api/auth/google/accounts/${encodeURIComponent(list[1].id)}`;
    expect((await app.inject({ method: "GET", url: "/api/auth/google/accounts" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PATCH", url: path, headers: b.headers, payload: { isPrimary: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: path, headers: b.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: path, headers: a.headers, payload: { isPrimary: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: path, headers: a.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/auth/google/accounts/${encodeURIComponent(list[0].id)}`, headers: a.headers })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/auth/google/unlink", headers: a.headers })).statusCode).toBe(409);
  });
});
