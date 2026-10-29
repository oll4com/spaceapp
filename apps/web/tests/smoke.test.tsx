import { workspaceAction } from "./workspace-navigation.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, PaneCapabilityMatrix } from "@space/contracts";
import { LiveSpaceApp as App } from "../src/live/LiveSpaceApp.js";
import { demoHealthSnapshot } from "../src/demo/demo-health.js";

function setDesktopViewport() {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
  window.dispatchEvent(new Event("resize"));
}

const healthCheckedAt = "2026-06-27T00:00:00.000Z";

// The API maps /api/admin/storage readiness into this Resources service card (apps/api/src/app.ts "storage" check).
function storageReadinessService(statusReason: string) {
  return {
    id: "storage", label: "Storage readiness", status: "critical", detail: statusReason, checkedAt: healthCheckedAt,
    values: [{ label: "Dedicated volume", value: "No" }, { label: "Minimum free space", value: "150 GiB" }]
  };
}

function healthSnapshotWithServices(services: Array<Record<string, unknown>>, values: Record<string, number> = {}) {
  const snapshot = demoHealthSnapshot(healthCheckedAt);
  return {
    ...snapshot,
    metrics: snapshot.metrics.map((metric) => (metric.id in values ? { ...metric, value: values[metric.id] } : metric)),
    services
  };
}

async function openServiceReadiness() {
  const resources = await screen.findByRole("dialog", { name: "Resources" });
  fireEvent.click(within(resources).getByRole("button", { name: /^System/ }));
  fireEvent.change(within(resources).getByRole("combobox", { name: "Resource view" }), { target: { value: "services" } });
  expect(await within(resources).findByRole("heading", { name: "Services & infrastructure" })).toBeTruthy();
  return resources;
}

async function findServiceCard(label: string) {
  const resources = screen.getByRole("dialog", { name: "Resources" });
  return (await within(resources).findByRole("heading", { name: label })).closest("article") as HTMLElement;
}

function agentSessionFixture(input: {
  paneId: string;
  roomId: string;
  title: string;
  message: string;
  selectedModelConfigId?: string;
  selectedProviderName?: string;
  selectedModelName?: string;
  selectedReasoningKey?: string;
  selectedToolIds?: string[];
  modelOptions?: Array<Record<string, unknown>>;
  modelCatalog?: Array<Record<string, unknown>>;
  toolOptions?: Array<Record<string, unknown>>;
  threadId?: string | null;
}) {
  const selectedModelConfigId = input.selectedModelConfigId ?? "gpt-5.5";
  const selectedProviderName = input.selectedProviderName ?? "OpenAI";
  const selectedModelName = input.selectedModelName ?? "gpt-5.5";
  const selectedReasoningKey = input.selectedReasoningKey ?? "high";
  const selectedToolIds = input.selectedToolIds ?? [];
  return {
    binding: {
      paneId: input.paneId,
      source: "SPACE",
      sessionId: `agent_session:${input.paneId}`,
      coderChatId: null,
      status: "READY",
      title: input.title,
      selectedModelConfigId,
      selectedProviderName,
      selectedModelName,
      selectedReasoningKey,
      selectedToolIds,
      lastSyncedAt: "2026-06-27T00:00:00.000Z"
    },
    threadId: input.threadId ?? null,
    messages: [
      {
        id: `msg:${input.paneId}`,
        role: "assistant",
        content: input.message,
        status: "COMPLETED",
        createdAt: "2026-06-27T00:00:00.000Z"
      }
    ],
    runStatus: "IDLE",
    statusReason: "Space agent session is ready.",
    modelOptions: input.modelOptions ?? [
      {
        id: selectedModelConfigId,
        displayName: selectedModelName,
        providerId: selectedProviderName.toLowerCase(),
        providerName: selectedProviderName,
        model: selectedModelName,
        reasoningKey: selectedReasoningKey,
        reasoningLabel: "High reasoning",
        isDefault: true
      }
    ],
    modelCatalog: input.modelCatalog ?? [],
    // Required by agentPaneSessionSchema (defaults to []); AgentPane reads it unguarded.
    modelProviders: [],
    selectedModelConfigId,
    toolOptions: input.toolOptions ?? [],
    selectedToolIds,
    history: [
      {
        paneId: input.paneId,
        roomId: input.roomId,
        source: "SPACE",
        sessionId: `agent_session:${input.paneId}`,
        coderChatId: null,
        status: "READY",
        title: input.title,
        selectedModelConfigId,
        selectedProviderName,
        selectedModelName,
        selectedReasoningKey,
        selectedToolIds,
        lastSyncedAt: "2026-06-27T00:00:00.000Z",
        paneTitle: input.title,
        paneIsClosed: false,
        updatedAt: "2026-06-27T00:00:00.000Z"
      }
    ],
    capabilities: {
      canSend: true,
      canInterrupt: false,
      canSelectModel: true,
      canSelectTools: true,
      supportsTools: true
    }
  };
}

function codexEnvironmentPayload(input: { model?: string; reasoningEffort?: string; hostStats?: Record<string, unknown> } = {}) {
  return {
    codexHome: "/var/lib/spaceapp-user/.codex",
    stateDbPath: "/var/lib/spaceapp-user/.codex/state_5.sqlite",
    config: {
      modelProvider: "space-gateway",
      model: input.model ?? "gpt-5.5",
      reasoningEffort: input.reasoningEffort ?? "high"
    },
    mcpServers: ["devtools", "summary_tools"],
    skillCount: 12,
    pluginCount: 2,
    memories: {
      generateMemories: true,
      useMemories: true
    },
    features: {
      plugins: true,
      memories: true
    },
    lbUsage: {
      allAccountsRemainingPercent: 61.8,
      activeAccountsRemainingPercent: 44.2,
      routeMode: "headroom",
      routeTargetMode: "auto",
      upstream: "headroom",
      source: "weekly-remaining",
      error: null,
      checkedAt: "2026-07-06T00:00:00.000Z"
    },
    spaceStats: {
      roomCount: 3,
      agentPaneCount: 5,
      activeAgentPaneCount: 2,
      cliPaneCount: 4,
      chatPaneCount: 5,
      browserPaneCount: 1,
      checkedAt: "2026-07-06T00:00:00.000Z"
    },
    hostStats: input.hostStats ?? {
      cliSessions: {
        active: 3,
        attached: 2,
        detached: 1,
        status: "OK"
      },
      cpu: {
        usagePercent: 17.2,
        coreCount: 16
      },
      memory: {
        usedBytes: 8_589_934_592,
        totalBytes: 10_737_418_240,
        usagePercent: 80
      },
      swap: {
        usedBytes: 1_073_741_824,
        totalBytes: 10_737_418_240,
        usagePercent: 10
      },
      apiStartedAt: "2026-07-14T09:00:00.000Z",
      sampledAt: "2026-07-14T09:00:10.000Z"
    },
    checkedAt: "2026-07-06T00:00:00.000Z"
  };
}

function codexHistoryPayload(input: { title?: string; preview?: string } = {}) {
  const title = input.title ?? "Codex Shared Task";
  const preview = input.preview ?? "shared Codex history";
  return {
    data: [
      {
        id: "019f-codex-smoke",
        rolloutPath: "/var/lib/spaceapp-user/.codex/sessions/2026/07/06/rollout-019f-codex-smoke.jsonl",
        title,
        preview,
        model: "gpt-5.5",
        reasoningEffort: "high",
        cwd: "/opt/spaceapp",
        archived: false,
        source: "vscode",
        modelProvider: "codex-lb",
        threadSource: "user",
        firstUserMessage: preview,
        updatedAt: "2026-07-06T00:00:01.000Z",
        recencyAt: "2026-07-06T00:00:01.000Z"
      }
    ],
    totalItems: 1,
    visibleItems: 1,
    checkedAt: "2026-07-06T00:00:02.000Z"
  };
}

// live-api keeps module-level request caches (10-15 s TTL, e.g. /api/codex/environment and
// /api/admin/cli-sessions); start every test past their expiry so one test's fixture is never reused.
const realDateNow = Date.now.bind(Date);
let dateOffsetMs = 0;

