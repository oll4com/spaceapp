import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentPaneSession, PaneCliModelSettings } from "@space/contracts";
import { LiveSpaceApp as App } from "../src/live/LiveSpaceApp.js";
import { LazyAgentPane } from "../src/features/pane-card/PaneCard.js";

const csrfHeaderName = "x-space-csrf-token";

type AgentPaneSessionWithModelCatalog = AgentPaneSession & { modelCatalog: PaneCliModelSettings["models"] };

function session(
  paneId: string,
  title: string,
  message: string,
  status: AgentPaneSession["binding"]["status"] = "READY",
  roomId = "room:agents"
): AgentPaneSessionWithModelCatalog {
  return {
    binding: {
      paneId,
      source: "SPACE",
      sessionId: `agent_session:${paneId}`,
      coderChatId: null,
      status,
      title,
      selectedModelConfigId: "gpt-5.5:high",
      selectedProviderName: "OpenAI",
      selectedModelName: "gpt-5.5",
      selectedReasoningKey: "high",
      selectedToolIds: ["mcp:github", "mcp:linear", "browser:extract_text"],
      lastSyncedAt: "2026-06-29T00:00:00.000Z"
    },
    threadId: null,
    messages: [
      {
        id: `msg:${paneId}`,
        role: "assistant",
        content: message,
        status: "COMPLETED",
        createdAt: "2026-06-29T00:00:00.000Z"
      }
    ],
    runStatus: status === "RUNNING" ? "RUNNING" : "IDLE",
    statusReason: "Space agent session is ready.",
    modelOptions: [
      {
        id: "gpt-5.5:high",
        displayName: "GPT-5.5",
        providerId: "openai",
        providerName: "OpenAI",
        model: "gpt-5.5",
        reasoningKey: "high",
        reasoningLabel: "High reasoning",
        isDefault: true
      },
      {
        id: "gpt-5.5:low",
        displayName: "GPT-5.5",
        providerId: "openai",
        providerName: "OpenAI",
        model: "gpt-5.5",
        reasoningKey: "low",
        reasoningLabel: "Low reasoning",
        isDefault: false
      },
      {
        id: "gpt-5.5:research",
        displayName: "GPT-5.5",
        providerId: "openai",
        providerName: "OpenAI",
        model: "gpt-5.5",
        reasoningKey: "research",
        reasoningLabel: "Research reasoning",
        isDefault: false
      },
      {
        id: "gpt-5-mini:minimal",
        displayName: "GPT-5 Mini",
        providerId: "openai",
        providerName: "OpenAI",
        model: "gpt-5-mini",
        reasoningKey: "minimal",
        reasoningLabel: "Minimal reasoning",
        isDefault: true
      }
    ],
    modelCatalog: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "Frontier coding model",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["low", "high", "research"],
        reasoningOptions: [
          { reasoningEffort: "low", description: "Fast responses" },
          { reasoningEffort: "high", description: "Deep reasoning" },
          { reasoningEffort: "research", description: "Extended research" }
        ]
      },      {
        id: "gpt-5-mini",
        displayName: "GPT-5 Mini",
        description: "Fast coding model",
        isDefault: false,
        defaultReasoningEffort: "minimal",
        supportedReasoningEfforts: ["minimal"],
        reasoningOptions: [{ reasoningEffort: "minimal", description: "Lowest latency" }]
      }
    ],
    modelProviders: [],
    selectedModelConfigId: "gpt-5.5:high",
    toolOptions: [
      {
        id: "mcp:github",
        displayName: "GitHub",
        description: "GitHub MCP tools",
        category: "mcp",
        slug: "github",
        availability: "default_on",
        authType: "none",
        authConnected: true,
        enabled: true,
        isAvailable: true,
        statusReason: null,
        isForceOn: false
      },
      {
        id: "mcp:linear",
        displayName: "Linear",
        description: "Linear MCP tools",
        category: "mcp",
        slug: "linear",
        availability: "default_off",
        authType: "none",
        authConnected: true,
        enabled: true,
        isAvailable: true,
        statusReason: null,
        isForceOn: false
      },
      {
        id: "browser:extract_text",
        displayName: "Browser extract text",
        description: "Extract browser text",
        category: "browser",
        slug: "browser.extract_text",
        availability: "default_off",
        authType: "space-browser",
        authConnected: true,
        enabled: true,
        isAvailable: true,
        statusReason: null,
        isForceOn: false
      }
    ],
    selectedToolIds: ["mcp:github", "mcp:linear", "browser:extract_text"],
    permissionMode: null,
    collaborationMode: "default",
    permissionState: {
      mode: null,
      effectiveMode: "full_access",
      isInherited: true,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      reviewer: "user",
      statusReason: "Inherited runtime default."
    },
    permissionOptions: [
      {
        mode: "ask_for_approval",
        label: "Ask for approval",
        description: "Ask before elevated actions.",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        reviewer: "user",
        isAvailable: true,
        statusReason: null
      },
      {
        mode: "approve_for_me",
        label: "Approve for me",
        description: "Use the guardian reviewer.",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        reviewer: "guardian_subagent",
        isAvailable: true,
        statusReason: null
      },
      {
        mode: "full_access",
        label: "Full access",
        description: "Run without sandbox approvals.",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        reviewer: "user",
        isAvailable: true,
        statusReason: null
      }
    ],
    goal: null,
    history: [
      {
        paneId,
        roomId,
        source: "SPACE",
        sessionId: `agent_session:${paneId}`,
        coderChatId: null,
        status,
        title,
        selectedModelConfigId: "gpt-5.5:high",
        selectedProviderName: "OpenAI",
        selectedModelName: "gpt-5.5",
        selectedReasoningKey: "high",
        selectedToolIds: ["mcp:github", "mcp:linear", "browser:extract_text"],
        lastSyncedAt: "2026-06-29T00:00:00.000Z",
        paneTitle: title,
        paneIsClosed: false,
        updatedAt: "2026-06-29T00:00:00.000Z"
      }
    ],
    capabilities: {
      canSend: true,
      canInterrupt: status === "RUNNING",
      canSelectModel: true,
      canSelectTools: true,
      supportsTools: true
    }
  };
}

function codexEnvironmentPayload() {
  return {
    codexHome: "/var/lib/spaceapp-user/.codex",
    stateDbPath: "/var/lib/spaceapp-user/.codex/state_5.sqlite",
    config: {
      modelProvider: "codex-lb",
      model: "gpt-5.5",
      reasoningEffort: "high"
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
    checkedAt: "2026-07-06T00:00:00.000Z"
  };
}

function codexHistoryPayload() {
  return {
    data: [
      {
        id: "019f-codex-planner",
        rolloutPath: "/var/lib/spaceapp-user/.codex/sessions/2026/07/06/rollout-019f-codex-planner.jsonl",
        title: "Codex Planner Task",
        preview: "test received",
        model: "gpt-5.5",
        reasoningEffort: "high",
        cwd: "/opt/spaceapp",
        archived: false,
        source: "vscode",
        modelProvider: "codex-lb",
        threadSource: "user",
        firstUserMessage: "test prompt",
        updatedAt: "2026-07-06T00:00:01.000Z",
        recencyAt: "2026-07-06T00:00:01.000Z"
      }
    ],
    totalItems: 1,
    visibleItems: 1,
    checkedAt: "2026-07-06T00:00:02.000Z"
  };
}

function codexThreadPayload() {
  return {
    thread: codexHistoryPayload().data[0],
    items: [
      {
        id: "item:meta",
        kind: "metadata",
        role: "system",
        content: "Session started · cwd /opt/spaceapp · source vscode · provider codex-lb",
        toolName: null,
        rawType: "session_meta",
        createdAt: "2026-07-06T00:00:00.000Z"
      },
      {
        id: "item:user",
        kind: "message",
        role: "user",
        content: "test prompt",
        toolName: null,
        rawType: "message",
        createdAt: "2026-07-06T00:00:01.000Z"
      },
      {
        id: "item:assistant",
        kind: "event",
        role: "assistant",
        content: "test received",
        toolName: null,
        rawType: "agent_message",
        createdAt: "2026-07-06T00:00:02.000Z"
      },
      {
        id: "item:tool",
        kind: "tool_call",
        role: "tool",
        content: "{\"cmd\":\"date\"}",
        toolName: "shell",
        rawType: "function_call",
        createdAt: "2026-07-06T00:00:03.000Z"
      }
    ],
    checkedAt: "2026-07-06T00:00:04.000Z"
  };
}

function setViewport(width: number, height = 900) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height });
  window.dispatchEvent(new Event("resize"));
}

