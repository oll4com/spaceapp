import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, hashPassword, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

// Settings → Login password (operator 12/11, nous_msg:ab7d29cfda7e438b8bbb1e9a): POST /api/auth/password changes the signed-in person's own password.
const secret = "auth-password-test-secret-1234567890";
const oldPassword = "right horse battery";
const newPassword = "a brand new staple phrase";
const dir = mkdtempSync(join(tmpdir(), "space-auth-password-"));
const keyFile = join(dir, "connector.key");
writeFileSync(keyFile, "c".repeat(48));
const as = (token: string) => ({ cookie: `${cookieName}=${token}`, "x-space-csrf-token": createCsrfToken(token, secret)! });
const cookieOf = (response: { cookies: Array<{ name: string; value: string }> }) => response.cookies.find((entry) => entry.name === cookieName)?.value;

async function ownerApp(env: Record<string, string> = {}) {
  const store = new InMemorySpaceStore();
  store.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" });
  const owner = store.claimOwnerSetup({ tokenHash: "a".repeat(64), email: "owner@example.test", passwordHash: await hashPassword(oldPassword), now: new Date().toISOString() }).user;
  const app = await createApp({ store, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile, ...env }),
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
  return { store, owner, app };
}

describe("POST /api/auth/password", () => {
  it("asks for proof, refuses a wrong current password, then swaps the password and ends every other session", async () => {
    const { store, owner, app } = await ownerApp();
    try {
      const change = (headers: Record<string, string>, payload: object) => app.inject({ method: "POST", url: "/api/auth/password", headers, payload });
      const login = (password: string) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email: owner.email, password } });
      const web = as(signSession(owner, secret, Date.now() - 2000)), other = as(signSession(owner, secret, Date.now() - 1000));
      expect((await app.inject({ method: "POST", url: "/api/auth/password", payload: { newPassword } })).statusCode).toBe(401);
      expect((await change(web, { newPassword })).json()).toMatchObject({ error: { code: "STEP_UP_REQUIRED", details: { stepUpUrl: "/api/auth/google/start?stepUp=mobile" } } });
      expect((await change(web, { currentPassword: "wrong words", newPassword })).statusCode).toBe(401);
      expect((await change(web, { currentPassword: oldPassword, newPassword: "short" })).statusCode).toBe(400);

      const changed = await change(web, { currentPassword: oldPassword, newPassword });
      expect(changed.json()).toEqual({ ok: true });
      const fresh = cookieOf(changed)!;
      expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: as(fresh) })).json()).toMatchObject({ isAuthenticated: true });
      expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: other })).json()).toMatchObject({ isAuthenticated: false });
      expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: web })).json()).toMatchObject({ isAuthenticated: false });
      expect((await login(oldPassword)).statusCode).toBe(401);
      expect((await login(newPassword)).statusCode).toBe(200);

      const audit = (await store.listAuditEvents()).filter((event) => event.action.startsWith("auth.password_change"));
      expect(audit.map((event) => event.action)).toEqual(expect.arrayContaining(["auth.password_change_failed", "auth.password_changed"]));
      expect(JSON.stringify(audit)).not.toMatch(/horse|staple|wrong words/);
    } finally { await app.close(); }
  });

  it("takes a fresh step-up instead of the current password", async () => {
    const { owner, app } = await ownerApp();
    try {
      const web = as(signSession(owner, secret));
      expect((await app.inject({ method: "POST", url: "/api/auth/step-up/password", headers: web, payload: { password: oldPassword } })).json()).toMatchObject({ steppedUp: true });
      expect((await app.inject({ method: "POST", url: "/api/auth/password", headers: web, payload: { newPassword } })).json()).toEqual({ ok: true });
      expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: owner.email, password: newPassword } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("lets an invited user change only their own password", async () => {
    const { owner, app } = await ownerApp({ SPACE_MULTI_USER_ENABLED: "true", SPACE_CLI_ENABLED: "false", SPACE_BROWSER_SESSIONS_ENABLED: "false" });
    try {
      const { token } = (await app.inject({ method: "POST", url: "/api/admin/users/invites", headers: as(signSession(owner, secret)), payload: { email: "dev@example.test" } })).json() as { token: string };
      const accepted = await app.inject({ method: "POST", url: "/api/auth/invites/accept", payload: { token, password: oldPassword } });
      const dev = as(cookieOf(accepted)!);
      expect((await app.inject({ method: "POST", url: "/api/auth/password", headers: dev, payload: { currentPassword: oldPassword, newPassword } })).json()).toEqual({ ok: true });
      const login = (email: string, password: string) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
      expect((await login("dev@example.test", newPassword)).statusCode).toBe(200);
      expect((await login(owner.email, oldPassword)).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("stores the .env operator's new password as the owner's, which wins over the .env hash until the host sets a new one", async () => {
    const store = new InMemorySpaceStore();
    const envApp = (operatorPasswordHash: string) => createApp({ store, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile }),
      auth: { sessionSecret: secret, devLogin: false, secureCookies: false, operatorEmail: "operator@example.test", operatorPasswordHash } });
    const login = (app: Awaited<ReturnType<typeof envApp>>, password: string) =>
      app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "Operator@example.test", password } });
    const envHash = await hashPassword(oldPassword);
    const app = await envApp(envHash);
    try {
      const signedIn = await login(app, oldPassword);
      expect(signedIn.statusCode).toBe(200);
      const web = as(cookieOf(signedIn)!);
      expect((await app.inject({ method: "POST", url: "/api/auth/password", headers: web, payload: { currentPassword: "wrong words", newPassword } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/auth/password", headers: web, payload: { newPassword } })).json()).toMatchObject({ error: { code: "STEP_UP_REQUIRED" } });
      const changed = await app.inject({ method: "POST", url: "/api/auth/password", headers: web, payload: { currentPassword: oldPassword, newPassword } });
      expect(changed.json()).toEqual({ ok: true });
      expect((await login(app, oldPassword)).statusCode).toBe(401);
      expect((await login(app, newPassword)).json().user.id).toBe(signedIn.json().user.id);
      expect(JSON.stringify(await store.listAuditEvents())).not.toContain(newPassword);
    } finally { await app.close(); }
    // A restart with the same .env hash keeps the Settings password; a new hash set on the host replaces it (the recovery path).
    const restarted = await envApp(envHash);
    try {
      expect((await login(restarted, oldPassword)).statusCode).toBe(401);
      expect((await login(restarted, newPassword)).statusCode).toBe(200);
    } finally { await restarted.close(); }
    const recovered = await envApp(await hashPassword("host recovery words"));
    try {
      expect((await login(recovered, newPassword)).statusCode).toBe(401);
      expect((await login(recovered, "host recovery words")).statusCode).toBe(200);
    } finally { await recovered.close(); }
  });

  it("is rate limited like the password step-up", async () => {
    const { owner, app } = await ownerApp();
    try {
      const web = as(signSession(owner, secret));
      const codes: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        codes.push((await app.inject({ method: "POST", url: "/api/auth/password", headers: web, payload: { currentPassword: "wrong words", newPassword } })).statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    } finally { await app.close(); }
  });
});

// Login screen › Forgot password? (operator 13/11): no mail channel sends sign-in mail on this server, so the reset is a fresh sign-in of the
// linked Google account; it marks only the new session, which may then set a password without the old one.
describe("password reset through a fresh Google sign-in", () => {
  const clientId = "reset-client";
  const googleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  afterEach(() => vi.unstubAllGlobals());

  /** Login screen › Forgot password? through Google's answer (stubbed): the callback's reply. */
  async function resetVia(app: Awaited<ReturnType<typeof createApp>>, claims: { sub: string; email: string; auth_time: number }) {
    const start = await app.inject({ method: "GET", url: "/api/auth/google/start?reset=password&json=true" });
    const authUrl = new URL(start.json().authUrl);
    expect(authUrl.searchParams.get("max_age")).toBe("0");
    const now = Math.floor(Date.now() / 1000);
    const body = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "k", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ ...claims,
      aud: clientId, iss: "https://accounts.google.com", exp: now + 600, iat: now, email_verified: true })).toString("base64url")}`;
    const idToken = `${body}.${createSign("RSA-SHA256").update(body).sign(googleKey.privateKey).toString("base64url")}`;
    const jwks = { keys: [{ ...googleKey.publicKey.export({ format: "jwk" }), kid: "k", alg: "RS256", use: "sig" }] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "https://oauth2.googleapis.com/token" ? Response.json({ id_token: idToken })
      : Response.json(jwks, { headers: { "cache-control": "public, max-age=3600" } })));
    const cookies = start.cookies.filter((cookie) => cookie.value).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const state = authUrl.searchParams.get("state")!;
    return app.inject({ method: "GET", url: `/api/auth/google/callback?code=c&state=${encodeURIComponent(state)}`, headers: { cookie: cookies } });
  }
  const fresh = () => Math.floor(Date.now() / 1000);

  it("sets a new password without the old one once, ends the other sessions, and refuses a stale or unlinked Google sign-in", async () => {
    const { store, owner, app } = await ownerApp({});
    await app.close();
    await store.linkGoogleAccount(owner.id, { sub: "google-owner", email: owner.email });
    const google = await createApp({ store, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile }),
      auth: { sessionSecret: secret, devLogin: false, secureCookies: false, googleClientId: clientId } });
    try {
      const other = as(signSession(owner, secret, Date.now() - 2000));
      // A Google sign-in older than the step-up window, or of a Google account no user linked, opens no session.
      for (const claims of [{ sub: "google-owner", email: owner.email, auth_time: fresh() - 900 }, { sub: "google-stranger", email: "stranger@example.test", auth_time: fresh() }]) {
        const refused = await resetVia(google, claims);
        expect(refused.headers.location).toMatch(/^\/\?authError=/);
        expect(cookieOf(refused)).toBeFalsy();
      }
      const signedIn = await resetVia(google, { sub: "google-owner", email: owner.email, auth_time: fresh() });
      expect(signedIn.headers.location).toBe("/?mobileStepUp=ok");
      const web = as(cookieOf(signedIn)!);
      const changed = await google.inject({ method: "POST", url: "/api/auth/password", headers: web, payload: { newPassword } });
      expect(changed.json()).toEqual({ ok: true });
      // Used once: the session the change hands back carries no mark, and the session before the reset is signed out.
      expect((await google.inject({ method: "POST", url: "/api/auth/password", headers: as(cookieOf(changed)!), payload: { newPassword: "yet another long phrase" } })).json())
        .toMatchObject({ error: { code: "STEP_UP_REQUIRED" } });
      expect((await google.inject({ method: "GET", url: "/api/auth/me", headers: other })).json()).toMatchObject({ isAuthenticated: false });
      expect((await google.inject({ method: "POST", url: "/api/auth/login", payload: { email: owner.email, password: oldPassword } })).statusCode).toBe(401);
      expect((await google.inject({ method: "POST", url: "/api/auth/login", payload: { email: owner.email, password: newPassword } })).statusCode).toBe(200);
      const audit = (await store.listAuditEvents()).filter((event) => event.action === "auth.step_up" || event.action === "auth.password_changed");
      expect(audit.map((event) => event.metadata)).toEqual(expect.arrayContaining([expect.objectContaining({ purpose: "password_reset" }), expect.objectContaining({ via: "step_up" })]));
      expect(JSON.stringify(await store.listAuditEvents())).not.toMatch(/staple|horse/);
      // Never through an app, desktop or phone hand-off, nor mixed with another step-up or a link.
      for (const extra of ["&stepUp=mobile", "&link=true", "&mobile=true", "&app=nous", "&desktopHandoff=x"]) {
        expect((await google.inject({ method: "GET", url: `/api/auth/google/start?reset=password${extra}&json=true`, headers: as(cookieOf(changed)!) })).json())
          .toMatchObject({ error: { code: "RESET_UNAVAILABLE" } });
      }
    } finally { await google.close(); }
  });

  it("resets the password of the operator defined only in .env", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({ store, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile }),
      auth: { sessionSecret: secret, devLogin: false, secureCookies: false, operatorEmail: "operator@example.test", operatorPasswordHash: await hashPassword(oldPassword), googleClientId: clientId } });
    try {
      const login = (password: string) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "operator@example.test", password } });
      const operatorId = (await login(oldPassword)).json().user.id as string;
      await store.linkGoogleAccount(operatorId, { sub: "google-operator", email: "operator@example.test" });
      const signedIn = await resetVia(app, { sub: "google-operator", email: "operator@example.test", auth_time: fresh() });
      expect((await app.inject({ method: "POST", url: "/api/auth/password", headers: as(cookieOf(signedIn)!), payload: { newPassword } })).json()).toEqual({ ok: true });
      expect((await login(oldPassword)).statusCode).toBe(401);
      expect((await login(newPassword)).json().user.id).toBe(operatorId);
    } finally { await app.close(); }
  });
});
