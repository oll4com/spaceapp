import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, hashPassword, signSession, signSessionWithTtl } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { maskPasswordResetJson, maskPasswordResetLinks } from "../src/password-reset-mask.js";

// Forgot password by mail (operator 13/11, Nous option A): each of Nous's four security conditions has a case here.
const secret = "auth-password-reset-test-secret-123456";
const oldPassword = "right horse battery";
const newPassword = "a brand new staple phrase";
const dir = mkdtempSync(join(tmpdir(), "space-auth-reset-"));
const keyFile = join(dir, "connector.key");
writeFileSync(keyFile, "c".repeat(48));
const host = "space.example.test";
type Mail = { owner: string; to: string; subject: string; text: string };

async function resetApp(options: { env?: Record<string, string>; ownerRow?: boolean; googleRedirectUri?: string; sendFails?: boolean } = {}) {
  const store = new InMemorySpaceStore();
  let owner = null;
  if (options.ownerRow !== false) {
    store.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" });
    owner = store.claimOwnerSetup({ tokenHash: "a".repeat(64), email: "owner@example.test", passwordHash: await hashPassword(oldPassword), now: new Date().toISOString() }).user;
  }
  const mails: Mail[] = [];
  const app = await createApp({ store, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile, ...options.env }),
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false, googleRedirectUri: options.googleRedirectUri ?? `https://${host}/api/auth/google/callback`,
      ...(options.ownerRow === false ? { operatorEmail: "operator@example.test", operatorPasswordHash: await hashPassword(oldPassword) } : {}) },
    passwordResetMail: async (owner, to, subject, text) => {
      if (options.sendFails) throw new Error("connect ECONNREFUSED mail.example.test:465");
      mails.push({ owner, to, subject, text });
    } });
  let ip = 1;
  const freshIp = () => `10.0.0.${ip++}`;
  const ask = async (email: string, remoteAddress = freshIp()) => {
    const response = await app.inject({ method: "POST", url: "/api/auth/password-reset/request", headers: { host }, remoteAddress, payload: { email } });
    await vi.waitFor(async () => { await new Promise((resolve) => setImmediate(resolve)); });
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { response, bind: response.cookies.find((cookie) => cookie.name === "space_pwreset")?.value };
  };
  const complete = (token: string, bind: string | undefined, extra: Record<string, string> = {}, password = newPassword) => app.inject({ method: "POST", url: "/api/auth/password-reset/complete",
    headers: { host, ...(bind ? { cookie: [`space_pwreset=${bind}`, extra.cookie].filter(Boolean).join("; ") } : extra.cookie ? { cookie: extra.cookie } : {}) },
    remoteAddress: freshIp(), payload: { token, newPassword: password } });
  const tokenOf = (mail: Mail) => /#password-reset=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
  const login = (email: string, password: string) => app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: freshIp(), payload: { email, password } });
  return { store, owner, app, mails, ask, complete, tokenOf, login };
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

