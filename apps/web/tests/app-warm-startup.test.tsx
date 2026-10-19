import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSpaceApp as App } from "../src/live/LiveSpaceApp.js";
import { resetCliVpnRoutingStatusForTests } from "../src/cli-vpn-routing.js";
import { deferred, installFetchFixture, setViewport, setWarmRoomTelemetry } from "./responsive-shell-fixture.js";

const paneRequest = (roomId: string) => `/api/panes?roomId=${encodeURIComponent(roomId)}`;

describe("app warm startup", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    window.localStorage.setItem("space.uiTheme.v1", "classic");
    setViewport(1440, 900);
    setWarmRoomTelemetry({ hardwareConcurrency: 4 });
  });

  afterEach(() => {
    cleanup();
    resetCliVpnRoutingStatusForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lets the active room load before starting the bounded parallel warm pass", async () => {
    const activeGate = deferred<void>();
    const fixture = installFetchFixture({
      rooms: [
        { id: "room:active", name: "Active" },
        { id: "room:next", name: "Next" },
        { id: "room:other", name: "Other" }
      ],
      paneRequestDeferredByRoom: { "room:active": activeGate.promise }
    });
    render(<App />);

    try {
      await waitFor(() => expect(fixture.requests.some(({ url }) => url === paneRequest("room:active"))).toBe(true));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
      expect(fixture.requests.filter(({ url }) => url.startsWith("/api/panes?roomId=")).map(({ url }) => url)).toEqual([
        paneRequest("room:active")
      ]);
      expect(fixture.requests.some(({ url }) => url === "/readyz")).toBe(false);
    } finally {
      await act(async () => activeGate.resolve());
    }
    await waitFor(() => expect(fixture.requests.some(({ url }) => url === paneRequest("room:other"))).toBe(true));
    expect(fixture.requests.filter(({ url }) => url.startsWith("/api/panes?roomId=")).map(({ url }) => url)).toEqual([
      paneRequest("room:active"), paneRequest("room:next"), paneRequest("room:other")
    ]);
    await waitFor(() => expect(fixture.requests.some(({ url }) => url === "/readyz")).toBe(true));
  });

  it("hydrates only five other rooms and excludes proof rooms even when all candidates are empty", async () => {
    window.sessionStorage.setItem("space.warmRoom.mru.v1", JSON.stringify(["room:8", "room:proof", "room:gone"]));
    const fixture = installFetchFixture({
      rooms: [
        { id: "room:0", name: "Active" },
        { id: "room:proof", name: "Proof", kind: "AGENT_PROOF" },
        ...Array.from({ length: 8 }, (_, index) => ({ id: `room:${index + 1}`, name: `Room ${index + 1}` }))
      ]
    });
    render(<App />);

    await waitFor(() => expect(fixture.requests.some(({ url }) => url === "/readyz")).toBe(true));
    expect([...new Set(fixture.requests.filter(({ url }) => url.startsWith("/api/panes?roomId=")).map(({ url }) => url))]).toEqual([
      "room:0", "room:8", "room:1", "room:2", "room:3", "room:4"
    ].map(paneRequest));
  });

  it.each([
    { local: true, server: false, expectedBackground: false },
    { local: false, server: true, expectedBackground: true },
    { local: false, server: undefined, expectedBackground: false }
  ])("uses hydrated Warm settings at startup (local $local, server $server)", async ({ local, server, expectedBackground }) => {
    window.localStorage.setItem("space.warmRoom.enabled.v1", String(local));
    const fixture = installFetchFixture({
      rooms: [{ id: "room:active", name: "Active" }, { id: "room:next", name: "Next" }]
    });
    const fixtureFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const response = await fixtureFetch(request, init);
      if (String(request) !== "/api/auth/me" || server === undefined) return response;
      return {
        ...response,
        json: async () => ({ ...await response.json(), settings: { warmRoomEnabled: server } })
      };
    }));
    render(<App />);

    await waitFor(() => expect(fixture.requests.some(({ url }) => url === "/readyz")).toBe(true));
    expect(fixture.requests.some(({ url }) => url === paneRequest("room:active"))).toBe(true);
    expect(fixture.requests.some(({ url }) => url === paneRequest("room:next"))).toBe(expectedBackground);
    const settingsWrites = fixture.requestBodies
      .filter(({ url }) => url === "/api/user-settings")
      .map(({ body }) => JSON.parse(body));
    expect(settingsWrites.filter((body) => "warmRoomEnabled" in body || "warmRoomConnectedPaneLimit" in body)).toEqual([]);
  });

  it("skips background room hydration when the active room is an Agent Proof", async () => {
    const fixture = installFetchFixture({
      rooms: [
        { id: "room:proof", name: "Proof", kind: "AGENT_PROOF" },
        { id: "room:other", name: "Other" }
      ]
    });
    render(<App />);

    await waitFor(() => expect(fixture.requests.some(({ url }) => url === "/readyz")).toBe(true));
    const paneRequests = fixture.requests.filter(({ url }) => url.startsWith("/api/panes?roomId="));
    expect(paneRequests.length).toBeGreaterThan(0);
    expect(paneRequests.every(({ url }) => url === paneRequest("room:proof"))).toBe(true);
  });
});
