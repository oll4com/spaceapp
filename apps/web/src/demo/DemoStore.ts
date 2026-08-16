import { canonicalizeUserLinkUrl, cliToggleRuntimeIds, streamingMetricDefinitions } from "@space/contracts";
import type {
  AgentRuntime,
  AgentRuntimeRegistry,
  AgentPaneSession,
  AgentPaneSettingsInput,
  Artifact,
  ClipboardItem,
  CliToggleRuntimeId,
  CodexResetCreditRedemptionResponse,
  UpdateCodexCliModeDefaultsInput,
  CreateClipboardItemRequest,
  CreateRoomPanesRequest,
  CreateTaskItemRequest,
  CreateUserLinkRequest,
  MemoryChangeSet,
  MemoryChangeSetSummary,
  MemoryGraphNode,
  MemoryGraphPayload,
  Pane,
  Room,
  RoomAgentSession,
  SetupConnection,
  SetupConnectionCheckEvent,
  SetupConnectionCheckReplay,
  SetupConnectionCheckRun,
  SetupOverview,
  StreamingBotActivity,
  StreamingBotSettings,
  StreamingBotStatus,
  StreamingCatalogResponse,
  StreamingMetricTileSnapshot,
  StreamingOverlaySettings,
  StreamingOverlaySnapshot,
  TaskItem,
  UpdateProviderSettingsInput,
  UpdateStreamingBotSettingsInput,
  UpdateStreamingOverlaySettingsInput,
  UpdateTelegramIntegrationInput,
  UpdateUserLinkRequest,
  UserLink
} from "@space/contracts";
import type { SpaceApiClient } from "../runtime/SpaceRuntime.js";
import { DEMO_LOCAL_REPLY, SpaceApiError } from "../runtime/SpaceRuntime.js";
import { CLI_RUNTIME_PRESENTATIONS, cliRuntimeLabel } from "../cli-runtime-presentation.js";
import { createDemoFixture, DEMO_FIXED_AT, type DemoFixture } from "./demo-fixture.js";

export const DEMO_WARNING = "DEMO MODE — Everything is simulated locally. No production service is connected.";
export { DEMO_LOCAL_REPLY } from "../runtime/SpaceRuntime.js";

function paginated<T>(data: T[]) {
  return { data, pagination: { page: 1, pageSize: Math.max(data.length, 1), totalItems: data.length, totalPages: data.length ? 1 : 0 } };
}

function requestedPage<T>(data: T[], query: { page?: number; pageSize?: number } = {}) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  const start = (page - 1) * pageSize;
  return {
    data: data.slice(start, start + pageSize),
    pagination: {
      page,
      pageSize,
      totalItems: data.length,
      totalPages: data.length === 0 ? 0 : Math.ceil(data.length / pageSize)
    }
  };
}

function cloneFixture(): DemoFixture {
  return structuredClone(createDemoFixture());
}

function initialStreamingSettings(): StreamingOverlaySettings {
  return {
    version: 1,
    tiles: [
      { metricKey: "space.rooms", accountId: null },
      { metricKey: "space.active_agents", accountId: null },
      { metricKey: "space.active_cli_sessions", accountId: null }
    ],
    customTextEnabled: false,
    customText: "",
    updatedAt: DEMO_FIXED_AT,
    updatedBy: "user:demo-admin"
  };
}

function initialStreamingBotSettings(): StreamingBotSettings {
  return {
    version: 1,
    enabled: false,
    persona: { name: "Live Assistant", tone: "Friendly, concise and helpful. Answer only questions about the stream." },
    platforms: {
      YOUTUBE: { enabled: false, accountId: null },
      TWITCH: { enabled: false, accountId: null }
    },
    facts: [{ key: "website", value: "https://spaceapp.dev" }],
    faq: [{ question: "What is Space?", answer: "Space is a local-first agent platform." }],
    instructions: "",
    guardrails: { cooldownSeconds: 15, maxRepliesPerMinute: 5, replyToQuestionsOnly: true },
    memoryEnabled: true,
    overlayTickerEnabled: false,
    updatedAt: DEMO_FIXED_AT,
    updatedBy: "user:demo-admin"
  };
}

function initialStreamingBotStatus(): StreamingBotStatus {
  return {
    enabled: false,
    paused: true,
    llmConfigured: false,
    model: null,
    youtubeQuota: { day: DEMO_FIXED_AT.slice(0, 10), unitsConsumed: 0, budget: 8000 },
    platforms: {
      YOUTUBE: { connected: false, live: false, chatId: null, lastPollAt: null, lastReplyAt: null, pendingCount: 0 },
      TWITCH: { connected: false, live: false, chatId: null, lastPollAt: null, lastReplyAt: null, pendingCount: 0 }
    }
  };
}

type DemoMemoryGraphQuery = {
  q?: string;
  nodeType?: MemoryGraphNode["type"];
  scope?: "SYSTEM" | "PROJECT" | "ROOM";
  roomId?: string;
  sourcePath?: string;
  lifecycleStatus?: "ACTIVE" | "ARCHIVED";
  month?: string;
  relationMode?: "CLUSTERED" | "RELATIONS";
  page?: number;
  pageSize?: number;
};

function memoryChangeSetSummary(changeSet: MemoryChangeSet): MemoryChangeSetSummary {
  const { beforeSnapshot: _before, afterSnapshot: _after, ...summary } = changeSet;
  return summary;
}

type DemoSetupConnectionResult = Pick<
  SetupConnection,
  "functionalState" | "liveVerificationState" | "reasonCode"
>;

interface DemoSetupCheckRunState {
  events: SetupConnectionCheckEvent[];
  nextConnectionIndex: number;
  run: SetupConnectionCheckRun;
}

const demoProviderNames: Readonly<Record<string, string>> = {
  "cli:codex": "Codex",
  "cli:claude": "Claude Code via Legacy",
  "cli:gemini": "Google Gemini",
  "cli:opencode": "OpenCode",
  "cli:autohand": "OpenRouter",
  "cli:qwen": "Alibaba Coding Plan International",
  "cli:kimi": "Moonshot AI",
  "cli:grok": "xAI",
  "cli:deepseek": "DeepSeek",
  "cli:cursor": "Cursor",
  "cli:copilot": "GitHub Copilot"
};

function initialSetupConnectionResults(): Map<string, DemoSetupConnectionResult> {
  return new Map(CLI_RUNTIME_PRESENTATIONS.map(({ id }, index) => [
    id,
    id === "cli:autohand"
      ? {
          functionalState: "NEEDS_SETUP",
          liveVerificationState: "NOT_CHECKED",
          reasonCode: "CREDENTIAL_REQUIRED"
        }
      : {
          functionalState: "FUNCTIONAL",
          liveVerificationState: index < 4 ? "VERIFIED" : "NOT_CHECKED",
          reasonCode: index < 4 ? null : "NOT_VERIFIED"
        }
  ]));
}

export class DemoStore {
  private fixture = cloneFixture();
  private sequence = 0;
  private cliRuntimeEnabled = new Map<CliToggleRuntimeId, boolean>(
    cliToggleRuntimeIds.map((runtimeId) => [runtimeId, true])
  );
  private agentMessages = new Map<string, AgentPaneSession["messages"]>();
  private agentSelectedToolIds = new Map<string, string[]>();
  private resetRedemptions = new Map<string, CodexResetCreditRedemptionResponse>();
  private setupConnectionResults = initialSetupConnectionResults();
  private setupCheckRuns = new Map<string, DemoSetupCheckRunState>();
  private setupCheckSequence = 0;
  private streamingSettings = initialStreamingSettings();
  private streamingBotSettings = initialStreamingBotSettings();
  private streamingBotStatus = initialStreamingBotStatus();
  readonly api: SpaceApiClient;

  constructor() {
    this.api = new Proxy({} as SpaceApiClient, {
      get: (_target, property) => (...args: unknown[]) => {
        const method = String(property);
        if (["artifactFileUrl", "agentFilePreviewUrl", "agentFileDownloadUrl", "browserBookmarksExportUrl", "browserFrameWebSocketUrl", "browserStreamWebSocketUrl", "cliRuntimesSnapshot", "cliRuntimeSettingsSnapshot", "cliTerminalWebSocketUrl", "eventStreamUrl", "invalidateCliRuntimes", "invalidateCliRuntimeSettings", "openSetupConnectionCheckStream", "resetCliRuntimeSettingsCache", "setCliTerminalControlLease", "warmCliRuntimes", "warmCliRuntimeSettings"].includes(method)) {
          return this.invoke(method, args);
        }
        return Promise.resolve().then(() => this.invoke(method, args));
      }
    });
  }

