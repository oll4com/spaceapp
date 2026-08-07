import type {
  AgentPaneToolOption,
  Artifact,
  AuthMe,
  ClipboardItem,
  TaskItem,
  CliSessionReapResponse,
  CliSessionStats,
  CodexCliModeDefaultsResponse,
  CodexAppServerHandshakeCheck,
  CodexAppServerStatus,
  CodexAppServerTurnSmokeCheck,
  CodexEnvironment,
  CodexHistoryPurgePreviewResponse,
  CodexHistoryPurgeResponse,
  CodexLbSpeedDefaultsResponse,
  CodexResetCreditAvailability,
  CodexUsageAccountList,
  Event,
  HostMemoryDetails,
  LaunchReadiness,
  McpDiscoverySmokeCheck,
  McpGatewayStatus,
  McpToolExecutionResult,
  MemoryEmbeddingSmokeCheck,
  MemoryChangeSet,
  MemoryConsolidationCommandResponse,
  MemoryConsolidationDetail,
  MemoryGraphIssue,
  MemoryGraphNodeDetail,
  MemoryGraphPayload,
  MemoryReclaimResponse,
  MemoryVectorReadiness,
  Model,
  ObservabilitySnapshot,
  Pane,
  Provider,
  ProviderSettings,
  ProviderSwitchResponse,
  ProviderSwitchTargets,
  Room,
  Skill,
  StorageReadiness,
  SwarmState,
  TelegramIntegrationStatus,
  Turn,
  UserLink,
  VoiceTranscriptionSettings,
  WorkerReadiness
} from "@space/contracts";
import type { ServiceRestartResponse } from "../live-api.js";
import { DEMO_LOCAL_REPLY } from "../runtime/SpaceRuntime.js";

export const DEMO_FIXTURE_VERSION = "space-demo-v1" as const;
export const DEMO_FIXED_AT = "2026-07-18T12:00:00.000Z";

export type DemoFixture = {
  agentToolOptions: AgentPaneToolOption[];
  artifacts: Artifact[];
  auth: AuthMe;
  clipboardItems: ClipboardItem[];
  taskItems: TaskItem[];
  links: UserLink[];
  rooms: Room[];
  panes: Pane[];
  turns: Turn[];
  events: Event[];
  providers: Provider[];
  providerSettings: ProviderSettings;
  codexCliModeDefaults: CodexCliModeDefaultsResponse;
  telegramIntegration: TelegramIntegrationStatus;
  voiceTranscriptionSettings: VoiceTranscriptionSettings;
  models: Model[];
  skills: Skill[];
  codexEnvironment: CodexEnvironment;
  codexUsageAccounts: CodexUsageAccountList;
  codexResetCredits: CodexResetCreditAvailability;
  cliSessionStats: CliSessionStats;
  cliSessionReap: CliSessionReapResponse;
  hostMemoryDetails: HostMemoryDetails;
  memoryReclaim: MemoryReclaimResponse;
  providerSwitchTargets: ProviderSwitchTargets;
  providerSwitch: ProviderSwitchResponse;
  codexLbSpeedDefaults: CodexLbSpeedDefaultsResponse;
  adminDiagnostics: {
    mcpGateway: McpGatewayStatus;
    mcpDiscoverySmoke: McpDiscoverySmokeCheck;
    memoryEmbeddingSmoke: MemoryEmbeddingSmokeCheck;
    memoryVectorReadiness: MemoryVectorReadiness;
    codexAppServer: CodexAppServerStatus;
    codexAppServerHandshake: CodexAppServerHandshakeCheck;
    codexAppServerTurnSmoke: CodexAppServerTurnSmokeCheck;
    mcpToolExecution: McpToolExecutionResult;
    historyPurgePreview: CodexHistoryPurgePreviewResponse;
    historyPurgeResult: CodexHistoryPurgeResponse;
    serviceRestart: ServiceRestartResponse;
    observability: ObservabilitySnapshot;
    worker: WorkerReadiness;
  };
  memoryWorkspace: {
    graph: MemoryGraphPayload;
    issues: MemoryGraphIssue[];
    nodeDetails: Record<string, MemoryGraphNodeDetail>;
    changeSets: MemoryChangeSet[];
    maintenanceCommand: MemoryConsolidationCommandResponse;
    maintenanceDetail: MemoryConsolidationDetail;
  };
  storageReadiness: StorageReadiness;
  launchReadiness: LaunchReadiness;
  swarm: Record<string, SwarmState>;
};

function pane(input: Pick<Pane, "id" | "roomId" | "title" | "mode" | "order"> & Partial<Pane>): Pane {
  return {
    status: "IDLE",
    providerId: input.mode === "CHAT" ? "demo-codex" : null,
    modelId: input.mode === "CHAT" ? "gpt-5.6-sol" : null,
    terminalRuntimeId: input.mode === "TERMINAL" ? "codex" : null,
    reasoningEffort: "high",
    cwd: input.mode === "TERMINAL" ? "/workspace/space-demo" : null,
    columnSpan: 1,
    isMaximized: false,
    isMinimized: false,
    isClosed: false,
    split: { parentId: null, direction: null, size: null },
    createdAt: DEMO_FIXED_AT,
    updatedAt: DEMO_FIXED_AT,
    ...input
  };
}

