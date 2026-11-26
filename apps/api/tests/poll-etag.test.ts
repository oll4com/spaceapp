import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { installPollEtag, POLLED_ROUTES } from "../src/poll-etag.js";
import { registerRoomListRoutes } from "../src/room-routes.js";

describe("polled routes answer 304 when nothing changed", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  it("the room's dashboard agents: a new sample time alone is not a new body", async () => {
    const app = Fastify();
    apps.push(app);
    installPollEtag(app);
    let samples = 0;
    let status = "idle";
    registerRoomListRoutes(app, {
      readDashboardAgents: async () => ({ data: [], activity: { "pane:one": status }, details: {}, sampledAt: `2026-11-21T00:00:0${samples++}.000Z` }),
      assertRoomAccess: async () => ({}), routeOptions: {}
    } as never);
    const url = "/api/rooms/room:one/dashboard-agents";
    const first = await app.inject({ method: "GET", url });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ data: [], activity: { "pane:one": "idle" }, details: {} });
    const poll = () => app.inject({ method: "GET", url, headers: { "if-none-match": first.headers.etag as string } });
    const unchanged = await poll();
    expect([unchanged.statusCode, unchanged.rawPayload.length, samples]).toEqual([304, 0, 2]);
    status = "working";
    const changed = await poll();
    expect([changed.statusCode, changed.json().activity]).toEqual([200, { "pane:one": "working" }]);
  });

  it("names only routes the API registers", async () => {
    // A renamed route would silently lose its 304: each name is found as a registered GET in the sources.
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("../src/", import.meta.url);
    const sources = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts") && name !== "poll-etag.ts")
      .map((name) => readFileSync(new URL(name, dir), "utf8")).join("\n");
    expect([...POLLED_ROUTES].filter((route) => !sources.includes(`"${route}"`) && !sources.includes(`'${route}'`))).toEqual([]);
  });
});