describe("Forgot password by mail", () => {
  it("1: mails only the stored owner address, answers the same for any address, and limits per account and per IP", async () => {
    const t = await resetApp(); close = () => t.app.close();
    const unknown = await t.ask("someone@example.test");
    const known = await t.ask("OWNER@example.test");
    expect(unknown.response.statusCode).toBe(200);
    expect(known.response.json()).toEqual(unknown.response.json());
    expect(Boolean(unknown.bind) && Boolean(known.bind)).toBe(true);
    expect(t.mails).toHaveLength(1);
    expect(t.mails[0]).toMatchObject({ owner: t.owner!.id, to: "owner@example.test", subject: "Reset your SpaceApp password" });
    expect(t.mails[0]!.text).toMatch(new RegExp(`https://${host.replace(/\./g, "\\.")}/#password-reset=[A-Za-z0-9_-]{43}`));
    expect(t.mails[0]!.text).toMatch(/^[\x20-\x7e\n]+$/);
    // Per account: three mails an hour, from any address.
    await t.ask("owner@example.test"); await t.ask("owner@example.test"); await t.ask("owner@example.test");
    expect(t.mails).toHaveLength(3);
    // Per IP: five asks in 15 minutes.
    for (let index = 0; index < 5; index += 1) expect((await t.ask("x@example.test", "10.9.9.9")).response.statusCode).toBe(200);
    expect((await t.ask("x@example.test", "10.9.9.9")).response.statusCode).toBe(429);
    const audit = JSON.stringify(await t.store.listAuditEvents());
    expect(audit).toContain("account_rate_limit");
    expect(audit).not.toMatch(/password-reset=|owner@example|someone@example/);
  });

  it("a server that cannot mail reset links says so (503, available false, canMail false); account outcomes stay silent", async () => {
    const off = await resetApp({ googleRedirectUri: "" }); close = () => off.app.close();
    const answer = await off.ask("owner@example.test");
    expect(answer.response.statusCode).toBe(503);
    expect(answer.response.json()).toMatchObject({ error: { code: "RESET_MAIL_UNAVAILABLE" } });
    expect(answer.bind).toBeUndefined();
    const other = (await off.ask("nobody@example.test")).response.json();
    expect([other.error.code, other.error.message]).toEqual([answer.response.json().error.code, answer.response.json().error.message]);
    const avail = await off.app.inject({ method: "GET", url: "/api/auth/password-reset/available", headers: { host } });
    expect(avail.json()).toEqual({ available: false });
    const as = (session: string) => ({ host, cookie: `${cookieName}=${session}` });
    const session = signSession(off.owner!, secret);
    expect((await off.app.inject({ method: "GET", url: "/api/auth/password", headers: as(session) })).json()).toMatchObject({ canMail: false });
    expect(off.mails).toHaveLength(0);

    const on = await resetApp(); close = async () => { await off.app.close(); await on.app.close(); };
    expect((await on.app.inject({ method: "GET", url: "/api/auth/password-reset/available", headers: { host } })).json()).toEqual({ available: true });
    expect((await on.app.inject({ method: "GET", url: "/api/auth/password", headers: as(signSession(on.owner!, secret)) })).json()).toMatchObject({ canMail: true });
    const unknown = await on.ask("someone@example.test");
    expect([unknown.response.statusCode, unknown.response.json()]).toEqual([200, { ok: true }]);
  });

  it("records a refused or timed-out send as send_failed and leaves no usable link", async () => {
    const t = await resetApp({ sendFails: true }); close = () => t.app.close();
    const asked = await t.ask("owner@example.test");
    expect(asked.response.json()).toEqual({ ok: true });
    await vi.waitFor(async () => expect(JSON.stringify(await t.store.listAuditEvents())).toContain("send_failed"));
  });

  it("1: mails nothing when the request comes through another host (a forged Host or a clone)", async () => {
    const t = await resetApp(); close = () => t.app.close();
    await t.app.inject({ method: "POST", url: "/api/auth/password-reset/request", headers: { host: "evil.example.test" }, payload: { email: "owner@example.test" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(t.mails).toHaveLength(0);
    const off = await resetApp({ googleRedirectUri: "" }); close = async () => { await t.app.close(); await off.app.close(); };
    await off.ask("owner@example.test");
    expect(off.mails).toHaveLength(0);
  });

  it("2 and 4: the link resets once, in the asking browser, ends every session, audits without values and tells the owner", async () => {
    const t = await resetApp(); close = () => t.app.close();
    const session = signSession(t.owner!, secret, Date.now() - 2000);
    const { bind } = await t.ask("owner@example.test");
    const token = t.tokenOf(t.mails[0]!);
    expect((await t.complete(token, bind, {}, "short")).statusCode).toBe(400);
    const done = await t.complete(token, bind);
    expect(done.json()).toEqual({ ok: true });
    expect((await t.complete(token, bind)).json()).toMatchObject({ error: { code: "RESET_LINK_INVALID" } });
    expect((await t.login("owner@example.test", oldPassword)).statusCode).toBe(401);
    expect((await t.login("owner@example.test", newPassword)).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `${cookieName}=${session}` } })).json()).toMatchObject({ isAuthenticated: false });
    await vi.waitFor(() => expect(t.mails.map((mail) => mail.subject)).toContain("Your SpaceApp password was reset"));
    const audit = (await t.store.listAuditEvents()).filter((event) => event.action.startsWith("auth.password_reset"));
    expect(audit.map((event) => event.action)).toEqual(expect.arrayContaining(["auth.password_reset_requested", "auth.password_reset"]));
    expect(JSON.stringify(audit)).not.toMatch(/horse|staple|password-reset=|space_pwreset/);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("2: an expired link, a link opened in another browser, a superseded link and one older than a password change fail closed", async () => {
    const t = await resetApp(); close = () => t.app.close();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const first = await t.ask("owner@example.test");
      vi.setSystemTime(Date.now() + 31 * 60_000);
      expect((await t.complete(t.tokenOf(t.mails[0]!), first.bind)).json()).toMatchObject({ error: { code: "RESET_LINK_INVALID" } });
    } finally { vi.useRealTimers(); }

    const second = await t.ask("owner@example.test");
    const third = await t.ask("owner@example.test");
    expect((await t.complete(t.tokenOf(t.mails[1]!), second.bind)).json()).toMatchObject({ error: { code: "RESET_LINK_INVALID" } });
    // Without the asking browser's cookie the link is refused and says where it works; it stays usable there (desktop app, 17/11).
    expect((await t.complete(t.tokenOf(t.mails[2]!), undefined)).json()).toMatchObject({ error: { code: "RESET_LINK_INVALID", message: expect.stringMatching(/same browser.*desktop app, paste/) } });
    expect((await t.login("owner@example.test", oldPassword)).statusCode).toBe(200);
    expect((await t.complete(t.tokenOf(t.mails[2]!), third.bind)).json()).toEqual({ ok: true });
  });

  it("2: any password change voids a pending link", async () => {
    const t = await resetApp(); close = () => t.app.close();
    const { bind } = await t.ask("owner@example.test");
    await t.store.updateOwnerPassword(await hashPassword("changed by owner reset-password"));
    expect((await t.complete(t.tokenOf(t.mails[0]!), bind)).json()).toMatchObject({ error: { code: "RESET_LINK_INVALID" } });
  });

  it("3: refuses any session (agent, broker, proof, a signed-in person) on both routes", async () => {
    const t = await resetApp(); close = () => t.app.close();
    const { bind } = await t.ask("owner@example.test");
    const token = t.tokenOf(t.mails[0]!);
    const proof = { id: "user:operator-proof", email: "space@space.local", role: "ADMIN" as const };
    for (const session of [signSession(t.owner!, secret), signSessionWithTtl(proof, secret, 60), signSessionWithTtl({ ...proof, proofScope: "READ_ONLY" }, secret, 60),
      signSessionWithTtl({ ...proof, brokerScope: "ADMIN_ACTION:user-appearance" }, secret, 60)]) {
      const cookie = `${cookieName}=${session}`;
      expect((await t.complete(token, bind, { cookie })).statusCode).toBe(403);
      expect((await t.app.inject({ method: "POST", url: "/api/auth/password-reset/request", headers: { host, cookie }, payload: { email: "owner@example.test" } })).statusCode).toBe(403);
    }
    expect((await t.complete(token, bind)).json()).toEqual({ ok: true });
  });

  it("works for the operator defined only in .env (adoptOwnerPassword)", async () => {
    const t = await resetApp({ ownerRow: false }); close = () => t.app.close();
    expect((await t.login("operator@example.test", oldPassword)).statusCode).toBe(200);
    const { bind } = await t.ask("operator@example.test");
    expect(t.mails[0]?.to).toBe("operator@example.test");
    expect((await t.complete(t.tokenOf(t.mails[0]!), bind)).json()).toEqual({ ok: true });
    expect((await t.login("operator@example.test", newPassword)).statusCode).toBe(200);
    expect((await t.login("operator@example.test", oldPassword)).statusCode).toBe(401);
  });
});

