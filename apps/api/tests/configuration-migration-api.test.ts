import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { spaceConfigBundleSchema } from "@space/contracts";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

describe("Configuration Migration API", () => {
  it("rejects unauthenticated requests to configuration endpoints", async () => {
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

    const exportRes = await app.inject({
      method: "GET",
      url: "/api/configuration/export"
    });
    expect(exportRes.statusCode).toBe(401);

    const inspectRes = await app.inject({
      method: "POST",
      url: "/api/configuration/inspect",
      payload: {}
    });
    expect(inspectRes.statusCode).toBe(401);

    const importRes = await app.inject({
      method: "POST",
      url: "/api/configuration/import",
      payload: {}
    });
    expect(importRes.statusCode).toBe(401);
  });

  it("exports, inspects, and imports configuration bundle for authenticated operator", async () => {
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

    // 1. Setup sample data in store
    const room = await store.createRoom({ name: "Export Room 1" });
    await store.createUserLink({
      ownerUserId: user.id,
      url: "https://example.com/test",
      title: "Test Bookmark"
    });
    await store.upsertClipboardItem({
      ownerUserId: user.id,
      text: "Sample text content",
      source: "MANUAL_NOTE"
    });

    // 2. Export configuration via GET
    const exportGetRes = await app.inject({
      method: "GET",
      url: "/api/configuration/export",
      headers: {
        cookie: `${cookieName}=${sessionToken}`
      }
    });
    expect(exportGetRes.statusCode).toBe(200);
    expect(exportGetRes.headers["content-disposition"]).toContain("attachment; filename=");
    const bundle = exportGetRes.json();
    const parseResult = spaceConfigBundleSchema.safeParse(bundle);
    expect(parseResult.success).toBe(true);
    expect(bundle.metadata.roomsCount).toBeGreaterThanOrEqual(1);
    expect(bundle.metadata.userLinksCount).toBe(1);
    expect(bundle.metadata.clipboardItemsCount).toBe(1);

    // 3. Inspect configuration via POST
    const inspectRes = await app.inject({
      method: "POST",
      url: "/api/configuration/inspect",
      headers: {
        cookie: `${cookieName}=${sessionToken}`,
        [csrfHeaderName]: csrfToken
      },
      payload: { bundle }
    });
    expect(inspectRes.statusCode).toBe(200);
    const inspectData = inspectRes.json();
    expect(inspectData.valid).toBe(true);
    expect(inspectData.summary.roomsCount).toBeGreaterThanOrEqual(1);
    expect(inspectData.summary.userLinksCount).toBe(1);
    expect(inspectData.summary.clipboardItemsCount).toBe(1);

    // 4. Import into a fresh target store
    const targetStore = new InMemorySpaceStore();
    const targetApp = await createApp({
      store: targetStore,
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

    const targetUser = { id: "user:local", email: "local@example.com", role: "ADMIN" as const };
    const targetSessionToken = signSession(targetUser, sessionSecret);
    const targetCsrfToken = createCsrfToken(targetSessionToken, sessionSecret)!;

    // Replace deletes the account's rooms, links, clipboard and tasks: refused unless confirmed (Record Retention Invariant).
    const unconfirmed = await targetApp.inject({
      method: "POST",
      url: "/api/configuration/import",
      headers: { cookie: `${cookieName}=${targetSessionToken}`, [csrfHeaderName]: targetCsrfToken },
      payload: { bundle, mode: "replace" }
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error.code).toBe("CONFIGURATION_REPLACE_UNCONFIRMED");
    expect(targetStore.listRooms("user:local")).toEqual([]);

    const importRes = await targetApp.inject({
      method: "POST",
      url: "/api/configuration/import",
      headers: {
        cookie: `${cookieName}=${targetSessionToken}`,
        [csrfHeaderName]: targetCsrfToken
      },
      payload: {
        bundle,
        mode: "replace",
        confirmReplace: true
      }
    });
    expect(importRes.statusCode).toBe(200);
    const importResult = importRes.json();
    expect(importResult.success).toBe(true);
    expect(importResult.stats.roomsImported).toBeGreaterThanOrEqual(1);
    expect(importResult.stats.linksImported).toBe(1);
    expect(importResult.stats.clipboardImported).toBe(1);

    // Verify imported links in target store
    const links = await targetStore.listUserLinks("user:local", { page: 1, pageSize: 50 });
    expect(links.items.length).toBe(1);
    expect(links.items[0].title).toBe("Test Bookmark");
  });
});
