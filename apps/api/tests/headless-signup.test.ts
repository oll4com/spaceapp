import { createSign, generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";

// K2 §4 invite-gated sign-up through the real Google start and callback routes; Google is a stubbed fetch, nothing leaves the process.
const secret = "headless-signup-test-secret-123456789";
const clientId = "headless-signup-client";
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...key.publicKey.export({ format: "jwk" }), kid: "kid", alg: "RS256", use: "sig" }] };
function google(sub: string, email: string) {
  const body = [{ alg: "RS256", kid: "kid", typ: "JWT" }, { sub, email, aud: clientId, iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 600, email_verified: true }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
  const idToken = `${body}.${createSign("RSA-SHA256").update(body).sign(key.privateKey).toString("base64url")}`;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ id_token: idToken });
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json(jwks);
    throw Error(`Unexpected external request ${url}`);
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe("headless invite-gated Google sign-up", () => {
  const store = new InMemorySpaceStore();
  const signUps: unknown[] = [];
  // The Postgres store is proven in packages/db/tests/signup-invite-postgres.test.ts; here only invited@ has an invite.
  store.signUpWithGoogleInvite = (input) => {
    signUps.push(input);
    return input.identity.email === "invited@example.test"
      ? store.upsertUser({ id: "user:invited", email: input.identity.email, role: "USER", googleId: input.identity.sub }) : null;
  };
  const build = (overrides: object) => createApp({ store, config: { ...getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_BROWSER_SESSIONS_ENABLED: "false" }), ...overrides },
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false, googleClientId: clientId } });
  let headless: Awaited<ReturnType<typeof createApp>>, closed: Awaited<ReturnType<typeof createApp>>, selfHosted: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    [headless, closed, selfHosted] = await Promise.all([build({ headless: true, signupTermsVersion: "terms-1" }), build({ headless: true }), build({ headless: false })]);
  }, 60_000);
  afterAll(async () => { await Promise.all([headless?.close(), closed?.close(), selfHosted?.close()]); }, 30_000);

  async function flow(query: string, sub: string, email: string) {
    const start = await headless.inject({ method: "GET", url: `/api/auth/google/start?${query}` });
    expect(start.statusCode, start.body).toBe(302);
    const state = start.cookies.find((cookie) => cookie.name === "space_oauth_state")!.value;
    google(sub, email);
    return headless.inject({ method: "GET", url: `/api/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: start.cookies.filter((cookie) => cookie.value).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") } });
  }
  const session = (res: { cookies: Array<{ name: string; value: string }> }) => res.cookies.find((cookie) => cookie.name === "space_session" && cookie.value);

  it("starts a sign-up only with the current terms and 18+, and only where sign-up is open", async () => {
    const code = async (app: typeof headless, query: string) => {
      const res = await app.inject({ method: "GET", url: `/api/auth/google/start?${query}` });
      return res.statusCode === 302 ? 302 : res.json().error?.code ?? res.json().code;
    };
    expect(await code(headless, "signup=1&terms=terms-1&adult=1")).toBe(302);
    expect(await code(headless, "signup=1&terms=terms-1")).toBe("SIGNUP_TERMS_REQUIRED");
    expect(await code(headless, "signup=1&terms=terms-0&adult=1")).toBe("SIGNUP_TERMS_REQUIRED");
    expect(await code(headless, "signup=1&adult=1")).toBe("SIGNUP_TERMS_REQUIRED");
    expect(await code(headless, "signup=1&terms=terms-1&adult=1&reset=password")).toBe("SIGNUP_UNAVAILABLE");
    expect(await code(closed, "signup=1&terms=terms-1&adult=1")).toBe("SIGNUP_UNAVAILABLE");
    expect(await code(selfHosted, "signup=1&terms=terms-1&adult=1")).toBe("SIGNUP_UNAVAILABLE");
  });

  it("makes the account for an invited email, refuses others, and a plain sign-in never makes one", async () => {
    const plain = await flow("", "sub-new", "invited@example.test");
    expect(session(plain)).toBeUndefined();
    expect(decodeURIComponent(plain.headers.location as string)).toContain("No account yet");
    expect(signUps).toHaveLength(0);

    const stranger = await flow("signup=1&terms=terms-1&adult=1", "sub-stranger", "stranger@example.test");
    expect(session(stranger)).toBeUndefined();
    expect(decodeURIComponent(stranger.headers.location as string)).toContain("by invitation");

    const invited = await flow("signup=1&terms=terms-1&adult=1", "sub-new", "invited@example.test");
    expect(session(invited)).toBeDefined();
    expect(signUps.at(-1)).toMatchObject({ identity: { sub: "sub-new", email: "invited@example.test" }, termsVersion: "terms-1", region: "eu" });
    // From now on it is a plain sign-in: the account exists.
    const again = await flow("", "sub-new", "invited@example.test");
    expect(session(again)).toBeDefined();
    expect(signUps).toHaveLength(2);
  });
});
