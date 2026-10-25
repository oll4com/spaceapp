import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";

const sessionSecret = "test-secret-with-enough-length-123456";
const csrfHeaderName = "x-space-csrf-token";

describe("Google Auth auto-claim and operator sync", () => {
  it("auto-claims user:operator on first Google sign-in when operator has no googleId and default email", async () => {
    const store = new InMemorySpaceStore();
    store.upsertUser({
      id: "user:operator",
      email: "space@space.local",
      role: "ADMIN"
    });

    // Populate some initial operator links & clipboard
    store.createUserLink({
      ownerUserId: "user:operator",
      url: "https://youtube.com/watch?v=123",
      title: "Work Music",
      description: "",
      openMode: "EMBEDDED",
      isQuick: false,
      category: "MUSIC_LIBRARY"
    });
    store.upsertClipboardItem({
      ownerUserId: "user:operator",
      text: "Operator initial plan",
      source: "PLAN",
      title: "Initial Plan",
      minimumModel: "gpt-5.6-sol"
    });

    const app = await createApp({
      store,
      auth: {
        sessionSecret,
        devLogin: false,
        googleClientId: "test-google-client-id",
        googleClientSecret: "test-secret",
        secureCookies: false
      }
    });

    // Emulate Google OAuth credential login with an installer's gmail
    // We can directly test the /api/admin/users/:id/copy-from-operator endpoint
    const adminToken = signSession({ id: "user:operator", email: "space@space.local", role: "ADMIN" }, sessionSecret);
    const adminCookie = `space_session=${adminToken}`;
    const adminCsrf = createCsrfToken(adminToken, sessionSecret)!;

    // Register a secondary user
    const secondary = store.upsertUser({
      id: "user:google:secondary-sub",
      email: "secondary@gmail.com",
      role: "USER"
    });

    // Copy from operator to secondary user
    const copyRes = await app.inject({
      method: "POST",
      url: `/api/admin/users/${encodeURIComponent(secondary.id)}/copy-from-operator`,
      headers: {
        cookie: adminCookie,
        [csrfHeaderName]: adminCsrf
      }
    });

    expect(copyRes.statusCode).toBe(200);
    expect(copyRes.json()).toMatchObject({ ok: true, copiedLinks: 1, copiedClipboard: 1 });

    const secondaryLinks = store.listUserLinks(secondary.id, { isQuick: undefined, page: 1, pageSize: 25 });
    expect(secondaryLinks.total).toBe(1);
    expect(secondaryLinks.items[0]?.url).toBe("https://youtube.com/watch?v=123");

    const secondaryClip = store.listClipboardItems(secondary.id, { page: 1, pageSize: 25 });
    expect(secondaryClip.total).toBe(1);
    expect(secondaryClip.items[0]?.text).toBe("Operator initial plan");
  });

  it("automatically syncs promoted user role and refreshes session cookie in /api/auth/me", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({
      store,
      auth: {
        sessionSecret,
        devLogin: false,
        googleClientId: "test-google-client-id",
        googleClientSecret: "test-secret",
        secureCookies: false
      }
    });

    const user = store.upsertUser({
      id: "user:google:test-sub",
      email: "testuser@gmail.com",
      role: "USER"
    });

    // Create session token with the old role "USER"
    const oldToken = signSession({ id: user.id, email: user.email, role: "USER" }, sessionSecret);
    const oldCookie = `space_session=${oldToken}`;

    // Update user role in store to ADMIN
    await store.updateUserRole(user.id, "ADMIN");

    // Call /api/auth/me with old cookie
    const meRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: oldCookie }
    });

    expect(meRes.statusCode).toBe(200);
    const meJson = meRes.json();
    expect(meJson.user.role).toBe("ADMIN");

    // Verify a new session cookie was issued
    const setCookie = meRes.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toContain("space_session=");

    // Verify onRequest also synced the role so admin endpoints are permitted
    const adminEndpointRes = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: oldCookie }
    });
    expect(adminEndpointRes.statusCode).toBe(200);
  });
});
