import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { cookieName, hashPassword, signSession, signSessionWithTtl } from "../src/auth.js";
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

async function resetApp(options: { env?: Record<string, string>; ownerRow?: boolean; googleRedirectUri?: string } = {}) {
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
    passwordResetMail: async (owner, to, subject, text) => { mails.push({ owner, to, subject, text }); } });
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
    // Without the asking browser's cookie the link is refused, and the try spends it.
    expect((await t.complete(t.tokenOf(t.mails[2]!), undefined)).json()).toMatchObject({ error: { code: "RESET_LINK_INVALID", message: expect.stringMatching(/same browser/) } });
    expect((await t.complete(t.tokenOf(t.mails[2]!), third.bind)).statusCode).toBe(400);
    expect((await t.login("owner@example.test", oldPassword)).statusCode).toBe(200);
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
    // Other mail passes untouched, byte for byte.
    const other = { payload: { body: { data: Buffer.from("hello").toString("base64url") } }, snippet: "hello" };
    expect(maskPasswordResetJson(other)).toEqual(other);
  });

  it("the Gmail client every Mail Copilot and Nous read goes through returns the masked message", async () => {
    const { createGmailClient } = await import("../src/mail-copilot/gmail-client.js");
    const fetchImpl = (async () => new Response(JSON.stringify({ id: "m1", threadId: "t1", snippet: mail, payload: { mimeType: "text/plain", headers: [], body: { data: Buffer.from(mail).toString("base64url") } } }),
      { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const client = createGmailClient({ accessToken: "x", fetchImpl });
    expect(JSON.stringify(await client.message("m1", "full"))).not.toContain(token);
  });
});