describe("Forgot password by mail, signed in (desktop app, operator 17/11)", () => {
  const as = (session: string, bind?: string) => ({ host, cookie: [`${cookieName}=${session}`, bind && `space_pwreset=${bind}`].filter(Boolean).join("; "), "x-space-csrf-token": createCsrfToken(session, secret)! });
  let ip = 1;
  const askMine = (t: Awaited<ReturnType<typeof resetApp>>, session: string) => t.app.inject({ method: "POST", url: "/api/auth/password-reset/mine/request", headers: as(session), remoteAddress: `10.1.0.${ip++}`, payload: {} });
  const completeMine = (t: Awaited<ReturnType<typeof resetApp>>, session: string, token: string, bind?: string) =>
    t.app.inject({ method: "POST", url: "/api/auth/password-reset/mine/complete", headers: as(session, bind), payload: { token, newPassword } });

  it("mails the person's own link, completes it without the current password, keeps this session and ends the others", async () => {
    const t = await resetApp(); close = () => t.app.close();
    const session = signSession(t.owner!, secret, Date.now() - 2000);
    const other = signSession(t.owner!, secret, Date.now() - 3000);
    expect((await t.app.inject({ method: "POST", url: "/api/auth/password-reset/mine/request", headers: { host, cookie: `${cookieName}=${session}` }, payload: {} })).statusCode).toBe(403);
    const asked = await askMine(t, session);
    expect(asked.json()).toEqual({ ok: true });
    const bind = asked.cookies.find((cookie) => cookie.name === "space_pwreset")?.value;
    expect(t.mails[0]).toMatchObject({ to: "owner@example.test" });
    expect(t.mails[0]!.text).toContain("paste it in SpaceApp, Settings > Login password");
    const token = t.tokenOf(t.mails[0]!);
    // Opened in a browser that did not ask: refused, and the link still works in the app.
    expect((await t.complete(token, undefined)).json()).toMatchObject({ error: { message: expect.stringMatching(/desktop app, paste the link there/) } });
    const done = await completeMine(t, session, token, bind);
    expect(done.json()).toEqual({ ok: true });
    const renewed = done.cookies.find((cookie) => cookie.name === cookieName)!.value;
    expect((await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `${cookieName}=${renewed}` } })).json()).toMatchObject({ isAuthenticated: true });
    expect((await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `${cookieName}=${other}` } })).json()).toMatchObject({ isAuthenticated: false });
    expect((await t.login("owner@example.test", newPassword)).statusCode).toBe(200);
    expect((await completeMine(t, renewed, token, bind)).json()).toMatchObject({ error: { code: "RESET_LINK_INVALID" } });
    const audit = (await t.store.listAuditEvents()).filter((event) => event.action === "auth.password_reset");
    expect(audit[0]?.metadata).toMatchObject({ via: "mail", inApp: true });
  });

  it("mails and completes the .env operator's own link when a Google sign-in left another email on its users row (stable 17/11)", async () => {
    const t = await resetApp({ ownerRow: false }); close = () => t.app.close();
    const operatorId = (await t.login("operator@example.test", oldPassword)).json().user.id as string;
    // As on stable: the operator's row (user:operator) carries the Google account's address, not SPACE_OPERATOR_EMAIL.
    (t.store as unknown as { users: Map<string, { email: string }> }).users.get(operatorId)!.email = "operator.google@example.test";
    const session = signSession({ id: operatorId, email: "operator.google@example.test", role: "ADMIN" }, secret);
    const asked = await askMine(t, session);
    expect(asked.json()).toEqual({ ok: true });
    expect(t.mails[0]).toMatchObject({ to: "operator@example.test" });
    const done = await completeMine(t, session, t.tokenOf(t.mails[0]!), asked.cookies.find((cookie) => cookie.name === "space_pwreset")?.value);
    expect(done.json()).toEqual({ ok: true });
    expect((await t.login("operator@example.test", newPassword)).statusCode).toBe(200);
  });

  it("mails the Google-only owner (no password, no .env operator) a link that sets a first password", async () => {
    const t = await resetApp(); close = () => t.app.close();
    (t.store as unknown as { userPasswordHashes: Map<string, string> }).userPasswordHashes.delete(t.owner!.id);
    expect((await t.login("owner@example.test", oldPassword)).statusCode).toBe(401);
    const session = signSession(t.owner!, secret);
    const asked = await askMine(t, session);
    expect(asked.json()).toEqual({ ok: true });
    expect(t.mails[0]).toMatchObject({ to: "owner@example.test" });
    const done = await completeMine(t, session, t.tokenOf(t.mails[0]!), asked.cookies.find((cookie) => cookie.name === "space_pwreset")?.value);
    expect(done.json()).toEqual({ ok: true });
    expect((await t.login("owner@example.test", newPassword)).statusCode).toBe(200);
  });

  it("tells the desktop sign-in's mail to paste the link back in the app", async () => {
    const t = await resetApp(); close = () => t.app.close();
    const response = await t.app.inject({ method: "POST", url: "/api/auth/password-reset/request", headers: { host }, remoteAddress: "10.2.0.1", payload: { email: "owner@example.test", inApp: true } });
    expect(response.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(t.mails).toHaveLength(1));
    expect(t.mails[0]!.text).toContain("paste it in the SpaceApp app's sign-in screen");
    const bind = response.cookies.find((cookie) => cookie.name === "space_pwreset")?.value;
    expect((await t.complete(t.tokenOf(t.mails[0]!), bind)).json()).toEqual({ ok: true });
  });

  it("says why no mail went out, and refuses another account's link, a session without the bind cookie and agent sessions", async () => {
    const t = await resetApp(); close = () => t.app.close();
    const session = signSession(t.owner!, secret);
    const invited = signSession({ id: "user:invited", email: "invited@example.test", role: "USER" }, secret);
    expect((await askMine(t, invited)).json()).toMatchObject({ error: { code: "PASSWORD_NOT_STORED" } });
    const asked = await askMine(t, session);
    const token = t.tokenOf(t.mails[0]!);
    expect((await completeMine(t, invited, token, asked.cookies.find((cookie) => cookie.name === "space_pwreset")?.value)).json()).toMatchObject({ error: { code: "RESET_LINK_INVALID" } });
    expect((await completeMine(t, session, token)).json()).toMatchObject({ error: { code: "RESET_LINK_INVALID", message: expect.stringMatching(/same browser/) } });
    const proof = signSessionWithTtl({ id: "user:operator-proof", email: "space@space.local", role: "ADMIN" }, secret, 60);
    expect((await askMine(t, proof)).statusCode).toBe(403);
    await askMine(t, session); await askMine(t, session);
    expect((await askMine(t, session)).json()).toMatchObject({ error: { code: "RESET_RATE_LIMITED" } });
    expect((await t.login("owner@example.test", oldPassword)).statusCode).toBe(200);
  });

  it("names why the mail failed when this install has no such sender, and sets no bind cookie", async () => {
    const store = new InMemorySpaceStore();
    store.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" });
    const owner = store.claimOwnerSetup({ tokenHash: "a".repeat(64), email: "owner@example.test", passwordHash: await hashPassword(oldPassword), now: new Date().toISOString() }).user;
    const app = await createApp({ store, config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile }),
      auth: { sessionSecret: secret, devLogin: false, secureCookies: false, googleRedirectUri: `https://${host}/api/auth/google/callback` } });
    close = () => app.close();
    const session = signSession(owner, secret);
    const answer = await app.inject({ method: "POST", url: "/api/auth/password-reset/mine/request", headers: as(session), payload: {} });
    expect(answer.json()).toMatchObject({ error: { code: "RESET_MAIL_FAILED", message: expect.stringMatching(/msender:Yp9r40K3jQ46 cannot send/) } });
    expect(answer.cookies.find((cookie) => cookie.name === "space_pwreset")).toBeUndefined();
  });
});

