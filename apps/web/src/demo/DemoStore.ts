import { taskTitleSettingsSchema, shortTaskTitle, roomSchema, paneSchema, userSettingsSchema, userLinkSchema, clipboardItemSchema, taskItemSchema, taskScheduleNextRunAt, artifactSchema, MAX_ROOMS, pickNextAvailableRoomName } from "@space/contracts";
import { demoHealthSnapshot } from "./demo-health.js";
import { defaultUserSettings, canonicalizeUserLinkUrl, cliToggleRuntimeIds, streamingMetricDefinitions, defaultToolRoutingState, buildEffectiveToolPlan, updateToolRoutingSchema, buildDotToolCatalog, dotWorkspacePath, dotUserSettingsFrom, summarizeDotProactiveUsage } from "@space/contracts";
import type { DotUserSettings, UpdateDotUserSettings } from "@space/contracts";
import type {
  MaintenanceAutopilotStatus,
  DotProfile,
  DotCollectionItem,
  CreateAgentPaneSessionInput,
  AgentRuntime,
  AgentRuntimeRegistry,
  AgentPaneSession,
  AgentPaneSettingsInput,
  Artifact,
  ClipboardItem,
  CliToggleRuntimeId,
  CodexResetCreditRedemptionResponse,
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
  UserLink,
  UserLinkCategory,
  UserSettings
} from "@space/contracts";
import type { SpaceApiClient } from "../runtime/SpaceRuntime.js";
import { DEMO_LOCAL_REPLY, SpaceApiError } from "../runtime/SpaceRuntime.js";
import { CLI_RUNTIME_PRESENTATIONS, cliRuntimeLabel } from "../cli-runtime-presentation.js";
import { createDemoFixture, DEMO_FIXED_AT, type DemoFixture } from "./demo-fixture.js";
import { MockServices } from "./mock-services.js";
import { getCliMockTranscript, getCliMockModel, getCliMockCwd, getCliMockDefinition } from "./mock-cli-transcripts.js";

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
    modelSelection: null,
    fallbackModelSelection: null,
    memoryEnabled: true,
    moderationEnabled: false,
    jevEnabled: false,
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
    },
    moderationEnabled: false,
    memoryPending: 0,
    setup: [{ id: "demo", label: "Live chat", ok: false, hint: "Not available in the local demo." }]
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
  "cli:claude": "Claude Code",
  "cli:gemini": "Google Gemini",
  "cli:opencode": "OpenCode",
  "cli:autohand": "OpenRouter",
  "cli:qwen": "Alibaba Coding Plan International",
  "cli:kimi": "Moonshot AI",
  "cli:grok": "xAI",
  "cli:deepseek": "DeepSeek",
  "cli:cursor": "Cursor",
  "cli:copilot": "GitHub Copilot",
  "cli:hermes": "Hermes Agent",
  "cli:omp": "Oh My Pi",
  "cli:qoder": "Qoder",
  "cli:muse": "Muse Code",
  "cli:droid": "Droid"
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
  private dotSessionRecords = new Map<string, DotCollectionItem>();
  private demoDotSettings: DotUserSettings = dotUserSettingsFrom(null);
  private activeDotSession = new Map<string, string>();
  private demoSubmissions = new Map<string, { fingerprint: string; session: AgentPaneSession }>();
  private agentMessages = new Map<string, AgentPaneSession["messages"]>();
  private agentSelectedToolIds = new Map<string, string[]>();
  private resetRedemptions = new Map<string, CodexResetCreditRedemptionResponse>();
  private setupConnectionResults = initialSetupConnectionResults();
  private setupCheckRuns = new Map<string, DemoSetupCheckRunState>();
  private setupCheckSequence = 0;
  private streamingSettings = initialStreamingSettings();
  private taskTitlePolicy = taskTitleSettingsSchema.parse({});
  private streamingBotSettings = initialStreamingBotSettings();
  private streamingBotStatus = initialStreamingBotStatus();
  readonly api: SpaceApiClient;
  private mockServices = new MockServices(() => this.fixture);
  private readonly publicMock: boolean;
  private readonly initialFixture: DemoFixture;

  constructor(initialFixture?: DemoFixture) {
    this.publicMock = initialFixture !== undefined;
    if (initialFixture) {
      this.fixture = structuredClone(initialFixture);
      this.mockServices = new MockServices(() => this.fixture);
    }
    this.initialFixture = structuredClone(this.fixture);
    this.api = new Proxy({} as SpaceApiClient, {
      get: (_target, property) => {
        if (this.publicMock && property === "harnessUrl") return `${import.meta.env.BASE_URL}demo/media/harness-preview.html`;
        return (...args: unknown[]) => {
        const method = String(property);
        if (this.publicMock) {
          try {
            const extra = this.mockServices.invoke(method, args);
            if (extra.handled) return method.endsWith("Url") ? extra.value : Promise.resolve(extra.value);
          } catch (error) {
            if (method.endsWith("Url")) throw error;
            return Promise.reject(error);
          }
        }
        if (["artifactFileUrl", "agentFilePreviewUrl", "agentFileDownloadUrl", "browserBookmarksExportUrl", "browserFrameWebSocketUrl", "browserStreamWebSocketUrl", "cliRuntimesSnapshot", "cliRuntimeSettingsSnapshot", "cliTerminalWebSocketUrl", "eventStreamUrl", "invalidateCliRuntimes", "invalidateCliRuntimeSettings", "openSetupConnectionCheckStream", "resetCliRuntimeSettingsCache", "setCliTerminalControlLease", "warmCliRuntimes", "warmCliRuntimeSettings"].includes(method)) {
          return this.invoke(method, args);
        }
        return Promise.resolve().then(() => this.invoke(method, args));
        };
      }
    });
  }

  snapshot(): string {
    return JSON.stringify({ version: 1, sequence: this.sequence, rooms: this.fixture.rooms, panes: this.fixture.panes,
      links: this.fixture.links, clipboardItems: this.fixture.clipboardItems, taskItems: this.fixture.taskItems,
      settings: this.fixture.auth.settings, artifacts: this.fixture.artifacts, messages: [...this.agentMessages], dotSessions: [...this.dotSessionRecords], activeDotSessions: [...this.activeDotSession], demoSubmissions: [...this.demoSubmissions], services: this.mockServices.snapshot() });
  }

  restoreSnapshot(value: string | null): void {
    if (!value) return;
    try {
      const state = JSON.parse(value);
      if (state.version !== 1 || !Array.isArray(state.rooms) || !state.rooms.length || !Array.isArray(state.panes)) return;
      const rooms = state.rooms.map((value: unknown) => roomSchema.parse(value));
      const panes = state.panes.map((value: unknown) => paneSchema.parse(value));
      const ids = new Set(rooms.map((r: Room) => r.id));
      if (!panes.every((p: Pane) => ids.has(p.roomId))) return;
      const links = state.links?.map((value: unknown) => userLinkSchema.parse(value)) ?? this.fixture.links;
      const clipboardItems = state.clipboardItems?.map((value: unknown) => clipboardItemSchema.parse(value)) ?? this.fixture.clipboardItems;
      const taskItems = state.taskItems?.map((value: unknown) => taskItemSchema.parse(value)) ?? this.fixture.taskItems;
      const settings = state.settings ? userSettingsSchema.parse(state.settings) : this.fixture.auth.settings;
      const artifacts = state.artifacts?.map((value: unknown) => artifactSchema.parse(value)) ?? this.fixture.artifacts;
      this.fixture.rooms = rooms; this.fixture.panes = panes;
      this.fixture.links = links; this.fixture.clipboardItems = clipboardItems; this.fixture.taskItems = taskItems;
      this.fixture.auth.settings = settings;
      this.fixture.artifacts = artifacts;
      if (Array.isArray(state.messages) && state.messages.every((row: any) => Array.isArray(row) && typeof row[0] === "string" && Array.isArray(row[1]))) this.agentMessages = new Map(state.messages);
      if (Array.isArray(state.dotSessions)) {
        const owned = new Set(this.demoDots().map(dot => dot.dotId));
        const records = state.dotSessions.filter((row: unknown) => Array.isArray(row) && typeof row[0] === "string" && row[1]
          && typeof row[1] === "object" && owned.has((row[1] as DotCollectionItem).dotId)
          && panes.some((pane: Pane) => pane.id === (row[1] as DotCollectionItem).paneId && pane.roomId === (row[1] as DotCollectionItem).roomId));
        this.dotSessionRecords = new Map(records);
        if (Array.isArray(state.activeDotSessions)) this.activeDotSession = new Map(state.activeDotSessions.filter((row: unknown) => Array.isArray(row)
          && typeof row[0] === "string" && this.dotSessionRecords.get(row[1])?.paneId === row[0]));
      }
      if (Array.isArray(state.demoSubmissions)) this.demoSubmissions = new Map(state.demoSubmissions.filter((row: unknown) => Array.isArray(row)
        && typeof row[0] === "string" && typeof row[1]?.fingerprint === "string" && this.dotSessionRecords.has(row[1]?.session?.binding?.sessionId)));
      this.mockServices.restore(state.services);
      if (Number.isSafeInteger(state.sequence) && state.sequence >= 0) this.sequence = state.sequence;
    } catch { /* Invalid cached workspaces start with the current fixture. */ }
  }

  reset(): void {
    this.toolRoutingState = defaultToolRoutingState();
    this.fixture = structuredClone(this.initialFixture);
    this.mockServices = new MockServices(() => this.fixture);
    this.sequence = 0;
    this.cliRuntimeEnabled = new Map(cliToggleRuntimeIds.map((runtimeId) => [runtimeId, true]));
    this.dotSessionRecords.clear(); this.activeDotSession.clear(); this.demoSubmissions.clear();
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

  private demoDots(): DotProfile[] {
    return ["Orbit", "Nova", "Byte", "Comet", "Luna", "Cosmo"].map((name, index) => ({
      dotId: `dot:${String(index + 1).repeat(32)}`, ownerUserId: this.fixture.auth.user?.id ?? "user:demo", slot: index + 1, name,
      appearance: { character: (["astronaut", "star", "robot", "comet", "moon", "planet"] as const)[index]!, accent: "slate" },
      preferences: {}, permissions: { mode: "INHERIT_USER" }, workLimits: { maxConcurrentTasks: 1, dailyBudgetUsd: null },
      createdAt: DEMO_FIXED_AT, updatedAt: DEMO_FIXED_AT
    }));
  }
  private createDotSession(paneId: string, input: CreateAgentPaneSessionInput): AgentPaneSession {
    const current = this.agentSession(paneId);
    const pane = this.fixture.panes.find(candidate => candidate.id === paneId);
    const roomId = pane?.roomId ?? this.fixture.rooms[0]!.id;
    const dotId = input.dotId ?? current.dotId ?? this.demoDots()[0]!.dotId;
    if (!this.demoDots().some(dot => dot.dotId === dotId)) throw new SpaceApiError("Dot not found.", { status: 404 });
    if (["RUNNING", "QUEUED", "INTERRUPTING"].includes(current.runStatus) || current.pendingRequest) throw new SpaceApiError("Finish or stop the current action before switching Dots.", { status: 409 });
    if (input.sessionId) {
      const restored = this.dotSessionRecords.get(input.sessionId);
      if (!restored || restored.dotId !== dotId || restored.roomId !== roomId) throw new SpaceApiError("Conversation is not available for this Dot and room.", { status: 404 });
      if (restored.paneId !== paneId && restored.paneId && this.activeDotSession.get(restored.paneId) === input.sessionId) {
        this.activeDotSession.delete(restored.paneId);
      }
      this.dotSessionRecords.set(input.sessionId, { ...restored, paneId }); this.activeDotSession.set(paneId, input.sessionId);
    } else if (input.sessionId === null || current.dotId !== dotId) {
      if (input.threadId && ![...this.dotSessionRecords.values()].some(record => record.dotId === dotId && record.roomId === roomId && record.threadId === input.threadId)) {
        throw new SpaceApiError("Conversation is not available for this Dot and room.", { status: 404 });
      }
      const sessionId = this.nextId("agent_session");
      this.dotSessionRecords.set(sessionId, { sessionId, paneId, roomId, dotId, title: input.title ?? pane?.title ?? "Demo chat",
        threadId: input.threadId ?? null, status: "READY", isActive: true, updatedAt: DEMO_FIXED_AT });
      this.agentMessages.set(sessionId, []); this.activeDotSession.set(paneId, sessionId);
    }
    return this.agentSession(paneId);
  }

  private agentSession(paneId: string): AgentPaneSession {
    const pane = this.fixture.panes.find((candidate) => candidate.id === paneId);
    const roomId = pane?.roomId ?? this.fixture.rooms[0]!.id;
    let activeId = this.activeDotSession.get(paneId) ?? `agent_session:${paneId}`;
    const previous = this.dotSessionRecords.get(activeId);
    if (previous && (previous.paneId !== paneId || previous.roomId !== roomId)) {
      // A moved session (including the deterministic initial ID) belongs to its
      // destination. Repair this pane with a distinct, empty conversation.
      activeId = this.nextId("agent_session");
      this.dotSessionRecords.set(activeId, { sessionId: activeId, paneId, roomId,
        dotId: previous.dotId, threadId: null, title: pane?.title ?? "Demo chat", status: "READY", isActive: true, updatedAt: DEMO_FIXED_AT });
      this.agentMessages.set(activeId, []);
    }
    if (!this.dotSessionRecords.has(activeId)) this.dotSessionRecords.set(activeId, { sessionId: activeId, paneId, roomId,
      dotId: this.demoDots()[0]!.dotId, threadId: `thread:${paneId}`, title: pane?.title ?? "Demo chat", status: "READY", isActive: true, updatedAt: DEMO_FIXED_AT });
    this.activeDotSession.set(paneId, activeId);
    const record = this.dotSessionRecords.get(activeId)!;
    const messages = this.agentMessages.get(activeId) ?? this.agentMessages.get(paneId) ?? (this.publicMock && paneId === "pane:demo-research-chat" ? [{
      id: `agent_message:${paneId}:brief`, role: "user" as const,
      content: "Review the public launch workspace.", status: "COMPLETED" as const, createdAt: DEMO_FIXED_AT
    }, {
      id: `agent_message:${paneId}:reply`, role: "assistant" as const,
      content: DEMO_LOCAL_REPLY, status: "COMPLETED" as const, createdAt: DEMO_FIXED_AT
    }] : [{
      id: `agent_message:${paneId}:welcome`,
      role: "assistant" as const,
      content: "Welcome to the deterministic Space demo. Explore the real workspace controls safely.",
      status: "COMPLETED" as const,
      createdAt: DEMO_FIXED_AT
    }]);
    this.agentMessages.set(activeId, messages);
    const selectedToolIds = this.agentSelectedToolIds.get(paneId) ?? ["space-readonly:space_status"];
    return {
      dotId: record.dotId, runtimeState: "AVAILABLE",
      binding: {
        paneId,
        source: "SPACE",
        sessionId: activeId,
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
      threadId: record.threadId ?? null,
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
      messages: [{ id: `room_agent_message:${roomId}`, role: "assistant", kind: "CHAT", content: DEMO_LOCAL_REPLY, status: "COMPLETED", createdAt: DEMO_FIXED_AT }],
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
    const runtimeId = pane.terminalRuntimeId ?? "cli:codex";
    const sessionId = `cli_session:${pane.id}`;
    const mockDef = getCliMockDefinition(runtimeId);
    const content = this.publicMock
      ? getCliMockTranscript(runtimeId)
      : `Space ${runtimeId} demo ready. Commands stay inside this browser.\r\n${DEMO_LOCAL_REPLY}\r\n`;
    return {
      session: {
        sessionId,
        paneId: pane.id,
        roomId: pane.roomId,
        runtimeId,
        providerId: "demo-local",
        agentId: runtimeId.replace(/^cli:/, ""),
        modelId: mockDef.modelId,
        reasoningEffort: "high",
        cwd: mockDef.cwd,
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
        agentId: runtimeId.replace(/^cli:/, ""),
        agentName: mockDef.displayName,
        displayName: mockDef.displayName,
        capabilities: ["CLI"],
        status: "READY",
        statusReason: "Available in the local deterministic demo.",
        commandName: runtimeId === "cli:root" ? "/bin/bash" : runtimeId.replace(/^cli:/, ""),
        detectedCommandPath: `/demo/bin/${runtimeId.replace(/^cli:/, "")}`,
        defaultModelId: mockDef.modelId,
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
        content,
        byteLength: content.length,
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
    const dotSession = [...this.dotSessionRecords.values()].find(record => record.threadId === threadId);
    const isolatedMessages = dotSession && dotSession.sessionId !== `agent_session:${dotSession.paneId}`
      ? this.agentMessages.get(dotSession.sessionId!) ?? [] : null;
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
      modelProvider: "space-gateway",
      threadSource: "demo-fixture",
      firstUserMessage: "Review the public launch workspace.",
      updatedAt: DEMO_FIXED_AT,
      recencyAt: DEMO_FIXED_AT
    };
    return {
      thread,
      items: isolatedMessages ? isolatedMessages.map(message => ({ id: message.id, kind: "message" as const, role: message.role,
        content: message.content, toolName: null, rawType: "message", createdAt: message.createdAt })) : [
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
        ? `space_memory_${query.month}.md`
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
          modelSelection: input.modelSelection,
          fallbackModelSelection: input.fallbackModelSelection,
          memoryEnabled: input.memoryEnabled,
          moderationEnabled: input.moderationEnabled,
          jevEnabled: input.jevEnabled,
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
            accountId: "demo-youtube",
            channelId: "demo-chat",
            authorId: "demo-viewer",
            messageId: "demo-message-001",
            protectedAccount: false,
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
            accountId: "demo-twitch",
            channelId: "demo-chat",
            authorId: null,
            messageId: "demo-message-002",
            protectedAccount: false,
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
      case "streamingBotModels":
        return Promise.resolve({ models: [] });
      case "streamingBotMemory":
        return Promise.resolve({ entries: args[0] === "APPROVED" ? [{
          id: "streaming-memory:demo-001", title: "Stream schedule", body: "Live every Tuesday at 20:00 (demo entry).",
          status: "APPROVED", source: "OPERATOR", version: 1, createdAt: DEMO_FIXED_AT, updatedAt: DEMO_FIXED_AT
        }] : [] });
      case "streamingModerationActions":
        return Promise.resolve({ actions: [] });
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

  private toolRoutingState = defaultToolRoutingState();

  private invoke(method: string, args: unknown[]): unknown {
    const roomId = typeof args[0] === "string" ? args[0] : null;
    switch (method) {
      case "exportConfiguration":
      case "inspectConfiguration":
      case "importConfiguration":
      case "configurationCliLogins":
        throw new SpaceApiError("Configuration migration is unavailable in this demo. No installation was accessed or changed.", { status: 400, code: "DEMO_UNSUPPORTED" });
      case "modelCapabilities": return { profiles: [], state: structuredClone(this.toolRoutingState) };
      case "effectiveToolRouting": return buildEffectiveToolPlan(this.toolRoutingState, {
        version: 1, runtimeId: String(args[0]), modelId: String(args[1]), capabilities: {}
      });
      case "saveToolRouting": {
        const input = updateToolRoutingSchema.parse(args[0]);
        if (input.expectedRevision !== this.toolRoutingState.revision) throw new SpaceApiError("Routing policy changed; reload before saving.", { status: 409 });
        this.toolRoutingState = { ...this.toolRoutingState, enabledRuntimeIds: input.enabledRuntimeIds, overrides: input.overrides, revision: input.expectedRevision + 1 };
        return structuredClone(this.toolRoutingState);
      }
      case "me": return Promise.resolve(structuredClone(this.fixture.auth));
      case "userSettings": return Promise.resolve(structuredClone(this.fixture.auth.settings ?? defaultUserSettings));
      case "updateUserSettings": {
        const patch = (args[0] ?? {}) as Partial<UserSettings>;
        const current = this.fixture.auth.settings ?? defaultUserSettings;
        const updated: UserSettings = { ...current, ...patch };
        this.fixture.auth.settings = updated;
        return Promise.resolve(structuredClone(updated));
      }
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
      case "healthPing": return Promise.resolve({ ok: true });
      case "systemHealth": return Promise.resolve(demoHealthSnapshot());
      case "systemHealthHistory": {
        const range = String(args[0] ?? "10m");
        const duration = ({ "1m": 60, "10m": 600, "1h": 3600, "7d": 604800, "30d": 2592000 } as Record<string, number>)[range] ?? 600;
        const snapshot = demoHealthSnapshot();
        return Promise.resolve({ range, sampledAt: snapshot.sampledAt, series: snapshot.metrics.filter(m => m.value !== null).map(m => ({
          id: m.id, label: m.label, unit: m.unit,
          points: Array.from({ length: 60 }, (_, i) => { const value = Math.max(0, m.value! * (0.8 + Math.sin(i * .7) * .15));
            return { at: new Date(Date.now() - (59 - i) * duration / 60 * 1000).toISOString(), min: value * .9, avg: value, max: value * 1.1 }; }),
        })) });
      }
      case "readyz": return Promise.resolve({
        ok: true,
        apiStartedAt: DEMO_FIXED_AT,
        dependencies: { store: "demo-local", runtimeStore: "demo-local", eventBus: "demo-local", temporal: "simulated", worker: "SIMULATED", cliHost: "SIMULATED", cliAdminHost: "SIMULATED", browserHost: "SIMULATED", browserHostBuildCommit: null, browserHostCaptureMetrics: null, codexTurns: "simulated", codexLb: "disconnected" }
      });
      case "deployQueue": return Promise.resolve({
        available: false, daemonRunning: false, heartbeatAt: null, paused: null, current: null, next: null, active: [], recent: []
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
            paneCount: this.fixture.panes.filter((pane) => pane.roomId === room.id && !pane.isClosed).length,
            runtimeIds: [...new Set(runningPanes.map((pane) => pane.terminalRuntimeId ?? "cli:codex"))]
          };
        }),
        sampledAt: DEMO_FIXED_AT
      });
      case "dashboardAgents": return Promise.resolve({ data: structuredClone(this.fixture.panes.filter((pane) => pane.roomId === roomId && !pane.isClosed)), activity: {} });
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
      case "taskTitleSettings": return structuredClone(this.taskTitlePolicy);
      case "updateTaskTitleSettings": this.taskTitlePolicy=taskTitleSettingsSchema.parse(args[0]);return structuredClone(this.taskTitlePolicy);
      case "taskTitleAvailability": return {candidates:[]};
      case "bindHarnessTitleSession":return structuredClone(this.fixture.panes.find(pane=>pane.id===String(args[0]))!);
      case "setPaneTitlePreference": {
        const pane=this.fixture.panes.find(pane=>pane.id===String(args[0]))!;
        if(pane.taskMetadata)pane.taskMetadata={...pane.taskMetadata,preferredCandidateId:args[1] as string|null,version:pane.taskMetadata.version+1};
        return structuredClone(pane);
      }
      case "generatePaneTitle": {
        const pane=this.fixture.panes.find(pane=>pane.id===String(args[0]))!;
        if(pane.titleSource!=="manual")pane.title=shortTaskTitle(pane.title,"Task");
        pane.taskMetadata={taskKey: `demo:${pane.id}`,version:1,description:pane.title,steps:[pane.title],earlierWork:"",source:"local",generationStatus:"ready",nativeSyncStatus:"unsupported",providerId:null,modelId:null,updatedAt:DEMO_FIXED_AT};
        return structuredClone(pane);
      }
      case "providerSettings": return Promise.resolve(structuredClone(this.fixture.providerSettings));
      case "updateProviderSettings": {
        const input = args[0] as UpdateProviderSettingsInput;
        Object.assign(this.fixture.providerSettings, input, { updatedAt: DEMO_FIXED_AT });
        return Promise.resolve(structuredClone(this.fixture.providerSettings));
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
        checkedAt: new Date().toISOString(),
        lbUsage: this.fixture.codexEnvironment.lbUsage ? { ...this.fixture.codexEnvironment.lbUsage, checkedAt: new Date().toISOString() } : undefined,
        isCodexEnabled: this.cliRuntimeEnabled.get("cli:codex") !== false
      }));
      case "toolbarUsageAccounts": return Promise.resolve(structuredClone({ ...this.fixture.codexUsageAccounts, checkedAt: new Date().toISOString(), data: this.fixture.codexUsageAccounts.data.map(account => ({ ...account, sampledAt: new Date().toISOString() })) }));
      case "toolbarAntigravityUsageAccounts": return Promise.resolve(structuredClone({ ...this.fixture.antigravityUsageAccounts, checkedAt: new Date().toISOString(), data: this.fixture.antigravityUsageAccounts.data.map(account => ({ ...account, sampledAt: new Date().toISOString() })) }));
      case "toolbarClaudeUsageAccounts": return Promise.resolve({
        data: [
          { id: "main", label: "Main account", email: "demo@spaceapp.dev", plan: "Team · Max 5x", status: "CONNECTED" as const, fiveHourRemainingPercent: 62, fiveHourResetAt: "2026-08-02T18:00:00.000Z", weeklyRemainingPercent: 91, weeklyResetAt: "2026-08-08T18:00:00.000Z", weeklyScope: "Opus", sampledAt: new Date().toISOString() },
          { id: "lab", label: "lab", email: "demo-lab@spaceapp.dev", plan: "Team · Max 5x", status: "CONNECTED" as const, fiveHourRemainingPercent: 100, fiveHourResetAt: "2026-08-02T19:00:00.000Z", weeklyRemainingPercent: 99, weeklyResetAt: "2026-08-08T19:00:00.000Z", weeklyScope: "Opus", sampledAt: new Date().toISOString() },
          { id: "api", label: "api", email: null, plan: null, status: "NOT_CONNECTED" as const, fiveHourRemainingPercent: null, fiveHourResetAt: null, weeklyRemainingPercent: null, weeklyResetAt: null, weeklyScope: null, sampledAt: new Date().toISOString() }
        ],
        pagination: { page: 1, pageSize: 100, totalItems: 3, totalPages: 1 },
        source: "demo-fixture",
        isStale: false,
        error: null,
        checkedAt: new Date().toISOString()
      });
      case "toolbarApiProviderAccounts": return Promise.resolve({
        data: [
          { id: "deepseek", providerId: "deepseek", label: "DeepSeek", status: "CONNECTED" as const, balance: "$0.19", currency: "USD", detail: "Topped up: $0.19", sampledAt: new Date().toISOString() },
          { id: "openrouter", providerId: "openrouter", label: "OpenRouter", status: "CONNECTED" as const, balance: "$0.00", currency: "USD", usage: "$15.23", limit: "$15.00", detail: "Credits: $15.00 · Used: $15.23 · Free: 907/1000 daily", sampledAt: new Date().toISOString() },
          { id: "vercel-gateway", providerId: "vercel-gateway", label: "Vercel AI Gateway", status: "CONNECTED" as const, balance: "$0.20", currency: "USD", usage: "$4.80", limit: "$5.00", remainingPercent: 4, detail: "Credits: $5.00 · Used: $4.80 · Account: demo@spaceapp.dev", sampledAt: new Date().toISOString() },
          { id: "google-gemini", providerId: "google", label: "Google Gemini (WebSocket / API)", status: "CONNECTED" as const, balance: "Pay-as-you-go", currency: "USD", usage: "Gemini 3.8 Live · Aoede", limit: "Standard Tier", remainingPercent: 100, detail: "Gemini 3.8 Live (Aoede) · Realtime WebSocket & Generative API (50 models · Pay-as-you-go)", sampledAt: new Date().toISOString() },
          { id: "openai", providerId: "openai", label: "OpenAI", status: "CONNECTED" as const, balance: "Configured", currency: null, usage: "gpt-4o-realtime-preview", limit: "Pay-as-you-go", detail: "Voice & Realtime API key configured", sampledAt: new Date().toISOString() }
        ],
        pagination: { page: 1, pageSize: 5, totalItems: 5, totalPages: 1 },
        source: "demo-fixture",
        isStale: false,
        error: null,
        checkedAt: new Date().toISOString()
      });
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
      case "toolbarCliSessions": return Promise.resolve(structuredClone({ ...this.fixture.cliSessionStats, sampledAt: new Date().toISOString() }));
      case "toolbarModelStats": return Promise.resolve(structuredClone(this.fixture.modelStats));
      case "systemAnalyticsOverview": return Promise.resolve(structuredClone({
        ...this.fixture.systemAnalyticsOverview,
        range: args[0] ?? "10m"
      }));
      case "systemAnalyticsModels": return Promise.resolve(structuredClone({
        ...this.fixture.systemAnalyticsModels,
        sampledAt: new Date().toISOString(),
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
      // The demo has no install pings: the Installs tab stays hidden and nothing is reported.
      case "systemAnalyticsInstalls": return Promise.resolve({ available: false, updatedAt: null, summary: { installs: 0, completed: 0, failed: 0, setupCompleted: 0, firstCli: 0, firstAnswer: 0, active7d: 0, internal: 0 }, installs: [] });
      case "reportInstallActivity": return Promise.resolve(null);
      case "reapToolbarCliSessions": return Promise.resolve(structuredClone(this.fixture.cliSessionReap));
      case "toolbarHostMemory": return Promise.resolve(structuredClone(this.fixture.hostMemoryDetails));
      case "reclaimToolbarMemory": return Promise.resolve(structuredClone(this.fixture.memoryReclaim));
      case "codexLbSpeedDefaults":
      case "updateCodexLbSpeedDefault": return Promise.resolve(structuredClone(this.fixture.codexLbSpeedDefaults));
      case "gatewayStatus": return Promise.resolve(this.demoGatewayStatus());
      // The demo holds no Anthropic admin key: the card says so and nothing leaves the page.
      case "gatewayAnthropicAdmin":
      case "syncGatewayAnthropicBilling":
      case "saveGatewayAnthropicAdminKey": return Promise.resolve({ configured: false, keyHint: null, savedAt: null, lastSyncAt: null, lastError: null, upstream: [] });
      case "removeGatewayAnthropicAdminKey": return Promise.resolve({ removed: false });
      case "gatewayAnthropicBilling": return Promise.resolve({ status: { configured: false, keyHint: null, savedAt: null, lastSyncAt: null, lastError: null, upstream: [] }, days: [] });
      case "gatewaySettings": return Promise.resolve(structuredClone(this.demoGatewaySettings));
      case "updateGatewaySettings":
        this.demoGatewaySettings = { ...this.demoGatewaySettings, ...(args[0] as object), updatedAt: DEMO_FIXED_AT };
        return Promise.resolve(structuredClone(this.demoGatewaySettings));
      case "gatewayAccounts":
      case "gatewayApiKeys":
      case "gatewayAntigravityProfiles": return Promise.resolve({ data: [] });
      case "gatewayRequestLogs": return Promise.resolve({ data: [], nextCursor: null });
      case "reloadGateway": return Promise.resolve({ status: "RELOADING" });
      case "gatewayCompressionSession": return Promise.resolve(this.demoHeadroomSession());
      case "gatewayCompressionLifetime": return Promise.resolve(this.demoHeadroomLifetime());
      case "gatewayCompressionHistory": return Promise.resolve({ generatedAt: DEMO_FIXED_AT,
        lifetime: { savedTokens: 0, savedUsd: 0, activeDays: 0, averagePerDay: 0, averagePerWeek: 0, averagePerMonth: 0 },
        series: { daily: [], weekly: [], monthly: [] }, models: [], retention: { requestLogDays: 30, rollups: "kept" as const } });
      case "gatewayRequestLogFacets": return Promise.resolve({ models: [], providers: [], statuses: [], accounts: [], apiKeys: [], clients: [] });
      case "gatewayDashboard": return Promise.resolve(this.demoGatewayDashboard(String(args[0] ?? "24h")));
      case "gatewayHealth": return Promise.resolve({
        generatedAt: DEMO_FIXED_AT,
        signals: (["gateway", "database", "upstream", "lan", "internet", "compression"] as const).map((key) => ({
          key, label: { gateway: "Gateway API", database: "Database", upstream: "Upstream providers", lan: "LAN listener", internet: "Internet", compression: "Compression workers" }[key],
          status: "UNAVAILABLE" as const, nowMs: null, p50Ms: null, p95Ms: null, samples: 0, sparkline: [], warnMs: null, criticalMs: null,
          detail: "Not measured in the demo.", updatedAt: null }))
      });
      case "gatewayReport": {
        const empty = { key: "total", requests: 0, errors: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, reasoningReported: 0, costUsd: 0, compressionTokensSaved: 0 };
        return Promise.resolve({ from: String(args[0]), to: String(args[1]), days: [], models: [], accounts: [], totals: empty });
      }
      case "previewCodexHistoryPurge": return Promise.resolve(structuredClone(this.fixture.adminDiagnostics.historyPurgePreview));
      case "executeCodexHistoryPurge": return Promise.resolve(structuredClone(this.fixture.adminDiagnostics.historyPurgeResult));
      case "restartCoreServices": return Promise.resolve(structuredClone(this.fixture.adminDiagnostics.serviceRestart));
      case "streamingCatalog": {
        const response: StreamingCatalogResponse = {
          providers: (["YOUTUBE", "TWITCH", "TIKTOK", "X", "DISCORD"] as const).map((provider) => ({
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
      case "createStreamingBotMemory":
      case "updateStreamingBotMemory":
      case "deleteStreamingBotMemory":
      case "undoStreamingModerationAction":
      case "timeoutStreamingModerationReview":
      case "streamingLiveAction":
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
      case "streamingBotModels":
      case "streamingBotMemory":
      case "streamingModerationActions":
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
      case "detectCliUpdateAll": return Promise.resolve(this.demoCliUpdateDetection());
      case "runCliUpdateAll": {
        const input = (args[0] ?? {}) as { keys?: string[]; reinstall?: boolean };
        const detection = this.demoCliUpdateDetection();
        const selected = detection.cliTypes.filter((entry) => entry.managed && (!input.keys?.length || input.keys.includes(entry.key)));
        this.demoCliUpdatesApplied = true;
        return Promise.resolve({
          mode: "UPDATE_ALL",
          overallStatus: "PASS",
          scope: input.keys?.length ? input.keys : "all",
          reinstall: input.reinstall === true,
          runtimes: selected.map((entry) => ({
            runtimeId: entry.cliType,
            displayName: entry.displayName,
            installedVersion: entry.installedVersion ?? null,
            availableVersion: entry.availableVersion ?? null,
            status: "PASS",
            code: entry.updateAvailable ? "UPDATED" : "CURRENT",
            summary: DEMO_LOCAL_REPLY,
            checks: [],
            customPreserved: entry.hasCustom,
            customReinstalled: entry.hasCustom && input.reinstall === true
          })),
          customSummary: selected.map((entry) => ({ key: entry.key, hasCustom: entry.hasCustom, custom: entry.custom })),
          startedAt: DEMO_FIXED_AT,
          finishedAt: DEMO_FIXED_AT
        });
      }
      case "maintenanceAutopilotStatus": return Promise.resolve(this.demoMaintenanceAutopilotStatus());
      case "startMaintenanceAutopilot": {
        const step = (id: "cleanup" | "memory" | "check" | "update") => ({ id, status: "DONE" as const, summary: DEMO_LOCAL_REPLY, startedAt: DEMO_FIXED_AT, finishedAt: DEMO_FIXED_AT });
        this.demoMaintenanceLastRun = {
          id: this.nextId("maintenance"),
          trigger: "MANUAL",
          status: "SUCCEEDED",
          summary: "Maintenance finished. Space is clean and up to date.",
          steps: [step("cleanup"), step("memory"), step("check"), step("update")],
          startedAt: DEMO_FIXED_AT,
          finishedAt: DEMO_FIXED_AT
        };
        return Promise.resolve(this.demoMaintenanceAutopilotStatus());
      }
      case "updateMaintenanceAutopilotSchedule": {
        const input = (args[0] ?? {}) as Partial<MaintenanceAutopilotStatus["schedule"]>;
        this.demoMaintenanceSchedule = {
          ...this.demoMaintenanceSchedule,
          enabled: Boolean(input.enabled),
          hour: input.hour ?? this.demoMaintenanceSchedule.hour,
          timeZone: input.timeZone ?? this.demoMaintenanceSchedule.timeZone,
          nextRunAt: input.enabled ? "2026-07-15T04:00:00.000Z" : null
        };
        return Promise.resolve(this.demoMaintenanceAutopilotStatus());
      }
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
      case "memoryCalendar": {
        const query = (args[0] ?? {}) as { year?: number; month?: string; date?: string };
        const activeMonth = query.month && query.month !== "all" ? query.month : "2026-10";
        const activeYear = query.year ?? 2026;
        const heatMap: Record<string, { count: number; bytes: number }> = {
          "2026-10-01": { count: 8, bytes: 4200 },
          "2026-10-02": { count: 12, bytes: 6400 },
          "2026-10-03": { count: 5, bytes: 2800 },
          "2026-10-04": { count: 15, bytes: 8900 },
          "2026-09-28": { count: 4, bytes: 2100 },
          "2026-09-29": { count: 7, bytes: 3600 },
          "2026-09-30": { count: 14, bytes: 7200 }
        };
        const records = [
          {
            id: "memory:demo-public-launch",
            title: "Public launch workspace",
            createdAt: "2026-10-04T10:00:00.000Z",
            sourcePath: "/demo/memory/public-launch.md",
            excerpt: "Sanitized public launch notes and configuration",
            tags: ["launch", "demo"],
            topics: ["ui parity"],
            charCount: 1500
          },
          {
            id: "memory:demo-seo",
            title: "SEO and Telemetry setup",
            createdAt: "2026-10-02T14:30:00.000Z",
            sourcePath: "/demo/memory/public-launch.md",
            excerpt: "Rich snippets and verified search engine indexation",
            tags: ["seo", "telemetry"],
            topics: ["parity"],
            charCount: 980
          }
        ];
        return Promise.resolve({
          data: {
            year: activeYear,
            month: activeMonth,
            selectedDate: query.date ?? null,
            availableMonths: ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"],
            availableYears: [2026],
            stats: {
              totalMemories: 65,
              activeDays: 7,
              yearMemories: 65,
              maxDailyCount: 15
            },
            heatMap,
            records: query.date ? records.filter(r => r.createdAt.startsWith(query.date!)) : records
          }
        });
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
      case "dots": return Promise.resolve({ dots: this.demoDots() });
      case "dotCollection": {
        const dotId = String(args[0]);
        if (!this.demoDots().some(dot => dot.dotId === dotId)) throw new SpaceApiError("Dot not found.", { status: 404 });
        const items = args[1] === "sessions" ? [...this.dotSessionRecords.values()].filter(record => record.dotId === dotId)
          .map(record => ({ ...record, isActive: this.activeDotSession.get(record.paneId!) === record.sessionId })) : [];
        return Promise.resolve({ dotId, items: structuredClone(items), limit: 50, offset: 0 });
      }
      case "dotTools": {
        const dotId = String(args[0]);
        if (!this.demoDots().some(dot => dot.dotId === dotId)) throw new SpaceApiError("Dot not found.", { status: 404 });
        const catalog = buildDotToolCatalog({ role: "USER", browserSessionsEnabled: true, browserPaneIds: [], installedMcpServers: [],
          mcpTools: [{ toolId: "space-readonly:space_status", serverName: "Space readonly", name: "space_status", available: true, approvalRequired: false, statusReason: null }] });
        return Promise.resolve({ dotId, tools: catalog.map(({ inputSchema: _schema, ...tool }) => tool), total: catalog.length,
          available: catalog.filter(tool => tool.availability === "AVAILABLE").length });
      }
      case "dotFeed": {
        const dotId = String(args[0]);
        if (!this.demoDots().some(dot => dot.dotId === dotId)) throw new SpaceApiError("Dot not found.", { status: 404 });
        return Promise.resolve({ dotId, scope: "DOT", items: [], nextBefore: null, latestCursor: null, lastActiveAt: null, unread: 0 });
      }
      case "markDotFeedRead": return Promise.resolve({ unread: 0 });
      case "dotSettings": return Promise.resolve({ settings: structuredClone(this.demoDotSettings) });
      case "updateDotSettings": {
        const patch = args[0] as UpdateDotUserSettings;
        this.demoDotSettings = { ...this.demoDotSettings, ...patch, proactive: { ...this.demoDotSettings.proactive, ...patch.proactive }, updatedAt: DEMO_FIXED_AT };
        return Promise.resolve({ settings: structuredClone(this.demoDotSettings) });
      }
      case "dotModels": return Promise.resolve({ providers: [] });
      case "dotProactiveUsage": return Promise.resolve(summarizeDotProactiveUsage([], Number(args[0] ?? 7)));
      case "dotToolInvocations": return Promise.resolve({ dotId: String(args[0]), items: [], limit: 20, offset: 0 });
      case "dotApprovals": return Promise.resolve({ dotId: String(args[0]), items: [] });
      case "dotGoals": return Promise.resolve({ dotId: String(args[0]), items: [] });
      case "dotSchedules": return Promise.resolve({ dotId: String(args[0]), items: [] });
      case "dotComputer": {
        const dot = this.demoDots().find(candidate => candidate.dotId === String(args[0]));
        if (!dot) throw new SpaceApiError("Dot not found.", { status: 404 });
        return Promise.resolve({ dotId: dot.dotId, workspace: { path: dotWorkspacePath(dot.dotId), exists: false, entries: [], totalEntries: 0, sortedAll: true },
          runs: [], goals: [], browsers: [], limits: { maxConcurrentTasks: dot.workLimits.maxConcurrentTasks, activeTasks: 0 } });
      }
      case "stopDotComputer": return Promise.resolve({ dotId: String(args[0]), interruptedRuns: 0, pausedGoals: 0 });
      case "dotMemories": return Promise.resolve({ dotId: String(args[0]), items: [] });
      case "connectors": return Promise.resolve({ providers: [{ provider: "GOOGLE", configured: false, reason: "Not available in the demo." },
        { provider: "MICROSOFT", configured: false, reason: "Not available in the demo." }], accounts: [] });
      case "disconnectConnector": throw new SpaceApiError(DEMO_LOCAL_REPLY, { status: 409, code: "DEMO_LOCAL_ONLY" });
      case "channels": return Promise.resolve({ providers: [{ provider: "SLACK", configured: false, reason: "Not available in the demo." },
        { provider: "TEAMS", configured: false, reason: "Not available in the demo." }], identities: [], threads: [] });
      case "createChannelLinkCode": case "unlinkChannelIdentity": case "askDotFromLive": throw new SpaceApiError(DEMO_LOCAL_REPLY, { status: 409, code: "DEMO_LOCAL_ONLY" });
      case "dotLiveStatus": return Promise.resolve({ status: "IDLE", message: "Dots do not run in the demo." });
      case "dotWorkspace": return Promise.resolve({ dotId: String(args[0]), folder: String(args[1] ?? ""), exists: false, entries: [], totalEntries: 0, sortedAll: true });
      case "dotDeliverables": return Promise.resolve({ dotId: String(args[0]), items: [] });
      case "dotEvalRuns": return Promise.resolve({ runs: [] });
      case "startDotEval": case "stopDotEval": throw new SpaceApiError(DEMO_LOCAL_REPLY, { status: 409, code: "DEMO_LOCAL_ONLY" });
      case "dotEvalReport": throw new SpaceApiError("Evaluation not found.", { status: 404 });
      case "publishDotDeliverable": throw new SpaceApiError(DEMO_LOCAL_REPLY, { status: 409, code: "DEMO_LOCAL_ONLY" });
      case "createDotMemory": case "updateDotMemory": case "deleteDotMemory":
        throw new SpaceApiError(DEMO_LOCAL_REPLY, { status: 409, code: "DEMO_LOCAL_ONLY" });
      case "updateDot": throw new SpaceApiError(DEMO_LOCAL_REPLY, { status: 409, code: "DEMO_LOCAL_ONLY" });
      case "createDotSchedule": case "controlDotSchedule": throw new SpaceApiError(DEMO_LOCAL_REPLY, { status: 409, code: "DEMO_LOCAL_ONLY" });
      case "createDotGoal": case "controlDotGoal": case "steerDotGoal":
        throw new SpaceApiError(DEMO_LOCAL_REPLY, { status: 409, code: "DEMO_LOCAL_ONLY" });
      case "decideDotApproval": throw new SpaceApiError(DEMO_LOCAL_REPLY, { status: 409, code: "DEMO_LOCAL_ONLY" });
      case "createAgentSession": return Promise.resolve(this.createDotSession(roomId ?? "pane:demo-chat", args[1] as CreateAgentPaneSessionInput ?? {}));
      case "agentSession":
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
      case "prepareAgentRetry": throw new SpaceApiError("Review the demo conversation and compose a new request.", { status: 409, code: "CONFLICT" });
      case "sendAgentMessage": {
        const paneId = roomId ?? "pane:demo-chat";
        const content = String(args[1] ?? "");
        const savedKey = args[5] ? `${paneId}:${String(args[5])}` : null;
        const fingerprint = JSON.stringify(args.slice(1));
        const receipt = savedKey ? this.demoSubmissions.get(savedKey) : null;
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) throw new SpaceApiError("Submission key was reused.", { status: 409 });
          return Promise.resolve(structuredClone(receipt.session));
        }
        const current = this.agentSession(paneId);
        const context = args[7] as { sessionId?: string; dotId?: string } | undefined;
        if (context && ((context.dotId && context.dotId !== current.dotId) || (context.sessionId && context.sessionId !== current.binding.sessionId))) {
          throw new SpaceApiError("The selected Dot session changed.", { status: 409 });
        }
        const messages = current.messages;
        messages.push(
          { id: this.nextId("agent_message"), role: "user", content, status: "COMPLETED", createdAt: DEMO_FIXED_AT },
          { id: this.nextId("agent_message"), role: "assistant", content: DEMO_LOCAL_REPLY, status: "COMPLETED", createdAt: DEMO_FIXED_AT }
        );
        this.agentMessages.set(current.binding.sessionId!, messages);
        const response = this.agentSession(paneId);
        if (savedKey) this.demoSubmissions.set(savedKey, { fingerprint, session: structuredClone(response) });
        return Promise.resolve(response);
      }
      case "roomAgent":
      case "acknowledgeRoomAgentCommand":
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
      case "cliProviderSettings": return {
        providers: [
          { id: "opencode", name: "OpenCode Zen", description: "Free curated coding models", enabled: true, isCustom: false },
          { id: "opencode-go", name: "OpenCode Go", description: "OpenCode Go subscription models", enabled: false, isCustom: false },
          { id: "openrouter", name: "OpenRouter", description: "Unified router across multiple AI model providers", enabled: true, isCustom: false }
        ],
        disabledProviders: ["opencode-go"],
        checkedAt: DEMO_FIXED_AT
      };
      case "updateCliProviderSetting":
      case "updateAllCliProviders": return {
        providers: [
          { id: "opencode", name: "OpenCode Zen", description: "Free curated coding models", enabled: true, isCustom: false },
          { id: "opencode-go", name: "OpenCode Go", description: "OpenCode Go subscription models", enabled: true, isCustom: false },
          { id: "openrouter", name: "OpenRouter", description: "Unified router across multiple AI model providers", enabled: true, isCustom: false }
        ],
        disabledProviders: [],
        checkedAt: DEMO_FIXED_AT
      };
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
      case "setCliTerminalControlLease":
      case "clearActiveCliSessionFlight": return undefined;
      case "panePlanExecution": return Promise.resolve(null);
      case "planExecution": throw new SpaceApiError("Managed plan history is unavailable in demo mode.", { status: 404 });
      case "startPlanExecution":
      case "controlPlanExecution":
      case "overridePlanExecutionStage": throw new SpaceApiError("Managed plan execution requires a live Codex session. Demo mode cannot run stages.", { status: 409, code: "DEMO_LOCAL_ONLY" });
      case "cliModelSettingsStatus": return Promise.resolve({ status: "AVAILABLE", settings: { sessionId: `cli_session:${roomId}`, threadId: null, current: { modelId: "gpt-5.6-sol", reasoningEffort: "high" }, models: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: ["medium", "high", "xhigh"] }], controlMode: "DIRECT", isTurnActive: false } });
      case "updateCliModelSettings": return Promise.resolve({ current: { modelId: String((args[1] as { modelId?: string })?.modelId ?? "gpt-5.6-sol"), reasoningEffort: String((args[1] as { reasoningEffort?: string })?.reasoningEffort ?? "high") }, message: DEMO_LOCAL_REPLY });
      case "cliTurnActivity": return Promise.resolve({ marker: String(args[1]), status: "COMPLETED", turnId: null });
      case "paneWorkingTime": return Promise.resolve({ paneId: String(args[0]), cumulativeWorkingMs: 0, isWorking: false, state: "IDLE" });
      case "cliTerminalWebSocketUrl": {
        const ticket = args[0] as { paneId: string; sessionId: string };
        const runtimeId = this.cliSession(ticket.paneId).session.runtimeId;
        return `demo-terminal://local/${encodeURIComponent(ticket.paneId)}?sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=${encodeURIComponent(runtimeId)}`;
      }
      case "youtubePlayback": return { playback: null };
      case "saveYouTubePlayback": return { ok: true };
      case "watchYouTube": return { currentUrl: null };
      case "browserAccounts": return { selectedProfileId: null, profiles: [] };
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
        const query = (args[0] ?? {}) as { q?: string; category?: UserLinkCategory; isQuick?: boolean; page?: number; pageSize?: number };
        const needle = query.q?.trim().toLowerCase();
        const links = this.fixture.links.filter((link) =>
          (query.category === undefined || link.category === query.category) &&
          (query.isQuick === undefined || link.isQuick === query.isQuick) &&
          (!needle || [link.title, link.description, link.url].some((value) => value.toLowerCase().includes(needle)))
        );
        return Promise.resolve(structuredClone(requestedPage(links, query)));
      }
      case "inspectLink": {
        const arg = args[0] as { url?: string } | string | undefined;
        const rawUrl = String((typeof arg === "object" ? arg?.url : arg) || "");
        let normalized = rawUrl.trim();
        if (!/^https?:\/\//i.test(normalized)) {
          normalized = `https://${normalized}`;
        }
        let hostname = "";
        try { hostname = new URL(normalized).hostname; } catch {}
        const isHttp = /^http:\/\//i.test(normalized);
        return Promise.resolve({
          url: normalized,
          title: hostname || "Link",
          openMode: isHttp ? "NEW_TAB" : "EMBEDDED",
          canEmbed: !isHttp
        });
      }
      case "createLink": {
        const input = args[0] as CreateUserLinkRequest;
        const url = canonicalizeUserLinkUrl(input.url);
        const openMode = input.openMode ?? "EMBEDDED";
        if (url.startsWith("http:") && openMode !== "NEW_TAB") {
          throw new SpaceApiError("HTTP links can only open in a new tab.", { status: 400, code: "INVALID_LINK" });
        }
        let defaultTitle = "Link";
        try { defaultTitle = new URL(url).hostname; } catch {}
        const link: UserLink = {
          id: this.nextId("link"),
          title: (input.title?.trim() || defaultTitle),
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
      case "deleteLink": if (this.publicMock) this.fixture.links = this.fixture.links.filter(item => item.id !== roomId); return Promise.resolve({ id: roomId!, deleted: true as const });
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
          title: input.source === "PLAN" ? (input.title ?? null) : null,
          minimumModel: input.source === "PLAN" ? (input.minimumModel ?? null) : null,
          isCompleted: false,
          executionStatus: "PLANNED",
          progressPercentage: 0,
          activeAgent: null,
          steps: [],
          lastProgressAt: null,
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
        if (item.isCompleted) {
          item.executionStatus = "COMPLETED";
          item.progressPercentage = 100;
        }
        return Promise.resolve(structuredClone(item));
      }
      case "updatePlanProgress": {
        const item = this.fixture.clipboardItems.find((candidate) => candidate.id === roomId);
        if (!item) throw new SpaceApiError("Clipboard item not found.", { status: 404, code: "NOT_FOUND" });
        const input = (args[1] ?? {}) as { executionStatus?: string; progressPercentage?: number; activeAgent?: string; steps?: unknown[] };
        if (input.executionStatus) item.executionStatus = input.executionStatus as any;
        if (input.progressPercentage !== undefined) item.progressPercentage = input.progressPercentage;
        if (input.activeAgent !== undefined) item.activeAgent = input.activeAgent;
        if (input.steps) item.steps = input.steps as any;
        if (item.progressPercentage === 100) item.isCompleted = true;
        return Promise.resolve(structuredClone(item));
      }
      case "deleteClipboardItem": if (this.publicMock) this.fixture.clipboardItems = this.fixture.clipboardItems.filter(item => item.id !== roomId); return Promise.resolve({ id: roomId!, deleted: true as const });
      case "clearClipboardItems": { const deletedCount = this.publicMock ? this.fixture.clipboardItems.length : 0; if (this.publicMock) this.fixture.clipboardItems = []; return Promise.resolve({ deletedCount }); }
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
          lastUsedAt: DEMO_FIXED_AT,
          schedule: input.schedule ? { ...input.schedule, timeZone: input.schedule.timeZone ?? "UTC",
            nextRunAt: taskScheduleNextRunAt({ ...input.schedule, timeZone: input.schedule.timeZone ?? "UTC" }, input.status ?? "OPEN", Date.now()),
            lastRunAt: null, lastOutcome: null } : null
        };
        this.fixture.taskItems.unshift(item);
        return Promise.resolve(structuredClone(item));
      }
      case "updateTaskItem": {
        const task = this.fixture.taskItems.find((candidate) => candidate.id === roomId);
        if (!task) throw new SpaceApiError("Task not found.", { status: 404, code: "NOT_FOUND" });
        const { schedule: _schedule, ...changes } = args[1] as Partial<TaskItem>;
        Object.assign(task, changes, {
          characterCount: "objective" in (args[1] as { objective?: string })
            ? Array.from((args[1] as { objective: string }).objective).length
            : task.characterCount,
          lastUsedAt: DEMO_FIXED_AT
        });
        if (task.schedule) task.schedule = { ...task.schedule, nextRunAt: taskScheduleNextRunAt(task.schedule, task.status, Date.now(), task.schedule) };
        return Promise.resolve(structuredClone(task));
      }
      case "deleteTaskItem": if (this.publicMock) this.fixture.taskItems = this.fixture.taskItems.filter(item => item.id !== roomId); return Promise.resolve({ id: roomId!, deleted: true as const });
      case "clearTaskItems": { const deletedCount = this.publicMock ? this.fixture.taskItems.length : 0; if (this.publicMock) this.fixture.taskItems = []; return Promise.resolve({ deletedCount }); }
      case "createRoom": {
        if (this.fixture.rooms.length >= MAX_ROOMS) {
          throw new SpaceApiError(`Maximum room limit (${MAX_ROOMS}) reached.`, { status: 409, code: "ROOM_LIMIT_REACHED" });
        }
        const name = String(args[0] ?? "").trim() || pickNextAvailableRoomName(this.fixture.rooms.map((r) => r.name));
        const initialPaneCount = Math.min(16, Math.max(0, Number(args[1] ?? 4)));
        const id = this.nextId("room");
        const room = { ...this.fixture.rooms[0]!, id, name, order: this.fixture.rooms.length, paneLayoutColumns: null, paneLayoutHeight: 1 as const, traceId: this.nextId("trace") };
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
        const input = args[1] as { paneLayoutColumns?: Room["paneLayoutColumns"]; paneLayoutHeight?: Room["paneLayoutHeight"] };
        if (input.paneLayoutColumns !== undefined) room.paneLayoutColumns = input.paneLayoutColumns;
        if (input.paneLayoutHeight !== undefined) room.paneLayoutHeight = input.paneLayoutHeight;
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
          if (item.mode === "VNC") {
            return this.addPane(targetRoomId, `VNC ${finalNumber}`, "VNC", {
              vncTarget: item.vncTarget
            });
          }
          if (item.mode === "HARNESS") {
            return this.addPane(targetRoomId, `Harness ${finalNumber}`, "HARNESS", {});
          }
          if (item.mode === "BROWSER" || item.mode === "YOUTUBE") {
            return this.addPane(targetRoomId, `${item.mode === "BROWSER" ? "Browser" : "YouTube"} ${finalNumber}`, item.mode, {});
          }
          if (item.mode === "LIVE") {
            return this.addPane(targetRoomId, `Live ${finalNumber}`, "LIVE", {});
          }
          if (item.mode === "FILES") {
            return this.addPane(targetRoomId, `Files ${finalNumber}`, "FILES", {});
          }
          if (item.mode === "DEMOS") {
            return this.addPane(targetRoomId, `Demo Projects ${finalNumber}`, "DEMOS", {});
          }
          const runtimeName = item.mode === "TERMINAL" ? cliRuntimeLabel(item.terminalRuntimeId)! : "Terminal";
          return this.addPane(targetRoomId, `${runtimeName} ${finalNumber}`, "TERMINAL", {
            cwd: "/etc",
            terminalRuntimeId: item.mode === "TERMINAL" ? item.terminalRuntimeId : undefined
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
        const sourceRoomId = pane.roomId;
        const sourcePane = structuredClone(pane);
        pane.roomId = String(args[1]);
        pane.order = this.fixture.panes.filter((candidate) => candidate.roomId === pane.roomId).length - 1;
        return Promise.resolve({ pane: structuredClone(pane), sourcePane, targetPane: structuredClone(pane), sourceRoom: structuredClone(this.fixture.rooms.find(r => r.id === sourceRoomId)), targetRoom: structuredClone(this.fixture.rooms.find(r => r.id === pane.roomId)), sourceRoomId, targetRoomId: pane.roomId });
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
      // The public demo has no managed T3 Code service; report that honestly.
      case "t3CodeStatus": return Promise.resolve({
        version: 1, enabled: false, state: "disabled", runtime: null, environmentId: null, workspaceAllowed: true, checkedAt: DEMO_FIXED_AT,
        capabilities: { paneBindings: false, selectionMessages: false, draftIsolation: false, orchestration: false, serviceControl: false }
      });
      case "t3CodeBinding": return Promise.resolve({ version: 1, paneId: String(args[0]), metadata: null });
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
      case "cliAccountIdentities": return Promise.resolve({
        accounts: (["cli:gemini", "cli:claude", "cli:copilot", "cli:cursor"] as const).map((runtimeId) => ({
          runtimeId,
          profileId: "main",
          displayName: "Main account",
          email: null,
          authStatus: "NOT_CONNECTED" as const
        })),
        checkedAt: DEMO_FIXED_AT
      });
      // The demo keeps no CLI history; answer with the real response shape so the Sessions dock shows its empty state.
      case "agentSessions": return Promise.resolve({ data: [], totalItems: 0, visibleItems: 0, checkedAt: DEMO_FIXED_AT });
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
      split: options.split ?? { parentId: null, direction: null, size: null }, categoryColor: null,
      vncTarget: options.vncTarget ?? null, createdAt: DEMO_FIXED_AT, updatedAt: DEMO_FIXED_AT
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

  private demoCliUpdatesApplied = false;
  private demoCliUpdateDetection() {
    const updated = this.demoCliUpdatesApplied;
    const entry = (key: string, displayName: string, installed: string, available: string, custom: Array<{ kind: string; path: string; label: string }> = []) => ({
      key, cliType: `cli:${key}`, displayName, managed: true, updateKind: "npm", enabled: true,
      hasCustom: custom.length > 0, custom: custom.map((item) => ({ ...item, present: true })),
      installedVersion: updated ? available : installed, availableVersion: available, updateAvailable: !updated && installed !== available
    });
    return {
      schemaVersion: "space.cli-update-all.detection.v1" as const,
      detectedAt: DEMO_FIXED_AT,
      cliTypes: [
        entry("codex", "Codex CLI", "0.162.1", "0.162.1"),
        entry("claude", "Claude Code CLI", "2.1.296", "2.1.300", [
          { kind: "config", path: "/opt/spaceapp/deploy/claude-space-settings.json", label: "Claude Space settings overlay" },
          { kind: "mcp", path: "/opt/spaceapp/deploy/claude-space-mcp.json", label: "Claude Space MCP config" }
        ]),
        entry("qwen", "Qwen Code CLI", "0.23.2-space.1", "0.23.2-space.1", [
          { kind: "script", path: "/opt/spaceapp/scripts/patch-qwen-distribution.mjs", label: "Qwen Space patch (distribution)" }
        ]),
        { ...entry("hermes", "Hermes Agent CLI", "0.21.0", "0.21.0"), managed: false, updateKind: "not-managed" }
      ]
    };
  }
  private demoMaintenanceSchedule: MaintenanceAutopilotStatus["schedule"] = { enabled: false, hour: 4, timeZone: "UTC", nextRunAt: null };
  private demoMaintenanceLastRun: MaintenanceAutopilotStatus["lastRun"] = null;
  private demoMaintenanceAutopilotStatus(): MaintenanceAutopilotStatus {
    return structuredClone({ schedule: this.demoMaintenanceSchedule, currentRun: null, lastRun: this.demoMaintenanceLastRun, checkedAt: DEMO_FIXED_AT });
  }
  private demoGatewaySettings = {
    routingStrategy: "CAPACITY_WEIGHTED" as const, stickyThreadsEnabled: true, preferEarlierReset: false, planPriority: ["plus", "prolite", "pro"],
    stickyReallocationBudgetThresholdPercent: 95, exhaustionFloorPercent: 3, compressionMode: "OFF" as const, compressionProfile: "TOKEN" as const, compressionCodeText: "ON" as const,
    compressionTimeBudgetMs: 250, compressionProviders: {}, requestLogRetentionDays: 30, displayTimeFormat: "24H" as const, displayAccountWindows: "BOTH" as const,
    displayBurnProjection: true, upstreamStreamTransport: "DEFAULT" as const, promptCacheTtlSeconds: 1800, importWithoutOverwrite: true, warmupEnabled: false,
    warmupWindows: "BOTH" as const, warmupModel: "auto", warmupPrompt: "Say OK.", warmupCooldownSeconds: 3600, warmupMinAvailablePercent: 100, claudeApiKeyFallback: false,
    lanMode: "ENV" as const, lanHost: null, lanPort: null, lanAllowedSources: [] as string[], updatedAt: DEMO_FIXED_AT
  };

  private demoHeadroomSession() {
    const timing = { averageMs: null, p50Ms: null, p95Ms: null, minMs: null, maxMs: null, samples: 0 };
    return {
      since: DEMO_FIXED_AT, generatedAt: DEMO_FIXED_AT, compressionMode: "OFF" as const, sampled: false,
      requests: { total: 0, completed: 0, failed: 0, rateLimited: 0, cached: 0 }, live: { activeRequests: 0, activeWebSockets: 0, relayTasks: 0, compressionQueue: 0 },
      tokens: { input: 0, output: 0, cachedInput: 0, cacheWrites: 0, compressedBefore: 0, compressedAfter: 0, saved: 0, shadowSaved: 0, savingsPercent: 0, activeSavingsPercent: 0 },
      performance: { overhead: timing, ttfb: timing, latency: timing, throughput: { forwardP50: null, forwardP95: null, generationP50: null, generationP95: null }, stages: [] },
      waste: [], savingsOverTime: [],
      prefixCache: { requests: 0, hitRequests: 0, readTokens: 0, writeTokens: 0, uncachedTokens: 0, hitRatePercent: 0, busts: 0, bustTokens: 0, savedUsd: 0, writePremiumUsd: 0,
        netUsd: 0, byProvider: [], misses: { ttlExpiry: 0, accountSwitch: 0, prefixChange: 0 } },
      compressionVsCache: { savedTokens: 0, lostToBustTokens: 0, netTokens: 0 }, agents: [], providers: [], models: [], recent: [], rateLimits: [], poolWeekly: null
    };
  }

  private demoHeadroomLifetime() {
    return {
      since: null, generatedAt: DEMO_FIXED_AT, requests: { total: 0, completed: 0, failed: 0, rateLimited: 0, cached: 0 },
      tokens: { input: 0, output: 0, attemptedInput: 0, saved: 0, shadowSaved: 0, savingsPercent: null },
      cost: { apiCostUsd: 0, compressionSavedUsd: 0, cacheSavedUsd: 0, unpricedRequests: 0 },
      prefixCache: { requests: 0, cachedRequests: 0, hitRatePercent: null, readTokens: 0, writeTokens: 0, busts: 0, bustTokens: 0, ttlMinutes: 5 },
      misses: { ttlExpiry: 0, accountSwitch: 0, prefixChange: 0 }, waste: [], providers: [], clients: [], models: [], projects: []
    };
  }

  private demoGatewayDashboard(range: string) {
    const timing = { samples: 0, averageMs: null, p50Ms: null, p95Ms: null };
    const totals = { key: "total", requests: 0, errors: 0, rateLimited: 0, inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0,
      reasoningTokens: 0, costUsd: 0, compressionTokensSaved: 0, latency: timing, ttft: timing, lastAt: null };
    const errors = (minutes: number) => ({ minutes, requests: 0, errors: 0, errorRate: null, topError: null });
    return {
      range, from: DEMO_FIXED_AT, to: DEMO_FIXED_AT, bucketSeconds: 3600, generatedAt: DEMO_FIXED_AT, totals,
      perPeriod: { unit: "hour" as const, requests: 0, costUsd: 0, tokens: 0 }, errorRate: errors(1440), errorRate7d: errors(10_080), errorRate5m: errors(5),
      trend: [], topKeys: [], topModels: [], latencyByModel: [], routes: [], pools: [], live: [], recent: []
    };
  }

  private demoGatewayStatus() {
    return {
      service: { state: "RUNNING" as const, version: "demo", startedAt: DEMO_FIXED_AT, inFlightRequests: 0, listen: "127.0.0.1:4920", error: null },
      accounts: { total: 0, active: 0, byProvider: [] },
      apiKeys: { total: 0, active: 0 },
      last24h: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, compressionTokensSaved: 0 },
      settings: structuredClone(this.demoGatewaySettings),
      checkedAt: DEMO_FIXED_AT
    };
  }

  private fallback(method: string): unknown {
    if (this.publicMock && typeof window !== "undefined") {
      const record = window as Window & { __spaceMockMissingMethods?: string[] };
      record.__spaceMockMissingMethods = [...new Set([...(record.__spaceMockMissingMethods ?? []), method])];
    }
    if (method.startsWith("create") || method.startsWith("update") || method.startsWith("delete") || method.startsWith("execute") || method.startsWith("restart") || method.startsWith("reclaim") || method.startsWith("switch") || method.startsWith("reap")) {
      return { ok: true, status: "SIMULATED", message: DEMO_LOCAL_REPLY, updatedAt: DEMO_FIXED_AT, data: [] };
    }
    return { data: [], pagination: paginated([]).pagination, status: "SIMULATED", statusReason: DEMO_LOCAL_REPLY };
  }
}
