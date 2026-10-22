import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

const secret = "session-renewal-test-secret";
const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"));

it("moves a cookie issued before the 30-day change to the new lifetime on its next request, without cutting it (security addendum step 12)", async () => {
  const app = await createApp({ store: new InMemorySpaceStore(), config: getApiConfig({ SPACE_LOG_LEVEL: "silent" }), auth: { sessionSecret: secret, devLogin: true, secureCookies: false } });
  try {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
    const fresh = login.cookies.find((cookie) => cookie.name === "space_session")!;
    expect(fresh.maxAge).toBe(30 * 24 * 3600);
    const user = payloadOf(fresh.value).user;
    // A fresh session is not renewed on use.
    const quiet = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `space_session=${fresh.value}` } });
    expect(quiet.cookies.find((cookie) => cookie.name === "space_session")).toBeUndefined();

    const now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({ user, exp: now + 390 * 24 * 3600, iat: now - 10 * 24 * 3600 })).toString("base64url");
    const legacy = `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
    const legacyCsrf = createCsrfToken(legacy, secret)!;
    const first = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `space_session=${legacy}` } });
    expect(first.json().isAuthenticated, first.body).toBe(true);
    const renewed = first.cookies.find((cookie) => cookie.name === "space_session")!;
    expect(payloadOf(renewed.value)).toMatchObject({ v: 2, iat: now - 10 * 24 * 3600 });
    expect(payloadOf(renewed.value).exp).toBeLessThanOrEqual(now + 30 * 24 * 3600 + 5);
    expect(renewed.maxAge).toBe(30 * 24 * 3600);
    // The old cookie still works (a tab sending it in parallel is not logged out) ...
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `space_session=${legacy}` } })).json().isAuthenticated).toBe(true);
    // ... and the CSRF token that tab fetched before the renewal fits the renewed cookie.
    const write = await app.inject({ method: "PATCH", url: "/api/user-settings", headers: { cookie: `space_session=${renewed.value}`, "x-space-csrf-token": legacyCsrf }, payload: { uiTheme: "aurora" } });
    expect(write.statusCode, write.body).toBe(200);
  } finally {
    await app.close();
  }
});
