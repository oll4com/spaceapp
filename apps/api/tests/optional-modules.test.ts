import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig, optionalModuleIds, parseOptionalModules } from "../src/config.js";

// Review F14 (operator decision 2026-10-14): public installs start without the modules beyond the
// coding workspace; SPACE_OPTIONAL_MODULES turns them on.
const APP_LIFECYCLE_TIMEOUT_MS = 60_000;
// A public install writes its connector key at start (ensureConnectorKey): the test keeps it in a temp folder, never the host's.
const testConnectorKey = join(tmpdir(), `space-test-connector-${process.pid}.key`);
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

it("defaults to every module on private installs and none on public ones", () => {
  expect(parseOptionalModules(undefined, false).size).toBe(optionalModuleIds.length);
  expect(parseOptionalModules(undefined, true).size).toBe(0);
  expect([...parseOptionalModules("waitlist, games, unknown", true)]).toEqual(["games", "waitlist"]);
  expect(parseOptionalModules("all", true).size).toBe(optionalModuleIds.length);
  expect(parseOptionalModules("none", false).size).toBe(0);
});

it("does not register optional routes on a public install unless they are enabled", async () => {
  const probe = async (modules?: string) => {
    app = await createApp({
      store: new InMemorySpaceStore(),
      config: getApiConfig({ SPACE_PUBLIC_DISTRIBUTION: "true", SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: testConnectorKey, ...(modules ? { SPACE_OPTIONAL_MODULES: modules } : {}) }),
      auth: { sessionSecret: "optional-modules-test-secret", devLogin: false, secureCookies: false }
    });
    const status = async (method: "GET" | "POST", url: string) => (await app!.inject({ method, url, ...(method === "POST" ? { payload: {} } : {}) })).statusCode;
    const result = {
      desktop: await status("GET", "/api/desktop/latest"),
      waitlist: await status("POST", "/api/public/waitlist"),
      slack: await status("POST", "/api/channels/slack/events")
    };
    await app.close();
    app = undefined;
    return result;
  };
  expect(await probe()).toEqual({ desktop: 404, waitlist: 404, slack: 404 });
  const enabled = await probe("desktop-updates,waitlist");
  expect(enabled.desktop).not.toBe(404);
  expect(enabled.waitlist).not.toBe(404);
  expect(enabled.slack).toBe(404);
}, APP_LIFECYCLE_TIMEOUT_MS);
