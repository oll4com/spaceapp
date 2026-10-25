import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the real, immutable schemas shared while resetModules isolates client caches.
// Rebuilding the full Zod graph on every case exhausts the test worker heap.
vi.mock("@space/contracts", async (importOriginal) => importOriginal());

describe("Space web API request handling", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
    window.localStorage?.clear();
    window.sessionStorage?.clear();
  });

  it("answers from the stored CLI runtime registry on load but refreshes it on the first read", async () => {
    const stored = { data: [{ id: "cli:claude", capabilities: ["CLI"], authState: "LOGIN_REQUIRED" }], checkedAt: "2026-10-16T06:16:59.743Z" };
    const fresh = { data: [{ id: "cli:claude", capabilities: ["CLI"], authState: "READY" }], checkedAt: "2026-10-16T06:53:04.152Z" };
    window.localStorage.setItem("space.cliRuntimeRegistry.cache.v1", JSON.stringify(stored));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fresh), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    await expect(api.cliRuntimes({ allowStale: true })).resolves.toEqual(stored);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(api.cliRuntimes()).resolves.toEqual(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.localStorage.getItem("space.cliRuntimeRegistry.cache.v1") ?? "null")).toEqual(fresh);
  });

  it("does not request a CLI session for a client-only optimistic pane", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    await expect(api.activeCliSession("pane:optimistic-new-0", { includeTranscript: false })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("builds bounded event stream URLs while preserving the legacy URL", async () => {
    const { api } = await import("../src/live-api.js");

    expect(api.eventStreamUrl()).toBe("/api/events/stream");
    expect(api.eventStreamUrl({ roomId: "room:live", replayLimit: 50 }))
      .toBe("/api/events/stream?roomId=room%3Alive&replayLimit=50");
    expect(api.eventStreamUrl({ replayLimit: 200 }))
      .toBe("/api/events/stream?replayLimit=200");
  });

  it("uses protected durable setup check resources and a credentialed SSE cursor", async () => {
    const jsonResponse = (payload: unknown) => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
    const fetchMock = vi.fn((url: RequestInfo | URL) => Promise.resolve(
      jsonResponse(
        String(url) === "/api/auth/csrf"
          ? { csrfToken: "csrf:setup-checks", headerName: "x-space-csrf-token" }
          : {}
      )
    ));
    const eventSourceConstructor = vi.fn();
    class MockEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        eventSourceConstructor(String(url), init);
      }
    }
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);
    const { api } = await import("../src/live-api.js");

    await api.startSetupConnectionChecks();
    await api.startSetupConnectionCheck("cli:kimi");
    await api.getSetupConnectionCheckReplay("setup_check_run:one", 12);
    const stream = api.openSetupConnectionCheckStream("setup_check_run:one", 12);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/setup/connection-check-runs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-space-csrf-token": "csrf:setup-checks"
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/setup/connections/cli%3Akimi/check-runs",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/setup/connection-check-runs/setup_check_run%3Aone/replay?afterSequence=12",
      expect.objectContaining({ credentials: "include" })
    );
    expect(eventSourceConstructor).toHaveBeenCalledWith(
      "/api/setup/connection-check-runs/setup_check_run%3Aone/stream?afterSequence=12",
      { withCredentials: true }
    );
    expect(stream).toBeInstanceOf(MockEventSource);
  });

  it("uses browser, tab-lineage, and page-scoped identities for protocol-v2 terminal sockets", async () => {
    window.localStorage.removeItem("space.cliTerminal.browserClientId.v1");
    window.sessionStorage.removeItem("space.cliTerminal.tabLineageId.v1");
    const { api } = await import("../src/live-api.js");
    const ticket = {
      paneId: "pane:thailand",
      sessionId: "cli_session:thailand",
      token: "terminal-ws-ticket-thailand-regression",
      expiresAt: "2026-07-20T20:30:00.000Z"
    };

    const first = new URL(api.cliTerminalWebSocketUrl(ticket));
    const second = new URL(api.cliTerminalWebSocketUrl(ticket, {
      leaseId: "cli_control_lease:reconnect"
    }));
    const browserId = first.searchParams.get("browserClientId");
    const tabLineageId = first.searchParams.get("tabLineageId");
    const pageClientId = first.searchParams.get("pageClientId");

    expect(first.searchParams.get("protocolVersion")).toBe("2");
    expect(first.searchParams.get("clientMode")).toBe("INTERACTIVE");
    expect(browserId).toMatch(/^[0-9a-f-]{36}$/);
    expect(tabLineageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pageClientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.searchParams.get("browserClientId")).toBe(browserId);
    expect(second.searchParams.get("tabLineageId")).toBe(tabLineageId);
    expect(second.searchParams.get("pageClientId")).toBe(pageClientId);
    expect(second.searchParams.get("leaseId")).toBe("cli_control_lease:reconnect");
    expect(window.localStorage.getItem("space.cliTerminal.browserClientId.v1")).toBe(browserId);
    expect(window.sessionStorage.getItem("space.cliTerminal.tabLineageId.v1")).toBe(tabLineageId);

    vi.resetModules();
    const { api: reloadedApi } = await import("../src/live-api.js");
    const reloaded = new URL(reloadedApi.cliTerminalWebSocketUrl(ticket));
    expect(reloaded.searchParams.get("browserClientId")).toBe(browserId);
    expect(reloaded.searchParams.get("tabLineageId")).toBe(tabLineageId);
    expect(reloaded.searchParams.get("pageClientId")).not.toBe(pageClientId);
  });

  it("adds initial terminal geometry only as a validated pair", async () => {
    const { api } = await import("../src/live-api.js");
    const ticket = {
      paneId: "pane:initial-geometry",
      sessionId: "cli_session:initial-geometry",
      token: "terminal-ws-ticket-initial-geometry",
      expiresAt: "2026-07-26T12:00:00.000Z"
    };

    const legacy = new URL(api.cliTerminalWebSocketUrl(ticket));
    const measured = new URL(api.cliTerminalWebSocketUrl(ticket, {
      initialCols: 132,
      initialRows: 41
    }));

    expect(legacy.searchParams.has("initialCols")).toBe(false);
    expect(legacy.searchParams.has("initialRows")).toBe(false);
    expect(measured.searchParams.get("initialCols")).toBe("132");
    expect(measured.searchParams.get("initialRows")).toBe("41");
  });

  it("fences every CLI HTTP mutation with the current page lease identity", async () => {
    window.localStorage.removeItem("space.cliTerminal.browserClientId.v1");
    window.sessionStorage.removeItem("space.cliTerminal.tabLineageId.v1");
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(
      new Response(JSON.stringify(
        String(url) === "/api/auth/csrf"
          ? { csrfToken: "csrf:cli-control", headerName: "x-space-csrf-token" }
          : {}
      ), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    ));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");
    const paneId = "pane:http-control";
    const websocketUrl = new URL(api.cliTerminalWebSocketUrl({
      paneId,
      sessionId: "cli_session:http-control",
      token: "terminal-ws-ticket-http-control-proof",
      expiresAt: "2026-07-23T13:00:00.000Z"
    }));
    const leaseId = "cli_control_lease:http-current-page";
    api.setCliTerminalControlLease(paneId, leaseId);

    await api.updateCliModelSettings(paneId, {
      expectedSessionId: "cli_session:http-control",
      modelId: "gpt-5",
      reasoningEffort: "medium"
    });
    await api.createCliSession(paneId, { runtimeId: "cli:codex", forceRestart: true });
    await api.resumeCliSession(paneId, { taskId: "cli_task:http-control" });
    await api.interruptCliSession(paneId, "HTTP control proof");
    await api.uploadCliFiles({
      paneId,
      source: "USER_UPLOAD",
      files: [new File(["proof"], "proof.txt", { type: "text/plain" })]
    });

    const mutationCalls = fetchMock.mock.calls.filter(([url]) => String(url) !== "/api/auth/csrf");
    expect(mutationCalls).toHaveLength(5);
    for (const [, init] of mutationCalls) {
      expect(init?.headers).toEqual(expect.objectContaining({
        "x-space-cli-control-lease-id": leaseId,
        "x-space-cli-browser-client-id": websocketUrl.searchParams.get("browserClientId"),
        "x-space-cli-tab-lineage-id": websocketUrl.searchParams.get("tabLineageId"),
        "x-space-cli-page-client-id": websocketUrl.searchParams.get("pageClientId"),
        "x-space-csrf-token": "csrf:cli-control"
      }));
    }

    api.setCliTerminalControlLease(paneId, null);
    await api.createCliSession(paneId, { runtimeId: "cli:codex" });
    const releasedHeaders = fetchMock.mock.calls.at(-1)?.[1]?.headers as Record<string, string>;
    expect(releasedHeaders["x-space-cli-control-lease-id"]).toBeUndefined();
    expect(releasedHeaders["x-space-cli-page-client-id"]).toBeUndefined();
  });

  it("reports bounded CLI lifecycle events through an authenticated CSRF POST", async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(
      new Response(JSON.stringify(
        String(url) === "/api/auth/csrf"
          ? { csrfToken: "csrf:cli-lifecycle", headerName: "x-space-csrf-token" }
          : { accepted: true }
      ), {
        status: String(url) === "/api/cli/client-events" ? 202 : 200,
        headers: { "Content-Type": "application/json" }
      })
    ));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");
    const event = {
      event: "RECONNECT_SCHEDULED",
      outcome: "RETRY",
      reason: "SOCKET_CLOSE",
      paneId: "pane:cli-lifecycle",
      sessionId: "cli_session:cli-lifecycle",
      runtimeId: "cli:codex",
      controlState: "AVAILABLE",
      protocolVersion: 2 as const,
      clientMode: "INTERACTIVE" as const,
      socketGeneration: 2,
      attempt: 1,
      delayMs: 250,
      clientAt: "2026-07-23T08:00:00.000Z"
    } as const;

    await expect(api.reportCliClientEvent(event)).resolves.toEqual({ accepted: true });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/cli/client-events",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-space-csrf-token": "csrf:cli-lifecycle"
        }),
        body: JSON.stringify(event)
      })
    );
  });

  it("uses the clean model-settings status probe for expected capability unavailability", async () => {
    const payload = {
      status: "UNAVAILABLE",
      reasonCode: "CODEX_SESSION_CONTROL_UNAVAILABLE",
      reason: "Live Codex model control is unavailable."
    } as const;
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    await expect(api.cliModelSettingsStatus("pane:model-status")).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/panes/pane%3Amodel-status/cli/model-settings/status",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("uses typed CLI runtime settings, carries stale previews, and invalidates the registry after updates", async () => {
    const registry = { data: [], checkedAt: "2026-07-22T18:00:00.000Z" };
    const refreshedRegistry = { data: [], checkedAt: "2026-07-22T18:01:00.000Z" };
    const settings = { settings: [], runtimes: [], checkedAt: "2026-07-22T18:00:00.000Z" };
    const preview = {
      runtimeId: "cli:deepseek",
      activeSessionCount: 0,
      openPaneCount: 0,
      confirmationToken: "preview_token_12345678901234567890",
      expiresAt: "2026-07-22T18:02:00.000Z"
    };
    const stalePreview = {
      ...preview,
      activeSessionCount: 1,
      openPaneCount: 1,
      confirmationToken: "fresh_preview_token_12345678901234"
    };
    const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" }
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(registry))
      .mockResolvedValueOnce(jsonResponse(settings))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf:runtime-settings", headerName: "x-space-csrf-token" }))
      .mockResolvedValueOnce(jsonResponse(preview))
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: "CLI_RUNTIME_DISABLE_CONFIRMATION_STALE",
          message: "Impact changed.",
          details: stalePreview,
          requestId: "req:stale"
        }
      }, 409))
      .mockResolvedValueOnce(jsonResponse({
        setting: { runtimeId: "cli:deepseek", enabled: false, updatedAt: settings.checkedAt, updatedBy: "user:admin" },
        cleanup: {
          requestedActiveSessionCount: 1,
          requestedOpenPaneCount: 1,
          terminatedSessionIds: ["cli_session:one"],
          closedPaneIds: ["pane:one"],
          unresolvedSessionIds: [],
          unresolvedPaneIds: []
        }
      }))
      .mockResolvedValueOnce(jsonResponse(refreshedRegistry));
    vi.stubGlobal("fetch", fetchMock);
    const { api, SpaceApiError } = await import("../src/live-api.js");

    await expect(api.cliRuntimes()).resolves.toEqual(registry);
    await expect(api.cliRuntimeSettings()).resolves.toEqual(settings);
    await expect(api.cliRuntimeDisablePreview("cli:deepseek")).resolves.toEqual(preview);
    const stale = await api.updateCliRuntimeSetting("cli:deepseek", {
      enabled: false,
      confirmationToken: preview.confirmationToken
    }).catch((error) => error);
    expect(stale).toBeInstanceOf(SpaceApiError);
    expect(stale).toMatchObject({
      code: "CLI_RUNTIME_DISABLE_CONFIRMATION_STALE",
      status: 409,
      requestId: "req:stale",
      details: stalePreview
    });
    await expect(api.updateCliRuntimeSetting("cli:deepseek", {
      enabled: false,
      confirmationToken: stalePreview.confirmationToken
    })).resolves.toMatchObject({ setting: { runtimeId: "cli:deepseek", enabled: false } });
    await expect(api.cliRuntimes()).resolves.toEqual(refreshedRegistry);

    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/cli/runtime-settings/cli%3Adeepseek/disable-preview",
      expect.objectContaining({ method: "POST", body: JSON.stringify({}) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "/api/cli/runtime-settings/cli%3Adeepseek",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ enabled: false, confirmationToken: stalePreview.confirmationToken })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(7, "/api/cli/runtimes", expect.objectContaining({ credentials: "include" }));
  });

  it("shares, snapshots, and refreshes the CLI runtime settings memory cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T06:00:00.000Z"));
    const cached = { settings: [], runtimes: [], checkedAt: "2026-08-10T06:00:00.000Z" };
    const refreshed = { settings: [], runtimes: [], checkedAt: "2026-08-10T06:00:10.000Z" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(cached), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(refreshed), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    expect(api.cliRuntimeSettingsSnapshot()).toBeNull();
    await expect(Promise.all([
      api.cliRuntimeSettings(),
      api.cliRuntimeSettings(),
      api.cliRuntimeSettings()
    ])).resolves.toEqual([cached, cached, cached]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.cliRuntimeSettingsSnapshot()).toEqual(cached);

    api.warmCliRuntimeSettings();
    vi.advanceTimersByTime(9_999);
    await expect(api.cliRuntimeSettings()).resolves.toEqual(cached);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    const refresh = api.cliRuntimeSettings();
    expect(api.cliRuntimeSettingsSnapshot()).toEqual(cached);
    await expect(refresh).resolves.toEqual(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(api.cliRuntimeSettingsSnapshot()).toEqual(refreshed);
  });

  it("prevents an old settings flight from repopulating a reset auth cache", async () => {
    const stale = { settings: [], runtimes: [], checkedAt: "2026-08-10T06:10:00.000Z" };
    const current = { settings: [], runtimes: [], checkedAt: "2026-08-10T06:10:01.000Z" };
    let resolveStale!: (response: Response) => void;
    const staleResponse = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(staleResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify(current), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    const oldFlight = api.cliRuntimeSettings();
    api.resetCliRuntimeSettingsCache();
    expect(api.cliRuntimeSettingsSnapshot()).toBeNull();
    await expect(api.cliRuntimeSettings()).resolves.toEqual(current);

    resolveStale(new Response(JSON.stringify(stale), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    await expect(oldFlight).resolves.toEqual(stale);
    expect(api.cliRuntimeSettingsSnapshot()).toEqual(current);
  });

  it("detaches an invalidated settings flight so a fresh read cannot reuse stale VPN state", async () => {
    const stale = { settings: [], runtimes: [], checkedAt: "2026-08-10T06:15:00.000Z" };
    const current = { settings: [], runtimes: [], checkedAt: "2026-08-10T06:15:01.000Z" };
    let resolveStale!: (response: Response) => void;
    const staleResponse = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(staleResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify(current), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    const oldFlight = api.cliRuntimeSettings();
    api.invalidateCliRuntimeSettings();
    const freshFlight = api.cliRuntimeSettings();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(freshFlight).resolves.toEqual(current);
    resolveStale(new Response(JSON.stringify(stale), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    await expect(oldFlight).resolves.toEqual(stale);
    expect(api.cliRuntimeSettingsSnapshot()).toEqual(current);
  });

  it("keeps the last settings snapshot visible but expires it after a runtime restart", async () => {
    const cached = { settings: [], runtimes: [], checkedAt: "2026-08-10T06:20:00.000Z" };
    const refreshed = { settings: [], runtimes: [], checkedAt: "2026-08-10T06:20:01.000Z" };
    const restartResult = {
      runtimeId: "cli:opencode",
      requestedSessionIds: [],
      restartedSessionIds: [],
      replacementSessionIds: [],
      failedSessionIds: []
    };
    const jsonResponse = (payload: unknown) => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(cached))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf:restart", headerName: "x-space-csrf-token" }))
      .mockResolvedValueOnce(jsonResponse(restartResult))
      .mockResolvedValueOnce(jsonResponse(refreshed));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    await expect(api.cliRuntimeSettings()).resolves.toEqual(cached);
    await expect(api.cliRuntimeRestart("cli:opencode")).resolves.toEqual(restartResult);
    expect(api.cliRuntimeSettingsSnapshot()).toEqual(cached);
    await expect(api.cliRuntimeSettings()).resolves.toEqual(refreshed);
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/cli/runtime-settings", expect.objectContaining({ credentials: "include" }));
  });

  it("shares the CLI runtime registry flight and opts terminal bootstrap requests out of transcript payloads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T16:00:00.000Z"));
    const registry = { data: [], checkedAt: "2026-07-17T16:00:00.000Z" };
    const refreshedRegistry = { data: [], checkedAt: "2026-07-17T16:00:10.000Z" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(registry), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(refreshedRegistry), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response("null", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        csrfToken: "csrf:cli-create",
        headerName: "x-space-csrf-token"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    await expect(Promise.all([api.cliRuntimes(), api.cliRuntimes(), api.cliRuntimes()])).resolves.toEqual([
      registry,
      registry,
      registry
    ]);
    vi.advanceTimersByTime(9_999);
    await expect(api.cliRuntimes()).resolves.toEqual(registry);
    vi.advanceTimersByTime(1);
    await expect(api.cliRuntimes()).resolves.toEqual(refreshedRegistry);
    await expect(api.activeCliSession("pane:active", { includeTranscript: false })).resolves.toBeNull();
    await expect(api.createCliSession("pane:create", {
      runtimeId: "cli:codex",
      includeTranscript: false
    })).resolves.toEqual({});

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/cli/runtimes", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/panes/pane%3Aactive/cli/session?includeTranscript=false",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/auth/csrf",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "/api/panes/pane%3Acreate/cli/session",
      expect.objectContaining({
        credentials: "include",
        method: "POST",
        body: JSON.stringify({ runtimeId: "cli:codex", includeTranscript: false })
      })
    );
  });

  it("exposes a synchronous last-known runtime snapshot and keeps it across invalidation", async () => {
    const registry = { data: [], checkedAt: "2026-07-23T12:00:00.000Z" };
    const refreshedRegistry = { data: [], checkedAt: "2026-07-23T12:00:01.000Z" };
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(registry), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockReturnValueOnce(refreshResponse);
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    expect(api.cliRuntimesSnapshot()).toBeNull();
    await expect(api.cliRuntimes()).resolves.toEqual(registry);
    expect(api.cliRuntimesSnapshot()).toEqual(registry);

    api.invalidateCliRuntimes();
    expect(api.cliRuntimesSnapshot()).toEqual(registry);
    const freshRequest = api.cliRuntimes();
    expect(api.cliRuntimesSnapshot()).toEqual(registry);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveRefresh(new Response(JSON.stringify(refreshedRegistry), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    await expect(freshRequest).resolves.toEqual(refreshedRegistry);
    expect(api.cliRuntimesSnapshot()).toEqual(refreshedRegistry);
  });

  it("immediately removes a disabled CLI runtime from the synchronous snapshot and storage when visibility changes", async () => {
    const registry = {
      data: [
        { id: "cli:codex", displayName: "Codex CLI", capabilities: ["CLI"], authState: "READY", adapterStatus: "READY", statusReason: "Ready" },
        { id: "cli:autohand", displayName: "Autohand CLI", capabilities: ["CLI"], authState: "READY", adapterStatus: "READY", statusReason: "Ready" }
      ],
      checkedAt: "2026-07-17T16:00:00.000Z"
    };
    const refreshedRegistry = {
      data: [
        { id: "cli:codex", displayName: "Codex CLI", capabilities: ["CLI"], authState: "READY", adapterStatus: "READY", statusReason: "Ready" }
      ],
      checkedAt: "2026-07-17T16:00:01.000Z"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(registry), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(refreshedRegistry), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    await expect(api.cliRuntimes()).resolves.toEqual(registry);
    expect(api.cliRuntimesSnapshot()?.data.some((r: any) => r.id === "cli:autohand")).toBe(true);

    api.invalidateCliRuntimes({ runtimeId: "cli:autohand", enabled: false });

    expect(api.cliRuntimesSnapshot()?.data.some((r: any) => r.id === "cli:autohand")).toBe(false);
    expect(window.localStorage.getItem("space.cliRuntimeRegistry.cache.v1")).not.toContain("cli:autohand");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("times out a stuck CLI runtime registry flight and retries with a fresh request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T16:30:00.000Z"));
    const refreshedRegistry = { data: [], checkedAt: "2026-07-17T16:30:08.000Z" };
    let runtimeRegistryRequests = 0;
    const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe("/api/cli/runtimes");
      runtimeRegistryRequests += 1;
      if (runtimeRegistryRequests === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true }
          );
        });
      }
      return Promise.resolve(new Response(JSON.stringify(refreshedRegistry), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    const firstRequest = api.cliRuntimes();
    const sharedRequest = api.cliRuntimes();
    const firstResult = firstRequest.catch((error) => error as Error);
    const sharedResult = sharedRequest.catch((error) => error as Error);
    const firstSignal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/cli/runtimes", expect.objectContaining({ credentials: "include" }));
    expect(firstSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(8_000);

    expect(firstSignal?.aborted).toBe(true);
    await expect(firstResult).resolves.toMatchObject({ message: "CLI runtimes request timed out. Please retry." });
    await expect(sharedResult).resolves.toMatchObject({ message: "CLI runtimes request timed out. Please retry." });
    await expect(api.cliRuntimes()).resolves.toEqual(refreshedRegistry);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("can serve stale CLI runtimes while refreshing a stuck registry request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T16:45:00.000Z"));
    const registry = { data: [], checkedAt: "2026-07-17T16:45:00.000Z" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(registry), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockImplementationOnce((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true }
        );
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    await expect(api.cliRuntimes()).resolves.toEqual(registry);
    vi.advanceTimersByTime(10_000);
    await expect(api.cliRuntimes({ allowStale: true })).resolves.toEqual(registry);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(8_000);
  });

  it("uses lazy toolbar telemetry resources and CSRF-protected system actions", async () => {
    const jsonResponse = (payload: unknown) => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: [], source: "space-gateway", isStale: false, error: null, checkedAt: "2026-07-24T12:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ summary: {}, sessions: [] }))
      .mockResolvedValueOnce(jsonResponse({ memory: {}, topProcesses: [] }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf:toolbar", headerName: "x-space-csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ accountId: "account:one", outcome: "RESET", completedAt: "2026-07-24T12:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ status: "NOOP", killedSessionIds: [] }))
      .mockResolvedValueOnce(jsonResponse({ status: "NOOP", cli: {}, kernelCache: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    await api.toolbarUsageAccounts();
    await api.toolbarResetCredits();
    await api.toolbarCliSessions();
    await api.toolbarHostMemory();
    await api.redeemToolbarResetCredit("account:one", "10000000-0000-4000-8000-000000000001");
    await api.reapToolbarCliSessions();
    await api.reclaimToolbarMemory();

    expect(fetchMock.mock.calls.slice(0, 4).map(([url]) => url)).toEqual([
      "/api/admin/codex-usage-accounts",
      "/api/admin/codex-reset-credits",
      "/api/admin/cli-sessions",
      "/api/admin/host-memory",
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(6, "/api/admin/codex-reset-credits/account%3Aone/redemptions", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-space-csrf-token": "csrf:toolbar" }),
      body: JSON.stringify({ idempotencyKey: "10000000-0000-4000-8000-000000000001" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(7, "/api/admin/cli-session-reaps", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-space-csrf-token": "csrf:toolbar" }),
      body: JSON.stringify({}),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(8, "/api/admin/memory-reclaims", expect.objectContaining({ method: "POST" }));
  });

  it("uses typed Codex speed and history purge admin resources with CSRF-protected writes", async () => {
    const jsonResponse = (payload: unknown) => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ models: [], updatedAt: null, checkedAt: "2026-07-17T08:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf:codex-admin", headerName: "x-space-csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ models: [], updatedAt: null, checkedAt: "2026-07-17T08:00:01.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ status: "NOOP", previewId: "9943e22b-97a3-48b6-ae84-1a2cced6a353" }))
      .mockResolvedValueOnce(jsonResponse({ status: "NOOP", previewId: "9943e22b-97a3-48b6-ae84-1a2cced6a353" }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    await api.codexLbSpeedDefaults();
    await api.updateCodexLbSpeedDefault("gpt-5.5", "FAST");
    await api.previewCodexHistoryPurge();
    await api.executeCodexHistoryPurge("9943e22b-97a3-48b6-ae84-1a2cced6a353", "PURGE HISTORY");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/admin/codex-lb-speed-defaults", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/admin/codex-lb-speed-defaults/gpt-5.5", expect.objectContaining({
      method: "PATCH",
      headers: expect.objectContaining({ "x-space-csrf-token": "csrf:codex-admin" }),
      body: JSON.stringify({ tier: "FAST" })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/admin/codex-history-purge-previews", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({})
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/admin/codex-history-purges", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        previewId: "9943e22b-97a3-48b6-ae84-1a2cced6a353",
        confirmation: "PURGE HISTORY"
      })
    }));
  });

  it("uses typed maintenance, release, and protected source-control publishing resources", async () => {
    const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" }
    });
    const run = { id: "admin_run:Abcd_1234-xy", status: "QUEUED" };
    const preview = {
      id: "release_preview:Abcd_1234",
      tag: "v2026.07.23.1",
      notes: "- Guarded release",
      sourceCommit: "42aac2eac274e2ab0512071615647073582d43a8"
    };
    const connection = {
      provider: "github",
      repositoryOwner: "oll4com",
      repositoryName: "space",
      accountLogin: "oll4com",
      status: "CONNECTED",
      secretConfigured: true,
      lastVerifiedAt: "2026-07-23T08:00:00.000Z",
      lastVerificationCode: "VERIFIED",
      updatedAt: "2026-07-23T08:00:00.000Z"
    };
    const writeOnlyToken = "test_token_123456789012345678901234";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf:release-admin", headerName: "x-space-csrf-token" }))
      .mockResolvedValueOnce(jsonResponse(run, 202))
      .mockResolvedValueOnce(jsonResponse(preview, 201))
      .mockResolvedValueOnce(jsonResponse(run, 202))
      .mockResolvedValueOnce(jsonResponse({ data: [run] }))
      .mockResolvedValueOnce(jsonResponse({ data: [connection] }))
      .mockResolvedValueOnce(jsonResponse(connection))
      .mockResolvedValueOnce(jsonResponse(connection))
      .mockResolvedValueOnce(jsonResponse({ ...connection, status: "DISCONNECTED", secretConfigured: false }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");

    await api.listCliMaintenanceRuns();
    await api.startCliMaintenance({ mode: "CHECK" });
    await api.createReleasePreview({});
    await api.publishRelease({
      previewId: preview.id,
      tag: preview.tag,
      notes: preview.notes,
      confirmation: `PUBLISH ${preview.tag}`
    });
    await api.listReleaseRuns();
    await api.listSourceControlConnections();
    await api.replaceSourceControlConnection("github", writeOnlyToken);
    await api.verifySourceControlConnection("github");
    await api.disconnectSourceControlConnection("github");

    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/admin/cli-maintenance/runs", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-space-csrf-token": "csrf:release-admin" }),
      body: JSON.stringify({ mode: "CHECK" })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/admin/releases/previews", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({})
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/admin/releases", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        previewId: preview.id,
        tag: preview.tag,
        notes: preview.notes,
        confirmation: `PUBLISH ${preview.tag}`
      })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(8, "/api/admin/source-control/connections/github", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ token: writeOnlyToken })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(9, "/api/admin/source-control/connections/github/verifications", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({})
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(10, "/api/admin/source-control/connections/github", expect.objectContaining({
      method: "DELETE"
    }));
  });

  it("uses the typed Telegram integration resources with CSRF-protected writes", async () => {
    const status = {
      connectionStatus: "PAIRING",
      isEnabled: false,
      botUsername: "space_test_bot",
      chatDisplayName: null,
      pairingId: "telegram_pairing:test/id",
      pairingExpiresAt: "2026-07-14T12:10:00.000Z",
      pairedAt: null,
      enabledAt: null,
      disabledAt: null,
      lastTestedAt: null,
      lastDeliveredAt: null,
      errorCode: null,
      errorAt: null,
      updatedAt: "2026-07-14T12:00:00.000Z"
    } as const;
    const pairing = {
      integration: status,
      pairing: {
        id: status.pairingId,
        pairingUrl: "https://t.me/space_test_bot?start=pairing-code",
        expiresAt: status.pairingExpiresAt,
        statusCode: "PAIRING_PENDING"
      }
    } as const;
    const jsonResponse = (payload: unknown, statusCode = 200) =>
      new Response(JSON.stringify(payload), {
        status: statusCode,
        headers: { "Content-Type": "application/json" }
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(status))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf:telegram", headerName: "x-space-csrf-token" }))
      .mockResolvedValueOnce(jsonResponse(pairing, 201))
      .mockResolvedValueOnce(jsonResponse({ ...status, connectionStatus: "CONNECTED", isEnabled: true }))
      .mockResolvedValueOnce(jsonResponse({ ...status, connectionStatus: "CONNECTED", isEnabled: true }))
      .mockResolvedValueOnce(jsonResponse({ ...status, connectionStatus: "DISABLED" }))
      .mockResolvedValueOnce(jsonResponse({ ...status, connectionStatus: "DISCONNECTED", botUsername: null, pairingId: null }));
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("../src/live-api.js");
    const syntheticToken = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE";

    await api.telegramIntegration();
    await api.createTelegramPairing(syntheticToken);
    await api.checkTelegramPairing(status.pairingId);
    await api.sendTelegramTestDelivery();
    await api.updateTelegramIntegration({ isEnabled: false });
    await api.disconnectTelegramIntegration();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/integrations/telegram", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/integrations/telegram/pairings", expect.objectContaining({
      method: "POST",
      credentials: "include",
      headers: expect.objectContaining({ "x-space-csrf-token": "csrf:telegram" }),
      body: JSON.stringify({ botToken: syntheticToken })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/integrations/telegram/pairings/telegram_pairing%3Atest%2Fid/check",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/integrations/telegram/test-deliveries", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(6, "/api/integrations/telegram", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ isEnabled: false })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(7, "/api/integrations/telegram", expect.objectContaining({ method: "DELETE" }));
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("posts pane move requests through the typed client", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "csrf:test", headerName: "x-space-csrf-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sourcePane: {
              id: "pane:source",
              roomId: "room:source",
              title: "Planner",
              mode: "CHAT",
              status: "IDLE",
              providerId: null,
              modelId: null,
              reasoningEffort: "medium",
              cwd: "/opt/spaceapp",
              order: 0,
              columnSpan: 1,
              isMaximized: false,
              isMinimized: false,
              isClosed: false,
              split: { parentId: null, direction: null, size: null },
              createdAt: "2026-07-09T00:00:00.000Z",
              updatedAt: "2026-07-09T00:00:00.000Z"
            },
            targetPane: {
              id: "pane:source",
              roomId: "room:target",
              title: "Planner",
              mode: "CHAT",
              status: "IDLE",
              providerId: null,
              modelId: null,
              reasoningEffort: "medium",
              cwd: "/opt/spaceapp",
              order: 0,
              columnSpan: 1,
              isMaximized: false,
              isMinimized: false,
              isClosed: false,
              split: { parentId: null, direction: null, size: null },
              createdAt: "2026-07-09T00:00:00.000Z",
              updatedAt: "2026-07-09T00:00:01.000Z"
            },
            sourceRoomId: "room:source",
            targetRoomId: "room:target"
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("../src/live-api.js");
    const moved = await api.movePane("pane:source", "room:target");

    expect(moved.targetPane.roomId).toBe("room:target");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/panes/pane%3Asource/move",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "x-space-csrf-token": "csrf:test" }),
        body: JSON.stringify({ targetRoomId: "room:target" })
      })
    );
  });

  it("uses owner-free clipboard resources with encoded filters and CSRF-protected writes", async () => {
    const item = {
      id: "clipboard:one",
      text: "private fallback",
      source: "COPY",
      roomId: null,
      paneId: null,
      paneTitle: null,
      occurrenceCount: 1,
      characterCount: 16,
      createdAt: "2026-07-15T10:00:00.000Z",
      lastUsedAt: "2026-07-15T10:00:00.000Z"
    } as const;
    const jsonResponse = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [item],
        pagination: { page: 2, pageSize: 40, totalItems: 41, totalPages: 2 }
      }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf:clipboard", headerName: "x-space-csrf-token" }))
      .mockResolvedValueOnce(jsonResponse(item, 201))
      .mockResolvedValueOnce(jsonResponse({ id: item.id, deleted: true }))
      .mockResolvedValueOnce(jsonResponse({ deletedCount: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("../src/live-api.js");
    await api.clipboardItems({ q: "private fallback", source: "COPY", page: 2, pageSize: 40 });
    await api.createClipboardItem({ text: item.text, source: "COPY" });
    await api.deleteClipboardItem(item.id);
    await api.clearClipboardItems();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/clipboard-items?q=private+fallback&source=COPY&page=2&pageSize=40",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/clipboard-items", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-space-csrf-token": "csrf:clipboard" }),
      body: JSON.stringify({ text: item.text, source: "COPY" })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/clipboard-items/clipboard%3Aone", expect.objectContaining({
      method: "DELETE"
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/clipboard-items", expect.objectContaining({ method: "DELETE" }));
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("ownerUserId");
  });

  it("encodes bounded memory graph and issue queries", async () => {
    const graphPayload = {
      data: {
        version: 1,
        generatedAt: "2026-07-13T08:00:00.000Z",
        sourceHash: "a".repeat(64),
        isStale: false,
        summary: { sourceCount: 2, recordCount: 0, nodeCount: 0, edgeCount: 0, issueCount: 0 },
        nodes: [],
        edges: [],
        filters: { q: "agent memory", nodeType: "MEMORY", roomId: null, sourcePath: null, lifecycleStatus: null }
      },
      pagination: { page: 2, pageSize: 100, totalItems: 0, totalPages: 0 }
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(graphPayload), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], pagination: graphPayload.pagination }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("../src/live-api.js");
    await api.memoryGraph({
      q: "agent memory",
      nodeType: "MEMORY",
      scope: "SYSTEM",
      relationMode: "RELATIONS",
      page: 2,
      pageSize: 100
    });
    await api.memoryGraphIssues({ severity: "WARN", status: "OPEN", pageSize: 50 });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/memory/graph?q=agent+memory&nodeType=MEMORY&scope=SYSTEM&relationMode=RELATIONS&page=2&pageSize=100",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/memory/issues?severity=WARN&status=OPEN&pageSize=50",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("uses typed memory change-set review and mutation command resources", async () => {
    const jsonResponse = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    const summary = { id: "memory_change:one", status: "PROPOSED" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [summary], pagination: { page: 2, pageSize: 25, hasNext: false } }))
      .mockResolvedValueOnce(jsonResponse({ ...summary, beforeSnapshot: "before", afterSnapshot: "after" }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf:memory", headerName: "x-space-csrf-token" }))
      .mockResolvedValueOnce(jsonResponse(summary))
      .mockResolvedValueOnce(jsonResponse({ ...summary, status: "APPROVED" }))
      .mockResolvedValueOnce(jsonResponse({ status: "SCHEDULED", workflowId: "space-memory-mutation:memory_change:one", runId: null }))
      .mockResolvedValueOnce(jsonResponse({ status: "ALREADY_SCHEDULED", workflowId: "space-memory-mutation:memory_change:one", runId: null }))
      .mockResolvedValueOnce(jsonResponse({ ...summary, id: "memory_change:rollback", kind: "ROLLBACK" }));
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("../src/live-api.js");
    await api.memoryChangeSets({ status: "PROPOSED", page: 2, pageSize: 25 });
    await api.memoryChangeSet("memory_change:one");
    await api.createMemoryChangeSet({
      kind: "EDIT",
      sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      recordIds: ["memory:agent"],
      resolvesIssueIds: [],
      expectedSourceHash: "a".repeat(64),
      beforeContentHash: "b".repeat(64),
      afterContentHash: "c".repeat(64),
      beforeSnapshot: "before",
      afterSnapshot: "after",
      reason: "Update the durable record."
    }, "memory-create:test-request");
    await api.reviewMemoryChangeSet("memory_change:one", { status: "APPROVED" });
    await api.executeMemoryChangeSet("memory_change:one", "memory-execute:test-request");
    await api.reconcileMemoryChangeSet("memory_change:one", "memory-reconcile:test-request");
    await api.createMemoryRollback(
      "memory_change:one",
      { reason: "Restore the audited before snapshot." },
      "memory-rollback:test-request"
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/memory/change-sets?status=PROPOSED&page=2&pageSize=25",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/admin/memory/change-sets/memory_change%3Aone", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/admin/memory/change-sets", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "x-space-csrf-token": "csrf:memory",
        "idempotency-key": "memory-create:test-request"
      })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/admin/memory/change-sets/memory_change%3Aone", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ status: "APPROVED" })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(6, "/api/admin/memory/change-sets/memory_change%3Aone/executions", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "idempotency-key": "memory-execute:test-request" }),
      body: JSON.stringify({})
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(7, "/api/admin/memory/change-sets/memory_change%3Aone/reconciliations", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "idempotency-key": "memory-reconcile:test-request" }),
      body: JSON.stringify({})
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(8, "/api/admin/memory/change-sets/memory_change%3Aone/rollbacks", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "idempotency-key": "memory-rollback:test-request" }),
      body: JSON.stringify({ reason: "Restore the audited before snapshot." })
    }));
  });

  it("uses typed issue-state and idempotent consolidation resources", async () => {
    const jsonResponse = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    const run = {
      id: "memory_consolidation:one",
      mode: "AUDIT",
      triggerKind: "OPERATOR",
      status: "QUEUED",
      workflowId: "space-memory-consolidation:one",
      dedupeKey: "operator:test:key",
      sourceHash: null,
      actorUserId: "user:operator",
      progressCompleted: 0,
      progressTotal: 0,
      findingCount: 0,
      appliedOperationCount: 0,
      skippedOperationCount: 0,
      failedOperationCount: 0,
      metrics: {},
      modelId: null,
      aiVerified: false,
      aiEvidence: {},
      statusReason: null,
      createdAt: "2026-07-13T08:00:00.000Z",
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-07-13T08:00:00.000Z"
    };
    const issue = {
      id: "issue:one",
      type: "DUPLICATE",
      severity: "WARN",
      status: "IGNORED",
      confidence: 1,
      recordId: "memory:one",
      sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      evidence: "Exact duplicate.",
      statusReason: "Reviewed duplicate.",
      stateVersion: 2,
      stateUpdatedAt: "2026-07-13T08:01:00.000Z"
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf:memory", headerName: "x-space-csrf-token" }))
      .mockResolvedValueOnce(jsonResponse(issue))
      .mockResolvedValueOnce(jsonResponse({
        run,
        schedule: { status: "SCHEDULED", workflowId: run.workflowId, runId: null },
        maintenanceEnabled: true,
        mutationsEnabled: false
      }))
      .mockResolvedValueOnce(jsonResponse({
        run,
        findings: [],
        operations: [],
        maintenanceEnabled: true,
        mutationsEnabled: false
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: "memory_change:archive",
        kind: "ARCHIVE",
        status: "PROPOSED"
      }));
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("../src/live-api.js");
    await api.updateMemoryGraphIssue("issue:one", {
      status: "IGNORED",
      reason: "Reviewed duplicate.",
      expectedVersion: 1
    });
    await api.createMemoryConsolidation({ mode: "AUDIT" }, "memory-audit:test-request");
    await api.memoryConsolidation("memory_consolidation:one");
    await api.createMemoryNodeChangeSet("memory:one", {
      kind: "ARCHIVE",
      expectedContentHash: "a".repeat(64),
      reason: "Archive the reviewed durable fact."
    }, "memory-node:archive-request");

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/admin/memory/issues/issue%3Aone", expect.objectContaining({
      method: "PATCH",
      headers: expect.objectContaining({ "x-space-csrf-token": "csrf:memory" }),
      body: JSON.stringify({ status: "IGNORED", reason: "Reviewed duplicate.", expectedVersion: 1 })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/admin/memory/consolidations", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "idempotency-key": "memory-audit:test-request" }),
      body: JSON.stringify({ mode: "AUDIT" })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/admin/memory/consolidations/memory_consolidation%3Aone",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/admin/memory/nodes/memory%3Aone/change-sets", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "idempotency-key": "memory-node:archive-request" }),
      body: JSON.stringify({
        kind: "ARCHIVE",
        expectedContentHash: "a".repeat(64),
        reason: "Archive the reviewed durable fact."
      })
    }));
  });

  it("surfaces proxy HTML 413 responses as a useful upload error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "csrf:test", headerName: "x-space-csrf-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response("<!doctype html><html><body><h1>413 Request Entity Too Large</h1></body></html>", {
          status: 413,
          headers: { "Content-Type": "text/html" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("../src/live-api.js");

    await expect(
      api.uploadCliFiles({
        paneId: "pane:cli-upload",
        source: "DROP",
        files: [new File(["video"], "recording.mp4", { type: "video/mp4" })]
      })
    ).rejects.toMatchObject({
      name: "SpaceApiError",
      status: 413,
      message: "UPLOAD_TOO_LARGE: Request exceeded the live proxy or API upload size limit."
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/auth/csrf",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/panes/pane%3Acli-upload/cli/uploads?source=DROP",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "x-space-csrf-token": "csrf:test" })
      })
    );
  });

  it("uses the browser v2 stream, control and capture wire contracts", async () => {
    const jsonResponse = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf:browser", headerName: "x-space-csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ session: {}, frame: null, websocket: null }))
      .mockResolvedValueOnce(jsonResponse({ lease: {} }))
      .mockResolvedValueOnce(jsonResponse({ job: {} }))
      .mockResolvedValueOnce(jsonResponse({ job: {} }))
      .mockResolvedValueOnce(jsonResponse({ job: {} }))
      .mockResolvedValueOnce(jsonResponse({ jobId: "capture:recording", segments: [] }))
      .mockResolvedValueOnce(jsonResponse({ jobId: "capture:recording", sessionId: "browser:session", durationMs: 0, frameCount: 0, segmentCount: 0, frames: [], events: [] }))
      .mockResolvedValueOnce(jsonResponse({ durationMs: 1_000, fps: 10, frameCount: 10 }));
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("../src/live-api.js");
    await api.updateBrowserSession("pane:browser-v2", { streamMode: "REALTIME" });
    await api.acquireBrowserControl("pane:browser-v2", {
      holderType: "OPERATOR",
      holderId: "space-user",
      reason: "Human takeover",
      ttlSeconds: 60
    });
    await api.createBrowserCapture("pane:browser-v2", {
      options: { kind: "SCREENSHOT", format: "PNG", target: "VIEWPORT", selector: null, quality: null }
    });
    await api.stopBrowserCapture("pane:browser-v2", "capture:recording");
    await api.cancelBrowserCapture("pane:browser-v2", "capture:recording");
    await api.browserCaptureSegments("pane:browser-v2", "capture:recording");
    await api.browserCaptureTimeline("pane:browser-v2", "capture:recording");
    await api.browserRecordingManifest("artifact:manifest");

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/panes/pane%3Abrowser-v2/browser/session",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ streamMode: "REALTIME" }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/panes/pane%3Abrowser-v2/browser/control/acquire",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ holderType: "OPERATOR", holderId: "space-user", reason: "Human takeover", ttlSeconds: 60 })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/panes/pane%3Abrowser-v2/browser/captures",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ options: { kind: "SCREENSHOT", format: "PNG", target: "VIEWPORT", selector: null, quality: null } })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "/api/panes/pane%3Abrowser-v2/browser/captures/capture%3Arecording/stop",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock.mock.calls[4]?.[1]).not.toHaveProperty("body");
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "/api/panes/pane%3Abrowser-v2/browser/captures/capture%3Arecording/cancel",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock.mock.calls[5]?.[1]).not.toHaveProperty("body");
    expect(fetchMock).toHaveBeenNthCalledWith(
      7,
      "/api/panes/pane%3Abrowser-v2/browser/captures/capture%3Arecording/segments",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      8,
      "/api/panes/pane%3Abrowser-v2/browser/captures/capture%3Arecording/timeline",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      9,
      "/api/artifacts/artifact%3Amanifest/file",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("sends app diagnostics mutations with CSRF and preserves binary WebM uploads", async () => {
    const jsonResponse = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(
      jsonResponse(
        String(url) === "/api/auth/csrf"
          ? { csrfToken: "csrf:app-diagnostics", headerName: "x-space-csrf-token" }
          : {}
      )
    ));
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("../src/live-api.js");
    await api.updateAppDiagnosticsStatus(true);
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]);
    await api.uploadAppDiagnosticsVideoSegment({
      leaseId: "app_debug_lease:api-test",
      sequence: 3,
      startedAt: "2026-07-24T10:00:00.000Z",
      endedAt: "2026-07-24T10:00:30.000Z",
      firstEventSequence: 12,
      lastEventSequence: 18,
      mimeType: "video/webm;codecs=vp8"
    }, bytes);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/app-diagnostics",
      expect.objectContaining({
        method: "PATCH",
        credentials: "include",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-space-csrf-token": "csrf:app-diagnostics"
        }),
        body: JSON.stringify({ isEnabled: true })
      })
    );
    const uploadCall = fetchMock.mock.calls[2];
    expect(String(uploadCall?.[0])).toBe(
      "/api/admin/app-diagnostics/video-segments/app_debug_lease%3Aapi-test/3" +
      "?startedAt=2026-07-24T10%3A00%3A00.000Z" +
      "&endedAt=2026-07-24T10%3A00%3A30.000Z" +
      "&firstEventSequence=12&lastEventSequence=18"
    );
    expect(uploadCall?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      credentials: "include",
      headers: expect.objectContaining({
        "Content-Type": "video/webm",
        "x-space-csrf-token": "csrf:app-diagnostics"
      }),
      body: expect.any(ArrayBuffer)
    }));
    expect(Array.from(new Uint8Array(uploadCall?.[1]?.body as ArrayBuffer))).toEqual(Array.from(bytes));
  });
});
