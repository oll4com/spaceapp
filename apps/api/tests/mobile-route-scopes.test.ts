import { LINK_ROUTE_SCOPES, MOBILE_ROUTE_SCOPES } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { registeredRoutes } from "./route-tree.js";

// Nous Pro 1b (ADR-013, design §6.2): the phone's allowlist names the router's own patterns, the string the onRequest hook reads as
// routeOptions.url. A renamed or removed route would silently close the phone's door, so every entry must be a registered route.
it("every MOBILE_ROUTE_SCOPES and LINK_ROUTE_SCOPES entry is a route the API registers, by its exact pattern", async () => {
  const app = await createApp({ store: new InMemorySpaceStore(), config: getApiConfig({ SPACE_LOG_LEVEL: "silent" }), auth: { sessionSecret: "mobile-route-scopes-secret", devLogin: false, secureCookies: false } });
  try {
    await app.ready();
    // Exact strings, parameter names included: the hook compares the pattern as a string, so ":notificationId" for ":id" would deny.
    const routes = new Set(registeredRoutes(app.printRoutes({ commonPrefix: false })));
    expect([...Object.keys(MOBILE_ROUTE_SCOPES), ...Object.keys(LINK_ROUTE_SCOPES)].filter((key) => !routes.has(key))).toEqual([]);
  } finally {
    await app.close();
  }
}, 300_000);