function createDemoMemoryWorkspace(): DemoFixture["memoryWorkspace"] {
  const sourcePath = "/demo/memory/public-launch.md";
  const sourceHash = "a".repeat(64);
  const beforeHash = "b".repeat(64);
  const afterHash = "c".repeat(64);
  const sourceNode = {
    id: "source:demo-public-launch",
    type: "SOURCE" as const,
    label: "Sanitized public launch notes",
    sourcePath,
    recordId: null,
    position: { clustered: { x: -18, y: 6 }, relations: { x: -24, y: 0 } }
  };
  const memoryNode = {
    id: "memory:demo-public-launch",
    type: "MEMORY" as const,
    label: "Public launch workspace",
    sourcePath,
    recordId: "memory:demo-public-launch",
    position: { clustered: { x: 4, y: 2 }, relations: { x: 2, y: 0 } }
  };
  const topicNode = {
    id: "topic:demo-parity",
    type: "TOPIC" as const,
    label: "ui parity",
    sourcePath,
    recordId: null,
    position: { clustered: { x: 14, y: -12 }, relations: { x: 22, y: -8 } }
  };
  const juneSourcePath = "/demo/memory/gemini_history_2026-06.md";
  const julySourcePath = "/demo/memory/gemini_history_2026-07.md";
  const juneSourceNode = {
    id: "source:demo-gemini-history-2026-06",
    type: "SOURCE" as const,
    label: "gemini_history_2026-06.md",
    sourcePath: juneSourcePath,
    recordId: null,
    position: { clustered: { x: -34, y: -26 }, relations: { x: -40, y: -20 } }
  };
  const julySourceNode = {
    id: "source:demo-gemini-history-2026-07",
    type: "SOURCE" as const,
    label: "gemini_history_2026-07.md",
    sourcePath: julySourcePath,
    recordId: null,
    position: { clustered: { x: 30, y: 18 }, relations: { x: 36, y: 16 } }
  };
  const juneMemoryNode = {
    id: "memory:demo-gemini-history-2026-06",
    type: "MEMORY" as const,
    label: "June canonical memory",
    sourcePath: juneSourcePath,
    recordId: "memory:demo-gemini-history-2026-06",
    position: { clustered: { x: -28, y: -18 }, relations: { x: -30, y: -14 } }
  };
  const julyMemoryNode = {
    id: "memory:demo-gemini-history-2026-07",
    type: "MEMORY" as const,
    label: "July canonical memory",
    sourcePath: julySourcePath,
    recordId: "memory:demo-gemini-history-2026-07",
    position: { clustered: { x: 24, y: 12 }, relations: { x: 28, y: 10 } }
  };
  const edges = [
    { id: "memory_edge:demo-source", type: "CONTAINS" as const, source: sourceNode.id, target: memoryNode.id },
    {
      id: "memory_edge:demo-topic",
      type: "TAGGED_WITH" as const,
      source: memoryNode.id,
      target: topicNode.id,
      origin: "EXPLICIT_TAG" as const,
      confidence: 1,
      evidence: "Sanitized fixture tag: ui parity."
    },
    { id: "memory_edge:demo-june-source", type: "CONTAINS" as const, source: juneSourceNode.id, target: juneMemoryNode.id },
    { id: "memory_edge:demo-july-source", type: "CONTAINS" as const, source: julySourceNode.id, target: julyMemoryNode.id }
  ];
  const issue: MemoryGraphIssue = {
    id: "memory_issue:demo-review",
    type: "STALE",
    severity: "INFO",
    status: "OPEN",
    confidence: 0.82,
    recordId: memoryNode.recordId,
    sourcePath,
    evidence: "Demo snapshot retains one reviewable issue.",
    statusReason: DEMO_LOCAL_REPLY,
    stateVersion: 1,
    stateUpdatedAt: DEMO_FIXED_AT
  };
  const record = {
    id: memoryNode.recordId,
    sourcePath,
    sectionId: "section:demo-public-launch",
    title: memoryNode.label,
    body: "## Public launch workspace\n- Sanitized fixture content for local Memory workspace exploration.",
    createdAt: DEMO_FIXED_AT,
    scope: "ROOM" as const,
    roomId: "room:demo-launch",
    provenance: "Deterministic public demo fixture.",
    contentHash: beforeHash,
    lifecycleStatus: "ACTIVE" as const,
    tags: ["ui parity"],
    topics: [{ label: "workspace parity", origin: "DERIVED_TFIDF" as const, confidence: 0.86 }]
  };
  const detail: MemoryGraphNodeDetail = {
    node: memoryNode,
    record,
    relatedNodes: [sourceNode, topicNode],
    relatedEdges: edges,
    issues: [issue]
  };
  const structuralDetail = (node: typeof sourceNode | typeof topicNode): MemoryGraphNodeDetail => ({
    node,
    record: null,
    relatedNodes: [memoryNode],
    relatedEdges: edges.filter((edge) => edge.source === node.id || edge.target === node.id),
    issues: []
  });
  const monthlyMemoryDetail = (node: typeof juneMemoryNode | typeof julyMemoryNode): MemoryGraphNodeDetail => ({
    node,
    record: null,
    relatedNodes: [],
    relatedEdges: edges.filter((edge) => edge.source === node.id || edge.target === node.id),
    issues: []
  });
  const monthlySourceDetail = (node: typeof juneSourceNode | typeof julySourceNode): MemoryGraphNodeDetail => ({
    node,
    record: null,
    relatedNodes: [node.id === juneSourceNode.id ? juneMemoryNode : julyMemoryNode],
    relatedEdges: edges.filter((edge) => edge.source === node.id || edge.target === node.id),
    issues: []
  });
  const changeSet: MemoryChangeSet = {
    id: "memory_change:demo-public-launch",
    kind: "EDIT",
    status: "PROPOSED",
    sourcePath,
    recordIds: [memoryNode.recordId],
    resolvesIssueIds: [issue.id],
    expectedSourceHash: sourceHash,
    resultingSourceHash: null,
    beforeContentHash: beforeHash,
    afterContentHash: afterHash,
    reason: "Review the sanitized public launch memory wording.",
    statusReason: DEMO_LOCAL_REPLY,
    actorUserId: "user:demo-admin",
    traceId: "trace:demo-memory-change",
    rollbackOfChangeSetId: null,
    rolledBackByChangeSetId: null,
    createdAt: DEMO_FIXED_AT,
    updatedAt: DEMO_FIXED_AT,
    appliedAt: null,
    failedAt: null,
    rolledBackAt: null,
    beforeSnapshot: record.body,
    afterSnapshot: `${record.body}\n- Public wording reviewed locally.`
  };
  const maintenanceRun: MemoryConsolidationDetail["run"] = {
    id: "memory_consolidation:demo-local",
    mode: "AUDIT",
    triggerKind: "OPERATOR",
    status: "SUCCEEDED",
    workflowId: "memory_workflow:demo-local",
    dedupeKey: "memory-audit:demo-local",
    sourceHash,
    actorUserId: "user:demo-admin",
    progressCompleted: 1,
    progressTotal: 1,
    findingCount: 0,
    appliedOperationCount: 0,
    skippedOperationCount: 0,
    failedOperationCount: 0,
    metrics: {},
    modelId: null,
    aiVerified: false,
    aiEvidence: {},
    statusReason: DEMO_LOCAL_REPLY,
    createdAt: DEMO_FIXED_AT,
    startedAt: DEMO_FIXED_AT,
    completedAt: DEMO_FIXED_AT,
    updatedAt: DEMO_FIXED_AT
  };
  const maintenanceDetail: MemoryConsolidationDetail = {
    run: maintenanceRun,
    findings: [],
    operations: [],
    maintenanceEnabled: true,
    mutationsEnabled: false
  };
  return {
    graph: {
      version: 2,
      generatedAt: DEMO_FIXED_AT,
      sourceHash,
      revisionHash: "d".repeat(64),
      isStale: false,
      summary: { sourceCount: 3, recordCount: 3, nodeCount: 7, edgeCount: 4, issueCount: 1 },
      nodes: [sourceNode, memoryNode, topicNode, juneSourceNode, juneMemoryNode, julySourceNode, julyMemoryNode],
      edges,
      layoutVersion: 2,
      taxonomyVersion: 2,
      filters: {
        q: null,
        nodeType: null,
        scope: null,
        roomId: null,
        sourcePath: null,
        lifecycleStatus: null,
        relationMode: "RELATIONS",
        month: null
      },
      months: ["2026-06", "2026-07"]
    },
    issues: [issue],
    nodeDetails: {
      [sourceNode.id]: structuralDetail(sourceNode),
      [memoryNode.id]: detail,
      [topicNode.id]: structuralDetail(topicNode),
      [juneSourceNode.id]: monthlySourceDetail(juneSourceNode),
      [juneMemoryNode.id]: monthlyMemoryDetail(juneMemoryNode),
      [julySourceNode.id]: monthlySourceDetail(julySourceNode),
      [julyMemoryNode.id]: monthlyMemoryDetail(julyMemoryNode)
    },
    changeSets: [changeSet],
    maintenanceCommand: {
      run: maintenanceRun,
      schedule: { status: "SCHEDULED", workflowId: maintenanceRun.workflowId, runId: null },
      maintenanceEnabled: true,
      mutationsEnabled: false
    },
    maintenanceDetail
  };
}

