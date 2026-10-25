import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

describe("User settings API", () => {
  it("rejects unauthenticated requests to user settings endpoints", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({
      store,
      auth: {
        sessionSecret: "test-session-secret-with-enough-length",
        devLogin: false,
        secureCookies: false
      },
      config: getApiConfig({
        SPACE_ROOT_DIR: "/opt/spaceapp",
        SPACE_VAR_DIR: "/opt/spaceapp/var"
      })
    });

    const getRes = await app.inject({
      method: "GET",
      url: "/api/user-settings"
    });
    expect(getRes.statusCode).toBe(401);

    const patchRes = await app.inject({
      method: "PATCH",
      url: "/api/user-settings",
      payload: { uiTheme: "classic" }
    });
    expect(patchRes.statusCode).toBe(401);
  });

  it("returns default settings and allows updates for authenticated user", async () => {
    const store = new InMemorySpaceStore();
    const sessionSecret = "test-session-secret-with-enough-length";
    const user = { id: "user:operator", email: "operator@example.com", role: "ADMIN" as const };
    const sessionToken = signSession(user, sessionSecret);
    const csrfToken = createCsrfToken(sessionToken, sessionSecret)!;

    const app = await createApp({
      store,
      auth: {
        sessionSecret,
        devLogin: false,
        secureCookies: false
      },
      config: getApiConfig({
        SPACE_ROOT_DIR: "/opt/spaceapp",
        SPACE_VAR_DIR: "/opt/spaceapp/var"
      })
    });

    // 1. Initial GET
    const getRes = await app.inject({
      method: "GET",
      url: "/api/user-settings",
      headers: {
        cookie: `${cookieName}=${sessionToken}`
      }
    });
    expect(getRes.statusCode).toBe(200);
    const initial = getRes.json();
    expect(initial.uiTheme).toBe("modern");
    expect(initial.dateTime.timeZone).toBe("Asia/Bangkok");

    // 2. PATCH
    const patchRes = await app.inject({
      method: "PATCH",
      url: "/api/user-settings",
      headers: {
        cookie: `${cookieName}=${sessionToken}`,
        [csrfHeaderName]: csrfToken
      },
      payload: {
        uiTheme: "codex",
        suppressNotifications: true,
        dateTime: { timeFormat: "12h" }
      }
    });
    expect(patchRes.statusCode).toBe(200);
    const updated = patchRes.json();
    expect(updated.uiTheme).toBe("codex");
    expect(updated.suppressNotifications).toBe(true);
    expect(updated.dateTime.timeFormat).toBe("12h");
    expect(updated.dateTime.timeZone).toBe("Asia/Bangkok");

    // 3. /api/auth/me includes settings
    const meRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        cookie: `${cookieName}=${sessionToken}`
      }
    });
    expect(meRes.statusCode).toBe(200);
    const meData = meRes.json();
    expect(meData.isAuthenticated).toBe(true);
    expect(meData.settings).toBeDefined();
    expect(meData.settings.uiTheme).toBe("codex");
    expect(meData.settings.suppressNotifications).toBe(true);

    // 4. Test alias /api/user/settings and new per-user fields
    const aliasPatchRes = await app.inject({
      method: "PATCH",
      url: "/api/user/settings",
      headers: {
        cookie: `${cookieName}=${sessionToken}`,
        [csrfHeaderName]: csrfToken
      },
      payload: {
        docksHidden: ["tasks", "links"],
        panesHidden: ["vnc"],
        uiZoom: 120,
        worktreeDefaultEnabled: false,
        vibeMusicVolume: 0.9,
        vibeMusicPlaylistLinkId: "test-playlist"
      }
    });
    expect(aliasPatchRes.statusCode).toBe(200);
    const aliasUpdated = aliasPatchRes.json();
    expect(aliasUpdated.docksHidden).toEqual(["tasks", "links"]);
    expect(aliasUpdated.panesHidden).toEqual(["vnc"]);
    expect(aliasUpdated.uiZoom).toBe(120);
    expect(aliasUpdated.worktreeDefaultEnabled).toBe(false);
    expect(aliasUpdated.vibeMusicVolume).toBe(0.9);
    expect(aliasUpdated.vibeMusicPlaylistLinkId).toBe("test-playlist");

    const aliasGetRes = await app.inject({
      method: "GET",
      url: "/api/user/settings",
      headers: {
        cookie: `${cookieName}=${sessionToken}`
      }
    });
    expect(aliasGetRes.statusCode).toBe(200);
    expect(aliasGetRes.json().uiZoom).toBe(120);
  });

  it("remembers the Job Copilot default agent for every device and forgets it with null", async () => {
    const store = new InMemorySpaceStore();
    const sessionSecret = "test-session-secret-with-enough-length";
    const user = { id: "user:operator", email: "operator@example.com", role: "ADMIN" as const };
    const sessionToken = signSession(user, sessionSecret);
    const csrfToken = createCsrfToken(sessionToken, sessionSecret)!;
    const app = await createApp({
      store,
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      config: getApiConfig({ SPACE_ROOT_DIR: "/opt/spaceapp", SPACE_VAR_DIR: "/opt/spaceapp/var" })
    });
    const patch = (payload: unknown) => app.inject({
      method: "PATCH",
      url: "/api/user-settings",
      headers: { cookie: `${cookieName}=${sessionToken}`, [csrfHeaderName]: csrfToken },
      payload
    });
    const read = async () => (await app.inject({ method: "GET", url: "/api/user-settings", headers: { cookie: `${cookieName}=${sessionToken}` } })).json();

    expect((await read()).jobCopilot).toBeUndefined();
    expect((await patch({ jobCopilot: { runtimeId: "cli:claude", accountProfileId: "space-gateway", askOnLaunch: false } })).statusCode).toBe(200);
    expect((await read()).jobCopilot).toEqual({ runtimeId: "cli:claude", accountProfileId: "space-gateway", askOnLaunch: false });
    // Other settings leave the default alone.
    expect((await patch({ uiZoom: 110 })).statusCode).toBe(200);
    expect((await read()).jobCopilot).toEqual({ runtimeId: "cli:claude", accountProfileId: "space-gateway", askOnLaunch: false });
    expect((await patch({ jobCopilot: { runtimeId: "claude", askOnLaunch: false } })).statusCode).toBe(422);
    expect((await patch({ jobCopilot: null })).statusCode).toBe(200);
    expect((await read()).jobCopilot ?? null).toBeNull();
    await app.close();
  });

  // Zod 4 filled the group's defaults inside .partial(): a PATCH naming one field reset the rest (2026-10-17).
  it.each([
    ["dateTime", { timeZone: "Europe/Athens" }, { timeFormat: "12h" }],
    ["voice", { insertMode: "replace" }, { enabled: false }],
    ["livePane", { voiceOnly: true }, { showToolCalls: true }],
    ["keyboardAutocorrect", { soundEnabled: false }, { enabled: false }]
  ] as const)("a %s PATCH saves only the fields it sends", async (group, first, second) => {
    const sessionSecret = "test-session-secret-with-enough-length";
    const sessionToken = signSession({ id: "user:operator", email: "operator@example.com", role: "ADMIN" }, sessionSecret);
    const app = await createApp({
      store: new InMemorySpaceStore(),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      config: getApiConfig({ SPACE_ROOT_DIR: "/opt/spaceapp", SPACE_VAR_DIR: "/opt/spaceapp/var" })
    });
    const headers = { cookie: `${cookieName}=${sessionToken}`, [csrfHeaderName]: createCsrfToken(sessionToken, sessionSecret)! };
    expect((await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { [group]: first } })).statusCode).toBe(200);
    const saved = await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { [group]: second } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()[group]).toMatchObject({ ...first, ...second });
    expect((await app.inject({ method: "GET", url: "/api/user-settings", headers })).json()[group]).toMatchObject({ ...first, ...second });
    await app.close();
  });
});