describe("Space web shell", () => {
  beforeEach(() => {
    setDesktopViewport();
    dateOffsetMs += 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + dateOffsetMs);
  });

  it("renders the login surface when unauthenticated", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      json: async () => ({ user: null, isAuthenticated: false, isSetupRequired: false })
    }));
    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Space" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Enter" })).toBeTruthy();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/auth/me",
      "/api/setup/status"
    ]);
  });

  it("explains domain login failures after the canonical hostname cutover", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/auth/login") {
          return {
            ok: false,
            status: 401,
            json: async () => ({
              error: {
                code: "INVALID_CREDENTIALS",
                message: "Email or password is not valid.",
                requestId: "req:test-login"
              }
            })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ user: null, isAuthenticated: false, isSetupRequired: false })
        };
      })
    );

    render(<App />);

    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "space-dev" } });
    fireEvent.click(await screen.findByRole("button", { name: "Enter" }));

    const rejection = await screen.findByText(/Use the configured operator credentials/);
    expect(rejection.textContent).toContain("owner reset-password");
  });

  it("loads authenticated Space data immediately after login", async () => {
    const requests: string[] = [];
    let loggedIn = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url}`);

        const authenticated = {
          user: { id: "user:operator", email: "space@space.local", role: "ADMIN" },
          isAuthenticated: true,
          isSetupRequired: false
        };
        if (method === "POST" && url === "/api/auth/login") loggedIn = true;
        const payloads: Record<string, unknown> = {
          "/api/setup/status": { setupRequired: false, expiresAt: null },
          "/api/auth/login": authenticated,
          "/readyz": {
            ok: true,
            dependencies: {
              store: "postgres",
              runtimeStore: "postgres",
              eventBus: "in-process",
              temporal: "enabled",
              worker: "RUNNING",
              codexTurns: "disabled",
              codexLb: "disabled"
            }
          },
          "/api/rooms?all=true": {
            data: [
              {
                id: "room:after-login",
                name: "Room 1",
                description: null,
                paneCap: 16,
                createdAt: "2026-06-26T00:00:00.000Z",
                updatedAt: "2026-06-26T00:00:00.000Z",
                archivedAt: null,
                traceId: "req:after-login"
              },
              {
                id: "room:after-login-2",
                name: "Room 2",
                description: null,
                paneCap: 16,
                createdAt: "2026-06-26T00:00:00.000Z",
                updatedAt: "2026-06-26T00:00:00.000Z",
                archivedAt: null,
                traceId: "req:after-login-2"
              }
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 }
          },
          "/api/providers": {
            data: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/provider-settings": { defaultProviderId: "headroom-gateway", updatedAt: "2026-07-06T00:00:00.000Z" },
          "/api/models": {
            data: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/skills": {
            data: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/imports": {
            data: [],
            pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
          },
          "/api/swarm?roomId=room%3Aafter-login": {
            tasks: [],
            locks: [],
            messages: [],
            reconciles: [],
            executionStatus: "DISABLED",
            statusReason: "Swarm execution is control-plane only until worker/agent smoke is explicitly approved and verified."
          },
          "/api/admin": {
            status: "ok",
            mode: "dev",
            storageWarning: "Dedicated /opt/spaceapp volume is still required before production/browser-heavy launch."
          },
          "/api/mcp": {
            data: [],
            gateway: {
              id: "mcp-gateway",
              status: "DISABLED",
              statusReason: "MCP discovery metadata is not verified; tool execution is disabled.",
              targetSpecVersion: "2025-11-25",
              approvalMode: "DISABLED",
              serverCount: 0,
              toolCount: 0,
              lastDiscoveryAt: null
            },
            servers: [],
            tools: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/admin/mcp/discovery-smoke": { data: null },
          "/api/admin/memory/embedding-smoke": { data: null },
          "/api/admin/memory/vector-readiness": {
            data: {
              id: "memory-vector-readiness",
              status: "VERIFIED",
              code: "MEMORY_VECTOR_READY",
              message: "pgvector extension, memory embedding column and HNSW vector index are ready.",
              runtimeStore: "postgres",
              extensionInstalled: true,
              extensionVersion: "0.8.3",
              embeddingColumnReady: true,
              embeddingDimensions: 1536,
              expectedDimensions: 1536,
              vectorIndexReady: true,
              checkedAt: "2026-06-26T00:00:00.000Z"
            }
          },
          "/api/admin/codex-app-server": {
            id: "codex-app-server",
            status: "DISABLED",
            reasonCode: "DISABLED_BY_DEFAULT",
            statusReason: "Codex App Server adapter is disabled by default. No Codex process is spawned or connected.",
            transport: "stdio",
            command: "codex",
            socketPath: null,
            websocketUrl: null,
            schemasGenerated: false,
            schemaManifest: null,
            lastCheckedAt: "2026-06-26T00:00:00.000Z"
          },
          "/api/admin/codex-app-server/handshake": { data: null },
          "/api/admin/codex-app-server/turn-smoke": { data: null },
          "/api/admin/storage": {
            id: "space-storage",
            status: "BLOCKED",
            statusReason: "Dedicated /opt/spaceapp volume is not detected.",
            root: { path: "/", deviceId: "100", sizeBytes: 214748364800, availableBytes: 42949672960, usedPercent: 80 },
            app: { path: "/opt/spaceapp", deviceId: "100", sizeBytes: 214748364800, availableBytes: 42949672960, usedPercent: 80 },
            dedicatedAppVolume: false,
            minimumRecommendedFreeBytes: 161061273600,
            checkedAt: "2026-06-26T00:00:01.000Z"
          },
          "/api/admin/observability": {
            service: "space-api",
            generatedAt: "2026-06-26T00:00:00.000Z",
            runtime: {
              startedAt: "2026-06-26T00:00:00.000Z",
              uptimeSeconds: 120,
              nodeVersion: "v22.23.0",
              pid: 207,
              memory: {
                rssBytes: 134217728,
                heapUsedBytes: 67108864,
                heapTotalBytes: 100663296,
                externalBytes: 1048576,
                arrayBuffersBytes: 524288
              }
            },
            totals: {
              requestCount: 24,
              errorCount: 0,
              errorRate: 0,
              p50Ms: 3.2,
              p95Ms: 12.4,
              p99Ms: 18.8
            },
            endpoints: [
              {
                method: "GET",
                route: "/api/rooms",
                statusClass: "2xx",
                requestCount: 3,
                errorCount: 0,
                durationMs: {
                  count: 3,
                  min: 2,
                  max: 12.4,
                  average: 5.8,
                  p50: 3.2,
                  p95: 12.4,
                  p99: 12.4
                },
                lastSeenAt: "2026-06-26T00:00:00.000Z"
              }
            ]
          },
          "/api/admin/worker": {
            id: "space-worker",
            status: "RUNNING",
            statusReason: "Temporal worker pollers are visible.",
            address: "127.0.0.1:7233",
            namespace: "default",
            taskQueue: "space-agent-turns",
            reachable: true,
            workflowPollerCount: 1,
            activityPollerCount: 1,
            pollerCount: 2,
            workflowBacklogCount: 0,
            activityBacklogCount: 0,
            pollerIdentities: ["space-worker@test"],
            lastPollerAccessAt: "2026-06-26T00:00:00.000Z",
            checkedAt: "2026-06-26T00:00:01.000Z"
          },
          "/api/panes?roomId=room%3Aafter-login": {
            data: [
              {
                id: "pane:after-login",
                roomId: "room:after-login",
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
                createdAt: "2026-06-26T00:00:00.000Z",
                updatedAt: "2026-06-26T00:00:00.000Z"
              }
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
          },
          "/api/turns?roomId=room%3Aafter-login": {
            data: [],
            pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
          },
          "/api/events?roomId=room%3Aafter-login&pageSize=50&sortOrder=desc": {
            data: [
              {
                id: "event:after-login-room",
                roomId: "room:after-login",
                paneId: null,
                turnId: null,
                workflowId: null,
                traceId: "req:after-login",
                type: "ROOM_CREATED",
                message: "Room created.",
                payload: { roomId: "room:after-login" },
                createdAt: "2026-06-26T00:00:00.000Z"
              }
            ],
            pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 }
          },
          "/api/panes?roomId=room%3Aafter-login-2": {
            data: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/turns?roomId=room%3Aafter-login-2": {
            data: [],
            pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
          },
          "/api/events?roomId=room%3Aafter-login-2&pageSize=50&sortOrder=desc": {
            data: [],
            pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 }
          },
          "/api/swarm?roomId=room%3Aafter-login-2": {
            tasks: [],
            locks: [],
            messages: [],
            reconciles: [],
            executionStatus: "DISABLED",
            statusReason: "Swarm execution is control-plane only until worker/agent smoke is explicitly approved and verified."
          },
          "/api/auth/csrf": { csrfToken: "csrf:test", headerName: "x-space-csrf-token" }
        };

        if (method === "DELETE" && url.startsWith("/api/rooms/")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, roomId: decodeURIComponent(url.split("/").at(-1) ?? "") })
          };
        }

        const payload =
          url === "/api/auth/me"
            ? !loggedIn
              ? { user: null, isAuthenticated: false, isSetupRequired: false }
              : authenticated
            : payloads[url];

        return {
          ok: true,
          status: 200,
          json: async () => payload
        };
      })
    );

    render(<App />);

    const password = await screen.findByLabelText("Password");
    expect(requests.some(request => request.includes("/api/rooms"))).toBe(false);
    fireEvent.change(password, { target: { value: "example-login-value" } });
    fireEvent.click(await screen.findByRole("button", { name: "Enter" }));

    expect(await screen.findByRole("heading", { name: "Room 1" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Open Room 2" })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(requests.filter(request => request === "POST /api/auth/login")).toHaveLength(1);
    await waitFor(() => {
      for (const url of [
        "/api/rooms?all=true", "/api/panes?roomId=room%3Aafter-login",
        "/api/swarm?roomId=room%3Aafter-login", "/api/turns?roomId=room%3Aafter-login",
        "/api/events?roomId=room%3Aafter-login&pageSize=50&sortOrder=desc"
      ]) expect(requests).toContain(`GET ${url}`);
    });
    // Settings remain lazy after authentication, then load through the actual Workspace menu.
    expect(requests).not.toContain("GET /api/providers");
    fireEvent.click(await workspaceAction(/^(Open|Show) settings dock$/, "Docks", true));
    expect(await screen.findByRole("searchbox", { name: "Search settings" })).toBeTruthy();
    await waitFor(() => expect(requests).toContain("GET /api/providers"));
    expect(requests).toContain("GET /api/provider-settings");
    expect(screen.getByRole("heading", { name: "Room 1" })).toBeTruthy();
  });

  it("suppresses transient upstream restart banners during background room polling", async () => {
    const roomId = "room:restart-proof";
    const roomIdParam = encodeURIComponent(roomId);
    const runtimeCallCounts = {
      panes: 0,
      swarm: 0,
      turns: 0,
      events: 0
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const ok = (payload: unknown) => ({
          ok: true,
          status: 200,
          json: async () => payload
        });
        const upstreamUnavailable = {
          ok: false,
          status: 502,
          json: async () => ({
            error: {
              code: "UPSTREAM_UNAVAILABLE",
              message: "Space API is not reachable from the web server.",
              requestId: "space-web"
            }
          })
        };
        const panePayload = { data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } };
        const swarmPayload = {
          tasks: [],
          locks: [],
          messages: [],
          reconciles: [],
          executionStatus: "DISABLED",
          statusReason: "Swarm execution is disabled."
        };
        const turnPayload = { data: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } };
        const eventPayload = { data: [], pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 } };
        const runtimeResponse = (key: keyof typeof runtimeCallCounts, payload: unknown) => {
          runtimeCallCounts[key] += 1;
          return runtimeCallCounts[key] === 2 ? upstreamUnavailable : ok(payload);
        };

        const payloads: Record<string, unknown> = {
          "/api/auth/me": {
            user: { id: "user:operator", email: "space@space.local", role: "ADMIN" },
            isAuthenticated: true,
            isSetupRequired: false
          },
          "/readyz": {
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
          },
          "/api/rooms?all=true": {
            data: [
              {
                id: roomId,
                name: "Transient restart room",
                description: null,
                paneCap: 16,
                createdAt: "2026-07-07T00:00:00.000Z",
                updatedAt: "2026-07-07T00:00:00.000Z",
                archivedAt: null,
                traceId: "req:restart-proof"
              }
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
          },
          "/api/providers": { data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
          "/api/provider-settings": { defaultProviderId: "headroom-gateway", updatedAt: "2026-07-07T00:00:00.000Z" },
          "/api/models": { data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
          "/api/skills": { data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
          "/api/imports": { data: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } },
          "/api/admin": { status: "ok", mode: "dev", storageWarning: "" },
          "/api/mcp": {
            data: [],
            gateway: {
              id: "mcp-gateway",
              status: "DISABLED",
              statusReason: "MCP metadata only.",
              targetSpecVersion: "2025-11-25",
              approvalMode: "DISABLED",
              serverCount: 0,
              toolCount: 0,
              lastDiscoveryAt: null
            },
            servers: [],
            tools: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/admin/mcp/discovery-smoke": { data: null },
          "/api/admin/memory/embedding-smoke": { data: null },
          "/api/admin/memory/vector-readiness": {
            data: {
              id: "memory-vector-readiness",
              status: "DISABLED",
              code: "VECTOR_STORE_NOT_POSTGRES",
              message: "Vector store is not ready.",
              runtimeStore: "postgres",
              extensionInstalled: false,
              extensionVersion: null,
              embeddingColumnReady: false,
              embeddingDimensions: null,
              expectedDimensions: 1536,
              vectorIndexReady: false,
              checkedAt: "2026-07-07T00:00:00.000Z"
            }
          },
          "/api/admin/codex-app-server": {
            id: "codex-app-server",
            status: "READY",
            reasonCode: "CONFIG_SAFE",
            statusReason: "Codex App Server config is safe.",
            transport: "stdio",
            command: "codex",
            socketPath: null,
            websocketUrl: null,
            schemasGenerated: true,
            schemaManifest: null,
            lastCheckedAt: "2026-07-07T00:00:00.000Z"
          },
          "/api/admin/codex-app-server/handshake": { data: null },
          "/api/admin/codex-app-server/turn-smoke": { data: null },
          "/api/admin/storage": {
            id: "space-storage",
            status: "VERIFIED",
            statusReason: "Storage ready.",
            root: { path: "/", deviceId: "100", sizeBytes: 100, availableBytes: 80, usedPercent: 20 },
            app: { path: "/opt/spaceapp", deviceId: "101", sizeBytes: 100, availableBytes: 80, usedPercent: 20 },
            dedicatedAppVolume: true,
            minimumRecommendedFreeBytes: 1,
            checkedAt: "2026-07-07T00:00:00.000Z"
          },
          "/api/admin/observability": {
            service: "space-api",
            generatedAt: "2026-07-07T00:00:00.000Z",
            runtime: {
              startedAt: "2026-07-07T00:00:00.000Z",
              uptimeSeconds: 1,
              nodeVersion: "v22.23.0",
              pid: 207,
              memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 0, arrayBuffersBytes: 0 }
            },
            totals: { requestCount: 0, errorCount: 0, errorRate: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
            endpoints: []
          },
          "/api/admin/worker": {
            id: "space-worker",
            status: "RUNNING",
            statusReason: "Temporal worker pollers are visible.",
            address: "127.0.0.1:7233",
            namespace: "default",
            taskQueue: "space-agent-turns",
            reachable: true,
            workflowPollerCount: 1,
            activityPollerCount: 1,
            pollerCount: 2,
            workflowBacklogCount: 0,
            activityBacklogCount: 0,
            pollerIdentities: [],
            lastPollerAccessAt: "2026-07-07T00:00:00.000Z",
            checkedAt: "2026-07-07T00:00:00.000Z"
          },
          "/api/cli/runtimes": { data: [], checkedAt: "2026-07-07T00:00:00.000Z" },
          "/api/browser/status": {
            enabled: false,
            statusReason: "Browser sessions are mediated.",
            defaultUrl: "http://127.0.0.1:4911/",
            checkedAt: "2026-07-07T00:00:00.000Z"
          },
          "/api/voice/transcription/settings": {
            enabled: true,
            statusReason: "OpenAI Realtime transcription is configured.",
            defaultModel: "gpt-live-transcribe",
            modelOptions: ["gpt-live-transcribe"],
            defaultLanguage: "auto",
            languageOptions: ["auto", "el", "en"],
            defaultDelay: "minimal",
            delayOptions: ["minimal", "low", "medium", "high", "xhigh"],
            maxBytes: 26214400,
            maxDurationMs: 60000,
            updatedAt: "2026-07-07T00:00:00.000Z"
          }
        };

        if (url === `/api/panes?roomId=${roomIdParam}`) return runtimeResponse("panes", panePayload);
        if (url === `/api/swarm?roomId=${roomIdParam}`) return runtimeResponse("swarm", swarmPayload);
        if (url === `/api/turns?roomId=${roomIdParam}`) return runtimeResponse("turns", turnPayload);
        if (url === `/api/events?roomId=${roomIdParam}&pageSize=50&sortOrder=desc`) return runtimeResponse("events", eventPayload);
        if (url in payloads) return ok(payloads[url]);
        throw new Error(`Missing fixture for ${url}`);
      })
    );

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      await act(async () => {
        render(<App />);
        await vi.dynamicImportSettled();
      });
      expect(screen.getByRole("heading", { name: "Transient restart room" })).toBeTruthy();

      await act(async () => { await vi.advanceTimersByTimeAsync(3200); });
      expect(runtimeCallCounts.panes).toBeGreaterThanOrEqual(2);
      expect(screen.queryByText(/UPSTREAM_UNAVAILABLE/)).toBeNull();
      expect(screen.queryByText(/Space API is not reachable from the web server/)).toBeNull();

      // The established SSE fallback refreshes every 30 seconds, not every 3 seconds.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(runtimeCallCounts.panes).toBeGreaterThanOrEqual(3);
      expect(screen.queryByText(/UPSTREAM_UNAVAILABLE/)).toBeNull();
      expect(screen.queryByText(/Space API is not reachable from the web server/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  it("keeps pane capability details in settings instead of every pane card", async () => {
    window.localStorage.removeItem("space.voiceTranscription.settings");
    const panes = [
      {
        id: "pane:chat",
        roomId: "room:capabilities",
        title: "Planner",
        mode: "CHAT" as const,
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
        createdAt: "2026-07-06T04:40:00.000Z",
        updatedAt: "2026-07-06T04:40:00.000Z"
      },
      {
        id: "pane:browser",
        roomId: "room:capabilities",
        title: "Browser 2",
        mode: "BROWSER" as const,
        status: "IDLE",
        providerId: null,
        modelId: null,
        reasoningEffort: "medium",
        cwd: "/opt/spaceapp",
        order: 1,
        columnSpan: 1,
        isMaximized: false,
        isMinimized: false,
        isClosed: false,
        split: { parentId: null, direction: null, size: null },
        createdAt: "2026-07-06T04:40:00.000Z",
        updatedAt: "2026-07-06T04:40:00.000Z"
      }
    ];
    const capabilityMatrix = (pane: (typeof panes)[number]): PaneCapabilityMatrix => ({
      paneId: pane.id,
      paneMode: pane.mode,
      generatedAt: "2026-07-06T04:41:00.000Z",
      groups: [
        {
          id: "memory",
          label: "Memory",
          status: "VERIFIED",
          statusReason: "Space Memory is available through mediated tools.",
          items: [
            {
              id: "memory:search",
              label: "Memory search",
              status: "VERIFIED",
              statusReason: "Force-on through Space agent defaults.",
              execution: "force_on",
              requiresApproval: false
            }
          ]
        },
        {
          id: "skills",
          label: "Skills",
          status: "VERIFIED",
          statusReason: "Verified skill context is readable.",
          items: [
            {
              id: "skills:read",
              label: "Skills read",
              status: "VERIFIED",
              statusReason: "Bounded skill reads.",
              execution: "force_on",
              requiresApproval: false
            }
          ]
        },
        {
          id: "mcp",
          label: "MCP",
          status: "WARN",
          statusReason: "Metadata only until allowlist and approval pass.",
          items: [
            {
              id: "mcp:devtools",
              label: "DevTools",
              status: "DISABLED",
              statusReason: "metadata only",
              execution: "metadata_only",
              requiresApproval: true
            }
          ]
        }
      ]
    });

    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        requestedUrls.push(url);
        const capabilityPane = panes.find((pane) => url === `/api/panes/${encodeURIComponent(pane.id)}/capabilities`);
        if (capabilityPane) {
          return { ok: true, status: 200, json: async () => capabilityMatrix(capabilityPane) };
        }
        const payloads: Record<string, unknown> = {
          "/api/auth/me": {
            user: { id: "user:operator", email: "space@space.local", role: "ADMIN" },
            isAuthenticated: true,
            isSetupRequired: false
          },
          "/readyz": {
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
          },
          "/api/rooms?all=true": {
            data: [
              {
                id: "room:capabilities",
                name: "Capability Room",
                description: null,
                paneCap: 16,
                createdAt: "2026-07-06T04:40:00.000Z",
                updatedAt: "2026-07-06T04:40:00.000Z",
                archivedAt: null,
                traceId: "req:capabilities"
              }
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
          },
          "/api/panes?roomId=room%3Acapabilities": {
            data: panes,
            pagination: { page: 1, pageSize: 100, totalItems: panes.length, totalPages: 1 }
          },
          "/api/panes/pane%3Achat/agent-session": agentSessionFixture({
            paneId: "pane:chat",
            roomId: "room:capabilities",
            title: "Planner",
            message: "Planner ready",
            selectedToolIds: ["mcp:devtools"]
          }),
          "/api/providers": { data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
          "/api/provider-settings": { defaultProviderId: "headroom-gateway", updatedAt: "2026-07-06T00:00:00.000Z" },
          "/api/models": { data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
          "/api/skills": { data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
          "/api/imports": { data: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } },
          "/api/admin": { status: "ok", mode: "dev", storageWarning: "" },
          "/api/mcp": {
            data: [],
            gateway: {
              id: "mcp-gateway",
              status: "DISABLED",
              statusReason: "MCP metadata only.",
              targetSpecVersion: "2025-11-25",
              approvalMode: "DISABLED",
              serverCount: 1,
              toolCount: 0,
              lastDiscoveryAt: null
            },
            servers: [],
            tools: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/admin/mcp/discovery-smoke": { data: null },
          "/api/admin/memory/embedding-smoke": { data: null },
          "/api/admin/memory/vector-readiness": {
            data: {
              id: "memory-vector-readiness",
              status: "DISABLED",
              code: "VECTOR_STORE_NOT_POSTGRES",
              message: "Vector store is not ready.",
              runtimeStore: "postgres",
              extensionInstalled: false,
              extensionVersion: null,
              embeddingColumnReady: false,
              embeddingDimensions: null,
              expectedDimensions: 1536,
              vectorIndexReady: false,
              checkedAt: "2026-07-06T04:40:00.000Z"
            }
          },
          "/api/admin/codex-app-server": {
            id: "codex-app-server",
            status: "READY",
            reasonCode: "CONFIG_SAFE",
            statusReason: "Codex App Server config is safe.",
            transport: "stdio",
            command: "codex",
            socketPath: null,
            websocketUrl: null,
            schemasGenerated: true,
            schemaManifest: null,
            lastCheckedAt: "2026-07-06T04:40:00.000Z"
          },
          "/api/admin/codex-app-server/handshake": { data: null },
          "/api/admin/codex-app-server/turn-smoke": { data: null },
          "/api/admin/storage": {
            id: "space-storage",
            status: "VERIFIED",
            statusReason: "Storage ready.",
            root: { path: "/", deviceId: "100", sizeBytes: 100, availableBytes: 80, usedPercent: 20 },
            app: { path: "/opt/spaceapp", deviceId: "101", sizeBytes: 100, availableBytes: 80, usedPercent: 20 },
            dedicatedAppVolume: true,
            minimumRecommendedFreeBytes: 1,
            checkedAt: "2026-07-06T04:40:00.000Z"
          },
          "/api/admin/observability": {
            service: "space-api",
            generatedAt: "2026-07-06T04:40:00.000Z",
            runtime: {
              startedAt: "2026-07-06T04:40:00.000Z",
              uptimeSeconds: 1,
              nodeVersion: "v22.23.0",
              pid: 207,
              memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 0, arrayBuffersBytes: 0 }
            },
            totals: { requestCount: 0, errorCount: 0, errorRate: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
            endpoints: []
          },
          "/api/admin/worker": {
            id: "space-worker",
            status: "RUNNING",
            statusReason: "Temporal worker pollers are visible.",
            address: "127.0.0.1:7233",
            namespace: "default",
            taskQueue: "space-agent-turns",
            reachable: true,
            workflowPollerCount: 1,
            activityPollerCount: 1,
            pollerCount: 2,
            workflowBacklogCount: 0,
            activityBacklogCount: 0,
            pollerIdentities: [],
            lastPollerAccessAt: "2026-07-06T04:40:00.000Z",
            checkedAt: "2026-07-06T04:40:00.000Z"
          },
          "/api/swarm?roomId=room%3Acapabilities": {
            tasks: [],
            locks: [],
            messages: [],
            reconciles: [],
            executionStatus: "DISABLED",
            statusReason: "Swarm execution is disabled."
          },
          "/api/turns?roomId=room%3Acapabilities": {
            data: [],
            pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
          },
          "/api/events?roomId=room%3Acapabilities&pageSize=50&sortOrder=desc": {
            data: [],
            pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 }
          },
          "/api/cli/runtimes": { data: [], checkedAt: "2026-07-06T04:40:00.000Z" },
          "/api/browser/status": {
            enabled: false,
            statusReason: "Browser sessions are mediated.",
            defaultUrl: "http://127.0.0.1:4911/",
            checkedAt: "2026-07-06T04:40:00.000Z"
          },
          "/api/voice/transcription/settings": {
            enabled: true,
            statusReason: "OpenAI Realtime transcription is configured.",
            defaultModel: "gpt-live-transcribe",
            modelOptions: ["gpt-live-transcribe"],
            defaultLanguage: "auto",
            languageOptions: ["auto", "el", "en"],
            defaultDelay: "minimal",
            delayOptions: ["minimal", "low", "medium", "high", "xhigh"],
            maxBytes: 26214400,
            maxDurationMs: 60000,
            updatedAt: "2026-07-06T04:40:00.000Z"
          },
          "/api/integrations/telegram": {
            connectionStatus: "DISCONNECTED",
            isEnabled: false,
            botUsername: null,
            chatDisplayName: null,
            pairingId: null,
            pairingExpiresAt: null,
            pairedAt: null,
            enabledAt: null,
            disabledAt: null,
            lastTestedAt: null,
            lastDeliveredAt: null,
            errorCode: null,
            errorAt: null,
            updatedAt: "2026-07-06T04:40:00.000Z"
          }
        };
        return {
          ok: true,
          status: 200,
          json: async () => payloads[url]
        };
      })
    );

    render(<App />);

    const plannerPane = await screen.findByLabelText("Planner agent 1");
    expect(within(plannerPane).queryByLabelText("Capabilities for Planner")).toBeNull();

    fireEvent.click(await workspaceAction(/^(Open|Show) settings dock$/, "Docks", true));
    const settings = await screen.findByRole("region", { name: "Settings dock" });
    expect(await within(settings).findByRole("searchbox", { name: "Search settings" })).toBeTruthy();
    expect(screen.queryByLabelText("Capabilities for Planner")).toBeNull();
    // Scoped to the dock: the Chat pane's own Dots tabs legitimately include "Memory".
    expect(within(settings).queryByText("Memory")).toBeNull();
    expect(within(settings).queryByText("Skills")).toBeNull();
    expect(within(settings).queryByText("MCP")).toBeNull();
    expect(within(plannerPane).queryByText("Skills")).toBeNull();
    expect(within(plannerPane).queryByText("MCP")).toBeNull();
    // The per-pane "Selected agent" section left the settings dock (9ed515d993): the dock holds
    // account/installation settings only and never loads a pane capability matrix.
    expect(screen.queryByLabelText("Basic settings for Planner")).toBeNull();
    expect(within(settings).queryByRole("button", { name: "Selected agent" })).toBeNull();
    expect(within(settings).queryByText("Applies to: Selected pane")).toBeNull();
    fireEvent.click(within(settings).getByRole("button", { name: "Telegram notifications" }));
    await act(async () => { await vi.dynamicImportSettled(); });
    const telegramSettings = await within(settings).findByRole("region", { name: "Telegram notifications" });
    expect(await within(telegramSettings).findByText("Disconnected")).toBeTruthy();
    expect(within(telegramSettings).getByLabelText("Telegram bot token").getAttribute("type")).toBe("password");
    fireEvent.click(within(settings).getByRole("button", { name: "Voice input" }));
    const voiceSettings = await within(settings).findByRole("region", { name: "Voice input settings" });
    expect(within(voiceSettings).getByRole("switch", { name: "Voice input" })).toBeTruthy();
    fireEvent.change(within(voiceSettings).getByRole("combobox", { name: /^Language/ }), { target: { value: "en" } });
    fireEvent.change(within(voiceSettings).getByRole("combobox", { name: /^Insert mode/ }), { target: { value: "replace" } });
    expect(window.localStorage.getItem("space.voiceTranscription.settings")).toContain("\"language\":\"en\"");
    expect(window.localStorage.getItem("space.voiceTranscription.settings")).toContain("\"insertMode\":\"replace\"");
    expect(within(voiceSettings).queryByLabelText(/^Speed/)).toBeNull();
    expect(within(voiceSettings).queryByLabelText(/^Auto-send/)).toBeNull();

    // Browser panes carry no "Target" toolbar action any more; pressing inside the pane targets it.
    await waitFor(() => expect(document.querySelector('[data-space-pane-id="pane:browser"]')).toBeTruthy());
    const browserPane = document.querySelector('[data-space-pane-id="pane:browser"]') as HTMLElement;
    expect(browserPane.classList.contains("is-target")).toBe(false);
    fireEvent.pointerDown(browserPane);
    await waitFor(() => expect(browserPane.classList.contains("is-target")).toBe(true));

    expect(document.querySelector('[data-space-pane-id="pane:chat"]')?.classList.contains("is-target")).toBe(false);
    expect(screen.queryByLabelText("Capabilities for Browser 2")).toBeNull();
    expect(screen.queryByLabelText("Model settings Browser 2")).toBeNull();
    expect(within(settings).queryByText("Applies to: Selected pane")).toBeNull();
    expect(requestedUrls.some((url) => url.endsWith("/capabilities"))).toBe(false);
  }, 20000);

  it("shows canonical golden launch readiness in the launch dock", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const payloads: Record<string, unknown> = {
          "/api/auth/me": {
            user: { id: "user:operator", email: "space@space.local", role: "ADMIN" },
            isAuthenticated: true,
            isSetupRequired: false
          },
          "/readyz": {
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
          },
          "/api/rooms?all=true": {
            data: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/providers": {
            data: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/provider-settings": { defaultProviderId: "headroom-gateway", updatedAt: "2026-07-06T00:00:00.000Z" },
          "/api/models": {
            data: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/skills": {
            data: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/imports": {
            data: [],
            pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
          },
          "/api/admin": {
            status: "ok",
            mode: "v0-postgres",
            storageWarning: "Dedicated /opt/spaceapp volume is still required before production/browser-heavy launch."
          },
          "/api/mcp": {
            data: [],
            gateway: {
              id: "mcp-gateway",
              status: "DISABLED",
              statusReason: "MCP discovery metadata is not verified; tool execution is disabled.",
              targetSpecVersion: "2025-11-25",
              approvalMode: "DISABLED",
              serverCount: 0,
              toolCount: 0,
              lastDiscoveryAt: null
            },
            servers: [],
            tools: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/admin/mcp/discovery-smoke": { data: null },
          "/api/admin/memory/embedding-smoke": { data: null },
          "/api/admin/memory/vector-readiness": {
            data: {
              id: "memory-vector-readiness",
              status: "VERIFIED",
              code: "MEMORY_VECTOR_READY",
              message: "pgvector ready.",
              runtimeStore: "postgres",
              extensionInstalled: true,
              extensionVersion: "0.8.3",
              embeddingColumnReady: true,
              embeddingDimensions: 1536,
              expectedDimensions: 1536,
              vectorIndexReady: true,
              checkedAt: "2026-06-27T00:00:00.000Z"
            }
          },
          "/api/admin/codex-app-server": {
            id: "codex-app-server",
            status: "READY",
            reasonCode: "CONFIG_SAFE",
            statusReason: "Configured for stdio transport.",
            transport: "stdio",
            command: "/opt/spaceapp/bin/codex",
            socketPath: null,
            websocketUrl: null,
            schemasGenerated: true,
            schemaManifest: null,
            lastCheckedAt: "2026-06-27T00:00:00.000Z"
          },
          "/api/admin/codex-app-server/handshake": { data: null },
          "/api/admin/codex-app-server/turn-smoke": { data: null },
          "/api/admin/system-analytics/health": healthSnapshotWithServices([storageReadinessService("Dedicated /opt/spaceapp volume is not detected.")]),
          "/api/admin/storage": {
            id: "space-storage",
            status: "BLOCKED",
            statusReason: "Dedicated /opt/spaceapp volume is not detected.",
            root: { path: "/", deviceId: "100", sizeBytes: 214748364800, availableBytes: 42949672960, usedPercent: 80 },
            app: { path: "/opt/spaceapp", deviceId: "100", sizeBytes: 214748364800, availableBytes: 42949672960, usedPercent: 80 },
            dedicatedAppVolume: false,
            minimumRecommendedFreeBytes: 161061273600,
            checkedAt: "2026-06-27T00:00:00.000Z"
          },
          "/api/admin/observability": {
            service: "space-api",
            generatedAt: "2026-06-27T00:00:00.000Z",
            runtime: {
              startedAt: "2026-06-27T00:00:00.000Z",
              uptimeSeconds: 120,
              nodeVersion: "v22.23.0",
              pid: 207,
              memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 0, arrayBuffersBytes: 0 }
            },
            totals: { requestCount: 1, errorCount: 0, errorRate: 0, p50Ms: 1, p95Ms: 1, p99Ms: 1 },
            endpoints: []
          },
          "/api/admin/worker": {
            id: "space-worker",
            status: "RUNNING",
            statusReason: "Temporal worker pollers are visible.",
            address: "127.0.0.1:7233",
            namespace: "default",
            taskQueue: "space-agent-turns",
            reachable: true,
            workflowPollerCount: 1,
            activityPollerCount: 1,
            pollerCount: 2,
            workflowBacklogCount: 0,
            activityBacklogCount: 0,
            pollerIdentities: ["space-worker@test"],
            lastPollerAccessAt: "2026-06-27T00:00:00.000Z",
            checkedAt: "2026-06-27T00:00:00.000Z"
          },
          "/api/swarm": {
            tasks: [],
            locks: [],
            messages: [],
            reconciles: [],
            executionStatus: "DISABLED",
            statusReason: "Swarm execution disabled."
          },
          "/api/admin/launch-readiness": {
            id: "launch-readiness",
            status: "BLOCKED",
            generatedAt: "2026-06-27T00:00:00.000Z",
            completionPct: 80,
            passedCount: 12,
            totalCount: 15,
            hardBlockerCount: 1,
            gateCount: 2,
            summary: "Production launch remains blocked by hard infrastructure requirements.",
            requirements: [
              {
                id: "storage",
                label: "Dedicated Space storage",
                status: "FAIL",
                severity: "hard",
                message: "Dedicated /opt/spaceapp volume is not detected.",
                evidence: [{ label: "Storage status", ref: "BLOCKED" }]
              }
            ]
          }
        };

        return {
          ok: true,
          status: 200,
          json: async () => payloads[url]
        };
      })
    );

    render(<App />);

    expect(screen.queryByRole("button", { name: "launch dock" })).toBeNull();
    // Neither a launch dock nor a Health dock is offered: Health left the docks (5aa3a6fdc4).
    await workspaceAction(/^(Open|Show) settings dock$/, "Docks", true);
    const workspaceMenu = screen.getByRole("dialog", { name: "Workspace" });
    expect(within(workspaceMenu).queryByRole("button", { name: /launch dock/i })).toBeNull();
    expect(within(workspaceMenu).queryByRole("button", { name: /health dock/i })).toBeNull();

    // Its readiness snapshot lives in Resources > Service readiness (ecc0af72fb).
    fireEvent.click(await workspaceAction("Resources", "Utilities", true));
    await openServiceReadiness();
    const storageCard = await findServiceCard("Storage readiness");
    expect(within(storageCard).getByText("Dedicated /opt/spaceapp volume is not detected.")).toBeTruthy();
    expect(within(storageCard).getByText("Dedicated volume").nextElementSibling?.textContent).toBe("No");
    expect(screen.queryByText("Golden E2E readiness")).toBeNull();
  }, 20000);

  it("runs native Codex web agent panes when the live gate is enabled", async () => {
    const agentMessagePayloads: Array<Record<string, unknown>> = [];
    const panePatchPayloads: Array<Record<string, unknown>> = [];
    const uploadRequests: string[] = [];
    let selectedModelConfigId = "gpt-5.4-mini";
    let codexHistoryPreview = "Previous image task";
    let paneRecord: Record<string, unknown> = {
      id: "pane:codex-live",
      roomId: "room:codex-live",
      title: "Codex Pane",
      mode: "CHAT",
      status: "IDLE",
      providerId: "codex-lb",
      modelId: "gpt-5.4-mini",
      reasoningEffort: "medium",
      cwd: "/opt/spaceapp",
      order: 0,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null },
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z"
    };
    const codexModelOptions = [
      {
        id: "gpt-5.4-mini",
        displayName: "GPT 5.4 Mini",
        providerId: "codex-lb",
        providerName: "Codex-LB",
        model: "gpt-5.4-mini",
        reasoningKey: "medium",
        reasoningLabel: "Medium reasoning",
        isDefault: true
      },
      {
        id: "gpt-5.4-vision",
        displayName: "GPT 5.4 Vision",
        providerId: "codex-lb",
        providerName: "Codex-LB",
        model: "gpt-5.4-vision",
        reasoningKey: "high",
        reasoningLabel: "High reasoning",
        isDefault: false
      }
    ];
    const codexModelCatalog = [
      {
        id: "gpt-5.4-mini",
        displayName: "GPT 5.4 Mini",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"],
        reasoningOptions: [{ reasoningEffort: "medium", description: "Balanced reasoning" }]
      },
      {
        id: "gpt-5.4-vision",
        displayName: "GPT 5.4 Vision",
        isDefault: false,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["high"],
        reasoningOptions: [{ reasoningEffort: "high", description: "Deep reasoning" }]
      }
    ];
    const codexSession = (message: string, modelConfigId = selectedModelConfigId) =>
      agentSessionFixture({
        paneId: "pane:codex-live",
        roomId: "room:codex-live",
        title: "Codex Pane",
        message,
        selectedModelConfigId: modelConfigId,
        selectedProviderName: "Codex-LB",
        selectedModelName: modelConfigId === "gpt-5.4-vision" ? "gpt-5.4-vision" : "gpt-5.4-mini",
        selectedReasoningKey: modelConfigId === "gpt-5.4-vision" ? "high" : "medium",
        selectedToolIds: ["mcp:browser"],
        // Chat Task history lists only this pane's own conversation without a Dot (fbdd6f04b5).
        threadId: "019f-codex-smoke",
        modelOptions: codexModelOptions,
        modelCatalog: codexModelCatalog,
        toolOptions: [
          {
            id: "mcp:browser",
            displayName: "Browser",
            slug: "browser",
            availability: "default_on",
            authType: "none",
            authConnected: true,
            enabled: true,
            isForceOn: false
          }
        ]
      });
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:space-upload-preview"),
      configurable: true
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      configurable: true
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (method === "POST" && url.startsWith("/api/artifacts/uploads")) {
          uploadRequests.push(url);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              artifacts: [
                {
                  id: "artifact:uploaded-image",
                  roomId: "room:codex-live",
                  paneId: "pane:codex-live",
                  turnId: null,
                  workflowId: null,
                  kind: "IMAGE",
                  mimeType: "image/png",
                  storageUri: "space-artifact://user-uploads/room/screen.png",
                  sha256: "a".repeat(64),
                  byteSize: 12,
                  metadata: { source: "CLIPBOARD" },
                  createdAt: "2026-06-27T00:00:00.000Z"
                }
              ]
            })
          };
        }
        if (method === "POST" && url === "/api/panes/pane%3Acodex-live/agent/messages") {
          agentMessagePayloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          codexHistoryPreview = "Queued turn:codex-live";
          return {
            ok: true,
            status: 200,
            json: async () => codexSession("Queued turn:codex-live", selectedModelConfigId)
          };
        }
        if (method === "PATCH" && url === "/api/panes/pane%3Acodex-live/agent/settings") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          panePatchPayloads.push(body);
          selectedModelConfigId = String(body.selectedModelConfigId ?? selectedModelConfigId);
          return {
            ok: true,
            status: 200,
            json: async () => codexSession("Codex native chat ready")
          };
        }

        const payloads: Record<string, unknown> = {
          "/api/auth/me": {
            user: { id: "user:operator", email: "space@space.local", role: "ADMIN" },
            isAuthenticated: true,
            isSetupRequired: false
          },
          "/api/auth/csrf": { csrfToken: "csrf:test", headerName: "x-space-csrf-token" },
          "/readyz": {
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
          },
          "/api/rooms?all=true": {
            data: [
              {
                id: "room:codex-live",
                name: "Codex Live",
                paneCap: 16,
                createdAt: "2026-06-27T00:00:00.000Z",
                updatedAt: "2026-06-27T00:00:00.000Z"
              }
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
          },
          "/api/panes?roomId=room%3Acodex-live": {
            data: [paneRecord],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
          },
          "/api/panes/pane%3Acodex-live/agent-session": codexSession("Codex native chat ready"),
          "/api/codex/history?limit=50": codexHistoryPayload({
            title: "Codex Live Task",
            preview: codexHistoryPreview
          }),
          "/api/codex/history?page=1&pageSize=50&dedupeTitles=true": codexHistoryPayload({
            title: "Codex Live Task",
            preview: codexHistoryPreview
          }),
          "/api/codex/environment": codexEnvironmentPayload({
            model: "gpt-5.4-mini",
            reasoningEffort: "medium"
          }),
          "/api/turns?roomId=room%3Acodex-live": {
            data: [
              {
                id: "turn:history-1",
                roomId: "room:codex-live",
                paneId: "pane:codex-live",
                workflowId: "workflow:history-1",
                providerId: "codex-lb",
                modelId: "gpt-5.4-mini",
                status: "COMPLETED",
                prompt: "Previous image task",
                promptHash: "b".repeat(64),
                artifactIds: ["artifact:history-image"],
                createdAt: "2026-06-27T00:00:00.000Z",
                updatedAt: "2026-06-27T00:00:00.000Z"
              }
            ],
            pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 }
          },
          "/api/events?roomId=room%3Acodex-live&pageSize=50&sortOrder=desc": {
            data: [],
            pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 }
          },
          "/api/providers": {
            data: [
              {
                id: "codex-lb",
                displayName: "Codex-LB",
                type: "CODEX_LB",
                status: "VERIFIED",
                statusReason: "Dedicated key smoke passed.",
                healthCheckedAt: "2026-06-27T00:00:00.000Z",
                maskedKeyPrefix: "sk-clb-test",
                baseUrl: "http://192.0.2.246:2455/v1",
                routeProfile: "direct-primary",
                backingProviderId: "codex-lb",
                credentialRef: null,
                isBuiltIn: false
              }
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
          },
          "/api/provider-settings": { defaultProviderId: "codex-lb", updatedAt: "2026-07-06T00:00:00.000Z" },
          "/api/models": {
            data: [
              {
                id: "gpt-5.4-mini",
                providerId: "codex-lb",
                displayName: "GPT 5.4 Mini",
                status: "VERIFIED",
                contextWindow: 128000,
                supportsTools: true,
                supportsVision: false,
                supportsRealtime: false,
                supportsReasoning: true,
                defaultReasoningEffort: "medium"
              },
              {
                id: "gpt-5.4-vision",
                providerId: "codex-lb",
                displayName: "GPT 5.4 Vision",
                status: "VERIFIED",
                contextWindow: 128000,
                supportsTools: true,
                supportsVision: true,
                supportsRealtime: false,
                supportsReasoning: true,
                defaultReasoningEffort: "high"
              }
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 }
          },
          "/api/mcp": {
            data: [],
            gateway: {
              id: "mcp-gateway",
              status: "VERIFIED",
              statusReason: "MCP discovery verified.",
              targetSpecVersion: "2025-11-25",
              approvalMode: "APPROVAL_REQUIRED",
              serverCount: 1,
              toolCount: 1,
              lastDiscoveryAt: "2026-06-27T00:00:00.000Z"
            },
            servers: [],
            tools: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/admin/mcp/discovery-smoke": { data: null },
          "/api/admin/memory/embedding-smoke": { data: null },
          "/api/admin/memory/vector-readiness": {
            data: {
              id: "memory-vector-readiness",
              status: "VERIFIED",
              code: "MEMORY_VECTOR_READY",
              message: "pgvector ready.",
              runtimeStore: "postgres",
              extensionInstalled: true,
              extensionVersion: "0.8.3",
              embeddingColumnReady: true,
              embeddingDimensions: 1536,
              expectedDimensions: 1536,
              vectorIndexReady: true,
              checkedAt: "2026-06-27T00:00:00.000Z"
            }
          },
          "/api/admin/codex-app-server": {
            id: "codex-app-server",
            status: "READY",
            reasonCode: "CONFIG_SAFE",
            statusReason: "Configured for stdio transport.",
            transport: "stdio",
            command: "/opt/spaceapp/bin/codex",
            socketPath: null,
            websocketUrl: null,
            schemasGenerated: true,
            schemaManifest: null,
            lastCheckedAt: "2026-06-27T00:00:00.000Z"
          },
          "/api/admin/codex-app-server/handshake": { data: null },
          "/api/admin/codex-app-server/turn-smoke": { data: null },
          "/api/admin/storage": {
            id: "space-storage",
            status: "BLOCKED",
            statusReason: "Dedicated /opt/spaceapp volume is not detected.",
            root: { path: "/", deviceId: "100", sizeBytes: 214748364800, availableBytes: 42949672960, usedPercent: 80 },
            app: { path: "/opt/spaceapp", deviceId: "100", sizeBytes: 214748364800, availableBytes: 42949672960, usedPercent: 80 },
            dedicatedAppVolume: false,
            minimumRecommendedFreeBytes: 161061273600,
            checkedAt: "2026-06-27T00:00:00.000Z"
          },
          "/api/admin/observability": {
            service: "space-api",
            generatedAt: "2026-06-27T00:00:00.000Z",
            runtime: {
              startedAt: "2026-06-27T00:00:00.000Z",
              uptimeSeconds: 120,
              nodeVersion: "v22.23.0",
              pid: 207,
              memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 0, arrayBuffersBytes: 0 }
            },
            totals: { requestCount: 1, errorCount: 0, errorRate: 0, p50Ms: 1, p95Ms: 1, p99Ms: 1 },
            endpoints: []
          },
          "/api/admin/worker": {
            id: "space-worker",
            status: "RUNNING",
            statusReason: "Temporal worker pollers are visible.",
            address: "127.0.0.1:7233",
            namespace: "default",
            taskQueue: "space-agent-turns",
            reachable: true,
            workflowPollerCount: 1,
            activityPollerCount: 1,
            pollerCount: 2,
            workflowBacklogCount: 0,
            activityBacklogCount: 0,
            pollerIdentities: ["space-worker@test"],
            lastPollerAccessAt: "2026-06-27T00:00:00.000Z",
            checkedAt: "2026-06-27T00:00:00.000Z"
          },
          "/api/skills": {
            data: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/imports": {
            data: [],
            pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
          },
          "/api/swarm?roomId=room%3Acodex-live": {
            tasks: [],
            locks: [],
            messages: [],
            reconciles: [],
            executionStatus: "DISABLED",
            statusReason: "Swarm execution disabled."
          },
          "/api/admin": {
            status: "ok",
            mode: "v0-postgres",
            storageWarning: "Dedicated /opt/spaceapp volume is still required before production/browser-heavy launch."
          }
        };

        return {
          ok: true,
          status: 200,
          json: async () => payloads[url]
        };
      })
    );

    render(<App />);

    expect((await screen.findAllByText("Codex Live")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Task history")).toBeNull();
    expect(screen.queryByLabelText("Command prompt")).toBeNull();
    // The agent pane body is lazy-loaded; allow it to mount under a loaded test runner.
    const codexPane = await screen.findByLabelText("Native agent Codex Pane", undefined, { timeout: 8000 });
    expect(codexPane).toBeTruthy();
    const codexPaneArticle = codexPane.closest("article");
    expect(codexPaneArticle).toBeTruthy();
    fireEvent.click(within(codexPaneArticle as HTMLElement).getByRole("button", { name: "More pane actions Codex Pane" }));
    const paneActions = await screen.findByRole("menu", { name: "Pane actions Codex Pane" });
    fireEvent.click(within(paneActions).getByRole("menuitem", { name: "Task history" }));
    const historyDialog = await screen.findByRole("dialog", { name: "Open Codex task history" });
    expect(within(codexPane).queryByText("Live stats")).toBeNull();
    expect(await within(historyDialog).findByRole("button", { name: "Codex task Codex Live Task" })).toBeTruthy();
    fireEvent.click(within(historyDialog).getByRole("button", { name: "Close task history" }));
    // The room toolbar Codex LB strip merged into Resources (ecc0af72fb): all-account capacity under
    // AI usage and the provider (GW, Space Gateway) under Provider routing.
    fireEvent.click(await workspaceAction("Resources", "Utilities", true));
    const resources = await screen.findByRole("dialog", { name: "Resources" });
    fireEvent.click(within(resources).getByRole("button", { name: /^AI usage/ }));
    const allAccounts = (await within(resources).findByText("Routing capacity · all accounts")).parentElement as HTMLElement;
    expect(allAccounts.textContent).toContain("62%");
    fireEvent.change(within(resources).getByRole("combobox", { name: "Resource view" }), { target: { value: "provider" } });
    const codexProvider = (await within(resources).findByText("Codex provider")).parentElement as HTMLElement;
    expect(codexProvider.textContent).toContain("GW");
    fireEvent.click(within(resources).getByRole("button", { name: "Close Resources" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Resources" })).toBeNull());
    expect(screen.queryByLabelText("Agent provider Codex Pane")).toBeNull();
    const modelTrigger = await within(codexPane).findByRole("button", {
      name: /Change model and reasoning\. Current GPT 5\.4 Mini · Medium/i
    });
    expect(within(codexPane).queryByLabelText("Composer tools Codex Pane")).toBeNull();
    expect(codexPane.querySelector(".coder-tool-count-chip")).toBeNull();

    fireEvent.click(modelTrigger);
    const modelDialog = await within(codexPane).findByRole("dialog", { name: "Model and reasoning" });
    // The compact picker is a Model select plus a Reasoning effort slider; GPT 5.4 Vision only supports high.
    expect(within(modelDialog).getByRole("slider", { name: "Reasoning effort" }).getAttribute("aria-valuetext")).toBe("Medium");
    fireEvent.change(within(modelDialog).getByRole("combobox", { name: "Model" }), { target: { value: "gpt-5.4-vision" } });
    await waitFor(() => {
      expect(panePatchPayloads).toContainEqual({ selectedModelConfigId: "gpt-5.4-vision" });
    });
    await waitFor(() => {
      expect(within(codexPane).getByRole("button", {
        name: /Change model and reasoning\. Current GPT 5\.4 Vision · High/i
      })).toBeTruthy();
    });

    fireEvent.change(await screen.findByLabelText("Message Codex Pane"), { target: { value: "Reply OK" } });
    fireEvent.click(await screen.findByRole("button", { name: "Send Codex Pane" }));

    await waitFor(() => {
      expect(uploadRequests).toEqual([]);
      expect(agentMessagePayloads).toEqual([
        {
          content: "Reply OK",
          // Idempotency key for resubmission recovery.
          clientRequestId: expect.any(String),
          selectedModelConfigId: "gpt-5.4-vision",
          selectedToolIds: ["mcp:browser"]
        }
      ]);
    });
    fireEvent.click(within(codexPaneArticle as HTMLElement).getByRole("button", { name: "More pane actions Codex Pane" }));
    const refreshedPaneActions = await screen.findByRole("menu", { name: "Pane actions Codex Pane" });
    fireEvent.click(within(refreshedPaneActions).getByRole("menuitem", { name: "Task history" }));
    const refreshedHistoryDialog = await screen.findByRole("dialog", { name: "Open Codex task history" });
    expect(await within(refreshedHistoryDialog).findByRole("button", { name: "Codex task Codex Live Task" })).toBeTruthy();
  }, 30000);

  it("runs fail-closed provider validation from the settings dock", async () => {
    const requests: string[] = [];
    const requestHeaders = new Map<string, Record<string, string>>();
    const swarmTasks: Array<Record<string, unknown>> = [];
    const swarmLocks: Array<Record<string, unknown>> = [];
    const swarmMessages: Array<Record<string, unknown>> = [];
    const swarmReconciles: Array<Record<string, unknown>> = [];
    const reviewDecisions: Array<Record<string, unknown>> = [];
    const reviewChecks: Array<Record<string, unknown>> = [];
    const reviewDiffs: Array<Record<string, unknown>> = [];
    const artifacts: Array<Record<string, unknown>> = [];
    const turns: Array<Record<string, unknown>> = [];
    const customProviders: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [
      {
        id: "event:test-room",
        roomId: "room:test",
        paneId: null,
        turnId: null,
        workflowId: null,
        traceId: "req:test-room",
        type: "ROOM_CREATED",
        message: "Room created.",
        payload: { roomId: "room:test" },
        createdAt: "2026-06-26T00:00:00.000Z"
      }
    ];
    const swarmState = () => ({
      tasks: swarmTasks,
      locks: swarmLocks,
      messages: swarmMessages,
      reconciles: swarmReconciles,
      executionStatus: "DISABLED",
      statusReason: "Swarm execution is control-plane only until worker/agent smoke is explicitly approved and verified."
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url}`);
        requestHeaders.set(`${method} ${url}`, (init?.headers as Record<string, string> | undefined) ?? {});
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        if (url === "/api/swarm/tasks" && method === "POST") {
          const task = {
            id: `swarm_task:test-${swarmTasks.length + 1}`,
            roomId: body.roomId,
            parentTaskId: body.parentTaskId ?? null,
            role: body.role,
            title: body.title,
            goal: body.goal,
            status: "PLANNED",
            assignee: body.assignee ?? null,
            dependsOnTaskIds: body.dependsOnTaskIds ?? [],
            lockIds: [],
            resultSummary: null,
            createdAt: "2026-06-26T00:00:00.000Z",
            updatedAt: "2026-06-26T00:00:00.000Z",
            completedAt: null
          };
          swarmTasks.unshift(task);
          return { ok: true, status: 200, json: async () => task };
        }
        if (url.startsWith("/api/swarm/tasks/") && method === "PATCH") {
          const taskId = decodeURIComponent(url.split("/").at(-1) ?? "");
          const task = swarmTasks.find((item) => item.id === taskId);
          if (task) {
            Object.assign(task, body, {
              updatedAt: "2026-06-26T00:00:00.001Z",
              completedAt: body.status === "DONE" ? "2026-06-26T00:00:00.001Z" : task.completedAt
            });
          }
          return { ok: true, status: 200, json: async () => task };
        }
        if (url === "/api/swarm/locks" && method === "POST") {
          const lock = {
            id: `swarm_lock:test-${swarmLocks.length + 1}`,
            roomId: body.roomId,
            taskId: body.taskId ?? null,
            resource: body.resource,
            status: "ACTIVE",
            holder: body.holder,
            reason: body.reason,
            createdAt: "2026-06-26T00:00:00.000Z",
            releasedAt: null
          };
          swarmLocks.unshift(lock);
          return { ok: true, status: 200, json: async () => lock };
        }
        if (url.startsWith("/api/swarm/locks/") && url.endsWith("/release") && method === "POST") {
          const lockId = decodeURIComponent(url.split("/").at(-2) ?? "");
          const lock = swarmLocks.find((item) => item.id === lockId);
          if (lock) {
            Object.assign(lock, { status: "RELEASED", releasedAt: "2026-06-26T00:00:00.001Z" });
          }
          return { ok: true, status: 200, json: async () => lock };
        }
        if (url === "/api/swarm/messages" && method === "POST") {
          const message = {
            id: `swarm_msg:test-${swarmMessages.length + 1}`,
            roomId: body.roomId,
            taskId: body.taskId ?? null,
            fromRole: body.fromRole,
            toRole: body.toRole ?? null,
            body: body.body,
            createdAt: "2026-06-26T00:00:00.000Z"
          };
          swarmMessages.unshift(message);
          return { ok: true, status: 200, json: async () => message };
        }
        if (url === "/api/swarm/reconciles" && method === "POST") {
          const reconcile = {
            id: `swarm_reconcile:test-${swarmReconciles.length + 1}`,
            roomId: body.roomId,
            taskIds: body.taskIds,
            decision: body.decision,
            summary: body.summary,
            nextSteps: body.nextSteps,
            createdAt: "2026-06-26T00:00:00.000Z"
          };
          swarmReconciles.unshift(reconcile);
          return { ok: true, status: 200, json: async () => reconcile };
        }
        if (url.startsWith("/api/swarm")) {
          return { ok: true, status: 200, json: async () => swarmState() };
        }
        if (url === "/api/turns" && method === "POST") {
          const turn = {
            id: "turn:test",
            roomId: body.roomId,
            paneId: body.paneId,
            workflowId: "workflow:dummy:test",
            providerId: null,
            modelId: null,
            status: "QUEUED",
            prompt: body.prompt,
            promptHash: "f".repeat(64),
            artifactIds: body.artifactIds ?? [],
            createdAt: "2026-06-26T00:00:00.000Z",
            updatedAt: "2026-06-26T00:00:00.000Z"
          };
          turns.unshift(turn);
          events.unshift(
            {
              id: "event:test-turn-completed",
              roomId: body.roomId,
              paneId: body.paneId,
              turnId: "turn:test",
              workflowId: "workflow:dummy:test",
              traceId: "req:test-turn",
              type: "TURN_COMPLETED",
              message: "Dummy Temporal turn completed.",
              payload: { runtime: "DUMMY_TEMPORAL", source: "temporal-dummy" },
              createdAt: "2026-06-26T00:00:00.002Z"
            },
            {
              id: "event:test-turn-started",
              roomId: body.roomId,
              paneId: body.paneId,
              turnId: "turn:test",
              workflowId: "workflow:dummy:test",
              traceId: "req:test-turn",
              type: "TURN_STARTED",
              message: "Dummy Temporal turn queued.",
              payload: { runtime: "DUMMY_TEMPORAL", source: "temporal-dummy" },
              createdAt: "2026-06-26T00:00:00.001Z"
            }
          );
          return {
            ok: true,
            status: 200,
            json: async () => ({
              workflowId: "workflow:dummy:test",
              runId: "run:test",
              roomId: body.roomId,
              paneId: body.paneId,
              traceId: "req:test",
              status: "QUEUED",
              runtime: "DUMMY_TEMPORAL",
              turnId: "turn:test"
            })
          };
        }
        if (url === "/api/artifacts" && method === "POST") {
          const artifact = {
            id: "artifact:test",
            roomId: "room:test",
            paneId: null,
            turnId: null,
            workflowId: null,
            kind: body.kind,
            mimeType: body.mimeType,
            storageUri: body.storageUri,
            sha256: body.sha256,
            byteSize: body.byteSize,
            metadata: body.metadata ?? {},
            createdAt: "2026-06-26T00:00:00.000Z"
          };
          artifacts.unshift(artifact);
          return { ok: true, status: 200, json: async () => artifact };
        }
        if (url === "/api/providers" && method === "POST") {
          const provider = {
            id: body.id,
            displayName: body.displayName,
            type: body.type,
            status: "DISABLED",
            statusReason: "Custom provider metadata is saved. Run validation before using it for chat sends.",
            healthCheckedAt: null,
            maskedKeyPrefix: null,
            baseUrl: body.baseUrl ?? null,
            routeProfile: body.routeProfile ?? "custom",
            backingProviderId: body.backingProviderId ?? null,
            credentialRef: body.credentialRef ?? null,
            isBuiltIn: false
          };
          customProviders.unshift(provider);
          return { ok: true, status: 200, json: async () => provider };
        }
        if (url === "/api/reviews" && method === "POST") {
          const review = {
            id: "review:test",
            roomId: "room:test",
            workflowId: null,
            decision: body.decision,
            summary: body.summary,
            evidenceArtifactIds: body.evidenceArtifactIds ?? [],
            rollbackNote: body.rollbackNote,
            createdAt: "2026-06-26T00:00:00.000Z"
          };
          reviewDecisions.unshift(review);
          return { ok: true, status: 200, json: async () => review };
        }
        if (url === "/api/review-checks" && method === "POST") {
          const check = {
            id: "review_check:test",
            roomId: "room:test",
            reviewDecisionId: body.reviewDecisionId ?? null,
            name: body.name,
            status: body.status,
            command: body.command ?? null,
            summary: body.summary,
            artifactIds: body.artifactIds ?? [],
            metadata: body.metadata ?? {},
            createdAt: "2026-06-26T00:00:00.000Z"
          };
          reviewChecks.unshift(check);
          return { ok: true, status: 200, json: async () => check };
        }
        if (url === "/api/review-diffs" && method === "POST") {
          const diff = {
            id: "review_diff:test",
            roomId: "room:test",
            reviewDecisionId: body.reviewDecisionId ?? null,
            title: body.title,
            filePath: body.filePath,
            status: body.status,
            additions: body.additions,
            deletions: body.deletions,
            patchArtifactId: body.patchArtifactId ?? null,
            summary: body.summary,
            createdAt: "2026-06-26T00:00:00.000Z"
          };
          reviewDiffs.unshift(diff);
          return { ok: true, status: 200, json: async () => diff };
        }
        if (url === "/api/reviews/state?roomId=room%3Atest") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              decisions: reviewDecisions,
              checks: reviewChecks,
              diffs: reviewDiffs,
              artifacts,
              gateStatus: reviewChecks.some((check) => check.status === "FAIL") ? "FAIL" : reviewChecks.length ? "PASS" : "EMPTY",
              statusReason: reviewChecks.length ? "All recorded review checks are passing." : "No review checks have been recorded for this room."
            })
          };
        }
        const memorySearch = {
          mode: "keyword",
          keyword: {
            status: "VERIFIED",
            statusReason: "Case-insensitive keyword search is active against redacted title, body and provenance fields.",
            checkedAt: null
          },
          semantic: {
            status: "DISABLED",
            statusReason: "pgvector storage is reserved, but no embedding provider has passed smoke validation.",
            checkedAt: null
          }
        };

        const payloads: Record<string, unknown> = {
          "/api/auth/me": {
            user: { id: "user:operator", email: "space@space.local", role: "ADMIN" },
            isAuthenticated: true,
            isSetupRequired: false
          },
          "/readyz": {
            ok: true,
            dependencies: {
              store: "postgres",
              runtimeStore: "postgres",
              eventBus: "in-process",
              temporal: "enabled",
              worker: "RUNNING",
              codexTurns: "disabled",
              codexLb: "disabled"
            }
          },
          "/api/rooms?all=true": {
            data: [{ id: "room:test", name: "Room 1", paneCap: 16, createdAt: "2026-06-26T00:00:00.000Z", updatedAt: "2026-06-26T00:00:00.000Z" }],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
          },
          "/api/providers": {
            data: [
              {
                id: "codex-lb",
                displayName: "Codex-LB",
                type: "CODEX_LB",
                status: "DISABLED",
                statusReason: "Dedicated Space Codex-LB key has not been verified yet.",
                healthCheckedAt: null,
                maskedKeyPrefix: null,
                baseUrl: null,
                routeProfile: "custom",
                backingProviderId: null,
                credentialRef: null,
                isBuiltIn: false
              },
              ...customProviders
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 1 + customProviders.length, totalPages: 1 }
          },
          "/api/provider-settings": { defaultProviderId: "codex-lb", updatedAt: "2026-07-06T00:00:00.000Z" },
          "/api/integrations/telegram": {
            connectionStatus: "DISCONNECTED",
            isEnabled: false,
            botUsername: null,
            chatDisplayName: null,
            pairingId: null,
            pairingExpiresAt: null,
            pairedAt: null,
            enabledAt: null,
            disabledAt: null,
            lastTestedAt: null,
            lastDeliveredAt: null,
            errorCode: null,
            errorAt: null,
            updatedAt: "2026-07-14T00:00:00.000Z"
          },
          "/api/models": {
            data: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/skills": method === "POST"
            ? {
                id: "skill:test",
                displayName: "Browser QA",
                version: "0.1.0",
                status: "DISABLED",
                statusReason: "Operator proposal recorded; execution remains disabled until review and allowlists pass.",
                triggerDescription: "Use after UI changes.",
                body: "Capture browser evidence.",
                allowedTools: ["browser.captureScreenshot"],
                contentHash: `sha256:${"b".repeat(64)}`,
                source: "OPERATOR_PROPOSAL",
                createdAt: "2026-06-26T00:00:00.000Z",
                updatedAt: "2026-06-26T00:00:00.000Z"
              }
            : {
                data: [],
                pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
              },
          "/api/imports": method === "POST"
            ? {
                id: "import:test",
                sourceKind: "CODEX_MEMORY",
                targetKind: "MEMORY",
                status: "PENDING",
                statusReason: "Awaiting explicit operator import or reject decision.",
                sourceRef: "operator-paste",
                roomId: "room:test",
                memoryScope: "ROOM",
                title: "Imported storage note",
                body: "Dedicated storage is required.",
                provenance: "explicit-import-gate",
                skillVersion: null,
                skillTriggerDescription: null,
                allowedTools: [],
                importedMemoryId: null,
                importedSkillId: null,
                createdAt: "2026-06-26T00:00:00.000Z",
                decidedAt: null
              }
            : {
                data: [],
                pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
              },
          "/api/imports/import%3Atest/decision": {
            candidate: {
              id: "import:test",
              sourceKind: "CODEX_MEMORY",
              targetKind: "MEMORY",
              status: "IMPORTED",
              statusReason: "Imported through explicit Space gate; source content is now a native Space copy.",
              sourceRef: "operator-paste",
              roomId: "room:test",
              memoryScope: "ROOM",
              title: "Imported storage note",
              body: "Dedicated storage is required.",
              provenance: "explicit-import-gate",
              skillVersion: null,
              skillTriggerDescription: null,
              allowedTools: [],
              importedMemoryId: "memory:imported",
              importedSkillId: null,
              createdAt: "2026-06-26T00:00:00.000Z",
              decidedAt: "2026-06-26T00:00:00.001Z"
            },
            memoryEntry: {
              id: "memory:imported",
              scope: "ROOM",
              roomId: "room:test",
              title: "Imported storage note",
              body: "Dedicated storage is required.",
              provenance: "explicit-import-gate; imported from CODEX_MEMORY:operator-paste",
              createdAt: "2026-06-26T00:00:00.001Z"
            },
            skill: null
          },
          "/api/admin": { status: "ok", mode: "dev", storageWarning: "" },
          "/api/admin/codex-app-server": {
            id: "codex-app-server",
            status: "DISABLED",
            reasonCode: "DISABLED_BY_DEFAULT",
            statusReason: "Codex App Server adapter is disabled by default. No Codex process is spawned or connected.",
            transport: "stdio",
            command: "codex",
            socketPath: null,
            websocketUrl: null,
            schemasGenerated: false,
            schemaManifest: null,
            lastCheckedAt: "2026-06-26T00:00:00.000Z"
          },
          "/api/admin/codex-app-server/handshake": method === "POST"
            ? {
                id: "codex-app-server",
                checkId: "codex_handshake:test",
                traceId: "req:test-codex-handshake",
                actorUserId: "user:operator",
                status: "DISABLED",
                code: "ADAPTER_DISABLED",
                message: "Codex App Server adapter is disabled by default. No Codex process is spawned or connected.",
                transport: "stdio",
                startedAt: "2026-06-26T00:00:00.000Z",
                finishedAt: "2026-06-26T00:00:00.001Z",
                durationMs: 1,
                serverInfo: null,
                schemasGenerated: false,
                schemaManifest: null,
                checkedAt: "2026-06-26T00:00:00.001Z"
              }
            : { data: null },
          "/api/admin/codex-app-server/turn-smoke": method === "POST"
            ? {
                id: "codex-app-server",
                checkId: "codex_turn_smoke:test",
                traceId: "req:test-codex-turn-smoke",
                actorUserId: "user:operator",
                status: "DISABLED",
                code: "ADAPTER_DISABLED",
                message: "Codex App Server adapter is disabled by default. No Codex process is spawned or connected.",
                transport: "stdio",
                startedAt: "2026-06-26T00:00:00.000Z",
                finishedAt: "2026-06-26T00:00:00.001Z",
                durationMs: 1,
                threadId: null,
                turnId: null,
                turnStatus: null,
                notificationCount: 0,
                completedNotificationSeen: false,
                schemasGenerated: false,
                schemaManifest: null,
                model: null,
                checkedAt: "2026-06-26T00:00:00.001Z"
              }
            : { data: null },
          "/api/admin/storage": {
            id: "space-storage",
            status: "BLOCKED",
            statusReason: "Dedicated /opt/spaceapp volume is not detected.",
            root: { path: "/", deviceId: "100", sizeBytes: 214748364800, availableBytes: 42949672960, usedPercent: 80 },
            app: { path: "/opt/spaceapp", deviceId: "100", sizeBytes: 214748364800, availableBytes: 42949672960, usedPercent: 80 },
            dedicatedAppVolume: false,
            minimumRecommendedFreeBytes: 161061273600,
            checkedAt: "2026-06-26T00:00:01.000Z"
          },
          "/api/admin/observability": {
            service: "space-api",
            generatedAt: "2026-06-26T00:00:00.000Z",
            runtime: {
              startedAt: "2026-06-26T00:00:00.000Z",
              uptimeSeconds: 180,
              nodeVersion: "v22.23.0",
              pid: 207,
              memory: {
                rssBytes: 134217728,
                heapUsedBytes: 67108864,
                heapTotalBytes: 100663296,
                externalBytes: 1048576,
                arrayBuffersBytes: 524288
              }
            },
            totals: {
              requestCount: 42,
              errorCount: 0,
              errorRate: 0,
              p50Ms: 4.4,
              p95Ms: 16.6,
              p99Ms: 20.1
            },
            endpoints: [
              {
                method: "GET",
                route: "/api/mcp",
                statusClass: "2xx",
                requestCount: 5,
                errorCount: 0,
                durationMs: {
                  count: 5,
                  min: 2.1,
                  max: 16.6,
                  average: 7.2,
                  p50: 4.4,
                  p95: 16.6,
                  p99: 16.6
                },
                lastSeenAt: "2026-06-26T00:00:00.000Z"
              }
            ]
          },
          "/api/admin/worker": {
            id: "space-worker",
            status: "RUNNING",
            statusReason: "Temporal worker pollers are visible.",
            address: "127.0.0.1:7233",
            namespace: "default",
            taskQueue: "space-agent-turns",
            reachable: true,
            workflowPollerCount: 1,
            activityPollerCount: 1,
            pollerCount: 2,
            workflowBacklogCount: 0,
            activityBacklogCount: 0,
            pollerIdentities: ["space-worker@test"],
            lastPollerAccessAt: "2026-06-26T00:00:00.000Z",
            checkedAt: "2026-06-26T00:00:01.000Z"
          },
          "/api/admin/audit?pageSize=20": {
            data: [
              {
                id: "audit:codex-turn-smoke",
                actorUserId: "user:operator",
                traceId: "req:test-codex-turn-smoke",
                action: "codex_app_server.turn_smoke",
                targetType: "codex_app_server",
                targetId: "codex-app-server",
                metadata: {
                  status: "DISABLED",
                  code: "ADAPTER_DISABLED",
                  transport: "stdio",
                  notificationCount: 0
                },
                createdAt: "2026-06-26T00:00:00.001Z"
              },
              {
                id: "audit:login",
                actorUserId: "user:operator",
                traceId: "req:test-login",
                action: "auth.login.succeeded",
                targetType: "user",
                targetId: "user:operator",
                metadata: {
                  role: "ADMIN",
                  devLogin: true
                },
                createdAt: "2026-06-26T00:00:00.000Z"
              }
            ],
            pagination: { page: 1, pageSize: 20, totalItems: 2, totalPages: 1 }
          },
          "/api/mcp": {
            data: [
              {
                id: "mcp-gateway",
                kind: "MCP_SERVER",
                displayName: "Space MCP Gateway",
                status: "DISABLED",
                statusReason: "MCP discovery metadata is not verified; tool execution is disabled.",
                requiresApproval: true
              }
            ],
            gateway: {
              id: "mcp-gateway",
              status: "DISABLED",
              statusReason: "MCP discovery metadata is not verified; tool execution is disabled.",
              targetSpecVersion: "2025-11-25",
              approvalMode: "DISABLED",
              serverCount: 1,
              toolCount: 0,
              lastDiscoveryAt: null
            },
            servers: [
              {
                id: "mcp-gateway",
                displayName: "Space MCP Gateway",
                transport: "stdio",
                status: "DISABLED",
                statusReason: "Gateway registry exists, but no MCP server has passed discovery smoke.",
                schemaVersion: "2025-11-25",
                configHash: "unconfigured",
                toolCount: 0,
                lastDiscoveredAt: null
              }
            ],
            tools: [],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
          },
          "/api/admin/mcp/discovery-smoke": method === "POST"
            ? {
                id: "mcp-gateway",
                checkId: "mcp_discovery_smoke:test",
                traceId: "req:test",
                actorUserId: "user:operator",
                status: "DISABLED",
                code: "DISCOVERY_SMOKE_DISABLED",
                message: "SPACE_MCP_DISCOVERY_SMOKE_ENABLED=true is required before MCP discovery smoke can run.",
                targetSpecVersion: "2025-11-25",
                discoveryEnabled: false,
                serverCount: 1,
                toolCount: 0,
                startedAt: "2026-06-26T00:00:00.000Z",
                finishedAt: "2026-06-26T00:00:00.001Z",
                durationMs: 1,
                checkedAt: "2026-06-26T00:00:00.001Z"
            }
            : { data: null },
          "/api/admin/memory/embedding-smoke": method === "POST"
            ? {
                id: "memory-embedding-smoke",
                checkId: "memory_embed_smoke:test",
                traceId: "req:test",
                actorUserId: "user:operator",
                status: "ERROR",
                code: "EMBEDDING_PROVIDER_SMOKE_FAILED",
                message: "Codex-LB embedding smoke failed with HTTP 405.",
                smokeEnabled: true,
                provider: "codex-lb",
                model: "text-embedding-3-small",
                dimensions: 1536,
                pgvectorReady: true,
                embeddingProviderReady: false,
                startedAt: "2026-06-26T00:00:00.000Z",
                finishedAt: "2026-06-26T00:00:00.001Z",
                durationMs: 1,
                checkedAt: "2026-06-26T00:00:00.001Z"
              }
            : { data: null },
          "/api/admin/memory/vector-readiness": {
            data: {
              id: "memory-vector-readiness",
              status: "VERIFIED",
              code: "MEMORY_VECTOR_READY",
              message: "pgvector extension, memory embedding column and HNSW vector index are ready.",
              runtimeStore: "postgres",
              extensionInstalled: true,
              extensionVersion: "0.8.3",
              embeddingColumnReady: true,
              embeddingDimensions: 1536,
              expectedDimensions: 1536,
              vectorIndexReady: true,
              checkedAt: "2026-06-26T00:00:00.000Z"
            }
          },
          "/api/mcp/tools/execute": {
            id: "mcp-gateway",
            executionId: "mcp_exec:test",
            status: "BLOCKED",
            code: "GATEWAY_DISABLED",
            message: "SPACE_MCP_TOOL_EXECUTION_ENABLED=true is required before MCP tool execution can run.",
            toolId: "mcp-gateway:execution-gate-smoke",
            serverId: null,
            toolName: null,
            startedAt: "2026-06-26T00:00:00.000Z",
            finishedAt: "2026-06-26T00:00:00.001Z",
            durationMs: 1,
            policy: null,
            approved: false,
            artifact: null
          },
          "/api/memory": method === "POST"
            ? {
                id: "memory:test",
                scope: "ROOM",
                roomId: "room:test",
                title: "Storage blocker",
                body: "Dedicated storage is required. token:[REDACTED]",
                provenance: "operator",
                createdAt: "2026-06-26T00:00:00.000Z"
              }
            : {
                data: [],
                pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 },
                search: memorySearch
              },
          "/api/memory?roomId=room%3Atest&scope=ROOM": {
            data: [],
            pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 },
            search: memorySearch
          },
          "/api/reviews": method === "POST"
            ? {
                id: "review:test",
                roomId: "room:test",
                workflowId: null,
                decision: "BLOCK",
                summary: "Tests failed before ship.",
                evidenceArtifactIds: ["artifact:test"],
                rollbackNote: "Revert the latest patch.",
                createdAt: "2026-06-26T00:00:00.000Z"
              }
            : {
                data: [],
                pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
              },
          "/api/review-checks": method === "POST"
            ? {
                id: "review_check:test",
                roomId: "room:test",
                reviewDecisionId: "review:test",
                name: "npm test",
                status: "PASS",
                command: "npm test",
                summary: "Unit checks passed.",
                artifactIds: ["artifact:test"],
                metadata: { suite: "unit" },
                createdAt: "2026-06-26T00:00:00.000Z"
              }
            : {
                data: [],
                pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
              },
          "/api/review-diffs": method === "POST"
            ? {
                id: "review_diff:test",
                roomId: "room:test",
                reviewDecisionId: "review:test",
                title: "Review dock",
                filePath: "apps/web/src/App.tsx",
                status: "MODIFIED",
                additions: 12,
                deletions: 2,
                patchArtifactId: "artifact:test",
                summary: "Adds review aggregation controls.",
                createdAt: "2026-06-26T00:00:00.000Z"
              }
            : {
                data: [],
                pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
              },
          "/api/artifacts": method === "POST"
            ? {
                id: "artifact:test",
                roomId: "room:test",
                paneId: null,
                turnId: null,
                workflowId: null,
                kind: "SCREENSHOT",
                mimeType: "image/png",
                storageUri: `cas://sha256/${"a".repeat(64)}`,
                sha256: "a".repeat(64),
                byteSize: 2048,
                metadata: { viewport: "1440x900" },
                createdAt: "2026-06-26T00:00:00.000Z"
              }
            : {
                data: [],
                pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
              },
          "/api/browser/evidence-smoke": {
            captureId: "browser_capture:test",
            roomId: "room:test",
            paneId: null,
            viewport: "desktop",
            targetUrl: "http://127.0.0.1:4911/",
            artifacts: [
              {
                id: "artifact:browser-shot",
                roomId: "room:test",
                paneId: null,
                turnId: null,
                workflowId: null,
                kind: "SCREENSHOT",
                mimeType: "image/png",
                storageUri: `space-artifact://browser-evidence/browser_capture%3Atest/screenshot.png`,
                sha256: "b".repeat(64),
                byteSize: 4096,
                metadata: { channel: "screenshot" },
                createdAt: "2026-06-26T00:00:00.000Z"
              },
              {
                id: "artifact:browser-dom",
                roomId: "room:test",
                paneId: null,
                turnId: null,
                workflowId: null,
                kind: "DOM_SNAPSHOT",
                mimeType: "application/json",
                storageUri: `space-artifact://browser-evidence/browser_capture%3Atest/dom.json`,
                sha256: "c".repeat(64),
                byteSize: 1024,
                metadata: { channel: "dom" },
                createdAt: "2026-06-26T00:00:00.000Z"
              },
              {
                id: "artifact:browser-console",
                roomId: "room:test",
                paneId: null,
                turnId: null,
                workflowId: null,
                kind: "CONSOLE_LOG",
                mimeType: "application/json",
                storageUri: `space-artifact://browser-evidence/browser_capture%3Atest/console.json`,
                sha256: "d".repeat(64),
                byteSize: 128,
                metadata: { channel: "console" },
                createdAt: "2026-06-26T00:00:00.000Z"
              },
              {
                id: "artifact:browser-network",
                roomId: "room:test",
                paneId: null,
                turnId: null,
                workflowId: null,
                kind: "NETWORK_LOG",
                mimeType: "application/json",
                storageUri: `space-artifact://browser-evidence/browser_capture%3Atest/network.json`,
                sha256: "e".repeat(64),
                byteSize: 256,
                metadata: { channel: "network" },
                createdAt: "2026-06-26T00:00:00.000Z"
              }
            ],
            createdAt: "2026-06-26T00:00:00.000Z"
          },
          "/api/reviews?roomId=room%3Atest": {
            data: [],
            pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
          },
          "/api/reviews/state?roomId=room%3Atest": {
            decisions: [],
            checks: [],
            diffs: [],
            artifacts: [],
            gateStatus: "EMPTY",
            statusReason: "No review checks have been recorded for this room."
          },
          "/api/artifacts?roomId=room%3Atest": {
            data: [],
            pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
          },
          "/api/panes?roomId=room%3Atest": {
            data: [
              {
                id: "pane:test",
                roomId: "room:test",
                title: "Planner",
                mode: "CHAT",
                status: turns.length ? "QUEUED" : "IDLE",
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
                createdAt: "2026-06-26T00:00:00.000Z",
                updatedAt: turns.length ? "2026-06-26T00:00:00.001Z" : "2026-06-26T00:00:00.000Z"
              }
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
          },
          "/api/panes/pane%3Atest/agent-session": agentSessionFixture({
            paneId: "pane:test",
            roomId: "room:test",
            title: "Planner",
            message: "Planner native pane ready",
            // Chat Task history lists only this pane's own conversation without a Dot (fbdd6f04b5).
            threadId: "019f-codex-smoke"
          }),
          "/api/admin/system-analytics/health": healthSnapshotWithServices([
            { id: "provider", label: "Active provider", status: "healthy", detail: "Codex-LB · Latest provider verification", checkedAt: healthCheckedAt, values: [] },
            { id: "mcp", label: "MCP gateway", status: "unavailable", detail: "Latest gateway verification", checkedAt: healthCheckedAt,
              values: [{ label: "Servers", value: "1" }, { label: "Tools", value: "0" }] },
            storageReadinessService("Dedicated /opt/spaceapp volume is not detected.")
          ]),
          "/api/codex/history?limit=50": codexHistoryPayload({
            title: "Codex Planner Task",
            preview: "planner shared Codex history"
          }),
          "/api/codex/history?page=1&pageSize=50&dedupeTitles=true": codexHistoryPayload({
            title: "Codex Planner Task",
            preview: "planner shared Codex history"
          }),
          "/api/codex/environment": codexEnvironmentPayload(),
          "/api/turns?roomId=room%3Atest": {
            data: turns,
            pagination: { page: 1, pageSize: 25, totalItems: turns.length, totalPages: turns.length ? 1 : 0 }
          },
          "/api/events?roomId=room%3Atest&pageSize=50&sortOrder=desc": {
            data: events,
            pagination: { page: 1, pageSize: events.length || 1, totalItems: events.length, totalPages: events.length ? 1 : 0 }
          },
          "/api/auth/csrf": { csrfToken: "csrf:test", headerName: "x-space-csrf-token" },
          "/api/providers/codex-lb/validate": {
            providerId: "codex-lb",
            status: "DISABLED",
            code: "MISSING_CONFIG",
            statusReason: "SPACE_CODEX_LB_BASE_URL and SPACE_CODEX_LB_KEY_FILE are required before credential smoke.",
            checkedAt: "2026-06-26T00:00:00.000Z",
            maskedKeyPrefix: null,
            credentialLabel: null,
            modelCount: null
          }
        };

        return {
          ok: true,
          status: 200,
          json: async () => payloads[url]
        };
      })
    );

    render(<App />);

    // Docks open from the Workspace menu's Docks tab; Health is no longer a dock (5aa3a6fdc4).
    expect(await workspaceAction(/^(Open|Show) settings dock$/, "Docks", true)).toBeTruthy();
    const docksMenu = screen.getByRole("dialog", { name: "Workspace" });
    expect(within(docksMenu).getByRole("button", { name: /media dock/i })).toBeTruthy();
    expect(within(docksMenu).queryByRole("button", { name: /health dock/i })).toBeNull();
    for (const removedDock of ["progress", "events", "observability", "tools", "audit", "launch", "memory", "context", "imports", "swarm", "review"]) {
      expect(within(docksMenu).queryByRole("button", { name: new RegExp(`\\b${removedDock} dock`, "i") })).toBeNull();
    }
    fireEvent.click(within(docksMenu).getByRole("button", { name: "Close menu" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
    expect(screen.queryByRole("button", { name: "progress dock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "events dock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "observability dock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "tools dock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "audit dock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "launch dock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "memory dock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "context dock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "imports dock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "swarm dock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "review dock" })).toBeNull();
    expect(screen.queryByText("Blueprint Progress")).toBeNull();
    expect(screen.queryByText("Latest visible slice")).toBeNull();
    expect(screen.queryByText("Codex real turn gated")).toBeNull();
    expect(screen.queryByText("Provider smoke gated")).toBeNull();
    const plannerAgent = await screen.findByLabelText("Native agent Planner", undefined, { timeout: 8000 });
    expect(plannerAgent).toBeTruthy();
    const plannerPane = plannerAgent.closest("article");
    expect(plannerPane).toBeTruthy();
    fireEvent.click(within(plannerPane as HTMLElement).getByRole("button", { name: "More pane actions Planner" }));
    const plannerActions = await screen.findByRole("menu", { name: "Pane actions Planner" });
    fireEvent.click(within(plannerActions).getByRole("menuitem", { name: "Task history" }));
    const plannerHistoryDialog = await screen.findByRole("dialog", { name: "Open Codex task history" });
    expect(within(plannerAgent).queryByText("Live stats")).toBeNull();
    expect(await within(plannerHistoryDialog).findByRole("button", { name: "Codex task Codex Planner Task" })).toBeTruthy();
    fireEvent.click(within(plannerHistoryDialog).getByRole("button", { name: "Close task history" }));
    // The room toolbar Codex LB strip merged into Resources > AI usage (ecc0af72fb).
    fireEvent.click(await workspaceAction("Resources", "Utilities", true));
    const accountResources = await screen.findByRole("dialog", { name: "Resources" });
    fireEvent.click(within(accountResources).getByRole("button", { name: /^AI usage/ }));
    expect(((await within(accountResources).findByText("Routing capacity · all accounts")).parentElement as HTMLElement).textContent).toContain("62%");
    expect(within(accountResources).queryByText("ACT")).toBeNull();
    fireEvent.click(within(accountResources).getByRole("button", { name: "Close Resources" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Resources" })).toBeNull());
    expect(within(plannerAgent).queryByLabelText("Composer tools Planner")).toBeNull();
    expect(plannerAgent.querySelector(".coder-tool-count-chip")).toBeNull();
    expect(screen.queryByLabelText("Command prompt")).toBeNull();
    expect(requests).toContain("GET /api/events?roomId=room%3Atest&pageSize=50&sortOrder=desc");
    expect(screen.queryByText("Postgres replay source")).toBeNull();
    expect(screen.queryByText("Prometheus metrics live")).toBeNull();
    expect(screen.queryByText("/metrics scrape target")).toBeNull();
    // Optional admin snapshots are no longer fetched at startup (e853249e82); Resources telemetry replaces them.
    expect(requests).not.toContain("GET /api/admin/observability");

    expect(screen.queryByText("Model Registry")).toBeNull();
    expect(screen.queryByText("No models loaded until a provider credential smoke passes.")).toBeNull();
    expect(requests).not.toContain("GET /api/models");
    expect(screen.queryByText("Codex App Server")).toBeNull();
    expect(screen.queryByText("DISABLED_BY_DEFAULT")).toBeNull();
    fireEvent.click(await workspaceAction(/^(Open|Show) settings dock$/, "Docks", true));
    const settings = await screen.findByRole("region", { name: "Settings dock" });
    fireEvent.click(within(settings).getByRole("button", { name: "Default provider" }));
    expect(await within(settings).findByRole("region", { name: "Global provider settings" })).toBeTruthy();
    expect(await within(settings).findByRole("combobox", { name: "Default provider" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add provider" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Validate Codex-LB" })).toBeNull();
    expect(screen.queryByText("Provider catalog")).toBeNull();
    expect(screen.queryByText("CLI title model")).toBeNull();
    expect(requests).not.toContain("POST /api/providers");
    expect(requests).not.toContain("POST /api/providers/codex-lb/validate");
    // The former Health dock snapshot lives in Resources > Service readiness (ecc0af72fb).
    fireEvent.click(await workspaceAction("Resources", "Utilities", true));
    await openServiceReadiness();
    expect(within(await findServiceCard("Active provider")).getByText("Codex-LB · Latest provider verification")).toBeTruthy();
    expect(within(await findServiceCard("MCP gateway")).getByText("Latest gateway verification")).toBeTruthy();
    expect(within(await findServiceCard("Storage readiness")).getByText("Dedicated /opt/spaceapp volume is not detected.")).toBeTruthy();
    expect(requests).toContain("GET /api/admin/system-analytics/health");
    expect(requests).not.toContain("POST /api/admin/mcp/discovery-smoke");
    expect(requests).not.toContain("POST /api/mcp/tools/execute");
    expect(requests).not.toContain("POST /api/admin/memory/embedding-smoke");
    expect(requests).not.toContain("POST /api/skills");
    expect(requests).not.toContain("POST /api/imports");
    expect(requests).not.toContain("POST /api/swarm/tasks");
    expect(requests).not.toContain("POST /api/browser/evidence-smoke");
  }, 30000);

  it("shows host metrics badges and performs an ADMIN-confirmed core restart with recovery polling", async () => {
    localStorage.clear();
    const requests: string[] = [];
    const restartPayloads: unknown[] = [];
    const restartHeaders: Array<Record<string, string>> = [];
    let restartAccepted = false;
    let readyzAfterRestartPolls = 0;
    const baseReadyz = {
      ok: true,
      apiStartedAt: "2026-07-14T09:00:00.000Z",
      dependencies: {
        store: "postgres",
        runtimeStore: "postgres",
        eventBus: "in-process",
        temporal: "enabled",
        worker: "RUNNING",
        cliHost: "RUNNING",
        cliAdminHost: "RUNNING",
        browserHost: "RUNNING",
        browserHostBuildCommit: "1d5daf0bd",
        browserHostCaptureMetrics: null,
        codexTurns: "enabled",
        codexLb: "configured"
      }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url}`);

        if (method === "POST" && url === "/api/admin/service-restarts") {
          restartAccepted = true;
          restartPayloads.push(JSON.parse(String(init?.body ?? "{}")));
          restartHeaders.push((init?.headers as Record<string, string> | undefined) ?? {});
          return {
            ok: true,
            status: 202,
            text: async () =>
              JSON.stringify({
                status: "ACCEPTED",
                scope: "CORE",
                services: ["space-worker.service", "space-api.service", "space-web.service"],
                requestedAt: "2026-07-14T09:01:00.000Z",
                cooldownUntil: "2026-07-14T09:02:00.000Z",
                apiStartedAt: "2026-07-14T09:00:00.000Z"
              }),
            headers: new Headers({ "content-type": "application/json" })
          };
        }

        const readyz = () => {
          if (!restartAccepted) return baseReadyz;
          readyzAfterRestartPolls += 1;
          return {
            ...baseReadyz,
            apiStartedAt: readyzAfterRestartPolls >= 1 ? "2026-07-14T09:01:10.000Z" : baseReadyz.apiStartedAt
          };
        };
        const payloads: Record<string, unknown> = {
          "/api/auth/me": {
            user: { id: "user:admin", email: "space@space.local", role: "ADMIN" },
            isAuthenticated: true,
            isSetupRequired: false
          },
          "/api/auth/csrf": { csrfToken: "csrf:test", headerName: "x-space-csrf-token" },
          "/readyz": readyz(),
          "/api/rooms?all=true": {
            data: [
              {
                id: "room:metrics",
                name: "Metrics",
                description: null,
                order: 0,
                paneCap: 16,
                createdAt: "2026-07-14T09:00:00.000Z",
                updatedAt: "2026-07-14T09:00:00.000Z",
                archivedAt: null,
                traceId: "req:metrics"
              }
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
          },
          "/api/providers": { data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
          "/api/provider-settings": { defaultProviderId: "codex-lb", updatedAt: "2026-07-14T09:00:00.000Z" },
          "/api/models": { data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
          "/api/skills": { data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
          "/api/imports": { data: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } },
          "/api/admin": { status: "ok", mode: "prod", capabilities: [], storageWarning: "" },
          "/api/mcp": {
            data: [],
            gateway: {
              id: "mcp-gateway",
              status: "DISABLED",
              statusReason: "MCP disabled.",
              targetSpecVersion: "2025-11-25",
              approvalMode: "DISABLED",
              serverCount: 0,
              toolCount: 0,
              lastDiscoveryAt: null
            },
            servers: [],
            tools: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/admin/mcp/discovery-smoke": { data: null },
          "/api/admin/memory/embedding-smoke": { data: null },
          "/api/admin/memory/vector-readiness": { data: null },
          "/api/admin/codex-app-server": {
            id: "codex-app-server",
            status: "DISABLED",
            reasonCode: "DISABLED_BY_DEFAULT",
            statusReason: "Disabled.",
            transport: "stdio",
            command: "codex",
            socketPath: null,
            websocketUrl: null,
            schemasGenerated: false,
            schemaManifest: null,
            lastCheckedAt: "2026-07-14T09:00:00.000Z"
          },
          "/api/admin/codex-app-server/handshake": { data: null },
          "/api/admin/codex-app-server/turn-smoke": { data: null },
          "/api/admin/storage": {
            id: "space-storage",
            status: "VERIFIED",
            statusReason: "Storage ready.",
            root: { path: "/", deviceId: "100", sizeBytes: 100, availableBytes: 80, usedPercent: 20 },
            app: { path: "/opt/spaceapp", deviceId: "200", sizeBytes: 100, availableBytes: 80, usedPercent: 20 },
            dedicatedAppVolume: true,
            minimumRecommendedFreeBytes: 1,
            checkedAt: "2026-07-14T09:00:00.000Z"
          },
          "/api/admin/observability": {
            service: "space-api",
            generatedAt: "2026-07-14T09:00:00.000Z",
            runtime: {
              startedAt: "2026-07-14T09:00:00.000Z",
              uptimeSeconds: 10,
              nodeVersion: "v22.23.0",
              pid: 207,
              memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 0, arrayBuffersBytes: 0 }
            },
            totals: { requestCount: 1, errorCount: 0, errorRate: 0, p50Ms: 1, p95Ms: 1, p99Ms: 1 },
            endpoints: []
          },
          "/api/admin/worker": {
            id: "space-worker",
            status: "RUNNING",
            statusReason: "Running.",
            address: "127.0.0.1:7233",
            namespace: "default",
            taskQueue: "space-agent-turns",
            reachable: true,
            workflowPollerCount: 1,
            activityPollerCount: 1,
            pollerCount: 2,
            workflowBacklogCount: 0,
            activityBacklogCount: 0,
            pollerIdentities: [],
            lastPollerAccessAt: "2026-07-14T09:00:00.000Z",
            checkedAt: "2026-07-14T09:00:00.000Z"
          },
          "/api/panes?roomId=room%3Ametrics": {
            data: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/turns?roomId=room%3Ametrics": {
            data: [],
            pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
          },
          "/api/events?roomId=room%3Ametrics&pageSize=50&sortOrder=desc": {
            data: [],
            pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 }
          },
          "/api/swarm?roomId=room%3Ametrics": {
            tasks: [],
            locks: [],
            messages: [],
            reconciles: [],
            executionStatus: "DISABLED",
            statusReason: "Swarm disabled."
          },
          "/api/codex/history?limit=50": codexHistoryPayload(),
          "/api/codex/environment": codexEnvironmentPayload(),
          // Resources reads host metrics from the health snapshot and the admin CLI session list.
          "/api/admin/system-analytics/health": healthSnapshotWithServices([], { cpu: 17, memory: 80, swap: 10 }),
          "/api/admin/cli-sessions": {
            summary: { running: 3, attached: 2, detached: 1, cleanupEligible: 0 },
            sessions: [],
            sampledAt: healthCheckedAt
          }
        };

        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(payloads[url]),
          headers: new Headers({ "content-type": "application/json" })
        };
      })
    );

    render(<App />);

    // The room toolbar host badges merged into the Resources overview (ecc0af72fb).
    fireEvent.click(await workspaceAction("Resources", "Utilities", true));
    const resources = await screen.findByRole("dialog", { name: "Resources" });
    const summaryRow = (name: RegExp) => within(resources).getByRole("button", { name });
    await waitFor(() => expect(summaryRow(/^System/).querySelector(".resources-summary-value")?.textContent).toBe("CPU 17% · RAM 80%"));
    await waitFor(() => expect(summaryRow(/^Sessions/).querySelector(".resources-summary-value")?.textContent).toBe("3"));
    expect(summaryRow(/^AI usage/).querySelector(".resources-summary-value")?.textContent).toBe("44%");
    fireEvent.click(summaryRow(/^System/));
    expect(await within(resources).findByText("Swap")).toBeTruthy();
    expect((within(resources).getByText("Swap").parentElement as HTMLElement).textContent).toContain("10%");
    fireEvent.click(within(resources).getByRole("button", { name: "Close Resources" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Resources" })).toBeNull());

    // Server actions live in the Workspace "Manage" window (ecc0af72fb).
    fireEvent.click(await workspaceAction("Manage", "Utilities", true));
    const manage = await screen.findByRole("dialog", { name: "Manage" });
    fireEvent.click(within(manage).getByRole("button", { name: "Services" }));
    fireEvent.click(await within(manage).findByRole("button", { name: "Restart server" }));
    const dialog = await screen.findByRole("dialog", { name: "Restart Space server" });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
    expect(within(dialog).getByText(/space-worker\.service/)).toBeTruthy();
    expect(within(dialog).getByText(/space-api\.service/)).toBeTruthy();
    expect(within(dialog).getByText(/space-web\.service/)).toBeTruthy();
    expect(within(dialog).getByText(/CLI and browser sessions stay protected/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Restart server" }));

    await waitFor(() => expect(requests).toContain("POST /api/admin/service-restarts"));
    expect(Object.keys(restartHeaders[0] ?? {}).some((header) => header.toLowerCase() === "x-space-csrf-token")).toBe(true);
    expect(restartPayloads).toEqual([{ scope: "CORE" }]);
    await waitFor(() => expect(within(dialog).getByText(/Server restarted/)).toBeTruthy());
    expect(requests.filter((request) => request === "POST /api/admin/service-restarts")).toHaveLength(1);
  }, 30000);
});