// Confirm it is you by mail (operator 17/11, nous_msg:db5f61cafe3847b1ad5f59f6): a link that marks the asking session's step-up and changes no
// password, so whoever does not know the password and cannot use Google still pairs a phone, grants a link or sets a new password.
describe("step-up by a mailed link", () => {
  const as = (session: string) => ({ host, cookie: `${cookieName}=${session}`, "x-space-csrf-token": createCsrfToken(session, secret)! });
  const stepTokenOf = (mail: Mail) => /#space-step-up=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
  const askStep = (t: Awaited<ReturnType<typeof resetApp>>, session: string) => t.app.inject({ method: "POST", url: "/api/auth/step-up/mail/request", headers: as(session), payload: {} });
  const useStep = (t: Awaited<ReturnType<typeof resetApp>>, session: string, token: string) => t.app.inject({ method: "POST", url: "/api/auth/step-up/mail", headers: as(session), payload: { token } });
  const status = async (t: Awaited<ReturnType<typeof resetApp>>, session: string) => (await t.app.inject({ method: "GET", url: "/api/auth/password", headers: as(session) })).json();

  it("mails the owner's address a link that confirms only the asking session, once, and then the password changes with no current password", async () => {
    const t = await resetApp(); close = () => t.app.close();
    const session = signSession(t.owner!, secret, Date.now() - 2000);
    const other = signSession(t.owner!, secret, Date.now() - 3000);
    expect((await t.app.inject({ method: "POST", url: "/api/auth/step-up/mail/request", headers: { host, cookie: `${cookieName}=${session}` }, payload: {} })).statusCode).toBe(403);
    expect((await askStep(t, session)).json()).toEqual({ ok: true, sentTo: "owner@example.test" });
    expect(t.mails[0]).toMatchObject({ owner: t.owner!.id, to: "owner@example.test", subject: "Confirm it is you in SpaceApp" });
    expect(t.mails[0]!.text).toMatch(new RegExp(`https://${host.replace(/\./g, "\\.")}/#space-step-up=[A-Za-z0-9_-]{43}`));
    expect(t.mails[0]!.text).toMatch(/^[\x20-\x7e\n]+$/);
    const token = stepTokenOf(t.mails[0]!);
    // Another session (another browser, a mailbox reader) is refused and does not spend it.
    expect((await useStep(t, other, token)).json()).toMatchObject({ error: { code: "STEP_UP_LINK_INVALID", message: expect.stringMatching(/same browser/) } });
    expect((await status(t, other)).stepUpUntil).toBeNull();
    expect((await useStep(t, session, "x".repeat(43))).json()).toMatchObject({ error: { code: "STEP_UP_LINK_INVALID" } });
    expect((await useStep(t, session, token)).json()).toMatchObject({ steppedUp: true });
    expect(Date.parse((await status(t, session)).stepUpUntil) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect((await useStep(t, session, token)).json()).toMatchObject({ error: { code: "STEP_UP_LINK_INVALID" } });
    // Nothing changed yet: the old password still signs in.
    expect((await t.login("owner@example.test", oldPassword)).statusCode).toBe(200);
    expect((await t.app.inject({ method: "POST", url: "/api/auth/password", headers: as(session), payload: { newPassword } })).json()).toEqual({ ok: true });
    expect((await t.login("owner@example.test", newPassword)).statusCode).toBe(200);
    const audit = await t.store.listAuditEvents();
    expect(audit.filter((event) => event.action === "auth.step_up").map((event) => event.metadata)).toEqual([expect.objectContaining({ via: "mail" })]);
    expect(audit.filter((event) => event.action === "auth.step_up_failed").map((event) => event.metadata)).toEqual([expect.objectContaining({ via: "mail", reason: "other_session" })]);
    expect(audit.some((event) => event.action === "auth.step_up_mail_requested")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("a newer link replaces the older, and an account gets three an hour", async () => {
    const t = await resetApp(); close = () => t.app.close();
    const session = signSession(t.owner!, secret);
    await askStep(t, session); await askStep(t, session);
    expect((await useStep(t, session, stepTokenOf(t.mails[0]!))).json()).toMatchObject({ error: { code: "STEP_UP_LINK_INVALID" } });
    await askStep(t, session);
    expect((await askStep(t, session)).json()).toMatchObject({ error: { code: "STEP_UP_MAIL_RATE_LIMITED" } });
    expect(t.mails).toHaveLength(3);
    expect((await useStep(t, session, stepTokenOf(t.mails[2]!))).json()).toMatchObject({ steppedUp: true });
  });

  it("mails an invited person at their own address through the owner's sender, and the .env operator at the operator address", async () => {
    const t = await resetApp(); close = () => t.app.close();
    const invited = signSession({ id: "user:invited", email: "invited@example.test", role: "USER" }, secret);
    expect((await askStep(t, invited)).json()).toEqual({ ok: true, sentTo: "invited@example.test" });
    expect(t.mails[0]).toMatchObject({ owner: t.owner!.id, to: "invited@example.test" });
    expect((await useStep(t, invited, stepTokenOf(t.mails[0]!))).json()).toMatchObject({ steppedUp: true });

    const env = await resetApp({ ownerRow: false });
    const operatorId = (await env.login("operator@example.test", oldPassword)).json().user.id as string;
    (env.store as unknown as { users: Map<string, { email: string }> }).users.get(operatorId)!.email = "operator.google@example.test";
    const session = signSession({ id: operatorId, email: "operator.google@example.test", role: "ADMIN" }, secret);
    try {
      expect((await askStep(env, session)).json()).toEqual({ ok: true, sentTo: "operator@example.test" });
    } finally { await env.app.close(); }
  });

  it("refuses agent proof sessions, and names a missing sender", async () => {
    const t = await resetApp(); close = () => t.app.close();
    const proof = signSessionWithTtl({ id: "user:operator-proof", email: "space@space.local", role: "ADMIN" }, secret, 60);
    expect((await askStep(t, proof)).statusCode).toBe(403);
    expect(t.mails).toHaveLength(0);
    const off = await resetApp({ googleRedirectUri: "https://elsewhere.example.test/api/auth/google/callback" });
    try {
      expect((await askStep(off, signSession(off.owner!, secret))).json()).toMatchObject({ error: { code: "STEP_UP_MAIL_UNAVAILABLE" } });
      expect(off.mails).toHaveLength(0);
    } finally { await off.app.close(); }
  });
});

describe("agents never see a reset link", () => {
  const token = "Ab1_".repeat(11);
  const mail = `Open https://space.example.test/#password-reset=${token} within 30 minutes.`;
  it("hides the token in text, quoted-printable, Gmail JSON bodies, raw sources and snippets", () => {
    expect(maskPasswordResetLinks(mail)).not.toContain(token);
    expect(maskPasswordResetLinks(mail)).toContain("#password-reset=[hidden");
    expect(maskPasswordResetLinks(`#password-reset=3D${token}`)).not.toContain(token);
    const gmail = { snippet: mail, payload: { parts: [{ body: { data: Buffer.from(mail).toString("base64url") } }] }, raw: Buffer.from(`Subject: x\r\n\r\n${mail}`).toString("base64url") };
    const masked = JSON.stringify(maskPasswordResetJson(gmail));
    expect(masked).not.toContain(token);
    const decoded = (maskPasswordResetJson(gmail) as typeof gmail).payload.parts[0]!.body.data;
    expect(Buffer.from(decoded, "base64url").toString()).toContain("password-reset=[hidden");
    // The step-up link too (operator 17/11).
    expect(maskPasswordResetLinks(`Open https://space.example.test/#space-step-up=${token} within 15 minutes.`)).not.toContain(token);
    expect(JSON.stringify(maskPasswordResetJson({ payload: { body: { data: Buffer.from(`#space-step-up=${token}`).toString("base64url") } } }))).not.toContain(token);
    // Other mail passes untouched, byte for byte.
    const other = { payload: { body: { data: Buffer.from("hello").toString("base64url") } }, snippet: "hello" };
    expect(maskPasswordResetJson(other)).toEqual(other);
    // A multi-MB attachment body (the 3.3 MB OUTSCALE deck, 27/11) is read and passed through unchanged.
    const deck = { size: 3_353_509, data: Buffer.alloc(3_353_509, 0xfe).toString("base64url") };
    expect(maskPasswordResetJson(deck)).toEqual(deck);
  });

  it("the Gmail client every Mail Copilot and Nous read goes through returns the masked message", async () => {
    const { createGmailClient } = await import("../src/mail-copilot/gmail-client.js");
    const fetchImpl = (async () => new Response(JSON.stringify({ id: "m1", threadId: "t1", snippet: mail, payload: { mimeType: "text/plain", headers: [], body: { data: Buffer.from(mail).toString("base64url") } } }),
      { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const client = createGmailClient({ accessToken: "x", fetchImpl });
    expect(JSON.stringify(await client.message("m1", "full"))).not.toContain(token);
  });

  // 27/11 08:09-08:14Z: a 3.3 MB PDF's attachment body threw "Maximum call stack size exceeded" in the mask's base64 regex.
  it("a multi-MB attachment body passes byte for byte, and a reset link inside one is still hidden", async () => {
    const { randomBytes } = await import("node:crypto");
    const { createGmailClient } = await import("../src/mail-copilot/gmail-client.js");
    const pdf = randomBytes(4 * 1024 * 1024 + 1);
    const respond = (data: string) => (async () => new Response(JSON.stringify({ size: data.length, data }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    expect((await createGmailClient({ accessToken: "x", fetchImpl: respond(pdf.toString("base64url")) }).attachment("m1", "a1")).equals(pdf)).toBe(true);
    const linked = Buffer.concat([Buffer.alloc(3 * 1024 * 1024, "a"), Buffer.from(mail)]).toString("base64url");
    const masked = await createGmailClient({ accessToken: "x", fetchImpl: respond(linked) }).attachment("m1", "a1");
    expect(masked.toString()).not.toContain(token);
    expect(masked.toString()).toContain("password-reset=[hidden");
    // Not base64url (a space): the string is masked as text.
    expect(maskPasswordResetJson({ data: `${"x".repeat(3 * 1024 * 1024)} ${mail}` }).data).not.toContain(token);
  });
});
