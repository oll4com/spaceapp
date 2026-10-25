import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { spaceConfigBundleSchema } from "@space/contracts";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

const sessionSecret = "configuration-synthetic-session-secret";
const bundle = spaceConfigBundleSchema.parse({
  format: "spaceapp-configuration-bundle", version: "1.0.0", exportedAt: "2026-10-03T00:00:00.000Z",
  source: { instance: "synthetic", exportedBy: "user:other" },
  metadata: { roomsCount: 0, panesCount: 0, userLinksCount: 0, clipboardItemsCount: 0, taskItemsCount: 0, cliRuntimesCount: 0, providersCount: 0 },
  data: { apiKeys: { SYNTHETIC_API_KEY: "synthetic-only" }, credentials: { "fixture.json": "synthetic-only" } }
});

describe("Configuration installation authorization", () => {
  const store = new InMemorySpaceStore();
  // Block all filesystem-backed secret collection and import in these HTTP boundary tests.
  const exportBundle = vi.spyOn(store, "exportConfigurationBundle").mockResolvedValue(bundle);
  const importBundle = vi.spyOn(store, "importConfigurationBundle").mockResolvedValue({
    success: true, mode: "merge", targetUserId: "user:other",
    stats: { roomsImported: 0, panesImported: 0, linksImported: 0, clipboardImported: 0, tasksImported: 0, settingsUpdated: false, cliRuntimesImported: 0, providersImported: 0 },
    warnings: []
  });
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cfg-auth-"));
    app = await createApp({ store, auth: { sessionSecret, devLogin: false, secureCookies: false },
      config: getApiConfig({ SPACE_ROOT_DIR: root, SPACE_VAR_DIR: join(root, "var"), SPACE_CLI_HOST_ENABLED: "false" }) });
  });
  afterAll(async () => { await app?.close(); if (root) await rm(root, { recursive: true, force: true }); });
  beforeEach(() => { exportBundle.mockClear(); importBundle.mockClear(); });

  function headers(role: "ADMIN" | "OPERATOR" | "USER") {
    const token = signSession({ id: `user:config-${role.toLowerCase()}`, email: `${role.toLowerCase()}@example.test`, role }, sessionSecret);
    return { cookie: `${cookieName}=${token}`, [csrfHeaderName]: createCsrfToken(token, sessionSecret)! };
  }

  it.each([
    { includeApiKeys: true }, { includeCredentials: true }, { includeApiKeys: true, includeCredentials: true }
  ])("rejects USER secret export before collecting any values: %j", async (payload) => {
    const response = await app!.inject({ method: "POST", url: "/api/configuration/export", headers: headers("USER"), payload });
    // A USER never reaches install-wide routes, with or without the multi-user flag (MU-001).
    expect(response.statusCode).toBe(404);
    expect(exportBundle).not.toHaveBeenCalled();
    expect(response.body).not.toContain("synthetic-only");
  });

  it.each(["replace", "merge"])("rejects USER %s import before any database or filesystem mutation", async (mode) => {
    const response = await app!.inject({ method: "POST", url: "/api/configuration/import", headers: headers("USER"),
      payload: { bundle, mode, targetUserId: "user:other", secretsDir: join(root, "secrets"), credentialsDir: join(root, "credentials") } });
    expect(response.statusCode).toBe(404);
    expect(importBundle).not.toHaveBeenCalled();
  });

  it("closes even an ordinary export to a USER: the bundle carries the installation's providers and CLI settings (MU-001)", async () => {
    for (const [method, url] of [["POST", "/api/configuration/export"], ["GET", "/api/configuration/export"]] as const) {
      const response = await app!.inject({ method, url, headers: headers("USER"), ...(method === "POST" ? { payload: { userId: "user:other" } } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(exportBundle).not.toHaveBeenCalled();
  });

  it.each(["ADMIN", "OPERATOR"] as const)("preserves authorized %s export/import and target selection", async (role) => {
    const auth = headers(role);
    const exported = await app!.inject({ method: "POST", url: "/api/configuration/export", headers: auth,
      payload: { userId: "user:other", includeApiKeys: true, includeCredentials: true, passphrase: "synthetic passphrase" } });
    expect(exported.statusCode).toBe(200);
    expect(exportBundle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: "user:other", includeApiKeys: true, includeCredentials: true }), { cliAuth: {} });
    const imported = await app!.inject({ method: "POST", url: "/api/configuration/import", headers: auth, payload: { bundle, mode: "merge", targetUserId: "user:other" } });
    expect(imported.statusCode).toBe(200);
    expect(importBundle).toHaveBeenCalledExactlyOnceWith(bundle, expect.objectContaining({ targetUserId: "user:other", mode: "merge" }), expect.anything());
    // The HTTP route never lets a caller choose where secrets are written.
    expect(importBundle.mock.calls[0]![1]).not.toHaveProperty("secretsDir");
  });

  it("refuses to export secrets without a passphrase of at least 12 characters", async () => {
    for (const [passphrase, status] of [[undefined, 400], ["short", 422]] as const) {
      const response = await app!.inject({ method: "POST", url: "/api/configuration/export", headers: headers("ADMIN"),
        payload: { includeApiKeys: true, ...(passphrase ? { passphrase } : {}) } });
      expect(response.statusCode).toBe(status);
    }
    expect(exportBundle).not.toHaveBeenCalled();
  });

  it("answers a wrong passphrase with one error code and locks after five failures", async () => {
    const { ConfigSecretsError } = await import("@space/runtime");
    importBundle.mockRejectedValue(new ConfigSecretsError());
    const attempt = () => app!.inject({ method: "POST", url: "/api/configuration/import", headers: headers("OPERATOR"),
      payload: { bundle, mode: "merge", passphrase: "not the passphrase" } });
    for (let index = 0; index < 5; index += 1) {
      const response = await attempt();
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("WRONG_PASSPHRASE_OR_TAMPERED");
      expect(response.body).not.toContain("not the passphrase");
    }
    expect((await attempt()).statusCode).toBe(429);
    expect(importBundle).toHaveBeenCalledTimes(5);
  });

  it("inspects and imports a backup from a newer SpaceApp, skipping only what this version does not know", async () => {
    const settings = JSON.parse(JSON.stringify(await store.getUserSettings("user:config-admin")));
    const newer = { ...bundle, data: { ...bundle.data, userSettings: { ...settings, uiTheme: "theme-from-a-future-version" } } };
    const inspected = await app!.inject({ method: "POST", url: "/api/configuration/inspect", headers: headers("ADMIN"), payload: { bundle: newer } });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().warnings[0]).toMatch(/does not recognize .*: setting uiTheme\./);
    importBundle.mockResolvedValueOnce({ success: true, mode: "merge", targetUserId: "user:config-admin", warnings: [],
      stats: { roomsImported: 0, panesImported: 0, linksImported: 0, clipboardImported: 0, tasksImported: 0, settingsUpdated: true, cliRuntimesImported: 0, providersImported: 0 } });
    const imported = await app!.inject({ method: "POST", url: "/api/configuration/import", headers: headers("ADMIN"), payload: { bundle: newer, mode: "merge" } });
    expect(imported.statusCode).toBe(200);
    // The unknown theme is gone; this version falls back to its default theme.
    expect(importBundle.mock.calls[0]![0].data.userSettings?.uiTheme).toBe("modern");
    expect(imported.json().warnings[0]).toMatch(/setting uiTheme/);
    const broken = await app!.inject({ method: "POST", url: "/api/configuration/import", headers: headers("ADMIN"), payload: { bundle: { ...bundle, format: "other" }, mode: "merge" } });
    expect(broken.statusCode).toBe(422);
  });

  it("rejects a relative project folder mapping", async () => {
    const response = await app!.inject({ method: "POST", url: "/api/configuration/import", headers: headers("ADMIN"),
      payload: { bundle, mode: "merge", pathRewrite: { from: "/opt/spaceapp", to: "Projects/space" } } });
    expect(response.statusCode).toBe(400);
    expect(importBundle).not.toHaveBeenCalled();
  });

  it.each(["export", "import"])("still requires CSRF for authorized %s", async (operation) => {
    const auth = headers("ADMIN");
    const response = await app!.inject({ method: "POST", url: `/api/configuration/${operation}`, headers: { cookie: auth.cookie }, payload: { bundle } });
    expect(response.statusCode).toBe(403);
    expect(exportBundle).not.toHaveBeenCalled();
    expect(importBundle).not.toHaveBeenCalled();
  });
});
