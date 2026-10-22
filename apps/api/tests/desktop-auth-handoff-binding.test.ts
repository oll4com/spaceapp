import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";

// Desktop Google sign-in (run-spaceapp 1.1.7 review, Codex finding 1): a handoff id chosen by whoever opens the start link
// must never receive the session. The session goes only to the desktop app's loopback listener on the machine where the
// sign-in happened, as a one-time code that needs the PKCE verifier the desktop app kept.
const secret = "desktop-handoff-test-secret-123456789";
const clientId = "desktop-handoff-client";
const googleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...googleKey.publicKey.export({ format: "jwk" }), kid: "handoff-kid", alg: "RS256", use: "sig" }] };
function idToken(sub: string) {
  const claims = { sub, email: `${sub}@example.test`, aud: clientId, iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 600, email_verified: true };
  const body = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "handoff-kid", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return { claims, token: `${body}.${createSign("RSA-SHA256").update(body).sign(googleKey.privateKey).toString("base64url")}` };
}
function google(token: string) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ id_token: token });
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json(jwks, { headers: { "cache-control": "public, max-age=3600" } });
    throw Error("Unexpected external request in desktop handoff test");
  }));
}
afterEach(() => vi.unstubAllGlobals());

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

describe("desktop Google sign-in handoff", () => {
  const store = new InMemorySpaceStore();
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    app = await createApp({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "false" }), auth: { sessionSecret: secret, devLogin: false, secureCookies: false, googleClientId: clientId } });
  }, 30_000);
  afterAll(async () => { await app?.close(); }, 30_000);

  function linkedOwner() {
    const actor = store.upsertUser({ id: `user:${randomUUID()}`, email: `${randomUUID()}@example.test`, role: "ADMIN" });
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
  const startPath = (id: string, port: number, challenge: string) =>
    `/api/auth/google/start?desktopHandoff=${id}&desktopPort=${port}&desktopChallenge=${challenge}`;
  const redeem = (payload: object) => app.inject({ method: "POST", url: "/api/auth/desktop-handoff", payload });

  it("refuses a desktop handoff that is not bound to a loopback listener and a PKCE challenge", async () => {
    const res = await app.inject({ method: "GET", url: `/api/auth/google/start?desktopHandoff=${randomBytes(16).toString("hex")}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code ?? res.json().code).toBe("DESKTOP_HANDOFF_UNBOUND");
    expect(res.cookies.find(c => c.name === "space_oauth_state")?.value ?? "").toBe("");
  });

  it("no longer hands a session to whoever polls with the handoff id", async () => {
    const res = await app.inject({ method: "GET", url: `/api/auth/desktop-handoff?handoffId=${randomBytes(16).toString("hex")}` });
    // The GET poll is gone: without a session the request is refused before routing, and nothing carries a token.
    expect([401, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain("token");
  });

  it("sends the one-time code to the loopback listener and redeems it once with the verifier", async () => {
    const { actor, token } = linkedOwner();
    const id = randomBytes(16).toString("hex"), { verifier, challenge } = pkce();
    const { callback } = await signIn(startPath(id, 49152, challenge), token);
    expect(callback.statusCode).toBe(302);
    const location = new URL(callback.headers.location as string);
    expect(location.origin).toBe("http://127.0.0.1:49152");
    expect(location.searchParams.get("handoff")).toBe(id);
    const code = location.searchParams.get("code")!;
    const ok = await redeem({ handoffId: id, code, codeVerifier: verifier });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ authenticated: true, user: { id: actor.id } });
    expect(typeof ok.json().token).toBe("string");
    expect((await redeem({ handoffId: id, code, codeVerifier: verifier })).json()).toEqual({ authenticated: false });
  });

  it("gives the initiator of a crafted link nothing when someone else completes the sign-in", async () => {
    const { token } = linkedOwner();
    // The attacker picks the id, the port and the challenge, and keeps the verifier; the owner opens the link and signs in.
    const id = randomBytes(16).toString("hex"), attacker = pkce();
    const { callback } = await signIn(startPath(id, 50123, attacker.challenge), token);
    // The code went to the owner's own 127.0.0.1:50123, which the attacker cannot read.
    expect(new URL(callback.headers.location as string).hostname).toBe("127.0.0.1");
    expect((await redeem({ handoffId: id, codeVerifier: attacker.verifier })).json()).toEqual({ authenticated: false });
    expect((await redeem({ handoffId: id, code: "x".repeat(43), codeVerifier: attacker.verifier })).json()).toEqual({ authenticated: false });
  });

  it("burns the code when the verifier does not match", async () => {
    const { token } = linkedOwner();
    const id = randomBytes(16).toString("hex"), { verifier, challenge } = pkce();
    const { callback } = await signIn(startPath(id, 49153, challenge), token);
    const code = new URL(callback.headers.location as string).searchParams.get("code")!;
    expect((await redeem({ handoffId: id, code, codeVerifier: pkce().verifier })).json()).toEqual({ authenticated: false });
    expect((await redeem({ handoffId: id, code, codeVerifier: verifier })).json()).toEqual({ authenticated: false });
  });
});