function disabledVoiceSettingsPayload() {
  return {
    enabled: false,
    statusReason: "Voice input disabled in fixture.",
    defaultModel: "gpt-live-transcribe",
    modelOptions: ["gpt-live-transcribe"],
    defaultLanguage: "auto",
    languageOptions: ["auto", "el", "en"],
    defaultDelay: "minimal",
    delayOptions: ["minimal", "low", "medium", "high", "xhigh"],
    maxBytes: 26214400,
    maxDurationMs: 60000,
    updatedAt: "2026-08-09T00:00:00.000Z"
  };
}

describe("Space native agent panes", () => {
  // Chat panes mount through a lazy chunk; resolve it once so the first
  // assertions measure pane behaviour, not module transform time.
  beforeAll(() => LazyAgentPane.preload(), 30000);

  it("renders native CHAT panes and shares one Codex environment request across panes", async () => {
    const requests: string[] = [];
    const requestHeaders = new Map<string, Record<string, string>>();
    const requestBodies: Array<{ url: string; body: string }> = [];
    const paneOne = "pane:one";
    const paneTwo = "pane:two";
    const paneThree = "pane:archived";
    let restoredClosedPane = false;
    let paneOneSelectedModelConfigId = "gpt-5.5:high";
    let paneOneSelectedToolIds = ["mcp:github", "mcp:linear", "browser:extract_text"];
    let paneOneCollaborationMode: AgentPaneSession["collaborationMode"] = "default";
    let paneOneThreadId: string | null = null;
    let paneOneRunErrorReason: string | null = null;
    let releaseSendResponse: (() => void) | null = null;
    let releaseInitialPaneOneSession: () => void = () => undefined;
    let initialPaneOneSessionPending = true;
    const initialPaneOneSessionGate = new Promise<void>((resolve) => {
      releaseInitialPaneOneSession = resolve;
    });
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    const paneOneSelectedReasoningKey = () =>
      paneOneSelectedModelConfigId.endsWith(":low")
        ? "low"
        : paneOneSelectedModelConfigId.endsWith(":minimal")
          ? "minimal"
          : "high";
    const paneOneSession = (message = "Initial assistant reply", status: AgentPaneSession["binding"]["status"] = "READY") => {
      const next = session(paneOne, "Planner", message, status, "room:agents");
      return {
        ...next,
        threadId: paneOneThreadId,
        runStatus: paneOneRunErrorReason ? "ERROR" as const : next.runStatus,
        statusReason: paneOneRunErrorReason ?? next.statusReason,
        selectedModelConfigId: paneOneSelectedModelConfigId,
        selectedToolIds: paneOneSelectedToolIds,
        collaborationMode: paneOneCollaborationMode,
        binding: {
          ...next.binding,
          selectedModelConfigId: paneOneSelectedModelConfigId,
          selectedReasoningKey: paneOneSelectedReasoningKey(),
          selectedToolIds: paneOneSelectedToolIds
        }
      };
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url}`);
        requestHeaders.set(`${method} ${url}`, (init?.headers as Record<string, string> | undefined) ?? {});
        if (init?.body) requestBodies.push({ url, body: String(init.body) });
        if (
          method === "GET" &&
          url === `/api/panes/${encodeURIComponent(paneOne)}/agent-session` &&
          initialPaneOneSessionPending
        ) {
          await initialPaneOneSessionGate;
          initialPaneOneSessionPending = false;
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
          "/api/voice/transcription/settings": disabledVoiceSettingsPayload(),
          "/api/rooms?all=true": {
            data: [
              {
                id: "room:agents",
                name: "Room 1",
                description: null,
                paneCap: 16,
                createdAt: "2026-06-29T00:00:00.000Z",
                updatedAt: "2026-06-29T00:00:00.000Z",
                archivedAt: null,
                traceId: "req:room"
              }
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
          },
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
              statusReason: "MCP discovery metadata is not verified.",
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
              checkedAt: "2026-06-29T00:00:00.000Z"
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
            lastCheckedAt: "2026-06-29T00:00:00.000Z"
          },
          "/api/admin/codex-app-server/handshake": { data: null },
          "/api/admin/codex-app-server/turn-smoke": { data: null },
          "/api/admin/storage": {
            id: "space-storage",
            status: "VERIFIED",
            statusReason: "Storage ready.",
            root: { path: "/", deviceId: "100", sizeBytes: 1, availableBytes: 1, usedPercent: 0 },
            app: { path: "/opt/spaceapp", deviceId: "200", sizeBytes: 1, availableBytes: 1, usedPercent: 0 },
            dedicatedAppVolume: true,
            minimumRecommendedFreeBytes: 1,
            checkedAt: "2026-06-29T00:00:00.000Z"
          },
          "/api/admin/observability": {
            service: "space-api",
            generatedAt: "2026-06-29T00:00:00.000Z",
            runtime: {
              startedAt: "2026-06-29T00:00:00.000Z",
              uptimeSeconds: 1,
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
            lastPollerAccessAt: "2026-06-29T00:00:00.000Z",
            checkedAt: "2026-06-29T00:00:00.000Z"
          },
          "/api/panes?roomId=room%3Aagents": {
            data: [
              {
                id: paneOne,
                roomId: "room:agents",
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
                createdAt: "2026-06-29T00:00:00.000Z",
                updatedAt: "2026-06-29T00:00:00.000Z"
              },
              {
                id: paneTwo,
                roomId: "room:agents",
                title: "Reviewer",
                mode: "CHAT",
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
                createdAt: "2026-06-29T00:00:00.000Z",
                updatedAt: "2026-06-29T00:00:00.000Z"
              }
            ].concat(
              restoredClosedPane
                ? [
                    {
                      id: paneThree,
                      roomId: "room:agents",
                      title: "Archived",
                      mode: "CHAT",
                      status: "IDLE",
                      providerId: null,
                      modelId: null,
                      reasoningEffort: "medium",
                      cwd: "/opt/spaceapp",
                      order: 2,
                      columnSpan: 1,
                      isMaximized: false,
                      isMinimized: false,
                      isClosed: false,
                      split: { parentId: null, direction: null, size: null },
                      createdAt: "2026-06-29T00:00:00.000Z",
                      updatedAt: "2026-06-29T00:00:10.000Z"
                    }
                  ]
                : []
            ),
            pagination: { page: 1, pageSize: 100, totalItems: restoredClosedPane ? 3 : 2, totalPages: 1 }
          },
          "/api/rooms/room%3Aagents/agent-history": {
            data: [
              {
                paneId: paneOne,
                roomId: "room:agents",
                source: "SPACE",
                sessionId: `agent_session:${paneOne}`,
                coderChatId: null,
                status: "READY",
                title: "Planner",
                selectedModelConfigId: "gpt-5.5:high",
                selectedProviderName: "OpenAI",
                selectedModelName: "gpt-5.5",
                selectedReasoningKey: "high",
                selectedToolIds: ["mcp:github"],
                lastSyncedAt: "2026-06-29T00:00:00.000Z",
                paneTitle: "Planner",
                paneIsClosed: false,
                updatedAt: "2026-06-29T00:00:00.000Z"
              },
              {
                paneId: paneThree,
                roomId: "room:agents",
                source: "SPACE",
                sessionId: `agent_session:${paneThree}`,
                coderChatId: null,
                status: "RUNNING",
                title: "Archived",
                selectedModelConfigId: "gpt-5.5:high",
                selectedProviderName: "OpenAI",
                selectedModelName: "gpt-5.5",
                selectedReasoningKey: "high",
                selectedToolIds: ["mcp:github"],
                lastSyncedAt: "2026-06-29T00:00:10.000Z",
                paneTitle: "Archived",
                paneIsClosed: !restoredClosedPane,
                updatedAt: "2026-06-29T00:00:10.000Z"
              }
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 }
          },
          "/api/codex/history?limit=50": codexHistoryPayload(),
          "/api/codex/history?page=1&pageSize=50&dedupeTitles=true": codexHistoryPayload(),
          "/api/codex/environment": codexEnvironmentPayload(),
          "/api/codex/threads/019f-codex-planner?presentation=chat": codexThreadPayload(),
          "/api/swarm?roomId=room%3Aagents": {
            tasks: [],
            locks: [],
            messages: [],
            reconciles: [],
            executionStatus: "DISABLED",
            statusReason: "Swarm execution is control-plane only."
          },
          "/api/turns?roomId=room%3Aagents": { data: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } },
          "/api/events?roomId=room%3Aagents&pageSize=50&sortOrder=desc": {
            data: [],
            pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 }
          },
          [`/api/panes/${encodeURIComponent(paneOne)}/agent-session`]: paneOneSession(),
          [`/api/panes/${encodeURIComponent(paneTwo)}/agent-session`]: session(paneTwo, "Reviewer", "Second pane ready"),
          [`/api/panes/${encodeURIComponent(paneThree)}/agent-session`]: session(paneThree, "Archived", "Restored session keeps running", "RUNNING"),
          "/api/auth/csrf": { csrfToken: "csrf:test", headerName: csrfHeaderName }
        };

        if (method === "POST" && url === `/api/panes/${encodeURIComponent(paneOne)}/agent/messages`) {
          const body = init?.body ? (JSON.parse(String(init.body)) as { content?: string; selectedModelConfigId?: string | null }) : {};
          const status = body.content === "plan" || body.content === "" || body.content === "send with image" ? "RUNNING" : "READY";
          paneOneSelectedModelConfigId = body.selectedModelConfigId ?? paneOneSelectedModelConfigId;
          if (body.content === "" || body.content === "send with image") {
            return await new Promise((resolve) => {
              releaseSendResponse = () =>
                resolve({
                  ok: true,
                  status: 200,
                  json: async () => paneOneSession("Hello from first pane", status)
                });
            });
          }
          return {
            ok: true,
            status: 200,
            json: async () => paneOneSession("Hello from first pane", status)
          };
        }
        if (method === "POST" && url === "/api/clipboard-items") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { text: string; source: string };
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: "clipboard:chat", ...body, roomId: "room:agents", paneId: paneOne, paneTitle: "Planner", occurrenceCount: 1, characterCount: body.text.length, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() })
          };
        }
        if (method === "POST" && url === `/api/panes/${encodeURIComponent(paneOne)}/agent-session`) {
          const body = init?.body ? (JSON.parse(String(init.body)) as { threadId?: string | null; selectedModelConfigId?: string; selectedToolIds?: string[] }) : {};
          paneOneThreadId = body.threadId === undefined ? paneOneThreadId : body.threadId;
          paneOneSelectedModelConfigId = body.selectedModelConfigId ?? paneOneSelectedModelConfigId;
          paneOneSelectedToolIds = body.selectedToolIds ?? paneOneSelectedToolIds;
          return {
            ok: true,
            status: 200,
            json: async () => paneOneSession()
          };
        }
        if (method === "POST" && url.startsWith("/api/artifacts/file-uploads?")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              artifacts: [
                {
                  id: "artifact:screen",
                  roomId: "room:agents",
                  paneId: paneOne,
                  turnId: null,
                  workflowId: null,
                  kind: "IMAGE",
                  mimeType: "image/png",
                  storageUri: "space-artifact://user-uploads/screen.png",
                  sha256: "0".repeat(64),
                  byteSize: 4,
                  metadata: { source: "CLIPBOARD", originalFilename: "screen.png" },
                  createdAt: "2026-06-29T00:00:00.000Z",
                  traceId: "req:upload"
                }
              ]
            })
          };
        }
        if (method === "POST" && url === `/api/panes/${encodeURIComponent(paneOne)}/agent/interrupt`) {
          return {
            ok: true,
            status: 200,
            json: async () => session(paneOne, "Planner", "Interrupted cleanly")
          };
        }
        if (method === "PATCH" && url === `/api/panes/${encodeURIComponent(paneOne)}/agent/settings`) {
          const body = init?.body ? JSON.parse(String(init.body)) as {
            selectedModelConfigId?: string;
            selectedToolIds?: string[];
            collaborationMode?: AgentPaneSession["collaborationMode"];
          } : {};
          paneOneSelectedModelConfigId = body.selectedModelConfigId ?? paneOneSelectedModelConfigId;
          paneOneSelectedToolIds = body.selectedToolIds ?? paneOneSelectedToolIds;
          paneOneCollaborationMode = body.collaborationMode ?? paneOneCollaborationMode;
          return {
            ok: true,
            status: 200,
            json: async () => paneOneSession()
          };
        }
        if (method === "PUT" && url === `/api/panes/${encodeURIComponent(paneOne)}/agent/goal`) {
          return {
            ok: true,
            status: 200,
            json: async () => paneOneSession()
          };
        }
        if (method === "PATCH" && url === `/api/panes/${encodeURIComponent(paneThree)}`) {
          restoredClosedPane = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: paneThree,
              roomId: "room:agents",
              title: "Archived",
              mode: "CHAT",
              status: "IDLE",
              providerId: null,
              modelId: null,
              reasoningEffort: "medium",
              cwd: "/opt/spaceapp",
              order: 2,
              columnSpan: 1,
              isMaximized: false,
              isMinimized: false,
              isClosed: false,
              split: { parentId: null, direction: null, size: null },
              createdAt: "2026-06-29T00:00:00.000Z",
              updatedAt: "2026-06-29T00:00:10.000Z"
            })
          };
        }
        if (method === "POST" && url === `/api/panes/${encodeURIComponent(paneThree)}/agent-session`) {
          return {
            ok: true,
            status: 200,
            json: async () => session(paneThree, "Archived", "Restored session keeps running", "RUNNING")
          };
        }

        if (!(url in payloads)) {
          throw new Error(`Missing fixture for ${method} ${url}`);
        }

        return {
          ok: true,
          status: 200,
          json: async () => payloads[url]
        };
      })
    );

    render(<App />);

    const plannerAgent = await screen.findByLabelText("Native agent Planner");
    const plannerPane = plannerAgent.closest("article");
    expect(plannerPane).toBeTruthy();
    const plannerPaneElement = plannerPane as HTMLElement;
    fireEvent.contextMenu(plannerPaneElement.querySelector(".pane-agent-badge") as HTMLElement, {
      clientX: 96,
      clientY: 64
    });
    const loadingBadgeMenu = await screen.findByRole("menu", { name: "Pane menu Planner" });
    // Copy session info waits for the Chat session: it is disabled with its reason instead of copying a stub.
    const loadingCopySessionInfo = within(loadingBadgeMenu).getByRole("menuitem", { name: "Copy session info" });
    expect(loadingCopySessionInfo).toHaveProperty("disabled", true);
    expect(loadingCopySessionInfo.getAttribute("title")).toBe("The Chat session is still loading.");
    fireEvent.click(loadingCopySessionInfo);
    expect(writeText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalledWith("Planner");
    releaseInitialPaneOneSession();
    await waitFor(() => expect(initialPaneOneSessionPending).toBe(false));
    await waitFor(() => expect(loadingCopySessionInfo).toHaveProperty("disabled", false));
    expect(loadingCopySessionInfo.getAttribute("title")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Pane menu Planner" })).toBeNull());

    expect(plannerAgent).toBeTruthy();
    expect(within(plannerAgent).queryByRole("button", { name: "Task history" })).toBeNull();
    // Stage 8: the Dot header's ✎ is the only in-pane new conversation control; Task history stays in the pane menu.
    const inPaneNewConversation = within(plannerAgent).getAllByRole("button", { name: "New conversation" });
    expect(inPaneNewConversation).toHaveLength(1);
    expect(inPaneNewConversation[0]?.closest(".dots-header")).toBeTruthy();
    expect(within(plannerAgent).queryByRole("button", { name: "New task" })).toBeNull();
    expect(plannerPaneElement.querySelectorAll(".pane-actions > button")).toHaveLength(0);
    expect(within(plannerPaneElement.querySelector(".pane-actions-fixed") as HTMLElement)
      .getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
        "More pane actions Planner",
        "Maximize pane",
        "Minimize pane Planner",
        "Close pane"
      ]);
    expect(within(plannerPaneElement).queryByRole("button", { name: "Edit pane title Planner" })).toBeNull();

    fireEvent.contextMenu(plannerPaneElement.querySelector(".pane-agent-badge") as HTMLElement, {
      clientX: 96,
      clientY: 64
    });
    const badgeMenu = await screen.findByRole("menu", { name: "Pane menu Planner" });
    expect(within(badgeMenu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "Copy session info",
      "Edit pane title",
      "Generate pane title"
    ]);
    fireEvent.click(within(badgeMenu).getByRole("menuitem", { name: "Copy session info" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith([
      `Space agent session ID: agent_session:${paneOne}`,
      "Codex thread ID: Not assigned yet"
    ].join("\n")));
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Pane menu Planner" })).toBeNull());

    fireEvent.click(within(plannerPaneElement).getByRole("button", { name: "More pane actions Planner" }));
    const paneMenu = await screen.findByRole("menu", { name: "Pane actions Planner" });
    expect(within(paneMenu).getByRole("group", { name: "Quick actions" })).toBeTruthy();
    expect(within(paneMenu).getByRole("menuitem", { name: "New task" })).toBeTruthy();
    expect(within(paneMenu).getByRole("menuitem", { name: "Task history" })).toBeTruthy();
    expect(within(paneMenu).getByRole("menuitem", { name: "Attach folder" })).toBeTruthy();
    expect(within(paneMenu).getByRole("menuitem", { name: "Manage goal" })).toBeTruthy();
    expect(within(paneMenu).getByRole("group", { name: "Pane actions" })).toBeTruthy();
    expect(within(paneMenu).queryAllByRole("menuitemcheckbox")).toHaveLength(0);
    const expectedPaneActionIcons = new Map([
      ["New task", "Plus"],
      ["Task history", "History"],
      ["Attach folder", "FolderPlus"],
      ["Manage goal", "Crosshair"],
      ["Import files Planner", "Paperclip"],
      ["Generate pane title with AI Planner", "Sparkles"],
      ["Enable Plan mode Planner", "ClipboardList"],
      ["Resume Planner", "Send"],
      ["Stop Planner", "CircleStop"],
      ["Save Planner to memory", "Database"],
      ["Copy Chat contents Planner", "Copy"],
      ["Reconnect Chat Planner", "RefreshCw"],
      ["Cannot move Planner without another room", "ArrowRightLeft"],
      ["Target Planner", "Crosshair"],
      ["Add pane from Planner", "Columns2"],
      ["Grow pane width", "MoveHorizontal"]
    ]);
    // Reset pane width only appears once the pane has been widened.
    expect(within(paneMenu).queryByRole("menuitem", { name: "Reset pane width" })).toBeNull();
    for (const [actionName, iconName] of expectedPaneActionIcons) {
      const action = within(paneMenu).getByRole("menuitem", { name: actionName });
      expect(action.querySelector("svg")?.getAttribute("data-app-icon")).toBe(iconName);
      expect(within(paneMenu).getAllByRole("menuitem", { name: actionName })).toHaveLength(1);
    }
    async function runPlannerPaneAction(name: string) {
      fireEvent.click(within(plannerPaneElement).getByRole("button", { name: "More pane actions Planner" }));
      const menu = await screen.findByRole("menu", { name: "Pane actions Planner" });
      const action = within(menu).getByRole("menuitem", { name });
      await waitFor(() => expect(action).toHaveProperty("disabled", false));
      fireEvent.click(action);
    }
    // Chat Task history lists only this Chat's own conversations. Without a Dot that is just the active
    // conversation, so a Chat without one offers nothing, never the server-wide Codex threads.
    fireEvent.click(within(paneMenu).getByRole("menuitem", { name: "Task history" }));
    expect(screen.queryByRole("menu", { name: "Pane actions Planner" })).toBeNull();
    const emptyHistoryDialog = await screen.findByRole("dialog", { name: "Open Codex task history" });
    expect(await within(emptyHistoryDialog).findByText("No Codex tasks found")).toBeTruthy();
    expect(within(emptyHistoryDialog).queryByRole("button", { name: /Codex task Codex Planner Task/ })).toBeNull();
    expect(requests.some((request) => request.startsWith("GET /api/codex/history"))).toBe(false);
    fireEvent.click(within(emptyHistoryDialog).getByRole("button", { name: "Close task history" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Open Codex task history" })).toBeNull());

    // Once the server binds the Chat to its Codex conversation, a session reload shows that transcript.
    paneOneThreadId = "019f-codex-planner";
    await runPlannerPaneAction("Reconnect Chat Planner");
    expect(await within(plannerAgent).findByText("test prompt")).toBeTruthy();
    const threadLoadsBeforeHistory = requests.filter(
      (request) => request === "GET /api/codex/threads/019f-codex-planner?presentation=chat"
    ).length;

    // Task history now offers exactly that conversation, and choosing it reopens it in this pane.
    await runPlannerPaneAction("Task history");
    const historyDialog = await screen.findByRole("dialog", { name: "Open Codex task history" });
    const historyRow = await within(historyDialog).findByRole("button", { name: /Codex task Codex Planner Task/ });
    expect(within(historyDialog).getAllByRole("button", { name: /^Codex task / })).toHaveLength(1);
    expect(requests).toContain("GET /api/codex/history?page=1&pageSize=50&dedupeTitles=true");
    fireEvent.click(historyRow);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Open Codex task history" })).toBeNull());
    await waitFor(() =>
      expect(requests.filter((request) => request === "GET /api/codex/threads/019f-codex-planner?presentation=chat").length)
        .toBe(threadLoadsBeforeHistory + 1)
    );
    // Reopening the Chat's own conversation never rebinds the session to another thread.
    expect(
      requestBodies.some(
        (request) =>
          request.url === `/api/panes/${encodeURIComponent(paneOne)}/agent-session` &&
          request.body.includes("\"threadId\":\"019f-codex-planner\"")
      )
    ).toBe(false);
    expect(await within(plannerAgent).findByText("test prompt")).toBeTruthy();
    expect(within(plannerAgent).getByText("test received")).toBeTruthy();
    expect(within(plannerAgent).queryByText("Worked with shell")).toBeNull();
    expect(within(plannerAgent).queryByText("Live stats")).toBeNull();
    fireEvent.contextMenu(plannerPaneElement.querySelector(".pane-agent-badge") as HTMLElement, {
      clientX: 96,
      clientY: 64
    });
    const resumedBadgeMenu = await screen.findByRole("menu", { name: "Pane menu Planner" });
    fireEvent.click(within(resumedBadgeMenu).getByRole("menuitem", { name: "Copy session info" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith([
      `Space agent session ID: agent_session:${paneOne}`,
      "Codex thread ID: 019f-codex-planner"
    ].join("\n")));
    const reviewerAgent = await screen.findByLabelText("Native agent Reviewer");
    expect(within(reviewerAgent).queryByRole("button", { name: "Task history" })).toBeNull();
    expect(requests.filter((request) => request === "GET /api/codex/environment")).toHaveLength(1);
    expect(document.querySelector("iframe, embed")).toBeNull();
    expect(screen.queryByText("No turns yet")).toBeNull();
    expect(screen.queryByLabelText("Command prompt")).toBeNull();
    expect(screen.queryByLabelText("Agent provider")).toBeNull();
    expect(screen.queryByLabelText("Agent model")).toBeNull();
    expect(screen.queryAllByText("Agents")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /New session/i })).toBeNull();
    expect(screen.queryByText("Session")).toBeNull();
    expect(screen.queryByText(`agent_session:${paneOne}`)).toBeNull();
    expect(screen.queryByLabelText("Session Planner")).toBeNull();
    expect(screen.queryByLabelText("Toggle details Planner")).toBeNull();
    const planner = within(plannerAgent);
    const composerRow = planner.getByLabelText("Agent composer controls Planner");
    expect(composerRow).toBeTruthy();
    expect(plannerAgent.querySelector(".coder-agent-settings")).toBeNull();
    expect(plannerAgent.querySelector(".coder-composer-controls")).toBeNull();
    expect(plannerAgent.querySelector(".coder-tool-popover")).toBeNull();
    expect(plannerAgent.querySelector(".coder-tool-count-chip")).toBeNull();
    expect(screen.queryByLabelText("Enable Plan mode Planner")).toBeNull();
    expect(screen.queryByLabelText("Resume Planner")).toBeNull();
    expect(screen.queryByLabelText("Stop Planner")).toBeNull();
    expect(screen.queryByLabelText("Save Planner to memory")).toBeNull();
    expect(screen.queryByLabelText("Copy Chat contents Planner")).toBeNull();
    expect(screen.queryByLabelText("Reconnect Chat Planner")).toBeNull();
    expect(within(composerRow).queryByLabelText("Add context")).toBeNull();
    expect(within(composerRow).queryByLabelText("Permission: Full access")).toBeNull();
    // A Chat without a Dot (legacy) keeps its in-pane model picker; a Dot's model is set in Settings → Dots.
    const initialModelTrigger = within(composerRow).getByRole("button", {
      name: /Change model and reasoning\. Current GPT-5\.5 · High/i
    });
    expect(initialModelTrigger).toBeTruthy();
    fireEvent.click(initialModelTrigger);
    const initialModelDialog = await within(plannerAgent).findByRole("dialog", { name: "Model and reasoning" });
    expect(within(initialModelDialog).getByRole("option", { name: "GPT-5.5" })).toBeTruthy();
    expect(within(initialModelDialog).getByRole("option", { name: "GPT-5 Mini" })).toBeTruthy();
    expect(within(initialModelDialog).getByRole("slider", { name: "Reasoning effort" })).toBeTruthy();
    fireEvent.keyDown(initialModelDialog, { key: "Escape" });

    await runPlannerPaneAction("Copy Chat contents Planner");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("User:\ntest prompt")));
    expect(writeText.mock.calls[0]?.[0]).not.toContain("Session started");
    await waitFor(() => expect(requests).toContain("POST /api/clipboard-items"));
    expect(await within(plannerAgent).findByText("Chat contents copied.")).toBeTruthy();

    const sessionLoadsBeforeReconnect = requests.filter((request) => request === `GET /api/panes/${encodeURIComponent(paneOne)}/agent-session`).length;
    await runPlannerPaneAction("Reconnect Chat Planner");
    await waitFor(() => expect(requests.filter((request) => request === `GET /api/panes/${encodeURIComponent(paneOne)}/agent-session`).length).toBe(sessionLoadsBeforeReconnect + 1));
    // Reconnect reloads the session quietly (no "reconnected" notice) and keeps the open transcript.
    expect(within(plannerAgent).getByText("test prompt")).toBeTruthy();
    expect(within(plannerAgent).queryByText("Agent session failed to load")).toBeNull();
    expect((planner.getByLabelText("Message Planner") as HTMLTextAreaElement).disabled).toBe(false);

    await runPlannerPaneAction("Resume Planner");
    await waitFor(() =>
      expect(
        requestBodies.some(
          (request) =>
            request.url === `/api/panes/${encodeURIComponent(paneOne)}/agent/messages` &&
            request.body.includes("\"content\":\"resume\"")
        )
      ).toBe(true)
    );
    await waitFor(() => expect((planner.getByLabelText("Message Planner") as HTMLTextAreaElement).disabled).toBe(false));

    await runPlannerPaneAction("Save Planner to memory");
    await waitFor(() =>
      expect(
        requestBodies.some(
          (request) =>
            request.url === `/api/panes/${encodeURIComponent(paneOne)}/agent/settings` &&
            request.body.includes("\"selectedModelConfigId\":\"gpt-5-mini:minimal\"")
        )
      ).toBe(true)
    );
    await waitFor(() =>
      expect(
        requestBodies.some(
          (request) =>
            request.url === `/api/panes/${encodeURIComponent(paneOne)}/agent/messages` &&
            request.body.includes("\"content\":\"save to memory\"") &&
            request.body.includes("\"selectedModelConfigId\":\"gpt-5-mini:minimal\"")
        )
      ).toBe(true)
    );

    await runPlannerPaneAction("Enable Plan mode Planner");
    await waitFor(() =>
      expect(
        requestBodies.some(
          (request) =>
            request.url === `/api/panes/${encodeURIComponent(paneOne)}/agent/settings` &&
            request.body.includes("\"collaborationMode\":\"plan\"")
        )
      ).toBe(true)
    );
    expect(within(plannerAgent).queryByLabelText("More task actions")).toBeNull();
    const planModeIndicator = await within(plannerAgent).findByRole("button", {
      name: "Disable Plan mode Planner"
    });
    expect(planModeIndicator.textContent).toContain("Plan mode on");
    expect(planModeIndicator.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(planModeIndicator);
    await waitFor(() =>
      expect(
        requestBodies.some(
          (request) =>
            request.url === `/api/panes/${encodeURIComponent(paneOne)}/agent/settings` &&
            request.body.includes("\"collaborationMode\":\"default\"")
        )
      ).toBe(true)
    );
    await waitFor(() =>
      expect(within(plannerAgent).queryByRole("button", { name: "Disable Plan mode Planner" })).toBeNull()
    );

    const folderInput = plannerAgent.querySelector<HTMLInputElement>('input[webkitdirectory]');
    expect(folderInput).toBeTruthy();
    const folderClick = vi.spyOn(folderInput as HTMLInputElement, "click");
    fireEvent.click(within(plannerPane as HTMLElement).getByRole("button", { name: "More pane actions Planner" }));
    const folderMenu = await screen.findByRole("menu", { name: "Pane actions Planner" });
    fireEvent.click(within(folderMenu).getByRole("menuitem", { name: "Attach folder" }));
    expect(folderClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "Pane actions Planner" })).toBeNull();

    fireEvent.click(within(plannerPane as HTMLElement).getByRole("button", { name: "More pane actions Planner" }));
    const goalMenu = await screen.findByRole("menu", { name: "Pane actions Planner" });
    fireEvent.click(within(goalMenu).getByRole("menuitem", { name: "Manage goal" }));
    const goalDialog = await screen.findByRole("dialog", { name: "Manage goal Planner" });
    fireEvent.change(within(goalDialog).getByLabelText("Goal objective"), { target: { value: "Ship exact Chat and CLI parity" } });
    fireEvent.click(within(goalDialog).getByRole("button", { name: "Save goal" }));
    await waitFor(() =>
      expect(
        requestBodies.some(
          (request) =>
            request.url === `/api/panes/${encodeURIComponent(paneOne)}/agent/goal` &&
            request.body.includes("\"objective\":\"Ship exact Chat and CLI parity\"")
        )
      ).toBe(true)
    );
    expect(screen.queryByRole("dialog", { name: "Manage goal Planner" })).toBeNull();

    fireEvent.click(within(plannerPane as HTMLElement).getByRole("button", { name: "More pane actions Planner" }));
    const newTaskMenu = await screen.findByRole("menu", { name: "Pane actions Planner" });
    fireEvent.click(within(newTaskMenu).getByRole("menuitem", { name: "New task" }));
    await waitFor(() =>
      expect(
        requestBodies.some(
          (request) =>
            request.url === `/api/panes/${encodeURIComponent(paneOne)}/agent-session` &&
            request.body.includes("\"sessionId\":null") &&
            request.body.includes("\"threadId\":null")
        )
      ).toBe(true)
    );

    fireEvent.click(within(plannerAgent).getByRole("button", {
      name: /Change model and reasoning\. Current GPT-5 Mini · Minimal/i
    }));
    const modelDialog = await within(plannerAgent).findByRole("dialog", { name: "Model and reasoning" });
    fireEvent.change(within(modelDialog).getByRole("combobox", { name: "Model" }), { target: { value: "gpt-5.5" } });
    const effortSlider = await within(modelDialog).findByRole("slider", { name: "Reasoning effort" });
    await waitFor(() => expect(effortSlider).toHaveProperty("disabled", false));
    fireEvent.change(effortSlider, { target: { value: "0" } });
    fireEvent.pointerUp(effortSlider);
    await waitFor(() =>
      expect(requestBodies.some((request) => request.body.includes("\"selectedModelConfigId\":\"gpt-5.5:low\""))).toBe(true)
    );
    expect(within(plannerAgent).getByRole("button", {
      name: /Change model and reasoning\. Current GPT-5\.5 · Low/i
    })).toBeTruthy();

    const composer = planner.getByLabelText("Message Planner") as HTMLTextAreaElement;
    fireEvent.drop(plannerAgent, {
      dataTransfer: {
        types: ["application/x-space-artifact"],
        files: [],
        getData: (type: string) => type === "application/x-space-clipboard-item-id" ? "clipboard:drag" : type === "text/plain" ? "dragged clip" : ""
      }
    });
    expect(composer.value).toBe("dragged clip");
    window.dispatchEvent(new CustomEvent("space:agent-pane-action", {
      detail: { paneId: paneOne, action: "insert_text", text: "inserted clip" }
    }));
    await waitFor(() => expect(composer.value).toBe("dragged clip\ninserted clip"));

    const screenshot = new File(["data"], "screen.png", { type: "image/png" });
    fireEvent.paste(plannerAgent, {
      clipboardData: {
        files: [],
        items: [{ kind: "file", getAsFile: () => screenshot }],
        getData: () => ""
      }
    });
    fireEvent.change(planner.getByLabelText("Message Planner"), { target: { value: "send with image" } });
    const sendButton = await screen.findByRole("button", { name: "Send Planner" });
    expect(await planner.findByRole("img", { name: "screen.png" })).toBeTruthy();
    await waitFor(() => expect(requests.some((request) => request.startsWith("POST /api/artifacts/file-uploads?"))).toBe(true));
    fireEvent.click(planner.getByRole("button", { name: "Clear all attachments" }));
    await waitFor(() => expect(planner.queryByRole("img", { name: "screen.png" })).toBeNull());

    fireEvent.paste(plannerAgent, {
      clipboardData: {
        files: [],
        items: [{ kind: "file", getAsFile: () => screenshot }],
        getData: () => ""
      }
    });
    expect(await planner.findByRole("img", { name: "screen.png" })).toBeTruthy();
    await waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sendButton);
    await waitFor(() => expect(requests).toContain(`POST /api/panes/${encodeURIComponent(paneOne)}/agent/messages`));
    await waitFor(() => expect(planner.queryByRole("img", { name: "screen.png" })).toBeNull());
    await waitFor(() => expect((planner.getByLabelText("Message Planner") as HTMLTextAreaElement).value).toBe(""));
    expect(window.sessionStorage.getItem(`space.agentPaneDraft:${paneOne}`)).toBeNull();
    const resolveSendResponse = releaseSendResponse as (() => void) | null;
    if (!resolveSendResponse) {
      throw new Error("Expected deferred send response to be captured.");
    }
    resolveSendResponse();
    const sendBody = requestBodies.findLast(
      (request) => request.url === `/api/panes/${encodeURIComponent(paneOne)}/agent/messages` && request.body.includes("\"content\":\"send with image\"")
    );
    expect(sendBody ? JSON.parse(sendBody.body) : null).toMatchObject({
      content: "send with image",
      selectedModelConfigId: "gpt-5.5:low",
      selectedToolIds: ["mcp:github", "mcp:linear", "browser:extract_text"],
      artifactIds: ["artifact:screen"]
    });
    expect(requestHeaders.get(`POST /api/panes/${encodeURIComponent(paneOne)}/agent/messages`)).toMatchObject({
      [csrfHeaderName]: "csrf:test"
    });

    await runPlannerPaneAction("Stop Planner");
    await waitFor(() => expect(requests).toContain(`POST /api/panes/${encodeURIComponent(paneOne)}/agent/interrupt`));
    paneOneRunErrorReason = "CODEX_APP_SERVER_TURN_INCOMPLETE: Codex stopped before the task completed.";
    const sessionLoadsBeforeFailedReconnect = requests.filter(
      (request) => request === `GET /api/panes/${encodeURIComponent(paneOne)}/agent-session`
    ).length;
    await runPlannerPaneAction("Reconnect Chat Planner");
    await waitFor(() => expect(requests.filter(
      (request) => request === `GET /api/panes/${encodeURIComponent(paneOne)}/agent-session`
    )).toHaveLength(sessionLoadsBeforeFailedReconnect + 1));
    fireEvent.click(await within(plannerAgent).findByRole("button", { name: "Details" }));
    expect(await within(plannerAgent).findByText(paneOneRunErrorReason)).toBeTruthy();
    expect(document.querySelector("iframe, embed")).toBeNull();
  }, 60000);

  it("keeps mobile chat panes mounted across pane switches and shell resizes", async () => {
    const requests: string[] = [];
    const paneOne = "pane:mobile-one";
    const paneTwo = "pane:mobile-two";

    setViewport(390, 844);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url}`);

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
                id: "room:mobile",
                name: "Mobile room",
                description: null,
                paneCap: 16,
                createdAt: "2026-07-07T00:00:00.000Z",
                updatedAt: "2026-07-07T00:00:00.000Z",
                archivedAt: null,
                traceId: "req:mobile-room"
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
              statusReason: "MCP discovery metadata is not verified.",
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
            root: { path: "/", deviceId: "100", sizeBytes: 1, availableBytes: 1, usedPercent: 0 },
            app: { path: "/opt/spaceapp", deviceId: "200", sizeBytes: 1, availableBytes: 1, usedPercent: 0 },
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
            pollerIdentities: ["space-worker@test"],
            lastPollerAccessAt: "2026-07-07T00:00:00.000Z",
            checkedAt: "2026-07-07T00:00:00.000Z"
          },
          "/api/panes?roomId=room%3Amobile": {
            data: [
              {
                id: paneOne,
                roomId: "room:mobile",
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
                createdAt: "2026-07-07T00:00:00.000Z",
                updatedAt: "2026-07-07T00:00:00.000Z"
              },
              {
                id: paneTwo,
                roomId: "room:mobile",
                title: "Reviewer",
                mode: "CHAT",
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
                createdAt: "2026-07-07T00:00:00.000Z",
                updatedAt: "2026-07-07T00:00:00.000Z"
              }
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 }
          },
          "/api/swarm?roomId=room%3Amobile": {
            tasks: [],
            locks: [],
            messages: [],
            reconciles: [],
            executionStatus: "DISABLED",
            statusReason: "Swarm execution is control-plane only."
          },
          "/api/turns?roomId=room%3Amobile": { data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
          "/api/events?roomId=room%3Amobile&pageSize=50&sortOrder=desc": {
            data: [],
            pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 }
          },
          [`/api/panes/${encodeURIComponent(paneOne)}/agent-session`]: session(paneOne, "Planner", "Planner ready", "READY", "room:mobile"),
          [`/api/panes/${encodeURIComponent(paneTwo)}/agent-session`]: session(paneTwo, "Reviewer", "Reviewer ready", "READY", "room:mobile"),
          "/api/codex/history?pageSize=50": codexHistoryPayload(),
          "/api/codex/environment": codexEnvironmentPayload(),
          "/api/auth/csrf": { csrfToken: "csrf:test", headerName: csrfHeaderName }
        };

        if (method === "GET" && url === "/api/artifacts/artifact%3Amobile/file") {
          return { ok: true, status: 200, blob: async () => new Blob(["mobile bytes"], { type: "image/png" }) };
        }

        if (method === "POST" && url.startsWith("/api/artifacts/file-uploads?")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              artifacts: [
                {
                  id: "artifact:mobile-screen",
                  roomId: "room:mobile",
                  paneId: paneOne,
                  turnId: null,
                  workflowId: null,
                  kind: "IMAGE",
                  mimeType: "image/png",
                  storageUri: "space-artifact://user-uploads/mobile-screen.png",
                  sha256: "1".repeat(64),
                  byteSize: 4,
                  metadata: { source: "CLIPBOARD", originalFilename: "screen.png" },
                  createdAt: "2026-07-07T00:00:00.000Z",
                  traceId: "req:mobile-upload"
                }
              ]
            })
          };
        }

        if (!(url in payloads)) {
          throw new Error(`Missing fixture for ${method} ${url}`);
        }

        return {
          ok: true,
          status: 200,
          json: async () => payloads[url]
        };
      })
    );

    render(<App />);

    const plannerAgent = await screen.findByLabelText("Native agent Planner");
    const initialPlannerLoads = requests.filter((request) => request === `GET /api/panes/${encodeURIComponent(paneOne)}/agent-session`).length;
    const initialReviewerLoads = requests.filter((request) => request === `GET /api/panes/${encodeURIComponent(paneTwo)}/agent-session`).length;

    expect(initialPlannerLoads).toBe(1);
    expect(initialReviewerLoads).toBe(1);

    const plannerPane = plannerAgent.closest("article");
    expect(plannerPane).toBeTruthy();
    fireEvent.click(within(plannerPane as HTMLElement).getByRole("button", { name: "More pane actions Planner" }));
    const mobileActions = await screen.findByRole("dialog", { name: "Pane actions Planner" });
    const taskCommands = within(mobileActions).getByRole("group", { name: "Task commands" });
    expect(within(taskCommands).getByRole("button", { name: "New task" })).toBeTruthy();
    expect(within(taskCommands).getByRole("button", { name: "Task history" })).toBeTruthy();
    expect(within(taskCommands).getByRole("button", { name: "Attach folder" })).toBeTruthy();
    expect(within(taskCommands).getByRole("button", { name: "Manage goal" })).toBeTruthy();
    expect(within(mobileActions).getByRole("group", { name: "Pane actions" })).toBeTruthy();
    fireEvent.click(within(taskCommands).getByRole("button", { name: "Manage goal" }));
    const mobileGoalDialog = await screen.findByRole("dialog", { name: "Manage goal Planner" });
    fireEvent.click(within(mobileGoalDialog).getByRole("button", { name: "Close goal editor" }));
    expect(screen.queryByRole("dialog", { name: "Pane actions Planner" })).toBeNull();

    const screenshot = new File(["data"], "screen.png", { type: "image/png" });
    fireEvent.paste(plannerAgent, {
      clipboardData: {
        files: [],
        items: [{ kind: "file", getAsFile: () => screenshot }],
        getData: () => ""
      }
    });
    expect(await within(plannerAgent).findByRole("img", { name: "screen.png" })).toBeTruthy();

    const reviewerPane = (await screen.findByLabelText("Native agent Reviewer")).closest("article")!;
    fireEvent.pointerDown(reviewerPane);
    expect(reviewerPane.classList.contains("is-target")).toBe(true);
    fireEvent.pointerDown(plannerPane!);
    expect(plannerPane!.classList.contains("is-target")).toBe(true);

    await waitFor(() => expect(within(plannerAgent).getByRole("img", { name: "screen.png" })).toBeTruthy());
    expect(requests.filter((request) => request === `GET /api/panes/${encodeURIComponent(paneOne)}/agent-session`).length).toBe(initialPlannerLoads);
    expect(requests.filter((request) => request === `GET /api/panes/${encodeURIComponent(paneTwo)}/agent-session`).length).toBe(initialReviewerLoads);

    setViewport(1280, 900);
    setViewport(390, 844);

    await waitFor(() => expect(within(plannerAgent).getByRole("img", { name: "screen.png" })).toBeTruthy());
    expect(requests.filter((request) => request === `GET /api/panes/${encodeURIComponent(paneOne)}/agent-session`).length).toBe(initialPlannerLoads);
    expect(requests.filter((request) => request === `GET /api/panes/${encodeURIComponent(paneTwo)}/agent-session`).length).toBe(initialReviewerLoads);

    fireEvent.drop(plannerAgent, {
      dataTransfer: {
        types: ["application/x-space-artifact"],
        files: [],
        getData: (type: string) =>
          type === "application/x-space-artifact"
            ? JSON.stringify({ id: "artifact:mobile", name: "mobile-shot.png", mimeType: "image/png" })
            : ""
      }
    });
    await waitFor(() =>
      expect(
        requests.some((request) => request.startsWith("POST /api/artifacts/file-uploads?") && request.includes("source=DROP"))
      ).toBe(true)
    );
    expect(await within(plannerAgent).findByRole("img", { name: "screen.png" })).toBeTruthy();
  }, 30000);

  it("recovers from a stale selected room and still sends in the fallback native pane", async () => {
    const requests: string[] = [];
    const requestBodies: Array<{ url: string; body: string }> = [];
    const stalePane = "pane:stale";
    const fallbackPane = "pane:fallback";
    let roomListCalls = 0;
    let staleRuntimeLoads = 0;
    setViewport(1280, 900);
    window.localStorage.setItem("space.selectedRoomId", "room:stale");

    const panePayload = (paneId: string, roomId: string, title: string) => ({
      id: paneId,
      roomId,
      title,
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
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z"
    });
    const roomPayload = (id: string, name: string, order = 0) => ({
      id,
      name,
      description: null,
      order,
      paneCap: 16,
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z",
      archivedAt: null,
      traceId: `req:${id}`
    });
    const paginated = <T,>(data: T[]) => ({
      data,
      pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: data.length ? 1 : 0 }
    });
    const roomRuntime = (roomId: string, paneId: string, title: string) => ({
      [`/api/panes?roomId=${encodeURIComponent(roomId)}`]: paginated([panePayload(paneId, roomId, title)]),
      [`/api/swarm?roomId=${encodeURIComponent(roomId)}`]: {
        tasks: [],
        locks: [],
        messages: [],
        reconciles: [],
        executionStatus: "DISABLED",
        statusReason: "Swarm execution is control-plane only."
      },
      [`/api/turns?roomId=${encodeURIComponent(roomId)}`]: paginated([]),
      [`/api/events?roomId=${encodeURIComponent(roomId)}&pageSize=50&sortOrder=desc`]: {
        data: [],
        pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 }
      },
      [`/api/rooms/${encodeURIComponent(roomId)}/agent-history`]: paginated([])
    });
    const notFound = {
      ok: false,
      status: 404,
      json: async () => ({ error: { code: "NOT_FOUND", message: "Room room:stale was not found" } })
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url}`);
        if (init?.body) requestBodies.push({ url, body: String(init.body) });

        if (url === "/api/rooms?all=true") {
          roomListCalls += 1;
          const rooms =
            roomListCalls === 1
              ? [roomPayload("room:stale", "Deleted mobile room"), roomPayload("room:fallback", "Fallback room")]
              : [roomPayload("room:fallback", "Fallback room")];
          return { ok: true, status: 200, json: async () => paginated(rooms) };
        }
        if (url.includes("room%3Astale")) {
          staleRuntimeLoads += 1;
          if (staleRuntimeLoads > 5) return notFound;
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
          "/api/voice/transcription/settings": disabledVoiceSettingsPayload(),
          "/api/providers": paginated([]),
          "/api/provider-settings": { defaultProviderId: "headroom-gateway", updatedAt: "2026-07-06T00:00:00.000Z" },
          "/api/models": paginated([]),
          "/api/skills": paginated([]),
          "/api/imports": { data: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } },
          "/api/admin": { status: "ok", mode: "dev", storageWarning: "" },
          "/api/mcp": {
            data: [],
            gateway: {
              id: "mcp-gateway",
              status: "DISABLED",
              statusReason: "MCP discovery metadata is not verified.",
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
              checkedAt: "2026-06-29T00:00:00.000Z"
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
            lastCheckedAt: "2026-06-29T00:00:00.000Z"
          },
          "/api/admin/codex-app-server/handshake": { data: null },
          "/api/admin/codex-app-server/turn-smoke": { data: null },
          "/api/admin/storage": {
            id: "space-storage",
            status: "VERIFIED",
            statusReason: "Storage ready.",
            root: { path: "/", deviceId: "100", sizeBytes: 1, availableBytes: 1, usedPercent: 0 },
            app: { path: "/opt/spaceapp", deviceId: "200", sizeBytes: 1, availableBytes: 1, usedPercent: 0 },
            dedicatedAppVolume: true,
            minimumRecommendedFreeBytes: 1,
            checkedAt: "2026-06-29T00:00:00.000Z"
          },
          "/api/admin/observability": {
            service: "space-api",
            generatedAt: "2026-06-29T00:00:00.000Z",
            runtime: {
              startedAt: "2026-06-29T00:00:00.000Z",
              uptimeSeconds: 1,
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
            pollerIdentities: ["space-worker@test"],
            lastPollerAccessAt: "2026-06-29T00:00:00.000Z",
            checkedAt: "2026-06-29T00:00:00.000Z"
          },
          "/api/codex/history?limit=50": codexHistoryPayload(),
          "/api/codex/environment": codexEnvironmentPayload(),
          "/api/codex/threads/019f-codex-planner?presentation=chat": codexThreadPayload(),
          ...roomRuntime("room:stale", stalePane, "Deleted mobile room"),
          ...roomRuntime("room:fallback", fallbackPane, "Fallback room"),
          [`/api/panes/${encodeURIComponent(stalePane)}/agent-session`]: session(
            stalePane,
            "Deleted mobile room",
            "Stale room initially loaded",
            "READY",
            "room:stale"
          ),
          [`/api/panes/${encodeURIComponent(fallbackPane)}/agent-session`]: session(
            fallbackPane,
            "Fallback room",
            "Fallback agent ready",
            "READY",
            "room:fallback"
          ),
          "/api/auth/csrf": { csrfToken: "csrf:test", headerName: csrfHeaderName }
        };

        if (method === "POST" && url === `/api/panes/${encodeURIComponent(fallbackPane)}/agent/messages`) {
          return {
            ok: true,
            status: 200,
            json: async () => session(fallbackPane, "Fallback room", "Fallback prompt accepted", "RUNNING", "room:fallback")
          };
        }

        if (!(url in payloads)) {
          throw new Error(`Missing fixture for ${method} ${url}`);
        }

        return {
          ok: true,
          status: 200,
          json: async () => payloads[url]
        };
      })
    );

    render(<App />);

    expect(await screen.findByLabelText("Native agent Deleted mobile room")).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("Native agent Fallback room")).toBeTruthy(), { timeout: 7000 });
    // The warm fallback pane can mount before the 30-second poll discovers the deleted room;
    // the switch stays silent (operator request 2026-10-14).
    await waitFor(() => expect(roomListCalls).toBeGreaterThan(1), { timeout: 35000 });
    expect(screen.queryByText(/no longer exists/i)).toBeNull();

    fireEvent.change(await screen.findByLabelText("Message Fallback room"), { target: { value: "mobile fallback prompt" } });
    fireEvent.click(await screen.findByRole("button", { name: "Send Fallback room" }));

    await waitFor(() => expect(requests).toContain(`POST /api/panes/${encodeURIComponent(fallbackPane)}/agent/messages`));
    expect(
      requestBodies.some(
        (request) =>
          request.url === `/api/panes/${encodeURIComponent(fallbackPane)}/agent/messages` &&
          request.body.includes("mobile fallback prompt")
      )
    ).toBe(true);
    expect(document.querySelector("iframe, embed")).toBeNull();
    expect(requests.some((request) => request.includes("192.0.2.216") || request.includes("coder-agent/proxy"))).toBe(false);
  }, 45000);

  it("renders voice input controls when transcription is configured", async () => {
    const requests: string[] = [];
    const paneId = "pane:voice";
    const paginated = <T,>(data: T[]) => ({
      data,
      pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: data.length ? 1 : 0 }
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        requests.push(`GET ${url}`);
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
          "/api/rooms?all=true": paginated([
            {
              id: "room:voice",
              name: "Voice room",
              description: null,
              paneCap: 16,
              createdAt: "2026-07-06T00:00:00.000Z",
              updatedAt: "2026-07-06T00:00:00.000Z",
              archivedAt: null,
              traceId: "req:voice-room"
            }
          ]),
          "/api/providers": paginated([]),
          "/api/provider-settings": { defaultProviderId: "headroom-gateway", updatedAt: "2026-07-06T00:00:00.000Z" },
          "/api/models": paginated([]),
          "/api/skills": paginated([]),
          "/api/imports": { data: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } },
          "/api/admin": { status: "ok", mode: "dev", storageWarning: "" },
          "/api/mcp": {
            data: [],
            gateway: {
              id: "mcp-gateway",
              status: "DISABLED",
              statusReason: "MCP discovery metadata is not verified.",
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
              checkedAt: "2026-07-06T00:00:00.000Z"
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
            lastCheckedAt: "2026-07-06T00:00:00.000Z"
          },
          "/api/admin/codex-app-server/handshake": { data: null },
          "/api/admin/codex-app-server/turn-smoke": { data: null },
          "/api/admin/storage": {
            id: "space-storage",
            status: "VERIFIED",
            statusReason: "Storage ready.",
            root: { path: "/", deviceId: "100", sizeBytes: 1, availableBytes: 1, usedPercent: 0 },
            app: { path: "/opt/spaceapp", deviceId: "200", sizeBytes: 1, availableBytes: 1, usedPercent: 0 },
            dedicatedAppVolume: true,
            minimumRecommendedFreeBytes: 1,
            checkedAt: "2026-07-06T00:00:00.000Z"
          },
          "/api/admin/observability": {
            service: "space-api",
            generatedAt: "2026-07-06T00:00:00.000Z",
            runtime: {
              startedAt: "2026-07-06T00:00:00.000Z",
              uptimeSeconds: 1,
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
            lastPollerAccessAt: "2026-07-06T00:00:00.000Z",
            checkedAt: "2026-07-06T00:00:00.000Z"
          },
          "/api/panes?roomId=room%3Avoice": paginated([
            {
              id: paneId,
              roomId: "room:voice",
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
              createdAt: "2026-07-06T00:00:00.000Z",
              updatedAt: "2026-07-06T00:00:00.000Z"
            }
          ]),
          "/api/rooms/room%3Avoice/agent-history": paginated([]),
          "/api/codex/history?limit=50": codexHistoryPayload(),
          "/api/codex/environment": codexEnvironmentPayload(),
          "/api/swarm?roomId=room%3Avoice": {
            tasks: [],
            locks: [],
            messages: [],
            reconciles: [],
            executionStatus: "DISABLED",
            statusReason: "Swarm execution is control-plane only."
          },
          "/api/turns?roomId=room%3Avoice": { data: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } },
          "/api/events?roomId=room%3Avoice&pageSize=50&sortOrder=desc": {
            data: [],
            pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 }
          },
          [`/api/panes/${encodeURIComponent(paneId)}/agent-session`]: session(paneId, "Planner", "Voice ready", "READY", "room:voice"),
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
            updatedAt: "2026-07-06T00:00:00.000Z"
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

    const voiceButton = await screen.findByRole("button", { name: "Start voice input Planner" });
    expect(voiceButton).toBeTruthy();
    await waitFor(() => expect((voiceButton as HTMLButtonElement).disabled).toBe(false));
    expect(requests).toContain("GET /api/voice/transcription/settings");
  }, 30000);
});
