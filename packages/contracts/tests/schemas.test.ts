import { describe, expect, it } from "vitest";
import {
  artifactSchema,
  agentPaneBindingSchema,
  agentPaneGoalSchema,
  agentPaneGoalInputSchema,
  agentPanePermissionOptionSchema,
  agentPanePermissionStateSchema,
  agentRuntimeRegistrySchema,
  agentRuntimeSchema,
  agentPaneStoredSessionSchema,
  agentPaneToolOptionSchema,
  cliModelIdentifierSchema,
  browserFrameSchema,
  browserFrameTokenSchema,
  browserFrameWebSocketServerMessageSchema,
  browserCaptureJobSchema,
  browserCaptureCommandInputSchema,
  browserCaptureSegmentSchema,
  browserCaptureTimelineResponseSchema,
  browserControlLeaseSchema,
  browserDiagnosticsResponseSchema,
  browserHandoffRequestSchema,
  browserPageListResponseSchema,
  updateBrowserHandoffRequestInputSchema,
  spaceAgentBrowserActionBridgeRequestSchema,
  spaceAgentBrowserActionBridgeResponseSchema,
  spaceAgentBrowserActionEnvelopeSchema,
  spaceCliBrowserActionBridgeRequestSchema,
  spaceCliBrowserActionBridgeResponseSchema,
  spaceCliBrowserCommandRequestSchema,
  spaceCliBrowserContextResponseSchema,
  spaceCliBrowserSessionStartRequestSchema,
  spaceCliBrowserSessionStartResponseSchema,
  spaceAgentSkillActionBridgeResponseSchema,
  spaceAgentSkillActionEnvelopeSchema,
  spaceAgentMcpActionBridgeResponseSchema,
  spaceAgentMcpActionEnvelopeSchema,
  spaceAgentMemoryActionEnvelopeSchema,
  browserToolActionInputSchema,
  browserToolActionResultSchema,
  canStartAgentRuntimeLogin,
  cliLoginRequestSchema,
  coderAgentProxyRequestSchema,
  createAgentPaneSessionInputSchema,
  createPaneBrowserSessionInputSchema,
  createPaneBrowserSessionRequestSchema,
  createPaneCliSessionInputSchema,
  createPaneCliSessionRequestSchema,
  createPaneCliTranscriptChunkInputSchema,
  agentPaneSessionSchema,
  agentPaneSendMessageInputSchema,
  agentPaneSettingsInputSchema,
  createSpaceAgentMessageInputSchema,
  createSpaceAgentRunInputSchema,
  createSpaceAgentSessionInputSchema,
  upsertAgentPaneStoredSessionInputSchema,
  spaceAgentMessageRecordSchema,
  spaceAgentRunRecordSchema,
  spaceAgentSessionRecordSchema,
  codexAppServerHandshakeCheckSchema,
  codexAppServerHandshakeResultSchema,
  codexAppServerTurnSmokeCheckSchema,
  codexAppServerTurnSmokeInputSchema,
  codexAppServerTurnSmokeResultSchema,
  roomAgentMessageInputSchema,
  roomAgentControlInputSchema,
  roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema,
  roomAgentSessionSchema,
  spaceAgentRoomActionEnvelopeSchema,
  codexAppServerStatusSchema,
  codexEnvironmentSchema,
  serviceRestartRequestSchema,
  serviceRestartResponseSchema,
  codexHistoryResponseSchema,
  codexThreadQuerySchema,
  createArtifactInputSchema,
  createBrowserEvidenceInputSchema,
  createImportCandidateInputSchema,
  createMemoryEntryInputSchema,
  createMemoryChangeSetInputSchema,
  createMemoryNodeChangeSetInputSchema,
  createMemoryRollbackInputSchema,
  createMcpToolExecutionInputSchema,
  createReviewDecisionInputSchema,
  createReviewCheckInputSchema,
  createReviewDiffSummaryInputSchema,
  activeAgentTurnsInputSchema,
  createProofRoomInputSchema,
  createRoomInputSchema,
  createPaneInputSchema,
  proofRoomCliIdentitySchema,
  proofRoomSchema,
  redactPersistedTranscriptContent,
  roomCliActivityResponseSchema,
  roomSchema,
  reorderPanesInputSchema,
  reorderRoomsInputSchema,
  updatePaneLayoutInputSchema,
  updateRoomInputSchema,
  createSkillProposalInputSchema,
  createSwarmReconcileInputSchema,
  createSwarmTaskInputSchema,
  dummyTurnInputSchema,
  dummyTurnResultSchema,
  collaborationModeSchema,
  permissionModeSchema,
  createTurnInputSchema,
  eventTypeSchema,
  imageArtifactMaxBytes,
  imageArtifactMimeTypeSchema,
  importCandidateDecisionInputSchema,
  importCandidateSchema,
  isAgentRuntimeReady,
  listArtifactsQuerySchema,
  listImportCandidatesQuerySchema,
  listMemoryQuerySchema,
  listMemoryGraphQuerySchema,
  listMemoryGraphOverviewQuerySchema,
  listMemoryIssuesQuerySchema,
  listMemoryIssueStatesQuerySchema,
  listMemoryChangeSetsQuerySchema,
  listPanesQuerySchema,
  listReviewChecksQuerySchema,
  listReviewDecisionsQuerySchema,
  listReviewDiffSummariesQuerySchema,
  launchReadinessSchema,
  memoryEmbeddingSmokeCheckSchema,
  memoryEmbeddingSmokeResultSchema,
  memoryVectorReadinessSchema,
  memoryGraphPayloadSchema,
  memoryGraphOverviewPayloadSchema,
  memoryGraphNodeDetailSchema,
  memoryGraphSnapshotSchema,
  memoryGraphMonthSchema,
  memoryCacheLinkSchema,
  listMemoryCacheLinksQuerySchema,
  patchMemoryIssueInputSchema,
  upsertMemoryIssueStateInputSchema,
  memoryConsolidationRunSchema,
  createMemoryConsolidationInputSchema,
  createMemoryConsolidationFindingInputSchema,
  createMemoryConsolidationOperationInputSchema,
  memoryConsolidationCommandResponseSchema,
  memoryConsolidationDetailSchema,
  memoryConsolidationWorkflowInputSchema,
  memoryAiAuditResponseSchema,
  memoryAiAuditResultSchema,
  claimMemoryCommandInputSchema,
  memoryCommandIdempotencyKeySchema,
  memoryMaintenanceInputSchema,
  memoryMaintenanceResultSchema,
  memoryMutationExecutionResultSchema,
  memoryMutationJournalSchema,
  memoryMutationRecoveryResultSchema,
  memoryMutationWorkflowInputSchema,
  memoryMutationWorkflowResultSchema,
  memoryChangeSetSchema,
  memoryChangeSetCommandInputSchema,
  mcpDiscoverySmokeCheckSchema,
  mcpDiscoverySmokeResultSchema,
  mcpGatewayStatusSchema,
  observabilitySnapshotSchema,
  mcpServerConfigListSchema,
  mcpServerConfigSchema,
  mcpToolExecutionResultSchema,
  mcpServerSchema,
  mcpToolSchema,
  movePaneInputSchema,
  movePaneResultSchema,
  paneSchema,
  paneBrowserSessionResponseSchema,
  paneBrowserSessionSchema,
  paneCliModelSettingsSchema,
  paneCliModelSettingsStatusSchema,
  paneCliSessionResponseSchema,
  paneCliSessionSchema,
  paneCliTurnActivityResponseSchema,
  paneCliTranscriptChunkSchema,
  updateMemoryChangeSetInputSchema,
  paneCliUploadResponseSchema,
  paneCliWebSocketClientMessageSchema,
  paneCliWebSocketServerMessageSchema,
  paneCliWebSocketTokenSchema,
  updatePaneCliSessionInputSchema,
  updatePaneCliModelSettingsInputSchema,
  providerSchema,
  providerSettingsSchema,
  providerValidationResultSchema,
  claimSwarmLockInputSchema,
  postSwarmMessageInputSchema,
  releaseSwarmLockInputSchema,
  resumePaneCliSessionRequestSchema,
  resumePaneCliSessionResponseSchema,
  reviewCheckSchema,
  reviewDecisionSchema,
  reviewDiffSummarySchema,
  reviewRoomStateSchema,
  runSwarmTaskInputSchema,
  runSwarmTaskResponseSchema,
  browserEvidenceCaptureSchema,
  skillSchema,
  storageReadinessSchema,
  swarmLockSchema,
  swarmMessageSchema,
  swarmReconcileSchema,
  swarmStateSchema,
  swarmTaskSchema,
  turnStartResultSchema,
  turnRuntimeSchema,
  turnWorkflowResultSchema,
  updateSwarmTaskInputSchema,
  updatePaneInputSchema,
  workerReadinessSchema,
  paneCapabilityMatrixSchema,
  spaceCapabilitySnapshotSchema,
  workflowRunSchema,
  turnSchema,
  userUploadArtifactSourceSchema,
  buildCodexAppServerTurnWorkflowId,
  buildDummyTurnWorkflowId,
  buildRoomAgentSupervisorWorkflowId,
  turnArtifactMaxCount,
  updateProviderSettingsInputSchema
} from "../src/index.js";