export function createDemoFixture(): DemoFixture {
  const rooms: Room[] = [
    {
      id: "room:demo-launch",
      name: "Launch Control",
      description: "Sanitized product launch workspace.",
      kind: "WORKSPACE",
      order: 0,
      paneLayoutColumns: 3,
      createdAt: DEMO_FIXED_AT,
      updatedAt: DEMO_FIXED_AT,
      archivedAt: null,
      paneCap: 16,
      traceId: "demo-fixture-launch"
    },
    {
      id: "room:demo-research",
      name: "Research Lab",
      description: "Public research and browser fixtures.",
      kind: "WORKSPACE",
      order: 1,
      paneLayoutColumns: 2,
      createdAt: DEMO_FIXED_AT,
      updatedAt: DEMO_FIXED_AT,
      archivedAt: null,
      paneCap: 16,
      traceId: "demo-fixture-research"
    },
    {
      id: "room:demo-ops",
      name: "Operations",
      description: "Local-only diagnostics fixtures.",
      kind: "WORKSPACE",
      order: 2,
      paneLayoutColumns: 2,
      createdAt: DEMO_FIXED_AT,
      updatedAt: DEMO_FIXED_AT,
      archivedAt: null,
      paneCap: 16,
      traceId: "demo-fixture-ops"
    }
  ];
  const panes: Pane[] = [
    pane({ id: "pane:demo-chat", roomId: rooms[0]!.id, title: "Product Copilot", mode: "CHAT", order: 0 }),
    pane({ id: "pane:demo-codex", roomId: rooms[0]!.id, title: "Codex CLI", mode: "TERMINAL", order: 1 }),
    pane({ id: "pane:demo-browser", roomId: rooms[0]!.id, title: "Preview Browser", mode: "BROWSER", order: 2 }),
    pane({ id: "pane:demo-review", roomId: rooms[0]!.id, title: "Release Review", mode: "REVIEW", order: 3 }),
    pane({ id: "pane:demo-swarm", roomId: rooms[0]!.id, title: "Launch Swarm", mode: "SWARM", order: 4 }),
    pane({ id: "pane:demo-design", roomId: rooms[0]!.id, title: "Design Notes", mode: "DESIGN", order: 5 }),
    pane({ id: "pane:demo-root", roomId: rooms[0]!.id, title: "Root CLI", mode: "TERMINAL", order: 6, terminalRuntimeId: "root", isMinimized: true }),
    pane({ id: "pane:demo-research-chat", roomId: rooms[1]!.id, title: "Research Brief", mode: "CHAT", order: 0 }),
    pane({ id: "pane:demo-research-browser", roomId: rooms[1]!.id, title: "Sources", mode: "BROWSER", order: 1 }),
    pane({ id: "pane:demo-research-code", roomId: rooms[1]!.id, title: "Research Code", mode: "CODE", order: 2 }),
    pane({ id: "pane:demo-ops-health", roomId: rooms[2]!.id, title: "Health Review", mode: "REVIEW", order: 0 }),
    pane({ id: "pane:demo-ops-cli", roomId: rooms[2]!.id, title: "OpenCode CLI", mode: "TERMINAL", order: 1, terminalRuntimeId: "opencode" })
  ];
  const emptySwarm = (roomId: string): SwarmState => ({
    tasks: roomId === rooms[0]!.id ? [{
      id: "swarm_task:demo-launch",
      roomId,
      parentTaskId: null,
      role: "PLANNER",
      title: "Verify public launch",
      goal: "Review the sanitized launch fixture and report locally.",
      status: "RUNNING",
      assignee: "Demo planner",
      dependsOnTaskIds: [],
      lockIds: [],
      resultSummary: null,
      createdAt: DEMO_FIXED_AT,
      updatedAt: DEMO_FIXED_AT,
      completedAt: null
    }] : [],
    locks: [],
    messages: [],
    reconciles: [],
    executionStatus: "READY",
    statusReason: "Demo swarm state is simulated locally."
  });
  const clipboardSafetyText = "No production credential or customer data is included in this public demo.";
  return {
    agentToolOptions: [
      {
        id: "space-readonly:space_status",
        displayName: "Space status (demo)",
        description: "Shows deterministic local Space status without contacting a service.",
        category: "mcp",
        slug: "space_status",
        availability: "default_on",
        authType: null,
        authConnected: true,
        enabled: true,
        isAvailable: true,
        statusReason: "Local descriptor only; no tool execution is available.",
        isForceOn: false
      },
      {
        id: "space-readonly:space_logs",
        displayName: "Space logs (demo)",
        description: "Shows a sanitized local log fixture without reading production logs.",
        category: "mcp",
        slug: "space_logs",
        availability: "default_off",
        authType: null,
        authConnected: true,
        enabled: true,
        isAvailable: true,
        statusReason: "Local descriptor only; no tool execution is available.",
        isForceOn: false
      }
    ],
    artifacts: [
      {
        id: "artifact:demo-launch-image",
        roomId: rooms[0]!.id,
        paneId: "pane:demo-chat",
        turnId: null,
        workflowId: null,
        kind: "IMAGE",
        mimeType: "image/png",
        storageUri: "space-artifact://user-uploads/room%3Ademo-launch/2026-07-18/launch-preview.png",
        sha256: "1".repeat(64),
        byteSize: 4096,
        metadata: { source: "USER_UPLOAD", originalFilename: "launch-preview.png" },
        expiresAt: null,
        pinnedAt: DEMO_FIXED_AT,
        deletedAt: null,
        createdAt: "2026-07-18T11:45:00.000Z"
      },
      {
        id: "artifact:demo-launch-notes",
        roomId: rooms[0]!.id,
        paneId: "pane:demo-codex",
        turnId: null,
        workflowId: null,
        kind: "EXPORT",
        mimeType: "text/plain",
        storageUri: "space-artifact://cli-uploads/room%3Ademo-launch/pane%3Ademo-codex/demo/launch-notes.txt",
        sha256: "2".repeat(64),
        byteSize: 2048,
        metadata: { source: "USER_UPLOAD", originalFilename: "launch-notes.txt" },
        expiresAt: null,
        pinnedAt: null,
        deletedAt: null,
        createdAt: "2026-07-18T11:30:00.000Z"
      }
    ],
    auth: {
      user: { id: "user:demo-admin", email: "demo@spaceapp.dev", role: "ADMIN" },
      isAuthenticated: true,
      isSetupRequired: false
    },
    clipboardItems: [{
      id: "clipboard:demo-safety-note",
      text: clipboardSafetyText,
      source: "AGENT_NOTE",
      title: null,
      roomId: rooms[0]!.id,
      paneId: "pane:demo-chat",
      paneTitle: "Product Copilot",
      occurrenceCount: 1,
      characterCount: Array.from(clipboardSafetyText).length,
      createdAt: DEMO_FIXED_AT,
      lastUsedAt: DEMO_FIXED_AT
    }, {
      id: "clipboard:demo-plan",
      text: "# Demo rollout plan\n\n1. Enable the feature flag.\n2. Run scoped tests.\n3. Deploy and verify.",
      source: "PLAN",
      title: "Demo rollout plan",
      roomId: rooms[0]!.id,
      paneId: "pane:demo-chat",
      paneTitle: "Product Copilot",
      occurrenceCount: 1,
      characterCount: 98,
      createdAt: DEMO_FIXED_AT,
      lastUsedAt: DEMO_FIXED_AT
    }],
    taskItems: [{
      id: "task:demo-welcome",
      title: "Welcome task",
      objective: "Run the guided tour of this demo workspace.",
      status: "OPEN",
      source: "MANUAL",
      roomId: rooms[0]!.id,
      paneId: "pane:demo-chat",
      paneTitle: "Product Copilot",
      occurrenceCount: 1,
      characterCount: Array.from("Run the guided tour of this demo workspace.").length,
      createdAt: DEMO_FIXED_AT,
      lastUsedAt: DEMO_FIXED_AT
    }, {
      id: "task:demo-verify",
      title: "Verify release",
      objective: "Verify the release candidate passes readyz checks.",
      status: "RUNNING",
      source: "AGENT",
      roomId: rooms[0]!.id,
      paneId: "pane:demo-chat",
      paneTitle: "Product Copilot",
      occurrenceCount: 1,
      characterCount: Array.from("Verify the release candidate passes readyz checks.").length,
      createdAt: DEMO_FIXED_AT,
      lastUsedAt: DEMO_FIXED_AT
    }],
    links: [{
      id: "link:demo-space-guide",
      title: "Space Guide",
      description: "Explore the sanitized public workspace guide.",
      url: "https://demo.invalid/space-guide",
      openMode: "EMBEDDED",
      isQuick: true,
      sortOrder: 0,
      createdAt: DEMO_FIXED_AT,
      updatedAt: DEMO_FIXED_AT
    }],
    rooms,
    panes,
    turns: [],
    events: [{
      id: "event:demo-ready",
      roomId: rooms[0]!.id,
      paneId: null,
      turnId: null,
      workflowId: null,
      traceId: "demo-fixture-event",
      type: "CAPABILITY_STATUS_CHANGED",
      message: "Deterministic public demo fixture loaded locally.",
      payload: { fixtureVersion: DEMO_FIXTURE_VERSION },
      createdAt: DEMO_FIXED_AT
    }],
    providers: [
      {
        id: "demo-codex",
        displayName: "Codex Demo",
        type: "CODEX_LB",
        status: "VERIFIED",
        statusReason: "Local deterministic provider fixture.",
        healthCheckedAt: DEMO_FIXED_AT,
        maskedKeyPrefix: null,
        baseUrl: null,
        routeProfile: "headroom",
        backingProviderId: null,
        credentialRef: null,
        isBuiltIn: true
      },
      {
        id: "demo-direct",
        displayName: "Direct Demo",
        type: "OPENAI",
        status: "VERIFIED",
        statusReason: "Sanitized alternate provider fixture; no upstream is connected.",
        healthCheckedAt: DEMO_FIXED_AT,
        maskedKeyPrefix: null,
        baseUrl: null,
        routeProfile: "openai-direct",
        backingProviderId: null,
        credentialRef: null,
        isBuiltIn: true
      }
    ],
    providerSettings: {
      defaultProviderId: "demo-codex",
      titleGenerationModelId: "gpt-5.6-sol",
      titleGenerationReasoningEffort: "low",
      updatedAt: DEMO_FIXED_AT
    },
    codexCliModeDefaults: {
      defaults: {
        build: { modelId: "gpt-5.6-sol", reasoningEffort: "high" },
        plan: { modelId: "gpt-5.6-sol", reasoningEffort: "xhigh" },
        updatedAt: DEMO_FIXED_AT
      },
      catalog: {
        status: "AVAILABLE",
        models: [
          {
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            isDefault: true,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["medium", "high", "xhigh"]
          },
          {
            id: "gpt-5.6-mini",
            displayName: "GPT-5.6 Mini",
            isDefault: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium", "high"]
          }
        ],
        error: null
      }
    },
    telegramIntegration: {
      connectionStatus: "CONNECTED",
      isEnabled: true,
      botUsername: "space_demo_bot",
      chatDisplayName: "Demo Admin",
      pairingId: null,
      pairingExpiresAt: null,
      pairedAt: DEMO_FIXED_AT,
      enabledAt: DEMO_FIXED_AT,
      disabledAt: null,
      lastTestedAt: DEMO_FIXED_AT,
      lastDeliveredAt: DEMO_FIXED_AT,
      errorCode: null,
      errorAt: null,
      updatedAt: DEMO_FIXED_AT
    },
    voiceTranscriptionSettings: {
      enabled: false,
      statusReason: "Microphone capture stays disabled in the public demo.",
      defaultModel: "gpt-realtime-whisper",
      modelOptions: ["gpt-realtime-whisper", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"],
      defaultLanguage: "auto",
      languageOptions: ["auto", "el", "en"],
      defaultDelay: "low",
      delayOptions: ["minimal", "low", "medium", "high", "xhigh"],
      maxBytes: 25 * 1024 * 1024,
      maxDurationMs: 5 * 60 * 1000,
      updatedAt: DEMO_FIXED_AT
    },
    models: [{
      id: "gpt-5.6-sol",
      providerId: "demo-codex",
      runtimeId: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol (demo)",
      status: "VERIFIED",
      contextWindow: 400000,
      supportsTools: true,
      supportsVision: true,
      supportsRealtime: false,
      supportsReasoning: true,
      defaultReasoningEffort: "high"
    }],
    skills: [{
      id: "skill:demo-ui-review",
      displayName: "UI Review (demo)",
      version: "1.0.0",
      status: "VERIFIED",
      statusReason: "Sanitized fixture only.",
      triggerDescription: "Reviews local demo states.",
      body: "This public skill fixture cannot execute tools.",
      allowedTools: [],
      contentHash: `sha256:${"0".repeat(64)}`,
      source: "STATIC",
      createdAt: DEMO_FIXED_AT,
      updatedAt: DEMO_FIXED_AT
    }],
    codexEnvironment: {
      isCodexEnabled: true,
      codexHome: "/demo/codex-home",
      stateDbPath: "/demo/codex-home/state.sqlite",
      config: {
        modelProvider: "codex-lb",
        model: "gpt-5.6-sol",
        reasoningEffort: "high"
      },
      mcpServers: [],
      skillCount: 1,
      pluginCount: 0,
      memories: { generateMemories: false, useMemories: false },
      features: { plugins: false, memories: false },
      lbUsage: {
        allAccountsRemainingPercent: 84,
        activeAccountsRemainingPercent: 91,
        routeMode: "direct",
        routeTargetMode: "primary",
        upstream: "demo-local",
        source: "deterministic-fixture",
        error: null,
        checkedAt: DEMO_FIXED_AT
      },
      spaceStats: {
        roomCount: rooms.length,
        agentPaneCount: panes.length,
        activeAgentPaneCount: panes.filter((candidate) => !candidate.isMinimized).length,
        cliPaneCount: panes.filter((candidate) => candidate.mode === "TERMINAL").length,
        chatPaneCount: panes.filter((candidate) => candidate.mode === "CHAT").length,
        browserPaneCount: panes.filter((candidate) => candidate.mode === "BROWSER").length,
        checkedAt: DEMO_FIXED_AT
      },
      hostStats: {
        cliSessions: { active: 3, attached: 2, detached: 1, status: "OK" },
        cpu: { usagePercent: 18, coreCount: 16 },
        memory: { usedBytes: 12_884_901_888, totalBytes: 34_359_738_368, usagePercent: 38 },
        swap: { usedBytes: 268_435_456, totalBytes: 8_589_934_592, usagePercent: 3 },
        apiStartedAt: DEMO_FIXED_AT,
        sampledAt: DEMO_FIXED_AT
      },
      checkedAt: DEMO_FIXED_AT
    },
    codexUsageAccounts: {
      data: [{
        id: "account:demo-public",
        label: "Demo account",
        fiveHourRemainingPercent: 91,
        weeklyRemainingPercent: 84,
        weeklyResetAt: "2026-08-02T09:30:00.000Z",
        sampledAt: DEMO_FIXED_AT
      }],
      pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 },
      source: "deterministic-demo-fixture",
      isStale: false,
      error: null,
      checkedAt: DEMO_FIXED_AT
    },
    codexResetCredits: {
      data: [{ accountId: "account:demo-public", availableCreditCount: 2 }],
      source: "vm214-codex-lb",
      isStale: false,
      error: null,
      checkedAt: DEMO_FIXED_AT
    },
    cliSessionStats: {
      summary: { running: 3, attached: 2, detached: 1, cleanupEligible: 1 },
      sessions: [
        {
          sessionId: "cli_session:demo-codex",
          hostId: "main",
          runtimeId: "codex",
          roomId: "room:demo-launch",
          paneId: "pane:demo-codex",
          pid: 4101,
          status: "RUNNING",
          attachmentCount: 1,
          startedAt: DEMO_FIXED_AT,
          detachedAt: null,
          rssBytes: 402_653_184,
          cleanupEligible: false
        },
        {
          sessionId: "cli_session:demo-root",
          hostId: "root",
          runtimeId: "root",
          roomId: "room:demo-launch",
          paneId: "pane:demo-root",
          pid: 4102,
          status: "RUNNING",
          attachmentCount: 0,
          startedAt: DEMO_FIXED_AT,
          detachedAt: DEMO_FIXED_AT,
          rssBytes: 134_217_728,
          cleanupEligible: true
        },
        {
          sessionId: "cli_session:demo-opencode",
          hostId: "main",
          runtimeId: "opencode",
          roomId: "room:demo-ops",
          paneId: "pane:demo-ops-cli",
          pid: 4103,
          status: "RUNNING",
          attachmentCount: 1,
          startedAt: DEMO_FIXED_AT,
          detachedAt: null,
          rssBytes: 268_435_456,
          cleanupEligible: false
        }
      ],
      sampledAt: DEMO_FIXED_AT
    },
    cliSessionReap: {
      status: "NOOP",
      killedSessionIds: [],
      skippedCount: 1,
      estimatedReclaimedBytes: 0,
      completedAt: DEMO_FIXED_AT
    },
    hostMemoryDetails: {
      memory: {
        totalBytes: 34_359_738_368,
        usedBytes: 12_884_901_888,
        availableBytes: 21_474_836_480,
        usagePercent: 37.5,
        pageCacheBytes: 4_294_967_296,
        reclaimableBytes: 2_147_483_648
      },
      swap: { totalBytes: 8_589_934_592, usedBytes: 268_435_456, usagePercent: 3.125 },
      pressure: { isUnderPressure: false, availablePercent: 62.5, canDropPageCache: false },
      topProcesses: [
        {
          pid: 4201,
          name: "demo-space-web",
          taskTitle: null,
          rssBytes: 536_870_912,
          cpuPercent: 2.5,
          state: "S",
          isSpaceManaged: true,
          cleanupEligible: false
        },
        {
          pid: 4202,
          name: "opencode",
          taskTitle: "Demo opencode task",
          rssBytes: 402_653_184,
          cpuPercent: 1.25,
          state: "S",
          isSpaceManaged: true,
          cleanupEligible: false
        }
      ],
      topCpuProcesses: [
        {
          pid: 4203,
          name: "demo-renderer",
          taskTitle: null,
          rssBytes: 268_435_456,
          cpuPercent: 42,
          state: "R",
          isSpaceManaged: false,
          cleanupEligible: false
        },
        {
          pid: 4201,
          name: "demo-space-web",
          taskTitle: null,
          rssBytes: 536_870_912,
          cpuPercent: 2.5,
          state: "S",
          isSpaceManaged: true,
          cleanupEligible: false
        }
      ],
      sampledAt: DEMO_FIXED_AT
    },
    memoryReclaim: {
      status: "NOOP",
      cli: { killedSessionIds: [], estimatedReclaimedBytes: 0 },
      kernelCache: {
        status: "SKIPPED_LOW_PRESSURE",
        reclaimedBytes: 0,
        message: "Demo mode kept the deterministic memory fixture unchanged."
      },
      before: {
        totalBytes: 34_359_738_368,
        usedBytes: 12_884_901_888,
        availableBytes: 21_474_836_480,
        usagePercent: 37.5,
        pageCacheBytes: 4_294_967_296,
        reclaimableBytes: 2_147_483_648
      },
      after: {
        totalBytes: 34_359_738_368,
        usedBytes: 12_884_901_888,
        availableBytes: 21_474_836_480,
        usagePercent: 37.5,
        pageCacheBytes: 4_294_967_296,
        reclaimableBytes: 2_147_483_648
      },
      completedAt: DEMO_FIXED_AT
    },
    providerSwitchTargets: {
      data: [
        {
          providerId: "demo-direct-primary",
          displayName: "Direct demo route",
          isCurrent: true,
          canSwitch: true,
          health: "HEALTHY",
          reason: "Deterministic local route fixture."
        },
        {
          providerId: "demo-headroom",
          displayName: "Headroom demo route",
          isCurrent: false,
          canSwitch: true,
          health: "HEALTHY",
          reason: "Selection is simulated locally and does not change a production route."
        }
      ],
      pagination: { page: 1, pageSize: 2, totalItems: 2, totalPages: 1 },
      checkedAt: DEMO_FIXED_AT
    },
    providerSwitch: {
      status: "NOOP",
      previousProviderId: "demo-direct-primary",
      currentProviderId: "demo-direct-primary",
      routeMode: "direct",
      routeTargetMode: "primary",
      switchedAt: DEMO_FIXED_AT
    },
    codexLbSpeedDefaults: {
      models: [
        { modelId: "gpt-5.5", displayName: "GPT-5.5", tier: "STANDARD" },
        { modelId: "gpt-5.4", displayName: "GPT-5.4", tier: "STANDARD" }
      ],
      updatedAt: null,
      checkedAt: DEMO_FIXED_AT
    },
    adminDiagnostics: {
      mcpGateway: {
        id: "mcp-gateway",
        status: "DISABLED",
        statusReason: DEMO_LOCAL_REPLY,
        targetSpecVersion: "demo-v1",
        approvalMode: "DISABLED",
        serverCount: 0,
        toolCount: 0,
        lastDiscoveryAt: DEMO_FIXED_AT
      },
      mcpDiscoverySmoke: {
        id: "mcp-gateway",
        status: "DISABLED",
        code: "DISCOVERY_SMOKE_DISABLED",
        message: DEMO_LOCAL_REPLY,
        targetSpecVersion: "demo-v1",
        discoveryEnabled: false,
        serverCount: 0,
        toolCount: 0,
        startedAt: DEMO_FIXED_AT,
        finishedAt: DEMO_FIXED_AT,
        durationMs: 0,
        checkId: "mcp_check:demo-local",
        traceId: "trace:demo-mcp-smoke",
        actorUserId: "user:demo-admin",
        checkedAt: DEMO_FIXED_AT
      },
      memoryEmbeddingSmoke: {
        id: "memory-embedding-smoke",
        status: "DISABLED",
        code: "EMBEDDING_SMOKE_DISABLED",
        message: DEMO_LOCAL_REPLY,
        smokeEnabled: false,
        provider: null,
        model: null,
        dimensions: 1536,
        pgvectorReady: false,
        embeddingProviderReady: false,
        startedAt: DEMO_FIXED_AT,
        finishedAt: DEMO_FIXED_AT,
        durationMs: 0,
        checkId: "embedding_check:demo-local",
        traceId: "trace:demo-embedding-smoke",
        actorUserId: "user:demo-admin",
        checkedAt: DEMO_FIXED_AT
      },
      memoryVectorReadiness: {
        id: "memory-vector-readiness",
        status: "DISABLED",
        code: "VECTOR_STORE_NOT_POSTGRES",
        message: DEMO_LOCAL_REPLY,
        runtimeStore: "memory",
        extensionInstalled: false,
        extensionVersion: null,
        embeddingColumnReady: false,
        embeddingDimensions: null,
        expectedDimensions: 1536,
        vectorIndexReady: false,
        checkedAt: DEMO_FIXED_AT
      },
      codexAppServer: {
        id: "codex-app-server",
        status: "DISABLED",
        reasonCode: "DISABLED_BY_DEFAULT",
        statusReason: DEMO_LOCAL_REPLY,
        transport: "off",
        command: null,
        socketPath: null,
        websocketUrl: null,
        schemasGenerated: false,
        schemaManifest: null,
        lastCheckedAt: DEMO_FIXED_AT
      },
      codexAppServerHandshake: {
        id: "codex-app-server",
        status: "DISABLED",
        code: "ADAPTER_DISABLED",
        message: DEMO_LOCAL_REPLY,
        transport: "off",
        startedAt: DEMO_FIXED_AT,
        finishedAt: DEMO_FIXED_AT,
        durationMs: 0,
        serverInfo: null,
        checkId: "codex_handshake:demo-local",
        traceId: "trace:demo-codex-handshake",
        actorUserId: "user:demo-admin",
        schemasGenerated: false,
        schemaManifest: null,
        checkedAt: DEMO_FIXED_AT
      },
      codexAppServerTurnSmoke: {
        id: "codex-app-server",
        status: "DISABLED",
        code: "ADAPTER_DISABLED",
        message: DEMO_LOCAL_REPLY,
        transport: "off",
        startedAt: DEMO_FIXED_AT,
        finishedAt: DEMO_FIXED_AT,
        durationMs: 0,
        threadId: null,
        turnId: null,
        turnStatus: null,
        notificationCount: 0,
        completedNotificationSeen: false,
        checkId: "codex_turn_smoke:demo-local",
        traceId: "trace:demo-codex-turn-smoke",
        actorUserId: "user:demo-admin",
        schemasGenerated: false,
        schemaManifest: null,
        model: null,
        checkedAt: DEMO_FIXED_AT
      },
      mcpToolExecution: {
        id: "mcp-gateway",
        executionId: "mcp_execution:demo-local",
        status: "BLOCKED",
        code: "GATEWAY_DISABLED",
        message: DEMO_LOCAL_REPLY,
        toolId: "mcp-gateway:execution-gate-smoke",
        serverId: null,
        toolName: null,
        startedAt: DEMO_FIXED_AT,
        finishedAt: DEMO_FIXED_AT,
        durationMs: 0,
        policy: {
          decision: "BLOCKED",
          reasonCode: "GATEWAY_DISABLED",
          approvalRequired: false,
          canExecuteWithoutApproval: false
        },
        approved: false,
        artifact: null
      },
      historyPurgePreview: {
        status: "READY",
        previewId: "00000000-0000-4000-8000-000000000001",
        candidates: { threads: 12, cliTasks: 7, indexEntries: 10, rolloutFiles: 11, shellSnapshots: 4 },
        protectedThreads: 3,
        expiresAt: "2026-07-18T12:10:00.000Z",
        checkedAt: DEMO_FIXED_AT
      },
      historyPurgeResult: {
        status: "NOOP",
        previewId: "00000000-0000-4000-8000-000000000001",
        backupId: "00000000-0000-4000-8000-000000000002",
        purged: { threads: 0, cliTasks: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 },
        protectedThreads: 3,
        newlyProtectedThreads: 0,
        completedAt: DEMO_FIXED_AT
      },
      serviceRestart: {
        status: "ACCEPTED",
        scope: "CORE",
        services: ["space-worker.service", "space-api.service", "space-web.service"],
        requestedAt: DEMO_FIXED_AT,
        cooldownUntil: "2026-07-18T12:01:00.000Z",
        apiStartedAt: DEMO_FIXED_AT
      },
      observability: {
        service: "space-api",
        generatedAt: DEMO_FIXED_AT,
        runtime: {
          startedAt: DEMO_FIXED_AT,
          uptimeSeconds: 0,
          nodeVersion: "demo-local",
          pid: 1,
          memory: { rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0, externalBytes: 0, arrayBuffersBytes: 0 }
        },
        totals: { requestCount: 0, errorCount: 0, errorRate: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
        endpoints: []
      },
      worker: {
        id: "space-worker",
        status: "RUNNING",
        statusReason: "Deterministic local worker fixture; no production worker is connected.",
        address: "demo-local",
        namespace: "demo",
        taskQueue: "demo-local",
        reachable: false,
        workflowPollerCount: 0,
        activityPollerCount: 0,
        pollerCount: 0,
        workflowBacklogCount: 0,
        activityBacklogCount: 0,
        pollerIdentities: [],
        lastPollerAccessAt: null,
        checkedAt: DEMO_FIXED_AT
      }
    },
    memoryWorkspace: createDemoMemoryWorkspace(),
    storageReadiness: {
      id: "space-storage",
      status: "VERIFIED",
      statusReason: "Deterministic in-memory demo storage; no production volume is connected.",
      root: {
        path: "/demo",
        deviceId: "demo-memory",
        sizeBytes: 34_359_738_368,
        availableBytes: 17_179_869_184,
        usedPercent: 50
      },
      app: {
        path: "/demo/space",
        deviceId: "demo-memory",
        sizeBytes: 34_359_738_368,
        availableBytes: 17_179_869_184,
        usedPercent: 50
      },
      dedicatedAppVolume: true,
      minimumRecommendedFreeBytes: 10_737_418_240,
      checkedAt: DEMO_FIXED_AT
    },
    launchReadiness: {
      id: "launch-readiness",
      status: "READY",
      generatedAt: DEMO_FIXED_AT,
      completionPct: 100,
      passedCount: 3,
      totalCount: 3,
      hardBlockerCount: 0,
      gateCount: 0,
      summary: "All public demo readiness checks pass locally; production services remain intentionally disconnected.",
      requirements: [
        {
          id: "demo-local-runtime",
          label: "Local demo runtime",
          status: "PASS",
          severity: "none",
          message: "All demo state is held in deterministic browser memory.",
          evidence: [{ label: "space-demo-v1", ref: null }]
        },
        {
          id: "demo-network-isolation",
          label: "Network isolation",
          status: "PASS",
          severity: "none",
          message: "API, process, browser host and production service transports are disconnected.",
          evidence: [{ label: "strict CSP", ref: null }]
        },
        {
          id: "demo-shared-view",
          label: "Shared Space view",
          status: "PASS",
          severity: "none",
          message: "The demo renders the same presentational Space component tree.",
          evidence: [{ label: "SpaceAppView", ref: null }]
        }
      ]
    },
    swarm: Object.fromEntries(rooms.map((room) => [room.id, emptySwarm(room.id)]))
  };
}