  reset(): void {
    this.fixture = cloneFixture();
    this.sequence = 0;
    this.cliRuntimeEnabled = new Map(cliToggleRuntimeIds.map((runtimeId) => [runtimeId, true]));
    this.agentMessages.clear();
    this.agentSelectedToolIds.clear();
    this.resetRedemptions.clear();
    this.setupConnectionResults = initialSetupConnectionResults();
    this.setupCheckRuns.clear();
    this.setupCheckSequence = 0;
    this.streamingSettings = initialStreamingSettings();
    this.streamingBotSettings = initialStreamingBotSettings();
    this.streamingBotStatus = initialStreamingBotStatus();
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}:demo-${String(this.sequence).padStart(3, "0")}`;
  }

  private demoCliRuntime(runtimeId: string, displayName: string): AgentRuntime {
    return {
      id: runtimeId,
      providerId: "demo-local",
      providerName: "Space Demo",
      agentId: runtimeId.replace(/^cli:/, ""),
      agentName: displayName,
      displayName,
      capabilities: ["CLI"],
      adapterStatus: "ENABLED",
      authMode: "NONE",
      authState: "READY",
      authReason: "Available in the local deterministic demo.",
      canStartLogin: false,
      status: "ENABLED",
      statusReason: "Available in the local deterministic demo.",
      commandName: runtimeId === "cli:root" ? "/bin/bash" : runtimeId.replace(/^cli:/, ""),
      detectedCommandPath: runtimeId === "cli:root" ? "/bin/bash" : `/demo/bin/${runtimeId.replace(/^cli:/, "")}`,
      defaultModelId: null,
      supportedReasoningEfforts: runtimeId === "cli:deepseek" ? [] : ["medium", "high", "xhigh"],
      checkedAt: DEMO_FIXED_AT
    };
  }

  private cliRuntimeRegistry(): AgentRuntimeRegistry {
    return {
      data: [
        ...CLI_RUNTIME_PRESENTATIONS
          .filter(({ id }) =>
            id === "cli:codex" || this.cliRuntimeEnabled.get(id as CliToggleRuntimeId) !== false
          )
          .map(({ id, displayName }) => this.demoCliRuntime(id, displayName)),
        this.demoCliRuntime("cli:root", "CLI ROOT")
      ],
      checkedAt: DEMO_FIXED_AT
    };
  }

  private agentSession(paneId: string): AgentPaneSession {
    const pane = this.fixture.panes.find((candidate) => candidate.id === paneId);
    const roomId = pane?.roomId ?? this.fixture.rooms[0]!.id;
    const messages = this.agentMessages.get(paneId) ?? [{
      id: `agent_message:${paneId}:welcome`,
      role: "assistant" as const,
      content: "Welcome to the deterministic Space demo. Explore the real workspace controls safely.",
      status: "COMPLETED" as const,
      createdAt: DEMO_FIXED_AT
    }];
    this.agentMessages.set(paneId, messages);
    const selectedToolIds = this.agentSelectedToolIds.get(paneId) ?? ["space-readonly:space_status"];
    return {
      binding: {
        paneId,
        source: "SPACE",
        sessionId: `agent_session:${paneId}`,
        coderChatId: null,
        status: "READY",
        title: pane?.title ?? "Demo chat",
        selectedModelConfigId: "gpt-5.6-sol:high",
        selectedProviderName: "Codex Demo",
        selectedModelName: "GPT-5.6 Sol",
        selectedReasoningKey: "high",
        selectedToolIds,
        lastSyncedAt: DEMO_FIXED_AT
      },
      threadId: `thread:${paneId}`,
      messages: [...messages],
      runStatus: "IDLE",
      statusReason: "Demo chat is ready and fully local.",
      modelOptions: [{
        id: "gpt-5.6-sol:high",
        displayName: "GPT-5.6 Sol · High",
        providerId: "demo-codex",
        providerName: "Codex Demo",
        model: "gpt-5.6-sol",
        reasoningKey: "high",
        reasoningLabel: "High reasoning",
        isDefault: true
      }],
      modelCatalog: [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["medium", "high", "xhigh"]
      }],
      modelProviders: [],
      selectedModelConfigId: "gpt-5.6-sol:high",
      toolOptions: structuredClone(this.fixture.agentToolOptions),
      selectedToolIds: [...selectedToolIds],
      permissionMode: null,
      collaborationMode: "default",
      permissionState: {
        mode: null,
        effectiveMode: "full_access",
        isInherited: true,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        reviewer: "user",
        statusReason: "Demo runtime never executes tools."
      },
      permissionOptions: [],
      goal: null,
      history: [],
      capabilities: { canSend: true, canInterrupt: false, canSelectModel: true, canSelectTools: true, supportsTools: true }
    };
  }

  private roomAgent(roomId: string): RoomAgentSession {
    return {
      roomId,
      paneId: null,
      sessionId: `room_agent:demo:${roomId}`,
      threadId: `thread:demo:${roomId}`,
      status: "IDLE",
      statusReason: "Demo Room Agent is ready and local-only.",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      messages: [{ id: `room_agent_message:${roomId}`, role: "assistant", content: DEMO_LOCAL_REPLY, status: "COMPLETED", createdAt: DEMO_FIXED_AT }],
      activeMission: null,
      queuedMissionCount: 0,
      currentPaneId: null,
      activePaneIds: [],
      progress: { totalSteps: 0, completedSteps: 0, runningSteps: 0, queuedSteps: 0, blockedSteps: 0, peakConcurrency: 0, elapsedMs: 0 },
      capabilities: { canSend: true, canPause: false, canResume: false, canStop: false, canClear: true }
    };
  }

  private cliSession(paneId: string) {
    const pane = this.fixture.panes.find((candidate) => candidate.id === paneId) ?? this.fixture.panes.find((candidate) => candidate.mode === "TERMINAL")!;
    const runtimeId = pane.terminalRuntimeId ?? "codex";
    const sessionId = `cli_session:${pane.id}`;
    return {
      session: {
        sessionId,
        paneId: pane.id,
        roomId: pane.roomId,
        runtimeId,
        providerId: "demo-local",
        agentId: runtimeId,
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high",
        cwd: "/workspace/space-demo",
        codexThreadId: null,
        status: "RUNNING",
        statusReason: "Local deterministic terminal controller.",
        exitCode: null,
        isActive: true,
        startedAt: DEMO_FIXED_AT,
        updatedAt: DEMO_FIXED_AT,
        endedAt: null
      },
      runtime: {
        id: runtimeId,
        providerId: "demo-local",
        providerName: "Space Demo",
        agentId: runtimeId,
        agentName: runtimeId === "root" ? "Root shell" : `${runtimeId} CLI`,
        displayName: runtimeId === "root" ? "Root CLI" : runtimeId === "opencode" ? "OpenCode CLI" : "Codex CLI",
        capabilities: ["CLI"],
        status: "READY",
        statusReason: "Simulated locally; no process is running.",
        commandName: null,
        detectedCommandPath: null,
        defaultModelId: "gpt-5.6-sol",
        supportedReasoningEfforts: ["medium", "high", "xhigh"],
        checkedAt: DEMO_FIXED_AT
      },
      transcript: [{
        chunkId: `cli_chunk:${pane.id}:0`,
        sessionId,
        paneId: pane.id,
        roomId: pane.roomId,
        sequence: 0,
        stream: "system",
        content: `Space ${runtimeId} demo ready. Commands stay inside this browser.\r\n${DEMO_LOCAL_REPLY}\r\n`,
        byteLength: DEMO_LOCAL_REPLY.length + 64,
        hostGenerationId: null,
        hostOutputSequence: null,
        createdAt: DEMO_FIXED_AT
      }],
      websocket: {
        paneId: pane.id,
        sessionId,
        token: "demo-local-terminal-token-000000000000",
        expiresAt: "2099-01-01T00:00:00.000Z"
      }
    };
  }

  private browserSession(paneId: string) {
    const pane = this.fixture.panes.find((candidate) => candidate.id === paneId) ?? this.fixture.panes.find((candidate) => candidate.mode === "BROWSER")!;
    const sessionId = `browser_session:${pane.id}`;
    const currentUrl = "https://demo.invalid/space-launch";
    const page = { pageId: `browser_page:${pane.id}`, kind: "PAGE", url: currentUrl, title: "Space launch preview", isActive: true, openerPageId: null, canGoBack: false, canGoForward: false };
    const frame = {
      sessionId,
      paneId: pane.id,
      roomId: pane.roomId,
      status: "READY",
      viewport: "desktop",
      currentUrl,
      title: "Space launch preview",
      screenshotDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+FvTqWQAAAABJRU5ErkJggg==",
      capturedAt: DEMO_FIXED_AT
    };
    return {
      session: {
        sessionId,
        paneId: pane.id,
        roomId: pane.roomId,
        ownerAgentId: "agent:demo",
        agentNumber: 3,
        profileId: `profile:${pane.id}`,
        profilePath: "/demo/browser-profile",
        viewport: "desktop",
        targetUrl: currentUrl,
        currentUrl,
        title: frame.title,
        status: "READY",
        statusReason: "Local canvas fixture; no browser host is connected.",
        lastFrameAt: DEMO_FIXED_AT,
        streamMode: "PREVIEW",
        resolvedStreamMode: "PREVIEW",
        runtimeState: "READY",
        capacityState: "AVAILABLE",
        controlState: "UNCONTROLLED",
        pages: [page],
        activePageId: page.pageId,
        workerHeartbeatAt: DEMO_FIXED_AT,
        queuePosition: null,
        isActive: true,
        startedAt: DEMO_FIXED_AT,
        updatedAt: DEMO_FIXED_AT,
        endedAt: null
      },
      frame,
      websocket: null
    };
  }

  private codexThread(threadId: string) {
    const thread = {
      id: threadId,
      rolloutPath: null,
      title: "Public demo launch thread",
      preview: "A sanitized, deterministic transcript rendered entirely in this browser.",
      model: "gpt-5.6-sol",
      reasoningEffort: "high" as const,
      cwd: "/workspace/space-demo",
      archived: false,
      source: "space-demo",
      modelProvider: "codex-lb",
      threadSource: "demo-fixture",
      firstUserMessage: "Review the public launch workspace.",
      updatedAt: DEMO_FIXED_AT,
      recencyAt: DEMO_FIXED_AT
    };
    return {
      thread,
      items: [
        {
          id: `codex_thread_item:${threadId}:user`,
          kind: "message" as const,
          role: "user" as const,
          content: "Review the public launch workspace.",
          toolName: null,
          rawType: "message",
          createdAt: DEMO_FIXED_AT
        },
        {
          id: `codex_thread_item:${threadId}:assistant`,
          kind: "message" as const,
          role: "assistant" as const,
          content: DEMO_LOCAL_REPLY,
          toolName: null,
          rawType: "message",
          createdAt: DEMO_FIXED_AT
        }
      ],
      checkedAt: DEMO_FIXED_AT
    };
  }

  private memoryGraph(query: DemoMemoryGraphQuery = {}): MemoryGraphPayload {
    const base = this.fixture.memoryWorkspace.graph;
    const needle = query.q?.trim().toLowerCase();
    const nodes = base.nodes.filter((node) => {
      const record = node.recordId ? this.fixture.memoryWorkspace.nodeDetails[node.id]?.record : null;
      const expectedMonthPath = query.month && query.month !== "all"
        ? `gemini_history_${query.month}.md`
        : null;
      return (!needle || [node.label, node.sourcePath, record?.body].some((value) => value?.toLowerCase().includes(needle))) &&
        (!query.nodeType || node.type === query.nodeType) &&
        (!query.sourcePath || node.sourcePath === query.sourcePath) &&
        (!query.scope || record?.scope === query.scope) &&
        (!query.roomId || record?.roomId === query.roomId) &&
        (!query.lifecycleStatus || record?.lifecycleStatus === query.lifecycleStatus) &&
        (!expectedMonthPath || node.sourcePath?.split("/").at(-1) === expectedMonthPath);
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = base.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    const recordCount = nodes.filter((node) => node.recordId).length;
    return structuredClone({
      ...base,
      summary: {
        sourceCount: new Set(nodes.flatMap((node) => node.sourcePath ? [node.sourcePath] : [])).size,
        recordCount,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        issueCount: this.fixture.memoryWorkspace.issues.filter((issue) => !issue.recordId || nodes.some((node) => node.recordId === issue.recordId)).length
      },
      nodes,
      edges,
      filters: {
        q: query.q ?? null,
        nodeType: query.nodeType ?? null,
        scope: query.scope ?? null,
        roomId: query.roomId ?? null,
        sourcePath: query.sourcePath ?? null,
        lifecycleStatus: query.lifecycleStatus ?? null,
        relationMode: query.relationMode ?? "RELATIONS",
        month: query.month ?? null
      }
    });
  }

  private invokeStreamingBot(method: string, args: unknown[]): unknown {
    switch (method) {
      case "streamingBotSettings":
        return Promise.resolve({ settings: structuredClone(this.streamingBotSettings), memoryCount: 3 });
      case "updateStreamingBotSettings": {
        const input = args[0] as UpdateStreamingBotSettingsInput;
        if (input.expectedVersion !== this.streamingBotSettings.version) {
          throw new SpaceApiError("The demo bot settings changed.", {
            status: 409,
            code: "STREAMING_BOT_SETTINGS_VERSION_CONFLICT"
          });
        }
        this.streamingBotSettings = {
          version: this.streamingBotSettings.version + 1,
          enabled: input.enabled,
          persona: structuredClone(input.persona),
          platforms: structuredClone(input.platforms),
          facts: structuredClone(input.facts),
          faq: structuredClone(input.faq),
          instructions: input.instructions,
          guardrails: structuredClone(input.guardrails),
          memoryEnabled: input.memoryEnabled,
          overlayTickerEnabled: input.overlayTickerEnabled,
          updatedAt: DEMO_FIXED_AT,
          updatedBy: "user:demo-admin"
        };
        this.streamingBotStatus = {
          ...this.streamingBotStatus,
          enabled: this.streamingBotSettings.enabled,
          paused: !this.streamingBotSettings.enabled
        };
        return Promise.resolve(structuredClone(this.streamingBotSettings));
      }
      case "pauseStreamingBot":
        this.streamingBotSettings = { ...this.streamingBotSettings, enabled: false, version: this.streamingBotSettings.version + 1 };
        this.streamingBotStatus = { ...this.streamingBotStatus, enabled: false, paused: true };
        return Promise.resolve(structuredClone(this.streamingBotSettings));
      case "resumeStreamingBot":
        this.streamingBotSettings = { ...this.streamingBotSettings, enabled: true, version: this.streamingBotSettings.version + 1 };
        this.streamingBotStatus = { ...this.streamingBotStatus, enabled: true, paused: false };
        return Promise.resolve(structuredClone(this.streamingBotSettings));
      case "streamingBotStatus":
        return Promise.resolve(structuredClone(this.streamingBotStatus));
      case "streamingBotActivity": {
        const demoActivity: StreamingBotActivity[] = [
          {
            id: "activity:demo-001",
            platform: "YOUTUBE",
            direction: "IN",
            author: "Viewer 1",
            message: "What stack does Space run on?",
            reply: null,
            status: "SKIPPED",
            createdAt: DEMO_FIXED_AT
          },
          {
            id: "activity:demo-002",
            platform: "TWITCH",
            direction: "OUT",
            author: "Live Assistant",
            message: "Space runs on Node.js with a local-first architecture.",
            reply: "Space runs on Node.js with a local-first architecture.",
            status: "REPLIED",
            createdAt: DEMO_FIXED_AT
          }
        ];
        return Promise.resolve({ data: demoActivity, pagination: { page: 1, pageSize: demoActivity.length, totalItems: demoActivity.length, totalPages: 1 } });
      }
      case "testStreamingBot": {
        const input = args[0] as { message: string };
        return Promise.resolve({
          reply: `Demo reply to "${input.message.slice(0, 80)}" — live replies are disabled in the local demo.`,
          errorCode: null,
          model: "demo-local"
        });
      }
      case "clearStreamingBotMemory":
        return Promise.resolve({ removed: 3 });
      case "createCliAccountProfile": return Promise.resolve({
        profile: {
          runtimeId: String((args[0] as { runtimeId?: string } | undefined)?.runtimeId ?? "cli:gemini"),
          profileId: String((args[0] as { profileId?: string } | undefined)?.profileId ?? "work"),
          displayName: String((args[0] as { displayName?: string } | undefined)?.displayName ?? "Work account"),
          createdAt: DEMO_FIXED_AT,
          updatedAt: DEMO_FIXED_AT,
          updatedBy: "user:demo-admin"
        }
      });
      case "removeCliAccountProfile": return Promise.resolve({ removed: true });
      case "searchStreamingBotMemory": {
        const query = String(args[0] ?? "");
        return Promise.resolve({
          entries: [{
            id: "memory:demo-001",
            title: query ? `Demo result for "${query}"` : "Demo memory",
            body: "This is a demo memory entry. Live bot memory is only available in a running Space installation.",
            createdAt: DEMO_FIXED_AT
          }]
        });
      }
      default:
        throw new SpaceApiError(DEMO_LOCAL_REPLY, { status: 409, code: "DEMO_LOCAL_ONLY" });
    }
  }

  private invoke(method: string, args: unknown[]): unknown {
    const roomId = typeof args[0] === "string" ? args[0] : null;
    switch (method) {
      case "me": return Promise.resolve(structuredClone(this.fixture.auth));
      case "setupStatus": return Promise.resolve({ setupRequired: false, expiresAt: null });
      case "claimSetup": {
        const onboarding = this.setupOverview();
        return Promise.resolve({
          ...structuredClone(this.fixture.auth),
          onboardingVersion: onboarding.onboardingVersion,
          isOnboardingComplete: onboarding.isComplete,
          starterRoomId: onboarding.starterRoomId
        });
      }
      case "setupOverview": return Promise.resolve(this.setupOverview());
      case "setupStarterRoom": return Promise.resolve({
        room: structuredClone(this.fixture.rooms[0]),
        onboarding: {
          onboardingVersion: 1,
          isComplete: true,
          completedAt: DEMO_FIXED_AT,
          starterRoomId: this.fixture.rooms[0]?.id ?? null
        }
      });
      case "startSetupConnectionChecks":
        return Promise.resolve(this.startSetupCheckRun(
          CLI_RUNTIME_PRESENTATIONS.map(({ id }) => id),
          "ALL"
        ));
      case "startSetupConnectionCheck":
        return Promise.resolve(this.startSetupCheckRun([String(args[0])], "SINGLE"));
      case "getSetupConnectionCheckReplay":
        return Promise.resolve(this.setupCheckReplay(
          String(args[0]),
          Number(args[1] ?? 0)
        ));
      case "openSetupConnectionCheckStream": return null;
      case "verifySetupConnection": {
        const connectionId = String(args[0]);
        this.setupConnectionResults.set(connectionId, {
          functionalState: "FUNCTIONAL",
          liveVerificationState: "VERIFIED",
          reasonCode: null
        });
        return Promise.resolve(this.setupOverview().connections.find(({ id }) => id === connectionId));
      }
      case "verifyAllSetupConnections":
        for (const connectionId of this.setupConnectionResults.keys()) {
          if (connectionId === "cli:autohand") continue;
          this.setupConnectionResults.set(connectionId, {
            functionalState: "FUNCTIONAL",
            liveVerificationState: "VERIFIED",
            reasonCode: null
          });
        }
        return Promise.resolve(this.setupOverview());
      case "finishSetup": return Promise.resolve({
        ...this.setupOverview(),
        isComplete: true,
        completedAt: DEMO_FIXED_AT
      });
      case "login": this.fixture.auth.isAuthenticated = true; return Promise.resolve(structuredClone(this.fixture.auth));
      case "logout": this.fixture.auth.isAuthenticated = false; return Promise.resolve({ ok: true });
      case "readyz": return Promise.resolve({
        ok: true,
        apiStartedAt: DEMO_FIXED_AT,
        dependencies: { store: "demo-local", runtimeStore: "demo-local", eventBus: "demo-local", temporal: "simulated", worker: "SIMULATED", cliHost: "SIMULATED", cliAdminHost: "SIMULATED", browserHost: "SIMULATED", browserHostBuildCommit: null, browserHostCaptureMetrics: null, codexTurns: "simulated", codexLb: "disconnected" }
      });
      case "appVersion": return Promise.resolve({
        appRelease: "v0.1.0",
        currentCommit: "demo",
        shortCommit: "demo",
        currentBranch: "demo",
        dirty: false,
        athensTag: null,
        githubLatest: null,
        githubTagUrl: null,
        updateAvailable: false,
        behindCount: 0,
        checkedAt: DEMO_FIXED_AT
      });
      case "rooms": return Promise.resolve(paginated(structuredClone(this.fixture.rooms)));
      case "roomCliActivity": return Promise.resolve({
        data: this.fixture.rooms.map((room) => {
          const runningPanes = this.fixture.panes.filter((pane) =>
            pane.roomId === room.id && pane.mode === "TERMINAL" && !pane.isClosed
          );
          return {
            roomId: room.id,
            runningCliCount: runningPanes.length,
            runtimeIds: [...new Set(runningPanes.map((pane) => pane.terminalRuntimeId ?? "cli:codex"))]
          };
        }),
        sampledAt: DEMO_FIXED_AT
      });
      case "panes": return Promise.resolve(paginated(structuredClone(this.fixture.panes.filter((pane) => pane.roomId === roomId && !pane.isClosed))));
      case "turns": {
        const query = args[0] as { roomId?: string } | undefined;
        return Promise.resolve(paginated(structuredClone(this.fixture.turns.filter((turn) => !query?.roomId || turn.roomId === query.roomId))));
      }
      case "events": {
        const query = args[0] as { roomId?: string } | undefined;
        return Promise.resolve(paginated(structuredClone(this.fixture.events.filter((event) => !query?.roomId || event.roomId === query.roomId))));
      }
      case "providers": return Promise.resolve(paginated(structuredClone(this.fixture.providers)));
      case "providerSettings": return Promise.resolve(structuredClone(this.fixture.providerSettings));
      case "updateProviderSettings": {
        const input = args[0] as UpdateProviderSettingsInput;
        Object.assign(this.fixture.providerSettings, input, { updatedAt: DEMO_FIXED_AT });
        return Promise.resolve(structuredClone(this.fixture.providerSettings));
      }
      case "codexCliModeDefaults": return Promise.resolve(structuredClone(this.fixture.codexCliModeDefaults));
      case "updateCodexCliModeDefaults": {
        const input = args[0] as UpdateCodexCliModeDefaultsInput;
        this.fixture.codexCliModeDefaults.defaults[input.mode] = {
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort
        };
        this.fixture.codexCliModeDefaults.defaults.updatedAt = DEMO_FIXED_AT;
        return Promise.resolve(structuredClone(this.fixture.codexCliModeDefaults));
      }
      case "telegramIntegration": return Promise.resolve(structuredClone(this.fixture.telegramIntegration));
      case "createTelegramPairing": {
        const pairingId = "telegram_pairing:demo-local";
        const expiresAt = "2026-07-18T12:10:00.000Z";
        Object.assign(this.fixture.telegramIntegration, {
          connectionStatus: "PAIRING",
          pairingId,
          pairingExpiresAt: expiresAt,
          chatDisplayName: null,
          updatedAt: DEMO_FIXED_AT
        });
        return Promise.resolve(structuredClone({
          integration: this.fixture.telegramIntegration,
          pairing: {
            id: pairingId,
            pairingUrl: "https://t.me/space_demo_bot?start=demoPublicPairing",
            expiresAt,
            statusCode: "PAIRING_PENDING" as const
          }
        }));
      }
      case "checkTelegramPairing": {
        Object.assign(this.fixture.telegramIntegration, {
          connectionStatus: "CONNECTED",
          pairingId: null,
          pairingExpiresAt: null,
          chatDisplayName: "Demo Admin",
          pairedAt: DEMO_FIXED_AT,
          updatedAt: DEMO_FIXED_AT
        });
        return Promise.resolve(structuredClone(this.fixture.telegramIntegration));
      }
      case "sendTelegramTestDelivery": return Promise.resolve(structuredClone(this.fixture.telegramIntegration));
      case "updateTelegramIntegration": {
        const input = args[0] as UpdateTelegramIntegrationInput;
        this.fixture.telegramIntegration.isEnabled = input.isEnabled;
        this.fixture.telegramIntegration.connectionStatus = input.isEnabled ? "CONNECTED" : "DISABLED";
        this.fixture.telegramIntegration.disabledAt = input.isEnabled ? null : DEMO_FIXED_AT;
        this.fixture.telegramIntegration.enabledAt = input.isEnabled ? DEMO_FIXED_AT : this.fixture.telegramIntegration.enabledAt;
        this.fixture.telegramIntegration.updatedAt = DEMO_FIXED_AT;
        return Promise.resolve(structuredClone(this.fixture.telegramIntegration));
      }
      case "disconnectTelegramIntegration": return Promise.resolve(structuredClone(this.fixture.telegramIntegration));
      case "voiceTranscriptionSettings": return Promise.resolve(structuredClone(this.fixture.voiceTranscriptionSettings));
      case "models": return Promise.resolve(paginated(structuredClone(this.fixture.models)));
      case "skills": return Promise.resolve(paginated(structuredClone(this.fixture.skills)));
      case "imports": return Promise.resolve(paginated([]));
      case "admin": return Promise.resolve({ storageWarning: DEMO_WARNING });
      case "mcp": return Promise.resolve({ data: [], gateway: structuredClone(this.fixture.adminDiagnostics.mcpGateway), servers: [], tools: [], pagination: paginated([]).pagination });
      case "latestMcpDiscoverySmoke": return Promise.resolve({ data: structuredClone(this.fixture.adminDiagnostics.mcpDiscoverySmoke) });
      case "runMcpDiscoverySmoke": return Promise.resolve(structuredClone(this.fixture.adminDiagnostics.mcpDiscoverySmoke));
      case "latestMemoryEmbeddingSmoke": return Promise.resolve({ data: structuredClone(this.fixture.adminDiagnostics.memoryEmbeddingSmoke) });
      case "runMemoryEmbeddingSmoke": return Promise.resolve(structuredClone(this.fixture.adminDiagnostics.memoryEmbeddingSmoke));
      case "memoryVectorReadiness": return Promise.resolve({ data: structuredClone(this.fixture.adminDiagnostics.memoryVectorReadiness) });
      case "codexAppServer": return Promise.resolve(structuredClone(this.fixture.adminDiagnostics.codexAppServer));
      case "latestCodexAppServerHandshake": return Promise.resolve({ data: structuredClone(this.fixture.adminDiagnostics.codexAppServerHandshake) });
      case "runCodexAppServerHandshake": return Promise.resolve(structuredClone(this.fixture.adminDiagnostics.codexAppServerHandshake));
      case "latestCodexAppServerTurnSmoke": return Promise.resolve({ data: structuredClone(this.fixture.adminDiagnostics.codexAppServerTurnSmoke) });
      case "runCodexAppServerTurnSmoke": return Promise.resolve(structuredClone(this.fixture.adminDiagnostics.codexAppServerTurnSmoke));
      case "executeMcpTool": {
        const result = structuredClone(this.fixture.adminDiagnostics.mcpToolExecution);
        result.toolId = String((args[0] as { toolId?: string })?.toolId ?? result.toolId);
        return Promise.resolve(result);
      }
      case "storage": return Promise.resolve(structuredClone(this.fixture.storageReadiness));
      case "launchReadiness": return Promise.resolve(structuredClone(this.fixture.launchReadiness));
      case "observability": return Promise.resolve(structuredClone(this.fixture.adminDiagnostics.observability));
      case "worker": return Promise.resolve(structuredClone(this.fixture.adminDiagnostics.worker));
      case "codexEnvironment": return Promise.resolve(structuredClone({
        ...this.fixture.codexEnvironment,
        isCodexEnabled: this.cliRuntimeEnabled.get("cli:codex") !== false
      }));
      case "toolbarUsageAccounts": return Promise.resolve(structuredClone(this.fixture.codexUsageAccounts));
      case "toolbarResetCredits": return Promise.resolve(structuredClone(this.fixture.codexResetCredits));
      case "redeemToolbarResetCredit": {
        const accountId = String(args[0] ?? "");
        const idempotencyKey = String(args[1] ?? "");
        const requestKey = `${accountId}:${idempotencyKey}`;
        const existing = this.resetRedemptions.get(requestKey);
        if (existing) return Promise.resolve(structuredClone(existing));
        const availability = this.fixture.codexResetCredits.data.find((item) => item.accountId === accountId);
        const outcome = availability?.availableCreditCount && availability.availableCreditCount > 0
          ? "RESET" as const
          : "NO_CREDIT" as const;
        if (outcome === "RESET" && availability?.availableCreditCount != null) {
          availability.availableCreditCount -= 1;
          this.fixture.codexResetCredits.checkedAt = DEMO_FIXED_AT;
        }
        const result: CodexResetCreditRedemptionResponse = {
          accountId,
          outcome,
          completedAt: DEMO_FIXED_AT
        };
        this.resetRedemptions.set(requestKey, result);
        return Promise.resolve(structuredClone(result));
      }
      case "toolbarCliSessions": return Promise.resolve(structuredClone(this.fixture.cliSessionStats));
      case "toolbarModelStats": return Promise.resolve(structuredClone(this.fixture.modelStats));
      case "systemAnalyticsOverview": return Promise.resolve(structuredClone({
        ...this.fixture.systemAnalyticsOverview,
        range: args[0] ?? "10m"
      }));
      case "systemAnalyticsModels": return Promise.resolve(structuredClone({
        ...this.fixture.systemAnalyticsModels,
        range: args[0] ?? "10m"
      }));
      case "systemAnalyticsResources": return Promise.resolve(structuredClone({
        ...this.fixture.systemAnalyticsResources,
        range: args[0] ?? "10m"
      }));
      case "systemAnalyticsProcesses": return Promise.resolve(structuredClone(this.fixture.systemAnalyticsProcesses));
      case "systemAnalyticsCliSessions": return Promise.resolve(structuredClone({
        ...this.fixture.systemAnalyticsCliSessions,
        range: args[0] ?? "10m"
      }));
      case "reapToolbarCliSessions": return Promise.resolve(structuredClone(this.fixture.cliSessionReap));
      case "toolbarHostMemory": return Promise.resolve(structuredClone(this.fixture.hostMemoryDetails));
      case "reclaimToolbarMemory": return Promise.resolve(structuredClone(this.fixture.memoryReclaim));
      case "toolbarProviderTargets": return Promise.resolve(structuredClone(this.fixture.providerSwitchTargets));
      case "switchToolbarProvider": return Promise.resolve(structuredClone(this.fixture.providerSwitch));
      case "codexLbSpeedDefaults":
      case "updateCodexLbSpeedDefault": return Promise.resolve(structuredClone(this.fixture.codexLbSpeedDefaults));
      case "previewCodexHistoryPurge": return Promise.resolve(structuredClone(this.fixture.adminDiagnostics.historyPurgePreview));
      case "executeCodexHistoryPurge": return Promise.resolve(structuredClone(this.fixture.adminDiagnostics.historyPurgeResult));
      case "restartCoreServices": return Promise.resolve(structuredClone(this.fixture.adminDiagnostics.serviceRestart));
      case "streamingCatalog": {
        const response: StreamingCatalogResponse = {
          providers: (["YOUTUBE", "TWITCH", "TIKTOK"] as const).map((provider) => ({
            provider,
            status: "UNCONFIGURED",
            clientFilePresent: false,
            clientFileSecure: false,
            code: "DEMO_LOCAL_ONLY",
            message: `${provider} OAuth is intentionally unavailable in the local demo.`,
            scopes: []
          })),
          metrics: streamingMetricDefinitions.map((metric) => ({ ...metric })),
          authorizations: [],
          accounts: [],
          settings: structuredClone(this.streamingSettings)
        };
        return Promise.resolve(response);
      }
      case "updateStreamingOverlaySettings": {
        const input = args[0] as UpdateStreamingOverlaySettingsInput;
        if (input.expectedVersion !== this.streamingSettings.version) {
          throw new SpaceApiError("The demo overlay settings changed.", {
            status: 409,
            code: "STREAMING_SETTINGS_VERSION_CONFLICT"
          });
        }
        this.streamingSettings = {
          version: this.streamingSettings.version + 1,
          tiles: structuredClone(input.tiles),
          customTextEnabled: input.customTextEnabled,
          customText: input.customText,
          updatedAt: DEMO_FIXED_AT,
          updatedBy: "user:demo-admin"
        };
        return Promise.resolve(structuredClone(this.streamingSettings));
      }
      case "streamingOverlaySnapshot": {
        const spaceValues = new Map<string, number>([
          ["space.rooms", this.fixture.rooms.length],
          ["space.active_agents", this.fixture.panes.filter((pane) => pane.mode === "CHAT" && !pane.isClosed).length],
          ["space.active_cli_sessions", this.fixture.panes.filter((pane) => pane.mode === "TERMINAL" && !pane.isClosed).length]
        ]);
        const definitions = new Map(streamingMetricDefinitions.map((metric) => [metric.key, metric]));
        const tiles: StreamingMetricTileSnapshot[] = this.streamingSettings.tiles.map((tile) => {
          const definition = definitions.get(tile.metricKey);
          return {
            metricKey: tile.metricKey,
            accountId: tile.accountId,
            provider: definition?.provider ?? "SPACE",
            label: definition?.label ?? tile.metricKey,
            badge: definition?.provider === "SPACE" ? "Space Demo" : "Demo local",
            value: spaceValues.get(tile.metricKey) ?? null,
            state: definition?.provider === "SPACE" ? "FRESH" : "UNAVAILABLE",
            sampledAt: definition?.provider === "SPACE" ? DEMO_FIXED_AT : null
          };
        });
        const response: StreamingOverlaySnapshot = {
          generatedAt: DEMO_FIXED_AT,
          settingsVersion: this.streamingSettings.version,
          tiles,
          customTextEnabled: this.streamingSettings.customTextEnabled,
          customText: this.streamingSettings.customText,
          botTickerEnabled: this.streamingBotSettings.overlayTickerEnabled && this.streamingBotSettings.enabled,
          botTicker: []
        };
        return Promise.resolve(response);
      }
      case "startStreamingOAuth":
      case "verifyStreamingAccount":
      case "removeStreamingAccount":
      case "disconnectStreamingAuthorization":
        throw new SpaceApiError(DEMO_LOCAL_REPLY, { status: 409, code: "DEMO_LOCAL_ONLY" });
      case "streamingBotSettings":
      case "updateStreamingBotSettings":
      case "pauseStreamingBot":
      case "resumeStreamingBot":
      case "streamingBotStatus":
      case "streamingBotActivity":
      case "testStreamingBot":
      case "clearStreamingBotMemory":
      case "searchStreamingBotMemory":
        return this.invokeStreamingBot(String(method), args);
      case "cliRuntimeRestart": {
        const runtimeId = String(args[0] ?? "cli:opencode");
        return Promise.resolve({
          runtimeId,
          requestedSessionIds: ["demo-session-1"],
          restartedSessionIds: ["demo-session-1"],
          replacementSessionIds: ["demo-session-1-r"],
          failedSessionIds: []
        });
      }
      case "cliRuntimeRestartAll": return Promise.resolve({
        requestedRuntimes: cliToggleRuntimeIds,
        restartedSessionIds: ["demo-session-1", "demo-session-2"],
        replacementSessionIds: ["demo-session-1-r", "demo-session-2-r"],
        failedSessionIds: [],
        checkedAt: DEMO_FIXED_AT
      });
      case "listCliMaintenanceRuns":
      case "listReleaseRuns": return Promise.resolve({ data: [] });
      case "getCliMaintenanceReplay": {
        const runId = String(args[0] ?? this.nextId("admin_run"));
        return Promise.resolve({
          run: {
            id: runId,
            operationType: "CLI_MAINTENANCE_REPAIR",
            status: "SUCCEEDED",
            actorUserId: "user:demo-admin",
            summary: DEMO_LOCAL_REPLY,
            result: {},
            createdAt: DEMO_FIXED_AT,
            startedAt: DEMO_FIXED_AT,
            finishedAt: DEMO_FIXED_AT,
            updatedAt: DEMO_FIXED_AT
          },
          events: [],
          authHandoffs: []
        });
      }
      case "openCliMaintenanceStream": return null;
      case "cliMaintenanceExportUrl": return "#demo-cli-maintenance-export";
      case "openCliMaintenanceRecovery": return Promise.resolve({
        status: "NOOP",
        room: null,
        handoffs: [],
        loginPanes: []
      });
      case "startCliMaintenance": {
        const mode = (args[0] as { mode?: "CHECK" | "UPDATE" | "REPAIR" })?.mode ?? "REPAIR";
        return Promise.resolve({
          id: this.nextId("admin_run"),
          operationType: mode === "CHECK"
            ? "CLI_MAINTENANCE_CHECK"
            : mode === "REPAIR"
              ? "CLI_MAINTENANCE_REPAIR"
              : "CLI_MAINTENANCE_UPDATE",
          status: "QUEUED",
          actorUserId: "user:demo-admin",
          summary: DEMO_LOCAL_REPLY,
          result: {},
          createdAt: DEMO_FIXED_AT,
          startedAt: null,
          finishedAt: null,
          updatedAt: DEMO_FIXED_AT
        });
      }
      case "createReleasePreview": return Promise.resolve({
        id: this.nextId("release_preview"),
        tag: "v2026.07.23.1",
        notes: String((args[0] as { notes?: string })?.notes ?? "- Deterministic Space demo release"),
        sourceCommit: "42aac2eac274e2ab0512071615647073582d43a8",
        previousTag: "v2026.07.22.1",
        remoteMainCommits: {
          gitea: "15aac2eac274e2ab0512071615647073582d43a1",
          github: "15aac2eac274e2ab0512071615647073582d43a1"
        },
        expiresAt: "2026-07-23T09:00:00.000Z",
        createdAt: DEMO_FIXED_AT
      });
      case "publishRelease": {
        const input = args[0] as { previewId?: string; tag?: string; notes?: string };
        return Promise.resolve({
          id: this.nextId("admin_run"),
          operationType: "SPACE_RELEASE",
          status: "QUEUED",
          actorUserId: "user:demo-admin",
          summary: DEMO_LOCAL_REPLY,
          result: {
            previewId: input.previewId,
            tag: input.tag,
            notes: input.notes,
            sourceCommit: "42aac2eac274e2ab0512071615647073582d43a8"
          },
          createdAt: DEMO_FIXED_AT,
          startedAt: null,
          finishedAt: null,
          updatedAt: DEMO_FIXED_AT
        });
      }
      case "listSourceControlConnections": return Promise.resolve({
        data: (["gitea", "github"] as const).map((provider) => ({
          provider,
          repositoryOwner: "spaceapp-owner",
          repositoryName: "spaceapp",
          accountLogin: null,
          status: "DISCONNECTED",
          secretConfigured: false,
          lastVerifiedAt: null,
          lastVerificationCode: "NOT_VERIFIED",
          updatedAt: DEMO_FIXED_AT
        }))
      });
      case "replaceSourceControlConnection":
      case "verifySourceControlConnection": {
        const provider = String(args[0]) === "gitea" ? "gitea" : "github";
        return Promise.resolve({
          provider,
          repositoryOwner: "spaceapp-owner",
          repositoryName: "spaceapp",
          accountLogin: "demo-admin",
          status: "CONNECTED",
          secretConfigured: true,
          lastVerifiedAt: DEMO_FIXED_AT,
          lastVerificationCode: "VERIFIED",
          updatedAt: DEMO_FIXED_AT
        });
      }
      case "disconnectSourceControlConnection": {
        const provider = String(args[0]) === "gitea" ? "gitea" : "github";
        return Promise.resolve({
          provider,
          repositoryOwner: "spaceapp-owner",
          repositoryName: "spaceapp",
          accountLogin: null,
          status: "DISCONNECTED",
          secretConfigured: false,
          lastVerifiedAt: null,
          lastVerificationCode: "NOT_VERIFIED",
          updatedAt: DEMO_FIXED_AT
        });
      }
      case "memoryGraph": {
        const query = (args[0] ?? {}) as DemoMemoryGraphQuery;
        const graph = this.memoryGraph(query);
        const page = requestedPage(graph.nodes, query);
        const visibleIds = new Set(page.data.map((node) => node.id));
        return Promise.resolve({
          data: {
            ...graph,
            nodes: page.data,
            edges: graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
          },
          pagination: page.pagination
        });
      }
      case "memoryGraphOverview": {
        const graph = this.memoryGraph((args[0] ?? {}) as DemoMemoryGraphQuery);
        return Promise.resolve({ data: { ...graph, totalMatchingNodes: graph.nodes.length, totalMatchingEdges: graph.edges.length, truncated: false } });
      }
      case "memoryGraphIssues": {
        const query = (args[0] ?? {}) as { type?: string; severity?: string; status?: string; recordId?: string; page?: number; pageSize?: number };
        const issues = this.fixture.memoryWorkspace.issues.filter((issue) =>
          (!query.type || issue.type === query.type) &&
          (!query.severity || issue.severity === query.severity) &&
          (!query.status || issue.status === query.status) &&
          (!query.recordId || issue.recordId === query.recordId)
        );
        return Promise.resolve(structuredClone(requestedPage(issues, query)));
      }
      case "updateMemoryGraphIssue": {
        const issue = this.fixture.memoryWorkspace.issues.find((candidate) => candidate.id === roomId);
        if (!issue) throw new SpaceApiError("Memory issue not found.", { status: 404, code: "NOT_FOUND" });
        return Promise.resolve(structuredClone({ ...issue, statusReason: DEMO_LOCAL_REPLY }));
      }
      case "createMemoryConsolidation": {
        const command = structuredClone(this.fixture.memoryWorkspace.maintenanceCommand);
        command.run.mode = ((args[0] as { mode?: "AUDIT" | "REPAIR" })?.mode ?? "AUDIT");
        return Promise.resolve(command);
      }
      case "memoryConsolidation": return Promise.resolve(structuredClone(this.fixture.memoryWorkspace.maintenanceDetail));
      case "memoryGraphNode": {
        const detail = this.fixture.memoryWorkspace.nodeDetails[roomId ?? ""];
        if (!detail) throw new SpaceApiError("Memory node not found.", { status: 404, code: "NOT_FOUND" });
        return Promise.resolve(structuredClone(detail));
      }
      case "memoryChangeSets": {
        const query = (args[0] ?? {}) as { kind?: string; status?: string; sourcePath?: string; recordId?: string; issueId?: string; page?: number; pageSize?: number };
        const summaries = this.fixture.memoryWorkspace.changeSets
          .filter((changeSet) =>
            (!query.kind || changeSet.kind === query.kind) &&
            (!query.status || changeSet.status === query.status) &&
            (!query.sourcePath || changeSet.sourcePath === query.sourcePath) &&
            (!query.recordId || changeSet.recordIds.includes(query.recordId)) &&
            (!query.issueId || changeSet.resolvesIssueIds.includes(query.issueId))
          )
          .map(memoryChangeSetSummary);
        const page = requestedPage(summaries, query);
        return Promise.resolve({
          data: structuredClone(page.data),
          pagination: { page: page.pagination.page, pageSize: page.pagination.pageSize, hasNext: page.pagination.page < page.pagination.totalPages },
          mutationsEnabled: false
        });
      }
      case "memoryChangeSet": {
        const changeSet = this.fixture.memoryWorkspace.changeSets.find((candidate) => candidate.id === roomId);
        if (!changeSet) throw new SpaceApiError("Memory change set not found.", { status: 404, code: "NOT_FOUND" });
        return Promise.resolve(structuredClone(changeSet));
      }
      case "createMemoryNodeChangeSet": {
        const input = args[1] as { kind?: "EDIT" | "ARCHIVE" | "MERGE" };
        const changeSet = structuredClone(this.fixture.memoryWorkspace.changeSets[0]!);
        changeSet.kind = input.kind ?? changeSet.kind;
        changeSet.status = "PROPOSED";
        changeSet.statusReason = DEMO_LOCAL_REPLY;
        return Promise.resolve(memoryChangeSetSummary(changeSet));
      }
      case "reviewMemoryChangeSet": {
        const changeSet = this.fixture.memoryWorkspace.changeSets.find((candidate) => candidate.id === roomId);
        if (!changeSet) throw new SpaceApiError("Memory change set not found.", { status: 404, code: "NOT_FOUND" });
        return Promise.resolve(memoryChangeSetSummary(structuredClone(changeSet)));
      }
      case "executeMemoryChangeSet":
      case "reconcileMemoryChangeSet": return Promise.resolve({ status: "ALREADY_SCHEDULED", workflowId: "memory-demo:no-op", runId: null });
      case "codexHistory": {
        const detail = this.codexThread("thread:demo-public-launch");
        return Promise.resolve({
          data: [detail.thread],
          totalItems: 1,
          visibleItems: 1,
          pagination: paginated([detail.thread]).pagination,
          checkedAt: DEMO_FIXED_AT
        });
      }
      case "codexThread": return Promise.resolve(this.codexThread(roomId ?? "thread:demo-public-launch"));
      case "swarm": return Promise.resolve(structuredClone(this.fixture.swarm[roomId ?? this.fixture.rooms[0]!.id]));
      case "agentSession":
      case "createAgentSession":
      case "interruptAgent":
      case "updateAgentGoal":
      case "clearAgentGoal": return Promise.resolve(this.agentSession(roomId ?? "pane:demo-chat"));
      case "updateAgentSettings": {
        const paneId = roomId ?? "pane:demo-chat";
        const input = args[1] as AgentPaneSettingsInput;
        if (input.selectedToolIds !== undefined) {
          this.agentSelectedToolIds.set(paneId, [...(input.selectedToolIds ?? [])]);
        }
        return Promise.resolve(this.agentSession(paneId));
      }
      case "sendAgentMessage": {
        const paneId = roomId ?? "pane:demo-chat";
        const content = String(args[1] ?? "");
        const messages = this.agentSession(paneId).messages;
        messages.push(
          { id: this.nextId("agent_message"), role: "user", content, status: "COMPLETED", createdAt: DEMO_FIXED_AT },
          { id: this.nextId("agent_message"), role: "assistant", content: DEMO_LOCAL_REPLY, status: "COMPLETED", createdAt: DEMO_FIXED_AT }
        );
        this.agentMessages.set(paneId, messages);
        return Promise.resolve(this.agentSession(paneId));
      }
      case "roomAgent":
      case "sendRoomAgentMessage":
      case "stopRoomAgent":
      case "controlRoomAgent":
      case "clearRoomAgentTranscript": return Promise.resolve(this.roomAgent(roomId ?? this.fixture.rooms[0]!.id));
      case "cliRuntimes": return Promise.resolve(this.cliRuntimeRegistry());
      case "cliRuntimesSnapshot": return this.cliRuntimeRegistry();
      case "invalidateCliRuntimes":
      case "warmCliRuntimes":
      case "invalidateCliRuntimeSettings":
      case "resetCliRuntimeSettingsCache":
      case "warmCliRuntimeSettings": return undefined;
      case "cliRuntimeSettingsSnapshot":
      case "cliRuntimeSettings": return {
        settings: cliToggleRuntimeIds.map((runtimeId) => ({
          runtimeId,
          enabled: this.cliRuntimeEnabled.get(runtimeId) !== false,
          vpnEnabled: false,
          updatedAt: DEMO_FIXED_AT,
          updatedBy: "user:demo-admin"
        })),
        runtimes: CLI_RUNTIME_PRESENTATIONS.map(({ id, displayName }) => this.demoCliRuntime(id, displayName)),
        vpnSupported: true,
        vpnConnection: {
          profileConfigured: false,
          status: "NOT_CONFIGURED",
          endpoint: null,
          dnsServers: [],
          profileFingerprint: null,
          relay: null,
          egressIpv4: null,
          egressIpv6: null,
          lastHandshakeAt: null,
          lastVerifiedAt: null,
          lastVerificationCode: "NOT_CONFIGURED",
          updatedAt: DEMO_FIXED_AT
        },
        vpnApplications: cliToggleRuntimeIds.map((runtimeId) => ({
          runtimeId,
          effectiveMode: "DIRECT",
          appliedSessionIds: [],
          restartRequiredSessionIds: []
        })),
        checkedAt: DEMO_FIXED_AT
      };
      case "cliVpnRoutingStatus": return Promise.resolve({
        vpnSupported: true,
        connectionStatus: "NOT_CONFIGURED",
        egressIpv4: null,
        egressIpv6: null,
        relay: null,
        applications: cliToggleRuntimeIds.map((runtimeId) => ({
          runtimeId,
          effectiveMode: "DIRECT",
          appliedSessionIds: [],
          restartRequiredSessionIds: []
        })),
        checkedAt: DEMO_FIXED_AT
      });
      case "restartCliRuntimeVpnSessions": {
        const runtimeId = String(args[0]) as CliToggleRuntimeId;
        return Promise.resolve({
          runtimeId,
          requestedSessionIds: [],
          restartedSessionIds: [],
          replacementSessionIds: [],
          failedSessionIds: [],
          connection: {
            profileConfigured: false,
            status: "NOT_CONFIGURED",
            endpoint: null,
            dnsServers: [],
            profileFingerprint: null,
            relay: null,
            egressIpv4: null,
            egressIpv6: null,
            lastHandshakeAt: null,
            lastVerifiedAt: null,
            lastVerificationCode: "NOT_CONFIGURED",
            updatedAt: DEMO_FIXED_AT
          },
          application: {
            effectiveMode: "DIRECT",
            appliedSessionIds: [],
            restartRequiredSessionIds: []
          }
        });
      }
      case "cliRuntimeDisablePreview": {
        const runtimeId = String(args[0]) as CliToggleRuntimeId;
        const codexPanes = runtimeId === "cli:codex"
          ? this.fixture.panes.filter((pane) =>
              !pane.isClosed
              && pane.mode === "TERMINAL"
              && (pane.terminalRuntimeId === "codex" || pane.terminalRuntimeId === "cli:codex")
            )
          : [];
        const chatPanes = runtimeId === "cli:codex"
          ? this.fixture.panes.filter((pane) => !pane.isClosed && pane.mode === "CHAT")
          : [];
        return Promise.resolve({
          runtimeId,
          activeSessionCount: codexPanes.length,
          matchingProcessCount: 0,
          openPaneCount: codexPanes.length,
          activeChatRunCount: 0,
          openChatPaneCount: chatPanes.length,
          activeRoomAgentMissionCount: 0,
          confirmationToken: `demo_disable_confirmation_${runtimeId.replace(/[^a-z0-9]/gi, "_")}`,
          expiresAt: "2026-07-22T23:59:59.000Z"
        });
      }
      case "updateCliRuntimeSetting": {
        const runtimeId = String(args[0]) as CliToggleRuntimeId;
        const input = args[1] as { enabled: boolean };
        const codexPanes = runtimeId === "cli:codex" && !input.enabled
          ? this.fixture.panes.filter((pane) =>
              !pane.isClosed
              && pane.mode === "TERMINAL"
              && (pane.terminalRuntimeId === "codex" || pane.terminalRuntimeId === "cli:codex")
            )
          : [];
        const chatPanes = runtimeId === "cli:codex" && !input.enabled
          ? this.fixture.panes.filter((pane) => !pane.isClosed && pane.mode === "CHAT")
          : [];
        for (const pane of [...codexPanes, ...chatPanes]) {
          pane.isClosed = true;
          pane.status = "CLOSED";
          pane.updatedAt = DEMO_FIXED_AT;
        }
        this.cliRuntimeEnabled.set(runtimeId, input.enabled);
        return Promise.resolve({
          setting: {
            runtimeId,
            enabled: input.enabled,
            vpnEnabled: false,
            updatedAt: DEMO_FIXED_AT,
            updatedBy: "user:demo-admin"
          },
          cleanup: input.enabled ? null : {
            requestedActiveSessionCount: codexPanes.length,
            requestedOpenPaneCount: codexPanes.length,
            requestedActiveChatRunCount: 0,
            requestedOpenChatPaneCount: chatPanes.length,
            requestedRoomAgentMissionCount: 0,
            terminatedSessionIds: codexPanes.map((pane) => `cli_session:${pane.id}`),
            interruptedChatPaneIds: [],
            stoppedRoomAgentMissionIds: [],
            closedPaneIds: codexPanes.map((pane) => pane.id),
            closedChatPaneIds: chatPanes.map((pane) => pane.id),
            killedProcessCount: 0,
            remainingProcessCount: 0,
            processSweepFailed: false,
            unresolvedSessionIds: [],
            unresolvedChatPaneIds: [],
            unresolvedRoomAgentMissionIds: [],
            unresolvedPaneIds: []
          }
        });
      }
      case "cliLogin": {
        const targetRoomId = String(args[0]);
        const runtimeId = String(args[1]);
        const pane = this.addPane(targetRoomId, cliRuntimeLabel(runtimeId) ?? runtimeId, "TERMINAL", {
          cwd: "/etc",
          terminalRuntimeId: runtimeId
        });
        return Promise.resolve({ pane, session: this.cliSession(pane.id), reused: false });
      }
      case "activeCliSession":
      case "createCliSession":
      case "interruptCliSession": return Promise.resolve(this.cliSession(roomId ?? "pane:demo-codex"));
      case "abortCliTurn": return Promise.resolve({ ok: true, isTurnActive: false });
      case "reportCliClientEvent": return Promise.resolve({ accepted: true });
      case "setCliTerminalControlLease": return undefined;
      case "cliModelSettingsStatus": return Promise.resolve({ status: "AVAILABLE", settings: { sessionId: `cli_session:${roomId}`, threadId: null, current: { modelId: "gpt-5.6-sol", reasoningEffort: "high" }, models: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: ["medium", "high", "xhigh"] }], controlMode: "DIRECT", isTurnActive: false } });
      case "updateCliModelSettings": return Promise.resolve({ current: { modelId: String((args[1] as { modelId?: string })?.modelId ?? "gpt-5.6-sol"), reasoningEffort: String((args[1] as { reasoningEffort?: string })?.reasoningEffort ?? "high") }, message: DEMO_LOCAL_REPLY });
      case "cliTurnActivity": return Promise.resolve({ marker: String(args[1]), status: "COMPLETED", turnId: null });
      case "cliTerminalWebSocketUrl": {
        const ticket = args[0] as { paneId: string; sessionId: string };
        return `demo-terminal://local/${encodeURIComponent(ticket.paneId)}?sessionId=${encodeURIComponent(ticket.sessionId)}`;
      }
      case "browserStatus": return Promise.resolve({ enabled: true, statusReason: "Local canvas fixture; no browser host is connected.", defaultUrl: "https://demo.invalid/space-launch", checkedAt: DEMO_FIXED_AT });
      case "browserSession":
      case "startBrowserSession":
      case "updateBrowserSession":
      case "navigateBrowser":
      case "setBrowserViewport":
      case "browserInput": return Promise.resolve(this.browserSession(roomId ?? "pane:demo-browser"));
      case "browserFrame": return Promise.resolve(this.browserSession(roomId ?? "pane:demo-browser").frame);
      case "browserPages": {
        const session = this.browserSession(roomId ?? "pane:demo-browser").session;
        return Promise.resolve({ sessionId: session.sessionId, pages: session.pages, activePageId: session.activePageId });
      }
      case "browserBookmarks": return Promise.resolve({ sessionId: `browser_session:${roomId}`, paneId: roomId, roomId: this.fixture.rooms[0]!.id, bookmarks: [] });
      case "browserFrameWebSocketUrl":
      case "browserStreamWebSocketUrl": return null;
      case "browserBookmarksExportUrl": return "data:application/json,%7B%22bookmarks%22%3A%5B%5D%7D";
      case "reviewState": return Promise.resolve({ decisions: [], checks: [], diffs: [], artifacts: [], gateStatus: "PASS", statusReason: "Demo review gate passed locally." });
      case "artifacts": {
        const query = (args[0] ?? {}) as {
          roomId?: string;
          paneId?: string;
          kind?: Artifact["kind"];
          collection?: "ROOM_MEDIA" | "AGENT_FILES";
          page?: number;
          pageSize?: number;
          sortOrder?: "asc" | "desc";
        };
        const artifacts = this.fixture.artifacts
          .filter((artifact) =>
            (query.roomId === undefined || artifact.roomId === query.roomId) &&
            (query.paneId === undefined || artifact.paneId === query.paneId) &&
            (query.kind === undefined || artifact.kind === query.kind) &&
            (query.collection !== "AGENT_FILES" || artifact.storageUri.startsWith("space-artifact://agent-files/")) &&
            (query.collection !== "ROOM_MEDIA" || !artifact.storageUri.startsWith("space-artifact://agent-files/"))
          )
          .sort((left, right) => {
            const direction = query.sortOrder === "asc" ? 1 : -1;
            return direction * (left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
          });
        return Promise.resolve(structuredClone(requestedPage(artifacts, query)));
      }
      case "deleteArtifact": return Promise.resolve({ ok: true as const, artifactId: roomId! });
      case "deleteRoomMedia": return Promise.resolve({
        ok: true,
        roomId: roomId!,
        matchedCount: 0,
        deletedCount: 0,
        failedCount: 0,
        failedArtifactIds: []
      });
      case "deleteRoomAgentFiles": return Promise.resolve({
        ok: true,
        roomId: roomId!,
        matchedCount: 0,
        deletedCount: 0,
        failedCount: 0,
        failedArtifactIds: []
      });
      case "links": {
        const query = (args[0] ?? {}) as { q?: string; isQuick?: boolean; page?: number; pageSize?: number };
        const needle = query.q?.trim().toLowerCase();
        const links = this.fixture.links.filter((link) =>
          (query.isQuick === undefined || link.isQuick === query.isQuick) &&
          (!needle || [link.title, link.description, link.url].some((value) => value.toLowerCase().includes(needle)))
        );
        return Promise.resolve(structuredClone(requestedPage(links, query)));
      }
      case "createLink": {
        const input = args[0] as CreateUserLinkRequest;
        const url = canonicalizeUserLinkUrl(input.url);
        const openMode = input.openMode ?? "EMBEDDED";
        if (url.startsWith("http:") && openMode !== "NEW_TAB") {
          throw new SpaceApiError("HTTP links can only open in a new tab.", { status: 400, code: "INVALID_LINK" });
        }
        const link: UserLink = {
          id: this.nextId("link"),
          title: input.title.trim(),
          description: input.description?.trim() ?? "",
          url,
          openMode,
          category: input.category ?? "GENERAL",
          isQuick: input.isQuick ?? false,
          sortOrder: this.fixture.links.length,
          createdAt: DEMO_FIXED_AT,
          updatedAt: DEMO_FIXED_AT
        };
        this.fixture.links.push(link);
        return Promise.resolve(structuredClone(link));
      }
      case "updateLink": {
        const link = this.fixture.links.find((candidate) => candidate.id === roomId);
        if (!link) throw new SpaceApiError("Link not found.", { status: 404, code: "NOT_FOUND" });
        const input = args[1] as UpdateUserLinkRequest;
        const url = input.url ? canonicalizeUserLinkUrl(input.url) : link.url;
        const openMode = input.openMode ?? link.openMode;
        if (url.startsWith("http:") && openMode !== "NEW_TAB") {
          throw new SpaceApiError("HTTP links can only open in a new tab.", { status: 400, code: "INVALID_LINK" });
        }
        Object.assign(link, input, { url, openMode, updatedAt: DEMO_FIXED_AT });
        return Promise.resolve(structuredClone(link));
      }
      case "deleteLink": return Promise.resolve({ id: roomId!, deleted: true as const });
      case "clipboardItems": {
        const query = (args[0] ?? {}) as { q?: string; source?: ClipboardItem["source"]; includeCompleted?: boolean; page?: number; pageSize?: number };
        const needle = query.q?.trim().toLowerCase();
        const items = this.fixture.clipboardItems.filter((item) =>
          (query.source === undefined || item.source === query.source) &&
          (query.includeCompleted !== false || !item.isCompleted) &&
          (!needle || item.text.toLowerCase().includes(needle))
        );
        return Promise.resolve(structuredClone(requestedPage(items, query)));
      }
      case "createClipboardItem": {
        const input = args[0] as CreateClipboardItemRequest;
        const item: ClipboardItem = {
          id: this.nextId("clipboard"),
          text: input.text,
          source: input.source,
          title: null,
          isCompleted: false,
          roomId: input.roomId ?? null,
          paneId: input.paneId ?? null,
          paneTitle: input.paneTitle ?? null,
          occurrenceCount: 1,
          characterCount: Array.from(input.text).length,
          createdAt: DEMO_FIXED_AT,
          lastUsedAt: DEMO_FIXED_AT
        };
        this.fixture.clipboardItems.unshift(item);
        return Promise.resolve(structuredClone(item));
      }
      case "setClipboardItemCompleted": {
        const item = this.fixture.clipboardItems.find((candidate) => candidate.id === roomId);
        if (!item) throw new SpaceApiError("Clipboard item not found.", { status: 404, code: "NOT_FOUND" });
        item.isCompleted = args[1] as boolean;
        return Promise.resolve(structuredClone(item));
      }
      case "deleteClipboardItem": return Promise.resolve({ id: roomId!, deleted: true as const });
      case "clearClipboardItems": return Promise.resolve({ deletedCount: 0 });
      case "taskItems": {
        const query = (args[0] ?? {}) as { q?: string; status?: TaskItem["status"]; page?: number; pageSize?: number };
        const needle = query.q?.trim().toLowerCase();
        const items = this.fixture.taskItems.filter((item) =>
          (query.status === undefined || item.status === query.status) &&
          (!needle || item.title.toLowerCase().includes(needle) || item.objective.toLowerCase().includes(needle))
        );
        return Promise.resolve(structuredClone(requestedPage(items, query)));
      }
      case "createTaskItem": {
        const input = args[0] as CreateTaskItemRequest;
        const item: TaskItem = {
          id: this.nextId("task"),
          title: input.title,
          objective: input.objective,
          status: input.status ?? "OPEN",
          source: "MANUAL",
          roomId: input.roomId ?? null,
          paneId: input.paneId ?? null,
          paneTitle: input.paneTitle ?? null,
          occurrenceCount: 1,
          characterCount: Array.from(input.objective).length,
          createdAt: DEMO_FIXED_AT,
          lastUsedAt: DEMO_FIXED_AT
        };
        this.fixture.taskItems.unshift(item);
        return Promise.resolve(structuredClone(item));
      }
      case "updateTaskItem": {
        const task = this.fixture.taskItems.find((candidate) => candidate.id === roomId);
        if (!task) throw new SpaceApiError("Task not found.", { status: 404, code: "NOT_FOUND" });
        Object.assign(task, args[1], {
          characterCount: "objective" in (args[1] as { objective?: string })
            ? Array.from((args[1] as { objective: string }).objective).length
            : task.characterCount,
          lastUsedAt: DEMO_FIXED_AT
        });
        return Promise.resolve(structuredClone(task));
      }
      case "deleteTaskItem": return Promise.resolve({ id: roomId!, deleted: true as const });
      case "clearTaskItems": return Promise.resolve({ deletedCount: 0 });
      case "createRoom": {
        const name = String(args[0] ?? "Demo room").trim() || "Demo room";
        const initialPaneCount = Math.min(16, Math.max(0, Number(args[1] ?? 4)));
        const id = this.nextId("room");
        const room = { ...this.fixture.rooms[0]!, id, name, order: this.fixture.rooms.length, paneLayoutColumns: null, traceId: this.nextId("trace") };
        this.fixture.rooms.push(room);
        for (let index = 0; index < initialPaneCount; index += 1) this.addPane(id, `Agent ${index + 1}`, "CHAT", {});
        return Promise.resolve(structuredClone(room));
      }
      case "reorderRooms": {
        const ids = args[0] as string[];
        this.fixture.rooms.sort((left, right) => ids.indexOf(left.id) - ids.indexOf(right.id));
        this.fixture.rooms.forEach((room, order) => { room.order = order; });
        return Promise.resolve(structuredClone(this.fixture.rooms));
      }
      case "updateRoom": {
        const room = this.fixture.rooms.find((candidate) => candidate.id === roomId);
        if (!room) throw new SpaceApiError("Room not found.", { status: 404, code: "NOT_FOUND" });
        Object.assign(room, args[1], { updatedAt: DEMO_FIXED_AT });
        return Promise.resolve(structuredClone(room));
      }
      case "updateRoomPaneLayout": {
        const room = this.fixture.rooms.find((candidate) => candidate.id === roomId)!;
        room.paneLayoutColumns = (args[1] as { paneLayoutColumns: Room["paneLayoutColumns"] }).paneLayoutColumns;
        const panes = this.fixture.panes.filter((pane) => pane.roomId === roomId);
        return Promise.resolve({ room: structuredClone(room), panes: structuredClone(panes) });
      }
      case "deleteRoom": {
        this.fixture.rooms = this.fixture.rooms.filter((room) => room.id !== roomId);
        this.fixture.panes = this.fixture.panes.filter((pane) => pane.roomId !== roomId);
        return Promise.resolve({ ok: true, roomId });
      }
      case "createPane": return Promise.resolve(this.addPane(String(args[0]), String(args[1]), args[2] as Pane["mode"], (args[3] ?? {}) as Partial<Pane>));
      case "createRoomPanes": {
        const targetRoomId = String(args[0]);
        const input = args[1] as CreateRoomPanesRequest;
        const room = this.fixture.rooms.find((candidate) => candidate.id === targetRoomId);
        if (!room) throw new SpaceApiError("Room not found.", { status: 404, code: "NOT_FOUND" });
        const existingCount = this.fixture.panes.filter((pane) => pane.roomId === targetRoomId && !pane.isClosed).length;
        if (existingCount + input.panes.length > room.paneCap) {
          throw new SpaceApiError("Room pane cap reached.", { status: 409, code: "PANE_CAP_REACHED" });
        }
        for (const item of input.panes) {
          if (item.mode === "TERMINAL" && !cliRuntimeLabel(item.terminalRuntimeId)) {
            throw new SpaceApiError("CLI runtime unavailable.", { status: 409, code: "CONFLICT" });
          }
        }
        const data = input.panes.map((item, index) => {
          const finalNumber = existingCount + index + 1;
          if (item.mode === "CHAT") {
            return this.addPane(targetRoomId, `Chat ${finalNumber}`, "CHAT", {});
          }
          const runtimeName = cliRuntimeLabel(item.terminalRuntimeId)!;
          return this.addPane(targetRoomId, `${runtimeName} ${finalNumber}`, "TERMINAL", {
            cwd: "/etc",
            terminalRuntimeId: item.terminalRuntimeId
          });
        });
        return Promise.resolve({ roomId: targetRoomId, data });
      }
      case "updatePane": {
        const pane = this.fixture.panes.find((candidate) => candidate.id === roomId);
        if (!pane) throw new SpaceApiError("Pane not found.", { status: 404, code: "NOT_FOUND" });
        Object.assign(pane, args[1], { updatedAt: DEMO_FIXED_AT });
        return Promise.resolve(structuredClone(pane));
      }
      case "movePane": {
        const pane = this.fixture.panes.find((candidate) => candidate.id === roomId)!;
        pane.roomId = String(args[1]);
        pane.order = this.fixture.panes.filter((candidate) => candidate.roomId === pane.roomId).length - 1;
        return Promise.resolve({ pane: structuredClone(pane), sourceRoomId: roomId, targetRoomId: pane.roomId });
      }
      case "closePane": {
        const pane = this.fixture.panes.find((candidate) => candidate.id === roomId)!;
        pane.isClosed = true;
        pane.status = "CLOSED";
        return Promise.resolve(structuredClone(pane));
      }
      case "artifactFileUrl": return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='450'%3E%3Crect width='100%25' height='100%25' fill='%23101413'/%3E%3Ctext x='50%25' y='50%25' fill='%2371c3b3' text-anchor='middle'%3ESpace demo fixture%3C/text%3E%3C/svg%3E";
      case "agentFilePreviewUrl": return "data:text/plain,Agent%20Files%20preview";
      case "agentFileDownloadUrl": return "data:text/plain,Agent%20Files%20download";
      case "eventStreamUrl": return "demo://events";
      case "listCliAccountProfiles": return Promise.resolve({
        profiles: [{
          runtimeId: String(args[0] ?? "cli:gemini"),
          profileId: "main",
          displayName: "Main account",
          createdAt: DEMO_FIXED_AT,
          updatedAt: DEMO_FIXED_AT,
          updatedBy: null
        }]
      });
      default: return Promise.resolve(this.fallback(method));
    }
  }

  private addPane(roomId: string, title: string, mode: Pane["mode"], options: Partial<Pane>): Pane {
    const room = this.fixture.rooms.find((candidate) => candidate.id === roomId);
    if (!room) throw new SpaceApiError("Room not found.", { status: 404, code: "NOT_FOUND" });
    const roomPanes = this.fixture.panes.filter((pane) => pane.roomId === roomId && !pane.isClosed);
    if (roomPanes.length >= room.paneCap) throw new SpaceApiError("Room pane cap reached.", { status: 409, code: "PANE_CAP_REACHED" });
    const pane: Pane = {
      id: this.nextId("pane"), roomId, title, titleSource: "auto", mode, status: "IDLE", providerId: null, modelId: null,
      terminalRuntimeId: options.terminalRuntimeId ?? (mode === "TERMINAL" ? "codex" : null), reasoningEffort: "high",
      cwd: options.cwd ?? (mode === "TERMINAL" ? "/workspace/space-demo" : null), order: roomPanes.length,
      columnSpan: 1, isMaximized: false, isMinimized: false, isClosed: false,
      split: options.split ?? { parentId: null, direction: null, size: null }, categoryColor: null, createdAt: DEMO_FIXED_AT, updatedAt: DEMO_FIXED_AT
    };
    this.fixture.panes.push(pane);
    return structuredClone(pane);
  }

  private startSetupCheckRun(
    connectionIds: string[],
    scope: SetupConnectionCheckRun["scope"]
  ): SetupConnectionCheckRun {
    for (const connectionId of connectionIds) {
      if (!CLI_RUNTIME_PRESENTATIONS.some((presentation) => presentation.id === connectionId)) {
        throw new SpaceApiError("Setup connection not found.", {
          status: 404,
          code: "NOT_FOUND"
        });
      }
    }
    const active = [...this.setupCheckRuns.values()].find(({ run }) =>
      run.status === "RUNNING" &&
      (scope === "ALL"
        ? run.scope === "ALL"
        : run.connectionIds.includes(connectionIds[0]!))
    );
    if (active) return structuredClone(active.run);

    const startedAt = new Date().toISOString();
    const run: SetupConnectionCheckRun = {
      id: this.nextId("setup_check_run"),
      scope,
      connectionIds,
      status: "RUNNING",
      totalCount: connectionIds.length,
      completedCount: 0,
      createdAt: startedAt,
      updatedAt: startedAt,
      finishedAt: null
    };
    const state: DemoSetupCheckRunState = {
      run,
      events: [],
      nextConnectionIndex: 0
    };
    this.setupCheckRuns.set(run.id, state);
    for (const connectionId of connectionIds) {
      this.appendSetupCheckEvent(state, connectionId, "Detecting CLI");
    }
    return structuredClone(run);
  }

  private setupCheckReplay(
    runId: string,
    afterSequence: number
  ): SetupConnectionCheckReplay {
    const state = this.setupCheckRuns.get(runId);
    if (!state) {
      throw new SpaceApiError("Setup connection check run not found.", {
        status: 404,
        code: "NOT_FOUND"
      });
    }
    this.advanceSetupCheckRun(state);
    return structuredClone({
      run: state.run,
      events: state.events.filter((event) => event.sequence > Math.max(0, afterSequence)),
      overview: this.setupOverview()
    });
  }

  private advanceSetupCheckRun(state: DemoSetupCheckRunState): void {
    if (state.run.status === "COMPLETED") return;
    const chunkSize = state.run.scope === "SINGLE" ? 1 : 4;
    const endIndex = Math.min(
      state.run.connectionIds.length,
      state.nextConnectionIndex + chunkSize
    );
    while (state.nextConnectionIndex < endIndex) {
      const connectionId = state.run.connectionIds[state.nextConnectionIndex]!;
      const result = this.checkedSetupConnectionResult(connectionId);
      this.appendSetupCheckEvent(state, connectionId, "Checking saved credential");
      if (result.functionalState === "FUNCTIONAL") {
        this.appendSetupCheckEvent(state, connectionId, "Sending live provider challenge");
        this.appendSetupCheckEvent(state, connectionId, "Confirming credential identity");
      }
      this.appendSetupCheckEvent(state, connectionId, "Saving result");
      this.setupConnectionResults.set(connectionId, result);
      const terminalStage =
        result.functionalState === "NEEDS_SETUP"
          ? "Needs setup"
          : result.functionalState === "UNAVAILABLE"
            ? "CLI unavailable"
            : result.liveVerificationState === "VERIFIED"
              ? "Verified"
              : result.liveVerificationState === "QUOTA_LIMITED"
                ? "Quota limited"
                : result.liveVerificationState === "TIMED_OUT"
                  ? "Timed out"
                  : "Provider failed";
      this.appendSetupCheckEvent(state, connectionId, terminalStage, "COMPLETED", result);
      state.nextConnectionIndex += 1;
    }
    state.run = {
      ...state.run,
      completedCount: state.nextConnectionIndex,
      status: state.nextConnectionIndex === state.run.totalCount ? "COMPLETED" : "RUNNING",
      updatedAt: new Date().toISOString(),
      finishedAt: state.nextConnectionIndex === state.run.totalCount
        ? new Date().toISOString()
        : null
    };
  }

  private checkedSetupConnectionResult(connectionId: string): DemoSetupConnectionResult {
    if (connectionId === "cli:autohand") {
      return {
        functionalState: "NEEDS_SETUP",
        liveVerificationState: "NOT_CHECKED",
        reasonCode: "CREDENTIAL_REQUIRED"
      };
    }
    if (["cli:codex", "cli:claude", "cli:gemini", "cli:opencode"].includes(connectionId)) {
      return {
        functionalState: "FUNCTIONAL",
        liveVerificationState: "VERIFIED",
        reasonCode: null
      };
    }
    if (connectionId === "cli:kimi") {
      return {
        functionalState: "FUNCTIONAL",
        liveVerificationState: "QUOTA_LIMITED",
        reasonCode: "PROVIDER_QUOTA_LIMITED"
      };
    }
    if (connectionId === "cli:cursor") {
      return {
        functionalState: "FUNCTIONAL",
        liveVerificationState: "TIMED_OUT",
        reasonCode: "PROVIDER_CHECK_TIMED_OUT"
      };
    }
    return {
      functionalState: "FUNCTIONAL",
      liveVerificationState: "PROVIDER_FAILED",
      reasonCode: "PROVIDER_CHECK_FAILED"
    };
  }

  private appendSetupCheckEvent(
    state: DemoSetupCheckRunState,
    connectionId: string,
    stage: SetupConnectionCheckEvent["stage"],
    eventState: SetupConnectionCheckEvent["state"] = "RUNNING",
    result?: DemoSetupConnectionResult
  ): void {
    this.setupCheckSequence += 1;
    state.events.push({
      id: `setup_check_event:demo-${String(this.setupCheckSequence).padStart(4, "0")}`,
      runId: state.run.id,
      sequence: this.setupCheckSequence,
      connectionId,
      stage,
      state: eventState,
      functionalState: result?.functionalState ?? null,
      liveVerificationState: result?.liveVerificationState ?? null,
      reasonCode: result?.reasonCode ?? null,
      createdAt: new Date().toISOString()
    });
  }

  private setupOverview(): SetupOverview {
    const connections: SetupConnection[] = CLI_RUNTIME_PRESENTATIONS.map(({ id, displayName }) => {
      const result = this.setupConnectionResults.get(id) ?? {
        functionalState: "UNAVAILABLE",
        liveVerificationState: "NOT_CHECKED",
        reasonCode: "CLI_RUNTIME_UNAVAILABLE"
      };
      return {
        id,
        label: displayName,
        providerName: demoProviderNames[id] ?? displayName,
        category: "AI coding CLI",
        state: result.functionalState === "FUNCTIONAL"
          ? "CONNECTED"
          : result.functionalState,
        functionalState: result.functionalState,
        liveVerificationState: result.liveVerificationState,
        reasonCode: result.reasonCode,
        verifiedAt: result.liveVerificationState === "VERIFIED" ? DEMO_FIXED_AT : null,
        staleAt: result.liveVerificationState === "VERIFIED" ? "2026-08-21T20:00:00.000Z" : null,
        actions: result.functionalState === "FUNCTIONAL"
          ? ["VERIFY"]
          : result.functionalState === "UNAVAILABLE"
            ? ["RUN_HOST_LAUNCHER"]
            : ["OPEN_LOGIN_PANE", "VERIFY"]
      };
    });
    const functional = connections.filter((connection) =>
      connection.functionalState === "FUNCTIONAL"
    ).length;
    return {
      onboardingVersion: 1,
      isComplete: true,
      completedAt: DEMO_FIXED_AT,
      starterRoomId: this.fixture.rooms[0]?.id ?? null,
      summary: {
        total: connections.length,
        functional,
        liveVerified: connections.filter((connection) =>
          connection.liveVerificationState === "VERIFIED"
        ).length,
        needsSetup: connections.length - functional
      },
      connections
    };
  }

  private fallback(method: string): unknown {
    if (method.startsWith("create") || method.startsWith("update") || method.startsWith("delete") || method.startsWith("execute") || method.startsWith("restart") || method.startsWith("reclaim") || method.startsWith("switch") || method.startsWith("reap")) {
      return { ok: true, status: "SIMULATED", message: DEMO_LOCAL_REPLY, updatedAt: DEMO_FIXED_AT, data: [] };
    }
    return { data: [], pagination: paginated([]).pagination, status: "SIMULATED", statusReason: DEMO_LOCAL_REPLY };
  }
}