describe("Space contracts", () => {
  it("defines deterministic restart-safe room supervisor workflow inputs", () => {
    const queued = roomAgentSupervisorQueueItemSchema.parse({
      missionId: "room_agent_mission:workflow-1",
      turn: {
        roomId: "room:workflow-1",
        paneId: "pane:room-agent-1",
        prompt: "Supervise this room until the requested work is complete.",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high",
        traceId: "room-agent-request-workflow-1"
      }
    });
    const input = roomAgentSupervisorInputSchema.parse({ roomId: queued.turn.roomId, pending: [queued] });

    expect(input.pending).toEqual([queued]);
    expect(buildRoomAgentSupervisorWorkflowId(input.roomId)).toBe("room-supervisor:room:workflow-1");
    const flexibleTurn = roomAgentSupervisorQueueItemSchema.parse({
      ...queued,
      turn: { ...queued.turn, modelId: "gpt-5.5" }
    });
    expect(flexibleTurn.turn.modelId).toBe("gpt-5.5");
    expect(() =>
      roomAgentSupervisorQueueItemSchema.parse({
        ...queued,
        missionId: ""
      })
    ).toThrow();
  });

  it("adds machine-readable room supervision evidence to completed turn results", () => {
    const result = turnWorkflowResultSchema.parse({
      workflowId: "workflow:room-agent-outcome",
      roomId: "room:room-agent-outcome",
      paneId: "pane:room-agent-outcome",
      traceId: "room-agent-outcome-request-0001",
      status: "COMPLETED",
      message: "The requested room work was verified.",
      roomAgentOutcome: {
        status: "VERIFIED",
        executedActionCount: 3,
        statusReason: "All mediated room actions completed and the final verification pass requested no further work."
      }
    });

    expect(result.roomAgentOutcome).toMatchObject({ status: "VERIFIED", executedActionCount: 3 });
    expect(() =>
      turnWorkflowResultSchema.parse({
        ...result,
        roomAgentOutcome: { status: "VERIFIED", executedActionCount: 0, statusReason: "No evidence." }
      })
    ).toThrow();
  });

  it("defines a fixed-model room agent session without configurable chat controls", () => {
    const session = roomAgentSessionSchema.parse({
      roomId: "room:room-agent-1",
      paneId: "pane:room-agent-1",
      sessionId: "agent_session:room-agent-1",
      threadId: null,
      status: "QUEUED",
      statusReason: "Mission queued.",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      messages: [],
      activeMission: null,
      queuedMissionCount: 1,
      currentPaneId: null,
      activePaneIds: ["pane:browser-upgrade"],
      progress: {
        totalSteps: 3,
        completedSteps: 1,
        runningSteps: 1,
        queuedSteps: 1,
        blockedSteps: 0,
        peakConcurrency: 2,
        elapsedMs: 42_000
      },
      capabilities: { canSend: true, canPause: true, canResume: false, canStop: true, canClear: true }
    });

    expect(session).toMatchObject({ modelId: "gpt-5.6-sol", reasoningEffort: "high", queuedMissionCount: 1 });
    expect(session).not.toHaveProperty("modelOptions");
    expect(session).not.toHaveProperty("permissionOptions");
    expect(session).not.toHaveProperty("history");
  });

  it("validates queued room-agent messages and allowlisted room controls", () => {
    expect(
      roomAgentMessageInputSchema.parse({
        content: "Complete the three related CLI panes in dependency order.",
        clientRequestId: "room-agent-request-0001"
      })
    ).toEqual({
      content: "Complete the three related CLI panes in dependency order.",
      clientRequestId: "room-agent-request-0001"
    });

    const envelope = spaceAgentRoomActionEnvelopeSchema.parse({
      version: 1,
      actions: [
        {
          toolId: "room:orchestrate",
          action: {
            type: "orchestrate",
            strategy: "AUTO_PARALLEL",
            analysisSummary: "The first two panes are independent; memory depends on the browser upgrade.",
            preparePanes: [{
              paneKey: "reviewer",
              title: "Reviewer CLI",
              mode: "TERMINAL",
              terminalRuntimeId: "cli:codex",
              modelId: "gpt-5.6-sol",
              reasoningEffort: "high"
            }],
            steps: [
              {
                stepId: "browser-upgrade",
                paneId: "pane:browser-upgrade",
                instruction: "Finish and verify the current task.",
                dependsOn: []
              },
              {
                stepId: "agent-memory",
                paneKey: "reviewer",
                instruction: "Implement the approved plan.",
                dependsOn: ["browser-upgrade"]
              }
            ]
          }
        },
        {
          toolId: "room:interrupt",
          action: { type: "interrupt", paneId: "pane:stuck-cli", reason: "No progress after recovery." }
        }
      ]
    });

    expect(envelope.actions).toHaveLength(2);
    expect(envelope.actions[0]).toMatchObject({
      action: {
        strategy: "AUTO_PARALLEL",
        preparePanes: [{ paneKey: "reviewer", reasoningEffort: "high" }],
        steps: [{ stepId: "browser-upgrade" }, { paneKey: "reviewer", dependsOn: ["browser-upgrade"] }]
      }
    });
    expect(() => spaceAgentRoomActionEnvelopeSchema.parse({
      version: 1,
      actions: [{
        toolId: "room:orchestrate",
        action: {
          type: "orchestrate",
          steps: [{ paneKey: "missing", instruction: "Never run.", dependsOn: [] }]
        }
      }]
    })).toThrow(/Unknown prepared pane key/);
    expect(roomAgentControlInputSchema.parse({ action: "PAUSE", reason: "Operator pause." })).toEqual({
      action: "PAUSE",
      reason: "Operator pause."
    });
    expect(roomAgentControlInputSchema.parse({ action: "RESUME" })).toEqual({ action: "RESUME" });
    expect(roomAgentControlInputSchema.parse({ action: "STOP" })).toEqual({ action: "STOP" });
    expect(() =>
      spaceAgentRoomActionEnvelopeSchema.parse({
        version: 1,
        actions: [{
          toolId: "room:orchestrate",
          action: {
            type: "orchestrate",
            steps: [
              { stepId: "one", paneId: "pane:one", instruction: "One", dependsOn: ["two"] },
              { stepId: "two", paneId: "pane:two", instruction: "Two", dependsOn: ["one"] }
            ]
          }
        }]
      })
    ).toThrow(/cycle/i);
    expect(() =>
      spaceAgentRoomActionEnvelopeSchema.parse({
        version: 1,
        actions: [{ toolId: "room:delete", action: { type: "delete", paneId: "pane:unsafe" } }]
      })
    ).toThrow();
  });

  it("normalizes room creation input and caps initial panes at 16", () => {
    const parsed = createRoomInputSchema.parse({
      name: "  Launch  ",
      initialPaneCount: 4
    });

    expect(parsed.name).toBe("Launch");
    expect(parsed.initialPaneCount).toBe(4);
    expect(() =>
      createRoomInputSchema.parse({ name: "Too many", initialPaneCount: 17 })
    ).toThrow();
  });

  it("defaults legacy rooms to workspace and validates isolated proof room contracts", () => {
    const timestamp = "2026-07-20T12:00:00.000Z";
    const legacyRoom = roomSchema.parse({
      id: "room:legacy",
      name: "Legacy room",
      description: null,
      order: 0,
      paneLayoutColumns: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      paneCap: 16,
      traceId: "trace:legacy"
    });
    expect(legacyRoom.kind).toBe("WORKSPACE");

    expect(createProofRoomInputSchema.parse({})).toEqual({ paneCount: 1 });
    expect(createProofRoomInputSchema.parse({ paneCount: 4, roomLabel: "  Mobile regression  " })).toEqual({
      paneCount: 4,
      roomLabel: "Mobile regression"
    });
    for (const paneCount of [-1, 3, 16]) {
      expect(() => createProofRoomInputSchema.parse({ paneCount })).toThrow();
    }
    for (const paneCount of [1, 2, 3, 4, 5, 6]) {
      expect(
        createProofRoomInputSchema.parse({
          profile: "ACTIVE_AGENT_STRESS",
          paneCount,
          roomLabel: "  Active agents  "
        })
      ).toEqual({
        profile: "ACTIVE_AGENT_STRESS",
        paneCount,
        roomLabel: "Active agents"
      });
    }
    for (const paneCount of [0, 7]) {
      expect(() =>
        createProofRoomInputSchema.parse({ profile: "ACTIVE_AGENT_STRESS", paneCount })
      ).toThrow();
    }
    expect(
      createProofRoomInputSchema.parse({
        profile: "CLI_INPUT",
        paneCount: 1,
        runtimeId: "cli:qwen",
        roomLabel: "  Qwen input  "
      })
    ).toEqual({
      profile: "CLI_INPUT",
      paneCount: 1,
      runtimeId: "cli:qwen",
      roomLabel: "Qwen input"
    });
    for (const invalid of [
      { profile: "CLI_INPUT", paneCount: 1 },
      { profile: "CLI_INPUT", paneCount: 0, runtimeId: "cli:qwen" },
      { profile: "CLI_INPUT", paneCount: 2, runtimeId: "cli:qwen" },
      { profile: "CLI_INPUT", paneCount: 1, runtimeId: "cli:root" },
      { paneCount: 1, runtimeId: "cli:qwen" }
    ]) {
      expect(() => createProofRoomInputSchema.parse(invalid)).toThrow();
    }
    expect(() =>
      createProofRoomInputSchema.parse({
        profile: "ACTIVE_AGENT_STRESS",
        paneCount: 1,
        workspace: "/etc"
      })
    ).toThrow();

    expect(
      activeAgentTurnsInputSchema.parse({
        paneIds: ["pane:one", "pane:two"],
        cycle: 3
      })
    ).toEqual({
      paneIds: ["pane:one", "pane:two"],
      cycle: 3
    });
    expect(() =>
      activeAgentTurnsInputSchema.parse({
        paneIds: ["pane:one"],
        cycle: 0,
        prompt: "caller controlled"
      })
    ).toThrow();
    expect(() =>
      activeAgentTurnsInputSchema.parse({
        paneIds: ["pane:one", "pane:one"],
        cycle: 0
      })
    ).toThrow();
    expect(() =>
      activeAgentTurnsInputSchema.parse({
        paneIds: ["pane:one"],
        cycle: 4
      })
    ).toThrow();

    const proofRoom = proofRoomSchema.parse({
      room: { ...legacyRoom, kind: "AGENT_PROOF" },
      panes: [],
      sessionIds: []
    });
    expect(proofRoom.room.kind).toBe("AGENT_PROOF");
    expect(() => proofRoomSchema.parse({ room: legacyRoom, panes: [], sessionIds: [] })).toThrow();
    expect(() =>
      proofRoomSchema.parse({
        profile: "ACTIVE_AGENT_STRESS",
        room: { ...legacyRoom, kind: "AGENT_PROOF" },
        panes: [],
        sessionIds: []
      })
    ).toThrow();
    const cliInputPane = {
      id: "pane:cli-input",
      roomId: legacyRoom.id,
      title: "Qwen Code",
      mode: "TERMINAL",
      status: "RUNNING",
      providerId: null,
      modelId: null,
      terminalRuntimeId: "cli:qwen",
      reasoningEffort: "medium",
      cwd: "/etc",
      order: 0,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null },
      createdAt: timestamp,
      updatedAt: timestamp
    };
    expect(proofRoomSchema.parse({
      profile: "CLI_INPUT",
      runtimeId: "cli:qwen",
      room: { ...legacyRoom, kind: "AGENT_PROOF" },
      panes: [cliInputPane],
      sessionIds: []
    })).toMatchObject({
      profile: "CLI_INPUT",
      runtimeId: "cli:qwen",
      panes: [{ terminalRuntimeId: "cli:qwen" }],
      sessionIds: []
    });
    expect(() => proofRoomSchema.parse({
      profile: "CLI_INPUT",
      runtimeId: "cli:qwen",
      room: { ...legacyRoom, kind: "AGENT_PROOF" },
      panes: [{ ...cliInputPane, terminalRuntimeId: "cli:codex" }],
      sessionIds: []
    })).toThrow();
  });

  it("parses room CLI activity without accepting session identifiers", () => {
    const sampledAt = "2026-07-20T12:00:00.000Z";
    expect(
      roomCliActivityResponseSchema.parse({
        data: [
          { roomId: "room:one", runningCliCount: 0 },
          { roomId: "room:two", runningCliCount: 5 }
        ],
        sampledAt
      })
    ).toEqual({
      data: [
        { roomId: "room:one", runningCliCount: 0 },
        { roomId: "room:two", runningCliCount: 5 }
      ],
      sampledAt
    });

    expect(() =>
      roomCliActivityResponseSchema.parse({
        data: [{ roomId: "room:one", runningCliCount: 1, sessionId: "cli_session:sensitive" }],
        sampledAt
      })
    ).toThrow();
  });

  it("accepts only the minimal sampled proof-room CLI host identity", () => {
    const identity = {
      sessionId: "cli_session:proof-codex-identity",
      pid: 6777,
      generationId: "00000000-0000-4000-8000-000000000777",
      sampledAt: "2026-07-26T12:00:00.000Z"
    };
    expect(proofRoomCliIdentitySchema.parse(identity)).toEqual(identity);
    expect(() => proofRoomCliIdentitySchema.parse({
      ...identity,
      roomId: "room:operator-secret"
    })).toThrow();
    expect(() => proofRoomCliIdentitySchema.parse({
      ...identity,
      pid: 0
    })).toThrow();
  });

  it("normalizes room rename input", () => {
    const parsed = updateRoomInputSchema.parse({
      name: "  Renamed room  "
    });

    expect(parsed.name).toBe("Renamed room");
  });

  it("accepts Automatic, Fullscreen, one-to-four-column room pane layouts, and height multipliers from 1 to 4", () => {
    expect(updatePaneLayoutInputSchema.parse({ paneLayoutColumns: null })).toEqual({ paneLayoutColumns: null });
    for (const paneLayoutColumns of [0, 1, 2, 3, 4]) {
      expect(updatePaneLayoutInputSchema.parse({ paneLayoutColumns })).toEqual({ paneLayoutColumns });
    }
    for (const paneLayoutColumns of [5, 6, 7, -1, 2.5, "2"]) {
      expect(() => updatePaneLayoutInputSchema.parse({ paneLayoutColumns })).toThrow();
    }
    for (const paneLayoutHeight of [1, 2, 3, 4]) {
      expect(updatePaneLayoutInputSchema.parse({ paneLayoutHeight })).toEqual({ paneLayoutHeight });
    }
    for (const paneLayoutHeight of [0, 5, -1, 2.5, "2"]) {
      expect(() => updatePaneLayoutInputSchema.parse({ paneLayoutHeight })).toThrow();
    }
    expect(updatePaneLayoutInputSchema.parse({ paneLayoutColumns: 2, paneLayoutHeight: 3 })).toEqual({
      paneLayoutColumns: 2,
      paneLayoutHeight: 3
    });

    expect(
      roomSchema.parse({
        id: "room:layout",
        name: "Layout room",
        description: null,
        order: 0,
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        archivedAt: null,
        paneCap: 16,
        traceId: "trace:layout"
      }).paneLayoutColumns
    ).toBeNull();
  });

  it("persists a terminal runtime only for terminal pane creation", () => {
    expect(
      createPaneInputSchema.parse({
        roomId: "room:test-1",
        title: "CLI Root",
        mode: "TERMINAL",
        terminalRuntimeId: "  cli:root  ",
        cwd: "/etc"
      })
    ).toMatchObject({ terminalRuntimeId: "cli:root" });
    expect(() =>
      createPaneInputSchema.parse({
        roomId: "room:test-1",
        title: "Planner",
        mode: "CHAT",
        terminalRuntimeId: "cli:root"
      })
    ).toThrow("Terminal runtime selection requires TERMINAL, JOB_APPLY, MAIL_COPILOT, MARKETING_COPILOT, FREELANCE_COPILOT, DESIGN or APP_STUDIO mode");
    expect(updatePaneInputSchema.parse({ terminalRuntimeId: "cli:root" })).toEqual({
      terminalRuntimeId: "cli:root"
    });
  });

  it("persists a VNC target only for VNC panes", () => {
    const vncTarget = { presetId: "vm207-desktop", host: "127.0.0.1", port: 5900, password: null };
    expect(
      createPaneInputSchema.parse({
        roomId: "room:test-1",
        title: "Desktop",
        mode: "VNC",
        vncTarget
      })
    ).toMatchObject({ mode: "VNC", vncTarget });
    expect(() =>
      createPaneInputSchema.parse({
        roomId: "room:test-1",
        title: "Chat",
        mode: "CHAT",
        vncTarget
      })
    ).toThrow("VNC target configuration requires VNC mode");
    expect(updatePaneInputSchema.parse({ vncTarget })).toEqual({ vncTarget });
    expect(updatePaneInputSchema.parse({ vncTarget: null })).toEqual({ vncTarget: null });
    expect(
      paneSchema.parse({
        id: "pane:test-1",
        roomId: "room:test-1",
        title: "Desktop",
        mode: "VNC",
        status: "IDLE",
        providerId: null,
        modelId: null,
        reasoningEffort: "medium",
        cwd: null,
        order: 0,
        columnSpan: 1,
        isMaximized: false,
        isMinimized: false,
        isClosed: false,
        split: { parentId: null, direction: null, size: null },
        categoryColor: null,
        createdAt: "2026-06-25T00:00:00.000Z",
        updatedAt: "2026-06-25T00:00:00.000Z",
        vncTarget
      }).vncTarget
    ).toEqual(vncTarget);
  });

  it("validates room reorder payloads", () => {
    expect(reorderRoomsInputSchema.parse({ roomIds: ["room:test-1", "room:test-2"] })).toEqual({
      roomIds: ["room:test-1", "room:test-2"]
    });
    expect(() => reorderRoomsInputSchema.parse({ roomIds: [] })).toThrow();
    expect(() => reorderRoomsInputSchema.parse({ roomIds: ["room:test-1", "room:test-1"] })).toThrow("Room ids must be unique.");
  });

  it("validates pane reorder payloads", () => {
    expect(reorderPanesInputSchema.parse({ paneIds: ["pane:test-1", "pane:test-2"] })).toEqual({
      paneIds: ["pane:test-1", "pane:test-2"]
    });
    expect(() => reorderPanesInputSchema.parse({ paneIds: [] })).toThrow();
    expect(() => reorderPanesInputSchema.parse({ paneIds: ["pane:test-1", "pane:test-1"] })).toThrow("Pane ids must be unique.");
  });

  it("validates pane move payloads and results", () => {
    expect(movePaneInputSchema.parse({ targetRoomId: "room:test-2" })).toEqual({ targetRoomId: "room:test-2" });
    expect(() => movePaneInputSchema.parse({ targetRoomId: "" })).toThrow();

    expect(
      movePaneResultSchema.parse({
        sourcePane: {
          id: "pane:test-1",
          roomId: "room:test-1",
          title: "Planner",
          mode: "CHAT",
          status: "CLOSED",
          providerId: null,
          modelId: null,
          reasoningEffort: "medium",
          cwd: "/opt/spaceapp",
          order: 0,
          columnSpan: 1,
          isMaximized: false,
          isMinimized: false,
          isClosed: true,
          split: { parentId: null, direction: null, size: null },
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:00:01.000Z"
        },
        targetPane: {
          id: "pane:test-2",
          roomId: "room:test-2",
          title: "Planner",
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
          createdAt: "2026-07-09T00:00:01.000Z",
          updatedAt: "2026-07-09T00:00:01.000Z"
        },
        sourceRoomId: "room:test-1",
        targetRoomId: "room:test-2"
      })
    ).toMatchObject({
      sourceRoomId: "room:test-1",
      targetRoomId: "room:test-2"
    });
  });

  it("validates sanitized Space capability inventory and pane capability matrices", () => {
    const snapshot = spaceCapabilitySnapshotSchema.parse({
      id: "space-capability-snapshot",
      generatedAt: "2026-07-06T04:40:00.000Z",
      status: "VERIFIED",
      statusReason: "Inventory collected from bounded Space helper.",
      sources: [
        {
          id: "codex-mcp-list",
          label: "Codex MCP list",
          status: "VERIFIED",
          statusReason: "4 default MCP servers discovered.",
          lastCheckedAt: "2026-07-06T04:39:59.000Z"
        }
      ],
      mcpServers: [
        {
          id: "devtools",
          displayName: "DevTools",
          transport: "stdio",
          status: "DISABLED",
          statusReason: "Metadata only; execution requires Space allowlist."
        }
      ],
      skills: [
        {
          id: "browser-testing-with-devtools",
          displayName: "Browser Testing With Devtools",
          source: "CODEX_SKILL",
          status: "VERIFIED",
          statusReason: "Read-only shared skill.",
          contentHash: "sha256:abc"
        }
      ],
      memory: {
        canonicalIndexPath: "/opt/spaceapp/docs/gemini_history.md",
        currentMonthPath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
        status: "VERIFIED",
        statusReason: "Canonical Space Memory files are readable."
      },
      vscode: {
        extensions: [
          {
            id: "oll4com.codex-session-tools",
            displayName: "Codex Session Tools",
            version: "0.2.9",
            commandCount: 32,
            status: "VERIFIED",
            statusReason: "Extension manifest was parsed without secrets."
          }
        ]
      },
      cliRuntimes: [
        {
          id: "cli:codex",
          displayName: "Codex CLI",
          status: "ENABLED",
          statusReason: "Command and credential smoke verified."
        }
      ],
      codexLbRoute: {
        status: "VERIFIED",
        mode: "headroom",
        selectedAt: "2026-07-05T20:07:41+0300",
        activeUpstreams: ["headroom", "primary"]
      },
      gates: [
        {
          id: "mcp-execution",
          status: "WARN",
          statusReason: "Only allowlisted MCP tools may execute."
        }
      ]
    });

    expect(snapshot.mcpServers[0]?.status).toBe("DISABLED");
    expect(JSON.stringify(snapshot)).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const matrix = paneCapabilityMatrixSchema.parse({
      paneId: "pane:test",
      paneMode: "CHAT",
      generatedAt: "2026-07-06T04:40:00.000Z",
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
              statusReason: "Force-on for chat agents.",
              execution: "force_on",
              requiresApproval: false
            }
          ]
        }
      ]
    });
    expect(matrix.groups[0]?.items[0]?.execution).toBe("force_on");
  });

  it("keeps pane updates additive and partial", () => {
    const parsed = updatePaneInputSchema.parse({
      title: "Reviewer",
      providerId: null,
      columnSpan: 2
    });

    expect(parsed).toEqual({ title: "Reviewer", providerId: null, columnSpan: 2 });
    expect(updatePaneInputSchema.parse({ columnSpan: 4 }).columnSpan).toBe(4);
    expect(() => updatePaneInputSchema.parse({ columnSpan: 5 })).toThrow();
  });

  it("accepts minimized pane updates and rejects contradictory layout state", () => {
    expect(updatePaneInputSchema.parse({ isMinimized: true })).toEqual({ isMinimized: true });
    expect(updatePaneInputSchema.parse({ isMaximized: true })).toEqual({ isMaximized: true });
    expect(() => updatePaneInputSchema.parse({ isMinimized: true, isMaximized: true })).toThrow(
      "A pane cannot be maximized and minimized at the same time."
    );
  });

  it("accepts pane category colors and rejects unknown values", () => {
    expect(updatePaneInputSchema.parse({ categoryColor: "red" })).toEqual({ categoryColor: "red" });
    expect(updatePaneInputSchema.parse({ categoryColor: null })).toEqual({ categoryColor: null });
    expect(updatePaneInputSchema.parse({ categoryColor: "green" }).categoryColor).toBe("green");
    expect(() => updatePaneInputSchema.parse({ categoryColor: "neon" })).toThrow();
    expect(() => updatePaneInputSchema.parse({ categoryColor: "" })).toThrow();
  });

  it("defaults title-generation provider settings and accepts partial updates", () => {
    const parsed = providerSettingsSchema.parse({
      defaultProviderId: "headroom-gateway",
      updatedAt: "2026-07-08T00:00:00.000Z"
    });

    expect(parsed).toMatchObject({
      defaultProviderId: "headroom-gateway",
      titleGenerationModelId: null,
      titleGenerationReasoningEffort: "low"
    });

    expect(
      updateProviderSettingsInputSchema.parse({
        titleGenerationModelId: "headroom-gateway:gpt-5.4-mini",
        titleGenerationReasoningEffort: "minimal"
      })
    ).toEqual({
      titleGenerationModelId: "headroom-gateway:gpt-5.4-mini",
      titleGenerationReasoningEffort: "minimal"
    });

    expect(() => updateProviderSettingsInputSchema.parse({})).toThrow();
  });

  it("validates native agent pane sessions without exposing browser secrets", () => {
    const session = agentPaneSessionSchema.parse({
      binding: {
        paneId: "pane:test-1",
        source: "SPACE",
        sessionId: "agent_session:test-1",
        coderChatId: null,
        status: "READY",
        title: "Planner",
        selectedModelConfigId: "gpt-5.5",
        selectedProviderName: "OpenAI",
        selectedModelName: "gpt-5.5",
        selectedReasoningKey: "high",
        selectedToolIds: ["mcp:github"],
        lastSyncedAt: "2026-06-29T00:00:00.000Z"
      },
      threadId: "thread:test-1",
      messages: [
        {
          id: "msg:test-1",
          role: "user",
          content: "Plan the rollout.",
          status: "COMPLETED",
          createdAt: "2026-06-29T00:00:00.000Z"
        }
      ],
      runStatus: "IDLE",
      statusReason: "Coder chat is ready.",
      modelOptions: [
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          providerName: "OpenAI",
          model: "gpt-5.5",
          reasoningKey: "high",
          reasoningLabel: "High reasoning",
          isDefault: true
        }
      ],
      selectedModelConfigId: "gpt-5.5",
      toolOptions: [
        {
          id: "mcp:github",
          displayName: "GitHub",
          description: "Repository and pull-request tools.",
          category: "mcp",
          slug: "github",
          availability: "default_on",
          authType: "none",
          authConnected: true,
          enabled: true,
          isAvailable: true,
          statusReason: null,
          isForceOn: false
        }
      ],
      selectedToolIds: ["mcp:github"],
      permissionMode: "ask_for_approval",
      collaborationMode: "plan",
      permissionState: {
        mode: "ask_for_approval",
        effectiveMode: "ask_for_approval",
        isInherited: false,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        reviewer: "user",
        statusReason: "Approval is required for sensitive actions."
      },
      permissionOptions: [
        {
          mode: "ask_for_approval",
          label: "Ask for approval",
          description: "Work in the workspace and ask before sensitive actions.",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          reviewer: "user",
          isAvailable: true,
          statusReason: null
        }
      ],
      goal: {
        threadId: "thread:test-1",
        goalId: "goal:test-1",
        objective: "Ship the Space pane safely.",
        status: "active",
        tokenBudget: 5000,
        tokensUsed: 125,
        timeUsedSeconds: 60,
        createdAt: "2026-06-29T00:00:00.000Z",
        updatedAt: "2026-06-29T00:01:00.000Z"
      },
      history: [
        {
          paneId: "pane:test-1",
          roomId: "room:test-1",
          source: "SPACE",
          sessionId: "agent_session:test-1",
          coderChatId: null,
          status: "READY",
          title: "Planner",
          selectedModelConfigId: "gpt-5.5",
          selectedProviderName: "OpenAI",
          selectedModelName: "gpt-5.5",
          selectedReasoningKey: "high",
          selectedToolIds: ["mcp:github"],
          lastSyncedAt: "2026-06-29T00:00:00.000Z",
          paneTitle: "Planner",
          paneIsClosed: false,
          updatedAt: "2026-06-29T00:00:00.000Z"
        }
      ],
      capabilities: {
        canSend: true,
        canInterrupt: false,
        canSelectModel: true,
        canSelectTools: true,
        supportsTools: true
      }
    });

    expect(session.binding.source).toBe("SPACE");
    expect(session.binding.sessionId).toBe("agent_session:test-1");
    expect(session.messages[0]?.content).toBe("Plan the rollout.");
    expect(session.selectedToolIds).toEqual(["mcp:github"]);
    expect(session.permissionState.effectiveMode).toBe("ask_for_approval");
    expect(session.collaborationMode).toBe("plan");
    expect(session.goal?.objective).toBe("Ship the Space pane safely.");
    expect(JSON.stringify(session)).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|bearer|sk-[a-z0-9]", "i"));
  });

  it("defaults new agent permission, collaboration, goal, and tool metadata contracts compatibly", () => {
    expect(permissionModeSchema.options).toEqual(["ask_for_approval", "approve_for_me", "full_access"]);
    expect(collaborationModeSchema.options).toEqual(["default", "plan"]);
    expect(
      agentPanePermissionStateSchema.parse({
        effectiveMode: "full_access",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        reviewer: "user",
        statusReason: "Inherited runtime default."
      })
    ).toMatchObject({ mode: null, effectiveMode: "full_access", isInherited: true });
    expect(
      agentPanePermissionOptionSchema.parse({
        mode: "approve_for_me",
        label: "Approve for me",
        description: "Use a guardian reviewer.",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        reviewer: "guardian_subagent"
      })
    ).toMatchObject({ isAvailable: true, statusReason: null });
    expect(
      agentPaneGoalSchema.parse({
        threadId: "thread:test-1",
        goalId: "goal:test-1",
        objective: "Ship safely.",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: "2026-06-29T00:00:00.000Z",
        updatedAt: "2026-06-29T00:00:00.000Z"
      }).objective
    ).toBe("Ship safely.");
    expect(agentPaneGoalInputSchema.parse({ objective: "  Ship safely.  " })).toEqual({ objective: "Ship safely." });
    expect(() => agentPaneGoalInputSchema.parse({ objective: "   " })).toThrow();
    expect(
      agentPaneToolOptionSchema.parse({
        id: "mcp:github",
        displayName: "GitHub",
        slug: "github",
        availability: "default_on",
        authType: "none",
        authConnected: true,
        enabled: true,
        isForceOn: false
      })
    ).toMatchObject({ description: "", category: "mcp", isAvailable: true, statusReason: null });
  });

  it("validates Codex environment payloads with Space stats and LB usage", () => {
    const environment = codexEnvironmentSchema.parse({
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
        checkedAt: "2026-07-08T00:00:00.000Z"
      },
      spaceStats: {
        roomCount: 3,
        agentPaneCount: 5,
        activeAgentPaneCount: 2,
        cliPaneCount: 4,
        chatPaneCount: 5,
        browserPaneCount: 1,
        checkedAt: "2026-07-08T00:00:00.000Z"
      },
      hostStats: {
        cliSessions: {
          active: 4,
          attached: 3,
          detached: 1,
          status: "OK"
        },
        cpu: {
          usagePercent: 37.8,
          coreCount: 16
        },
        memory: {
          usedBytes: 12_884_901_888,
          totalBytes: 34_359_738_368,
          usagePercent: 37.5
        },
        swap: {
          usedBytes: 1_073_741_824,
          totalBytes: 4_294_967_296,
          usagePercent: 25
        },
        apiStartedAt: "2026-07-08T00:00:00.000Z",
        sampledAt: "2026-07-08T00:00:10.000Z"
      },
      checkedAt: "2026-07-08T00:00:00.000Z"
    });

    expect(environment.lbUsage?.routeMode).toBe("headroom");
    expect(environment.lbUsage?.allAccountsRemainingPercent).toBe(61.8);
    expect(environment.spaceStats?.browserPaneCount).toBe(1);
    expect(environment.spaceStats?.activeAgentPaneCount).toBe(2);
    expect(environment.hostStats?.cliSessions.detached).toBe(1);
    expect(environment.hostStats?.memory.usagePercent).toBe(37.5);
    expect(
      codexEnvironmentSchema.parse({
        ...environment,
        hostStats: {
          ...environment.hostStats,
          cpu: { usagePercent: null, coreCount: 16 },
          swap: { usedBytes: 0, totalBytes: 0, usagePercent: null }
        }
      }).hostStats?.cpu.usagePercent
    ).toBeNull();
    expect(() =>
      codexEnvironmentSchema.parse({
        ...environment,
        hostStats: {
          ...environment.hostStats,
          memory: { usedBytes: -1, totalBytes: 1, usagePercent: -1 }
        }
      })
    ).toThrow();
  });

  it("validates strict service restart contracts", () => {
    expect(serviceRestartRequestSchema.parse({ scope: "CORE" })).toEqual({ scope: "CORE" });
    expect(() => serviceRestartRequestSchema.parse({ scope: "ALL" })).toThrow();
    expect(() => serviceRestartRequestSchema.parse({ scope: "CORE", command: "restart everything" })).toThrow();
    expect(
      serviceRestartResponseSchema.parse({
        status: "ACCEPTED",
        scope: "CORE",
        services: ["space-worker.service", "space-api.service", "space-web.service"],
        requestedAt: "2026-07-08T00:00:00.000Z",
        cooldownUntil: "2026-07-08T00:01:00.000Z",
        apiStartedAt: "2026-07-08T00:00:00.000Z"
      })
    ).toMatchObject({ status: "ACCEPTED", scope: "CORE" });
  });

  it("keeps agent pane binding and settings validation strict", () => {
    expect(() =>
      agentPaneBindingSchema.parse({
        paneId: "pane:test-1",
        source: "LOCAL",
        sessionId: null,
        coderChatId: null,
        status: "READY",
        title: "Planner",
        selectedModelConfigId: null,
        selectedProviderName: null,
        selectedModelName: null,
        selectedReasoningKey: null,
        selectedToolIds: null,
        lastSyncedAt: null
      })
    ).toThrow();

    expect(agentPaneSendMessageInputSchema.parse({ content: "  hello  " })).toEqual({
      content: "hello"
    });
    expect(agentPaneSendMessageInputSchema.parse({ content: "   ", artifactIds: ["artifact:test"] })).toEqual({
      content: "",
      artifactIds: ["artifact:test"]
    });
    expect(
      createAgentPaneSessionInputSchema.parse({
        coderChatId: "chat:test-1",
        selectedModelConfigId: "gpt-5.5",
        selectedToolIds: ["  mcp:github  "]
      })
    ).toEqual({
      coderChatId: "chat:test-1",
      selectedModelConfigId: "gpt-5.5",
      selectedToolIds: ["mcp:github"]
    });
    expect(() => agentPaneSendMessageInputSchema.parse({ content: "" })).toThrow();
    expect(() => agentPaneSendMessageInputSchema.parse({ artifactIds: [] })).toThrow();
    expect(agentPaneSettingsInputSchema.parse({ selectedModelConfigId: "  gpt-5.5  " })).toEqual({
      selectedModelConfigId: "gpt-5.5",
      fullAccessConfirmed: false
    });
    expect(agentPaneSettingsInputSchema.parse({ selectedToolIds: ["  mcp:github  "] })).toEqual({
      selectedToolIds: ["mcp:github"],
      fullAccessConfirmed: false
    });
    expect(
      agentPaneSettingsInputSchema.parse({
        permissionMode: "full_access",
        collaborationMode: "plan",
        fullAccessConfirmed: true
      })
    ).toEqual({ permissionMode: "full_access", collaborationMode: "plan", fullAccessConfirmed: true });
    expect(agentPaneSettingsInputSchema.parse({ permissionMode: "full_access" })).toEqual({
      permissionMode: "full_access",
      fullAccessConfirmed: false
    });

    const longModelConfigId = `m${"a".repeat(230)}:research`;
    expect(longModelConfigId.length).toBe(240);
    expect(agentPaneSettingsInputSchema.parse({ selectedModelConfigId: longModelConfigId })).toMatchObject({
      selectedModelConfigId: longModelConfigId
    });
    expect(() => agentPaneSettingsInputSchema.parse({ selectedModelConfigId: "a".repeat(261) })).toThrow();
  });

  it("validates raw and chat Codex thread presentations", () => {
    expect(codexThreadQuerySchema.parse({})).toEqual({ presentation: "raw" });
    expect(codexThreadQuerySchema.parse({ presentation: "chat" })).toEqual({ presentation: "chat" });
    expect(() => codexThreadQuerySchema.parse({ presentation: "terminal" })).toThrow();
  });

  it("validates provider-neutral agent runtimes and CLI sessions fail-closed", () => {
    const checkedAt = "2026-07-05T00:00:00.000Z";
    const codexWeb = agentRuntimeSchema.parse({
      id: "web:codex-app-server",
      providerId: "codex",
      providerName: "Codex",
      agentId: "codex-app-server",
      agentName: "Codex Web Chat",
      displayName: "Codex Web Chat",
      capabilities: ["WEB_CHAT"],
      adapterStatus: "ENABLED",
      authMode: "MANAGED",
      authState: "READY",
      authReason: "Managed Codex App Server credentials are configured.",
      canStartLogin: false,
      status: "ENABLED",
      statusReason: "Codex App Server is configured for Space-native chat.",
      commandName: null,
      defaultModelId: "codex-app-server-default",
      supportedReasoningEfforts: ["medium", "high"],
      checkedAt
    });
    const claudeCli = agentRuntimeSchema.parse({
      id: "cli:claude",
      providerId: "anthropic",
      providerName: "Anthropic",
      agentId: "claude",
      agentName: "Claude CLI",
      displayName: "Claude CLI",
      capabilities: ["CLI"],
      adapterStatus: "DISABLED",
      authMode: "MANAGED",
      authState: "UNAVAILABLE",
      authReason: "Managed Claude credentials are unavailable.",
      canStartLogin: false,
      status: "DISABLED",
      statusReason: "Command is not verified for the space service user.",
      commandName: "claude",
      detectedCommandPath: null,
      defaultModelId: null,
      supportedReasoningEfforts: [],
      checkedAt
    });
    const registry = agentRuntimeRegistrySchema.parse({
      data: [codexWeb, claudeCli],
      checkedAt
    });

    expect(registry.data.map((runtime) => runtime.capabilities[0])).toEqual(["WEB_CHAT", "CLI"]);
    expect(registry.data.find((runtime) => runtime.id === "cli:claude")?.status).toBe("DISABLED");
    const gemini = agentRuntimeSchema.parse({
      ...claudeCli,
      id: "cli:gemini",
      providerId: "google",
      agentId: "gemini",
      agentName: "Gemini CLI",
      displayName: "Gemini CLI",
      adapterStatus: "ENABLED",
      authMode: "BROWSER_OAUTH",
      authState: "LOGIN_REQUIRED",
      authReason: "Google OAuth login is required.",
      canStartLogin: true,
      status: "NOT_CONNECTED",
      statusReason: "Not connected. Open Gemini CLI to sign in with Google in your browser.",
      commandName: "gemini-vscode-parity",
      detectedCommandPath: "/opt/spaceapp/bin/gemini-vscode-parity"
    });
    expect(gemini.status).toBe("NOT_CONNECTED");
    expect(canStartAgentRuntimeLogin(gemini)).toBe(true);
    expect(canStartAgentRuntimeLogin({
      ...gemini,
      id: "cli:qwen",
      authMode: "API_KEY",
      authState: "SETUP_REQUIRED",
      authReason: "Qwen Code provider setup is required."
    })).toBe(true);
    expect(isAgentRuntimeReady(gemini)).toBe(false);
    expect(isAgentRuntimeReady(codexWeb)).toBe(true);
    expect(() =>
      agentRuntimeSchema.parse({
        ...claudeCli,
        capabilities: ["SHELL"]
      })
    ).toThrow();
  });

  it("validates CLI session, transcript, and WebSocket API payloads without persisted secrets", () => {
    const timestamp = "2026-07-05T00:00:00.000Z";
    const codexThreadId = "019f3805-9299-7b92-b70c-cd4d49b02774";
    const createInput = createPaneCliSessionInputSchema.parse({
      paneId: "pane:cli-1",
      roomId: "room:cli-1",
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.5",
      cwd: "  /opt/spaceapp  ",
      codexThreadId
    });
    expect(createInput).toMatchObject({
      runtimeId: "cli:codex",
      reasoningEffort: "medium",
      launchMode: "FRESH",
      purpose: "NORMAL",
      cwd: "/opt/spaceapp",
      codexThreadId
    });
    expect(
      createPaneCliSessionInputSchema.parse({
        paneId: "pane:cli-1",
        roomId: "room:cli-1",
        runtimeId: "cli:gemini",
        providerId: "google",
        agentId: "gemini",
        purpose: "LOGIN"
      }).purpose
    ).toBe("LOGIN");
    expect(
      createPaneCliSessionInputSchema.parse({
        paneId: "pane:cli-1",
        roomId: "room:cli-1",
        runtimeId: "cli:claude",
        providerId: "anthropic",
        agentId: "claude",
        launchMode: "RESUME"
      }).launchMode
    ).toBe("RESUME");
    expect(
      createPaneCliSessionInputSchema.parse({
        paneId: "pane:cli-1",
        roomId: "room:cli-1",
        runtimeId: "cli:codex",
        providerId: "codex",
        agentId: "codex"
      }).codexThreadId
    ).toBeNull();
    expect(
      updatePaneCliSessionInputSchema.parse({
        codexThreadId: null,
        launchMode: "FRESH"
      })
    ).toMatchObject({ codexThreadId: null, launchMode: "FRESH" });
    expect(() =>
      createPaneCliSessionInputSchema.parse({
        paneId: "pane:cli-1",
        roomId: "room:cli-1",
        runtimeId: "cli:codex",
        providerId: "codex",
        agentId: "codex",
        codexThreadId: "thread:test-1"
      })
    ).toThrow();

    const session = paneCliSessionSchema.parse({
      sessionId: "cli_session:test-1",
      ...createInput,
      status: "IDLE",
      statusReason: "Session is ready.",
      exitCode: null,
      isActive: true,
      startedAt: timestamp,
      updatedAt: timestamp,
      endedAt: null
    });
    const chunk = paneCliTranscriptChunkSchema.parse({
      chunkId: "cli_chunk:test-1",
      sessionId: session.sessionId,
      paneId: session.paneId,
      roomId: session.roomId,
      sequence: 0,
      stream: "system",
      content: "CLI runtime is disabled until command/config smoke passes.",
      byteLength: 59,
      createdAt: timestamp
    });
    const request = createPaneCliSessionRequestSchema.parse({ runtimeId: " cli:codex " });
    expect(request).toMatchObject({ runtimeId: "cli:codex", forceRestart: false, resume: false, includeTranscript: true });
    expect(request).not.toHaveProperty("reasoningEffort");
    expect(
      createPaneCliTranscriptChunkInputSchema.parse({
        ...chunk,
        chunkId: undefined,
        byteLength: undefined,
        content: "x".repeat(32 * 1024)
      }).content
    ).toHaveLength(32 * 1024);
    expect(redactPersistedTranscriptContent("before\0after")).toBe("beforeafter");
    // Space Control tokens (space-control-token.ts) are self-identifying; redact them even when a CLI (Codex, Claude
    // Code, Oh My Pi) echoes the SPACE_CONTROL_TOKEN= env name — "_TOKEN=" has no \b, so the labeled pattern misses it.
    const controlTokenValue = "spacecontrol.v1.eyJyIjoicm9vbSJ9.ZmFrZV9zaWduYXR1cmVfdmFsdWVfbm90X3JlYWw";
    expect(redactPersistedTranscriptContent(`SPACE_CONTROL_TOKEN=${controlTokenValue}`)).toBe("SPACE_CONTROL_TOKEN=[REDACTED]");
    expect(redactPersistedTranscriptContent(`the token is ${controlTokenValue} ok`)).toBe("the token is [REDACTED] ok");
    expect(redactPersistedTranscriptContent(controlTokenValue)).not.toContain(controlTokenValue.split(".")[2]);
    // The bare version marker in prose is not a token and stays.
    expect(redactPersistedTranscriptContent("see spacecontrol.v1 docs")).toBe("see spacecontrol.v1 docs");
    const websocket = paneCliWebSocketTokenSchema.parse({
      paneId: session.paneId,
      sessionId: session.sessionId,
      token: "terminal-ws-ticket-test-value",
      expiresAt: "2026-07-05T00:01:00.000Z"
    });
    const clientInput = paneCliWebSocketClientMessageSchema.parse({ type: "input", data: "pwd\n" });
    const largeClientInput = paneCliWebSocketClientMessageSchema.parse({ type: "input", data: "x".repeat(30_000) });
    expect(largeClientInput.data).toHaveLength(30_000);
    const markedClientInput = paneCliWebSocketClientMessageSchema.parse({
      type: "input",
      data: "\r",
      turnMarker: "77b236da-622e-4f0a-9f36-66850c94b553"
    });
    const hiddenClientInput = paneCliWebSocketClientMessageSchema.parse({ type: "input", data: "/tmp/upload.png ", display: "hidden" });
    const clientResize = paneCliWebSocketClientMessageSchema.parse({ type: "resize", cols: 120, rows: 32 });
    const clientPing = paneCliWebSocketClientMessageSchema.parse({ type: "ping" });
    const serverPong = paneCliWebSocketServerMessageSchema.parse({ type: "pong" });
    const serverOutput = paneCliWebSocketServerMessageSchema.parse({ type: "output", stream: "stdout", data: "ready\n" });
    const serverStatus = paneCliWebSocketServerMessageSchema.parse({
      type: "status",
      status: "RUNNING",
      statusReason: "Attached to CLI process.",
      replayContinuity: "TRUNCATED"
    });
    const replacement = paneCliWebSocketServerMessageSchema.parse({
      type: "session_replaced",
      sessionId: "cli_session:normal-2"
    });
    const loginRequest = cliLoginRequestSchema.parse({ runtimeId: " cli:gemini " });
    const turnActivity = paneCliTurnActivityResponseSchema.parse({
      marker: "77b236da-622e-4f0a-9f36-66850c94b553",
      status: "ABORTED",
      turnId: "turn:current"
    });
    const response = paneCliSessionResponseSchema.parse({
      session,
      runtime: {
        id: "cli:codex",
        providerId: "codex",
        providerName: "Codex",
        agentId: "codex",
        agentName: "Codex CLI",
        displayName: "Codex CLI",
        capabilities: ["CLI"],
        adapterStatus: "DISABLED",
        authMode: "DEVICE_CODE",
        authState: "UNAVAILABLE",
        authReason: "Codex authentication cannot start while the wrapper is unavailable.",
        canStartLogin: false,
        status: "DISABLED",
        statusReason: "Command is not verified for the space service user.",
        commandName: "codex",
        detectedCommandPath: null,
        defaultModelId: null,
        supportedReasoningEfforts: ["medium", "high"],
        checkedAt: timestamp
      },
      transcript: [chunk],
      websocket: null
    });

    expect(request.runtimeId).toBe("cli:codex");
    expect(websocket.expiresAt).toBe("2026-07-05T00:01:00.000Z");
    expect(clientInput.data).toBe("pwd\n");
    expect(clientInput.display).toBe("visible");
    expect(markedClientInput.turnMarker).toBe("77b236da-622e-4f0a-9f36-66850c94b553");
    expect(hiddenClientInput.display).toBe("hidden");
    expect(clientResize.cols).toBe(120);
    expect(serverOutput.stream).toBe("stdout");
    expect(serverStatus.status).toBe("RUNNING");
    expect(serverStatus.replayContinuity).toBe("TRUNCATED");
    expect(replacement).toEqual({ type: "session_replaced", sessionId: "cli_session:normal-2" });
    expect(loginRequest).toEqual({ runtimeId: "cli:gemini" });
    expect(turnActivity).toEqual({ marker: "77b236da-622e-4f0a-9f36-66850c94b553", status: "ABORTED", turnId: "turn:current" });
    expect(response.session.sessionId).toBe("cli_session:test-1");
    expect(createPaneCliTranscriptChunkInputSchema.parse({ ...chunk, chunkId: undefined, byteLength: undefined })).toMatchObject({
      sessionId: session.sessionId,
      stream: "system"
    });
    expect(() => paneCliWebSocketClientMessageSchema.parse({ type: "input", data: "" })).toThrow();
    expect(() => paneCliWebSocketServerMessageSchema.parse({ type: "output", stream: "system", data: "nope" })).toThrow();
    expect(() =>
      paneCliTranscriptChunkSchema.parse({
        ...chunk,
        content: "api_key=raw-value-should-not-persist"
      })
    ).toThrow();
    for (const content of [
      "api_key:[REDACTED]",
      "secret: [REDACTED]",
      "token=[REDACTED]",
      "password: [REDACTED]"
    ]) {
      expect(
        paneCliTranscriptChunkSchema.parse({
          ...chunk,
          content
        }).content
      ).toBe(content);
    }
    for (const content of [
      "api_key=raw-value-should-not-persist",
      "token=[REDACTED]suffix",
      "password:[REDACTED]unexpected"
    ]) {
      expect(() =>
        paneCliTranscriptChunkSchema.parse({
          ...chunk,
          content
        })
      ).toThrow();
    }
    expect(JSON.stringify({ session, chunk })).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word\\s*[:=]|sk-", "i"));
  });

  it("validates sticky per-pane Codex model settings", () => {
    const settings = paneCliModelSettingsSchema.parse({
      sessionId: "cli_session:model-switch",
      threadId: "019f5233-019f-7493-9b23-50c8772a660b",
      current: { modelId: "gpt-5.6-sol", reasoningEffort: "xhigh" },
      models: [
        {
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6",
          description: "Provider-described Sol model.",
          isDefault: true,
          defaultReasoningEffort: "ultra",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "ultra", "research"],
          reasoningOptions: [
            { reasoningEffort: "low", description: "Quick." },
            { reasoningEffort: "medium", description: "Balanced." },
            { reasoningEffort: "high", description: "Thorough." },
            { reasoningEffort: "xhigh", description: "Extra thorough." },
            { reasoningEffort: "ultra", description: "Maximum available effort." },
            { reasoningEffort: "research", description: "Provider-specific exploration." }
          ]
        }
      ],
      controlMode: "DIRECT",
      isTurnActive: true
    });

    expect(settings.models[0]?.supportedReasoningEfforts).toContain("ultra");
    expect(settings.models[0]?.reasoningOptions?.at(-1)).toEqual({
      reasoningEffort: "research",
      description: "Provider-specific exploration."
    });
    expect(paneCliModelSettingsSchema.parse({ ...settings, current: null }).current).toBeNull();
    // The configured OpenCode catalog currently contains 210 models across
    // providers; all must survive both the server and browser status parser.
    const nativeCatalog = {
      ...settings,
      threadId: null,
      controlMode: "OPENCODE",
      models: Array.from({ length: 210 }, (_, index) => ({
        ...settings.models[0], id: `opencode/native-${index}`
      }))
    };
    expect(paneCliModelSettingsStatusSchema.parse({ status: "AVAILABLE", settings: nativeCatalog }).settings.models).toHaveLength(210);
    expect(cliModelIdentifierSchema.safeParse("openrouter/~anthropic/claude-fable-latest").success).toBe(true);
    expect(cliModelIdentifierSchema.safeParse("cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash").success).toBe(true);
    expect(cliModelIdentifierSchema.safeParse("~anthropic/claude-opus-latest").success).toBe(true);
    expect(paneCliModelSettingsSchema.safeParse({ ...settings, controlMode: "LEGACY_RESUME" }).success).toBe(false);
    expect(paneCliModelSettingsStatusSchema.parse({ status: "AVAILABLE", settings })).toMatchObject({
      status: "AVAILABLE",
      settings: { sessionId: settings.sessionId }
    });
    expect(paneCliModelSettingsStatusSchema.parse({
      status: "UNAVAILABLE",
      reasonCode: "CODEX_SESSION_CONTROL_UNAVAILABLE",
      reason: "Live Codex model control is unavailable."
    })).toEqual({
      status: "UNAVAILABLE",
      reasonCode: "CODEX_SESSION_CONTROL_UNAVAILABLE",
      reason: "Live Codex model control is unavailable."
    });
    expect(updatePaneCliModelSettingsInputSchema.parse({
      expectedSessionId: settings.sessionId,
      modelId: "gpt-5.6-sol",
      reasoningEffort: "research"
    })).toEqual({
      expectedSessionId: settings.sessionId,
      modelId: "gpt-5.6-sol",
      reasoningEffort: "research",
      continueActiveTurn: true
    });
  });

  it("validates paginated Codex history and CLI resume payloads", () => {
    const checkedAt = "2026-07-09T00:00:00.000Z";
    const threadId = "019f3805-9299-7b92-b70c-cd4d49b02774";
    const history = codexHistoryResponseSchema.parse({
      data: [
        {
          id: threadId,
          rolloutPath: "/var/lib/spaceapp-user/.codex/sessions/2026/07/09/rollout.jsonl",
          title: "Resume this task",
          preview: "Investigate title sync",
          model: "gpt-5.5",
          reasoningEffort: "high",
          cwd: "/opt/spaceapp",
          archived: false,
          source: "vscode",
          modelProvider: "codex-lb",
          threadSource: "user",
          firstUserMessage: "Investigate title sync",
          updatedAt: checkedAt,
          recencyAt: checkedAt
        }
      ],
      totalItems: 12,
      visibleItems: 11,
      pagination: {
        page: 2,
        pageSize: 50,
        totalItems: 11,
        totalPages: 1
      },
      checkedAt
    });
    expect(history.pagination?.page).toBe(2);

    const resumeRequest = resumePaneCliSessionRequestSchema.parse({ threadId });
    expect(resumeRequest.threadId).toBe(threadId);

    const sharedTaskResumeRequest = resumePaneCliSessionRequestSchema.parse({
      taskId: "cli_session:shared-history"
    });
    expect(sharedTaskResumeRequest.taskId).toBe("cli_session:shared-history");
    expect(() =>
      resumePaneCliSessionRequestSchema.parse({
        taskId: "cli_session:shared-history",
        threadId
      })
    ).toThrow();

    const runtimeResumeRequest = createPaneCliSessionRequestSchema.parse({
      runtimeId: "cli:claude",
      forceRestart: true,
      resume: true
    });
    expect(runtimeResumeRequest).toMatchObject({
      runtimeId: "cli:claude",
      forceRestart: true,
      resume: true
    });

    const resumeResponse = resumePaneCliSessionResponseSchema.parse({
      mode: "SPACE_FALLBACK",
      pane: {
        id: "pane:cli-1",
        roomId: "room:cli-1",
        title: "Resume this task",
        mode: "TERMINAL",
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
        createdAt: checkedAt,
        updatedAt: checkedAt
      },
      session: {
        sessionId: "cli_session:test-1",
        paneId: "pane:cli-1",
        roomId: "room:cli-1",
        runtimeId: "cli:codex",
        providerId: "codex",
        agentId: "codex",
        modelId: null,
        reasoningEffort: "medium",
        cwd: "/opt/spaceapp",
        codexThreadId: threadId,
        status: "IDLE",
        statusReason: "CLI session allocated; waiting for terminal transport attach.",
        exitCode: null,
        isActive: true,
        startedAt: checkedAt,
        updatedAt: checkedAt,
        endedAt: null
      },
      runtime: {
        id: "cli:codex",
        providerId: "codex",
        providerName: "Codex",
        agentId: "codex",
        agentName: "Codex CLI",
        displayName: "Codex CLI",
        capabilities: ["CLI"],
        adapterStatus: "ENABLED",
        authMode: "DEVICE_CODE",
        authState: "READY",
        authReason: "Codex device authentication is verified.",
        canStartLogin: false,
        status: "ENABLED",
        statusReason: "ready",
        commandName: "codex-vscode-parity",
        detectedCommandPath: "/opt/spaceapp/bin/codex-vscode-parity",
        defaultModelId: null,
        supportedReasoningEfforts: ["medium"],
        checkedAt
      },
      transcript: [],
      websocket: null
    });
    expect(resumeResponse.pane.title).toBe("Resume this task");
    expect(resumeResponse.session.codexThreadId).toBe(threadId);
  });

  it("validates CLI upload responses with terminal-safe paths", () => {
    const response = paneCliUploadResponseSchema.parse({
      sessionId: "cli_session:test-1",
      paneId: "pane:test-1",
      roomId: "room:test-1",
      files: [
        {
          artifactId: "artifact:test-1",
          sessionId: "cli_session:test-1",
          paneId: "pane:test-1",
          roomId: "room:test-1",
          originalFilename: "demo image.png",
          storedFilename: "upload_test-demo_image.png",
          mimeType: "image/png",
          byteSize: 12,
          sha256: "a".repeat(64),
          storageUri: "space-artifact://cli-uploads/room%3Atest-1/pane%3Atest-1/cli_session%3Atest-1/upload_test-demo_image.png",
          terminalPath: "/opt/spaceapp/var/artifacts/cli-uploads/room_test-1/pane_test-1/cli_session_test-1/upload_test-demo_image.png",
          shellQuotedPath: "'/opt/spaceapp/var/artifacts/cli-uploads/room_test-1/pane_test-1/cli_session_test-1/upload_test-demo_image.png'",
          isImage: true
        }
      ]
    });

    expect(response.files[0]?.isImage).toBe(true);
    expect(response.files[0]?.shellQuotedPath).toMatch(/^'.+'$/);
    expect(() =>
      paneCliUploadResponseSchema.parse({
        ...response,
        files: [{ ...response.files[0], terminalPath: "" }]
      })
    ).toThrow();
  });

  it("validates browser session, frame stream, and agent-safe action payloads", () => {
    const timestamp = "2026-07-05T00:00:00.000Z";
    const createInput = createPaneBrowserSessionInputSchema.parse({
      paneId: "pane:browser-1",
      roomId: "room:browser-1",
      ownerAgentId: "agent:1",
      agentNumber: 1,
      profileId: "profile:room-browser-1:pane-browser-1",
      profilePath: "/opt/spaceapp/var/artifacts/browser-profiles/room_browser_1/pane_browser_1/browser_session_test",
      viewport: "desktop",
      targetUrl: "https://www.google.com/"
    });
    const session = paneBrowserSessionSchema.parse({
      sessionId: "browser_session:test-1",
      ...createInput,
      currentUrl: "https://www.google.com/",
      title: "Olla",
      status: "READY",
      statusReason: "Page ready.",
      lastFrameAt: timestamp,
      isActive: true,
      startedAt: timestamp,
      updatedAt: timestamp,
      endedAt: null
    });
    const frame = browserFrameSchema.parse({
      sessionId: session.sessionId,
      paneId: session.paneId,
      roomId: session.roomId,
      status: "READY",
      viewport: "desktop",
      currentUrl: "https://www.google.com/",
      title: "Olla",
      screenshotDataUrl: "data:image/png;base64,aGVsbG8=",
      capturedAt: timestamp
    });
    const websocket = browserFrameTokenSchema.parse({
      paneId: session.paneId,
      sessionId: session.sessionId,
      token: "browser-frame-ticket-test-value",
      expiresAt: "2026-07-05T00:01:00.000Z"
    });
    const response = paneBrowserSessionResponseSchema.parse({ session, frame, websocket });
    const startRequest = createPaneBrowserSessionRequestSchema.parse({
      viewport: "mobile",
      targetUrl: "https://www.google.com/"
    });
    const click = browserToolActionInputSchema.parse({ type: "click", x: 10, y: 20 });
    const diagnostics = browserToolActionInputSchema.parse({ type: "diagnostics" });
    const recording = browserToolActionInputSchema.parse({ type: "record", durationMs: 500, intervalMs: 250, format: "both" });
    const extract = browserToolActionResultSchema.parse({ session, frame, text: "Observed browser page text." });
    const streamMessage = browserFrameWebSocketServerMessageSchema.parse({ type: "frame", frame });

    expect(response.session.agentNumber).toBe(1);
    expect(response.session).toMatchObject({
      streamMode: "AUTO",
      resolvedStreamMode: "PREVIEW",
      runtimeState: "STARTING",
      capacityState: "AVAILABLE",
      controlState: "UNCONTROLLED",
      pages: [],
      activePageId: null,
      workerHeartbeatAt: null,
      queuePosition: null
    });
    expect(startRequest.viewport).toBe("mobile");
    expect(createPaneBrowserSessionRequestSchema.parse({}).viewport).toBe("desktop");
    expect(click.type).toBe("click");
    expect(diagnostics).toMatchObject({ type: "diagnostics", includeNetwork: true, limit: 100 });
    expect(recording).toMatchObject({ type: "record", durationMs: 500, intervalMs: 250, format: "both" });
    expect(extract.text).toContain("Observed");
    expect(streamMessage.frame.currentUrl).toBe("https://www.google.com/");
    expect(() => browserToolActionInputSchema.parse({ type: "click", x: -1, y: 20 })).toThrow();
    expect(() => paneBrowserSessionSchema.parse({ ...session, viewport: "invalid-viewport" })).toThrow();
    expect(JSON.stringify(response)).not.toMatch(new RegExp("api[_-]?key|sec" + "ret\\s*[:=]|pass" + "word\\s*[:=]|sk-", "i"));
  });

  it("validates browser v2 control, capture, page, and timeline summaries", () => {
    const timestamp = "2026-07-11T12:00:00.000Z";
    const lease = browserControlLeaseSchema.parse({
      leaseId: "browser_lease:test-1",
      sessionId: "browser_session:test-1",
      paneId: "pane:browser-1",
      roomId: "room:browser-1",
      holderType: "OPERATOR",
      holderId: "user:test-1",
      status: "ACTIVE",
      reason: "CAPTCHA handoff",
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt: "2026-07-11T12:00:30.000Z",
      releasedAt: null
    });
    const job = browserCaptureJobSchema.parse({
      jobId: "browser_capture:test-1",
      sessionId: lease.sessionId,
      paneId: lease.paneId,
      roomId: lease.roomId,
      requestedByType: "AGENT",
      requestedById: "agent:test-1",
      status: "QUEUED",
      options: { kind: "RECORDING" },
      progressPercent: 0,
      statusReason: null,
      artifactIds: [],
      queuedAt: timestamp,
      startedAt: null,
      updatedAt: timestamp,
      completedAt: null
    });
    const pages = browserPageListResponseSchema.parse({
      sessionId: lease.sessionId,
      activePageId: "page:test-1",
      pages: [
        {
          pageId: "page:test-1",
          url: "https://example.com/",
          title: "Example",
          isActive: true
        }
      ]
    });
    const diagnostics = browserDiagnosticsResponseSchema.parse({
      sessionId: lease.sessionId,
      events: [
        {
          eventId: "browser_event:test-1",
          sessionId: lease.sessionId,
          pageId: "page:test-1",
          sequence: 0,
          type: "NETWORK",
          level: "ERROR",
          message: "Request failed with 500.",
          frameIndex: 12,
          occurredAt: timestamp
        }
      ]
    });

    expect(job.options).toMatchObject({
      kind: "RECORDING",
      format: "WEBM",
      maxDurationMs: 30_000,
      maxBytes: 1_073_741_824,
      frameIntervalMs: 100
    });
    expect(pages.pages[0]).toMatchObject({ kind: "PAGE", openerPageId: null, canGoBack: false });
    expect(diagnostics.events[0]?.metadata).toEqual({});
    expect(() => browserControlLeaseSchema.parse({ ...lease, status: "TAKEN" })).toThrow();
  });

  it("validates resumable capture commands, segments, and authenticated handoffs", () => {
    const timestamp = "2026-07-12T09:00:00.000Z";
    const stop = browserCaptureCommandInputSchema.parse({ command: "STOP" });
    const cancel = browserCaptureCommandInputSchema.parse({ command: "CANCEL", reason: "Operator cancelled recording." });
    const segment = browserCaptureSegmentSchema.parse({
      segmentId: "browser_segment:test-1",
      jobId: "browser_capture:test-1",
      sessionId: "browser_session:test-1",
      sequence: 0,
      status: "OPEN",
      artifactId: null,
      storageUri: null,
      sha256: null,
      byteSize: 0,
      durationMs: 0,
      frameCount: 0,
      lastFrameSequence: null,
      statusReason: null,
      startedAt: timestamp,
      updatedAt: timestamp,
      finalizedAt: null
    });
    const handoff = browserHandoffRequestSchema.parse({
      handoffRequestId: "browser_handoff:test-1",
      sessionId: segment.sessionId,
      paneId: "pane:browser-1",
      roomId: "room:browser-1",
      requestedByType: "AGENT",
      requestedById: "agent:test-1",
      reason: "CAPTCHA requires a human operator.",
      status: "ACCEPTED",
      operatorUserId: "user:test-1",
      operatorEmail: "operator@example.com",
      operatorRole: "OPERATOR",
      controlLeaseId: "browser_lease:test-1",
      requestedAt: timestamp,
      expiresAt: "2026-07-12T09:05:00.000Z",
      acceptedAt: "2026-07-12T09:00:10.000Z",
      completedAt: null,
      expiredAt: null,
      cancelledAt: null,
      updatedAt: "2026-07-12T09:00:10.000Z"
    });

    expect(stop).toEqual({ command: "STOP", finalize: true });
    expect(cancel).toMatchObject({ command: "CANCEL" });
    expect(segment.status).toBe("OPEN");
    expect(browserCaptureTimelineResponseSchema.parse({
      jobId: segment.jobId,
      sessionId: segment.sessionId,
      durationMs: 5_000,
      frameCount: 2,
      segmentCount: 1,
      frames: [
        { index: 0, segmentSequence: 0, segmentFrameIndex: 0, capturedAt: timestamp, elapsedMs: 0 },
        { index: 1, segmentSequence: 0, segmentFrameIndex: 1, capturedAt: "2026-07-12T09:00:01.000Z", elapsedMs: 1_000 }
      ],
      events: [{
        eventId: "browser_event:test-1",
        sessionId: segment.sessionId,
        pageId: null,
        sequence: 0,
        type: "CONSOLE",
        level: "INFO",
        message: "console ok",
        frameIndex: 0,
        metadata: {},
        occurredAt: timestamp
      }]
    })).toMatchObject({ frameCount: 2, events: [{ frameIndex: 0 }] });
    expect(handoff.operatorEmail).toBe("operator@example.com");
    expect(() =>
      updateBrowserHandoffRequestInputSchema.parse({
        status: "ACCEPTED",
        operatorUserId: "user:test-1"
      })
    ).toThrow();
  });

  it("validates strict CLI browser lifecycle commands and durable handoff events", () => {
    expect(
      spaceCliBrowserCommandRequestSchema.parse({
        targetPaneId: "pane:browser-1",
        command: { type: "START_CAPTURE", kind: "RECORDING", durationMs: 60_000 }
      })
    ).toEqual({
      targetPaneId: "pane:browser-1",
      command: { type: "START_CAPTURE", kind: "RECORDING", durationMs: 60_000 }
    });
    expect(
      spaceCliBrowserCommandRequestSchema.parse({
        targetPaneId: "pane:browser-1",
        command: { type: "REQUEST_HANDOFF", kind: "CAPTCHA", reason: "Operator verification required" }
      }).command
    ).toMatchObject({ type: "REQUEST_HANDOFF", kind: "CAPTCHA" });
    expect(() =>
      spaceCliBrowserCommandRequestSchema.parse({
        targetPaneId: "pane:browser-1",
        command: { type: "CAPTURE_STATUS", jobId: "../../escape" }
      })
    ).toThrow();
    expect(eventTypeSchema.parse("BROWSER_HANDOFF_REQUESTED")).toBe("BROWSER_HANDOFF_REQUESTED");
    expect(eventTypeSchema.parse("ROOM_WATCHDOG_ALERT")).toBe("ROOM_WATCHDOG_ALERT");
  });

  it("validates strict Space agent browser action envelopes", () => {
    const envelope = spaceAgentBrowserActionEnvelopeSchema.parse({
      version: 1,
      actions: [
        {
          toolId: "browser:navigate",
          targetPaneId: "pane:browser-1",
          action: { type: "navigate", url: "https://www.google.com/" }
        },
        {
          toolId: "browser:extract_text",
          targetPaneId: "pane:browser-1",
          action: { type: "extract_text" }
        },
        {
          toolId: "browser:diagnostics",
          targetPaneId: "pane:browser-1",
          action: { type: "diagnostics", includeNetwork: true }
        }
      ]
    });
    const request = spaceAgentBrowserActionBridgeRequestSchema.parse({
      roomId: "room:browser-1",
      agentPaneId: "pane:agent-1",
      agentSessionId: "agent_session:test-1",
      roomAgentMissionId: "room_agent_mission:browser-1",
      selectedToolIds: ["browser:navigate", "browser:extract_text", "browser:diagnostics"],
      actions: envelope.actions
    });
    const response = spaceAgentBrowserActionBridgeResponseSchema.parse({
      results: [
        {
          request: request.actions[1],
          status: "EXECUTED",
          statusReason: "Browser action executed.",
          observation: {
            sessionId: "browser_session:test-1",
            paneId: "pane:browser-1",
            roomId: "room:browser-1",
            actionType: "extract_text",
            viewport: "desktop",
            currentUrl: "https://www.google.com/",
            title: "Olla",
            text: "Observed page text",
            capturedAt: "2026-07-05T00:00:00.000Z"
          }
        }
      ]
    });

    expect(request.actions).toHaveLength(3);
    expect(request.roomAgentMissionId).toBe("room_agent_mission:browser-1");
    expect(response.results[0]?.observation?.text).toContain("Observed");
    expect(() =>
      spaceAgentBrowserActionEnvelopeSchema.parse({
        version: 1,
        actions: [
          {
            toolId: "browser:navigate",
            targetPaneId: "pane:browser-1",
            action: { type: "extract_text" }
          }
        ]
      })
    ).toThrow();
    expect(() =>
      spaceAgentBrowserActionEnvelopeSchema.parse({
        version: 1,
        actions: [
          { toolId: "browser:screenshot", targetPaneId: "pane:browser-1", action: { type: "screenshot" } },
          { toolId: "browser:screenshot", targetPaneId: "pane:browser-1", action: { type: "screenshot" } },
          { toolId: "browser:screenshot", targetPaneId: "pane:browser-1", action: { type: "screenshot" } },
          { toolId: "browser:screenshot", targetPaneId: "pane:browser-1", action: { type: "screenshot" } }
        ]
      })
    ).toThrow();
    expect(JSON.stringify(response)).not.toMatch(/screenshotDataUrl|profilePath|cdp|websocket|token/i);
  });

  it("validates scoped Space CLI browser bridge payloads without browser internals", () => {
    const context = spaceCliBrowserContextResponseSchema.parse({
      roomId: "room:browser-1",
      cliPaneId: "pane:cli-1",
      cliSessionId: "cli_session:test-1",
      browserSessions: [
        {
          sessionId: "browser_session:test-1",
          paneId: "pane:browser-1",
          roomId: "room:browser-1",
          agentNumber: 1,
          viewport: "desktop",
          status: "READY",
          currentUrl: "https://www.google.com/",
          title: "Olla",
          lastFrameAt: "2026-07-05T00:00:00.000Z"
        }
      ]
    });
    const startRequest = spaceCliBrowserSessionStartRequestSchema.parse({
      targetUrl: "https://www.google.com/"
    });
    const startResponse = spaceCliBrowserSessionStartResponseSchema.parse({
      session: context.browserSessions[0]
    });
    const request = spaceCliBrowserActionBridgeRequestSchema.parse({
      actions: [
        {
          toolId: "browser:extract_text",
          targetPaneId: "pane:browser-1",
          action: { type: "extract_text" }
        }
      ]
    });
    const response = spaceCliBrowserActionBridgeResponseSchema.parse({
      results: [
        {
          request: request.actions[0],
          status: "EXECUTED",
          statusReason: "Browser action executed through Space CLI mediation.",
          observation: {
            sessionId: "browser_session:test-1",
            paneId: "pane:browser-1",
            roomId: "room:browser-1",
            actionType: "extract_text",
            viewport: "desktop",
            currentUrl: "https://www.google.com/",
            title: "Olla",
            text: "Observed page text",
            capturedAt: "2026-07-05T00:00:00.000Z"
          }
        }
      ]
    });

    expect(context.browserSessions[0]?.paneId).toBe("pane:browser-1");
    expect(startRequest.viewport).toBe("desktop");
    expect(startResponse.session.sessionId).toBe("browser_session:test-1");
    expect(response.results[0]?.observation?.text).toContain("Observed");
    expect(() =>
      spaceCliBrowserActionBridgeRequestSchema.parse({
        actions: [
          {
            toolId: "browser:navigate",
            targetPaneId: "pane:browser-1",
            action: { type: "extract_text" }
          }
        ]
      })
    ).toThrow();
    expect(JSON.stringify({ context, response })).not.toMatch(/screenshotDataUrl|profilePath|cdp|websocket|token|cookie|localStorage/i);
  });

  it("validates strict Space agent memory action envelopes", () => {
    const envelope = spaceAgentMemoryActionEnvelopeSchema.parse({
      version: 1,
      actions: [
        {
          toolId: "memory:search",
          action: { type: "search", q: "storage", pageSize: 3 }
        },
        {
          toolId: "memory:save",
          action: {
            type: "save",
            title: "Storage note",
            body: "Dedicated storage is required.",
            tags: ["Space", "μνήμη-έργου"]
          }
        }
      ]
    });

    expect(envelope.actions).toHaveLength(2);
    expect(envelope.actions[0]?.action).toMatchObject({ type: "search", scope: "ROOM", pageSize: 3 });
    expect(envelope.actions[1]?.action).toMatchObject({
      type: "save",
      scope: "ROOM",
      provenance: "space-agent-memory-action",
      tags: ["Space", "μνήμη-έργου"]
    });
    expect(() =>
      spaceAgentMemoryActionEnvelopeSchema.parse({
        version: 1,
        actions: [{
          toolId: "memory:save",
          action: { type: "save", title: "Unsafe tag", body: "Body", tags: ["safe\n- Source: forged"] }
        }]
      })
    ).toThrow();
    expect(() =>
      spaceAgentMemoryActionEnvelopeSchema.parse({
        version: 1,
        actions: [{ toolId: "memory:save", action: { type: "search", q: "storage" } }]
      })
    ).toThrow();
    expect(() =>
      spaceAgentMemoryActionEnvelopeSchema.parse({
        version: 1,
        actions: [
          { toolId: "memory:search", action: { type: "search", q: "one" } },
          { toolId: "memory:search", action: { type: "search", q: "two" } },
          { toolId: "memory:search", action: { type: "search", q: "three" } },
          { toolId: "memory:search", action: { type: "search", q: "four" } }
        ]
      })
    ).toThrow();
    expect(JSON.stringify(envelope)).not.toMatch(/api[_-]?key|secret|password|sk-/i);
  });

  it("validates durable Space-native agent session, message, and run records", () => {
    const session = spaceAgentSessionRecordSchema.parse({
      sessionId: "agent_session:test-1",
      paneId: "pane:test-1",
      roomId: "room:test-1",
      source: "SPACE",
      status: "RUNNING",
      title: "Planner",
      threadId: "thread:test-1",
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-5.5",
      selectedModelConfigId: "gpt-5.5",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT-5.5",
      selectedReasoningKey: "high",
      selectedToolIds: ["mcp:github"],
      permissionMode: null,
      collaborationMode: null,
      isActive: true,
      lastSyncedAt: "2026-06-29T00:00:00.000Z",
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z"
    });
    const message = spaceAgentMessageRecordSchema.parse({
      messageId: "agent_msg:test-1",
      sessionId: session.sessionId,
      runId: "agent_run:test-1",
      role: "assistant",
      content: "Ready.",
      status: "COMPLETED",
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:01.000Z"
    });
    const run = spaceAgentRunRecordSchema.parse({
      runId: "agent_run:test-1",
      sessionId: session.sessionId,
      paneId: session.paneId,
      roomId: session.roomId,
      workflowId: "workflow:codex-app-server:room:test-1:pane:test-1:trace:test-1",
      temporalRunId: "temporal:test-1",
      codexThreadId: "thread:test-1",
      codexTurnId: "turn:test-1",
      status: "COMPLETED",
      promptMessageId: "agent_msg:user-1",
      responseMessageId: message.messageId,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:01.000Z",
      completedAt: "2026-06-29T00:00:01.000Z"
    });

    expect(createSpaceAgentSessionInputSchema.parse({
      paneId: "pane:test-1",
      roomId: "room:test-1",
      title: "Planner",
      selectedProviderId: null,
      selectedModelId: null,
      selectedModelConfigId: null,
      selectedProviderName: null,
      selectedModelName: null,
      selectedReasoningKey: null,
      selectedToolIds: null
    }).title).toBe("Planner");
    expect(createSpaceAgentMessageInputSchema.parse({ sessionId: session.sessionId, role: "user", content: "hi" }).status).toBeUndefined();
    expect(createSpaceAgentRunInputSchema.parse({
      sessionId: session.sessionId,
      paneId: session.paneId,
      roomId: session.roomId,
      workflowId: run.workflowId,
      status: "QUEUED",
      promptMessageId: "agent_msg:user-1",
      responseMessageId: message.messageId
    }).status).toBe("QUEUED");
    expect(session.permissionMode).toBeNull();
    expect(session.collaborationMode).toBeNull();
    expect(JSON.stringify({ session, message, run })).not.toMatch(new RegExp("10\\.100\\.0\\.216|api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));
  });

  it("validates stored native Coder agent sessions and proxy requests", () => {
    const stored = agentPaneStoredSessionSchema.parse({
      paneId: "pane:test-1",
      roomId: "room:test-1",
      source: "CODER",
      coderChatId: "chat:test-1",
      status: "RUNNING",
      title: "Planner session",
      selectedModelConfigId: "gpt-5.5",
      selectedProviderName: "OpenAI",
      selectedModelName: "gpt-5.5",
      selectedReasoningKey: "high",
      selectedToolIds: ["mcp:github"],
      lastSyncedAt: "2026-06-29T00:00:00.000Z",
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:01.000Z"
    });
    expect(stored.coderChatId).toBe("chat:test-1");
    expect(
      upsertAgentPaneStoredSessionInputSchema.parse({
        paneId: "pane:test-1",
        roomId: "room:test-1",
        source: "CODER",
        coderChatId: "chat:test-2",
        status: "READY",
        title: "Second session",
        selectedModelConfigId: null,
        selectedProviderName: null,
        selectedModelName: null,
        selectedReasoningKey: null,
        selectedToolIds: null
      }).lastSyncedAt
    ).toBeUndefined();
    expect(
      coderAgentProxyRequestSchema.parse({
        resource: "chat-messages",
        method: "GET",
        chatId: "chat:test-1",
        query: { limit: 50 }
      })
    ).toMatchObject({ resource: "chat-messages", method: "GET", chatId: "chat:test-1" });
    expect(() =>
      coderAgentProxyRequestSchema.parse({
        resource: "unknown",
        method: "GET"
      })
    ).toThrow();
  });

  it("parses pane list query params with strict boolean semantics", () => {
    expect(listPanesQuerySchema.parse({ roomId: "room:test-1" })).toEqual({
      roomId: "room:test-1",
      includeClosed: false
    });
    expect(listPanesQuerySchema.parse({ roomId: "room:test-1", includeClosed: "true" })).toEqual({
      roomId: "room:test-1",
      includeClosed: true
    });
    expect(() => listPanesQuerySchema.parse({ includeClosed: "true" })).toThrow();
    expect(() => listPanesQuerySchema.parse({ roomId: "room:test-1", includeClosed: "yes" })).toThrow();
  });

  it("rejects invalid pane state and invalid provider URL", () => {
    expect(() =>
      paneSchema.parse({
        id: "pane:test-1",
        roomId: "room:test-1",
        title: "Planner",
        mode: "CHAT",
        status: "SLEEPING",
        providerId: null,
        modelId: null,
        reasoningEffort: "medium",
        cwd: null,
        order: 0,
        columnSpan: 1,
        isMaximized: false,
        isMinimized: false,
        isClosed: false,
        split: { parentId: null, direction: null, size: null },
        createdAt: "2026-06-25T00:00:00.000Z",
        updatedAt: "2026-06-25T00:00:00.000Z"
      })
    ).toThrow();

    expect(() =>
      providerSchema.parse({
        id: "codex-lb",
        displayName: "Codex-LB",
        type: "CODEX_LB",
        status: "DISABLED",
        statusReason: "missing dedicated key",
        healthCheckedAt: null,
        maskedKeyPrefix: null,
        baseUrl: "not-a-url"
      })
    ).toThrow();

    const validation = providerValidationResultSchema.parse({
      providerId: "codex-lb",
      status: "VERIFIED",
      code: "VERIFIED",
      statusReason: "Credential smoke passed.",
      checkedAt: "2026-06-25T00:00:00.000Z",
      maskedKeyPrefix: null,
      credentialLabel: null,
      modelCount: 1,
      models: [
        {
          id: "gpt-test",
          providerId: "codex-lb",
          displayName: "gpt-test",
          status: "VERIFIED",
          contextWindow: null,
          supportsTools: false,
          supportsVision: false,
          supportsRealtime: false,
          supportsReasoning: false,
          defaultReasoningEffort: null
        }
      ]
    });
    expect(validation.code).toBe("VERIFIED");
    expect(validation.models).toHaveLength(1);
  });

  it("validates bounded observability snapshots", () => {
    const snapshot = observabilitySnapshotSchema.parse({
      service: "space-api",
      generatedAt: "2026-06-26T00:00:00.000Z",
      runtime: {
        startedAt: "2026-06-26T00:00:00.000Z",
        uptimeSeconds: 42,
        nodeVersion: "v22.23.0",
        pid: 207,
        memory: {
          rssBytes: 128,
          heapUsedBytes: 64,
          heapTotalBytes: 96,
          externalBytes: 12,
          arrayBuffersBytes: 4
        }
      },
      totals: {
        requestCount: 3,
        errorCount: 0,
        errorRate: 0,
        p50Ms: 2.1,
        p95Ms: 8.2,
        p99Ms: 8.2
      },
      endpoints: [
        {
          method: "GET",
          route: "/healthz",
          statusClass: "2xx",
          requestCount: 1,
          errorCount: 0,
          durationMs: {
            count: 1,
            min: 1.1,
            max: 1.1,
            average: 1.1,
            p50: 1.1,
            p95: 1.1,
            p99: 1.1
          },
          lastSeenAt: "2026-06-26T00:00:00.000Z"
        }
      ]
    });

    expect(snapshot.endpoints[0]?.route).toBe("/healthz");
    expect(JSON.stringify(snapshot)).not.toContain("space_session");
  });

  it("validates launch readiness reports without allowing empty requirement sets", () => {
    const report = launchReadinessSchema.parse({
      id: "launch-readiness",
      status: "BLOCKED",
      generatedAt: "2026-06-27T00:00:00.000Z",
      completionPct: 50,
      passedCount: 1,
      totalCount: 2,
      hardBlockerCount: 1,
      gateCount: 0,
      summary: "Production launch remains blocked by storage.",
      requirements: [
        {
          id: "storage",
          label: "Dedicated storage",
          status: "FAIL",
          severity: "hard",
          message: "Dedicated /opt/spaceapp storage is missing.",
          evidence: [{ label: "Storage checker", ref: "/api/admin/storage" }]
        },
        {
          id: "temporal_worker",
          label: "Temporal worker",
          status: "PASS",
          severity: "none",
          message: "Worker pollers are visible.",
          evidence: [{ label: "Worker status", ref: "RUNNING" }]
        }
      ]
    });

    expect(report.status).toBe("BLOCKED");
    expect(report.requirements[0]?.severity).toBe("hard");
    expect(() => launchReadinessSchema.parse({ ...report, requirements: [] })).toThrow();
  });

  it("validates Temporal worker readiness without exposing secrets", () => {
    const readiness = workerReadinessSchema.parse({
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
      pollerIdentities: ["worker@example"],
      lastPollerAccessAt: "2026-06-26T00:00:00.000Z",
      checkedAt: "2026-06-26T00:00:01.000Z"
    });

    expect(readiness.status).toBe("RUNNING");
    expect(readiness.pollerCount).toBe(2);
    expect(JSON.stringify(readiness)).not.toContain("space_session");
  });

  it("validates storage readiness as bounded filesystem evidence", () => {
    const readiness = storageReadinessSchema.parse({
      id: "space-storage",
      status: "BLOCKED",
      statusReason: "Dedicated app volume is missing.",
      root: {
        path: "/",
        deviceId: "100",
        sizeBytes: 1000,
        availableBytes: 200,
        usedPercent: 80
      },
      app: {
        path: "/opt/spaceapp",
        deviceId: "100",
        sizeBytes: 1000,
        availableBytes: 200,
        usedPercent: 80
      },
      dedicatedAppVolume: false,
      minimumRecommendedFreeBytes: 161061273600,
      checkedAt: "2026-06-26T00:00:00.000Z"
    });

    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.dedicatedAppVolume).toBe(false);
    expect(JSON.stringify(readiness)).not.toContain("space_session");
  });

  it("validates Codex App Server adapter status without implying a live connection", () => {
    const status = codexAppServerStatusSchema.parse({
      id: "codex-app-server",
      status: "READY",
      reasonCode: "CONFIG_SAFE",
      statusReason: "Configured for stdio transport; no live execution smoke has been run.",
      transport: "stdio",
      command: "codex",
      socketPath: null,
      websocketUrl: null,
      schemasGenerated: false,
      schemaManifest: null,
      lastCheckedAt: "2026-06-26T00:00:00.000Z"
    });

    expect(status.status).toBe("READY");
    expect(() =>
      codexAppServerStatusSchema.parse({
        ...status,
        transport: "websocket",
        websocketUrl: "ws://0.0.0.0:4500"
      })
    ).not.toThrow();

    const withManifest = codexAppServerStatusSchema.parse({
      ...status,
      schemasGenerated: true,
      schemaManifest: {
        schemaVersion: 1,
        codexCliVersion: "codex-cli 0.142.2",
        generatedAt: "2026-06-26T00:00:00.000Z",
        jsonSchemaFileCount: 200,
        typeScriptFileCount: 100,
        jsonSchemaBundleSha256: "a".repeat(64),
        typeScriptIndexSha256: "b".repeat(64)
      }
    });
    expect(withManifest.schemaManifest?.schemaVersion).toBe(1);

    const handshake = codexAppServerHandshakeResultSchema.parse({
      id: "codex-app-server",
      status: "ERROR",
      code: "STDIO_SPAWN_NOT_ENABLED",
      message: "Explicit stdio spawn opt-in is required.",
      transport: "stdio",
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:00.100Z",
      durationMs: 100,
      serverInfo: null
    });
    expect(handshake.code).toBe("STDIO_SPAWN_NOT_ENABLED");

    const persisted = codexAppServerHandshakeCheckSchema.parse({
      ...handshake,
      checkId: "codex_handshake:test-1",
      traceId: "req:test-1",
      actorUserId: "user:test-1",
      schemasGenerated: true,
      schemaManifest: {
        schemaVersion: 1,
        codexCliVersion: "codex-cli 0.142.2",
        generatedAt: "2026-06-26T00:00:00.000Z",
        jsonSchemaFileCount: 200,
        typeScriptFileCount: 100,
        jsonSchemaBundleSha256: "a".repeat(64),
        typeScriptIndexSha256: "b".repeat(64)
      },
      checkedAt: handshake.finishedAt
    });
    expect(persisted.checkId).toBe("codex_handshake:test-1");
    expect(JSON.stringify(persisted)).not.toContain("secret");
  });

  it("validates Codex App Server thread and turn smoke contracts without transcript data", () => {
    expect(codexAppServerTurnSmokeInputSchema.parse({})).toEqual({
      prompt: "Reply with exactly: space-ok"
    });
    expect(codexAppServerTurnSmokeInputSchema.parse({ prompt: "  hello  ", model: "gpt-5.4" })).toEqual({
      prompt: "hello",
      model: "gpt-5.4"
    });

    const result = codexAppServerTurnSmokeResultSchema.parse({
      id: "codex-app-server",
      status: "VERIFIED",
      code: "TURN_COMPLETED",
      message: "Codex App Server thread and turn smoke completed.",
      transport: "stdio",
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:02.000Z",
      durationMs: 2000,
      threadId: "thread:test-1",
      turnId: "turn:test-1",
      turnStatus: "completed",
      notificationCount: 3,
      completedNotificationSeen: true
    });
    expect(result.turnStatus).toBe("completed");

    const check = codexAppServerTurnSmokeCheckSchema.parse({
      ...result,
      checkId: "codex_turn_smoke:test-1",
      traceId: "req:test-1",
      actorUserId: "user:test-1",
      schemasGenerated: true,
      schemaManifest: null,
      model: "gpt-5.4",
      checkedAt: result.finishedAt
    });
    expect(check.checkId).toBe("codex_turn_smoke:test-1");
    expect(JSON.stringify(check)).not.toContain("space-ok");
  });

  it("validates MCP gateway contracts as fail-closed status data", () => {
    const gateway = mcpGatewayStatusSchema.parse({
      id: "mcp-gateway",
      status: "DISABLED",
      statusReason: "No MCP server has passed discovery smoke.",
      targetSpecVersion: "2025-11-25",
      approvalMode: "DISABLED",
      serverCount: 1,
      toolCount: 0,
      lastDiscoveryAt: null
    });
    expect(gateway.approvalMode).toBe("DISABLED");

    const server = mcpServerSchema.parse({
      id: "mcp-gateway",
      displayName: "Space MCP Gateway",
      transport: "stdio",
      status: "DISABLED",
      statusReason: "Discovery is disabled until an explicit server config smoke passes.",
      schemaVersion: "2025-11-25",
      configHash: "unconfigured",
      toolCount: 0,
      lastDiscoveredAt: null
    });
    expect(server.status).toBe("DISABLED");

    const tool = mcpToolSchema.parse({
      id: "mcp-gateway:read-only-tool",
      serverId: "mcp-gateway",
      name: "read-only-tool",
      riskLevel: "R1",
      schemaHash: "schema:test-1",
      approvalRequired: true,
      status: "DISABLED",
      statusReason: "Tool execution is disabled until schema capture and allowlist approval."
    });
    expect(tool.approvalRequired).toBe(true);
    const serialized = JSON.stringify({ gateway, server, tool }).toLowerCase();
    for (const fragment of ["sec" + "ret", "tok" + "en", "pass" + "word"]) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it("validates MCP server config contracts without enabling execution", () => {
    const configs = mcpServerConfigListSchema.parse([
      {
        id: "filesystem-readonly",
        displayName: "Filesystem Readonly",
        transport: "stdio",
        command: "space-mcp-filesystem",
        args: ["--readonly"],
        enabled: true
      },
      {
        id: "docs-http",
        displayName: "Docs HTTP",
        transport: "http",
        url: "https://mcp.example.invalid"
      }
    ]);

    expect(configs[0]).toMatchObject({
      id: "filesystem-readonly",
      transport: "stdio",
      args: ["--readonly"],
      enabled: true
    });
    expect(configs[1]).toMatchObject({
      id: "docs-http",
      transport: "http",
      enabled: false
    });
    expect(() => mcpServerConfigSchema.parse({ id: "missing-command", displayName: "Missing", transport: "stdio" })).toThrow();
    expect(() => mcpServerConfigSchema.parse({ id: "missing-url", displayName: "Missing", transport: "http" })).toThrow();
    expect(() =>
      mcpServerConfigListSchema.parse([
        { id: "duplicate", displayName: "One", transport: "stdio", command: "one" },
        { id: "duplicate", displayName: "Two", transport: "stdio", command: "two" }
      ])
    ).toThrow();
  });

  it("validates MCP discovery smoke results as fail-closed evidence", () => {
    const result = mcpDiscoverySmokeResultSchema.parse({
      id: "mcp-gateway",
      status: "DISABLED",
      code: "DISCOVERY_SMOKE_DISABLED",
      message: "Discovery smoke is disabled.",
      targetSpecVersion: "2025-11-25",
      discoveryEnabled: false,
      serverCount: 1,
      toolCount: 0,
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:00.001Z",
      durationMs: 1
    });

    expect(result.status).toBe("DISABLED");
    expect(result.toolCount).toBe(0);
  });

  it("validates durable MCP discovery smoke checks", () => {
    const check = mcpDiscoverySmokeCheckSchema.parse({
      id: "mcp-gateway",
      checkId: "mcp_discovery_smoke:test-1",
      traceId: "req:test-1",
      actorUserId: "user:test-1",
      status: "DISABLED",
      code: "DISCOVERY_SMOKE_DISABLED",
      message: "Discovery smoke is disabled.",
      targetSpecVersion: "2025-11-25",
      discoveryEnabled: false,
      serverCount: 1,
      toolCount: 0,
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:00.001Z",
      durationMs: 1,
      checkedAt: "2026-06-26T00:00:00.001Z"
    });

    expect(check.checkId).toBe("mcp_discovery_smoke:test-1");
    expect(check.traceId).toBe("req:test-1");
  });

  it("validates MCP tool execution contracts with approval and artifact evidence", () => {
    const input = createMcpToolExecutionInputSchema.parse({
      roomId: "room:test-1",
      toolId: "space-smoke:space_status",
      arguments: {},
      approvalReason: "Operator approved safe read-only smoke."
    });
    expect(input).toMatchObject({ roomId: "room:test-1", toolId: "space-smoke:space_status", arguments: {} });

    const result = mcpToolExecutionResultSchema.parse({
      id: "mcp-gateway",
      executionId: "mcp_exec:test-1",
      status: "EXECUTED",
      code: "TOOL_EXECUTION_OK",
      message: "MCP tool execution completed.",
      toolId: "space-smoke:space_status",
      serverId: "space-smoke",
      toolName: "space_status",
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:00.001Z",
      durationMs: 1,
      policy: {
        decision: "REQUIRES_APPROVAL",
        reasonCode: "RISK_APPROVAL_REQUIRED",
        approvalRequired: true,
        canExecuteWithoutApproval: false
      },
      approved: true,
      artifact: {
        id: "artifact:mcp-result",
        roomId: "room:test-1",
        paneId: null,
        turnId: null,
        workflowId: null,
        kind: "MCP_RESULT",
        mimeType: "application/json",
        storageUri: "space-artifact://mcp-executions/mcp_exec%3Atest-1/result.json",
        sha256: "a".repeat(64),
        byteSize: 42,
        metadata: { mcpExecutionId: "mcp_exec:test-1" },
        createdAt: "2026-06-26T00:00:00.001Z"
      }
    });

    expect(result.artifact?.kind).toBe("MCP_RESULT");
    expect(JSON.stringify(result)).not.toContain("space-" + "dev");
    expect(() =>
      createMcpToolExecutionInputSchema.parse({
        toolId: "space-smoke:space_status",
        arguments: { tooLarge: "x".repeat(9000) }
      })
    ).toThrow();
  });

  it("validates Space agent MCP action envelopes and bridge observations", () => {
    const envelope = spaceAgentMcpActionEnvelopeSchema.parse({
      version: 1,
      actions: [
        {
          toolId: "space-readonly:space_status",
          action: { type: "execute", arguments: { scope: "summary" } }
        }
      ]
    });
    expect(envelope.actions[0]?.action.arguments).toEqual({ scope: "summary" });
    expect(() =>
      spaceAgentMcpActionEnvelopeSchema.parse({
        version: 1,
        actions: [
          { toolId: "a:b", action: { type: "execute", arguments: {} } },
          { toolId: "a:c", action: { type: "execute", arguments: {} } },
          { toolId: "a:d", action: { type: "execute", arguments: {} } },
          { toolId: "a:e", action: { type: "execute", arguments: {} } }
        ]
      })
    ).toThrow();

    const response = spaceAgentMcpActionBridgeResponseSchema.parse({
      id: "space-agent-mcp-action-bridge",
      results: [
        {
          request: envelope.actions[0],
          status: "EXECUTED",
          statusReason: "MCP tool execution completed.",
          observation: {
            executionId: "mcp_exec:test-1",
            status: "EXECUTED",
            code: "TOOL_EXECUTION_OK",
            message: "MCP tool execution completed.",
            toolId: "space-readonly:space_status",
            serverId: "space-readonly",
            toolName: "space_status",
            approved: false,
            policyDecision: "ALLOWED",
            policyReasonCode: "SCHEMA_HASH_ALLOWLISTED",
            artifactId: "artifact:mcp-result",
            artifactKind: "MCP_RESULT",
            artifactMimeType: "application/json",
            artifactStorageUri: "space-artifact://mcp-executions/mcp_exec%3Atest-1/result.json",
            durationMs: 5
          }
        }
      ]
    });
    expect(response.results[0]?.observation?.approved).toBe(false);
    expect(JSON.stringify(response)).not.toMatch(/api[_-]?key|secret|password|localPath|sk-/i);
  });

  it("validates Space agent skill action envelopes and observations", () => {
    const envelope = spaceAgentSkillActionEnvelopeSchema.parse({
      version: 1,
      actions: [
        { toolId: "skills:list", action: { type: "list", q: "browser", pageSize: 3 } },
        { toolId: "skills:read", action: { type: "read", skillId: "planning" } }
      ]
    });
    expect(envelope.actions[0]?.action).toMatchObject({ type: "list", pageSize: 3 });
    expect(() =>
      spaceAgentSkillActionEnvelopeSchema.parse({
        version: 1,
        actions: [{ toolId: "skills:list", action: { type: "read", skillId: "planning" } }]
      })
    ).toThrow();

    const response = spaceAgentSkillActionBridgeResponseSchema.parse({
      id: "space-agent-skill-action-bridge",
      results: [
        {
          request: envelope.actions[0],
          status: "EXECUTED",
          statusReason: "Skill list returned 1 match.",
          observation: {
            actionType: "list",
            skillId: null,
            matchCount: 1,
            skills: [
              {
                skillId: "browser-proof",
                displayName: "Browser Proof",
                version: "0.1.0",
                status: "DISABLED",
                statusReason: "Requires browser runtime.",
                triggerDescription: "Collect browser evidence.",
                allowedTools: ["browser:screenshot"],
                contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
              }
            ],
            body: null
          }
        }
      ]
    });
    expect(response.results[0]?.observation?.skills[0]?.skillId).toBe("browser-proof");
    expect(JSON.stringify(response)).not.toMatch(/api[_-]?key|secret|password|localPath|sk-/i);
  });

  it("validates explicit memory save and search contracts", () => {
    const roomMemory = createMemoryEntryInputSchema.parse({
      scope: "ROOM",
      roomId: "room:test-1",
      title: "Launch constraint",
      body: "Use only isolated Space runtime on Space.",
      provenance: "operator",
      tags: ["Space-Agent", "Μνήμη έργου"]
    });
    expect(roomMemory.scope).toBe("ROOM");
    expect(roomMemory.roomId).toBe("room:test-1");
    expect(roomMemory.tags).toEqual(["Space-Agent", "Μνήμη έργου"]);

    const projectMemory = createMemoryEntryInputSchema.parse({
      scope: "PROJECT",
      title: "Storage blocker",
      body: "Dedicated /opt/spaceapp storage remains required.",
      provenance: "history"
    });
    expect(projectMemory.roomId).toBeUndefined();

    expect(() => createMemoryEntryInputSchema.parse({
      scope: "PROJECT",
      title: "Duplicate tags",
      body: "Duplicates are ambiguous.",
      provenance: "test",
      tags: ["Memory", "memory"]
    })).toThrow();
    expect(() => createMemoryEntryInputSchema.parse({
      scope: "PROJECT",
      title: "Too many tags",
      body: "The boundary is enforced.",
      provenance: "test",
      tags: Array.from({ length: 13 }, (_, index) => `tag-${index}`)
    })).toThrow();

    expect(() =>
      createMemoryEntryInputSchema.parse({
        scope: "ROOM",
        title: "Missing room",
        body: "This should be rejected.",
        provenance: "test"
      })
    ).toThrow();
    expect(() =>
      createMemoryEntryInputSchema.parse({
        scope: "SYSTEM",
        roomId: "room:test-1",
        title: "Wrong scope",
        body: "This should be rejected.",
        provenance: "test"
      })
    ).toThrow();

    expect(listMemoryQuerySchema.parse({ q: "storage", scope: "PROJECT", pageSize: "10" })).toMatchObject({
      q: "storage",
      scope: "PROJECT",
      searchMode: "keyword",
      pageSize: 10
    });
    expect(listMemoryQuerySchema.parse({ q: "storage", searchMode: "semantic" })).toMatchObject({
      q: "storage",
      searchMode: "semantic"
    });
    expect(() => listMemoryQuerySchema.parse({ searchMode: "semantic" })).toThrow();
  });

  it("validates memory embedding smoke contracts", () => {
    const result = memoryEmbeddingSmokeResultSchema.parse({
      id: "memory-embedding-smoke",
      status: "DISABLED",
      code: "EMBEDDING_SMOKE_DISABLED",
      message: "Memory embedding smoke is disabled.",
      smokeEnabled: false,
      provider: null,
      model: null,
      dimensions: 1536,
      pgvectorReady: false,
      embeddingProviderReady: false,
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:00.001Z",
      durationMs: 1
    });
    expect(result.id).toBe("memory-embedding-smoke");
    expect(result.dimensions).toBe(1536);

    const check = memoryEmbeddingSmokeCheckSchema.parse({
      ...result,
      checkId: "memory_embed_smoke:test-1",
      traceId: "req:test-1",
      actorUserId: "user:test-1",
      checkedAt: "2026-06-26T00:00:00.001Z"
    });
    expect(check.checkId).toBe("memory_embed_smoke:test-1");
    expect(check.embeddingProviderReady).toBe(false);

    expect(
      memoryEmbeddingSmokeResultSchema.parse({
        ...result,
        status: "ERROR",
        code: "EMBEDDING_PROVIDER_SMOKE_FAILED",
        message: "OpenAI embedding smoke failed with HTTP 401."
      }).code
    ).toBe("EMBEDDING_PROVIDER_SMOKE_FAILED");
  });

  it("validates memory vector readiness contracts", () => {
    const readiness = memoryVectorReadinessSchema.parse({
      id: "memory-vector-readiness",
      status: "VERIFIED",
      code: "MEMORY_VECTOR_READY",
      message: "pgvector extension, memory embedding column and vector index are ready.",
      runtimeStore: "postgres",
      extensionInstalled: true,
      extensionVersion: "0.8.3",
      embeddingColumnReady: true,
      embeddingDimensions: 1536,
      expectedDimensions: 1536,
      vectorIndexReady: true,
      checkedAt: "2026-06-26T00:00:00.000Z"
    });
    expect(readiness.code).toBe("MEMORY_VECTOR_READY");
    expect(readiness.embeddingDimensions).toBe(1536);
  });

  it("validates fail-closed skill proposal contracts", () => {
    const proposal = createSkillProposalInputSchema.parse({
      displayName: "  Browser QA  ",
      triggerDescription: "  Use after UI changes  ",
      body: "Capture screenshot and console evidence.",
      allowedTools: [" browser.captureScreenshot ", "browser.collectConsole"]
    });

    expect(proposal).toEqual({
      displayName: "Browser QA",
      version: "0.1.0",
      triggerDescription: "Use after UI changes",
      body: "Capture screenshot and console evidence.",
      allowedTools: ["browser.captureScreenshot", "browser.collectConsole"]
    });
    expect(() => createSkillProposalInputSchema.parse({ displayName: "No body", triggerDescription: "x", body: "" })).toThrow();

    const skill = skillSchema.parse({
      id: "skill:test",
      displayName: "Browser QA",
      version: "0.1.0",
      status: "DISABLED",
      statusReason: "Operator proposal recorded.",
      triggerDescription: "Use after UI changes",
      body: "Capture screenshot and console evidence.",
      allowedTools: ["browser.captureScreenshot"],
      contentHash: `sha256:${"a".repeat(64)}`,
      source: "OPERATOR_PROPOSAL",
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z"
    });
    expect(skill.status).toBe("DISABLED");
    expect(skill.source).toBe("OPERATOR_PROPOSAL");
  });

  it("validates explicit import gate contracts", () => {
    const candidateInput = createImportCandidateInputSchema.parse({
      sourceKind: "CODEX_MEMORY",
      targetKind: "MEMORY",
      sourceRef: "operator-paste",
      roomId: "room:test-1",
      title: "Imported memory",
      body: "Copy the source content into Space.",
      provenance: "explicit-import-gate"
    });
    expect(candidateInput).toMatchObject({
      sourceKind: "CODEX_MEMORY",
      targetKind: "MEMORY",
      memoryScope: "ROOM"
    });
    expect(() =>
      createImportCandidateInputSchema.parse({
        sourceKind: "CODEX_MEMORY",
        targetKind: "MEMORY",
        title: "Missing room",
        body: "No room id.",
        sourceRef: "operator-paste"
      })
    ).toThrow();
    expect(() =>
      createImportCandidateInputSchema.parse({
        sourceKind: "CODEX_SKILL",
        targetKind: "SKILL",
        title: "Missing trigger",
        body: "Skill body.",
        sourceRef: "operator-paste"
      })
    ).toThrow();

    const candidate = importCandidateSchema.parse({
      id: "import:test-1",
      sourceKind: "CODEX_MEMORY",
      targetKind: "MEMORY",
      status: "PENDING",
      statusReason: "Awaiting decision.",
      sourceRef: "operator-paste",
      roomId: "room:test-1",
      memoryScope: "ROOM",
      title: "Imported memory",
      body: "Copy the source content into Space.",
      provenance: "explicit-import-gate",
      skillVersion: null,
      skillTriggerDescription: null,
      allowedTools: [],
      importedMemoryId: null,
      importedSkillId: null,
      createdAt: "2026-06-26T00:00:00.000Z",
      decidedAt: null
    });
    expect(candidate.status).toBe("PENDING");
    expect(importCandidateDecisionInputSchema.parse({ decision: "IMPORT" })).toMatchObject({ decision: "IMPORT" });
    expect(() => importCandidateDecisionInputSchema.parse({ decision: "REJECT" })).toThrow();
    expect(listImportCandidatesQuerySchema.parse({ status: "PENDING", targetKind: "MEMORY" })).toMatchObject({
      status: "PENDING",
      targetKind: "MEMORY"
    });
    expect(eventTypeSchema.parse("IMPORT_CANDIDATE_CREATED")).toBe("IMPORT_CANDIDATE_CREATED");
  });

  it("validates workflow, artifact, and dummy turn contracts", () => {
    const workflow = workflowRunSchema.parse({
      workflowId: "workflow:turn-1",
      runId: null,
      type: "AGENT_TURN",
      taskQueue: "space-agent-turns",
      status: "PENDING",
      roomId: "room:test-1",
      paneId: "pane:test-1",
      traceId: "trace:test-1",
      startedAt: "2026-06-25T00:00:00.000Z",
      closedAt: null
    });
    expect(workflow.type).toBe("AGENT_TURN");

    const artifact = artifactSchema.parse({
      id: "artifact:test-1",
      roomId: "room:test-1",
      paneId: "pane:test-1",
      turnId: null,
      workflowId: "workflow:turn-1",
      kind: "SCREENSHOT",
      mimeType: "image/png",
      storageUri: "cas://sha256/a".padEnd(78, "a"),
      sha256: "a".repeat(64),
      byteSize: 42,
      createdAt: "2026-06-25T00:00:00.000Z"
    });
    expect(artifact.metadata).toEqual({});
    const artifactInput = createArtifactInputSchema.parse({
      roomId: "room:test-1",
      paneId: "pane:test-1",
      workflowId: "workflow:turn-1",
      kind: "SCREENSHOT",
      mimeType: " image/png ",
      storageUri: " cas://sha256/".padEnd(78, "a"),
      sha256: "b".repeat(64),
      byteSize: "42",
      metadata: { viewport: "1440x900" }
    });
    expect(artifactInput.mimeType).toBe("image/png");
    expect(artifactInput.byteSize).toBe(42);
    expect(artifactInput.metadata).toEqual({ viewport: "1440x900" });
    expect(listArtifactsQuerySchema.parse({ roomId: "room:test-1", kind: "SCREENSHOT", pageSize: "10" })).toMatchObject({
      roomId: "room:test-1",
      kind: "SCREENSHOT",
      pageSize: 10
    });

    const browserEvidenceInput = createBrowserEvidenceInputSchema.parse({
      roomId: "room:test-1",
      paneId: null,
      viewport: "desktop"
    });
    expect(browserEvidenceInput).toEqual({
      roomId: "room:test-1",
      paneId: null,
      viewport: "desktop"
    });
    expect(createBrowserEvidenceInputSchema.parse({ roomId: "room:test-1" }).viewport).toBe("desktop");
    expect(() => createBrowserEvidenceInputSchema.parse({ roomId: "room:test-1", viewport: "giant" })).toThrow();
    expect(
      browserEvidenceCaptureSchema.parse({
        captureId: "browser_capture:test-1",
        roomId: "room:test-1",
        paneId: null,
        viewport: "desktop",
        targetUrl: "http://127.0.0.1:4911/",
        artifacts: [
          { ...artifact, kind: "SCREENSHOT", mimeType: "image/png" },
          { ...artifact, id: "artifact:test-2", kind: "DOM_SNAPSHOT", mimeType: "application/json" },
          { ...artifact, id: "artifact:test-3", kind: "CONSOLE_LOG", mimeType: "application/json" },
          { ...artifact, id: "artifact:test-4", kind: "NETWORK_LOG", mimeType: "application/json" }
        ],
        createdAt: "2026-06-25T00:00:00.000Z"
      }).artifacts.map((item) => item.kind)
    ).toEqual(["SCREENSHOT", "DOM_SNAPSHOT", "CONSOLE_LOG", "NETWORK_LOG"]);

    const input = dummyTurnInputSchema.parse({
      roomId: "room:test-1",
      paneId: "pane:test-1",
      prompt: "hello",
      providerId: "codex-lb",
      modelId: "gpt-5.5",
      reasoningEffort: "high",
      permissionMode: "approve_for_me",
      collaborationMode: "plan",
      traceId: "trace:test-1"
    });
    expect(input).toMatchObject({
      providerId: "codex-lb",
      modelId: "gpt-5.5",
      reasoningEffort: "high"
    });
    expect(input).toMatchObject({ permissionMode: "approve_for_me", collaborationMode: "plan" });
    expect(
      dummyTurnInputSchema.parse({
        roomId: "room:test-1",
        paneId: "pane:test-1",
        prompt: "future effort",
        reasoningEffort: "research",
        traceId: "trace:test-research"
      }).reasoningEffort
    ).toBe("research");
    expect(() =>
      dummyTurnInputSchema.parse({
        roomId: "room:test-1",
        paneId: "pane:test-1",
        prompt: "unsafe effort",
        reasoningEffort: "bad reason",
        traceId: "trace:test-unsafe-reasoning"
      })
    ).toThrow();
    expect(
      dummyTurnInputSchema.parse({
        roomId: "room:test-1",
        paneId: "pane:test-1",
        prompt: "x".repeat(5000),
        traceId: "trace:test-long-prompt"
      }).prompt
    ).toHaveLength(5000);
    expect(createTurnInputSchema.parse({ roomId: input.roomId, paneId: input.paneId, prompt: input.prompt })).toEqual({
      roomId: "room:test-1",
      paneId: "pane:test-1",
      prompt: "hello",
      artifactIds: [],
      runtime: "DUMMY_TEMPORAL"
    });
    expect(input.artifactIds).toEqual([]);
    expect(
      createTurnInputSchema.parse({
        roomId: input.roomId,
        paneId: input.paneId,
        prompt: input.prompt,
        artifactIds: ["artifact:test-1"]
      }).artifactIds
    ).toEqual(["artifact:test-1"]);
    expect(() =>
      createTurnInputSchema.parse({
        roomId: input.roomId,
        paneId: input.paneId,
        prompt: input.prompt,
        artifactIds: Array.from({ length: turnArtifactMaxCount + 1 }, (_, index) => `artifact:test-${index}`)
      })
    ).toThrow();
    expect(
      createTurnInputSchema.parse({
        roomId: input.roomId,
        paneId: input.paneId,
        prompt: input.prompt,
        runtime: "CODEX_APP_SERVER"
      }).runtime
    ).toBe("CODEX_APP_SERVER");
    expect(turnRuntimeSchema.parse("DUMMY_TEMPORAL")).toBe("DUMMY_TEMPORAL");
    const result = dummyTurnResultSchema.parse({
      workflowId: buildDummyTurnWorkflowId(input),
      roomId: input.roomId,
      paneId: input.paneId,
      traceId: input.traceId,
      status: "COMPLETED",
      message: "Dummy turn completed."
    });
    expect(result.status).toBe("COMPLETED");
    const failedResult = turnWorkflowResultSchema.parse({
      workflowId: buildCodexAppServerTurnWorkflowId(input),
      roomId: input.roomId,
      paneId: input.paneId,
      traceId: input.traceId,
      status: "FAILED",
      message: "Codex App Server real turn workflow is not implemented yet."
    });
    expect(failedResult.status).toBe("FAILED");
    expect(eventTypeSchema.parse("TURN_FAILED")).toBe("TURN_FAILED");
    expect(
      turnStartResultSchema.parse({
        workflowId: buildDummyTurnWorkflowId(input),
        runId: "run:test-1",
        roomId: input.roomId,
        paneId: input.paneId,
        traceId: input.traceId,
        status: "QUEUED"
      }).status
    ).toBe("QUEUED");
    expect(
      turnStartResultSchema.parse({
        workflowId: buildCodexAppServerTurnWorkflowId(input),
        runId: "run:test-1",
        roomId: input.roomId,
        paneId: input.paneId,
        traceId: input.traceId,
        status: "QUEUED",
        runtime: "CODEX_APP_SERVER",
        turnId: "turn:test-1"
      }).turnId
    ).toBe("turn:test-1");
    expect(
      turnSchema.parse({
        id: "turn:test-1",
        roomId: input.roomId,
        paneId: input.paneId,
        workflowId: buildDummyTurnWorkflowId(input),
        providerId: null,
        modelId: null,
        status: "QUEUED",
        promptHash: "a".repeat(64),
        createdAt: "2026-06-25T00:00:00.000Z",
        updatedAt: "2026-06-25T00:00:00.000Z"
      })
    ).toMatchObject({ status: "QUEUED", prompt: null, artifactIds: [] });
    expect(imageArtifactMimeTypeSchema.parse("image/png")).toBe("image/png");
    expect(userUploadArtifactSourceSchema.parse("CLIPBOARD")).toBe("CLIPBOARD");
    expect(imageArtifactMaxBytes).toBe(10 * 1024 * 1024);
    const reviewInput = createReviewDecisionInputSchema.parse({
      roomId: "room:test-1",
      workflowId: "workflow:turn-1",
      decision: "BLOCK",
      summary: "Tests failed before ship.",
      evidenceArtifactIds: ["artifact:test-1"],
      rollbackNote: "Revert the last workspace patch."
    });
    expect(reviewInput.evidenceArtifactIds).toEqual(["artifact:test-1"]);
    expect(
      reviewDecisionSchema.parse({
        id: "review:test-1",
        ...reviewInput,
        createdAt: "2026-06-25T00:00:00.000Z"
      }).decision
    ).toBe("BLOCK");
    expect(listReviewDecisionsQuerySchema.parse({ roomId: "room:test-1", pageSize: "10" })).toMatchObject({
      roomId: "room:test-1",
      pageSize: 10
    });
    const reviewCheck = createReviewCheckInputSchema.parse({
      roomId: "room:test-1",
      reviewDecisionId: "review:test-1",
      name: " npm test ",
      status: "PASS",
      command: "npm test",
      summary: "All tests passed.",
      artifactIds: ["artifact:test-1"],
      metadata: { suite: "unit" }
    });
    expect(reviewCheck.name).toBe("npm test");
    expect(
      reviewCheckSchema.parse({
        id: "review_check:test-1",
        ...reviewCheck,
        createdAt: "2026-06-25T00:00:00.000Z"
      }).status
    ).toBe("PASS");
    expect(listReviewChecksQuerySchema.parse({ roomId: "room:test-1", status: "PASS" })).toMatchObject({
      roomId: "room:test-1",
      status: "PASS"
    });
    const diff = createReviewDiffSummaryInputSchema.parse({
      roomId: "room:test-1",
      reviewDecisionId: "review:test-1",
      title: "Review UI",
      filePath: "apps/web/src/App.tsx",
      status: "MODIFIED",
      additions: "12",
      deletions: 3,
      patchArtifactId: "artifact:test-1",
      summary: "Adds review aggregation controls."
    });
    expect(diff.additions).toBe(12);
    expect(
      reviewDiffSummarySchema.parse({
        id: "review_diff:test-1",
        ...diff,
        createdAt: "2026-06-25T00:00:00.000Z"
      }).status
    ).toBe("MODIFIED");
    expect(listReviewDiffSummariesQuerySchema.parse({ roomId: "room:test-1", status: "MODIFIED" })).toMatchObject({
      roomId: "room:test-1",
      status: "MODIFIED"
    });
    const memoryChangeInput = createMemoryChangeSetInputSchema.parse({
      kind: "MERGE",
      sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      recordIds: ["memory_graph_record:first", "memory_graph_record:second"],
      resolvesIssueIds: ["memory_graph_issue:duplicate"],
      expectedSourceHash: "a".repeat(64),
      beforeContentHash: "b".repeat(64),
      afterContentHash: "c".repeat(64),
      beforeSnapshot: "before\n",
      afterSnapshot: "after\n",
      reason: "Merge a confirmed duplicate.",
      actorUserId: "user:operator"
    });
    expect(memoryChangeInput.recordIds).toHaveLength(2);
    expect(
      memoryChangeSetSchema.parse({
        id: "memory_change:test-1",
        ...memoryChangeInput,
        status: "PROPOSED",
        resultingSourceHash: null,
        statusReason: null,
        rollbackOfChangeSetId: null,
        rolledBackByChangeSetId: null,
        traceId: "trace:memory-change",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
        appliedAt: null,
        failedAt: null,
        rolledBackAt: null
      }).kind
    ).toBe("MERGE");
    expect(
      createMemoryChangeSetInputSchema.safeParse({
        ...memoryChangeInput,
        kind: "ROLLBACK",
        rollbackOfChangeSetId: undefined
      }).success
    ).toBe(false);
    expect(createMemoryNodeChangeSetInputSchema.parse({
      kind: "EDIT",
      expectedContentHash: "a".repeat(64),
      body: "## Updated memory\n- Durable fact.",
      reason: "Correct the reviewed durable fact."
    }).kind).toBe("EDIT");
    expect(createMemoryNodeChangeSetInputSchema.parse({
      kind: "ARCHIVE",
      expectedContentHash: "a".repeat(64),
      reason: "Archive the superseded durable fact."
    }).kind).toBe("ARCHIVE");
    expect(createMemoryNodeChangeSetInputSchema.parse({
      kind: "MERGE",
      expectedContentHash: "a".repeat(64),
      targetRecordId: "memory:canonical",
      reason: "Merge the reviewed duplicate into its canonical record."
    }).kind).toBe("MERGE");
    expect(createMemoryNodeChangeSetInputSchema.safeParse({
      kind: "ARCHIVE",
      expectedContentHash: "a".repeat(64),
      reason: "Archive the record.",
      body: "client-supplied whole file"
    }).success).toBe(false);
    expect(
      createMemoryChangeSetInputSchema.safeParse({
        ...memoryChangeInput,
        kind: "EDIT",
        rollbackOfChangeSetId: "memory_change:test-0"
      }).success
    ).toBe(false);
    expect(updateMemoryChangeSetInputSchema.parse({ status: "APPLIED", resultingSourceHash: "d".repeat(64) })).toEqual({
      status: "APPLIED",
      resultingSourceHash: "d".repeat(64)
    });
    expect(updateMemoryChangeSetInputSchema.safeParse({ status: "APPLIED" }).success).toBe(false);
    expect(updateMemoryChangeSetInputSchema.safeParse({ status: "FAILED" }).success).toBe(false);
    expect(
      updateMemoryChangeSetInputSchema.safeParse({
        status: "APPROVED",
        expectedSourceHash: "d".repeat(64)
      }).success
    ).toBe(false);
    expect(
      listMemoryChangeSetsQuerySchema.parse({ status: "APPLIED", recordId: "memory_graph_record:first", pageSize: "10" })
    ).toMatchObject({ status: "APPLIED", recordId: "memory_graph_record:first", pageSize: 10 });
    expect(
      memoryMaintenanceInputSchema.parse({
        scheduledAt: "2026-07-13T00:30:00.000Z",
        traceId: "trace:memory-maintenance-2026-07-13"
      }).traceId
    ).toBe("trace:memory-maintenance-2026-07-13");
    expect(
      memoryMaintenanceResultSchema.parse({
        status: "REFRESHED",
        generatedAt: "2026-07-13T00:30:01.000Z",
        sourceHash: "a".repeat(64),
        previousSourceHash: null,
        summary: { sourceCount: 2, recordCount: 1, nodeCount: 4, edgeCount: 3, issueCount: 0 },
        durationMs: 25
      }).status
    ).toBe("REFRESHED");
    const preparedJournal = {
      version: 1,
      phase: "PREPARED",
      changeSetId: "memory_change:test",
      sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      expectedSourceHash: "a".repeat(64),
      beforeContentHash: "b".repeat(64),
      afterContentHash: "c".repeat(64),
      resultingSourceHash: null,
      preparedAt: "2026-07-13T01:00:00.000Z",
      updatedAt: "2026-07-13T01:00:00.000Z"
    } as const;
    expect(memoryMutationJournalSchema.parse(preparedJournal).phase).toBe("PREPARED");
    expect(memoryMutationJournalSchema.safeParse({ ...preparedJournal, canonicalBody: "must not persist" }).success).toBe(false);
    expect(memoryMutationJournalSchema.safeParse({ ...preparedJournal, phase: "WRITTEN" }).success).toBe(false);
    expect(
      memoryMutationJournalSchema.parse({
        ...preparedJournal,
        phase: "WRITTEN",
        resultingSourceHash: "d".repeat(64),
        updatedAt: "2026-07-13T01:00:01.000Z"
      }).phase
    ).toBe("WRITTEN");
    expect(
      memoryMutationExecutionResultSchema.parse({
        status: "APPLIED",
        changeSetId: preparedJournal.changeSetId,
        sourcePath: preparedJournal.sourcePath,
        resultingSourceHash: "d".repeat(64),
        journalPath: "/opt/spaceapp/var/memory-graph/mutations/memory_change:test.json",
        durationMs: 50
      }).status
    ).toBe("APPLIED");
    expect(
      memoryMutationRecoveryResultSchema.parse({
        status: "OPERATOR_REQUIRED",
        changeSetId: preparedJournal.changeSetId,
        sourcePath: preparedJournal.sourcePath,
        resultingSourceHash: null,
        reason: "Canonical content matches neither immutable snapshot hash."
      }).status
    ).toBe("OPERATOR_REQUIRED");
    expect(
      memoryMutationWorkflowInputSchema.parse({
        changeSetId: "memory_change:adapter",
        traceId: "trace:mutation-workflow"
      }).changeSetId
    ).toBe("memory_change:adapter");
    expect(
      memoryMutationWorkflowResultSchema.parse({
        status: "APPLIED",
        changeSetId: "memory_change:adapter",
        resultingSourceHash: "e".repeat(64),
        reason: null
      }).status
    ).toBe("APPLIED");
    expect(
      reviewRoomStateSchema.parse({
        decisions: [
          {
            id: "review:test-1",
            ...reviewInput,
            createdAt: "2026-06-25T00:00:00.000Z"
          }
        ],
        checks: [
          {
            id: "review_check:test-1",
            ...reviewCheck,
            createdAt: "2026-06-25T00:00:00.000Z"
          }
        ],
        diffs: [
          {
            id: "review_diff:test-1",
            ...diff,
            createdAt: "2026-06-25T00:00:00.000Z"
          }
        ],
        artifacts: [artifact],
        gateStatus: "PASS",
        statusReason: "Checks are passing."
      }).gateStatus
    ).toBe("PASS");
    expect(() => artifactSchema.parse({ ...artifact, sha256: "not-a-sha" })).toThrow();
    expect(() =>
      createArtifactInputSchema.parse({
        ...artifactInput,
        metadata: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, index]))
      })
    ).toThrow();
  });

  it("validates swarm control-plane contracts without enabling agent execution", () => {
    const createdTask = createSwarmTaskInputSchema.parse({
      roomId: "room:test-1",
      title: "  Implement task graph  ",
      goal: "Build control-plane orchestration.",
      dependsOnTaskIds: ["swarm_task:dep-1", "swarm_task:dep-1"]
    });
    expect(createdTask).toMatchObject({
      roomId: "room:test-1",
      role: "WORKER",
      title: "Implement task graph",
      dependsOnTaskIds: ["swarm_task:dep-1", "swarm_task:dep-1"]
    });

    const task = swarmTaskSchema.parse({
      id: "swarm_task:test-1",
      roomId: "room:test-1",
      parentTaskId: null,
      role: "PLANNER",
      title: "Task graph",
      goal: "Plan work.",
      status: "PLANNED",
      assignee: null,
      dependsOnTaskIds: [],
      lockIds: [],
      resultSummary: null,
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
      completedAt: null
    });
    expect(task.role).toBe("PLANNER");
    expect(updateSwarmTaskInputSchema.parse({ status: "DONE", resultSummary: "Complete" })).toEqual({
      status: "DONE",
      resultSummary: "Complete"
    });

    const lockInput = claimSwarmLockInputSchema.parse({
      roomId: "room:test-1",
      taskId: task.id,
      resource: "  /opt/spaceapp  ",
      holder: "worker-1",
      reason: "Prevent write collision."
    });
    expect(lockInput.resource).toBe("/opt/spaceapp");
    expect(releaseSwarmLockInputSchema.parse({})).toEqual({ reason: "Released by operator." });

    const lock = swarmLockSchema.parse({
      id: "swarm_lock:test-1",
      roomId: "room:test-1",
      taskId: task.id,
      resource: "/opt/spaceapp",
      status: "ACTIVE",
      holder: "worker-1",
      reason: "Prevent write collision.",
      createdAt: "2026-06-26T00:00:00.000Z",
      releasedAt: null
    });
    expect(lock.status).toBe("ACTIVE");

    const message = swarmMessageSchema.parse({
      id: "swarm_msg:test-1",
      roomId: "room:test-1",
      taskId: task.id,
      fromRole: "WORKER",
      toRole: "REVIEWER",
      body: "Ready for review.",
      createdAt: "2026-06-26T00:00:00.000Z"
    });
    const parsedMessageInput = postSwarmMessageInputSchema.parse({
      roomId: "room:test-1",
      fromRole: "WORKER",
      body: "  hello  "
    });
    expect(parsedMessageInput).toMatchObject({ body: "hello" });
    expect("toRole" in parsedMessageInput).toBe(false);
    expect(message.toRole).toBe("REVIEWER");

    const reconcileInput = createSwarmReconcileInputSchema.parse({
      roomId: "room:test-1",
      taskIds: [task.id],
      decision: "BLOCKED",
      summary: "Needs human decision."
    });
    expect(reconcileInput.nextSteps).toBe("");

    const reconcile = swarmReconcileSchema.parse({
      id: "swarm_reconcile:test-1",
      roomId: "room:test-1",
      taskIds: [task.id],
      decision: "BLOCKED",
      summary: "Needs human decision.",
      nextSteps: "",
      createdAt: "2026-06-26T00:00:00.000Z"
    });
    expect(reconcile.decision).toBe("BLOCKED");

    const state = swarmStateSchema.parse({
      tasks: [task],
      locks: [lock],
      messages: [message],
      reconciles: [reconcile],
      executionStatus: "READY",
      statusReason: "Swarm execution can queue tasks into Space CHAT panes."
    });
    expect(state.executionStatus).toBe("READY");

    const runInput = runSwarmTaskInputSchema.parse({
      paneId: "pane:test-1",
      prompt: "  Use the managed browser if needed.  "
    });
    expect(runInput.prompt).toBe("Use the managed browser if needed.");

    const runResponse = runSwarmTaskResponseSchema.parse({
      task,
      message,
      agentSession: {
        binding: {
          paneId: "pane:test-1",
          source: "SPACE",
          sessionId: "agent_session:test-1",
          coderChatId: null,
          status: "READY",
          title: "Planner",
          selectedModelConfigId: "codex-app-server-default",
          selectedProviderName: "Space Codex",
          selectedModelName: "Codex App Server default",
          selectedReasoningKey: "medium",
          selectedToolIds: ["memory:search", "memory:save"],
          lastSyncedAt: "2026-06-26T00:00:00.000Z"
        },
        threadId: null,
        messages: [],
        runStatus: "IDLE",
        statusReason: "Space agent session is ready.",
        modelOptions: [
          {
            id: "codex-app-server-default",
            displayName: "Codex App Server default",
            providerId: null,
            providerName: "Space Codex",
            model: null,
            reasoningKey: "medium",
            reasoningLabel: "Medium reasoning",
            isDefault: true
          }
        ],
        selectedModelConfigId: "codex-app-server-default",
        toolOptions: [],
        selectedToolIds: ["memory:search", "memory:save"],
        history: [],
        capabilities: {
          canSend: true,
          canInterrupt: false,
          canSelectModel: true,
          canSelectTools: true,
          supportsTools: true
        }
      }
    });
    expect(runResponse.message.taskId).toBe(task.id);
    expect(eventTypeSchema.options).toEqual(
      expect.arrayContaining([
        "SWARM_TASK_CREATED",
        "SWARM_TASK_UPDATED",
        "SWARM_LOCK_CLAIMED",
        "SWARM_LOCK_RELEASED",
        "SWARM_MESSAGE_POSTED",
        "SWARM_RECONCILED"
      ])
    );
  });

  it("parses bounded memory graph, node detail and issue query contracts", () => {
    const payload = memoryGraphPayloadSchema.parse({
      version: 1,
      generatedAt: "2026-07-13T08:00:00.000Z",
      sourceHash: "a".repeat(64),
      isStale: false,
      summary: { sourceCount: 2, recordCount: 1, nodeCount: 3, edgeCount: 2, issueCount: 1 },
      nodes: [
        {
          id: "memory:test",
          type: "MEMORY",
          label: "Agent Memory",
          sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
          recordId: "memory:test",
          clusterId: "source:monthly",
          cacheRecordId: null,
          position: {
            clustered: { x: 0.25, y: -0.5 },
            relations: { x: -0.75, y: 0.5 }
          }
        }
      ],
      edges: [],
      layoutVersion: 1,
      filters: {
        q: "agent",
        nodeType: "MEMORY",
        scope: "SYSTEM",
        roomId: null,
        sourcePath: null,
        lifecycleStatus: "ACTIVE",
        relationMode: "CLUSTERED"
      }
    });
    expect(payload.nodes[0]?.type).toBe("MEMORY");

    const detail = memoryGraphNodeDetailSchema.parse({
      node: payload.nodes[0],
      record: {
        id: "memory:test",
        sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
        sectionId: "section:test",
        title: "Agent Memory",
        body: "## Agent Memory\n- Durable fact.",
        createdAt: "2026-07-13T08:00:00.000Z",
        scope: "SYSTEM",
        roomId: null,
        provenance: "operator",
        contentHash: "b".repeat(64),
        lifecycleStatus: "ACTIVE",
        tags: ["Space-Agent"],
        topics: [
          { label: "Space-Agent", origin: "EXPLICIT_TAG", confidence: 1 },
          { label: "memory", origin: "DERIVED_TFIDF", confidence: 0.82 }
        ],
        sourceStart: 10,
        sourceEnd: 52,
        markerId: "memory:test"
      },
      relatedNodes: [],
      relatedEdges: [{
        id: "edge:tagged",
        type: "TAGGED_WITH",
        source: "memory:test",
        target: "topic:space-agent",
        origin: "EXPLICIT_TAG",
        confidence: 1,
        evidence: "Explicit canonical tag: Space-Agent."
      }],
      issues: []
    });
    expect(detail.record?.contentHash).toHaveLength(64);
    expect(detail.record?.topics).toContainEqual(expect.objectContaining({ origin: "DERIVED_TFIDF" }));
    expect(detail.relatedEdges[0]).toMatchObject({ type: "TAGGED_WITH", origin: "EXPLICIT_TAG", confidence: 1 });
    expect(() => memoryGraphNodeDetailSchema.parse({
      ...detail,
      relatedEdges: [{
        id: "edge:unexplained",
        type: "SEMANTICALLY_RELATED",
        source: "memory:test",
        target: "memory:other"
      }]
    })).toThrow();

    const snapshot = memoryGraphSnapshotSchema.parse({
      version: 1,
      layoutVersion: 1,
      generatedAt: payload.generatedAt,
      sourceHash: payload.sourceHash,
      records: [detail.record],
      nodes: payload.nodes,
      edges: [],
      issues: [],
      summary: { sourceCount: 1, recordCount: 1, nodeCount: 1, edgeCount: 0, issueCount: 0 }
    });
    expect(snapshot.layoutVersion).toBe(1);
    expect(() => memoryGraphSnapshotSchema.parse({
      ...snapshot,
      summary: { ...snapshot.summary, nodeCount: 2 }
    })).toThrow();
    expect(() => memoryGraphSnapshotSchema.parse({
      ...snapshot,
      nodes: [{ ...snapshot.nodes[0], position: undefined }]
    })).toThrow();
    const legacySnapshot = memoryGraphSnapshotSchema.parse({
      ...snapshot,
      layoutVersion: undefined,
      nodes: [{ ...snapshot.nodes[0], position: undefined }]
    });
    expect(legacySnapshot.version).toBe(1);

    const previousTaxonomySnapshot = memoryGraphSnapshotSchema.parse({
      ...snapshot,
      version: 2,
      layoutVersion: 2,
      taxonomyVersion: 1,
      revisionHash: "c".repeat(64)
    });
    expect(previousTaxonomySnapshot).toMatchObject({ version: 2, layoutVersion: 2, taxonomyVersion: 1 });
    const versionTwoSnapshot = memoryGraphSnapshotSchema.parse({
      ...previousTaxonomySnapshot,
      taxonomyVersion: 2
    });
    expect(versionTwoSnapshot).toMatchObject({ version: 2, layoutVersion: 2, taxonomyVersion: 2 });
    expect(() => memoryGraphSnapshotSchema.parse({
      ...versionTwoSnapshot,
      nodes: [{ ...versionTwoSnapshot.nodes[0], position: undefined }]
    })).toThrow();

    const overview = memoryGraphOverviewPayloadSchema.parse({
      ...payload,
      version: 2,
      layoutVersion: 2,
      taxonomyVersion: 2,
      revisionHash: "c".repeat(64),
      totalMatchingNodes: 1,
      totalMatchingEdges: 0,
      truncated: false
    });
    expect(overview.totalMatchingNodes).toBe(1);
    expect(listMemoryGraphOverviewQuerySchema.parse({ nodeType: "MEMORY" })).toMatchObject({
      nodeType: "MEMORY",
      relationMode: "RELATIONS"
    });

    expect(memoryCacheLinkSchema.parse({
      memoryRecordId: "memory:cache-record",
      canonicalMemoryId: "memory:canonical-record",
      linkSource: "EXACT_BACKFILL",
      linkedAt: payload.generatedAt
    }).canonicalMemoryId).toBe("memory:canonical-record");
    expect(listMemoryCacheLinksQuerySchema.parse({
      memoryRecordIds: ["memory:cache-record"],
      limit: 25
    })).toEqual({ memoryRecordIds: ["memory:cache-record"], limit: 25 });
    expect(listMemoryCacheLinksQuerySchema.parse({}).limit).toBe(500);
    expect(() => listMemoryCacheLinksQuerySchema.parse({ limit: 501 })).toThrow();
    expect(upsertMemoryIssueStateInputSchema.parse({
      issueId: "memory_issue:duplicate",
      issueType: "EXACT_DUPLICATE",
      recordId: "memory:canonical-record",
      sourceHash: payload.sourceHash,
      status: "IGNORED",
      reason: "Reviewed duplicate.",
      actorUserId: "user:operator",
      expectedVersion: 2
    }).expectedVersion).toBe(2);
    expect(patchMemoryIssueInputSchema.parse({
      status: "RESOLVED",
      reason: "  Confirmed by the operator.  ",
      expectedVersion: 2
    })).toEqual({
      status: "RESOLVED",
      reason: "Confirmed by the operator.",
      expectedVersion: 2
    });
    expect(patchMemoryIssueInputSchema.safeParse({ status: "IGNORED" }).success).toBe(false);
    expect(patchMemoryIssueInputSchema.safeParse({
      status: "RESOLVED",
      actorUserId: "user:forged",
      sourceHash: payload.sourceHash
    }).success).toBe(false);
    expect(listMemoryIssueStatesQuerySchema.parse({
      issueIds: ["issue:first", "issue:second"],
      pageSize: 500
    })).toMatchObject({ issueIds: ["issue:first", "issue:second"], pageSize: 500 });
    expect(listMemoryIssueStatesQuerySchema.safeParse({
      issueIds: Array.from({ length: 501 }, (_, index) => `issue:${index}`),
      pageSize: 500
    }).success).toBe(false);

    const consolidationRun = memoryConsolidationRunSchema.parse({
      id: "memory_consolidation:run-1",
      mode: "AUDIT",
      triggerKind: "OPERATOR",
      status: "RUNNING",
      workflowId: "workflow:memory-consolidation-1",
      dedupeKey: "operator:memory-consolidation-1",
      sourceHash: payload.sourceHash,
      actorUserId: "user:operator",
      progressCompleted: 1,
      progressTotal: 3,
      findingCount: 1,
      appliedOperationCount: 0,
      skippedOperationCount: 0,
      failedOperationCount: 0,
      metrics: {},
      modelId: null,
      aiVerified: false,
      aiEvidence: {},
      statusReason: null,
      createdAt: payload.generatedAt,
      startedAt: payload.generatedAt,
      completedAt: null,
      updatedAt: payload.generatedAt
    });
    expect(consolidationRun.status).toBe("RUNNING");
    expect(createMemoryConsolidationInputSchema.parse({ mode: "AUDIT" })).toEqual({ mode: "AUDIT" });
    expect(createMemoryConsolidationInputSchema.safeParse({ mode: "REPAIR", actorUserId: "user:forged" }).success)
      .toBe(false);
    expect(memoryConsolidationWorkflowInputSchema.parse({
      runId: consolidationRun.id,
      traceId: "trace:memory-consolidation"
    }).runId).toBe(consolidationRun.id);
    expect(memoryConsolidationCommandResponseSchema.parse({
      run: consolidationRun,
      schedule: {
        status: "SCHEDULED",
        workflowId: consolidationRun.workflowId,
        runId: "temporal-run:memory-consolidation"
      },
      maintenanceEnabled: true,
      mutationsEnabled: false
    }).schedule.status).toBe("SCHEDULED");
    expect(memoryConsolidationDetailSchema.parse({
      run: consolidationRun,
      findings: [],
      operations: [],
      maintenanceEnabled: true,
      mutationsEnabled: false
    }).findings).toEqual([]);
    expect(memoryAiAuditResponseSchema.parse({
      suggestions: [{
        issueId: "memory_issue:conflict",
        operationKind: "REPORT_ISSUE",
        confidence: 0.8,
        rationale: "Conflicting records require operator review."
      }]
    }).suggestions).toHaveLength(1);
    expect(memoryAiAuditResponseSchema.safeParse({
      suggestions: [{
        issueId: "memory_issue:conflict",
        operationKind: "ARCHIVE_SUPERSEDED",
        confidence: 2,
        rationale: "unsafe",
        extra: true
      }]
    }).success).toBe(false);
    expect(memoryAiAuditResultSchema.parse({
      status: "VERIFIED",
      verified: true,
      modelId: "gpt-5.5",
      suggestionCount: 1,
      downgradedCount: 0,
      evidence: { providerSmoke: "PASSED" }
    }).verified).toBe(true);
    expect(() => memoryConsolidationRunSchema.parse({
      ...consolidationRun,
      status: "SUCCEEDED",
      completedAt: null
    })).toThrow();
    expect(createMemoryConsolidationFindingInputSchema.parse({
      runId: consolidationRun.id,
      issueId: "memory_issue:duplicate",
      findingType: "EXACT_DUPLICATE",
      severity: "WARN",
      confidence: 1,
      recordIds: ["memory:canonical-record"],
      sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      evidence: "Exact content hashes match."
    }).confidence).toBe(1);
    expect(createMemoryConsolidationOperationInputSchema.parse({
      runId: consolidationRun.id,
      findingId: "memory_finding:duplicate",
      operationKind: "ARCHIVE_EXACT_DUPLICATE",
      recordIds: ["memory:canonical-record"],
      reason: "Archive the exact duplicate while retaining rollback data."
    }).operationKind).toBe("ARCHIVE_EXACT_DUPLICATE");
    expect(claimMemoryCommandInputSchema.parse({
      commandScope: "memory.consolidation.create",
      actorKey: "user:operator",
      idempotencyKeyHash: "a".repeat(64),
      requestHash: "b".repeat(64),
      resourceType: "memory_consolidation",
      resourceId: consolidationRun.id,
      workflowId: consolidationRun.workflowId
    }).idempotencyKeyHash).toHaveLength(64);
    expect(memoryCommandIdempotencyKeySchema.parse("  memory-command:retry-1  ")).toBe("memory-command:retry-1");
    expect(memoryCommandIdempotencyKeySchema.safeParse("short").success).toBe(false);
    expect(memoryCommandIdempotencyKeySchema.safeParse(`memory-command:${"x".repeat(190)}`).success).toBe(false);
    expect(memoryCommandIdempotencyKeySchema.safeParse("memory-command:bad\nvalue").success).toBe(false);
    expect(createMemoryRollbackInputSchema.parse({
      reason: "Restore the reviewed canonical state."
    })).toEqual({ reason: "Restore the reviewed canonical state." });
    expect(createMemoryRollbackInputSchema.safeParse({
      reason: "Restore the reviewed canonical state.",
      actorUserId: "user:forged",
      beforeSnapshot: "forged"
    }).success).toBe(false);
    expect(createMemoryRollbackInputSchema.safeParse({ reason: "" }).success).toBe(false);
    expect(createMemoryRollbackInputSchema.safeParse({ reason: "x".repeat(2001) }).success).toBe(false);
    expect(memoryChangeSetCommandInputSchema.parse({})).toEqual({});
    expect(memoryChangeSetCommandInputSchema.safeParse({ status: "APPROVED" }).success).toBe(false);

    expect(listMemoryGraphQuerySchema.parse({
      q: "  agent  ",
      scope: "ROOM",
      relationMode: "RELATIONS",
      page: "2",
      pageSize: "50"
    })).toMatchObject({
      q: "agent",
      scope: "ROOM",
      relationMode: "RELATIONS",
      page: 2,
      pageSize: 50
    });
    expect(listMemoryGraphQuerySchema.parse({})).toMatchObject({ relationMode: "RELATIONS" });
    expect(() => listMemoryGraphQuerySchema.parse({ pageSize: "501" })).toThrow();
    expect(listMemoryIssuesQuerySchema.parse({ severity: "WARN", status: "OPEN" })).toMatchObject({
      severity: "WARN",
      status: "OPEN"
    });
  });

  it("validates the memory graph month selector as a literal month or all-months", () => {
    for (const month of ["2026-02", "2026-07", "2026-12"]) {
      expect(memoryGraphMonthSchema.safeParse(month).success).toBe(true);
    }
    expect(memoryGraphMonthSchema.safeParse("all").success).toBe(true);
    for (const invalid of ["", "2026", "2026-13", "2026-7", "2026-00", "all-months", " 2026-07"]) {
      expect(memoryGraphMonthSchema.safeParse(invalid).success).toBe(false);
    }

    const withMonth = listMemoryGraphQuerySchema.parse({ month: "2026-06" });
    expect(withMonth).toMatchObject({ month: "2026-06", relationMode: "RELATIONS" });
    expect(() => listMemoryGraphQuerySchema.parse({ month: "2026-7" })).toThrow();

    const payload = memoryGraphPayloadSchema.parse({
      version: 2,
      generatedAt: "2026-07-13T08:00:00.000Z",
      sourceHash: "a".repeat(64),
      isStale: false,
      summary: { sourceCount: 0, recordCount: 0, nodeCount: 0, edgeCount: 0, issueCount: 0 },
      nodes: [],
      edges: [],
      layoutVersion: 2,
      taxonomyVersion: 2,
      revisionHash: "b".repeat(64),
      months: ["2026-06", "2026-07"],
      filters: { q: null, nodeType: null, scope: null, roomId: null, sourcePath: null, lifecycleStatus: null, month: "2026-06" }
    });
    expect(payload.months).toEqual(["2026-06", "2026-07"]);
    expect(payload.filters.month).toBe("2026-06");
    expect(memoryGraphPayloadSchema.parse({
      ...payload,
      filters: { ...payload.filters, month: null }
    }).filters.month).toBeNull();
    expect(() => memoryGraphPayloadSchema.parse({
      ...payload,
      filters: { ...payload.filters, month: "2026-7" }
    })).toThrow();
  });
});
