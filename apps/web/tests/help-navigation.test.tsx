import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  const base: Record<string, any> = {
    me: vi.fn(),
    readyz: vi.fn(),
    rooms: vi.fn(),
    providers: vi.fn(),
    providerSettings: vi.fn(),
    models: vi.fn(),
    skills: vi.fn(),
    imports: vi.fn(),
    admin: vi.fn(),
    mcp: vi.fn(),
    latestMcpDiscoverySmoke: vi.fn(),
    latestMemoryEmbeddingSmoke: vi.fn(),
    memoryVectorReadiness: vi.fn(),
    codexAppServer: vi.fn(),
    latestCodexAppServerHandshake: vi.fn(),
    latestCodexAppServerTurnSmoke: vi.fn(),
    storage: vi.fn(),
    observability: vi.fn(),
    worker: vi.fn(),
    swarm: vi.fn(),
    codexEnvironment: vi.fn(),
    cliVpnRoutingStatus: vi.fn(),
    cliRuntimeSettings: vi.fn(),
    cliRuntimes: vi.fn(),
    logout: vi.fn()
  };
  return new Proxy(base, {
    get(target, prop: string) {
      if (!(prop in target)) {
        target[prop] = vi.fn().mockResolvedValue({});
      }
      return target[prop];
    }
  });
});

vi.mock("../src/api.js", () => ({
  api,
  SpaceApiError: class SpaceApiError extends Error {
    code = "TEST_ERROR";
  }
}));

import { App } from "../src/App.js";
import { SpaceRuntimeProvider } from "../src/runtime/SpaceRuntime.js";
import { VoiceInputProvider } from "../src/features/voice-input/VoiceInputProvider.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";

function installAuthenticatedFixtures() {
  api.me.mockResolvedValue({
    user: { id: "user:operator", email: "space@space.local", role: "ADMIN" },
    isAuthenticated: true,
    isSetupRequired: false
  });
  api.readyz.mockResolvedValue({
    ok: true,
    dependencies: {
      store: "postgres",
      runtimeStore: "postgres",
      eventBus: "in-process",
      temporal: "enabled",
      worker: "RUNNING",
      codexTurns: "enabled",
      codexLb: "configured"
    }
  });
  api.rooms.mockResolvedValue({ data: [], pagination: { totalPages: 1, totalItems: 0, page: 1, pageSize: 100 } });
  api.providers.mockResolvedValue({ data: [] });
  api.providerSettings.mockResolvedValue({ defaultProviderId: "codex-lb", updatedAt: null });
  api.models.mockResolvedValue({ data: [] });
  api.skills.mockResolvedValue({ data: [] });
  api.imports.mockResolvedValue({ data: [] });
  api.admin.mockResolvedValue({ storageWarning: "" });
  api.mcp.mockResolvedValue({ gateway: { status: "ENABLED", serverCount: 0, toolCount: 0 } });
  api.latestMcpDiscoverySmoke.mockResolvedValue({ data: null });
  api.latestMemoryEmbeddingSmoke.mockResolvedValue({ data: null });
  api.memoryVectorReadiness.mockResolvedValue({ data: null });
  api.codexAppServer.mockResolvedValue({ status: "READY" });
  api.latestCodexAppServerHandshake.mockResolvedValue({ data: null });
  api.latestCodexAppServerTurnSmoke.mockResolvedValue({ data: null });
  api.storage.mockResolvedValue({ status: "VERIFIED" });
  api.observability.mockResolvedValue({ totals: { requestCount: 0, errorCount: 0, p95Ms: 0 } });
  api.worker.mockResolvedValue({ status: "RUNNING" });
  api.swarm.mockResolvedValue({ tasks: [], locks: [], messages: [], reconciles: [] });
  api.codexEnvironment.mockResolvedValue(null);
  api.cliVpnRoutingStatus.mockResolvedValue({ selectedRoute: null });
  api.cliRuntimeSettings.mockResolvedValue({ settings: [], harness: { enabled: true } });
  api.cliRuntimes.mockResolvedValue([]);
  api.setupOverview.mockResolvedValue({ isComplete: true, connections: [] });
  api.logout.mockResolvedValue(undefined);
}

describe("Space Help navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAuthenticatedFixtures();
    window.localStorage.setItem("space.uiTheme.v1", "classic");
    window.history.replaceState({}, "", "/");
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("opens embedded Help from Workspace and returns without changing the route", async () => {
    const bundle = createDemoRuntime();
    bundle.runtime.platform.localStorage.setItem("space.uiTheme.v1", "classic");
    render(<SpaceRuntimeProvider runtime={bundle.runtime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>);

    const pane = document.querySelector("[data-space-pane-id]");
    fireEvent.click(await screen.findByRole("button", { name: "Workspace" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Utilities" }));
    fireEvent.click(await screen.findByRole("button", { name: "Help" }));
    expect(window.location.pathname).toBe("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Space Help" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to Space" }));
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(await screen.findByRole("tab", { name: "Utilities" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "Space Help" })).toBeNull();
    expect(document.querySelector("[data-space-pane-id]")).toBe(pane);
  });

  it("supports direct authenticated /help loads and browser popstate navigation", async () => {
    window.history.replaceState({}, "", "/help");
    const bundle = createDemoRuntime();
    render(<SpaceRuntimeProvider runtime={bundle.runtime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>);

    expect(await screen.findByRole("heading", { level: 1, name: "Space Help" })).toBeTruthy();
    window.history.replaceState({}, "", "/");
    fireEvent(window, new PopStateEvent("popstate"));

    expect(await screen.findByRole("heading", { level: 2, name: "No room" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "Space Help" })).toBeNull();
  });
});
