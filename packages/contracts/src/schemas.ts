import { z } from "zod";

export const isoDateTimeSchema = z.string().datetime({ offset: true });
export const idSchema = z.string().min(8).max(128).regex(/^[a-zA-Z0-9._:-]+$/);
export const requestIdSchema = z.string().min(8).max(128);
export const codexThreadIdSchema = z.string().trim().uuid();

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
    requestId: requestIdSchema
  })
});

export const telegramConnectionStatusSchema = z.enum([
  "DISCONNECTED",
  "PAIRING",
  "CONNECTED",
  "DISABLED",
  "ERROR"
]);

export const telegramIntegrationStatusSchema = z
  .object({
    connectionStatus: telegramConnectionStatusSchema,
    isEnabled: z.boolean(),
    botUsername: z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/).nullable(),
    chatDisplayName: z.string().min(1).max(160).nullable(),
    pairingId: idSchema.nullable(),
    pairingExpiresAt: isoDateTimeSchema.nullable(),
    pairedAt: isoDateTimeSchema.nullable(),
    enabledAt: isoDateTimeSchema.nullable(),
    disabledAt: isoDateTimeSchema.nullable(),
    lastTestedAt: isoDateTimeSchema.nullable(),
    lastDeliveredAt: isoDateTimeSchema.nullable(),
    errorCode: z.string().min(1).max(80).regex(/^[A-Z0-9_]+$/).nullable(),
    errorAt: isoDateTimeSchema.nullable(),
    updatedAt: isoDateTimeSchema
  })
  .strict();

export const createTelegramPairingInputSchema = z
  .object({
    botToken: z
      .string()
      .trim()
      .min(20)
      .max(256)
      .regex(/^\d{6,16}:[A-Za-z0-9_-]{20,240}$/)
  })
  .strict();

export const telegramPairingResponseSchema = z
  .object({
    integration: telegramIntegrationStatusSchema,
    pairing: z
      .object({
        id: idSchema,
        pairingUrl: z
          .string()
          .url()
          .regex(/^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=[A-Za-z0-9_-]{1,64}$/),
        expiresAt: isoDateTimeSchema,
        statusCode: z.enum(["PAIRING_PENDING", "PAIRING_CONFIRMED"])
      })
      .strict()
  })
  .strict();

export const updateTelegramIntegrationInputSchema = z
  .object({
    isEnabled: z.boolean()
  })
  .strict();

export const paginationRequestSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.string().min(1).max(64).optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc")
});

export const paginationSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  totalItems: z.number().int().min(0),
  totalPages: z.number().int().min(0)
});

export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    pagination: paginationSchema
  });

export const integrationStatusSchema = z.enum(["VERIFIED", "DISABLED", "ERROR"]);
export const paneModeSchema = z.enum(["CHAT", "CODE", "BROWSER", "REVIEW", "SWARM", "DESIGN", "TERMINAL"]);
export const paneStatusSchema = z.enum(["IDLE", "QUEUED", "RUNNING", "BLOCKED", "ERROR", "COMPLETE", "CLOSED"]);
export const paneColumnSpanSchema = z.number().int().min(1).max(3);
export const paneSplitSchema = z.object({
  parentId: idSchema.nullable(),
  direction: z.enum(["horizontal", "vertical"]).nullable(),
  size: z.number().min(5).max(95).nullable()
});
export const reasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export const cliModelIdentifierSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const cliReasoningEffortSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const agentModelConfigIdSchema = z.string().trim().min(1).max(260);
export const workflowStatusSchema = z.enum(["PENDING", "RUNNING", "PAUSED", "CANCELLED", "FAILED", "COMPLETED"]);
export const turnStatusSchema = z.enum(["QUEUED", "RUNNING", "BLOCKED", "FAILED", "COMPLETED", "CANCELLED"]);
export const artifactKindSchema = z.enum([
  "IMAGE",
  "SCREENSHOT",
  "DOM_SNAPSHOT",
  "CONSOLE_LOG",
  "NETWORK_LOG",
  "TRACE",
  "VIDEO",
  "PATCH",
  "TRANSCRIPT",
  "EXPORT",
  "MCP_RESULT"
]);
export const eventTypeSchema = z.enum([
  "ROOM_CREATED",
  "PANE_CREATED",
  "PANE_UPDATED",
  "PANE_CLOSED",
  "TURN_STARTED",
  "TURN_DELTA",
  "TURN_COMPLETED",
  "TURN_FAILED",
  "APPROVAL_REQUESTED",
  "BROWSER_HANDOFF_REQUESTED",
  "ARTIFACT_CREATED",
  "CAPABILITY_STATUS_CHANGED",
  "MEMORY_SAVED",
  "SKILL_PROPOSED",
  "IMPORT_CANDIDATE_CREATED",
  "IMPORT_CANDIDATE_DECIDED",
  "SWARM_TASK_CREATED",
  "SWARM_TASK_UPDATED",
  "SWARM_LOCK_CLAIMED",
  "SWARM_LOCK_RELEASED",
  "SWARM_MESSAGE_POSTED",
  "SWARM_RECONCILED",
  "REVIEW_CHECK_RECORDED",
  "REVIEW_DIFF_RECORDED",
  "REVIEW_DECISION_CREATED",
  "ROOM_AGENT_UPDATED"
]);

export const roomKindSchema = z.enum(["WORKSPACE", "AGENT_PROOF"]);

export const roomSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable(),
  kind: roomKindSchema.default("WORKSPACE"),
  order: z.number().int().min(0).default(0),
  paneLayoutColumns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  archivedAt: isoDateTimeSchema.nullable(),
  paneCap: z.number().int().min(1).max(16),
  traceId: requestIdSchema
});

export const createRoomInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  initialPaneCount: z.number().int().min(0).max(16).default(4)
});

export const proofRoomPaneCountSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(4)
]);

export const createProofRoomInputSchema = z
  .object({
    paneCount: proofRoomPaneCountSchema.default(1),
    roomLabel: z.string().trim().min(1).max(80).optional()
  })
  .strict();

export const roomCliActivitySchema = z
  .object({
    roomId: idSchema,
    runningCliCount: z.number().int().min(0)
  })
  .strict();

export const roomCliActivityResponseSchema = z
  .object({
    data: z.array(roomCliActivitySchema),
    sampledAt: isoDateTimeSchema
  })
  .strict();

export const updateRoomInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional()
});

export const updatePaneLayoutInputSchema = z
  .object({
    paneLayoutColumns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable()
  })
  .strict();

export const reorderRoomsInputSchema = z.object({
  roomIds: z
    .array(idSchema)
    .min(1)
    .max(500)
    .refine((roomIds) => new Set(roomIds).size === roomIds.length, "Room ids must be unique.")
});

export const paneSchema = z.object({
  id: idSchema,
  roomId: idSchema,
  title: z.string().min(1).max(120),
  mode: paneModeSchema,
  status: paneStatusSchema,
  providerId: z.string().max(120).nullable(),
  modelId: z.string().max(160).nullable(),
  terminalRuntimeId: z.string().max(160).nullable().optional(),
  reasoningEffort: reasoningEffortSchema.default("medium"),
  cwd: z.string().max(500).nullable(),
  order: z.number().int().min(0),
  columnSpan: paneColumnSpanSchema,
  isMaximized: z.boolean(),
  isMinimized: z.boolean(),
  isClosed: z.boolean(),
  split: paneSplitSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const proofRoomSchema = z
  .object({
    room: roomSchema,
    panes: z.array(paneSchema).max(4),
    sessionIds: z.array(idSchema).max(4)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.room.kind !== "AGENT_PROOF") {
      context.addIssue({ code: "custom", path: ["room", "kind"], message: "Proof rooms must use AGENT_PROOF kind." });
    }
    if (![0, 1, 2, 4].includes(value.panes.length)) {
      context.addIssue({ code: "custom", path: ["panes"], message: "Proof rooms support 0, 1, 2, or 4 panes." });
    }
    const paneIds = new Set<string>();
    for (const pane of value.panes) {
      if (pane.roomId !== value.room.id || pane.mode !== "TERMINAL" || pane.terminalRuntimeId !== "cli:codex") {
        context.addIssue({ code: "custom", path: ["panes"], message: "Proof room panes must be independent Codex terminals in the proof room." });
        break;
      }
      if (paneIds.has(pane.id)) {
        context.addIssue({ code: "custom", path: ["panes"], message: "Proof room pane ids must be unique." });
        break;
      }
      paneIds.add(pane.id);
    }
  });

export const createPaneInputSchema = z
  .object({
    roomId: idSchema,
    title: z.string().trim().min(1).max(120),
    mode: paneModeSchema.default("CHAT"),
    providerId: z.string().trim().max(120).nullable().optional(),
    modelId: z.string().trim().max(160).nullable().optional(),
    terminalRuntimeId: z.string().trim().min(1).max(160).nullable().optional(),
    cwd: z.string().trim().max(500).nullable().optional(),
    split: paneSplitSchema.optional()
  })
  .superRefine((input, context) => {
    if (input.terminalRuntimeId && input.mode !== "TERMINAL") {
      context.addIssue({
        code: "custom",
        path: ["terminalRuntimeId"],
        message: "Terminal runtime selection requires TERMINAL mode."
      });
    }
  });

export const roomPaneBatchItemSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("TERMINAL"),
      terminalRuntimeId: z.string().trim().min(1).max(160)
    })
    .strict(),
  z
    .object({
      mode: z.literal("CHAT")
    })
    .strict()
]);

export const createRoomPanesRequestSchema = z
  .object({
    panes: z.array(roomPaneBatchItemSchema).min(1).max(16)
  })
  .strict();

export const createRoomPanesInputSchema = z
  .object({
    roomId: idSchema,
    panes: z.array(roomPaneBatchItemSchema).min(1).max(16)
  })
  .strict();

export const roomPanesResultSchema = z.object({
  roomId: idSchema,
  data: z.array(paneSchema).min(1).max(16)
});

const persistedTranscriptTokenPattern = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const persistedTranscriptLabeledSecretPattern =
  /\b(api[_-]?key|secret|token|password)\s*[:=]\s*([^\s,;]+)/gi;

export function redactPersistedTranscriptContent(value: string): string {
  return value
    .replace(persistedTranscriptTokenPattern, "[REDACTED]")
    .replace(persistedTranscriptLabeledSecretPattern, (match, label: string, secretValue: string) =>
      secretValue === "[REDACTED]" ? match : `${label}:[REDACTED]`
    );
}

const persistedTranscriptContentSchema = z
  .string()
  .max(32 * 1024)
  .refine(
    (value) => redactPersistedTranscriptContent(value) === value,
    "Transcript chunks must be redacted before persistence."
  );

const booleanQueryValueSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .default(false)
  .transform((value) => value === true || value === "true");

export const listPanesQuerySchema = z.object({
  roomId: idSchema,
  includeClosed: booleanQueryValueSchema
});

export const updatePaneInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    mode: paneModeSchema.optional(),
    status: paneStatusSchema.optional(),
    providerId: z.string().trim().max(120).nullable().optional(),
    modelId: z.string().trim().max(160).nullable().optional(),
    terminalRuntimeId: z.string().trim().min(1).max(160).nullable().optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    cwd: z.string().trim().max(500).nullable().optional(),
    columnSpan: paneColumnSpanSchema.optional(),
    isMaximized: z.boolean().optional(),
    isMinimized: z.boolean().optional(),
    isClosed: z.boolean().optional(),
    split: paneSplitSchema.optional()
  })
  .refine((input) => !(input.isMaximized === true && input.isMinimized === true), {
    message: "A pane cannot be maximized and minimized at the same time."
  });

export const movePaneInputSchema = z.object({
  targetRoomId: idSchema
});

export const movePaneResultSchema = z.object({
  sourcePane: paneSchema,
  targetPane: paneSchema,
  sourceRoomId: idSchema,
  targetRoomId: idSchema
});

export const roomPaneLayoutResultSchema = z.object({
  room: roomSchema,
  panes: z.array(paneSchema)
});

export const agentPaneSourceSchema = z.enum(["SPACE", "CODER"]);
export const agentPaneBindingStatusSchema = z.enum(["UNBOUND", "READY", "SYNCING", "RUNNING", "BLOCKED", "ERROR"]);
export const agentPaneRunStatusSchema = z.enum(["IDLE", "QUEUED", "RUNNING", "INTERRUPTING", "BLOCKED", "ERROR"]);
export const spaceAgentRunRecordStatusSchema = z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "INTERRUPTED"]);
export const agentPaneMessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export const agentPaneMessageStatusSchema = z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "INTERRUPTED"]);
export const permissionModeSchema = z.enum(["ask_for_approval", "approve_for_me", "full_access"]);
export const collaborationModeSchema = z.enum(["default", "plan"]);
export const agentPaneSandboxSchema = z.enum(["workspace-write", "danger-full-access"]);
export const agentPaneApprovalPolicySchema = z.enum(["on-request", "never"]);
export const agentPaneReviewerSchema = z.enum(["user", "guardian_subagent"]);
export const agentPaneToolCategorySchema = z.enum(["memory", "skills", "mcp", "browser", "room"]);
export const agentPaneGoalStatusSchema = z.enum(["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"]);

export const agentPanePermissionStateSchema = z.object({
  mode: permissionModeSchema.nullable().default(null),
  effectiveMode: permissionModeSchema,
  isInherited: z.boolean().default(true),
  sandbox: agentPaneSandboxSchema,
  approvalPolicy: agentPaneApprovalPolicySchema,
  reviewer: agentPaneReviewerSchema,
  statusReason: z.string().min(1).max(500)
});

export const agentPanePermissionOptionSchema = z.object({
  mode: permissionModeSchema,
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  sandbox: agentPaneSandboxSchema,
  approvalPolicy: agentPaneApprovalPolicySchema,
  reviewer: agentPaneReviewerSchema,
  isAvailable: z.boolean().default(true),
  statusReason: z.string().min(1).max(500).nullable().default(null)
});

export const agentPaneGoalSchema = z.object({
  threadId: z.string().min(1).max(200),
  goalId: z.string().min(1).max(128),
  objective: z.string().min(1).max(4000),
  status: agentPaneGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().int().min(0),
  timeUsedSeconds: z.number().int().min(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const agentPaneGoalInputSchema = z.object({
  objective: z.string().trim().min(1).max(4000)
});

export const agentPaneBindingSchema = z.object({
  paneId: idSchema,
  source: agentPaneSourceSchema,
  sessionId: idSchema.nullable().default(null),
  coderChatId: z.string().min(1).max(200).nullable(),
  status: agentPaneBindingStatusSchema,
  title: z.string().min(1).max(120),
  selectedModelConfigId: agentModelConfigIdSchema.nullable(),
  selectedProviderName: z.string().min(1).max(160).nullable().default(null),
  selectedModelName: z.string().min(1).max(160).nullable().default(null),
  selectedReasoningKey: z.string().min(1).max(80).nullable().default(null),
  selectedToolIds: z.array(z.string().min(1).max(160)).max(50).nullable().default(null),
  lastSyncedAt: isoDateTimeSchema.nullable()
});

export const upsertAgentPaneBindingInputSchema = agentPaneBindingSchema;

export const updateAgentPaneBindingInputSchema = z
  .object({
    sessionId: idSchema.nullable().optional(),
    coderChatId: z.string().trim().min(1).max(200).nullable().optional(),
    status: agentPaneBindingStatusSchema.optional(),
    title: z.string().trim().min(1).max(120).optional(),
    selectedModelConfigId: agentModelConfigIdSchema.nullable().optional(),
    selectedProviderName: z.string().trim().min(1).max(160).nullable().optional(),
    selectedModelName: z.string().trim().min(1).max(160).nullable().optional(),
    selectedReasoningKey: z.string().trim().min(1).max(80).nullable().optional(),
    selectedToolIds: z.array(z.string().trim().min(1).max(160)).max(50).nullable().optional(),
    lastSyncedAt: isoDateTimeSchema.nullable().optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Agent pane binding update must include at least one field.");

export const agentPaneMessageSchema = z.object({
  id: z.string().min(1).max(200),
  role: agentPaneMessageRoleSchema,
  content: z.string().max(50000),
  status: agentPaneMessageStatusSchema,
  createdAt: isoDateTimeSchema.nullable()
});

export const roomAgentStatusSchema = z.enum(["IDLE", "QUEUED", "RUNNING", "PAUSED", "RECOVERING", "BLOCKED"]);
export const roomAgentMissionStatusSchema = z.enum(["QUEUED", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "INTERRUPTED"]);
export const roomAgentRequestKindSchema = z.enum(["MISSION", "FOLLOW_UP"]);

export const roomAgentMissionSchema = z.object({
  id: idSchema,
  status: roomAgentMissionStatusSchema,
  currentPaneId: idSchema.nullable().default(null),
  queuedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable().default(null),
  completedAt: isoDateTimeSchema.nullable().default(null),
  pausedAt: isoDateTimeSchema.nullable().default(null),
  totalPausedMs: z.number().int().min(0).default(0),
  lastProgressAt: isoDateTimeSchema.nullable().default(null),
  executionState: z.record(z.string(), z.unknown()).default({}),
  statusReason: z.string().min(1).max(1000)
});

export const roomAgentBindingSchema = z.object({
  roomId: idSchema,
  paneId: idSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const roomAgentRequestRecordSchema = z.object({
  requestId: idSchema,
  roomId: idSchema,
  sessionId: idSchema,
  missionId: idSchema.nullable().default(null),
  requestKind: roomAgentRequestKindSchema.default("MISSION"),
  clientRequestId: requestIdSchema,
  promptMessageId: idSchema,
  responseMessageId: idSchema,
  createdAt: isoDateTimeSchema
});

export const createRoomAgentRequestInputSchema = roomAgentRequestRecordSchema.omit({ createdAt: true });

export const roomAgentMissionRecordSchema = roomAgentMissionSchema.extend({
  requestId: idSchema,
  roomId: idSchema,
  sessionId: idSchema,
  workflowId: z.string().min(1).max(240),
  updatedAt: isoDateTimeSchema
});

export const createRoomAgentMissionInputSchema = roomAgentMissionRecordSchema.omit({
  queuedAt: true,
  startedAt: true,
  completedAt: true,
  updatedAt: true
});

export const updateRoomAgentMissionInputSchema = z
  .object({
    status: roomAgentMissionStatusSchema.optional(),
    currentPaneId: idSchema.nullable().optional(),
    statusReason: z.string().trim().min(1).max(1000).optional(),
    startedAt: isoDateTimeSchema.nullable().optional(),
    completedAt: isoDateTimeSchema.nullable().optional(),
    pausedAt: isoDateTimeSchema.nullable().optional(),
    totalPausedMs: z.number().int().min(0).optional(),
    lastProgressAt: isoDateTimeSchema.nullable().optional(),
    executionState: z.record(z.string(), z.unknown()).optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Room agent mission update must include at least one field.");

export const roomAgentActionTypeSchema = z.enum([
  "INSPECT",
  "ORCHESTRATE",
  "SEND",
  "INTERRUPT",
  "RESTART",
  "CREATE_PANE",
  "CLOSE_PANE",
  "REOPEN_PANE"
]);
export const roomAgentActionStatusSchema = z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "BLOCKED"]);
export const roomAgentActionRecordSchema = z.object({
  actionId: idSchema,
  missionId: idSchema,
  roomId: idSchema,
  paneId: idSchema.nullable(),
  idempotencyKey: z.string().min(8).max(240),
  actionType: roomAgentActionTypeSchema,
  status: roomAgentActionStatusSchema,
  requestPayload: z.record(z.string(), z.unknown()),
  evidence: z.record(z.string(), z.unknown()),
  attemptCount: z.number().int().min(0).max(3),
  statusReason: z.string().min(1).max(1000),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable()
});

export const createRoomAgentActionInputSchema = roomAgentActionRecordSchema.omit({
  createdAt: true,
  updatedAt: true,
  completedAt: true
});

export const updateRoomAgentActionInputSchema = z
  .object({
    paneId: idSchema.nullable().optional(),
    status: roomAgentActionStatusSchema.optional(),
    evidence: z.record(z.string(), z.unknown()).optional(),
    attemptCount: z.number().int().min(0).max(3).optional(),
    statusReason: z.string().trim().min(1).max(1000).optional(),
    completedAt: isoDateTimeSchema.nullable().optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Room agent action update must include at least one field.");

export const roomAgentPlanStatusSchema = z.enum(["READY", "PAUSED_BY_ROOM_AGENT", "RUNNING", "COMPLETED"]);
export const roomAgentRoomPlanSchema = z.object({
  paneId: idSchema,
  paneTitle: z.string().min(1).max(500),
  sessionId: idSchema,
  threadId: z.string().min(1).max(200),
  status: roomAgentPlanStatusSchema,
  title: z.string().min(1).max(500),
  updatedAt: isoDateTimeSchema.nullable()
});
export const roomAgentRoomInventorySchema = z.object({
  totalPanes: z.number().int().min(0).max(64),
  plannedPanes: z.number().int().min(0).max(64),
  pendingPlans: z.number().int().min(0).max(64),
  readyPlans: z.number().int().min(0).max(64),
  pausedPlans: z.number().int().min(0).max(64),
  runningPlans: z.number().int().min(0).max(64),
  checkedAt: isoDateTimeSchema,
  plans: z.array(roomAgentRoomPlanSchema).max(64)
});

export const roomAgentTaskResultSchema = z.object({
  stepId: z.string().min(1).max(120),
  paneId: idSchema,
  label: z.string().min(1).max(160),
  state: z.enum(["RUNNING", "VERIFYING", "COMPLETED", "LOW_QUALITY", "BLOCKED"]),
  modelId: z.string().min(1).max(160).nullable(),
  reasoningEffort: reasoningEffortSchema.nullable(),
  qualityScore: z.number().min(0).max(100).nullable(),
  qualityUnavailableReason: z.string().min(1).max(500).nullable(),
  reliabilityScore: z.number().min(0).max(100),
  combinedScore: z.number().min(0).max(100).nullable(),
  rubric: z.object({
    correctness: z.number().min(0).max(100),
    completeness: z.number().min(0).max(100),
    instructionAdherence: z.number().min(0).max(100),
    evidence: z.number().min(0).max(100),
    clarity: z.number().min(0).max(100)
  }).nullable(),
  queueMs: z.number().int().min(0),
  firstResponseMs: z.number().int().min(0).nullable(),
  executionMs: z.number().int().min(0),
  totalMs: z.number().int().min(0),
  retries: z.number().int().min(0),
  recoveries: z.number().int().min(0),
  stalls: z.number().int().min(0),
  completedAt: isoDateTimeSchema.nullable(),
  verificationSummary: z.string().min(1).max(1000)
});

export const roomAgentTaskRunStatusSchema = z.enum(["QUEUED", "RUNNING", "VERIFYING", "COMPLETED", "LOW_QUALITY", "BLOCKED"]);
export const roomAgentTaskRunRecordSchema = roomAgentTaskResultSchema.extend({
  runId: idSchema,
  missionId: idSchema,
  roomId: idSchema,
  instruction: z.string().min(1).max(2000),
  status: roomAgentTaskRunStatusSchema,
  queuedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  firstResponseAt: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema
});
export const upsertRoomAgentTaskRunInputSchema = roomAgentTaskRunRecordSchema.omit({ updatedAt: true });

export const roomAgentMissionSummarySchema = z.object({
  totalTasks: z.number().int().min(0),
  completedTasks: z.number().int().min(0),
  blockedTasks: z.number().int().min(0),
  successRate: z.number().min(0).max(100),
  averageQuality: z.number().min(0).max(100).nullable(),
  minQuality: z.number().min(0).max(100).nullable(),
  maxQuality: z.number().min(0).max(100).nullable(),
  totalMs: z.number().int().min(0),
  averageFirstResponseMs: z.number().int().min(0).nullable(),
  peakConcurrency: z.number().int().min(0),
  retries: z.number().int().min(0),
  stalls: z.number().int().min(0)
});

export const roomAgentSessionSchema = z.object({
  roomId: idSchema,
  paneId: idSchema.nullable(),
  sessionId: idSchema.nullable(),
  threadId: z.string().min(1).max(200).nullable(),
  status: roomAgentStatusSchema,
  statusReason: z.string().min(1).max(1000),
  modelId: z.literal("gpt-5.6-sol"),
  reasoningEffort: z.literal("high"),
  messages: z.array(agentPaneMessageSchema).max(500),
  activeMission: roomAgentMissionSchema.nullable(),
  queuedMissionCount: z.number().int().min(0),
  currentPaneId: idSchema.nullable(),
  activePaneIds: z.array(idSchema).max(64).default([]),
  progress: z.object({
    totalSteps: z.number().int().min(0).default(0),
    completedSteps: z.number().int().min(0).default(0),
    runningSteps: z.number().int().min(0).default(0),
    queuedSteps: z.number().int().min(0).default(0),
    blockedSteps: z.number().int().min(0).default(0),
    peakConcurrency: z.number().int().min(0).default(0),
    elapsedMs: z.number().int().min(0).default(0)
  }).default({
    totalSteps: 0,
    completedSteps: 0,
    runningSteps: 0,
    queuedSteps: 0,
    blockedSteps: 0,
    peakConcurrency: 0,
    elapsedMs: 0
  }),
  roomInventory: roomAgentRoomInventorySchema.optional(),
  taskResults: z.array(roomAgentTaskResultSchema).max(64).optional(),
  missionSummary: roomAgentMissionSummarySchema.nullable().optional(),
  capabilities: z.object({
    canSend: z.boolean(),
    canPause: z.boolean().default(false),
    canResume: z.boolean().default(false),
    canStop: z.boolean(),
    canClear: z.boolean().default(true)
  })
});

export const roomAgentMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  clientRequestId: requestIdSchema
});

export const roomAgentStopInputSchema = z.object({
  reason: z.string().trim().min(1).max(500).default("Stopped by operator.")
});

const roomAgentControlReasonSchema = z.string().trim().min(1).max(500).optional();
export const roomAgentControlInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("PAUSE"), reason: roomAgentControlReasonSchema }),
  z.object({ action: z.literal("RESUME") }),
  z.object({ action: z.literal("STOP"), reason: roomAgentControlReasonSchema })
]);

export const roomAgentVerificationEnvelopeSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("VERIFIED"),
    summary: z.string().trim().min(1).max(1000)
  })
  .strict();

export const roomAgentOrchestrationStepSchema = z.object({
  stepId: z.string().trim().min(1).max(120).optional(),
  paneId: idSchema.optional(),
  paneKey: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(160).optional(),
  instruction: z.string().trim().min(1).max(2000),
  dependsOn: z.array(z.string().trim().min(1).max(120)).max(63).default([])
}).superRefine((step, context) => {
  if (Boolean(step.paneId) === Boolean(step.paneKey)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["paneId"],
      message: "Each room orchestration step must target exactly one paneId or paneKey."
    });
  }
});

export const roomAgentPreparedPaneSchema = z.object({
  paneKey: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  mode: z.enum(["TERMINAL", "CHAT"]),
  terminalRuntimeId: z.string().trim().min(1).max(160).nullable().optional(),
  modelId: z.string().trim().min(1).max(160),
  reasoningEffort: reasoningEffortSchema
});

function validateRoomAgentOrchestrationGraph(
  steps: Array<z.infer<typeof roomAgentOrchestrationStepSchema>>,
  context: z.RefinementCtx
): void {
  const ids = steps.map((step, index) => step.stepId ?? `step-${index + 1}`);
  const known = new Set(ids);
  if (known.size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "Room orchestration step IDs must be unique." });
    return;
  }
  const dependencies = new Map(ids.map((id, index) => [id, steps[index]!.dependsOn]));
  for (let index = 0; index < steps.length; index += 1) {
    for (const dependency of steps[index]!.dependsOn) {
      if (!known.has(dependency)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "dependsOn"],
          message: `Unknown room orchestration dependency: ${dependency}.`
        });
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (known.has(dependency) && hasCycle(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (ids.some(hasCycle)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "Room orchestration dependency graph contains a cycle." });
  }
}

export const spaceRoomToolIdSchema = z.enum([
  "room:inspect",
  "room:orchestrate",
  "room:send",
  "room:interrupt",
  "room:restart",
  "room:create_pane",
  "room:close_pane",
  "room:reopen_pane"
]);

const roomAgentInspectActionRequestSchema = z.object({
  toolId: z.literal("room:inspect"),
  action: z.object({ type: z.literal("inspect") })
});

const roomAgentOrchestrateActionRequestSchema = z.object({
  toolId: z.literal("room:orchestrate"),
  action: z.object({
    type: z.literal("orchestrate"),
    strategy: z.literal("AUTO_PARALLEL").default("AUTO_PARALLEL"),
    analysisSummary: z.string().trim().min(1).max(2000).optional(),
    preparePanes: z.array(roomAgentPreparedPaneSchema).max(15).default([]),
    steps: z.array(roomAgentOrchestrationStepSchema).min(1).max(64)
  }).superRefine((action, context) => {
    validateRoomAgentOrchestrationGraph(action.steps, context);
    const keys = action.preparePanes.map((pane) => pane.paneKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["preparePanes"], message: "Prepared pane keys must be unique." });
    }
    const known = new Set(keys);
    for (const [index, step] of action.steps.entries()) {
      if (step.paneKey && !known.has(step.paneKey)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "paneKey"], message: `Unknown prepared pane key: ${step.paneKey}.` });
      }
    }
  })
});

const roomAgentSendActionRequestSchema = z.object({
  toolId: z.literal("room:send"),
  action: z.object({
    type: z.literal("send"),
    paneId: idSchema,
    input: z.string().trim().min(1).max(4000)
  })
});

const roomAgentInterruptActionRequestSchema = z.object({
  toolId: z.literal("room:interrupt"),
  action: z.object({
    type: z.literal("interrupt"),
    paneId: idSchema,
    reason: z.string().trim().min(1).max(500)
  })
});

const roomAgentRestartActionRequestSchema = z.object({
  toolId: z.literal("room:restart"),
  action: z.object({ type: z.literal("restart"), paneId: idSchema })
});

const roomAgentCreatePaneActionRequestSchema = z.object({
  toolId: z.literal("room:create_pane"),
  action: z.object({
    type: z.literal("create_pane"),
    title: z.string().trim().min(1).max(120),
    mode: paneModeSchema,
    terminalRuntimeId: z.string().trim().min(1).max(160).nullable().optional()
  })
});

const roomAgentClosePaneActionRequestSchema = z.object({
  toolId: z.literal("room:close_pane"),
  action: z.object({ type: z.literal("close_pane"), paneId: idSchema })
});

const roomAgentReopenPaneActionRequestSchema = z.object({
  toolId: z.literal("room:reopen_pane"),
  action: z.object({ type: z.literal("reopen_pane"), paneId: idSchema })
});

export const spaceAgentRoomActionRequestSchema = z.discriminatedUnion("toolId", [
  roomAgentInspectActionRequestSchema,
  roomAgentOrchestrateActionRequestSchema,
  roomAgentSendActionRequestSchema,
  roomAgentInterruptActionRequestSchema,
  roomAgentRestartActionRequestSchema,
  roomAgentCreatePaneActionRequestSchema,
  roomAgentClosePaneActionRequestSchema,
  roomAgentReopenPaneActionRequestSchema
]);

export const spaceAgentRoomActionEnvelopeSchema = z.object({
  version: z.literal(1),
  actions: z.array(spaceAgentRoomActionRequestSchema).min(1).max(3)
});

export const spaceAgentRoomActionBridgeRequestSchema = z.object({
  roomId: idSchema,
  missionId: idSchema,
  agentPaneId: idSchema,
  agentSessionId: idSchema,
  selectedToolIds: z.array(z.string().trim().min(1).max(160)).max(50),
  actions: z.array(spaceAgentRoomActionRequestSchema).min(1).max(3)
});

export const spaceAgentRoomActionBridgeResultSchema = z.object({
  request: spaceAgentRoomActionRequestSchema,
  status: z.enum(["BLOCKED", "EXECUTED", "FAILED"]),
  statusReason: z.string().min(1).max(1000),
  paneId: idSchema.nullable().default(null),
  missionId: idSchema.nullable().default(null),
  evidence: z.record(z.string(), z.unknown()).default({})
});

export const spaceAgentRoomActionBridgeResponseSchema = z.object({
  id: z.literal("space-agent-room-action-bridge"),
  results: z.array(spaceAgentRoomActionBridgeResultSchema).min(1).max(3)
});

export const agentPaneModelOptionSchema = z.object({
  id: agentModelConfigIdSchema,
  displayName: z.string().min(1).max(160),
  providerId: z.string().min(1).max(120).nullable().default(null),
  providerName: z.string().min(1).max(160).nullable(),
  model: z.string().min(1).max(160).nullable(),
  reasoningKey: z.string().min(1).max(80).nullable().default(null),
  reasoningLabel: z.string().min(1).max(160).nullable().default(null),
  isDefault: z.boolean().default(false)
});

export const codexModelCatalogOptionSchema = z.object({
  id: cliModelIdentifierSchema,
  displayName: z.string().min(1).max(160),
  description: z.string().trim().max(500).optional(),
  isDefault: z.boolean().default(false),
  defaultReasoningEffort: cliReasoningEffortSchema,
  supportedReasoningEfforts: z.array(cliReasoningEffortSchema).min(1).max(20),
  reasoningOptions: z.array(z.object({
    reasoningEffort: cliReasoningEffortSchema,
    description: z.string().trim().max(500).optional()
  })).min(1).max(20).optional()
});

export const agentPaneToolOptionSchema = z.object({
  id: z.string().min(1).max(160),
  displayName: z.string().min(1).max(160),
  description: z.string().max(500).default(""),
  category: agentPaneToolCategorySchema.default("mcp"),
  slug: z.string().min(1).max(160).nullable(),
  availability: z.enum(["force_on", "default_on", "default_off"]).nullable(),
  authType: z.string().min(1).max(80).nullable(),
  authConnected: z.boolean(),
  enabled: z.boolean(),
  isAvailable: z.boolean().default(true),
  statusReason: z.string().min(1).max(500).nullable().default(null),
  isForceOn: z.boolean()
});

export const agentPaneCapabilitiesSchema = z.object({
  canSend: z.boolean(),
  canInterrupt: z.boolean(),
  canSelectModel: z.boolean(),
  canSelectTools: z.boolean().default(false),
  supportsTools: z.boolean()
});

export const agentPaneHistoryItemSchema = z.object({
  paneId: idSchema.nullable(),
  roomId: idSchema.nullable(),
  source: agentPaneSourceSchema,
  sessionId: idSchema.nullable().default(null),
  coderChatId: z.string().min(1).max(200).nullable().default(null),
  status: agentPaneBindingStatusSchema,
  title: z.string().min(1).max(160),
  selectedModelConfigId: agentModelConfigIdSchema.nullable(),
  selectedProviderName: z.string().min(1).max(160).nullable(),
  selectedModelName: z.string().min(1).max(160).nullable(),
  selectedReasoningKey: z.string().min(1).max(80).nullable(),
  selectedToolIds: z.array(z.string().min(1).max(160)).max(50).nullable().default(null),
  lastSyncedAt: isoDateTimeSchema.nullable(),
  paneTitle: z.string().min(1).max(120).nullable(),
  paneIsClosed: z.boolean(),
  updatedAt: isoDateTimeSchema.nullable()
});

export const agentPaneStoredSessionSchema = z.object({
  paneId: idSchema,
  roomId: idSchema,
  source: agentPaneSourceSchema,
  sessionId: idSchema.nullable().default(null),
  coderChatId: z.string().min(1).max(200),
  status: agentPaneBindingStatusSchema,
  title: z.string().min(1).max(160),
  selectedModelConfigId: agentModelConfigIdSchema.nullable(),
  selectedProviderName: z.string().min(1).max(160).nullable(),
  selectedModelName: z.string().min(1).max(160).nullable(),
  selectedReasoningKey: z.string().min(1).max(80).nullable(),
  selectedToolIds: z.array(z.string().min(1).max(160)).max(50).nullable().default(null),
  lastSyncedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const upsertAgentPaneStoredSessionInputSchema = agentPaneStoredSessionSchema
  .omit({
    createdAt: true,
    updatedAt: true
  })
  .extend({
    lastSyncedAt: isoDateTimeSchema.nullable().optional()
  });

export const agentPaneSessionSchema = z.object({
  binding: agentPaneBindingSchema,
  threadId: z.string().min(1).max(200).nullable().default(null),
  messages: z.array(agentPaneMessageSchema).max(500),
  runStatus: agentPaneRunStatusSchema,
  statusReason: z.string().min(1).max(1000),
  modelOptions: z.array(agentPaneModelOptionSchema).max(4000),
  modelCatalog: z.array(codexModelCatalogOptionSchema).max(200).default([]),
  selectedModelConfigId: agentModelConfigIdSchema.nullable(),
  toolOptions: z.array(agentPaneToolOptionSchema).max(100).default([]),
  selectedToolIds: z.array(z.string().min(1).max(160)).max(50).default([]),
  permissionMode: permissionModeSchema.nullable().default(null),
  collaborationMode: collaborationModeSchema.default("default"),
  permissionState: agentPanePermissionStateSchema.default({
    mode: null,
    effectiveMode: "full_access",
    isInherited: true,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    reviewer: "user",
    statusReason: "Inherited runtime default."
  }),
  permissionOptions: z.array(agentPanePermissionOptionSchema).max(3).default([]),
  goal: agentPaneGoalSchema.nullable().default(null),
  history: z.array(agentPaneHistoryItemSchema).max(100).default([]),
  capabilities: agentPaneCapabilitiesSchema
});

export const createAgentPaneSessionInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    sessionId: idSchema.nullable().optional(),
    threadId: z.string().trim().min(1).max(200).nullable().optional(),
    coderChatId: z.string().trim().min(1).max(200).nullable().optional(),
    selectedModelConfigId: agentModelConfigIdSchema.nullable().optional(),
    selectedToolIds: z.array(z.string().trim().min(1).max(160)).max(50).nullable().optional()
  })
  .default({});

export const turnArtifactMaxCount = 8;

export const agentPaneSendMessageInputSchema = z
  .object({
    content: z.string().trim().max(4000).default(""),
    selectedModelConfigId: agentModelConfigIdSchema.optional(),
    selectedToolIds: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
    artifactIds: z.array(idSchema).max(turnArtifactMaxCount).optional()
  })
  .refine((input) => input.content.length > 0 || Boolean(input.artifactIds?.length), {
    message: "Agent pane messages require text or at least one artifact.",
    path: ["content"]
  });

export const agentPaneInterruptInputSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional()
});

export const agentPaneSettingsInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    selectedModelConfigId: agentModelConfigIdSchema.nullable().optional(),
    selectedToolIds: z.array(z.string().trim().min(1).max(160)).max(50).nullable().optional(),
    permissionMode: permissionModeSchema.nullable().optional(),
    collaborationMode: collaborationModeSchema.optional(),
    fullAccessConfirmed: z.boolean().default(false)
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.selectedModelConfigId !== undefined ||
      input.selectedToolIds !== undefined ||
      input.permissionMode !== undefined ||
      input.collaborationMode !== undefined,
    "Agent pane settings update must include at least one field."
  );

export const agentRuntimeCapabilitySchema = z.enum(["WEB_CHAT", "CLI"]);
export const agentRuntimeStatusSchema = z.enum(["ENABLED", "NOT_CONNECTED", "DISABLED", "ERROR"]);
export const agentRuntimeAdapterStatusSchema = z.enum(["ENABLED", "DISABLED", "ERROR"]);
export const agentRuntimeAuthModeSchema = z.enum(["NONE", "BROWSER_OAUTH", "DEVICE_CODE", "MANAGED", "API_KEY"]);
export const agentRuntimeAuthStateSchema = z.enum(["READY", "LOGIN_REQUIRED", "SETUP_REQUIRED", "UNAVAILABLE"]);
export const paneCliSessionStatusSchema = z.enum(["IDLE", "RUNNING", "INTERRUPTING", "EXITED", "ERROR"]);
export const paneCliSessionLaunchModeSchema = z.enum(["FRESH", "RESUME"]);
export const paneCliSessionPurposeSchema = z.enum(["NORMAL", "LOGIN"]);
export const paneCliTranscriptStreamSchema = z.enum(["stdin", "stdout", "stderr", "system"]);
export const paneCliCodexThreadOwnershipSourceSchema = z.enum(["AUTO", "HISTORY_TRANSFER", "MIGRATION"]);
export const browserSessionViewportSchema = z.enum(["mobile", "tablet", "desktop"]);
export const browserSessionStatusSchema = z.enum(["STARTING", "READY", "NAVIGATING", "ERROR", "CLOSED"]);
export const browserStreamModeSchema = z.enum(["AUTO", "SILENT", "PREVIEW", "INTERACTIVE", "REALTIME"]);
export const browserResolvedStreamModeSchema = z.enum(["SILENT", "PREVIEW", "INTERACTIVE", "REALTIME"]);
export const browserRuntimeStateSchema = z.enum(["STARTING", "READY", "DEGRADED", "STOPPED", "ERROR"]);
export const browserCapacityStateSchema = z.enum(["AVAILABLE", "QUEUED", "LIMITED"]);
export const browserControlStateSchema = z.enum(["UNCONTROLLED", "AGENT", "OPERATOR"]);

export const browserRuntimeInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("KEY"),
    leaseId: idSchema,
    eventType: z.enum(["keyDown", "keyUp", "rawKeyDown", "char"]),
    key: z.string().min(1).max(120),
    code: z.string().max(120).optional(),
    text: z.string().max(4000).optional(),
    modifiers: z.number().int().min(0).max(15).optional()
  }),
  z.object({
    type: z.literal("POINTER"),
    leaseId: idSchema,
    eventType: z.enum(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]),
    x: z.number().min(0).max(10000),
    y: z.number().min(0).max(10000),
    button: z.enum(["none", "left", "middle", "right", "back", "forward"]).optional(),
    clickCount: z.number().int().min(0).max(4).optional(),
    deltaX: z.number().min(-10000).max(10000).optional(),
    deltaY: z.number().min(-10000).max(10000).optional(),
    modifiers: z.number().int().min(0).max(15).optional()
  }),
  z.object({
    type: z.literal("TOUCH"),
    leaseId: idSchema,
    eventType: z.enum(["touchStart", "touchMove", "touchEnd", "touchCancel"]),
    touchPoints: z
      .array(
        z.object({
          x: z.number().min(0).max(10000),
          y: z.number().min(0).max(10000),
          id: z.number().int().min(0).max(100).optional(),
          radiusX: z.number().min(0).max(1000).optional(),
          radiusY: z.number().min(0).max(1000).optional(),
          force: z.number().min(0).max(1).optional()
        })
      )
      .max(16),
    modifiers: z.number().int().min(0).max(15).optional()
  }),
  z.object({
    type: z.literal("DIALOG"),
    leaseId: idSchema,
    accept: z.boolean(),
    promptText: z.string().max(4000).optional()
  }),
  z.object({
    type: z.literal("NAVIGATION"),
    leaseId: idSchema,
    action: z.enum(["BACK", "FORWARD", "RELOAD"])
  })
]);

export const browserPageSummarySchema = z.object({
  pageId: z.string().min(1).max(200),
  kind: z.enum(["PAGE", "POPUP"]).default("PAGE"),
  url: z.string().url().nullable(),
  title: z.string().max(500).nullable(),
  isActive: z.boolean(),
  openerPageId: z.string().min(1).max(200).nullable().default(null),
  canGoBack: z.boolean().default(false),
  canGoForward: z.boolean().default(false)
});

export const agentRuntimeSchema = z.object({
  id: z.string().min(1).max(160),
  providerId: z.string().min(1).max(120),
  providerName: z.string().min(1).max(160),
  agentId: z.string().min(1).max(120),
  agentName: z.string().min(1).max(160),
  displayName: z.string().min(1).max(160),
  capabilities: z.array(agentRuntimeCapabilitySchema).min(1).max(4),
  adapterStatus: agentRuntimeAdapterStatusSchema,
  authMode: agentRuntimeAuthModeSchema,
  authState: agentRuntimeAuthStateSchema,
  authReason: z.string().min(1).max(500),
  canStartLogin: z.boolean(),
  status: agentRuntimeStatusSchema,
  statusReason: z.string().min(1).max(500),
  commandName: z.string().min(1).max(120).nullable(),
  detectedCommandPath: z.string().min(1).max(500).nullable().default(null),
  defaultModelId: z.string().min(1).max(160).nullable().default(null),
  supportedReasoningEfforts: z.array(reasoningEffortSchema).max(10).default([]),
  checkedAt: isoDateTimeSchema
});

export const agentRuntimeRegistrySchema = z.object({
  data: z.array(agentRuntimeSchema).max(50),
  checkedAt: isoDateTimeSchema
});

export const cliToggleRuntimeIds = [
  "cli:codex",
  "cli:claude",
  "cli:gemini",
  "cli:opencode",
  "cli:qwen",
  "cli:kimi",
  "cli:grok",
  "cli:deepseek"
] as const;

export const cliToggleRuntimeIdSchema = z.enum(cliToggleRuntimeIds);

export const cliTaskHistoryQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    includeArchived: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .default(false)
      .transform((value) => value === true || value === "true"),
    q: z.string().max(300).optional(),
    runtimeId: cliToggleRuntimeIdSchema.optional()
  })
  .strict()
  .transform((input) => ({
    page: input.page ?? 1,
    pageSize: input.pageSize ?? 50,
    includeArchived: input.includeArchived,
    q: input.q?.trim() || undefined,
    runtimeId: input.runtimeId
  }));

export const cliRuntimeSettingSchema = z.object({
  runtimeId: cliToggleRuntimeIdSchema,
  enabled: z.boolean(),
  updatedAt: isoDateTimeSchema,
  updatedBy: idSchema.nullable()
});

export const cliRuntimeSettingsResponseSchema = z.object({
  settings: z.array(cliRuntimeSettingSchema).length(cliToggleRuntimeIds.length),
  runtimes: z.array(agentRuntimeSchema).max(cliToggleRuntimeIds.length),
  checkedAt: isoDateTimeSchema
});

const cliRuntimeDisableConfirmationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{24,96}$/);

export const cliRuntimeDisablePreviewSchema = z.object({
  runtimeId: cliToggleRuntimeIdSchema,
  activeSessionCount: z.number().int().min(0).max(10_000),
  openPaneCount: z.number().int().min(0).max(10_000),
  confirmationToken: cliRuntimeDisableConfirmationTokenSchema,
  expiresAt: isoDateTimeSchema
});

export const updateCliRuntimeSettingInputSchema = z
  .object({
    enabled: z.boolean(),
    confirmationToken: cliRuntimeDisableConfirmationTokenSchema.optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.enabled && !input.confirmationToken) {
      context.addIssue({
        code: "custom",
        path: ["confirmationToken"],
        message: "Disabling a CLI runtime requires a confirmation token."
      });
    }
    if (input.enabled && input.confirmationToken) {
      context.addIssue({
        code: "custom",
        path: ["confirmationToken"],
        message: "Enabling a CLI runtime does not accept a confirmation token."
      });
    }
  });

export const cliRuntimeCleanupResultSchema = z.object({
  requestedActiveSessionCount: z.number().int().min(0),
  requestedOpenPaneCount: z.number().int().min(0),
  terminatedSessionIds: z.array(idSchema).max(10_000),
  closedPaneIds: z.array(idSchema).max(10_000),
  unresolvedSessionIds: z.array(idSchema).max(10_000),
  unresolvedPaneIds: z.array(idSchema).max(10_000)
});

export const updateCliRuntimeSettingResultSchema = z.object({
  setting: cliRuntimeSettingSchema,
  cleanup: cliRuntimeCleanupResultSchema.nullable()
});

export function isAgentRuntimeReady(
  runtime: Pick<AgentRuntime, "adapterStatus" | "authState" | "status">
): boolean {
  return runtime.adapterStatus === "ENABLED" && runtime.authState === "READY" && runtime.status === "ENABLED";
}

export function canStartAgentRuntimeLogin(
  runtime: Pick<AgentRuntime, "adapterStatus" | "authState" | "canStartLogin">
): boolean {
  return runtime.adapterStatus === "ENABLED" &&
    (runtime.authState === "LOGIN_REQUIRED" || runtime.authState === "SETUP_REQUIRED") &&
    runtime.canStartLogin;
}

export const paneCliSessionSchema = z.object({
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  runtimeId: z.string().min(1).max(160),
  providerId: z.string().min(1).max(120),
  agentId: z.string().min(1).max(120),
  modelId: z.string().min(1).max(160).nullable(),
  reasoningEffort: cliReasoningEffortSchema,
  launchMode: paneCliSessionLaunchModeSchema.default("FRESH"),
  purpose: paneCliSessionPurposeSchema.default("NORMAL"),
  cwd: z.string().min(1).max(500).nullable(),
  codexThreadId: codexThreadIdSchema.nullable().default(null),
  cliTaskId: idSchema.nullable().default(null),
  cliTaskRevisionId: idSchema.nullable().default(null),
  status: paneCliSessionStatusSchema,
  statusReason: z.string().min(1).max(500).nullable(),
  exitCode: z.number().int().nullable(),
  isActive: z.boolean(),
  startedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.nullable()
});

export const createPaneCliSessionInputSchema = paneCliSessionSchema
  .omit({
    sessionId: true,
    status: true,
    statusReason: true,
    exitCode: true,
    isActive: true,
    startedAt: true,
    updatedAt: true,
    endedAt: true
  })
  .extend({
    sessionId: idSchema.optional(),
    modelId: cliModelIdentifierSchema.nullable().optional(),
    reasoningEffort: cliReasoningEffortSchema.default("medium"),
    launchMode: paneCliSessionLaunchModeSchema.default("FRESH"),
    purpose: paneCliSessionPurposeSchema.default("NORMAL"),
    cwd: z.string().trim().min(1).max(500).nullable().optional(),
    codexThreadId: codexThreadIdSchema.nullable().default(null),
    status: paneCliSessionStatusSchema.optional(),
    statusReason: z.string().trim().min(1).max(500).nullable().optional(),
    isActive: z.boolean().optional()
  });

export const updatePaneCliSessionInputSchema = z
  .object({
    status: paneCliSessionStatusSchema.optional(),
    statusReason: z.string().trim().min(1).max(500).nullable().optional(),
    exitCode: z.number().int().nullable().optional(),
    isActive: z.boolean().optional(),
    endedAt: isoDateTimeSchema.nullable().optional(),
    codexThreadId: codexThreadIdSchema.nullable().optional(),
    modelId: cliModelIdentifierSchema.nullable().optional(),
    reasoningEffort: cliReasoningEffortSchema.optional(),
    launchMode: paneCliSessionLaunchModeSchema.optional(),
    cliTaskId: idSchema.nullable().optional(),
    cliTaskRevisionId: idSchema.nullable().optional()
  })
  .refine((input) => Object.keys(input).length > 0, "CLI session update must include at least one field.");

export const paneCliTranscriptChunkSchema = z.object({
  chunkId: idSchema,
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  sequence: z.number().int().min(0),
  stream: paneCliTranscriptStreamSchema,
  content: persistedTranscriptContentSchema,
  byteLength: z.number().int().min(0).max(65536),
  hostGenerationId: z.string().uuid().nullable().default(null),
  hostOutputSequence: z.number().int().min(0).nullable().default(null),
  createdAt: isoDateTimeSchema
});

export const createPaneCliTranscriptChunkInputSchema = paneCliTranscriptChunkSchema
  .omit({
    chunkId: true,
    byteLength: true,
    hostGenerationId: true,
    hostOutputSequence: true,
    createdAt: true
  })
  .extend({
    chunkId: idSchema.optional(),
    byteLength: z.number().int().min(0).max(65536).optional(),
    hostGenerationId: z.string().uuid().nullable().optional().default(null),
    hostOutputSequence: z.number().int().min(0).nullable().optional().default(null)
  })
  .refine(
    (value) => (value.hostGenerationId === null) === (value.hostOutputSequence === null),
    "CLI transcript host generation and output sequence must be set together."
  );

export const createPaneCliHostOutputInputSchema = z.object({
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  generationId: z.string().uuid(),
  outputSequence: z.number().int().min(0),
  stream: z.enum(["stdout", "stderr"]),
  content: persistedTranscriptContentSchema,
  byteLength: z.number().int().min(0).max(65536).optional()
});

export const paneCliCodexThreadOwnershipSchema = z.object({
  threadId: codexThreadIdSchema,
  roomId: idSchema,
  paneId: idSchema,
  cliSessionId: idSchema,
  source: paneCliCodexThreadOwnershipSourceSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const createPaneCliSessionRequestSchema = z.object({
  runtimeId: z.string().trim().min(1).max(160),
  modelId: cliModelIdentifierSchema.nullable().optional(),
  reasoningEffort: cliReasoningEffortSchema.optional(),
  cwd: z.string().trim().min(1).max(500).nullable().optional(),
  forceRestart: z.boolean().default(false),
  resume: z.boolean().default(false),
  includeTranscript: z.boolean().default(true)
});

export const cliLoginRequestSchema = z.object({
  runtimeId: z.string().trim().min(1).max(160)
}).strict();

export const resumePaneCliSessionRequestSchema = z.union([
  z.object({ taskId: idSchema, threadId: z.never().optional() }).strict(),
  z.object({ threadId: codexThreadIdSchema, taskId: z.never().optional() }).strict()
]);

export const paneCliInterruptInputSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional()
});

export const paneCliWebSocketTokenSchema = z.object({
  paneId: idSchema,
  sessionId: idSchema,
  token: z.string().min(24).max(512),
  expiresAt: isoDateTimeSchema
});

export const paneCliTurnActivityStatusSchema = z.enum(["PENDING", "RUNNING", "COMPLETED", "ABORTED", "UNAVAILABLE"]);

export const paneCliTurnActivityResponseSchema = z.object({
  marker: z.string().uuid(),
  status: paneCliTurnActivityStatusSchema,
  turnId: z.string().min(1).max(200).nullable()
});

export const paneCliWebSocketClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input"),
    data: z.string().min(1).max(16000),
    display: z.enum(["visible", "hidden"]).default("visible"),
    turnMarker: z.string().uuid().optional()
  }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(2).max(400),
    rows: z.number().int().min(2).max(200)
  }),
  z.object({
    type: z.literal("interrupt")
  })
]);

export const paneCliWebSocketServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    paneId: idSchema,
    sessionId: idSchema,
    runtimeId: z.string().min(1).max(160)
  }),
  z.object({
    type: z.literal("output"),
    stream: z.enum(["stdout", "stderr"]),
    data: z.string().max(16000)
  }),
  z.object({
    type: z.literal("status"),
    status: paneCliSessionStatusSchema,
    statusReason: z.string().min(1).max(500).nullable().optional(),
    exitCode: z.number().int().nullable().optional(),
    replayContinuity: z.enum(["COMPLETE", "TRUNCATED"]).optional()
  }),
  z.object({
    type: z.literal("session_replaced"),
    sessionId: idSchema
  }),
  z.object({
    type: z.literal("error"),
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500)
  })
]);

export const paneCliSessionResponseSchema = z.object({
  session: paneCliSessionSchema,
  runtime: agentRuntimeSchema,
  transcript: z.array(paneCliTranscriptChunkSchema).max(200),
  websocket: paneCliWebSocketTokenSchema.nullable()
});

export const cliLoginResponseSchema = z.object({
  pane: paneSchema,
  session: paneCliSessionResponseSchema,
  reused: z.boolean()
});

export const paneCliModelOptionSchema = codexModelCatalogOptionSchema;

export const paneCliModelSettingsSchema = z.object({
  sessionId: idSchema,
  threadId: codexThreadIdSchema.nullable(),
  current: z.object({
    modelId: cliModelIdentifierSchema,
    reasoningEffort: cliReasoningEffortSchema
  }).nullable(),
  models: z.array(paneCliModelOptionSchema).min(1).max(200),
  controlMode: z.literal("DIRECT"),
  isTurnActive: z.boolean()
});

export const paneCliModelSettingsStatusSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("AVAILABLE"),
    settings: paneCliModelSettingsSchema
  }),
  z.object({
    status: z.literal("UNAVAILABLE"),
    reasonCode: z.enum(["CODEX_SESSION_CONTROL_UNAVAILABLE", "CODEX_MODEL_CATALOG_UNAVAILABLE"]),
    reason: z.string().min(1).max(500)
  })
]);

export const updatePaneCliModelSettingsInputSchema = z.object({
  expectedSessionId: idSchema,
  modelId: cliModelIdentifierSchema,
  reasoningEffort: cliReasoningEffortSchema,
  continueActiveTurn: z.boolean().default(true)
});

export const updatePaneCliModelSettingsResultSchema = z.object({
  settings: paneCliModelSettingsSchema,
  session: paneCliSessionResponseSchema,
  appliedScope: z.enum(["MODEL_AND_REASONING", "REASONING_ONLY"]),
  wasActive: z.boolean(),
  interrupted: z.boolean(),
  continuation: z.enum(["NOT_NEEDED", "SENT"]),
  transport: z.literal("DIRECT"),
  warning: z.string().min(1).max(500).nullable()
});

export const codexCliModeDefaultPairSchema = z.object({
  modelId: cliModelIdentifierSchema,
  reasoningEffort: cliReasoningEffortSchema
});

export const codexCliModeDefaultPairsSchema = z.object({
  build: codexCliModeDefaultPairSchema,
  plan: codexCliModeDefaultPairSchema
});

export const codexCliModeDefaultsSchema = codexCliModeDefaultPairsSchema.extend({
  updatedAt: isoDateTimeSchema
});

export const updateCodexCliModeDefaultsInputSchema = z.object({
  mode: z.enum(["build", "plan"]),
  modelId: cliModelIdentifierSchema,
  reasoningEffort: cliReasoningEffortSchema
}).strict();

export const codexCliModeDefaultsCatalogSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("AVAILABLE"),
    models: z.array(codexModelCatalogOptionSchema).min(1).max(200),
    error: z.null()
  }),
  z.object({
    status: z.literal("UNAVAILABLE"),
    models: z.array(codexModelCatalogOptionSchema).max(0),
    error: z.string().min(1).max(500)
  })
]);

export const codexCliModeDefaultsResponseSchema = z.object({
  defaults: codexCliModeDefaultsSchema,
  catalog: codexCliModeDefaultsCatalogSchema
});

export const codexCliModeDefaultsProjectionSchema = z.object({
  schemaVersion: z.literal("CodexCliModeDefaultsProjectionV1"),
  revision: isoDateTimeSchema,
  defaults: codexCliModeDefaultsSchema
});

export const paneCliUploadMaxCount = 8;
export const paneCliUploadMaxBytes = 10 * 1024 * 1024;

export const paneCliUploadSourceSchema = z.enum(["USER_UPLOAD", "CLIPBOARD", "DROP", "SCREEN_CAPTURE"]);

export const paneCliUploadedFileSchema = z.object({
  artifactId: idSchema.nullable(),
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  originalFilename: z.string().min(1).max(180),
  storedFilename: z.string().min(1).max(220),
  mimeType: z.string().min(1).max(120),
  byteSize: z.number().int().min(1).max(paneCliUploadMaxBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  storageUri: z.string().min(1).max(1000),
  terminalPath: z.string().min(1).max(1000),
  shellQuotedPath: z.string().min(1).max(1200),
  isImage: z.boolean()
});

export const paneCliUploadResponseSchema = z.object({
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  files: z.array(paneCliUploadedFileSchema).min(1).max(paneCliUploadMaxCount)
});

export const paneBrowserSessionSchema = z.object({
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  ownerAgentId: z.string().min(1).max(120).nullable(),
  agentNumber: z.number().int().min(1).max(99),
  profileId: z.string().min(1).max(160),
  profilePath: z.string().min(1).max(1000),
  viewport: browserSessionViewportSchema,
  targetUrl: z.string().url().nullable(),
  currentUrl: z.string().url().nullable(),
  title: z.string().max(500).nullable(),
  status: browserSessionStatusSchema,
  statusReason: z.string().min(1).max(500).nullable(),
  lastFrameAt: isoDateTimeSchema.nullable(),
  streamMode: browserStreamModeSchema.default("AUTO"),
  resolvedStreamMode: browserResolvedStreamModeSchema.default("PREVIEW"),
  runtimeState: browserRuntimeStateSchema.default("STARTING"),
  capacityState: browserCapacityStateSchema.default("AVAILABLE"),
  controlState: browserControlStateSchema.default("UNCONTROLLED"),
  pages: z.array(browserPageSummarySchema).max(100).default([]),
  activePageId: z.string().min(1).max(200).nullable().default(null),
  workerHeartbeatAt: isoDateTimeSchema.nullable().default(null),
  queuePosition: z.number().int().min(1).max(10000).nullable().default(null),
  isActive: z.boolean(),
  startedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.nullable()
});

export const createPaneBrowserSessionInputSchema = paneBrowserSessionSchema
  .omit({
    sessionId: true,
    currentUrl: true,
    title: true,
    status: true,
    statusReason: true,
    lastFrameAt: true,
    isActive: true,
    startedAt: true,
    updatedAt: true,
    endedAt: true
  })
  .extend({
    sessionId: idSchema.optional(),
    ownerAgentId: z.string().trim().min(1).max(120).nullable().optional(),
    targetUrl: z.string().trim().url().nullable().optional(),
    currentUrl: z.string().trim().url().nullable().optional(),
    title: z.string().trim().max(500).nullable().optional(),
    status: browserSessionStatusSchema.optional(),
    statusReason: z.string().trim().min(1).max(500).nullable().optional(),
    streamMode: browserStreamModeSchema.optional(),
    resolvedStreamMode: browserResolvedStreamModeSchema.optional(),
    runtimeState: browserRuntimeStateSchema.optional(),
    capacityState: browserCapacityStateSchema.optional(),
    controlState: browserControlStateSchema.optional(),
    pages: z.array(browserPageSummarySchema).max(100).optional(),
    activePageId: z.string().trim().min(1).max(200).nullable().optional(),
    workerHeartbeatAt: isoDateTimeSchema.nullable().optional(),
    queuePosition: z.number().int().min(1).max(10000).nullable().optional(),
    isActive: z.boolean().optional()
  });

export const updatePaneBrowserSessionInputSchema = z
  .object({
    viewport: browserSessionViewportSchema.optional(),
    targetUrl: z.string().trim().url().nullable().optional(),
    currentUrl: z.string().trim().url().nullable().optional(),
    title: z.string().trim().max(500).nullable().optional(),
    status: browserSessionStatusSchema.optional(),
    statusReason: z.string().trim().min(1).max(500).nullable().optional(),
    lastFrameAt: isoDateTimeSchema.nullable().optional(),
    streamMode: browserStreamModeSchema.optional(),
    resolvedStreamMode: browserResolvedStreamModeSchema.optional(),
    runtimeState: browserRuntimeStateSchema.optional(),
    capacityState: browserCapacityStateSchema.optional(),
    controlState: browserControlStateSchema.optional(),
    pages: z.array(browserPageSummarySchema).max(100).optional(),
    activePageId: z.string().trim().min(1).max(200).nullable().optional(),
    workerHeartbeatAt: isoDateTimeSchema.nullable().optional(),
    queuePosition: z.number().int().min(1).max(10000).nullable().optional(),
    isActive: z.boolean().optional(),
    endedAt: isoDateTimeSchema.nullable().optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Browser session update must include at least one field.");

export const createPaneBrowserSessionRequestSchema = z.object({
  viewport: browserSessionViewportSchema.default("desktop"),
  targetUrl: z.string().trim().url().optional(),
  ownerAgentId: z.string().trim().min(1).max(120).nullable().optional(),
  streamMode: browserStreamModeSchema.default("AUTO")
});

export const updatePaneBrowserSessionRequestSchema = z
  .object({
    viewport: browserSessionViewportSchema.optional(),
    targetUrl: z.string().trim().url().optional(),
    streamMode: browserStreamModeSchema.optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Browser session update must include at least one field.");

export const updateBrowserStreamModeInputSchema = z.object({
  streamMode: browserStreamModeSchema
});

export const browserPageListResponseSchema = z.object({
  sessionId: idSchema,
  activePageId: z.string().min(1).max(200).nullable(),
  pages: z.array(browserPageSummarySchema).max(100)
});

export const createBrowserPageInputSchema = z.object({
  url: z.string().trim().url().optional(),
  activate: z.boolean().default(true)
});

export const activateBrowserPageInputSchema = z.object({
  pageId: z.string().trim().min(1).max(200)
});

export const browserControlHolderTypeSchema = z.enum(["AGENT", "OPERATOR"]);
export const browserControlLeaseStatusSchema = z.enum(["ACTIVE", "RELEASED", "EXPIRED", "REVOKED"]);

export const browserControlLeaseSchema = z.object({
  leaseId: idSchema,
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  holderType: browserControlHolderTypeSchema,
  holderId: z.string().min(1).max(160),
  status: browserControlLeaseStatusSchema,
  reason: z.string().min(1).max(500).nullable(),
  acquiredAt: isoDateTimeSchema,
  heartbeatAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  releasedAt: isoDateTimeSchema.nullable()
});

export const createBrowserControlLeaseInputSchema = browserControlLeaseSchema
  .omit({
    leaseId: true,
    status: true,
    acquiredAt: true,
    heartbeatAt: true,
    expiresAt: true,
    releasedAt: true
  })
  .extend({
    leaseId: idSchema.optional(),
    reason: z.string().trim().min(1).max(500).nullable().optional(),
    ttlSeconds: z.number().int().min(5).max(300).default(30)
  });

export const updateBrowserControlLeaseInputSchema = z
  .object({
    status: browserControlLeaseStatusSchema.optional(),
    reason: z.string().trim().min(1).max(500).nullable().optional(),
    ttlSeconds: z.number().int().min(5).max(300).optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Browser control lease update must include at least one field.");

export const acquireBrowserControlInputSchema = z.object({
  holderType: browserControlHolderTypeSchema,
  holderId: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).max(500).nullable().optional(),
  ttlSeconds: z.number().int().min(5).max(300).default(30)
});

export const browserControlLeaseActionInputSchema = z.object({
  leaseId: idSchema,
  ttlSeconds: z.number().int().min(5).max(300).optional()
});

export const browserControlLeaseResponseSchema = z.object({
  lease: browserControlLeaseSchema
});

export const browserCaptureJobStatusSchema = z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]);
export const browserScreenshotCaptureOptionsSchema = z.object({
  kind: z.literal("SCREENSHOT"),
  format: z.enum(["PNG", "JPEG", "WEBP"]).default("PNG"),
  target: z.enum(["VIEWPORT", "FULL_PAGE", "ELEMENT"]).default("VIEWPORT"),
  selector: z.string().trim().min(1).max(1000).nullable().default(null),
  quality: z.number().int().min(1).max(100).nullable().default(null)
});
export const browserRecordingCaptureOptionsSchema = z.object({
  kind: z.literal("RECORDING"),
  format: z.literal("WEBM").default("WEBM"),
  maxDurationMs: z.number().int().min(250).max(1_800_000).default(30_000),
  maxBytes: z.number().int().min(1).max(1_073_741_824).default(1_073_741_824),
  frameIntervalMs: z.number().int().min(40).max(4_000).default(100)
});
export const browserCaptureOptionsSchema = z.discriminatedUnion("kind", [
  browserScreenshotCaptureOptionsSchema,
  browserRecordingCaptureOptionsSchema
]);

export const browserCaptureJobSchema = z.object({
  jobId: idSchema,
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  requestedByType: browserControlHolderTypeSchema,
  requestedById: z.string().min(1).max(160),
  status: browserCaptureJobStatusSchema,
  options: browserCaptureOptionsSchema,
  progressPercent: z.number().int().min(0).max(100),
  statusReason: z.string().min(1).max(500).nullable(),
  artifactIds: z.array(idSchema).max(100).default([]),
  queuedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable()
});

export const createBrowserCaptureJobInputSchema = browserCaptureJobSchema
  .omit({
    jobId: true,
    status: true,
    progressPercent: true,
    statusReason: true,
    artifactIds: true,
    queuedAt: true,
    startedAt: true,
    updatedAt: true,
    completedAt: true
  })
  .extend({ jobId: idSchema.optional() });

export const createBrowserCaptureJobRequestSchema = z.object({
  options: browserCaptureOptionsSchema
});

export const updateBrowserCaptureJobInputSchema = z
  .object({
    status: browserCaptureJobStatusSchema.optional(),
    progressPercent: z.number().int().min(0).max(100).optional(),
    statusReason: z.string().trim().min(1).max(500).nullable().optional(),
    artifactIds: z.array(idSchema).max(100).optional(),
    startedAt: isoDateTimeSchema.nullable().optional(),
    completedAt: isoDateTimeSchema.nullable().optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Browser capture job update must include at least one field.");

export const browserCaptureJobResponseSchema = z.object({ job: browserCaptureJobSchema });

export const stopBrowserCaptureInputSchema = z.object({
  command: z.literal("STOP"),
  finalize: z.boolean().default(true)
});

export const cancelBrowserCaptureInputSchema = z.object({
  command: z.literal("CANCEL"),
  reason: z.string().trim().min(1).max(500).nullable().optional()
});

export const browserCaptureCommandInputSchema = z.discriminatedUnion("command", [
  stopBrowserCaptureInputSchema,
  cancelBrowserCaptureInputSchema
]);

export const browserCaptureSegmentStatusSchema = z.enum(["OPEN", "FINALIZED", "FAILED", "DISCARDED"]);

export const browserCaptureSegmentSchema = z.object({
  segmentId: idSchema,
  jobId: idSchema,
  sessionId: idSchema,
  sequence: z.number().int().min(0),
  status: browserCaptureSegmentStatusSchema,
  artifactId: idSchema.nullable(),
  storageUri: z.string().min(1).max(1000).nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  byteSize: z.number().int().min(0).max(1_073_741_824),
  durationMs: z.number().int().min(0).max(1_800_000),
  frameCount: z.number().int().min(0),
  lastFrameSequence: z.number().int().min(0).nullable(),
  statusReason: z.string().min(1).max(500).nullable(),
  startedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  finalizedAt: isoDateTimeSchema.nullable()
});

export const createBrowserCaptureSegmentInputSchema = browserCaptureSegmentSchema
  .omit({
    segmentId: true,
    sequence: true,
    status: true,
    artifactId: true,
    storageUri: true,
    sha256: true,
    byteSize: true,
    durationMs: true,
    frameCount: true,
    lastFrameSequence: true,
    statusReason: true,
    startedAt: true,
    updatedAt: true,
    finalizedAt: true
  })
  .extend({
    segmentId: idSchema.optional(),
    sequence: z.number().int().min(0).optional()
  });

export const updateBrowserCaptureSegmentInputSchema = z
  .object({
    status: browserCaptureSegmentStatusSchema.optional(),
    artifactId: idSchema.nullable().optional(),
    storageUri: z.string().trim().min(1).max(1000).nullable().optional(),
    sha256: z.string().trim().regex(/^[a-f0-9]{64}$/).nullable().optional(),
    byteSize: z.number().int().min(0).max(1_073_741_824).optional(),
    durationMs: z.number().int().min(0).max(1_800_000).optional(),
    frameCount: z.number().int().min(0).optional(),
    lastFrameSequence: z.number().int().min(0).nullable().optional(),
    statusReason: z.string().trim().min(1).max(500).nullable().optional(),
    finalizedAt: isoDateTimeSchema.nullable().optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Browser capture segment update must include at least one field.");

export const browserCaptureSegmentListResponseSchema = z.object({
  jobId: idSchema,
  segments: z.array(browserCaptureSegmentSchema).max(10000)
});

export const browserHandoffStatusSchema = z.enum(["REQUESTED", "ACCEPTED", "COMPLETED", "EXPIRED", "CANCELLED"]);
export const browserOperatorRoleSchema = z.enum(["OPERATOR", "ADMIN"]);

export const browserHandoffRequestSchema = z.object({
  handoffRequestId: idSchema,
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  requestedByType: browserControlHolderTypeSchema,
  requestedById: z.string().min(1).max(160),
  reason: z.string().min(1).max(500),
  status: browserHandoffStatusSchema,
  operatorUserId: idSchema.nullable(),
  operatorEmail: z.string().email().max(320).nullable(),
  operatorRole: browserOperatorRoleSchema.nullable(),
  controlLeaseId: idSchema.nullable(),
  requestedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  acceptedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  expiredAt: isoDateTimeSchema.nullable(),
  cancelledAt: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema
});

export const createBrowserHandoffRequestInputSchema = browserHandoffRequestSchema
  .omit({
    handoffRequestId: true,
    status: true,
    operatorUserId: true,
    operatorEmail: true,
    operatorRole: true,
    controlLeaseId: true,
    requestedAt: true,
    expiresAt: true,
    acceptedAt: true,
    completedAt: true,
    expiredAt: true,
    cancelledAt: true,
    updatedAt: true
  })
  .extend({
    handoffRequestId: idSchema.optional(),
    reason: z.string().trim().min(1).max(500),
    ttlSeconds: z.number().int().min(30).max(1800).default(300)
  });

export const updateBrowserHandoffRequestInputSchema = z
  .object({
    status: browserHandoffStatusSchema,
    operatorUserId: idSchema.optional(),
    operatorEmail: z.string().trim().email().max(320).optional(),
    operatorRole: browserOperatorRoleSchema.optional(),
    controlLeaseId: idSchema.nullable().optional(),
    reason: z.string().trim().min(1).max(500).optional()
  })
  .superRefine((input, context) => {
    const operatorFields = [input.operatorUserId, input.operatorEmail, input.operatorRole];
    const operatorFieldCount = operatorFields.filter((value) => value !== undefined).length;
    if (operatorFieldCount !== 0 && operatorFieldCount !== operatorFields.length) {
      context.addIssue({
        code: "custom",
        message: "Authenticated browser handoff operator identity must include user id, email, and role."
      });
    }
    if (input.status === "ACCEPTED" && operatorFieldCount !== operatorFields.length) {
      context.addIssue({
        code: "custom",
        message: "Accepting a browser handoff requires authenticated operator identity."
      });
    }
  });

export const browserHandoffRequestResponseSchema = z.object({
  handoff: browserHandoffRequestSchema
});

export const browserTimelineEventTypeSchema = z.enum([
  "NAVIGATION",
  "INPUT",
  "CONSOLE",
  "NETWORK",
  "FRAME",
  "MARKER",
  "ERROR"
]);
export const browserTimelineEventSummarySchema = z.object({
  eventId: idSchema,
  sessionId: idSchema,
  pageId: z.string().min(1).max(200).nullable(),
  sequence: z.number().int().min(0),
  type: browserTimelineEventTypeSchema,
  level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]),
  message: z.string().min(1).max(2000),
  frameIndex: z.number().int().min(0).nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  occurredAt: isoDateTimeSchema
});

export const browserDiagnosticsResponseSchema = z.object({
  sessionId: idSchema,
  events: z.array(browserTimelineEventSummarySchema).max(1000)
});

export const browserRecordingFrameSummarySchema = z.object({
  index: z.number().int().min(0),
  segmentSequence: z.number().int().min(0),
  segmentFrameIndex: z.number().int().min(0),
  capturedAt: isoDateTimeSchema,
  elapsedMs: z.number().int().min(0).max(1_800_000)
});

export const browserCaptureTimelineResponseSchema = z.object({
  jobId: idSchema,
  sessionId: idSchema,
  durationMs: z.number().int().min(0).max(1_800_000),
  frameCount: z.number().int().min(0),
  segmentCount: z.number().int().min(0).max(10_000),
  frames: z.array(browserRecordingFrameSummarySchema).max(100_000),
  events: z.array(browserTimelineEventSummarySchema).max(1000)
});

export const browserFrameSchema = z.object({
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  status: browserSessionStatusSchema,
  viewport: browserSessionViewportSchema,
  currentUrl: z.string().url().nullable(),
  title: z.string().max(500).nullable(),
  screenshotDataUrl: z.string().startsWith("data:image/png;base64,").max(10 * 1024 * 1024).nullable(),
  capturedAt: isoDateTimeSchema
});

export const browserFrameTokenSchema = z.object({
  paneId: idSchema,
  sessionId: idSchema,
  token: z.string().min(24).max(512),
  expiresAt: isoDateTimeSchema
});

export const browserStreamTicketResponseSchema = z
  .object({
    websocket: browserFrameTokenSchema
  })
  .strict();

export const browserStreamWebSocketClientMessageSchema = z
  .object({
    type: z.literal("input"),
    requestId: requestIdSchema,
    input: browserRuntimeInputSchema
  })
  .strict();

export const browserStreamInputAckSchema = z.discriminatedUnion("ok", [
  z
    .object({
      type: z.literal("inputAck"),
      requestId: requestIdSchema,
      ok: z.literal(true),
      serverDurationMs: z.number().int().min(0).max(300_000)
    })
    .strict(),
  z
    .object({
      type: z.literal("inputAck"),
      requestId: requestIdSchema,
      ok: z.literal(false),
      serverDurationMs: z.number().int().min(0).max(300_000),
      error: z
        .object({
          code: z.string().min(1).max(80).regex(/^[A-Z0-9_]+$/),
          message: z.string().min(1).max(500)
        })
        .strict()
    })
    .strict()
]);

export const browserStreamWebSocketServerMessageSchema = z.union([
  z
    .object({
      type: z.literal("ready"),
      paneId: idSchema,
      sessionId: idSchema,
      streamId: idSchema,
      encoding: z.literal("image/jpeg"),
      requestedMode: browserStreamModeSchema,
      resolvedMode: browserResolvedStreamModeSchema,
      framesPerSecond: z.number().int().min(0).max(60)
    })
    .strict(),
  browserStreamInputAckSchema,
  z
    .object({
      type: z.literal("error"),
      code: z.string().min(1).max(80).regex(/^[A-Z0-9_]+$/),
      message: z.string().min(1).max(500)
    })
    .strict()
]);

export const paneBrowserSessionResponseSchema = z.object({
  session: paneBrowserSessionSchema,
  frame: browserFrameSchema.nullable(),
  websocket: browserFrameTokenSchema.nullable()
});

export const browserBookmarkSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(300),
  url: z.string().url(),
  addedAt: isoDateTimeSchema.nullable()
});

export const browserBookmarkListResponseSchema = z.object({
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  bookmarks: z.array(browserBookmarkSchema).max(1000)
});

export const browserBookmarkImportResponseSchema = browserBookmarkListResponseSchema.extend({
  importedCount: z.number().int().min(0).max(500),
  skippedCount: z.number().int().min(0).max(10000)
});

export const createBrowserBookmarkInputSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  url: z.string().trim().url().optional()
});

export const openBrowserBookmarkInputSchema = z.object({
  bookmarkId: z.string().trim().min(1).max(120)
});

const browserActionBaseSchema = z.object({
  sessionId: idSchema.optional()
});

export const browserNavigateInputSchema = browserActionBaseSchema.extend({
  url: z.string().trim().url()
});

export const browserSetViewportInputSchema = browserActionBaseSchema.extend({
  viewport: browserSessionViewportSchema
});

export const browserToolActionInputSchema = z.discriminatedUnion("type", [
  browserActionBaseSchema.extend({
    type: z.literal("navigate"),
    url: z.string().trim().url()
  }),
  browserActionBaseSchema.extend({
    type: z.literal("screenshot")
  }),
  browserActionBaseSchema.extend({
    type: z.literal("extract_text")
  }),
  browserActionBaseSchema.extend({
    type: z.literal("click"),
    x: z.number().min(0).max(10000),
    y: z.number().min(0).max(10000)
  }),
  browserActionBaseSchema.extend({
    type: z.literal("type"),
    text: z.string().min(1).max(4000)
  }),
  browserActionBaseSchema.extend({
    type: z.literal("scroll"),
    deltaX: z.number().min(-10000).max(10000).default(0),
    deltaY: z.number().min(-10000).max(10000)
  }),
  browserActionBaseSchema.extend({
    type: z.literal("set_viewport"),
    viewport: browserSessionViewportSchema
  }),
  browserActionBaseSchema.extend({
    type: z.literal("diagnostics"),
    includeNetwork: z.boolean().default(true),
    limit: z.number().int().min(1).max(500).default(100)
  }),
  browserActionBaseSchema.extend({
    type: z.literal("record"),
    durationMs: z.number().int().min(250).max(1_800_000).default(3_000),
    intervalMs: z.number().int().min(40).max(4_000).default(500),
    format: z.enum(["frames", "gif", "webm", "both"]).default("both")
  })
]);

export const browserToolActionTypeSchema = z.enum([
  "navigate",
  "screenshot",
  "extract_text",
  "click",
  "type",
  "scroll",
  "set_viewport",
  "diagnostics",
  "record"
]);

export const browserToolActionResultSchema = z.object({
  session: paneBrowserSessionSchema,
  frame: browserFrameSchema.nullable(),
  text: z.string().max(20000).nullable().optional()
});

export const spaceBrowserToolIdSchema = z.enum([
  "browser:navigate",
  "browser:screenshot",
  "browser:extract_text",
  "browser:click",
  "browser:type",
  "browser:scroll",
  "browser:set_viewport",
  "browser:diagnostics",
  "browser:record"
]);

function expectedBrowserToolIdForAction(type: z.infer<typeof browserToolActionTypeSchema>): z.infer<typeof spaceBrowserToolIdSchema> {
  switch (type) {
    case "navigate":
      return "browser:navigate";
    case "screenshot":
      return "browser:screenshot";
    case "extract_text":
      return "browser:extract_text";
    case "click":
      return "browser:click";
    case "type":
      return "browser:type";
    case "scroll":
      return "browser:scroll";
    case "set_viewport":
      return "browser:set_viewport";
    case "diagnostics":
      return "browser:diagnostics";
    case "record":
      return "browser:record";
  }
}

export const spaceAgentBrowserActionRequestSchema = z
  .object({
    toolId: spaceBrowserToolIdSchema,
    targetPaneId: idSchema,
    action: browserToolActionInputSchema
  })
  .superRefine((input, context) => {
    const expected = expectedBrowserToolIdForAction(input.action.type);
    if (input.toolId !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolId"],
        message: `toolId ${input.toolId} does not match browser action type ${input.action.type}.`
      });
    }
  });

export const spaceAgentBrowserActionEnvelopeSchema = z.object({
  version: z.literal(1),
  actions: z.array(spaceAgentBrowserActionRequestSchema).min(1).max(3)
});

export const spaceAgentBrowserActionBridgeRequestSchema = z.object({
  roomId: idSchema,
  agentPaneId: idSchema,
  agentSessionId: idSchema,
  roomAgentMissionId: idSchema.optional(),
  selectedToolIds: z.array(spaceBrowserToolIdSchema).max(50),
  actions: z.array(spaceAgentBrowserActionRequestSchema).min(1).max(3)
});

export const spaceAgentBrowserActionObservationSchema = z.object({
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  actionType: browserToolActionTypeSchema,
  viewport: browserSessionViewportSchema,
  currentUrl: z.string().url().nullable(),
  title: z.string().max(500).nullable(),
  text: z.string().max(5000).nullable(),
  capturedAt: isoDateTimeSchema.nullable()
});

export const spaceAgentBrowserActionExecutionResultSchema = z.object({
  request: spaceAgentBrowserActionRequestSchema,
  status: z.enum(["EXECUTED", "BLOCKED", "FAILED"]),
  statusReason: z.string().min(1).max(500),
  observation: spaceAgentBrowserActionObservationSchema.nullable()
});

export const spaceAgentBrowserActionBridgeResponseSchema = z.object({
  results: z.array(spaceAgentBrowserActionExecutionResultSchema).max(3)
});

export const spaceCliBrowserSessionSummarySchema = z.object({
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  agentNumber: z.number().int().min(1).max(99),
  viewport: browserSessionViewportSchema,
  streamMode: browserStreamModeSchema.default("AUTO"),
  resolvedStreamMode: browserResolvedStreamModeSchema.default("PREVIEW"),
  controlState: browserControlStateSchema.default("UNCONTROLLED"),
  activePageId: z.string().max(200).nullable().default(null),
  pageCount: z.number().int().min(0).max(100).default(0),
  status: browserSessionStatusSchema,
  currentUrl: z.string().url().nullable(),
  title: z.string().max(500).nullable(),
  lastFrameAt: isoDateTimeSchema.nullable()
});

export const spaceCliBrowserContextResponseSchema = z.object({
  roomId: idSchema,
  cliPaneId: idSchema,
  cliSessionId: idSchema,
  browserSessions: z.array(spaceCliBrowserSessionSummarySchema).max(50)
});

export const spaceCliBrowserSessionStartRequestSchema = z.object({
  targetPaneId: idSchema.optional(),
  viewport: browserSessionViewportSchema.default("desktop"),
  streamMode: browserStreamModeSchema.default("AUTO"),
  targetUrl: z.string().trim().url().optional()
});

export const spaceCliBrowserSessionStartResponseSchema = z.object({
  session: spaceCliBrowserSessionSummarySchema
});

export const spaceCliBrowserActionBridgeRequestSchema = z.object({
  actions: z.array(spaceAgentBrowserActionRequestSchema).min(1).max(3)
});

export const spaceCliBrowserActionBridgeResponseSchema = spaceAgentBrowserActionBridgeResponseSchema;

const spaceCliBrowserJobCommandSchema = (type: "CAPTURE_STATUS" | "STOP_CAPTURE" | "CANCEL_CAPTURE") =>
  z.object({ type: z.literal(type), jobId: idSchema }).strict();
const spaceCliBrowserArtifactCommandSchema = (type: "PIN_ARTIFACT" | "UNPIN_ARTIFACT") =>
  z.object({ type: z.literal(type), artifactId: idSchema }).strict();

export const spaceCliBrowserCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("LIST_PAGES") }).strict(),
  z.object({
    type: z.literal("CREATE_PAGE"),
    url: z.string().trim().url().optional(),
    activate: z.boolean().default(true)
  }).strict(),
  z.object({ type: z.literal("ACTIVATE_PAGE"), pageId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal("CLOSE_PAGE"), pageId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal("SET_STREAM_MODE"), streamMode: browserStreamModeSchema }).strict(),
  z.object({
    type: z.literal("START_CAPTURE"),
    kind: z.enum(["SCREENSHOT", "RECORDING"]),
    durationMs: z.number().int().min(250).max(1_800_000).optional()
  }).strict(),
  spaceCliBrowserJobCommandSchema("CAPTURE_STATUS"),
  spaceCliBrowserJobCommandSchema("STOP_CAPTURE"),
  spaceCliBrowserJobCommandSchema("CANCEL_CAPTURE"),
  z.object({ type: z.literal("LIST_ARTIFACTS") }).strict(),
  spaceCliBrowserArtifactCommandSchema("PIN_ARTIFACT"),
  spaceCliBrowserArtifactCommandSchema("UNPIN_ARTIFACT"),
  z.object({
    type: z.literal("REQUEST_HANDOFF"),
    kind: z.enum(["CAPTCHA", "LOGIN", "MFA", "OTHER"]),
    reason: z.string().trim().min(1).max(500)
  }).strict(),
  z.object({ type: z.literal("HANDOFF_STATUS") }).strict()
]);

export const spaceCliBrowserCommandRequestSchema = z.object({
  targetPaneId: idSchema,
  command: spaceCliBrowserCommandSchema
}).strict();

export const browserFrameWebSocketServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    paneId: idSchema,
    sessionId: idSchema
  }),
  z.object({
    type: z.literal("frame"),
    frame: browserFrameSchema
  }),
  z.object({
    type: z.literal("status"),
    status: browserSessionStatusSchema,
    statusReason: z.string().min(1).max(500).nullable().optional()
  }),
  z.object({
    type: z.literal("error"),
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500)
  })
]);

export const spaceAgentSessionRecordSchema = z.object({
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  source: z.literal("SPACE").default("SPACE"),
  status: agentPaneBindingStatusSchema,
  title: z.string().min(1).max(160),
  threadId: z.string().min(1).max(200).nullable(),
  selectedProviderId: z.string().min(1).max(120).nullable(),
  selectedModelId: z.string().min(1).max(160).nullable(),
  selectedModelConfigId: agentModelConfigIdSchema.nullable(),
  selectedProviderName: z.string().min(1).max(160).nullable(),
  selectedModelName: z.string().min(1).max(160).nullable(),
  selectedReasoningKey: z.string().min(1).max(80).nullable(),
  selectedToolIds: z.array(z.string().min(1).max(160)).max(50).nullable().default(null),
  permissionMode: permissionModeSchema.nullable().default(null),
  collaborationMode: collaborationModeSchema.nullable().default(null),
  isActive: z.boolean(),
  lastSyncedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const createSpaceAgentSessionInputSchema = spaceAgentSessionRecordSchema
  .omit({
    source: true,
    threadId: true,
    status: true,
    isActive: true,
    lastSyncedAt: true,
    createdAt: true,
    updatedAt: true
  })
  .extend({
    sessionId: idSchema.optional(),
    threadId: z.string().min(1).max(200).nullable().optional(),
    permissionMode: permissionModeSchema.nullable().optional(),
    collaborationMode: collaborationModeSchema.optional(),
    status: agentPaneBindingStatusSchema.optional(),
    isActive: z.boolean().optional(),
    lastSyncedAt: isoDateTimeSchema.nullable().optional()
  });

export const updateSpaceAgentSessionInputSchema = z
  .object({
    paneId: idSchema.optional(),
    roomId: idSchema.optional(),
    status: agentPaneBindingStatusSchema.optional(),
    title: z.string().trim().min(1).max(160).optional(),
    threadId: z.string().trim().min(1).max(200).nullable().optional(),
    selectedProviderId: z.string().trim().min(1).max(120).nullable().optional(),
    selectedModelId: z.string().trim().min(1).max(160).nullable().optional(),
    selectedModelConfigId: agentModelConfigIdSchema.nullable().optional(),
    selectedProviderName: z.string().trim().min(1).max(160).nullable().optional(),
    selectedModelName: z.string().trim().min(1).max(160).nullable().optional(),
    selectedReasoningKey: z.string().trim().min(1).max(80).nullable().optional(),
    selectedToolIds: z.array(z.string().trim().min(1).max(160)).max(50).nullable().optional(),
    permissionMode: permissionModeSchema.nullable().optional(),
    collaborationMode: collaborationModeSchema.optional(),
    isActive: z.boolean().optional(),
    lastSyncedAt: isoDateTimeSchema.nullable().optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Space agent session update must include at least one field.");

export const spaceAgentMessageRecordSchema = z.object({
  messageId: idSchema,
  sessionId: idSchema,
  runId: idSchema.nullable(),
  role: agentPaneMessageRoleSchema,
  content: z.string().max(50000),
  status: agentPaneMessageStatusSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const createSpaceAgentMessageInputSchema = spaceAgentMessageRecordSchema
  .omit({
    messageId: true,
    createdAt: true,
    updatedAt: true
  })
  .extend({
    messageId: idSchema.optional(),
    runId: idSchema.nullable().optional(),
    status: agentPaneMessageStatusSchema.optional()
  });

export const updateSpaceAgentMessageInputSchema = z
  .object({
    runId: idSchema.nullable().optional(),
    content: z.string().max(50000).optional(),
    status: agentPaneMessageStatusSchema.optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Space agent message update must include at least one field.");

export const spaceAgentRunRecordSchema = z.object({
  runId: idSchema,
  sessionId: idSchema,
  paneId: idSchema,
  roomId: idSchema,
  workflowId: idSchema,
  temporalRunId: z.string().min(1).max(160).nullable(),
  codexThreadId: z.string().min(1).max(200).nullable(),
  codexTurnId: z.string().min(1).max(200).nullable(),
  status: spaceAgentRunRecordStatusSchema,
  promptMessageId: idSchema,
  responseMessageId: idSchema,
  errorCode: z.string().min(1).max(160).nullable(),
  errorMessage: z.string().min(1).max(1000).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable()
});

export const createSpaceAgentRunInputSchema = spaceAgentRunRecordSchema
  .omit({
    runId: true,
    temporalRunId: true,
    codexThreadId: true,
    codexTurnId: true,
    errorCode: true,
    errorMessage: true,
    createdAt: true,
    updatedAt: true,
    completedAt: true
  })
  .extend({
    runId: idSchema.optional(),
    temporalRunId: z.string().min(1).max(160).nullable().optional(),
    codexThreadId: z.string().min(1).max(200).nullable().optional(),
    codexTurnId: z.string().min(1).max(200).nullable().optional(),
    errorCode: z.string().min(1).max(160).nullable().optional(),
    errorMessage: z.string().min(1).max(1000).nullable().optional(),
    completedAt: isoDateTimeSchema.nullable().optional()
  });

export const updateSpaceAgentRunInputSchema = z
  .object({
    temporalRunId: z.string().min(1).max(160).nullable().optional(),
    codexThreadId: z.string().min(1).max(200).nullable().optional(),
    codexTurnId: z.string().min(1).max(200).nullable().optional(),
    status: spaceAgentRunRecordStatusSchema.optional(),
    errorCode: z.string().min(1).max(160).nullable().optional(),
    errorMessage: z.string().min(1).max(1000).nullable().optional(),
    completedAt: isoDateTimeSchema.nullable().optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Space agent run update must include at least one field.");

export const coderAgentProxyResourceSchema = z.enum([
  "chat",
  "chat-messages",
  "chat-prompts",
  "chat-stream",
  "chat-watch",
  "chat-queue",
  "chat-title",
  "chat-files",
  "chat-model-configs",
  "chat-provider-configs",
  "mcp-server-configs"
]);

export const coderAgentProxyMethodSchema = z.enum(["GET", "POST", "PATCH", "DELETE"]);

export const coderAgentProxyRequestSchema = z.object({
  resource: coderAgentProxyResourceSchema,
  method: coderAgentProxyMethodSchema,
  chatId: z.string().trim().min(1).max(200).optional(),
  queuedMessageId: z.coerce.number().int().positive().optional(),
  messageId: z.coerce.number().int().positive().optional(),
  query: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
  body: z.unknown().optional()
});

export const providerSchema = z.object({
  id: z.string().min(1).max(120),
  displayName: z.string().min(1).max(120),
  type: z.enum(["CODEX_LB", "OPENAI", "ANTHROPIC", "LOCAL", "CUSTOM"]),
  status: integrationStatusSchema,
  statusReason: z.string().max(500).nullable(),
  healthCheckedAt: isoDateTimeSchema.nullable(),
  maskedKeyPrefix: z.string().max(24).nullable(),
  baseUrl: z.string().url().nullable(),
  routeProfile: z.enum(["headroom", "direct-primary", "direct-auto", "direct-fallback", "openai-direct", "custom"]).nullable().default(null),
  backingProviderId: z.string().min(1).max(120).nullable().default(null),
  credentialRef: z.string().max(500).nullable().default(null),
  isBuiltIn: z.boolean().default(false)
});

export const providerSettingsSchema = z.object({
  defaultProviderId: z.string().min(1).max(120),
  titleGenerationModelId: z.string().min(1).max(160).nullable().default(null),
  titleGenerationReasoningEffort: reasoningEffortSchema.default("low"),
  updatedAt: isoDateTimeSchema
});

export const updateProviderSettingsInputSchema = z
  .object({
    defaultProviderId: z.string().trim().min(1).max(120).optional(),
    titleGenerationModelId: z.string().trim().min(1).max(160).nullable().optional(),
    titleGenerationReasoningEffort: reasoningEffortSchema.optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Provider settings update must include at least one field.");

export const voiceTranscriptionMaxBytes = 25 * 1024 * 1024;
export const voiceTranscriptionModelSchema = z.enum(["gpt-realtime-whisper", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]);
export const voiceTranscriptionLanguageSchema = z.enum(["auto", "el", "en"]);
export const voiceTranscriptionDelaySchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);

export const voiceTranscriptionSettingsSchema = z.object({
  enabled: z.boolean(),
  statusReason: z.string().min(1).max(500),
  defaultModel: voiceTranscriptionModelSchema,
  modelOptions: z.array(voiceTranscriptionModelSchema).min(1).max(10),
  defaultLanguage: voiceTranscriptionLanguageSchema,
  languageOptions: z.array(voiceTranscriptionLanguageSchema).min(1).max(10),
  defaultDelay: voiceTranscriptionDelaySchema,
  delayOptions: z.array(voiceTranscriptionDelaySchema).min(1).max(10),
  maxBytes: z.number().int().min(1).max(voiceTranscriptionMaxBytes),
  maxDurationMs: z.number().int().min(1000).max(5 * 60 * 1000),
  updatedAt: isoDateTimeSchema
});

export const voiceTranscriptionRequestFieldsSchema = z.object({
  model: voiceTranscriptionModelSchema.optional(),
  language: voiceTranscriptionLanguageSchema.default("auto")
});

export const voiceTranscriptionResponseSchema = z.object({
  text: z.string().max(20000),
  model: voiceTranscriptionModelSchema,
  language: voiceTranscriptionLanguageSchema,
  durationMs: z.number().int().min(0),
  byteSize: z.number().int().min(1).max(voiceTranscriptionMaxBytes),
  mimeType: z.string().min(1).max(120)
});

export const voiceRealtimeSessionRequestSchema = z.object({
  offerSdp: z.string().trim().min(32).max(100000),
  model: voiceTranscriptionModelSchema.optional(),
  language: voiceTranscriptionLanguageSchema.default("auto"),
  delay: voiceTranscriptionDelaySchema.optional()
});

export const voiceRealtimeSessionResponseSchema = z.object({
  answerSdp: z.string().trim().min(32).max(100000)
});

export const createProviderInputSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._:-]+$/),
  displayName: z.string().trim().min(1).max(120),
  type: z.enum(["CODEX_LB", "OPENAI", "ANTHROPIC", "LOCAL", "CUSTOM"]).default("CUSTOM"),
  baseUrl: z.string().trim().url().nullable().optional(),
  routeProfile: providerSchema.shape.routeProfile.optional(),
  backingProviderId: z.string().trim().min(1).max(120).nullable().optional(),
  credentialRef: z.string().trim().max(500).nullable().optional()
});

export const updateProviderInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    type: z.enum(["CODEX_LB", "OPENAI", "ANTHROPIC", "LOCAL", "CUSTOM"]).optional(),
    baseUrl: z.string().trim().url().nullable().optional(),
    routeProfile: providerSchema.shape.routeProfile.optional(),
    backingProviderId: z.string().trim().min(1).max(120).nullable().optional(),
    credentialRef: z.string().trim().max(500).nullable().optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Provider update must include at least one field.");

export const modelSchema = z.object({
  id: z.string().min(1).max(160),
  providerId: z.string().min(1).max(120),
  runtimeId: z.string().min(1).max(160).nullable().optional(),
  displayName: z.string().min(1).max(160),
  status: integrationStatusSchema,
  contextWindow: z.number().int().positive().nullable(),
  supportsTools: z.boolean(),
  supportsVision: z.boolean(),
  supportsRealtime: z.boolean(),
  supportsReasoning: z.boolean(),
  defaultReasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).nullable()
});

export const providerValidationResultSchema = z.object({
  providerId: z.string().min(1).max(120),
  status: integrationStatusSchema,
  code: z.enum(["MISSING_CONFIG", "KEY_NAME_NOT_DEDICATED", "KEY_FILE_UNREADABLE", "SMOKE_FAILED", "VERIFIED"]),
  statusReason: z.string().min(1).max(500),
  checkedAt: isoDateTimeSchema,
  maskedKeyPrefix: z.string().max(24).nullable(),
  credentialLabel: z.string().max(160).nullable(),
  modelCount: z.number().int().min(0).nullable(),
  models: z.array(modelSchema).max(200).optional()
});

export const codexAppServerTransportSchema = z.enum(["stdio", "unix", "websocket", "off"]);
export const codexAppServerStatusValueSchema = z.enum(["DISABLED", "READY", "ERROR"]);
export const codexAppServerReasonCodeSchema = z.enum([
  "DISABLED_BY_DEFAULT",
  "TRANSPORT_OFF",
  "CONFIG_SAFE",
  "INVALID_COMMAND",
  "INVALID_TRANSPORT",
  "HOME_PATH_NOT_ABSOLUTE",
  "KEY_FILE_PATH_NOT_ABSOLUTE",
  "KEY_FILE_UNREADABLE",
  "KEY_FILE_EMPTY",
  "SOCKET_PATH_NOT_ABSOLUTE",
  "WEBSOCKET_URL_REQUIRED",
  "WEBSOCKET_URL_INVALID",
  "WEBSOCKET_NON_LOOPBACK_FORBIDDEN"
]);

export const codexAppServerSchemaManifestSchema = z.object({
  schemaVersion: z.literal(1),
  codexCliVersion: z.string().min(1).max(120),
  generatedAt: isoDateTimeSchema,
  jsonSchemaFileCount: z.number().int().min(1),
  typeScriptFileCount: z.number().int().min(1),
  jsonSchemaBundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  typeScriptIndexSha256: z.string().regex(/^[a-f0-9]{64}$/)
});

export const codexAppServerStatusSchema = z.object({
  id: z.literal("codex-app-server"),
  status: codexAppServerStatusValueSchema,
  reasonCode: codexAppServerReasonCodeSchema,
  statusReason: z.string().min(1).max(500),
  transport: codexAppServerTransportSchema,
  command: z.string().min(1).max(500).nullable(),
  socketPath: z.string().min(1).max(500).nullable(),
  websocketUrl: z.string().url().nullable(),
  schemasGenerated: z.boolean(),
  schemaManifest: codexAppServerSchemaManifestSchema.nullable().default(null),
  lastCheckedAt: isoDateTimeSchema
});

export const codexAppServerHandshakeResultSchema = z.object({
  id: z.literal("codex-app-server"),
  status: z.enum(["DISABLED", "ERROR", "VERIFIED"]),
  code: z.enum([
    "ADAPTER_DISABLED",
    "CONFIG_UNSAFE",
    "SCHEMAS_MISSING",
    "STDIO_SPAWN_NOT_ENABLED",
    "TRANSPORT_NOT_IMPLEMENTED",
    "HANDSHAKE_FAILED",
    "HANDSHAKE_OK"
  ]),
  message: z.string().min(1).max(500),
  transport: codexAppServerTransportSchema,
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema,
  durationMs: z.number().int().min(0),
  serverInfo: z.record(z.string(), z.unknown()).nullable().default(null)
});

export const codexAppServerHandshakeCheckSchema = codexAppServerHandshakeResultSchema.extend({
  checkId: idSchema,
  traceId: requestIdSchema,
  actorUserId: idSchema.nullable(),
  schemasGenerated: z.boolean(),
  schemaManifest: codexAppServerSchemaManifestSchema.nullable().default(null),
  checkedAt: isoDateTimeSchema
});

export const codexAppServerTurnSmokeInputSchema = z.object({
  prompt: z.string().trim().min(1).max(500).default("Reply with exactly: space-ok"),
  model: z.string().trim().min(1).max(160).optional()
});

export const codexAppServerTurnStatusSchema = z.enum(["completed", "interrupted", "failed", "inProgress"]);

export const codexAppServerTurnSmokeResultSchema = z.object({
  id: z.literal("codex-app-server"),
  status: z.enum(["DISABLED", "ERROR", "VERIFIED"]),
  code: z.enum([
    "ADAPTER_DISABLED",
    "CONFIG_UNSAFE",
    "SCHEMAS_MISSING",
    "STDIO_SPAWN_NOT_ENABLED",
    "TURN_SMOKE_NOT_ENABLED",
    "TRANSPORT_NOT_IMPLEMENTED",
    "THREAD_START_FAILED",
    "TURN_START_FAILED",
    "TURN_COMPLETION_FAILED",
    "TURN_COMPLETED"
  ]),
  message: z.string().min(1).max(500),
  transport: codexAppServerTransportSchema,
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema,
  durationMs: z.number().int().min(0),
  threadId: z.string().min(1).max(200).nullable(),
  turnId: z.string().min(1).max(200).nullable(),
  turnStatus: codexAppServerTurnStatusSchema.nullable(),
  notificationCount: z.number().int().min(0),
  completedNotificationSeen: z.boolean()
});

export const codexAppServerTurnSmokeCheckSchema = codexAppServerTurnSmokeResultSchema.extend({
  checkId: idSchema,
  traceId: requestIdSchema,
  actorUserId: idSchema.nullable(),
  schemasGenerated: z.boolean(),
  schemaManifest: codexAppServerSchemaManifestSchema.nullable().default(null),
  model: z.string().max(160).nullable(),
  checkedAt: isoDateTimeSchema
});

export const codexHistoryItemSchema = z.object({
  id: z.string().min(1).max(200),
  rolloutPath: z.string().min(1).max(1000).nullable(),
  title: z.string().min(1).max(300),
  preview: z.string().max(2000),
  model: z.string().min(1).max(160).nullable(),
  reasoningEffort: reasoningEffortSchema.nullable(),
  cwd: z.string().min(1).max(1000).nullable(),
  archived: z.boolean(),
  source: z.string().min(1).max(120).nullable(),
  modelProvider: z.string().min(1).max(120).nullable(),
  threadSource: z.string().min(1).max(120).nullable(),
  firstUserMessage: z.string().max(2000),
  updatedAt: isoDateTimeSchema.nullable(),
  recencyAt: isoDateTimeSchema.nullable()
});

export const codexHistoryResponseSchema = z.object({
  data: z.array(codexHistoryItemSchema).max(100),
  totalItems: z.number().int().min(0),
  visibleItems: z.number().int().min(0),
  pagination: paginationSchema.optional(),
  checkedAt: isoDateTimeSchema
});

export const cliTaskHistoryItemSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  revisionId: idSchema,
  title: z.string().min(1).max(300),
  runtimeId: z.string().min(1).max(160),
  providerId: z.string().min(1).max(120),
  providerLabel: z.string().min(1).max(160),
  modelProvider: z.string().min(1).max(120),
  preview: z.string().max(2000),
  firstUserMessage: z.string().max(2000),
  cwd: z.string().min(1).max(1000).nullable(),
  model: z.string().min(1).max(160).nullable(),
  reasoningEffort: cliReasoningEffortSchema.nullable(),
  updatedAt: isoDateTimeSchema,
  recencyAt: isoDateTimeSchema,
  archived: z.literal(false),
  source: z.literal("space"),
  threadSource: z.string().min(1).max(160),
  rolloutPath: z.null()
});

export const cliTaskHistoryResponseSchema = z.object({
  threads: z.array(cliTaskHistoryItemSchema).max(100),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100)
});

export const codexThreadPresentationSchema = z.enum(["raw", "chat"]);
export const codexThreadQuerySchema = z.object({
  presentation: codexThreadPresentationSchema.default("raw")
});

export const codexThreadItemSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["metadata", "message", "event", "reasoning", "tool_call", "tool_result"]),
  role: z.enum(["user", "assistant", "system", "tool"]).nullable(),
  content: z.string().max(50000),
  toolName: z.string().min(1).max(200).nullable().default(null),
  rawType: z.string().min(1).max(120).nullable().default(null),
  createdAt: isoDateTimeSchema.nullable()
});

export const codexThreadResponseSchema = z.object({
  thread: codexHistoryItemSchema,
  items: z.array(codexThreadItemSchema).max(1000),
  checkedAt: isoDateTimeSchema
});

export const cliTaskResumeModeSchema = z.enum(["NATIVE_RESUME", "CROSS_RUNTIME_SHARE", "SPACE_FALLBACK"]);

export const resumePaneCliSessionResponseSchema = paneCliSessionResponseSchema.extend({
  pane: paneSchema,
  mode: cliTaskResumeModeSchema
});

export const codexEnvironmentLbUsageSchema = z.object({
  allAccountsRemainingPercent: z.number().min(0).max(100).nullable(),
  activeAccountsRemainingPercent: z.number().min(0).max(100).nullable(),
  routeMode: z.enum(["direct", "headroom"]).nullable(),
  routeTargetMode: z.enum(["primary", "fallback", "auto"]).nullable(),
  upstream: z.string().min(1).max(160).nullable(),
  source: z.string().min(1).max(200).nullable(),
  error: z.string().min(1).max(500).nullable(),
  checkedAt: isoDateTimeSchema
});

export const codexEnvironmentSpaceStatsSchema = z.object({
  roomCount: z.number().int().min(0),
  agentPaneCount: z.number().int().min(0),
  activeAgentPaneCount: z.number().int().min(0),
  cliPaneCount: z.number().int().min(0),
  chatPaneCount: z.number().int().min(0),
  browserPaneCount: z.number().int().min(0),
  checkedAt: isoDateTimeSchema
});

const nullableUsagePercentSchema = z.number().min(0).max(100).nullable();
const nullableByteCountSchema = z.number().int().min(0).nullable();

export const codexEnvironmentHostStatsSchema = z.object({
  cliSessions: z.object({
    active: z.number().int().min(0),
    attached: z.number().int().min(0),
    detached: z.number().int().min(0),
    status: z.enum(["OK", "PARTIAL"])
  }),
  cpu: z.object({
    usagePercent: nullableUsagePercentSchema,
    coreCount: z.number().int().min(1).nullable()
  }),
  memory: z.object({
    usedBytes: nullableByteCountSchema,
    totalBytes: nullableByteCountSchema,
    usagePercent: nullableUsagePercentSchema
  }),
  swap: z.object({
    usedBytes: nullableByteCountSchema,
    totalBytes: nullableByteCountSchema,
    usagePercent: nullableUsagePercentSchema
  }),
  apiStartedAt: isoDateTimeSchema,
  sampledAt: isoDateTimeSchema
});

export const codexEnvironmentSchema = z.object({
  codexHome: z.string().min(1).max(1000),
  stateDbPath: z.string().min(1).max(1000),
  config: z.object({
    modelProvider: z.string().min(1).max(120).nullable(),
    model: z.string().min(1).max(160).nullable(),
    reasoningEffort: reasoningEffortSchema.nullable()
  }),
  mcpServers: z.array(z.string().min(1).max(160)).max(200),
  skillCount: z.number().int().min(0),
  pluginCount: z.number().int().min(0),
  memories: z.object({
    generateMemories: z.boolean().nullable(),
    useMemories: z.boolean().nullable()
  }),
  features: z.object({
    plugins: z.boolean().nullable(),
    memories: z.boolean().nullable()
  }),
  lbUsage: codexEnvironmentLbUsageSchema.optional(),
  spaceStats: codexEnvironmentSpaceStatsSchema.optional(),
  hostStats: codexEnvironmentHostStatsSchema.optional(),
  checkedAt: isoDateTimeSchema
});

const nullableToolbarPercentSchema = z.number().min(0).max(100).nullable();
const toolbarByteCountSchema = z.number().int().min(0);

export const codexUsageAccountSchema = z
  .object({
    id: z.string().min(1).max(160),
    label: z.string().min(1).max(200),
    fiveHourRemainingPercent: nullableToolbarPercentSchema,
    weeklyRemainingPercent: nullableToolbarPercentSchema,
    sampledAt: isoDateTimeSchema.nullable()
  })
  .strict();

export const codexUsageAccountListSchema = z
  .object({
    data: z.array(codexUsageAccountSchema).max(100),
    pagination: paginationSchema,
    source: z.string().min(1).max(160),
    isStale: z.boolean(),
    error: z.string().min(1).max(500).nullable(),
    checkedAt: isoDateTimeSchema
  })
  .strict();

export const cliSessionDetailSchema = z
  .object({
    sessionId: idSchema,
    hostId: z.enum(["main", "root"]),
    runtimeId: z.string().min(1).max(160),
    roomId: idSchema,
    paneId: idSchema,
    pid: z.number().int().positive(),
    status: z.literal("RUNNING"),
    attachmentCount: z.number().int().min(0),
    startedAt: isoDateTimeSchema,
    detachedAt: isoDateTimeSchema.nullable(),
    rssBytes: toolbarByteCountSchema,
    cleanupEligible: z.boolean()
  })
  .strict();

export const cliSessionStatsSchema = z
  .object({
    summary: z
      .object({
        running: z.number().int().min(0),
        attached: z.number().int().min(0),
        detached: z.number().int().min(0),
        cleanupEligible: z.number().int().min(0)
      })
      .strict(),
    sessions: z.array(cliSessionDetailSchema).max(500),
    sampledAt: isoDateTimeSchema
  })
  .strict();

export const cliSessionReapResponseSchema = z
  .object({
    status: z.enum(["COMPLETED", "PARTIAL", "NOOP"]),
    killedSessionIds: z.array(idSchema).max(500),
    skippedCount: z.number().int().min(0),
    estimatedReclaimedBytes: toolbarByteCountSchema,
    completedAt: isoDateTimeSchema
  })
  .strict();

export const hostMemorySummarySchema = z
  .object({
    totalBytes: toolbarByteCountSchema,
    usedBytes: toolbarByteCountSchema,
    availableBytes: toolbarByteCountSchema,
    usagePercent: z.number().min(0).max(100),
    pageCacheBytes: toolbarByteCountSchema,
    reclaimableBytes: toolbarByteCountSchema
  })
  .strict();

export const hostMemoryDetailsSchema = z
  .object({
    memory: hostMemorySummarySchema,
    swap: z
      .object({
        totalBytes: toolbarByteCountSchema,
        usedBytes: toolbarByteCountSchema,
        usagePercent: z.number().min(0).max(100)
      })
      .strict(),
    pressure: z
      .object({
        isUnderPressure: z.boolean(),
        availablePercent: z.number().min(0).max(100),
        canDropPageCache: z.boolean()
      })
      .strict(),
    topProcesses: z
      .array(
        z
          .object({
            pid: z.number().int().positive(),
            name: z.string().min(1).max(120),
            rssBytes: toolbarByteCountSchema,
            cpuPercent: nullableToolbarPercentSchema,
            state: z.string().min(1).max(16),
            isSpaceManaged: z.boolean(),
            cleanupEligible: z.boolean()
          })
          .strict()
      )
      .max(10),
    sampledAt: isoDateTimeSchema
  })
  .strict();

export const memoryReclaimResponseSchema = z
  .object({
    status: z.enum(["COMPLETED", "PARTIAL", "NOOP"]),
    cli: z
      .object({
        killedSessionIds: z.array(idSchema).max(500),
        estimatedReclaimedBytes: toolbarByteCountSchema
      })
      .strict(),
    kernelCache: z
      .object({
        status: z.enum(["CLEARED", "SKIPPED_LOW_PRESSURE", "SKIPPED_SMALL_CACHE", "SKIPPED_COOLDOWN", "FAILED"]),
        reclaimedBytes: toolbarByteCountSchema,
        message: z.string().min(1).max(500).nullable()
      })
      .strict(),
    before: hostMemorySummarySchema,
    after: hostMemorySummarySchema,
    completedAt: isoDateTimeSchema
  })
  .strict();

export const providerSwitchTargetSchema = z
  .object({
    providerId: z.string().min(1).max(120),
    displayName: z.string().min(1).max(120),
    isCurrent: z.boolean(),
    canSwitch: z.boolean(),
    health: z.enum(["HEALTHY", "DEGRADED", "UNAVAILABLE", "UNKNOWN"]),
    reason: z.string().min(1).max(500).nullable()
  })
  .strict();

export const providerSwitchTargetsSchema = z
  .object({
    data: z.array(providerSwitchTargetSchema).max(100),
    pagination: paginationSchema,
    checkedAt: isoDateTimeSchema
  })
  .strict();

export const providerSwitchRequestSchema = z.object({ providerId: z.string().trim().min(1).max(120) }).strict();

export const providerSwitchResponseSchema = z
  .object({
    status: z.enum(["SWITCHED", "NOOP"]),
    previousProviderId: z.string().min(1).max(120),
    currentProviderId: z.string().min(1).max(120),
    routeMode: z.enum(["direct", "headroom"]).nullable(),
    routeTargetMode: z.enum(["primary", "fallback", "auto"]).nullable(),
    switchedAt: isoDateTimeSchema
  })
  .strict();

export const codexLbSpeedTierSchema = z.enum(["STANDARD", "FAST"]);

export const codexLbSpeedDefaultUpdateRequestSchema = z
  .object({
    tier: codexLbSpeedTierSchema
  })
  .strict();

export const codexLbSpeedDefaultsResponseSchema = z
  .object({
    models: z.tuple([
      z
        .object({
          modelId: z.literal("gpt-5.5"),
          displayName: z.literal("GPT-5.5"),
          tier: codexLbSpeedTierSchema
        })
        .strict(),
      z
        .object({
          modelId: z.literal("gpt-5.4"),
          displayName: z.literal("GPT-5.4"),
          tier: codexLbSpeedTierSchema
        })
        .strict()
    ]),
    updatedAt: isoDateTimeSchema.nullable(),
    checkedAt: isoDateTimeSchema
  })
  .strict();

const codexHistoryPurgeCountSchema = z.number().int().min(0).max(1_000_000);

const codexHistoryPurgeCountsSchema = z
  .object({
    threads: codexHistoryPurgeCountSchema,
    cliTasks: codexHistoryPurgeCountSchema.default(0),
    indexEntries: codexHistoryPurgeCountSchema,
    rolloutFiles: codexHistoryPurgeCountSchema,
    shellSnapshots: codexHistoryPurgeCountSchema
  })
  .strict();

const hasCodexHistoryPurgeTargets = (counts: z.infer<typeof codexHistoryPurgeCountsSchema>) =>
  Object.values(counts).some((count) => count > 0);

export const codexHistoryPurgePreviewRequestSchema = z.object({}).strict();

export const codexHistoryPurgePreviewResponseSchema = z
  .object({
    status: z.enum(["READY", "NOOP"]),
    previewId: z.string().uuid(),
    candidates: codexHistoryPurgeCountsSchema,
    protectedThreads: codexHistoryPurgeCountSchema,
    expiresAt: isoDateTimeSchema,
    checkedAt: isoDateTimeSchema
  })
  .strict()
  .superRefine((response, context) => {
    const hasTargets = hasCodexHistoryPurgeTargets(response.candidates);
    if ((response.status === "READY") !== hasTargets) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "READY previews require candidates and NOOP previews require zero candidates."
      });
    }
  });

export const codexHistoryPurgeExecuteRequestSchema = z
  .object({
    previewId: z.string().uuid(),
    confirmation: z.literal("PURGE HISTORY")
  })
  .strict();

export const codexHistoryPurgeResponseSchema = z
  .object({
    status: z.enum(["COMPLETED", "NOOP"]),
    previewId: z.string().uuid(),
    backupId: z.string().uuid(),
    purged: codexHistoryPurgeCountsSchema,
    protectedThreads: codexHistoryPurgeCountSchema,
    newlyProtectedThreads: codexHistoryPurgeCountSchema,
    completedAt: isoDateTimeSchema
  })
  .strict()
  .superRefine((response, context) => {
    const hasPurgedTargets = hasCodexHistoryPurgeTargets(response.purged);
    if ((response.status === "COMPLETED") !== hasPurgedTargets) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "COMPLETED purges require removed history and NOOP purges require zero removals."
      });
    }
  });

export const serviceRestartScopeSchema = z.literal("CORE");
export const serviceRestartRequestSchema = z.object({
  scope: serviceRestartScopeSchema
}).strict();
export const serviceRestartResponseSchema = z.object({
  status: z.literal("ACCEPTED"),
  scope: serviceRestartScopeSchema,
  services: z.tuple([
    z.literal("space-worker.service"),
    z.literal("space-api.service"),
    z.literal("space-web.service")
  ]),
  requestedAt: isoDateTimeSchema,
  cooldownUntil: isoDateTimeSchema,
  apiStartedAt: isoDateTimeSchema
});

export const adminOperationTypeSchema = z.enum([
  "CLI_MAINTENANCE_CHECK",
  "CLI_MAINTENANCE_UPDATE",
  "SPACE_RELEASE"
]);
export const adminOperationStatusSchema = z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"]);
export const adminOperationRunSchema = z
  .object({
    id: idSchema,
    operationType: adminOperationTypeSchema,
    status: adminOperationStatusSchema,
    actorUserId: idSchema.nullable(),
    summary: z.string().trim().min(1).max(1000),
    result: z.record(z.string(), z.unknown()).default({}),
    createdAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    finishedAt: isoDateTimeSchema.nullable(),
    updatedAt: isoDateTimeSchema
  })
  .strict();

export const createAdminOperationRunInputSchema = z
  .object({
    operationType: adminOperationTypeSchema,
    actorUserId: idSchema.nullable(),
    summary: z.string().trim().min(1).max(1000),
    result: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const updateAdminOperationRunInputSchema = z
  .object({
    status: adminOperationStatusSchema.optional(),
    summary: z.string().trim().min(1).max(1000).optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    startedAt: isoDateTimeSchema.nullable().optional(),
    finishedAt: isoDateTimeSchema.nullable().optional()
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, "An admin operation update must change at least one field.");

export const cliMaintenanceRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("CHECK") }).strict(),
  z
    .object({
      mode: z.literal("UPDATE"),
      confirmation: z.literal("UPDATE ALL CLI APPS")
    })
    .strict()
]);

export const cliMaintenanceCheckStatusSchema = z.enum(["PASS", "WARN", "FAIL", "SKIPPED"]);
export const cliMaintenanceRuntimeResultSchema = z
  .object({
    runtimeId: cliToggleRuntimeIdSchema,
    displayName: z.string().trim().min(1).max(160),
    installedVersion: z.string().trim().min(1).max(160).nullable(),
    availableVersion: z.string().trim().min(1).max(160).nullable(),
    status: cliMaintenanceCheckStatusSchema,
    code: z.string().trim().min(1).max(80).regex(/^[A-Z0-9_]+$/),
    summary: z.string().trim().min(1).max(1000),
    checks: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(120),
            status: cliMaintenanceCheckStatusSchema,
            code: z.string().trim().min(1).max(80).regex(/^[A-Z0-9_]+$/),
            summary: z.string().trim().min(1).max(1000),
            durationMs: z.number().int().min(0).max(3_600_000)
          })
          .strict()
      )
      .max(32)
  })
  .strict();

export const sourceControlProviderSchema = z.enum(["gitea", "github"]);
export const sourceControlConnectionStatusSchema = z.enum(["DISCONNECTED", "CONNECTED", "ERROR"]);
export const sourceControlVerificationCodeSchema = z.enum([
  "NOT_VERIFIED",
  "VERIFIED",
  "INVALID_TOKEN",
  "INSUFFICIENT_PERMISSION",
  "PROVIDER_UNAVAILABLE"
]);
export const sourceControlConnectionSchema = z
  .object({
    provider: sourceControlProviderSchema,
    repositoryOwner: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.-]+$/),
    repositoryName: z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9_.-]+$/),
    accountLogin: z.string().trim().min(1).max(160).nullable(),
    status: sourceControlConnectionStatusSchema,
    secretConfigured: z.boolean(),
    lastVerifiedAt: isoDateTimeSchema.nullable(),
    lastVerificationCode: sourceControlVerificationCodeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();

export const updateSourceControlConnectionInputSchema = z
  .object({
    token: z.string().trim().min(20).max(512).regex(/^[A-Za-z0-9._-]+$/)
  })
  .strict();

export const releaseTagSchema = z
  .string()
  .trim()
  .min(12)
  .max(32)
  .regex(/^v20\d{2}\.(?:0[1-9]|1[0-2])\.(?:0[1-9]|[12]\d|3[01])\.[1-9]\d*$/);
export const releaseNotesSchema = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), "Release notes contain control characters.");
export const gitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const releasePreviewSchema = z
  .object({
    id: idSchema,
    tag: releaseTagSchema,
    notes: releaseNotesSchema,
    sourceCommit: gitCommitShaSchema,
    previousTag: releaseTagSchema.nullable(),
    remoteMainCommits: z
      .object({
        gitea: gitCommitShaSchema,
        github: gitCommitShaSchema
      })
      .strict(),
    expiresAt: isoDateTimeSchema,
    createdAt: isoDateTimeSchema
  })
  .strict();

export const createReleasePreviewInputSchema = z
  .object({
    tag: releaseTagSchema.optional(),
    notes: releaseNotesSchema.optional()
  })
  .strict();

export const createReleaseRequestSchema = z
  .object({
    previewId: idSchema,
    tag: releaseTagSchema,
    notes: releaseNotesSchema,
    confirmation: z.string().min(1).max(64)
  })
  .strict()
  .superRefine((input, context) => {
    if (input.confirmation !== `PUBLISH ${input.tag}`) {
      context.addIssue({
        code: "custom",
        path: ["confirmation"],
        message: `Release confirmation must exactly match PUBLISH ${input.tag}.`
      });
    }
  });

export const eventSchema = z.object({
  id: idSchema,
  roomId: idSchema.nullable(),
  paneId: idSchema.nullable(),
  turnId: idSchema.nullable(),
  workflowId: idSchema.nullable().default(null),
  traceId: requestIdSchema,
  type: eventTypeSchema,
  message: z.string().min(1).max(1000),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: isoDateTimeSchema
});

export const auditEventSchema = z.object({
  id: idSchema,
  actorUserId: idSchema.nullable(),
  traceId: requestIdSchema,
  action: z.string().min(1).max(160),
  targetType: z.string().min(1).max(80),
  targetId: z.string().min(1).max(160).nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: isoDateTimeSchema
});

export const createAuditEventInputSchema = z.object({
  actorUserId: idSchema.nullable(),
  traceId: requestIdSchema,
  action: z.string().min(1).max(160),
  targetType: z.string().min(1).max(80),
  targetId: z.string().min(1).max(160).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const capabilitySchema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum(["PROVIDER", "MODEL", "MCP_SERVER", "MCP_TOOL", "SKILL", "MEMORY_SCOPE", "BROWSER_POOL"]),
  displayName: z.string().min(1).max(160),
  status: integrationStatusSchema,
  statusReason: z.string().max(500).nullable(),
  requiresApproval: z.boolean()
});

export const observabilityDurationSummarySchema = z.object({
  count: z.number().int().min(0),
  min: z.number().min(0).nullable(),
  max: z.number().min(0).nullable(),
  average: z.number().min(0).nullable(),
  p50: z.number().min(0).nullable(),
  p95: z.number().min(0).nullable(),
  p99: z.number().min(0).nullable()
});

export const observabilityEndpointMetricSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  route: z.string().min(1).max(240),
  statusClass: z.enum(["1xx", "2xx", "3xx", "4xx", "5xx"]),
  requestCount: z.number().int().min(0),
  errorCount: z.number().int().min(0),
  durationMs: observabilityDurationSummarySchema,
  lastSeenAt: isoDateTimeSchema.nullable()
});

export const observabilitySnapshotSchema = z.object({
  service: z.literal("space-api"),
  generatedAt: isoDateTimeSchema,
  runtime: z.object({
    startedAt: isoDateTimeSchema,
    uptimeSeconds: z.number().int().min(0),
    nodeVersion: z.string().min(1).max(80),
    pid: z.number().int().positive(),
    memory: z.object({
      rssBytes: z.number().int().min(0),
      heapUsedBytes: z.number().int().min(0),
      heapTotalBytes: z.number().int().min(0),
      externalBytes: z.number().int().min(0),
      arrayBuffersBytes: z.number().int().min(0)
    })
  }),
  totals: z.object({
    requestCount: z.number().int().min(0),
    errorCount: z.number().int().min(0),
    errorRate: z.number().min(0).max(1),
    p50Ms: z.number().min(0).nullable(),
    p95Ms: z.number().min(0).nullable(),
    p99Ms: z.number().min(0).nullable()
  }),
  endpoints: z.array(observabilityEndpointMetricSchema).max(50)
});

export const workerReadinessStatusSchema = z.enum(["RUNNING", "NO_POLLERS", "ERROR"]);

export const workerReadinessSchema = z.object({
  id: z.literal("space-worker"),
  status: workerReadinessStatusSchema,
  statusReason: z.string().min(1).max(1000),
  address: z.string().min(1).max(200),
  namespace: z.string().min(1).max(160),
  taskQueue: z.string().min(1).max(160),
  reachable: z.boolean(),
  workflowPollerCount: z.number().int().min(0),
  activityPollerCount: z.number().int().min(0),
  pollerCount: z.number().int().min(0),
  workflowBacklogCount: z.number().int().min(0).nullable(),
  activityBacklogCount: z.number().int().min(0).nullable(),
  pollerIdentities: z.array(z.string().min(1).max(240)).max(20),
  lastPollerAccessAt: isoDateTimeSchema.nullable(),
  checkedAt: isoDateTimeSchema
});

export const storageReadinessStatusSchema = z.enum(["VERIFIED", "WARN", "BLOCKED"]);

export const storageReadinessMountSchema = z.object({
  path: z.string().min(1).max(500),
  deviceId: z.string().min(1).max(120),
  sizeBytes: z.number().int().min(0),
  availableBytes: z.number().int().min(0),
  usedPercent: z.number().min(0).max(100)
});

export const storageReadinessSchema = z.object({
  id: z.literal("space-storage"),
  status: storageReadinessStatusSchema,
  statusReason: z.string().min(1).max(1000),
  root: storageReadinessMountSchema,
  app: storageReadinessMountSchema,
  dedicatedAppVolume: z.boolean(),
  minimumRecommendedFreeBytes: z.number().int().positive(),
  checkedAt: isoDateTimeSchema
});

export const mcpRiskLevelSchema = z.enum(["R0", "R1", "R2", "R3", "R4"]);
export const mcpTransportSchema = z.enum(["stdio", "http"]);
export const mcpApprovalModeSchema = z.enum(["DISABLED", "ALWAYS_ASK", "ALLOWLISTED"]);

const mcpServerConfigIdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:-]+$/);

export const mcpServerConfigSchema = z
  .object({
    id: mcpServerConfigIdSchema,
    displayName: z.string().trim().min(1).max(160),
    transport: mcpTransportSchema,
    command: z.string().trim().min(1).max(500).optional(),
    args: z.array(z.string().max(500)).max(50).default([]),
    url: z.string().trim().url().max(1000).optional(),
    enabled: z.boolean().default(false)
  })
  .superRefine((config, ctx) => {
    if (config.transport === "stdio" && !config.command) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "stdio MCP server config requires command." });
    }
    if (config.transport === "http") {
      if (!config.url) {
        ctx.addIssue({ code: "custom", path: ["url"], message: "http MCP server config requires url." });
        return;
      }
      const protocol = new URL(config.url).protocol;
      if (protocol !== "http:" && protocol !== "https:") {
        ctx.addIssue({ code: "custom", path: ["url"], message: "http MCP server config requires http or https URL." });
      }
    }
  });

export const mcpServerConfigListSchema = z
  .array(mcpServerConfigSchema)
  .max(50)
  .superRefine((configs, ctx) => {
    const seenIds = new Set<string>();
    configs.forEach((config, index) => {
      if (seenIds.has(config.id)) {
        ctx.addIssue({ code: "custom", path: [index, "id"], message: "MCP server config ids must be unique." });
      }
      seenIds.add(config.id);
    });
  });

export const mcpDiscoverySmokeCodeSchema = z.enum([
  "CONFIG_INVALID",
  "DISCOVERY_SMOKE_DISABLED",
  "NO_CONFIGURED_SERVERS",
  "DISCOVERY_NOT_IMPLEMENTED",
  "DISCOVERY_FAILED",
  "DISCOVERY_OK"
]);

export const mcpGatewayStatusSchema = z.object({
  id: z.literal("mcp-gateway"),
  status: integrationStatusSchema,
  statusReason: z.string().min(1).max(500),
  targetSpecVersion: z.string().min(1).max(40),
  approvalMode: mcpApprovalModeSchema,
  serverCount: z.number().int().min(0),
  toolCount: z.number().int().min(0),
  lastDiscoveryAt: isoDateTimeSchema.nullable()
});

export const mcpServerSchema = z.object({
  id: z.string().min(1).max(160),
  displayName: z.string().min(1).max(160),
  transport: mcpTransportSchema,
  status: integrationStatusSchema,
  statusReason: z.string().min(1).max(500),
  schemaVersion: z.string().min(1).max(40),
  configHash: z.string().min(1).max(128),
  toolCount: z.number().int().min(0),
  lastDiscoveredAt: isoDateTimeSchema.nullable()
});

export const mcpToolSchema = z.object({
  id: z.string().min(1).max(200),
  serverId: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
  riskLevel: mcpRiskLevelSchema,
  schemaHash: z.string().min(1).max(128),
  approvalRequired: z.boolean(),
  status: integrationStatusSchema,
  statusReason: z.string().min(1).max(500)
});

const capabilityBridgeStatusSchema = z.enum(["VERIFIED", "ENABLED", "DISABLED", "WARN", "ERROR"]);
const capabilityBridgeSensitivePattern = /api[_-]?key|secret|password|token/gi;
const capabilityBridgeTextSchema = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .transform((value) => value.replace(capabilityBridgeSensitivePattern, "[REDACTED]"));

export const spaceCapabilitySourceSchema = z.object({
  id: z.string().min(1).max(160),
  label: capabilityBridgeTextSchema(160),
  status: capabilityBridgeStatusSchema,
  statusReason: capabilityBridgeTextSchema(500),
  lastCheckedAt: isoDateTimeSchema.nullable().default(null)
});

export const spaceCapabilityMcpServerSchema = z.object({
  id: z.string().min(1).max(160),
  displayName: capabilityBridgeTextSchema(160),
  transport: mcpTransportSchema,
  status: integrationStatusSchema,
  statusReason: capabilityBridgeTextSchema(500)
});

export const spaceCapabilitySkillSchema = z.object({
  id: z.string().min(1).max(160),
  displayName: capabilityBridgeTextSchema(160),
  source: z.enum(["STATIC", "CODEX_SKILL", "OPERATOR_PROPOSAL"]),
  status: integrationStatusSchema,
  statusReason: capabilityBridgeTextSchema(500).nullable().default(null),
  contentHash: z.string().min(1).max(128)
});

export const spaceCapabilityMemorySchema = z.object({
  canonicalIndexPath: z.string().min(1).max(500),
  currentMonthPath: z.string().min(1).max(500),
  status: integrationStatusSchema,
  statusReason: capabilityBridgeTextSchema(500)
});

export const spaceCapabilityVsCodeExtensionSchema = z.object({
  id: z.string().min(1).max(200),
  displayName: capabilityBridgeTextSchema(200),
  version: z.string().min(1).max(80).nullable().default(null),
  commandCount: z.number().int().min(0).max(1000),
  status: integrationStatusSchema,
  statusReason: capabilityBridgeTextSchema(500)
});

export const spaceCapabilityCliRuntimeSchema = z.object({
  id: z.string().min(1).max(160),
  displayName: capabilityBridgeTextSchema(160),
  status: agentRuntimeStatusSchema,
  statusReason: capabilityBridgeTextSchema(500)
});

export const spaceCapabilityCodexLbRouteSchema = z.object({
  status: integrationStatusSchema,
  mode: z.string().min(1).max(80).nullable(),
  selectedAt: z.string().min(1).max(80).nullable(),
  activeUpstreams: z.array(z.string().min(1).max(120)).max(20)
});

export const spaceCapabilityGateSchema = z.object({
  id: z.string().min(1).max(160),
  status: capabilityBridgeStatusSchema,
  statusReason: capabilityBridgeTextSchema(500)
});

export const spaceCapabilitySnapshotSchema = z.object({
  id: z.literal("space-capability-snapshot"),
  generatedAt: isoDateTimeSchema,
  status: integrationStatusSchema,
  statusReason: capabilityBridgeTextSchema(500),
  sources: z.array(spaceCapabilitySourceSchema).max(50),
  mcpServers: z.array(spaceCapabilityMcpServerSchema).max(100),
  skills: z.array(spaceCapabilitySkillSchema).max(300),
  memory: spaceCapabilityMemorySchema,
  vscode: z.object({
    extensions: z.array(spaceCapabilityVsCodeExtensionSchema).max(200)
  }),
  cliRuntimes: z.array(spaceCapabilityCliRuntimeSchema).max(50),
  codexLbRoute: spaceCapabilityCodexLbRouteSchema,
  gates: z.array(spaceCapabilityGateSchema).max(50)
});

export const paneCapabilityExecutionSchema = z.enum(["force_on", "default_on", "selectable", "metadata_only", "blocked"]);

export const paneCapabilityItemSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  status: capabilityBridgeStatusSchema,
  statusReason: z.string().min(1).max(500),
  execution: paneCapabilityExecutionSchema,
  requiresApproval: z.boolean()
});

export const paneCapabilityGroupSchema = z.object({
  id: z.string().min(1).max(160),
  label: z.string().min(1).max(160),
  status: capabilityBridgeStatusSchema,
  statusReason: z.string().min(1).max(500),
  items: z.array(paneCapabilityItemSchema).max(200)
});

export const paneCapabilityMatrixSchema = z.object({
  paneId: idSchema,
  paneMode: paneModeSchema,
  generatedAt: isoDateTimeSchema,
  groups: z.array(paneCapabilityGroupSchema).min(1).max(20)
});

export const mcpDiscoverySmokeResultSchema = z.object({
  id: z.literal("mcp-gateway"),
  status: integrationStatusSchema,
  code: mcpDiscoverySmokeCodeSchema,
  message: z.string().min(1).max(1000),
  targetSpecVersion: z.string().min(1).max(40),
  discoveryEnabled: z.boolean(),
  serverCount: z.number().int().min(0),
  toolCount: z.number().int().min(0),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema,
  durationMs: z.number().int().min(0)
});

export const mcpDiscoverySmokeCheckSchema = mcpDiscoverySmokeResultSchema.extend({
  checkId: idSchema,
  traceId: requestIdSchema,
  actorUserId: idSchema.nullable(),
  checkedAt: isoDateTimeSchema
});

const mcpToolPolicyReasonCodes = [
  "GATEWAY_DISABLED",
  "SERVER_NOT_VERIFIED",
  "TOOL_NOT_VERIFIED",
  "SCHEMA_HASH_INVALID",
  "GATEWAY_ALWAYS_ASK",
  "SCHEMA_HASH_NOT_ALLOWLISTED",
  "RISK_APPROVAL_REQUIRED",
  "TOOL_APPROVAL_REQUIRED",
  "SCHEMA_HASH_ALLOWLISTED"
] as const;

export const mcpToolPolicyReasonCodeSchema = z.enum(mcpToolPolicyReasonCodes);

export const mcpToolPolicyDecisionKindSchema = z.enum(["BLOCKED", "REQUIRES_APPROVAL", "ALLOWED"]);

export const mcpToolPolicyDecisionSchema = z.object({
  decision: mcpToolPolicyDecisionKindSchema,
  reasonCode: mcpToolPolicyReasonCodeSchema,
  approvalRequired: z.boolean(),
  canExecuteWithoutApproval: z.boolean()
});

export const mcpToolArgumentsSchema = z
  .record(z.string().min(1).max(120), z.unknown())
  .default({})
  .superRefine((args, ctx) => {
    if (Object.keys(args).length > 50) {
      ctx.addIssue({ code: "custom", message: "MCP tool arguments support at most 50 top-level keys." });
    }
    try {
      if (JSON.stringify(args).length > 8000) {
        ctx.addIssue({ code: "custom", message: "MCP tool arguments must fit within 8000 JSON characters." });
      }
    } catch {
      ctx.addIssue({ code: "custom", message: "MCP tool arguments must be JSON serializable." });
    }
  });

export const createMcpToolExecutionInputSchema = z.object({
  roomId: idSchema.nullable().optional(),
  paneId: idSchema.nullable().optional(),
  toolId: z.string().trim().min(1).max(220),
  arguments: mcpToolArgumentsSchema,
  approvalReason: z.string().trim().min(5).max(500).optional()
});

export const mcpToolExecutionStatusSchema = z.enum(["BLOCKED", "APPROVAL_REQUIRED", "EXECUTED", "FAILED"]);

export const mcpToolExecutionCodeSchema = z.enum([
  ...mcpToolPolicyReasonCodes,
  "TOOL_NOT_FOUND",
  "SERVER_NOT_FOUND",
  "SERVER_CONFIG_MISSING",
  "TRANSPORT_NOT_SUPPORTED",
  "EXECUTION_FAILED",
  "TOOL_EXECUTION_OK",
  "TOOL_RETURNED_ERROR"
]);

export const mcpToolExecutionResultSchema = z.object({
  id: z.literal("mcp-gateway"),
  executionId: idSchema,
  status: mcpToolExecutionStatusSchema,
  code: mcpToolExecutionCodeSchema,
  message: z.string().min(1).max(1000),
  toolId: z.string().min(1).max(220),
  serverId: z.string().min(1).max(160).nullable(),
  toolName: z.string().min(1).max(160).nullable(),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema,
  durationMs: z.number().int().min(0),
  policy: mcpToolPolicyDecisionSchema.nullable(),
  approved: z.boolean(),
  artifact: z.lazy(() => artifactSchema).nullable()
});

export const spaceAgentMcpExecuteActionSchema = z.object({
  type: z.literal("execute"),
  arguments: mcpToolArgumentsSchema
});

export const spaceAgentMcpActionRequestSchema = z.object({
  toolId: z.string().trim().min(1).max(220),
  action: spaceAgentMcpExecuteActionSchema
});

export const spaceAgentMcpActionEnvelopeSchema = z.object({
  version: z.literal(1),
  actions: z.array(spaceAgentMcpActionRequestSchema).min(1).max(3)
});

export const spaceAgentMcpActionBridgeRequestSchema = z.object({
  roomId: idSchema,
  agentPaneId: idSchema,
  agentSessionId: idSchema,
  selectedToolIds: z.array(z.string().trim().min(1).max(220)).max(50),
  actions: z.array(spaceAgentMcpActionRequestSchema).min(1).max(3)
});

export const spaceAgentMcpActionBridgeObservationSchema = z.object({
  executionId: idSchema,
  status: mcpToolExecutionStatusSchema,
  code: mcpToolExecutionCodeSchema,
  message: z.string().min(1).max(1000),
  toolId: z.string().min(1).max(220),
  serverId: z.string().min(1).max(160).nullable(),
  toolName: z.string().min(1).max(160).nullable(),
  approved: z.boolean(),
  policyDecision: mcpToolPolicyDecisionKindSchema.nullable(),
  policyReasonCode: mcpToolPolicyReasonCodeSchema.nullable(),
  artifactId: idSchema.nullable(),
  artifactKind: artifactKindSchema.nullable(),
  artifactMimeType: z.string().min(1).max(120).nullable(),
  artifactStorageUri: z.string().min(1).max(1000).nullable(),
  durationMs: z.number().int().min(0)
});

export const spaceAgentMcpActionBridgeResultSchema = z.object({
  request: spaceAgentMcpActionRequestSchema,
  status: mcpToolExecutionStatusSchema,
  statusReason: z.string().min(1).max(1000),
  observation: spaceAgentMcpActionBridgeObservationSchema.nullable()
});

export const spaceAgentMcpActionBridgeResponseSchema = z.object({
  id: z.literal("space-agent-mcp-action-bridge"),
  results: z.array(spaceAgentMcpActionBridgeResultSchema).min(1).max(3)
});

export const workflowRunSchema = z.object({
  workflowId: idSchema,
  runId: z.string().min(1).max(160).nullable(),
  type: z.enum(["AGENT_TURN", "TOOL_APPROVAL", "BROWSER_TASK", "SWARM_MISSION", "REVIEW_AND_SHIP", "MEMORY_CONSOLIDATION", "WORKSPACE_CLEANUP"]),
  taskQueue: z.string().min(1).max(160),
  status: workflowStatusSchema,
  roomId: idSchema.nullable(),
  paneId: idSchema.nullable(),
  traceId: requestIdSchema,
  startedAt: isoDateTimeSchema,
  closedAt: isoDateTimeSchema.nullable()
});

export const turnSchema = z.object({
  id: idSchema,
  roomId: idSchema,
  paneId: idSchema.nullable(),
  workflowId: idSchema.nullable(),
  providerId: z.string().max(120).nullable(),
  modelId: z.string().max(160).nullable(),
  status: turnStatusSchema,
  prompt: z.string().max(4000).nullable().default(null),
  promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  artifactIds: z.array(idSchema).max(8).default([]),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const turnRuntimeSchema = z.enum(["DUMMY_TEMPORAL", "CODEX_APP_SERVER"]);
export const imageArtifactMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);
export const userUploadArtifactSourceSchema = z.enum(["USER_UPLOAD", "CLIPBOARD", "DROP", "SCREEN_CAPTURE"]);
export const imageArtifactMaxBytes = 10 * 1024 * 1024;

export const artifactSchema = z.object({
  id: idSchema,
  roomId: idSchema.nullable(),
  paneId: idSchema.nullable(),
  turnId: idSchema.nullable(),
  workflowId: idSchema.nullable(),
  kind: artifactKindSchema,
  mimeType: z.string().min(1).max(120),
  storageUri: z.string().min(1).max(1000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().min(0),
  metadata: z.record(z.string(), z.unknown()).default({}),
  expiresAt: isoDateTimeSchema.nullable().default(null),
  pinnedAt: isoDateTimeSchema.nullable().default(null),
  deletedAt: isoDateTimeSchema.nullable().default(null),
  createdAt: isoDateTimeSchema
});

const roomMediaBrowserKinds = new Set<z.infer<typeof artifactKindSchema>>(["IMAGE", "SCREENSHOT", "VIDEO"]);

export function isRoomMediaArtifact(artifact: z.infer<typeof artifactSchema>): boolean {
  if (artifact.storageUri.startsWith("space-artifact://user-uploads/")) return true;
  if (artifact.storageUri.startsWith("space-artifact://cli-uploads/")) return true;
  return artifact.storageUri.startsWith("space-artifact://browser-evidence/") && roomMediaBrowserKinds.has(artifact.kind);
}

export const deleteRoomMediaResponseSchema = z
  .object({
    ok: z.boolean(),
    roomId: idSchema,
    matchedCount: z.number().int().min(0),
    deletedCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    failedArtifactIds: z.array(idSchema)
  })
  .superRefine((result, context) => {
    if (result.matchedCount !== result.deletedCount + result.failedCount) {
      context.addIssue({ code: "custom", message: "Matched media count must equal deleted plus failed counts." });
    }
    if (result.failedCount !== result.failedArtifactIds.length) {
      context.addIssue({ code: "custom", message: "Failed media count must equal the failed artifact ID count." });
    }
    if (result.ok !== (result.failedCount === 0)) {
      context.addIssue({ code: "custom", message: "Room media deletion is successful only when no artifacts failed." });
    }
  });

const artifactMetadataInputSchema = z
  .record(z.string().min(1).max(120), z.unknown())
  .default({})
  .superRefine((metadata, ctx) => {
    if (Object.keys(metadata).length > 50) {
      ctx.addIssue({ code: "custom", message: "Artifact metadata supports at most 50 top-level keys." });
    }
    try {
      if (JSON.stringify(metadata).length > 8000) {
        ctx.addIssue({ code: "custom", message: "Artifact metadata must fit within 8000 JSON characters." });
      }
    } catch {
      ctx.addIssue({ code: "custom", message: "Artifact metadata must be JSON serializable." });
    }
  });

export const createArtifactInputSchema = z.object({
  roomId: idSchema.nullable().optional(),
  paneId: idSchema.nullable().optional(),
  turnId: idSchema.nullable().optional(),
  workflowId: idSchema.nullable().optional(),
  kind: artifactKindSchema,
  mimeType: z.string().trim().min(1).max(120),
  storageUri: z.string().trim().min(1).max(1000),
  sha256: z.string().trim().regex(/^[a-f0-9]{64}$/),
  byteSize: z.coerce.number().int().min(0).max(10_000_000_000),
  metadata: artifactMetadataInputSchema,
  expiresAt: isoDateTimeSchema.nullable().optional(),
  pinnedAt: isoDateTimeSchema.nullable().optional(),
  deletedAt: isoDateTimeSchema.nullable().optional()
});

export const listArtifactsQuerySchema = paginationRequestSchema.extend({
  roomId: idSchema.optional(),
  paneId: idSchema.optional(),
  workflowId: idSchema.optional(),
  kind: artifactKindSchema.optional()
});

export const updateArtifactRetentionInputSchema = z
  .object({
    expiresAt: isoDateTimeSchema.nullable().optional(),
    pinnedAt: isoDateTimeSchema.nullable().optional(),
    deletedAt: isoDateTimeSchema.nullable().optional()
  })
  .refine((input) => Object.keys(input).length > 0, "Artifact retention update must include at least one field.");

export const dummyTurnInputSchema = z.object({
  roomId: idSchema,
  paneId: idSchema,
  prompt: z.string().trim().min(1).max(8000),
  artifactIds: z.array(idSchema).max(turnArtifactMaxCount).default([]),
  providerId: z.string().trim().max(120).nullable().optional(),
  modelId: z.string().trim().min(1).max(160).nullable().optional(),
  reasoningEffort: cliReasoningEffortSchema.nullable().optional(),
  agentSessionId: idSchema.optional(),
  agentRunId: idSchema.optional(),
  roomAgentMissionId: idSchema.optional(),
  agentUserMessageId: idSchema.optional(),
  agentAssistantMessageId: idSchema.optional(),
  agentThreadId: z.string().trim().min(1).max(200).nullable().optional(),
  operatorUserId: idSchema.optional(),
  selectedToolIds: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
  permissionMode: permissionModeSchema.nullable().default(null),
  collaborationMode: collaborationModeSchema.default("default"),
  traceId: requestIdSchema
});

export const roomAgentSupervisorQueueItemSchema = z.object({
  missionId: idSchema,
  turn: dummyTurnInputSchema.extend({
    modelId: z.literal("gpt-5.6-sol"),
    reasoningEffort: z.literal("high")
  })
});

export const roomAgentSupervisorInputSchema = z
  .object({
    roomId: idSchema,
    pending: z.array(roomAgentSupervisorQueueItemSchema).max(100).default([]),
    processedCount: z.number().int().min(0).default(0)
  })
  .superRefine((input, context) => {
    input.pending.forEach((item, index) => {
      if (item.turn.roomId !== input.roomId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pending", index, "turn", "roomId"],
          message: "Queued room-agent turns must belong to the supervisor room."
        });
      }
    });
  });

export const roomAgentSupervisorStopSignalSchema = z.object({
  missionId: idSchema.nullable().default(null),
  reason: z.string().trim().min(1).max(500)
});

export const createTurnInputSchema = z.object({
  roomId: idSchema,
  paneId: idSchema,
  prompt: z.string().trim().min(1).max(4000),
  artifactIds: z.array(idSchema).max(turnArtifactMaxCount).default([]),
  runtime: turnRuntimeSchema.default("DUMMY_TEMPORAL")
});

export const turnStartResultSchema = z.object({
  workflowId: idSchema,
  runId: z.string().min(1).max(160).nullable(),
  roomId: idSchema,
  paneId: idSchema,
  traceId: requestIdSchema,
  status: z.literal("QUEUED"),
  runtime: turnRuntimeSchema.default("DUMMY_TEMPORAL"),
  artifactIds: z.array(idSchema).max(turnArtifactMaxCount).default([]),
  turnId: idSchema.optional()
});

export const listTurnsQuerySchema = paginationRequestSchema.extend({
  roomId: idSchema.optional()
});

export const dummyTurnResultSchema = z.object({
  workflowId: idSchema,
  roomId: idSchema,
  paneId: idSchema,
  traceId: requestIdSchema,
  status: z.literal("COMPLETED"),
  message: z.string().min(1).max(1000)
});

export const roomAgentTurnOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("VERIFIED"),
    executedActionCount: z.number().int().min(1).max(100),
    statusReason: z.string().min(1).max(1000)
  }),
  z.object({
    status: z.literal("UNVERIFIED"),
    executedActionCount: z.number().int().min(0).max(100),
    statusReason: z.string().min(1).max(1000)
  })
]);

export const turnWorkflowResultSchema = z.object({
  workflowId: idSchema,
  roomId: idSchema,
  paneId: idSchema,
  traceId: requestIdSchema,
  status: z.enum(["COMPLETED", "FAILED", "CANCELLED"]),
  message: z.string().min(1).max(1000),
  roomAgentOutcome: roomAgentTurnOutcomeSchema.optional()
});

export const memoryScopeSchema = z.enum(["ROOM", "PROJECT", "SYSTEM"]);
export const memorySearchModeSchema = z.enum(["keyword", "semantic"]);
export const memoryTagSchema = z.string()
  .trim()
  .min(1)
  .max(48)
  .regex(
    /^[\p{L}\p{N}](?:[\p{L}\p{N}._-]| [\p{L}\p{N}._-])*$/u,
    "Memory tags may contain letters, numbers, single spaces, dots, underscores, and hyphens."
  );
export const memoryTagsSchema = z.array(memoryTagSchema)
  .max(12)
  .superRefine((tags, ctx) => {
    const seen = new Set<string>();
    tags.forEach((tag, index) => {
      const normalized = tag.toLowerCase();
      if (seen.has(normalized)) {
        ctx.addIssue({ code: "custom", path: [index], message: "Memory tags must be unique regardless of case." });
      }
      seen.add(normalized);
    });
  });

const memorySearchLaneSchema = z.object({
  status: integrationStatusSchema,
  statusReason: z.string().min(1).max(500),
  checkedAt: isoDateTimeSchema.nullable()
});

export const memorySearchStatusSchema = z.object({
  mode: memorySearchModeSchema,
  keyword: memorySearchLaneSchema,
  semantic: memorySearchLaneSchema
});

export const memoryEmbeddingSmokeCodeSchema = z.enum([
  "EMBEDDING_SMOKE_DISABLED",
  "RUNTIME_STORE_NOT_POSTGRES",
  "PGVECTOR_UNAVAILABLE",
  "EMBEDDING_PROVIDER_MISSING",
  "EMBEDDING_PROVIDER_UNVERIFIED",
  "EMBEDDING_PROVIDER_UNSUPPORTED",
  "EMBEDDING_KEY_NAME_NOT_DEDICATED",
  "EMBEDDING_CREDENTIAL_MISSING",
  "EMBEDDING_KEY_FILE_UNREADABLE",
  "EMBEDDING_PROVIDER_CONFIG_INVALID",
  "EMBEDDING_PROVIDER_SMOKE_FAILED",
  "EMBEDDING_PROVIDER_RESPONSE_INVALID",
  "EMBEDDING_DIMENSIONS_MISMATCH",
  "EMBEDDING_SMOKE_OK"
]);

export const memoryEmbeddingSmokeResultSchema = z.object({
  id: z.literal("memory-embedding-smoke"),
  status: integrationStatusSchema,
  code: memoryEmbeddingSmokeCodeSchema,
  message: z.string().min(1).max(1000),
  smokeEnabled: z.boolean(),
  provider: z.string().min(1).max(160).nullable(),
  model: z.string().min(1).max(160).nullable(),
  dimensions: z.number().int().positive().max(4096),
  pgvectorReady: z.boolean(),
  embeddingProviderReady: z.boolean(),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema,
  durationMs: z.number().int().min(0)
});

export const memoryEmbeddingSmokeCheckSchema = memoryEmbeddingSmokeResultSchema.extend({
  checkId: idSchema,
  traceId: requestIdSchema,
  actorUserId: idSchema.nullable(),
  checkedAt: isoDateTimeSchema
});

export const memoryVectorReadinessCodeSchema = z.enum([
  "VECTOR_STORE_NOT_POSTGRES",
  "PGVECTOR_EXTENSION_MISSING",
  "MEMORY_EMBEDDING_COLUMN_MISSING",
  "MEMORY_EMBEDDING_DIMENSIONS_MISMATCH",
  "MEMORY_VECTOR_INDEX_MISSING",
  "MEMORY_VECTOR_READY"
]);

export const memoryVectorReadinessSchema = z.object({
  id: z.literal("memory-vector-readiness"),
  status: integrationStatusSchema,
  code: memoryVectorReadinessCodeSchema,
  message: z.string().min(1).max(1000),
  runtimeStore: z.enum(["memory", "postgres"]),
  extensionInstalled: z.boolean(),
  extensionVersion: z.string().min(1).max(80).nullable(),
  embeddingColumnReady: z.boolean(),
  embeddingDimensions: z.number().int().positive().max(4096).nullable(),
  expectedDimensions: z.number().int().positive().max(4096),
  vectorIndexReady: z.boolean(),
  checkedAt: isoDateTimeSchema
});

export const memoryEntrySchema = z.object({
  id: idSchema,
  scope: memoryScopeSchema,
  roomId: idSchema.nullable(),
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(10000),
  provenance: z.string().min(1).max(500),
  createdAt: isoDateTimeSchema
});

export const memoryGraphNodeTypeSchema = z.enum(["SOURCE", "SECTION", "MEMORY", "ROOM", "PROVENANCE", "TOPIC", "CACHE_RECORD"]);
export const memoryGraphEdgeTypeSchema = z.enum([
  "CONTAINS",
  "BELONGS_TO_ROOM",
  "DERIVED_FROM",
  "TAGGED_WITH",
  "SEMANTICALLY_RELATED",
  "CACHED_AS",
  "DUPLICATES",
  "SUPERSEDES",
  "CONFLICTS_WITH"
]);
export const memoryLifecycleStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);
export const memoryIssueTypeSchema = z.enum([
  "MISSING_TIMESTAMP",
  "INVALID_MARKER",
  "EXACT_DUPLICATE",
  "NEAR_DUPLICATE",
  "CONFLICT",
  "STALE",
  "CACHE_MISMATCH"
]);
export const memoryIssueSeveritySchema = z.enum(["INFO", "WARN", "ERROR"]);
export const memoryIssueStatusSchema = z.enum(["OPEN", "IGNORED", "RESOLVED"]);
export const memoryGraphTopicOriginSchema = z.enum(["EXPLICIT_TAG", "DERIVED_TFIDF"]);
export const memoryGraphEdgeOriginSchema = z.enum([
  "EXPLICIT_TAG",
  "DERIVED_TFIDF",
  "DETERMINISTIC_TFIDF",
  "EMBEDDING"
]);
export const memoryGraphTopicAssignmentSchema = z.object({
  label: memoryTagSchema,
  origin: memoryGraphTopicOriginSchema,
  confidence: z.number().min(0).max(1)
}).strict();

export const memoryGraphRecordSchema = z
  .object({
    id: idSchema,
    sourcePath: z.string().min(1).max(1000),
    sectionId: idSchema,
    title: z.string().min(1).max(500),
    body: z.string().min(1).max(100000),
    createdAt: isoDateTimeSchema,
    scope: memoryScopeSchema,
    roomId: idSchema.nullable(),
    provenance: z.string().min(1).max(1000),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    lifecycleStatus: memoryLifecycleStatusSchema,
    tags: memoryTagsSchema.optional(),
    topics: z.array(memoryGraphTopicAssignmentSchema).max(24).optional(),
    sourceStart: z.number().int().min(0).optional(),
    sourceEnd: z.number().int().min(1).optional(),
    markerId: idSchema.nullable().optional()
  })
  .superRefine((record, ctx) => {
    if ((record.sourceStart === undefined) !== (record.sourceEnd === undefined)) {
      ctx.addIssue({ code: "custom", path: ["sourceStart"], message: "Source spans require both offsets." });
    }
    if (record.sourceStart !== undefined && record.sourceEnd !== undefined && record.sourceEnd <= record.sourceStart) {
      ctx.addIssue({ code: "custom", path: ["sourceEnd"], message: "Source spans must be non-empty and ordered." });
    }
  });

const memoryGraphPositionSchema = z
  .object({
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000)
  })
  .strict();

export const memoryGraphNodePositionSchema = z
  .object({
    clustered: memoryGraphPositionSchema,
    relations: memoryGraphPositionSchema
  })
  .strict();

export const memoryGraphNodeSchema = z.object({
  id: idSchema,
  type: memoryGraphNodeTypeSchema,
  label: z.string().min(1).max(1000),
  sourcePath: z.string().min(1).max(1000).nullable(),
  recordId: idSchema.nullable(),
  clusterId: idSchema.nullable().optional(),
  cacheRecordId: idSchema.nullable().optional(),
  position: memoryGraphNodePositionSchema.optional()
});

export const memoryGraphEdgeSchema = z.object({
  id: idSchema,
  type: memoryGraphEdgeTypeSchema,
  source: idSchema,
  target: idSchema,
  origin: memoryGraphEdgeOriginSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.string().min(1).max(500).optional()
}).strict().superRefine((edge, ctx) => {
  if (edge.type !== "TAGGED_WITH" && edge.type !== "SEMANTICALLY_RELATED") return;
  if (!edge.origin) ctx.addIssue({ code: "custom", path: ["origin"], message: `${edge.type} edges require an origin.` });
  if (edge.confidence === undefined) {
    ctx.addIssue({ code: "custom", path: ["confidence"], message: `${edge.type} edges require confidence.` });
  }
  if (!edge.evidence) ctx.addIssue({ code: "custom", path: ["evidence"], message: `${edge.type} edges require evidence.` });
  if (edge.type === "TAGGED_WITH" && edge.origin && !["EXPLICIT_TAG", "DERIVED_TFIDF"].includes(edge.origin)) {
    ctx.addIssue({ code: "custom", path: ["origin"], message: "TAGGED_WITH origin must describe a topic assignment." });
  }
  if (edge.type === "SEMANTICALLY_RELATED" && edge.origin && !["DETERMINISTIC_TFIDF", "EMBEDDING"].includes(edge.origin)) {
    ctx.addIssue({ code: "custom", path: ["origin"], message: "SEMANTICALLY_RELATED origin must describe a similarity method." });
  }
});

export const memoryGraphIssueSchema = z.object({
  id: idSchema,
  type: memoryIssueTypeSchema,
  severity: memoryIssueSeveritySchema,
  status: memoryIssueStatusSchema,
  confidence: z.number().min(0).max(1),
  recordId: idSchema.nullable(),
  sourcePath: z.string().min(1).max(1000),
  evidence: z.string().min(1).max(4000),
  statusReason: z.string().min(1).max(2000).nullable().optional(),
  stateVersion: z.number().int().min(1).nullable().optional(),
  stateUpdatedAt: isoDateTimeSchema.nullable().optional()
});

export const memoryGraphSummarySchema = z.object({
  sourceCount: z.number().int().min(0).max(24),
  recordCount: z.number().int().min(0),
  nodeCount: z.number().int().min(0),
  edgeCount: z.number().int().min(0),
  issueCount: z.number().int().min(0)
});

export const memoryGraphSnapshotSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    layoutVersion: z.union([z.literal(1), z.literal(2)]).optional(),
    taxonomyVersion: z.union([z.literal(1), z.literal(2)]).optional(),
    revisionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    generatedAt: isoDateTimeSchema,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    records: z.array(memoryGraphRecordSchema).max(10_000),
    nodes: z.array(memoryGraphNodeSchema).max(50_000),
    edges: z.array(memoryGraphEdgeSchema).max(200_000),
    issues: z.array(memoryGraphIssueSchema).max(20_000),
    summary: memoryGraphSummarySchema
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const expectedCounts = {
      recordCount: snapshot.records.length,
      nodeCount: snapshot.nodes.length,
      edgeCount: snapshot.edges.length,
      issueCount: snapshot.issues.length
    };
    for (const [field, count] of Object.entries(expectedCounts)) {
      if (snapshot.summary[field as keyof typeof expectedCounts] !== count) {
        ctx.addIssue({ code: "custom", path: ["summary", field], message: `${field} does not match snapshot contents.` });
      }
    }
    const recordIds = new Set(snapshot.records.map((record) => record.id));
    const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
    const issueIds = new Set(snapshot.issues.map((issue) => issue.id));
    if (recordIds.size !== snapshot.records.length) {
      ctx.addIssue({ code: "custom", path: ["records"], message: "Snapshot record IDs must be unique." });
    }
    if (nodeIds.size !== snapshot.nodes.length) {
      ctx.addIssue({ code: "custom", path: ["nodes"], message: "Snapshot node IDs must be unique." });
    }
    if (issueIds.size !== snapshot.issues.length) {
      ctx.addIssue({ code: "custom", path: ["issues"], message: "Snapshot issue IDs must be unique." });
    }
    snapshot.nodes.forEach((node, index) => {
      if (node.recordId && !recordIds.has(node.recordId)) {
        ctx.addIssue({ code: "custom", path: ["nodes", index, "recordId"], message: "Node record reference is missing." });
      }
      if (snapshot.layoutVersion !== undefined && !node.position) {
        ctx.addIssue({ code: "custom", path: ["nodes", index, "position"], message: "Versioned layouts require every node position." });
      }
    });
    if (snapshot.version === 2) {
      if (snapshot.layoutVersion !== 2) {
        ctx.addIssue({ code: "custom", path: ["layoutVersion"], message: "Version-2 snapshots require layout version 2." });
      }
      if (snapshot.taxonomyVersion === undefined) {
        ctx.addIssue({ code: "custom", path: ["taxonomyVersion"], message: "Version-2 snapshots require a taxonomy version." });
      }
      if (!snapshot.revisionHash) {
        ctx.addIssue({ code: "custom", path: ["revisionHash"], message: "Version-2 snapshots require a revision hash." });
      }
    }
    snapshot.edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        ctx.addIssue({ code: "custom", path: ["edges", index], message: "Edge endpoints must reference snapshot nodes." });
      }
    });
    snapshot.issues.forEach((issue, index) => {
      if (issue.recordId && !recordIds.has(issue.recordId)) {
        ctx.addIssue({ code: "custom", path: ["issues", index, "recordId"], message: "Issue record reference is missing." });
      }
    });
    const boundedCharacterCount = snapshot.records.reduce((total, record) => total + record.body.length, 0) +
      snapshot.nodes.reduce((total, node) => total + node.label.length, 0) +
      snapshot.issues.reduce((total, issue) => total + issue.evidence.length, 0);
    if (boundedCharacterCount > 16_000_000) {
      ctx.addIssue({ code: "custom", path: [], message: "Snapshot textual content exceeds its aggregate bound." });
    }
  });

export const memoryGraphFiltersSchema = z.object({
  q: z.string().max(200).nullable(),
  nodeType: memoryGraphNodeTypeSchema.nullable(),
  scope: memoryScopeSchema.nullable().optional(),
  roomId: idSchema.nullable(),
  sourcePath: z.string().max(1000).nullable(),
  lifecycleStatus: memoryLifecycleStatusSchema.nullable(),
  relationMode: z.enum(["CLUSTERED", "RELATIONS"]).optional()
});

export const memoryGraphPayloadSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  generatedAt: isoDateTimeSchema,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  revisionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  isStale: z.boolean(),
  summary: memoryGraphSummarySchema,
  nodes: z.array(memoryGraphNodeSchema).max(500),
  edges: z.array(memoryGraphEdgeSchema).max(2000),
  layoutVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  taxonomyVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  filters: memoryGraphFiltersSchema
});

export const memoryGraphOverviewPayloadSchema = memoryGraphPayloadSchema
  .omit({ nodes: true, edges: true })
  .extend({
    nodes: z.array(memoryGraphNodeSchema).max(2000),
    edges: z.array(memoryGraphEdgeSchema).max(6000),
    totalMatchingNodes: z.number().int().min(0),
    totalMatchingEdges: z.number().int().min(0),
    truncated: z.boolean()
  });

export const memoryGraphNodeDetailSchema = z.object({
  node: memoryGraphNodeSchema,
  record: memoryGraphRecordSchema.nullable(),
  relatedNodes: z.array(memoryGraphNodeSchema).max(500),
  relatedEdges: z.array(memoryGraphEdgeSchema).max(1000).default([]),
  issues: z.array(memoryGraphIssueSchema).max(500)
});

export const listMemoryGraphQuerySchema = paginationRequestSchema.extend({
  sortBy: z.enum(["label", "type"]).default("label"),
  q: z.string().trim().min(1).max(200).optional(),
  nodeType: memoryGraphNodeTypeSchema.optional(),
  scope: memoryScopeSchema.optional(),
  roomId: idSchema.optional(),
  sourcePath: z.string().trim().min(1).max(1000).optional(),
  lifecycleStatus: memoryLifecycleStatusSchema.optional(),
  relationMode: z.enum(["CLUSTERED", "RELATIONS"]).default("RELATIONS")
});

export const listMemoryGraphOverviewQuerySchema = listMemoryGraphQuerySchema.omit({
  page: true,
  pageSize: true,
  sortBy: true,
  sortOrder: true
});

export const listMemoryIssuesQuerySchema = paginationRequestSchema.extend({
  sortBy: z.enum(["severity", "type", "status"]).default("severity"),
  type: memoryIssueTypeSchema.optional(),
  severity: memoryIssueSeveritySchema.optional(),
  status: memoryIssueStatusSchema.optional(),
  recordId: idSchema.optional()
});

export const patchMemoryIssueInputSchema = z
  .object({
    status: memoryIssueStatusSchema,
    reason: z.string().trim().min(1).max(2000).nullable().default(null),
    expectedVersion: z.number().int().min(1).optional()
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.status === "IGNORED" && input.reason === null) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Ignored issues require an operator reason." });
    }
  });

const memoryStateHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const memoryStateMetadataSchema = z
  .record(z.string().min(1).max(200), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 65_536, "Memory state metadata exceeds its aggregate bound.");

export const memoryCacheLinkSourceSchema = z.enum(["CANONICAL_SAVE", "EXACT_BACKFILL", "REPAIR"]);
export const memoryCacheLinkSchema = z
  .object({
    memoryRecordId: idSchema,
    canonicalMemoryId: idSchema,
    linkSource: memoryCacheLinkSourceSchema,
    linkedAt: isoDateTimeSchema
  })
  .strict();
export const linkMemoryCacheInputSchema = memoryCacheLinkSchema.omit({ linkedAt: true }).strict();
export const listMemoryCacheLinksQuerySchema = z
  .object({
    memoryRecordIds: z.array(idSchema).min(1).max(500).optional(),
    limit: z.number().int().min(1).max(500).default(500)
  })
  .strict();

export const memoryIssueStateSchema = z
  .object({
    issueId: idSchema,
    issueType: memoryIssueTypeSchema,
    recordId: idSchema.nullable(),
    sourceHash: memoryStateHashSchema,
    status: memoryIssueStatusSchema,
    reason: z.string().min(1).max(2000).nullable(),
    actorUserId: idSchema,
    version: z.number().int().min(1),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();
export const upsertMemoryIssueStateInputSchema = z
  .object({
    issueId: idSchema,
    issueType: memoryIssueTypeSchema,
    recordId: idSchema.nullable().default(null),
    sourceHash: memoryStateHashSchema,
    status: memoryIssueStatusSchema,
    reason: z.string().trim().min(1).max(2000).nullable().default(null),
    actorUserId: idSchema,
    expectedVersion: z.number().int().min(1).optional()
  })
  .strict();
export const listMemoryIssueStatesQuerySchema = paginationRequestSchema.extend({
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
  issueIds: z.array(idSchema).min(1).max(500).optional(),
  status: memoryIssueStatusSchema.optional(),
  recordId: idSchema.optional()
});

export const memoryConsolidationModeSchema = z.enum(["AUDIT", "REPAIR"]);
export const memoryConsolidationTriggerSchema = z.enum(["OPERATOR", "SCHEDULED"]);
export const memoryConsolidationStatusSchema = z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]);
export const memoryConsolidationFindingStatusSchema = z.enum(["OPEN", "APPLIED", "SKIPPED"]);
export const memoryConsolidationOperationKindSchema = z.enum([
  "LINK_CACHE",
  "NORMALIZE_MARKER",
  "ARCHIVE_EXACT_DUPLICATE",
  "ARCHIVE_SUPERSEDED",
  "REPORT_ISSUE"
]);
export const memoryConsolidationOperationStatusSchema = z.enum(["PROPOSED", "APPLYING", "APPLIED", "SKIPPED", "FAILED"]);
export const createMemoryConsolidationInputSchema = z
  .object({ mode: memoryConsolidationModeSchema })
  .strict();

export const memoryConsolidationRunSchema = z
  .object({
    id: idSchema,
    mode: memoryConsolidationModeSchema,
    triggerKind: memoryConsolidationTriggerSchema,
    status: memoryConsolidationStatusSchema,
    workflowId: idSchema,
    dedupeKey: z.string().min(8).max(240),
    sourceHash: memoryStateHashSchema.nullable(),
    actorUserId: idSchema.nullable(),
    progressCompleted: z.number().int().min(0),
    progressTotal: z.number().int().min(0),
    findingCount: z.number().int().min(0),
    appliedOperationCount: z.number().int().min(0),
    skippedOperationCount: z.number().int().min(0),
    failedOperationCount: z.number().int().min(0),
    metrics: memoryStateMetadataSchema,
    modelId: z.string().min(1).max(240).nullable(),
    aiVerified: z.boolean(),
    aiEvidence: memoryStateMetadataSchema,
    statusReason: z.string().min(1).max(2000).nullable(),
    createdAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    completedAt: isoDateTimeSchema.nullable(),
    updatedAt: isoDateTimeSchema
  })
  .strict()
  .superRefine((run, ctx) => {
    if (run.progressCompleted > run.progressTotal) {
      ctx.addIssue({ code: "custom", path: ["progressCompleted"], message: "Completed progress cannot exceed total progress." });
    }
    if (run.triggerKind === "OPERATOR" && !run.actorUserId) {
      ctx.addIssue({ code: "custom", path: ["actorUserId"], message: "Operator runs require an actor." });
    }
    if (run.status === "RUNNING" && !run.startedAt) {
      ctx.addIssue({ code: "custom", path: ["startedAt"], message: "Running consolidations require a start timestamp." });
    }
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(run.status) && !run.completedAt) {
      ctx.addIssue({ code: "custom", path: ["completedAt"], message: "Terminal consolidations require a completion timestamp." });
    }
    if (run.status === "FAILED" && !run.statusReason) {
      ctx.addIssue({ code: "custom", path: ["statusReason"], message: "Failed consolidations require a reason." });
    }
  });

export const createMemoryConsolidationRunInputSchema = z
  .object({
    mode: memoryConsolidationModeSchema,
    triggerKind: memoryConsolidationTriggerSchema,
    workflowId: idSchema,
    dedupeKey: z.string().trim().min(8).max(240),
    sourceHash: memoryStateHashSchema.nullable().default(null),
    actorUserId: idSchema.nullable().default(null)
  })
  .strict()
  .superRefine((run, ctx) => {
    if (run.triggerKind === "OPERATOR" && !run.actorUserId) {
      ctx.addIssue({ code: "custom", path: ["actorUserId"], message: "Operator runs require an actor." });
    }
  });

export const updateMemoryConsolidationRunInputSchema = z
  .object({
    status: memoryConsolidationStatusSchema,
    sourceHash: memoryStateHashSchema.nullable().optional(),
    progressCompleted: z.number().int().min(0).optional(),
    progressTotal: z.number().int().min(0).optional(),
    findingCount: z.number().int().min(0).optional(),
    appliedOperationCount: z.number().int().min(0).optional(),
    skippedOperationCount: z.number().int().min(0).optional(),
    failedOperationCount: z.number().int().min(0).optional(),
    metrics: memoryStateMetadataSchema.optional(),
    modelId: z.string().min(1).max(240).nullable().optional(),
    aiVerified: z.boolean().optional(),
    aiEvidence: memoryStateMetadataSchema.optional(),
    statusReason: z.string().trim().min(1).max(2000).nullable().optional()
  })
  .strict();

export const memoryConsolidationFindingSchema = z
  .object({
    id: idSchema,
    runId: idSchema,
    issueId: idSchema.nullable(),
    findingType: memoryIssueTypeSchema,
    severity: memoryIssueSeveritySchema,
    status: memoryConsolidationFindingStatusSchema,
    confidence: z.number().min(0).max(1),
    recordIds: z.array(idSchema).max(100),
    sourcePath: z.string().min(1).max(1000),
    evidence: z.string().min(1).max(4000),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();
export const createMemoryConsolidationFindingInputSchema = memoryConsolidationFindingSchema
  .omit({ id: true, status: true, createdAt: true, updatedAt: true })
  .extend({ issueId: idSchema.nullable().default(null) })
  .strict();
export const updateMemoryConsolidationFindingInputSchema = z.object({
  status: memoryConsolidationFindingStatusSchema
}).strict();

export const memoryConsolidationOperationSchema = z
  .object({
    id: idSchema,
    runId: idSchema,
    findingId: idSchema.nullable(),
    operationKind: memoryConsolidationOperationKindSchema,
    status: memoryConsolidationOperationStatusSchema,
    recordIds: z.array(idSchema).min(1).max(100),
    changeSetId: idSchema.nullable(),
    reason: z.string().min(1).max(2000),
    statusReason: z.string().min(1).max(2000).nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    appliedAt: isoDateTimeSchema.nullable()
  })
  .strict()
  .superRefine((operation, ctx) => {
    if (operation.status === "APPLIED" && !operation.appliedAt) {
      ctx.addIssue({ code: "custom", path: ["appliedAt"], message: "Applied operations require an applied timestamp." });
    }
    if (operation.status === "FAILED" && !operation.statusReason) {
      ctx.addIssue({ code: "custom", path: ["statusReason"], message: "Failed operations require a reason." });
    }
  });
export const createMemoryConsolidationOperationInputSchema = z
  .object({
    runId: idSchema,
    findingId: idSchema.nullable().default(null),
    operationKind: memoryConsolidationOperationKindSchema,
    recordIds: z.array(idSchema).min(1).max(100),
    reason: z.string().trim().min(1).max(2000)
  })
  .strict();
export const updateMemoryConsolidationOperationInputSchema = z
  .object({
    status: memoryConsolidationOperationStatusSchema,
    changeSetId: idSchema.nullable().optional(),
    statusReason: z.string().trim().min(1).max(2000).nullable().optional()
  })
  .strict();

export const memoryConsolidationScheduleSchema = z
  .object({
    status: z.enum(["SCHEDULED", "ALREADY_SCHEDULED"]),
    workflowId: idSchema,
    runId: idSchema.nullable()
  })
  .strict();
export const memoryConsolidationCommandResponseSchema = z
  .object({
    run: memoryConsolidationRunSchema,
    schedule: memoryConsolidationScheduleSchema,
    maintenanceEnabled: z.boolean(),
    mutationsEnabled: z.boolean()
  })
  .strict();
export const memoryConsolidationDetailSchema = z
  .object({
    run: memoryConsolidationRunSchema,
    findings: z.array(memoryConsolidationFindingSchema).max(500),
    operations: z.array(memoryConsolidationOperationSchema).max(500),
    maintenanceEnabled: z.boolean(),
    mutationsEnabled: z.boolean()
  })
  .strict();
export const memoryConsolidationWorkflowInputSchema = z
  .object({
    runId: idSchema,
    traceId: idSchema
  })
  .strict();

export const memoryAiAuditSuggestionSchema = z
  .object({
    issueId: idSchema,
    operationKind: memoryConsolidationOperationKindSchema,
    confidence: z.number().min(0).max(1),
    rationale: z.string().trim().min(1).max(1000)
  })
  .strict();
export const memoryAiAuditResponseSchema = z
  .object({
    suggestions: z.array(memoryAiAuditSuggestionSchema).max(100)
  })
  .strict();
export const memoryAiAuditResultSchema = z
  .object({
    status: z.enum(["DISABLED", "VERIFIED", "DEGRADED"]),
    verified: z.boolean(),
    modelId: z.string().trim().min(1).max(240).nullable(),
    suggestionCount: z.number().int().min(0).max(100),
    downgradedCount: z.number().int().min(0).max(100),
    evidence: memoryStateMetadataSchema
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status === "VERIFIED" && (!result.verified || !result.modelId)) {
      ctx.addIssue({ code: "custom", path: ["verified"], message: "Verified AI audit results require a model." });
    }
    if (result.status !== "VERIFIED" && result.verified) {
      ctx.addIssue({ code: "custom", path: ["verified"], message: "Only VERIFIED AI audit results may set verified=true." });
    }
  });

export const memoryCommandIdempotencySchema = z
  .object({
    commandScope: z.string().min(3).max(120),
    actorKey: z.string().min(3).max(240),
    idempotencyKeyHash: memoryStateHashSchema,
    requestHash: memoryStateHashSchema,
    resourceType: z.string().min(3).max(120),
    resourceId: idSchema,
    workflowId: idSchema.nullable(),
    createdAt: isoDateTimeSchema
  })
  .strict();
export const memoryCommandIdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const claimMemoryCommandInputSchema = memoryCommandIdempotencySchema.omit({ createdAt: true }).strict();
export const memoryCommandClaimSchema = z.object({
  record: memoryCommandIdempotencySchema,
  created: z.boolean()
}).strict();

export const memoryChangeKindSchema = z.enum(["EDIT", "MERGE", "ARCHIVE", "ROLLBACK"]);
export const memoryChangeStatusSchema = z.enum([
  "PROPOSED",
  "APPROVED",
  "APPLYING",
  "APPLIED",
  "FAILED",
  "ROLLED_BACK",
  "REJECTED"
]);
const memoryChangeHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const memoryChangeSnapshotSchema = z.string().max(2_000_000);

const memoryNodeChangeSetBaseShape = {
  expectedContentHash: memoryChangeHashSchema,
  reason: z.string().trim().min(1).max(2000)
};
export const createMemoryNodeChangeSetInputSchema = z.discriminatedUnion("kind", [
  z.object({
    ...memoryNodeChangeSetBaseShape,
    kind: z.literal("EDIT"),
    body: z.string().min(1).max(100_000).refine((value) => !value.includes("\0"), "Memory body cannot contain null bytes.")
  }).strict(),
  z.object({
    ...memoryNodeChangeSetBaseShape,
    kind: z.literal("ARCHIVE")
  }).strict(),
  z.object({
    ...memoryNodeChangeSetBaseShape,
    kind: z.literal("MERGE"),
    targetRecordId: idSchema
  }).strict()
]);

const memoryChangeSetSummaryShape = {
  id: idSchema,
  kind: memoryChangeKindSchema,
  status: memoryChangeStatusSchema,
  sourcePath: z.string().min(1).max(1000),
  recordIds: z.array(idSchema).max(500),
  resolvesIssueIds: z.array(idSchema).max(500),
  expectedSourceHash: memoryChangeHashSchema,
  resultingSourceHash: memoryChangeHashSchema.nullable(),
  beforeContentHash: memoryChangeHashSchema,
  afterContentHash: memoryChangeHashSchema,
  reason: z.string().min(1).max(2000),
  statusReason: z.string().max(2000).nullable(),
  actorUserId: idSchema,
  traceId: idSchema,
  rollbackOfChangeSetId: idSchema.nullable(),
  rolledBackByChangeSetId: idSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  appliedAt: isoDateTimeSchema.nullable(),
  failedAt: isoDateTimeSchema.nullable(),
  rolledBackAt: isoDateTimeSchema.nullable()
};

function validateMemoryChangeSetState(
  changeSet: z.infer<z.ZodObject<typeof memoryChangeSetSummaryShape>>,
  ctx: z.RefinementCtx
): void {
  if (changeSet.kind === "ROLLBACK" && !changeSet.rollbackOfChangeSetId) {
    ctx.addIssue({ code: "custom", path: ["rollbackOfChangeSetId"], message: "Rollback change sets require a target." });
  }
  if (changeSet.kind !== "ROLLBACK" && changeSet.rollbackOfChangeSetId) {
    ctx.addIssue({ code: "custom", path: ["rollbackOfChangeSetId"], message: "Only rollback change sets can target another change set." });
  }
  if (["APPLIED", "ROLLED_BACK"].includes(changeSet.status) && (!changeSet.resultingSourceHash || !changeSet.appliedAt)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Applied change sets require their resulting source hash and applied timestamp." });
  }
  if (changeSet.status === "FAILED" && (!changeSet.statusReason || !changeSet.failedAt)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Failed change sets require a reason and failed timestamp." });
  }
  if (changeSet.status === "ROLLED_BACK" && (!changeSet.rolledBackByChangeSetId || !changeSet.rolledBackAt)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Rolled-back change sets require rollback linkage and timestamp." });
  }
}

export const memoryChangeSetSummarySchema = z.object(memoryChangeSetSummaryShape).superRefine(validateMemoryChangeSetState);

export const memoryChangeSetSchema = z
  .object({
    ...memoryChangeSetSummaryShape,
    beforeSnapshot: memoryChangeSnapshotSchema,
    afterSnapshot: memoryChangeSnapshotSchema
  })
  .superRefine(validateMemoryChangeSetState);

export const createMemoryChangeSetInputSchema = z
  .object({
    kind: memoryChangeKindSchema,
    sourcePath: z.string().trim().min(1).max(1000),
    recordIds: z.array(idSchema).min(1).max(500),
    resolvesIssueIds: z.array(idSchema).max(500).default([]),
    expectedSourceHash: memoryChangeHashSchema,
    beforeContentHash: memoryChangeHashSchema,
    afterContentHash: memoryChangeHashSchema,
    beforeSnapshot: memoryChangeSnapshotSchema,
    afterSnapshot: memoryChangeSnapshotSchema,
    reason: z.string().trim().min(1).max(2000),
    actorUserId: idSchema,
    rollbackOfChangeSetId: idSchema.nullable().optional()
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.kind === "ROLLBACK" && !input.rollbackOfChangeSetId) {
      ctx.addIssue({ code: "custom", path: ["rollbackOfChangeSetId"], message: "Rollback change sets require a target." });
    }
    if (input.kind !== "ROLLBACK" && input.rollbackOfChangeSetId) {
      ctx.addIssue({ code: "custom", path: ["rollbackOfChangeSetId"], message: "Only rollback change sets can target another change set." });
    }
  });

export const createMemoryRollbackInputSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000)
  })
  .strict();

export const memoryChangeSetCommandInputSchema = z.object({}).strict();

export const updateMemoryChangeSetInputSchema = z
  .object({
    status: memoryChangeStatusSchema,
    resultingSourceHash: memoryChangeHashSchema.optional(),
    statusReason: z.string().trim().min(1).max(2000).optional()
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.status === "APPLIED" && !input.resultingSourceHash) {
      ctx.addIssue({ code: "custom", path: ["resultingSourceHash"], message: "Applied change sets require the resulting source hash." });
    }
    if (input.status !== "APPLIED" && input.resultingSourceHash) {
      ctx.addIssue({ code: "custom", path: ["resultingSourceHash"], message: "Only applied change sets can record a resulting source hash." });
    }
    if (["FAILED", "REJECTED"].includes(input.status) && !input.statusReason) {
      ctx.addIssue({ code: "custom", path: ["statusReason"], message: `${input.status} change sets require a reason.` });
    }
  });

export const listMemoryChangeSetsQuerySchema = paginationRequestSchema.extend({
  kind: memoryChangeKindSchema.optional(),
  status: memoryChangeStatusSchema.optional(),
  sourcePath: z.string().trim().min(1).max(1000).optional(),
  recordId: idSchema.optional(),
  issueId: idSchema.optional(),
  rollbackOfChangeSetId: idSchema.optional()
});

export const memoryMaintenanceInputSchema = z.object({
  scheduledAt: isoDateTimeSchema,
  traceId: idSchema
});

export const memoryMaintenanceResultSchema = z.object({
  status: z.enum(["REFRESHED", "UNCHANGED"]),
  generatedAt: isoDateTimeSchema,
  sourceHash: memoryChangeHashSchema,
  previousSourceHash: memoryChangeHashSchema.nullable(),
  summary: memoryGraphSummarySchema,
  durationMs: z.number().int().min(0).max(3_600_000)
});

export const memoryMutationJournalPhaseSchema = z.enum(["PREPARED", "WRITTEN"]);

export const memoryMutationJournalSchema = z
  .object({
    version: z.literal(1),
    phase: memoryMutationJournalPhaseSchema,
    changeSetId: idSchema,
    sourcePath: z.string().min(1).max(1000),
    expectedSourceHash: memoryChangeHashSchema,
    beforeContentHash: memoryChangeHashSchema,
    afterContentHash: memoryChangeHashSchema,
    resultingSourceHash: memoryChangeHashSchema.nullable(),
    preparedAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict()
  .superRefine((journal, ctx) => {
    if (journal.phase === "PREPARED" && journal.resultingSourceHash !== null) {
      ctx.addIssue({ code: "custom", path: ["resultingSourceHash"], message: "Prepared journals cannot record a result hash." });
    }
    if (journal.phase === "WRITTEN" && journal.resultingSourceHash === null) {
      ctx.addIssue({ code: "custom", path: ["resultingSourceHash"], message: "Written journals require a result hash." });
    }
  });

export const memoryMutationExecutionResultSchema = z
  .object({
    status: z.literal("APPLIED"),
    changeSetId: idSchema,
    sourcePath: z.string().min(1).max(1000),
    resultingSourceHash: memoryChangeHashSchema,
    journalPath: z.string().min(1).max(2000),
    durationMs: z.number().int().min(0).max(3_600_000)
  })
  .strict();

export const memoryMutationRecoveryResultSchema = z
  .object({
    status: z.enum(["COMPLETE_APPLIED", "COMPLETE_FAILED", "OPERATOR_REQUIRED"]),
    changeSetId: idSchema,
    sourcePath: z.string().min(1).max(1000),
    resultingSourceHash: memoryChangeHashSchema.nullable(),
    reason: z.string().min(1).max(2000).nullable()
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status === "COMPLETE_APPLIED" && result.resultingSourceHash === null) {
      ctx.addIssue({ code: "custom", path: ["resultingSourceHash"], message: "Applied recovery requires a result hash." });
    }
    if (result.status !== "COMPLETE_APPLIED" && result.resultingSourceHash !== null) {
      ctx.addIssue({ code: "custom", path: ["resultingSourceHash"], message: "Only applied recovery records a result hash." });
    }
    if (result.status === "OPERATOR_REQUIRED" && result.reason === null) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Operator-required recovery needs a reason." });
    }
  });

export const memoryMutationWorkflowInputSchema = z
  .object({
    changeSetId: idSchema,
    traceId: idSchema
  })
  .strict();

export const memoryMutationWorkflowResultSchema = z
  .object({
    status: z.enum(["DISABLED", "APPLIED", "FAILED", "OPERATOR_REQUIRED"]),
    changeSetId: idSchema,
    resultingSourceHash: memoryChangeHashSchema.nullable(),
    reason: z.string().min(1).max(2000).nullable()
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status === "APPLIED" && result.resultingSourceHash === null) {
      ctx.addIssue({ code: "custom", path: ["resultingSourceHash"], message: "Applied mutations require a result hash." });
    }
    if (result.status !== "APPLIED" && result.resultingSourceHash !== null) {
      ctx.addIssue({ code: "custom", path: ["resultingSourceHash"], message: "Only applied mutations record a result hash." });
    }
    if (["FAILED", "OPERATOR_REQUIRED"].includes(result.status) && result.reason === null) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: `${result.status} mutations require a reason.` });
    }
  });

export const createMemoryEntryInputSchema = z
  .object({
    scope: memoryScopeSchema.default("ROOM"),
    roomId: idSchema.nullable().optional(),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(10000),
    provenance: z.string().trim().min(1).max(500),
    tags: memoryTagsSchema.optional()
  })
  .superRefine((input, ctx) => {
    if (input.scope === "ROOM" && !input.roomId) {
      ctx.addIssue({ code: "custom", path: ["roomId"], message: "ROOM memory requires roomId." });
    }
    if (input.scope !== "ROOM" && input.roomId) {
      ctx.addIssue({ code: "custom", path: ["roomId"], message: "Only ROOM memory can include roomId." });
    }
  });

export const listMemoryQuerySchema = paginationRequestSchema
  .extend({
    scope: memoryScopeSchema.optional(),
    roomId: idSchema.optional(),
    q: z.string().trim().min(1).max(200).optional(),
    searchMode: memorySearchModeSchema.default("keyword")
  })
  .superRefine((input, ctx) => {
    if (input.searchMode === "semantic" && !input.q) {
      ctx.addIssue({ code: "custom", path: ["q"], message: "Semantic memory search requires q." });
    }
  });

export const clipboardSourceSchema = z.enum(["COPY", "PASTE", "MANUAL_NOTE", "AGENT_NOTE"]);
export const clipboardOperatorSourceSchema = z.enum(["COPY", "PASTE", "MANUAL_NOTE"]);
export const clipboardTextMaxCharacters = 100_000;
export const agentClipboardNoteMaxCharacters = 10_000;

const nonBlankExactText = (maxCharacters: number) =>
  z
    .string()
    .min(1)
    .refine((text) => Array.from(text).length <= maxCharacters, {
      message: `Clipboard text may contain at most ${maxCharacters} characters.`
    })
    .refine((text) => text.trim().length > 0, { message: "Clipboard text must contain a non-whitespace character." });

export const spaceClipboardToolIdSchema = z.enum(["clipboard:list", "clipboard:get", "clipboard:save"]);

export const spaceAgentClipboardListActionSchema = z.object({
  type: z.literal("list"),
  q: z.string().trim().min(1).max(500).optional(),
  source: clipboardSourceSchema.optional(),
  pageSize: z.number().int().min(1).max(10).default(10)
});

export const spaceAgentClipboardGetActionSchema = z.object({
  type: z.literal("get"),
  clipboardItemId: idSchema
});

export const spaceAgentClipboardSaveActionSchema = z.object({
  type: z.literal("save"),
  text: nonBlankExactText(agentClipboardNoteMaxCharacters)
});

export const spaceAgentClipboardActionInputSchema = z.discriminatedUnion("type", [
  spaceAgentClipboardListActionSchema,
  spaceAgentClipboardGetActionSchema,
  spaceAgentClipboardSaveActionSchema
]);

function expectedClipboardToolIdForAction(
  type: z.infer<typeof spaceAgentClipboardActionInputSchema>["type"]
): z.infer<typeof spaceClipboardToolIdSchema> {
  switch (type) {
    case "list":
      return "clipboard:list";
    case "get":
      return "clipboard:get";
    case "save":
      return "clipboard:save";
  }
}

export const spaceAgentClipboardActionRequestSchema = z
  .object({
    toolId: spaceClipboardToolIdSchema,
    action: spaceAgentClipboardActionInputSchema
  })
  .superRefine((input, context) => {
    const expected = expectedClipboardToolIdForAction(input.action.type);
    if (input.toolId !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolId"],
        message: `toolId ${input.toolId} does not match clipboard action type ${input.action.type}.`
      });
    }
  });

export const spaceAgentClipboardActionEnvelopeSchema = z.object({
  version: z.literal(1),
  actions: z.array(spaceAgentClipboardActionRequestSchema).min(1).max(3)
});

export const spaceMemoryToolIdSchema = z.enum(["memory:search", "memory:save"]);

export const spaceAgentMemorySearchActionSchema = z.object({
  type: z.literal("search"),
  q: z.string().trim().min(1).max(200),
  scope: memoryScopeSchema.default("ROOM"),
  pageSize: z.number().int().min(1).max(5).default(5)
});

export const spaceAgentMemorySaveActionSchema = z.object({
  type: z.literal("save"),
  scope: memoryScopeSchema.default("ROOM"),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(10000),
  provenance: z.string().trim().min(1).max(500).default("space-agent-memory-action"),
  tags: memoryTagsSchema.optional()
});

export const spaceAgentMemoryActionInputSchema = z.discriminatedUnion("type", [
  spaceAgentMemorySearchActionSchema,
  spaceAgentMemorySaveActionSchema
]);

function expectedMemoryToolIdForAction(type: z.infer<typeof spaceAgentMemoryActionInputSchema>["type"]): z.infer<typeof spaceMemoryToolIdSchema> {
  switch (type) {
    case "search":
      return "memory:search";
    case "save":
      return "memory:save";
  }
}

export const spaceAgentMemoryActionRequestSchema = z
  .object({
    toolId: spaceMemoryToolIdSchema,
    action: spaceAgentMemoryActionInputSchema
  })
  .superRefine((input, context) => {
    const expected = expectedMemoryToolIdForAction(input.action.type);
    if (input.toolId !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolId"],
        message: `toolId ${input.toolId} does not match memory action type ${input.action.type}.`
      });
    }
  });

export const spaceAgentMemoryActionEnvelopeSchema = z.object({
  version: z.literal(1),
  actions: z.array(spaceAgentMemoryActionRequestSchema).min(1).max(3)
});

export const skillSchema = z.object({
  id: z.string().min(1).max(160),
  displayName: z.string().min(1).max(160),
  version: z.string().min(1).max(80),
  status: integrationStatusSchema,
  statusReason: z.string().max(500).nullable(),
  triggerDescription: z.string().max(500),
  body: z.string().max(20000),
  allowedTools: z.array(z.string().min(1).max(160)),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  source: z.enum(["STATIC", "CODEX_SKILL", "OPERATOR_PROPOSAL"]),
  createdAt: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema.nullable()
});

export const spaceSkillToolIdSchema = z.enum(["skills:list", "skills:read"]);

export const spaceAgentSkillListActionSchema = z.object({
  type: z.literal("list"),
  q: z.string().trim().min(1).max(120).optional(),
  status: integrationStatusSchema.optional(),
  includeDisabled: z.boolean().default(false),
  pageSize: z.number().int().min(1).max(20).default(10)
});

export const spaceAgentSkillReadActionSchema = z.object({
  type: z.literal("read"),
  skillId: z.string().trim().min(1).max(160)
});

export const spaceAgentSkillActionInputSchema = z.discriminatedUnion("type", [
  spaceAgentSkillListActionSchema,
  spaceAgentSkillReadActionSchema
]);

function expectedSkillToolIdForAction(type: z.infer<typeof spaceAgentSkillActionInputSchema>["type"]): z.infer<typeof spaceSkillToolIdSchema> {
  switch (type) {
    case "list":
      return "skills:list";
    case "read":
      return "skills:read";
  }
}

export const spaceAgentSkillActionRequestSchema = z
  .object({
    toolId: spaceSkillToolIdSchema,
    action: spaceAgentSkillActionInputSchema
  })
  .superRefine((input, context) => {
    const expected = expectedSkillToolIdForAction(input.action.type);
    if (input.toolId !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolId"],
        message: `toolId ${input.toolId} does not match skill action type ${input.action.type}.`
      });
    }
  });

export const spaceAgentSkillActionEnvelopeSchema = z.object({
  version: z.literal(1),
  actions: z.array(spaceAgentSkillActionRequestSchema).min(1).max(3)
});

export const spaceAgentSkillActionBridgeRequestSchema = z.object({
  roomId: idSchema,
  agentPaneId: idSchema,
  agentSessionId: idSchema,
  selectedToolIds: z.array(spaceSkillToolIdSchema).max(50),
  actions: z.array(spaceAgentSkillActionRequestSchema).min(1).max(3)
});

export const spaceAgentSkillSummaryObservationSchema = z.object({
  skillId: z.string().min(1).max(160),
  displayName: z.string().min(1).max(160),
  version: z.string().min(1).max(80),
  status: integrationStatusSchema,
  statusReason: z.string().max(500).nullable(),
  triggerDescription: z.string().max(500),
  allowedTools: z.array(z.string().min(1).max(160)).max(50),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
});

export const spaceAgentSkillActionObservationSchema = z.object({
  actionType: z.enum(["list", "read"]),
  skillId: z.string().min(1).max(160).nullable(),
  matchCount: z.number().int().min(0).max(100).nullable(),
  skills: z.array(spaceAgentSkillSummaryObservationSchema).max(20),
  body: z.string().max(8000).nullable()
});

export const spaceAgentSkillActionExecutionResultSchema = z.object({
  request: spaceAgentSkillActionRequestSchema,
  status: z.enum(["EXECUTED", "BLOCKED", "FAILED"]),
  statusReason: z.string().min(1).max(500),
  observation: spaceAgentSkillActionObservationSchema.nullable()
});

export const spaceAgentSkillActionBridgeResponseSchema = z.object({
  id: z.literal("space-agent-skill-action-bridge"),
  results: z.array(spaceAgentSkillActionExecutionResultSchema).max(3)
});

export const createSkillProposalInputSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  version: z.string().trim().min(1).max(80).default("0.1.0"),
  triggerDescription: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(20000),
  allowedTools: z.array(z.string().trim().min(1).max(160)).max(50).default([])
});

export const importSourceKindSchema = z.enum(["CODEX_MEMORY", "CODEX_SKILL", "OPERATOR_NOTE", "MARKDOWN"]);
export const importTargetKindSchema = z.enum(["MEMORY", "SKILL"]);
export const importCandidateStatusSchema = z.enum(["PENDING", "IMPORTED", "REJECTED"]);

export const importCandidateSchema = z.object({
  id: idSchema,
  sourceKind: importSourceKindSchema,
  targetKind: importTargetKindSchema,
  status: importCandidateStatusSchema,
  statusReason: z.string().max(1000).nullable(),
  sourceRef: z.string().min(1).max(500),
  roomId: idSchema.nullable(),
  memoryScope: memoryScopeSchema,
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(20000),
  provenance: z.string().min(1).max(500),
  skillVersion: z.string().min(1).max(80).nullable(),
  skillTriggerDescription: z.string().min(1).max(500).nullable(),
  allowedTools: z.array(z.string().min(1).max(160)),
  importedMemoryId: idSchema.nullable(),
  importedSkillId: idSchema.nullable(),
  createdAt: isoDateTimeSchema,
  decidedAt: isoDateTimeSchema.nullable()
});

export const createImportCandidateInputSchema = z
  .object({
    sourceKind: importSourceKindSchema,
    targetKind: importTargetKindSchema,
    sourceRef: z.string().trim().min(1).max(500),
    roomId: idSchema.nullable().optional(),
    memoryScope: memoryScopeSchema.default("ROOM"),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(20000),
    provenance: z.string().trim().min(1).max(500).default("explicit-import-gate"),
    skillVersion: z.string().trim().min(1).max(80).default("0.1.0"),
    skillTriggerDescription: z.string().trim().min(1).max(500).optional(),
    allowedTools: z.array(z.string().trim().min(1).max(160)).max(50).default([])
  })
  .superRefine((input, ctx) => {
    if (input.targetKind === "MEMORY" && input.memoryScope === "ROOM" && !input.roomId) {
      ctx.addIssue({ code: "custom", path: ["roomId"], message: "ROOM memory imports require roomId." });
    }
    if (input.targetKind === "MEMORY" && input.memoryScope !== "ROOM" && input.roomId) {
      ctx.addIssue({ code: "custom", path: ["roomId"], message: "Only ROOM memory imports can include roomId." });
    }
    if (input.targetKind === "SKILL" && !input.skillTriggerDescription) {
      ctx.addIssue({ code: "custom", path: ["skillTriggerDescription"], message: "Skill imports require a trigger description." });
    }
  });

export const importCandidateDecisionInputSchema = z
  .object({
    decision: z.enum(["IMPORT", "REJECT"]),
    reason: z.string().trim().max(1000).default("")
  })
  .superRefine((input, ctx) => {
    if (input.decision === "REJECT" && !input.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Rejecting an import candidate requires a reason." });
    }
  });

export const listImportCandidatesQuerySchema = paginationRequestSchema.extend({
  status: importCandidateStatusSchema.optional(),
  targetKind: importTargetKindSchema.optional()
});

export const importCandidateDecisionResultSchema = z.object({
  candidate: importCandidateSchema,
  memoryEntry: memoryEntrySchema.nullable(),
  skill: skillSchema.nullable()
});

export const browserSessionSchema = paneBrowserSessionSchema;

export const browserEvidenceViewportSchema = z.enum(["mobile", "tablet", "desktop", "wide", "ultrawide"]);

export const createBrowserEvidenceInputSchema = z.object({
  roomId: idSchema,
  paneId: idSchema.nullable().optional(),
  viewport: browserEvidenceViewportSchema.default("desktop")
});

export const browserEvidenceCaptureSchema = z.object({
  captureId: idSchema,
  roomId: idSchema,
  paneId: idSchema.nullable(),
  viewport: browserEvidenceViewportSchema,
  targetUrl: z.string().url(),
  artifacts: z.array(artifactSchema),
  createdAt: isoDateTimeSchema
});

export const reviewDecisionSchema = z.object({
  id: idSchema,
  roomId: idSchema,
  workflowId: idSchema.nullable(),
  decision: z.enum(["SHIP", "BLOCK", "NEEDS_HUMAN"]),
  summary: z.string().min(1).max(2000),
  evidenceArtifactIds: z.array(idSchema),
  rollbackNote: z.string().max(2000),
  createdAt: isoDateTimeSchema
});

export const createReviewDecisionInputSchema = z.object({
  roomId: idSchema,
  workflowId: idSchema.nullable().optional(),
  decision: z.enum(["SHIP", "BLOCK", "NEEDS_HUMAN"]),
  summary: z.string().trim().min(1).max(2000),
  evidenceArtifactIds: z.array(idSchema).max(50).default([]),
  rollbackNote: z.string().trim().max(2000).default("")
});

export const listReviewDecisionsQuerySchema = paginationRequestSchema.extend({
  roomId: idSchema.optional()
});

export const reviewCheckStatusSchema = z.enum(["PASS", "WARN", "FAIL", "SKIPPED", "RUNNING"]);
export const reviewDiffStatusSchema = z.enum(["ADDED", "MODIFIED", "DELETED", "RENAMED"]);

const reviewMetadataInputSchema = z
  .record(z.string().min(1).max(120), z.unknown())
  .default({})
  .superRefine((metadata, ctx) => {
    if (Object.keys(metadata).length > 50) {
      ctx.addIssue({ code: "custom", message: "Review metadata supports at most 50 top-level keys." });
    }
    try {
      if (JSON.stringify(metadata).length > 8000) {
        ctx.addIssue({ code: "custom", message: "Review metadata must fit within 8000 JSON characters." });
      }
    } catch {
      ctx.addIssue({ code: "custom", message: "Review metadata must be JSON serializable." });
    }
  });

export const reviewCheckSchema = z.object({
  id: idSchema,
  roomId: idSchema,
  reviewDecisionId: idSchema.nullable(),
  name: z.string().min(1).max(160),
  status: reviewCheckStatusSchema,
  command: z.string().max(500).nullable(),
  summary: z.string().min(1).max(2000),
  artifactIds: z.array(idSchema),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: isoDateTimeSchema
});

export const createReviewCheckInputSchema = z.object({
  roomId: idSchema,
  reviewDecisionId: idSchema.nullable().optional(),
  name: z.string().trim().min(1).max(160),
  status: reviewCheckStatusSchema,
  command: z.string().trim().max(500).nullable().optional(),
  summary: z.string().trim().min(1).max(2000),
  artifactIds: z.array(idSchema).max(50).default([]),
  metadata: reviewMetadataInputSchema
});

export const listReviewChecksQuerySchema = paginationRequestSchema.extend({
  roomId: idSchema.optional(),
  reviewDecisionId: idSchema.optional(),
  status: reviewCheckStatusSchema.optional()
});

export const reviewDiffSummarySchema = z.object({
  id: idSchema,
  roomId: idSchema,
  reviewDecisionId: idSchema.nullable(),
  title: z.string().min(1).max(160),
  filePath: z.string().min(1).max(1000),
  status: reviewDiffStatusSchema,
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  patchArtifactId: idSchema.nullable(),
  summary: z.string().max(2000),
  createdAt: isoDateTimeSchema
});

export const createReviewDiffSummaryInputSchema = z.object({
  roomId: idSchema,
  reviewDecisionId: idSchema.nullable().optional(),
  title: z.string().trim().min(1).max(160),
  filePath: z.string().trim().min(1).max(1000),
  status: reviewDiffStatusSchema,
  additions: z.coerce.number().int().min(0).max(1_000_000).default(0),
  deletions: z.coerce.number().int().min(0).max(1_000_000).default(0),
  patchArtifactId: idSchema.nullable().optional(),
  summary: z.string().trim().max(2000).default("")
});

export const listReviewDiffSummariesQuerySchema = paginationRequestSchema.extend({
  roomId: idSchema.optional(),
  reviewDecisionId: idSchema.optional(),
  status: reviewDiffStatusSchema.optional()
});

export const reviewRoomStateSchema = z.object({
  decisions: z.array(reviewDecisionSchema),
  checks: z.array(reviewCheckSchema),
  diffs: z.array(reviewDiffSummarySchema),
  artifacts: z.array(artifactSchema),
  gateStatus: z.enum(["EMPTY", "PASS", "WARN", "FAIL"]),
  statusReason: z.string().min(1).max(500)
});

export const launchReadinessRequirementStatusSchema = z.enum(["PASS", "WARN", "FAIL", "MISSING"]);
export const launchReadinessBlockerSeveritySchema = z.enum(["none", "gate", "hard"]);

export const launchReadinessEvidenceSchema = z.object({
  label: z.string().min(1).max(120),
  ref: z.string().min(1).max(500).nullable().default(null)
});

export const launchReadinessRequirementSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(160),
  status: launchReadinessRequirementStatusSchema,
  severity: launchReadinessBlockerSeveritySchema,
  message: z.string().min(1).max(1000),
  evidence: z.array(launchReadinessEvidenceSchema).max(10).default([])
});

export const launchReadinessSchema = z.object({
  id: z.literal("launch-readiness"),
  status: z.enum(["READY", "GATED", "BLOCKED"]),
  generatedAt: isoDateTimeSchema,
  completionPct: z.number().int().min(0).max(100),
  passedCount: z.number().int().min(0),
  totalCount: z.number().int().min(1),
  hardBlockerCount: z.number().int().min(0),
  gateCount: z.number().int().min(0),
  summary: z.string().min(1).max(1000),
  requirements: z.array(launchReadinessRequirementSchema).min(1)
});

export const swarmTaskRoleSchema = z.enum(["PLANNER", "WORKER", "REVIEWER"]);
export const swarmTaskStatusSchema = z.enum(["PLANNED", "READY", "RUNNING", "BLOCKED", "DONE", "CANCELLED"]);
export const swarmLockStatusSchema = z.enum(["ACTIVE", "RELEASED"]);
export const swarmReconcileDecisionSchema = z.enum(["MERGED", "BLOCKED", "NEEDS_HUMAN"]);
export const swarmExecutionStatusSchema = z.enum(["DISABLED", "READY"]);

export const swarmTaskSchema = z.object({
  id: idSchema,
  roomId: idSchema,
  parentTaskId: idSchema.nullable(),
  role: swarmTaskRoleSchema,
  title: z.string().min(1).max(160),
  goal: z.string().min(1).max(4000),
  status: swarmTaskStatusSchema,
  assignee: z.string().min(1).max(160).nullable(),
  dependsOnTaskIds: z.array(idSchema),
  lockIds: z.array(idSchema),
  resultSummary: z.string().max(4000).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable()
});

export const createSwarmTaskInputSchema = z.object({
  roomId: idSchema,
  parentTaskId: idSchema.nullable().optional(),
  role: swarmTaskRoleSchema.default("WORKER"),
  title: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(4000),
  assignee: z.string().trim().min(1).max(160).nullable().optional(),
  dependsOnTaskIds: z.array(idSchema).max(50).default([])
});

export const updateSwarmTaskInputSchema = z.object({
  status: swarmTaskStatusSchema.optional(),
  assignee: z.string().trim().min(1).max(160).nullable().optional(),
  dependsOnTaskIds: z.array(idSchema).max(50).optional(),
  lockIds: z.array(idSchema).max(50).optional(),
  resultSummary: z.string().trim().max(4000).nullable().optional()
});

export const runSwarmTaskInputSchema = z.object({
  paneId: idSchema.optional(),
  prompt: z.string().trim().min(1).max(4000).optional()
});

export const listSwarmTasksQuerySchema = paginationRequestSchema.extend({
  roomId: idSchema.optional(),
  status: swarmTaskStatusSchema.optional(),
  role: swarmTaskRoleSchema.optional()
});

export const swarmLockSchema = z.object({
  id: idSchema,
  roomId: idSchema,
  taskId: idSchema.nullable(),
  resource: z.string().min(1).max(500),
  status: swarmLockStatusSchema,
  holder: z.string().min(1).max(160),
  reason: z.string().min(1).max(500),
  createdAt: isoDateTimeSchema,
  releasedAt: isoDateTimeSchema.nullable()
});

export const claimSwarmLockInputSchema = z.object({
  roomId: idSchema,
  taskId: idSchema.nullable().optional(),
  resource: z.string().trim().min(1).max(500),
  holder: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).max(500)
});

export const releaseSwarmLockInputSchema = z.object({
  reason: z.string().trim().min(1).max(500).default("Released by operator.")
});

export const swarmMessageSchema = z.object({
  id: idSchema,
  roomId: idSchema,
  taskId: idSchema.nullable(),
  fromRole: swarmTaskRoleSchema,
  toRole: swarmTaskRoleSchema.nullable(),
  body: z.string().min(1).max(4000),
  createdAt: isoDateTimeSchema
});

export const postSwarmMessageInputSchema = z.object({
  roomId: idSchema,
  taskId: idSchema.nullable().optional(),
  fromRole: swarmTaskRoleSchema,
  toRole: swarmTaskRoleSchema.nullable().optional(),
  body: z.string().trim().min(1).max(4000)
});

export const swarmReconcileSchema = z.object({
  id: idSchema,
  roomId: idSchema,
  taskIds: z.array(idSchema).min(1).max(50),
  decision: swarmReconcileDecisionSchema,
  summary: z.string().min(1).max(2000),
  nextSteps: z.string().max(2000),
  createdAt: isoDateTimeSchema
});

export const createSwarmReconcileInputSchema = z.object({
  roomId: idSchema,
  taskIds: z.array(idSchema).min(1).max(50),
  decision: swarmReconcileDecisionSchema,
  summary: z.string().trim().min(1).max(2000),
  nextSteps: z.string().trim().max(2000).default("")
});

export const swarmStateSchema = z.object({
  tasks: z.array(swarmTaskSchema),
  locks: z.array(swarmLockSchema),
  messages: z.array(swarmMessageSchema),
  reconciles: z.array(swarmReconcileSchema),
  executionStatus: swarmExecutionStatusSchema,
  statusReason: z.string().min(1).max(500)
});

export const runSwarmTaskResponseSchema = z.object({
  task: swarmTaskSchema,
  agentSession: agentPaneSessionSchema,
  message: swarmMessageSchema
});

export const sharedTaskSourceSchema = z.enum(["all", "space_swarm", "codex_goal"]);
export const codexGoalStatusSchema = agentPaneGoalStatusSchema;

export const spaceSwarmSharedTaskSchema = z.object({
  id: idSchema,
  source: z.literal("space_swarm"),
  title: z.string().min(1).max(160),
  status: swarmTaskStatusSchema,
  roomId: idSchema,
  role: swarmTaskRoleSchema,
  assignee: z.string().max(160).nullable(),
  resultSummary: z.string().max(4000).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const codexGoalSharedTaskSchema = z.object({
  id: idSchema,
  source: z.literal("codex_goal"),
  threadId: z.string().min(1).max(128),
  goalId: z.string().min(1).max(128),
  title: z.string().min(1).max(4000),
  status: codexGoalStatusSchema,
  tokenBudget: z.number().int().nullable(),
  tokensUsed: z.number().int().min(0),
  timeUsedSeconds: z.number().int().min(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const sharedTaskSchema = z.discriminatedUnion("source", [spaceSwarmSharedTaskSchema, codexGoalSharedTaskSchema]);

export const listSharedTasksQuerySchema = paginationRequestSchema.extend({
  source: sharedTaskSourceSchema.default("all")
});

export const updateCodexGoalTaskInputSchema = z
  .object({
    status: codexGoalStatusSchema.optional(),
    objective: z.string().trim().min(1).max(4000).optional()
  })
  .refine((input) => input.status !== undefined || input.objective !== undefined, "Codex goal update must include status or objective.");

export const authUserSchema = z.object({
  id: idSchema,
  email: z.string().email(),
  role: z.enum(["OPERATOR", "ADMIN"])
});

export const authMeSchema = z.object({
  user: authUserSchema.nullable(),
  isAuthenticated: z.boolean(),
  isSetupRequired: z.boolean()
});

export const loginInputSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(500)
});

export const setupStatusSchema = z.object({
  setupRequired: z.boolean(),
  expiresAt: isoDateTimeSchema.nullable()
});

export const setupClaimInputSchema = z.object({
  token: z.string().min(32).max(500),
  email: z.string().trim().email().max(320),
  password: z.string().min(12).max(500)
}).strict();

export const setupClaimResponseSchema = z.object({
  user: authUserSchema,
  isAuthenticated: z.literal(true),
  isSetupRequired: z.literal(false)
});

export function canonicalizeUserLinkUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Link URL must be an absolute HTTP or HTTPS URL.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new Error("Link URL must use HTTP or HTTPS and must not contain credentials.");
  }
  parsed.hash = "";
  return parsed.toString();
}

const userLinkUrlSchema = z.string().trim().min(1).max(2048).transform((value, context) => {
  try {
    return canonicalizeUserLinkUrl(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid link URL." });
    return z.NEVER;
  }
});

export const userLinkOpenModeSchema = z.enum(["EMBEDDED", "NEW_TAB"]);
export const userLinkSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000),
  url: userLinkUrlSchema,
  openMode: userLinkOpenModeSchema,
  isQuick: z.boolean(),
  sortOrder: z.number().int().min(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).strict().superRefine((link, context) => {
  if (link.url.startsWith("http:") && link.openMode !== "NEW_TAB") {
    context.addIssue({ code: "custom", path: ["openMode"], message: "HTTP links can only open in a new tab." });
  }
});

export const createUserLinkRequestSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).default(""),
  url: userLinkUrlSchema,
  openMode: userLinkOpenModeSchema.default("EMBEDDED"),
  isQuick: z.boolean().default(false)
}).strict().superRefine((link, context) => {
  if (link.url.startsWith("http:") && link.openMode !== "NEW_TAB") {
    context.addIssue({ code: "custom", path: ["openMode"], message: "HTTP links can only open in a new tab." });
  }
});

export const updateUserLinkRequestSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(1000).optional(),
  url: userLinkUrlSchema.optional(),
  openMode: userLinkOpenModeSchema.optional(),
  isQuick: z.boolean().optional()
}).strict().refine((input) => Object.keys(input).length > 0, "Link update must include at least one field.");

export const listUserLinksQuerySchema = z.object({
  q: z.string().trim().min(1).max(500).optional(),
  isQuick: z.union([z.boolean(), z.enum(["true", "false"])]).optional().transform((value) =>
    value === undefined ? undefined : value === true || value === "true"
  ),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
}).strict();

export const userLinkListResponseSchema = paginated(userLinkSchema);

export const clipboardItemSchema = z
  .object({
    id: idSchema,
    text: nonBlankExactText(clipboardTextMaxCharacters),
    source: clipboardSourceSchema,
    roomId: idSchema.nullable().default(null),
    paneId: idSchema.nullable().default(null),
    paneTitle: z.string().min(1).max(160).nullable().default(null),
    occurrenceCount: z.number().int().min(1),
    characterCount: z.number().int().min(1).max(clipboardTextMaxCharacters),
    createdAt: isoDateTimeSchema,
    lastUsedAt: isoDateTimeSchema
  })
  .strict();

export const createClipboardItemRequestSchema = z
  .object({
    text: nonBlankExactText(clipboardTextMaxCharacters),
    source: clipboardOperatorSourceSchema,
    roomId: idSchema.nullable().optional(),
    paneId: idSchema.nullable().optional(),
    paneTitle: z.string().min(1).max(160).nullable().optional()
  })
  .strict();

export const saveAgentClipboardItemInputSchema = z
  .object({
    text: nonBlankExactText(agentClipboardNoteMaxCharacters),
    roomId: idSchema.nullable().optional(),
    paneId: idSchema.nullable().optional(),
    paneTitle: z.string().min(1).max(160).nullable().optional()
  })
  .strict();

export const upsertClipboardItemInputSchema = z
  .object({
    ownerUserId: idSchema,
    text: nonBlankExactText(clipboardTextMaxCharacters),
    source: clipboardSourceSchema,
    roomId: idSchema.nullable().optional(),
    paneId: idSchema.nullable().optional(),
    paneTitle: z.string().min(1).max(160).nullable().optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (input.source === "AGENT_NOTE" && Array.from(input.text).length > agentClipboardNoteMaxCharacters) {
      context.addIssue({
        code: "too_big",
        maximum: agentClipboardNoteMaxCharacters,
        origin: "string",
        inclusive: true,
        path: ["text"],
        message: `Agent notes may contain at most ${agentClipboardNoteMaxCharacters} characters.`
      });
    }
  });

export const listClipboardItemsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(500).optional(),
    source: clipboardSourceSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25)
  })
  .strict();

export const clipboardItemListResponseSchema = paginated(clipboardItemSchema);

export type ClipboardSource = z.infer<typeof clipboardSourceSchema>;
export type ClipboardOperatorSource = z.infer<typeof clipboardOperatorSourceSchema>;
export type ClipboardItem = z.infer<typeof clipboardItemSchema>;
export type CreateClipboardItemRequest = z.infer<typeof createClipboardItemRequestSchema>;
export type SaveAgentClipboardItemInput = z.infer<typeof saveAgentClipboardItemInputSchema>;
export type UpsertClipboardItemInput = z.infer<typeof upsertClipboardItemInputSchema>;
export type ListClipboardItemsQuery = z.infer<typeof listClipboardItemsQuerySchema>;
export type ClipboardItemListResponse = z.infer<typeof clipboardItemListResponseSchema>;

export type ApiError = z.infer<typeof apiErrorSchema>;
export type PaginationRequest = z.infer<typeof paginationRequestSchema>;
export type Pagination = z.infer<typeof paginationSchema>;
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;
export type RoomKind = z.infer<typeof roomKindSchema>;
export type Room = z.infer<typeof roomSchema>;
export type CreateRoomInput = z.infer<typeof createRoomInputSchema>;
export type ProofRoomPaneCount = z.infer<typeof proofRoomPaneCountSchema>;
export type CreateProofRoomInput = z.infer<typeof createProofRoomInputSchema>;
export type ProofRoom = z.infer<typeof proofRoomSchema>;
export type RoomCliActivity = z.infer<typeof roomCliActivitySchema>;
export type RoomCliActivityResponse = z.infer<typeof roomCliActivityResponseSchema>;
export type UpdateRoomInput = z.infer<typeof updateRoomInputSchema>;
export type UpdatePaneLayoutInput = z.infer<typeof updatePaneLayoutInputSchema>;
export type ReorderRoomsInput = z.infer<typeof reorderRoomsInputSchema>;
export type Pane = z.infer<typeof paneSchema>;
export type CreatePaneInput = z.infer<typeof createPaneInputSchema>;
export type RoomPaneBatchItem = z.infer<typeof roomPaneBatchItemSchema>;
export type CreateRoomPanesRequest = z.infer<typeof createRoomPanesRequestSchema>;
export type CreateRoomPanesInput = z.infer<typeof createRoomPanesInputSchema>;
export type RoomPanesResult = z.infer<typeof roomPanesResultSchema>;
export type ListPanesQuery = z.infer<typeof listPanesQuerySchema>;
export type UpdatePaneInput = z.infer<typeof updatePaneInputSchema>;
export type MovePaneInput = z.infer<typeof movePaneInputSchema>;
export type MovePaneResult = z.infer<typeof movePaneResultSchema>;
export type RoomPaneLayoutResult = z.infer<typeof roomPaneLayoutResultSchema>;
export type AgentPaneSource = z.infer<typeof agentPaneSourceSchema>;
export type AgentPaneBindingStatus = z.infer<typeof agentPaneBindingStatusSchema>;
export type AgentPaneRunStatus = z.infer<typeof agentPaneRunStatusSchema>;
export type SpaceAgentRunRecordStatus = z.infer<typeof spaceAgentRunRecordStatusSchema>;
export type AgentPaneMessageRole = z.infer<typeof agentPaneMessageRoleSchema>;
export type AgentPaneMessageStatus = z.infer<typeof agentPaneMessageStatusSchema>;
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export type CollaborationMode = z.infer<typeof collaborationModeSchema>;
export type AgentPaneSandbox = z.infer<typeof agentPaneSandboxSchema>;
export type AgentPaneApprovalPolicy = z.infer<typeof agentPaneApprovalPolicySchema>;
export type AgentPaneReviewer = z.infer<typeof agentPaneReviewerSchema>;
export type AgentPaneToolCategory = z.infer<typeof agentPaneToolCategorySchema>;
export type AgentPanePermissionState = z.infer<typeof agentPanePermissionStateSchema>;
export type AgentPanePermissionOption = z.infer<typeof agentPanePermissionOptionSchema>;
export type AgentPaneGoalStatus = z.infer<typeof agentPaneGoalStatusSchema>;
export type AgentPaneGoal = z.infer<typeof agentPaneGoalSchema>;
export type AgentPaneGoalInput = z.infer<typeof agentPaneGoalInputSchema>;
export type AgentPaneBinding = z.infer<typeof agentPaneBindingSchema>;
export type UpsertAgentPaneBindingInput = z.infer<typeof upsertAgentPaneBindingInputSchema>;
export type UpdateAgentPaneBindingInput = z.infer<typeof updateAgentPaneBindingInputSchema>;
export type AgentPaneMessage = z.infer<typeof agentPaneMessageSchema>;
export type RoomAgentStatus = z.infer<typeof roomAgentStatusSchema>;
export type RoomAgentMissionStatus = z.infer<typeof roomAgentMissionStatusSchema>;
export type RoomAgentMission = z.infer<typeof roomAgentMissionSchema>;
export type RoomAgentBinding = z.infer<typeof roomAgentBindingSchema>;
export type RoomAgentRequestRecord = z.infer<typeof roomAgentRequestRecordSchema>;
export type CreateRoomAgentRequestInput = z.infer<typeof createRoomAgentRequestInputSchema>;
export type RoomAgentMissionRecord = z.infer<typeof roomAgentMissionRecordSchema>;
export type CreateRoomAgentMissionInput = z.infer<typeof createRoomAgentMissionInputSchema>;
export type UpdateRoomAgentMissionInput = z.infer<typeof updateRoomAgentMissionInputSchema>;
export type RoomAgentActionType = z.infer<typeof roomAgentActionTypeSchema>;
export type RoomAgentActionStatus = z.infer<typeof roomAgentActionStatusSchema>;
export type RoomAgentActionRecord = z.infer<typeof roomAgentActionRecordSchema>;
export type CreateRoomAgentActionInput = z.infer<typeof createRoomAgentActionInputSchema>;
export type UpdateRoomAgentActionInput = z.infer<typeof updateRoomAgentActionInputSchema>;
export type RoomAgentPlanStatus = z.infer<typeof roomAgentPlanStatusSchema>;
export type RoomAgentRoomPlan = z.infer<typeof roomAgentRoomPlanSchema>;
export type RoomAgentRoomInventory = z.infer<typeof roomAgentRoomInventorySchema>;
export type RoomAgentTaskResult = z.infer<typeof roomAgentTaskResultSchema>;
export type RoomAgentTaskRunStatus = z.infer<typeof roomAgentTaskRunStatusSchema>;
export type RoomAgentTaskRunRecord = z.infer<typeof roomAgentTaskRunRecordSchema>;
export type UpsertRoomAgentTaskRunInput = z.infer<typeof upsertRoomAgentTaskRunInputSchema>;
export type RoomAgentMissionSummary = z.infer<typeof roomAgentMissionSummarySchema>;
export type RoomAgentSession = z.infer<typeof roomAgentSessionSchema>;
export type RoomAgentMessageInput = z.infer<typeof roomAgentMessageInputSchema>;
export type RoomAgentStopInput = z.infer<typeof roomAgentStopInputSchema>;
export type RoomAgentControlInput = z.infer<typeof roomAgentControlInputSchema>;
export type RoomAgentVerificationEnvelope = z.infer<typeof roomAgentVerificationEnvelopeSchema>;
export type RoomAgentOrchestrationStep = z.infer<typeof roomAgentOrchestrationStepSchema>;
export type SpaceRoomToolId = z.infer<typeof spaceRoomToolIdSchema>;
export type SpaceAgentRoomActionRequest = z.infer<typeof spaceAgentRoomActionRequestSchema>;
export type SpaceAgentRoomActionEnvelope = z.infer<typeof spaceAgentRoomActionEnvelopeSchema>;
export type SpaceAgentRoomActionBridgeRequest = z.infer<typeof spaceAgentRoomActionBridgeRequestSchema>;
export type SpaceAgentRoomActionBridgeResult = z.infer<typeof spaceAgentRoomActionBridgeResultSchema>;
export type SpaceAgentRoomActionBridgeResponse = z.infer<typeof spaceAgentRoomActionBridgeResponseSchema>;
export type AgentPaneModelOption = z.infer<typeof agentPaneModelOptionSchema>;
export type CodexModelCatalogOption = z.infer<typeof codexModelCatalogOptionSchema>;
export type AgentPaneToolOption = z.infer<typeof agentPaneToolOptionSchema>;
export type AgentPaneCapabilities = z.infer<typeof agentPaneCapabilitiesSchema>;
export type AgentPaneHistoryItem = z.infer<typeof agentPaneHistoryItemSchema>;
export type AgentPaneStoredSession = z.infer<typeof agentPaneStoredSessionSchema>;
export type UpsertAgentPaneStoredSessionInput = z.infer<typeof upsertAgentPaneStoredSessionInputSchema>;
export type AgentPaneSession = z.infer<typeof agentPaneSessionSchema>;
export type CreateAgentPaneSessionInput = z.infer<typeof createAgentPaneSessionInputSchema>;
export type AgentPaneSendMessageInput = z.infer<typeof agentPaneSendMessageInputSchema>;
export type AgentPaneInterruptInput = z.infer<typeof agentPaneInterruptInputSchema>;
export type AgentPaneSettingsInput = z.infer<typeof agentPaneSettingsInputSchema>;
export type AgentRuntimeCapability = z.infer<typeof agentRuntimeCapabilitySchema>;
export type AgentRuntimeStatus = z.infer<typeof agentRuntimeStatusSchema>;
export type AgentRuntimeAdapterStatus = z.infer<typeof agentRuntimeAdapterStatusSchema>;
export type AgentRuntimeAuthMode = z.infer<typeof agentRuntimeAuthModeSchema>;
export type AgentRuntimeAuthState = z.infer<typeof agentRuntimeAuthStateSchema>;
export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;
export type AgentRuntimeRegistry = z.infer<typeof agentRuntimeRegistrySchema>;
export type CliToggleRuntimeId = z.infer<typeof cliToggleRuntimeIdSchema>;
export type CliRuntimeSetting = z.infer<typeof cliRuntimeSettingSchema>;
export type CliRuntimeSettingsResponse = z.infer<typeof cliRuntimeSettingsResponseSchema>;
export type CliRuntimeDisablePreview = z.infer<typeof cliRuntimeDisablePreviewSchema>;
export type UpdateCliRuntimeSettingInput = z.infer<typeof updateCliRuntimeSettingInputSchema>;
export type CliRuntimeCleanupResult = z.infer<typeof cliRuntimeCleanupResultSchema>;
export type UpdateCliRuntimeSettingResult = z.infer<typeof updateCliRuntimeSettingResultSchema>;
export type AdminOperationType = z.infer<typeof adminOperationTypeSchema>;
export type AdminOperationStatus = z.infer<typeof adminOperationStatusSchema>;
export type AdminOperationRun = z.infer<typeof adminOperationRunSchema>;
export type CreateAdminOperationRunInput = z.infer<typeof createAdminOperationRunInputSchema>;
export type UpdateAdminOperationRunInput = z.infer<typeof updateAdminOperationRunInputSchema>;
export type CliMaintenanceRequest = z.infer<typeof cliMaintenanceRequestSchema>;
export type CliMaintenanceCheckStatus = z.infer<typeof cliMaintenanceCheckStatusSchema>;
export type CliMaintenanceRuntimeResult = z.infer<typeof cliMaintenanceRuntimeResultSchema>;
export type SourceControlProvider = z.infer<typeof sourceControlProviderSchema>;
export type SourceControlConnectionStatus = z.infer<typeof sourceControlConnectionStatusSchema>;
export type SourceControlVerificationCode = z.infer<typeof sourceControlVerificationCodeSchema>;
export type SourceControlConnection = z.infer<typeof sourceControlConnectionSchema>;
export type UpdateSourceControlConnectionInput = z.infer<typeof updateSourceControlConnectionInputSchema>;
export type ReleaseTag = z.infer<typeof releaseTagSchema>;
export type ReleasePreview = z.infer<typeof releasePreviewSchema>;
export type CreateReleasePreviewInput = z.infer<typeof createReleasePreviewInputSchema>;
export type CreateReleaseRequest = z.infer<typeof createReleaseRequestSchema>;
export type PaneCliSessionStatus = z.infer<typeof paneCliSessionStatusSchema>;
export type PaneCliSessionLaunchMode = z.infer<typeof paneCliSessionLaunchModeSchema>;
export type PaneCliSessionPurpose = z.infer<typeof paneCliSessionPurposeSchema>;
export type PaneCliTranscriptStream = z.infer<typeof paneCliTranscriptStreamSchema>;
export type PaneCliSession = z.infer<typeof paneCliSessionSchema>;
export type CreatePaneCliSessionInput = z.input<typeof createPaneCliSessionInputSchema>;
export type UpdatePaneCliSessionInput = z.infer<typeof updatePaneCliSessionInputSchema>;
export type PaneCliTranscriptChunk = z.infer<typeof paneCliTranscriptChunkSchema>;
export type CreatePaneCliTranscriptChunkInput = z.input<typeof createPaneCliTranscriptChunkInputSchema>;
export type CreatePaneCliHostOutputInput = z.infer<typeof createPaneCliHostOutputInputSchema>;
export type PaneCliCodexThreadOwnershipSource = z.infer<typeof paneCliCodexThreadOwnershipSourceSchema>;
export type PaneCliCodexThreadOwnership = z.infer<typeof paneCliCodexThreadOwnershipSchema>;
export type CreatePaneCliSessionRequest = z.infer<typeof createPaneCliSessionRequestSchema>;
export type CliLoginRequest = z.infer<typeof cliLoginRequestSchema>;
export type ResumePaneCliSessionRequest = z.infer<typeof resumePaneCliSessionRequestSchema>;
export type PaneCliInterruptInput = z.infer<typeof paneCliInterruptInputSchema>;
export type PaneCliWebSocketToken = z.infer<typeof paneCliWebSocketTokenSchema>;
export type PaneCliTurnActivityStatus = z.infer<typeof paneCliTurnActivityStatusSchema>;
export type PaneCliTurnActivityResponse = z.infer<typeof paneCliTurnActivityResponseSchema>;
export type PaneCliWebSocketClientMessage = z.infer<typeof paneCliWebSocketClientMessageSchema>;
export type PaneCliWebSocketServerMessage = z.infer<typeof paneCliWebSocketServerMessageSchema>;
export type PaneCliSessionResponse = z.infer<typeof paneCliSessionResponseSchema>;
export type CliLoginResponse = z.infer<typeof cliLoginResponseSchema>;
export type PaneCliModelOption = z.infer<typeof paneCliModelOptionSchema>;
export type PaneCliModelSettings = z.infer<typeof paneCliModelSettingsSchema>;
export type PaneCliModelSettingsStatus = z.infer<typeof paneCliModelSettingsStatusSchema>;
export type UpdatePaneCliModelSettingsInput = z.infer<typeof updatePaneCliModelSettingsInputSchema>;
export type UpdatePaneCliModelSettingsResult = z.infer<typeof updatePaneCliModelSettingsResultSchema>;
export type CodexCliModeDefaultPair = z.infer<typeof codexCliModeDefaultPairSchema>;
export type CodexCliModeDefaultPairs = z.infer<typeof codexCliModeDefaultPairsSchema>;
export type CodexCliModeDefaults = z.infer<typeof codexCliModeDefaultsSchema>;
export type UpdateCodexCliModeDefaultsInput = z.infer<typeof updateCodexCliModeDefaultsInputSchema>;
export type CodexCliModeDefaultsCatalog = z.infer<typeof codexCliModeDefaultsCatalogSchema>;
export type CodexCliModeDefaultsResponse = z.infer<typeof codexCliModeDefaultsResponseSchema>;
export type CodexCliModeDefaultsProjection = z.infer<typeof codexCliModeDefaultsProjectionSchema>;
export type ResumePaneCliSessionResponse = z.infer<typeof resumePaneCliSessionResponseSchema>;
export type PaneCliUploadSource = z.infer<typeof paneCliUploadSourceSchema>;
export type PaneCliUploadedFile = z.infer<typeof paneCliUploadedFileSchema>;
export type PaneCliUploadResponse = z.infer<typeof paneCliUploadResponseSchema>;
export type BrowserSessionViewport = z.infer<typeof browserSessionViewportSchema>;
export type BrowserSessionStatus = z.infer<typeof browserSessionStatusSchema>;
export type BrowserStreamMode = z.infer<typeof browserStreamModeSchema>;
export type BrowserResolvedStreamMode = z.infer<typeof browserResolvedStreamModeSchema>;
export type BrowserRuntimeState = z.infer<typeof browserRuntimeStateSchema>;
export type BrowserCapacityState = z.infer<typeof browserCapacityStateSchema>;
export type BrowserControlState = z.infer<typeof browserControlStateSchema>;
export type BrowserRuntimeInput = z.infer<typeof browserRuntimeInputSchema>;
export type BrowserPageSummary = z.infer<typeof browserPageSummarySchema>;
export type PaneBrowserSession = z.infer<typeof paneBrowserSessionSchema>;
export type CreatePaneBrowserSessionInput = z.infer<typeof createPaneBrowserSessionInputSchema>;
export type UpdatePaneBrowserSessionInput = z.infer<typeof updatePaneBrowserSessionInputSchema>;
export type CreatePaneBrowserSessionRequest = z.infer<typeof createPaneBrowserSessionRequestSchema>;
export type UpdatePaneBrowserSessionRequest = z.infer<typeof updatePaneBrowserSessionRequestSchema>;
export type UpdateBrowserStreamModeInput = z.infer<typeof updateBrowserStreamModeInputSchema>;
export type BrowserPageListResponse = z.infer<typeof browserPageListResponseSchema>;
export type CreateBrowserPageInput = z.infer<typeof createBrowserPageInputSchema>;
export type ActivateBrowserPageInput = z.infer<typeof activateBrowserPageInputSchema>;
export type BrowserControlHolderType = z.infer<typeof browserControlHolderTypeSchema>;
export type BrowserControlLeaseStatus = z.infer<typeof browserControlLeaseStatusSchema>;
export type BrowserControlLease = z.infer<typeof browserControlLeaseSchema>;
export type CreateBrowserControlLeaseInput = z.infer<typeof createBrowserControlLeaseInputSchema>;
export type UpdateBrowserControlLeaseInput = z.infer<typeof updateBrowserControlLeaseInputSchema>;
export type AcquireBrowserControlInput = z.infer<typeof acquireBrowserControlInputSchema>;
export type BrowserControlLeaseActionInput = z.infer<typeof browserControlLeaseActionInputSchema>;
export type BrowserControlLeaseResponse = z.infer<typeof browserControlLeaseResponseSchema>;
export type BrowserCaptureJobStatus = z.infer<typeof browserCaptureJobStatusSchema>;
export type BrowserScreenshotCaptureOptions = z.infer<typeof browserScreenshotCaptureOptionsSchema>;
export type BrowserRecordingCaptureOptions = z.infer<typeof browserRecordingCaptureOptionsSchema>;
export type BrowserCaptureOptions = z.infer<typeof browserCaptureOptionsSchema>;
export type BrowserCaptureJob = z.infer<typeof browserCaptureJobSchema>;
export type CreateBrowserCaptureJobInput = z.infer<typeof createBrowserCaptureJobInputSchema>;
export type CreateBrowserCaptureJobRequest = z.infer<typeof createBrowserCaptureJobRequestSchema>;
export type UpdateBrowserCaptureJobInput = z.infer<typeof updateBrowserCaptureJobInputSchema>;
export type BrowserCaptureJobResponse = z.infer<typeof browserCaptureJobResponseSchema>;
export type StopBrowserCaptureInput = z.infer<typeof stopBrowserCaptureInputSchema>;
export type CancelBrowserCaptureInput = z.infer<typeof cancelBrowserCaptureInputSchema>;
export type BrowserCaptureCommandInput = z.infer<typeof browserCaptureCommandInputSchema>;
export type BrowserCaptureSegmentStatus = z.infer<typeof browserCaptureSegmentStatusSchema>;
export type BrowserCaptureSegment = z.infer<typeof browserCaptureSegmentSchema>;
export interface BrowserCaptureMetrics {
  jobs: {
    QUEUED: number;
    RUNNING: number;
    COMPLETED: number;
    FAILED: number;
    CANCELLED: number;
  };
  segments: {
    OPEN: number;
    FINALIZED: number;
    FAILED: number;
    DISCARDED: number;
  };
}
export type CreateBrowserCaptureSegmentInput = z.infer<typeof createBrowserCaptureSegmentInputSchema>;
export type UpdateBrowserCaptureSegmentInput = z.infer<typeof updateBrowserCaptureSegmentInputSchema>;
export type BrowserCaptureSegmentListResponse = z.infer<typeof browserCaptureSegmentListResponseSchema>;
export type BrowserHandoffStatus = z.infer<typeof browserHandoffStatusSchema>;
export type BrowserOperatorRole = z.infer<typeof browserOperatorRoleSchema>;
export type BrowserHandoffRequest = z.infer<typeof browserHandoffRequestSchema>;
export type CreateBrowserHandoffRequestInput = z.infer<typeof createBrowserHandoffRequestInputSchema>;
export type UpdateBrowserHandoffRequestInput = z.infer<typeof updateBrowserHandoffRequestInputSchema>;
export type BrowserHandoffRequestResponse = z.infer<typeof browserHandoffRequestResponseSchema>;
export type BrowserTimelineEventType = z.infer<typeof browserTimelineEventTypeSchema>;
export type BrowserTimelineEventSummary = z.infer<typeof browserTimelineEventSummarySchema>;
export type BrowserDiagnosticsResponse = z.infer<typeof browserDiagnosticsResponseSchema>;
export type BrowserRecordingFrameSummary = z.infer<typeof browserRecordingFrameSummarySchema>;
export type BrowserCaptureTimelineResponse = z.infer<typeof browserCaptureTimelineResponseSchema>;
export type BrowserFrame = z.infer<typeof browserFrameSchema>;
export type BrowserFrameToken = z.infer<typeof browserFrameTokenSchema>;
export type BrowserStreamTicketResponse = z.infer<typeof browserStreamTicketResponseSchema>;
export type BrowserStreamWebSocketClientMessage = z.infer<typeof browserStreamWebSocketClientMessageSchema>;
export type BrowserStreamInputAck = z.infer<typeof browserStreamInputAckSchema>;
export type BrowserStreamWebSocketServerMessage = z.infer<typeof browserStreamWebSocketServerMessageSchema>;
export type PaneBrowserSessionResponse = z.infer<typeof paneBrowserSessionResponseSchema>;
export type BrowserBookmark = z.infer<typeof browserBookmarkSchema>;
export type BrowserBookmarkListResponse = z.infer<typeof browserBookmarkListResponseSchema>;
export type BrowserBookmarkImportResponse = z.infer<typeof browserBookmarkImportResponseSchema>;
export type CreateBrowserBookmarkInput = z.infer<typeof createBrowserBookmarkInputSchema>;
export type OpenBrowserBookmarkInput = z.infer<typeof openBrowserBookmarkInputSchema>;
export type BrowserNavigateInput = z.infer<typeof browserNavigateInputSchema>;
export type BrowserSetViewportInput = z.infer<typeof browserSetViewportInputSchema>;
export type BrowserToolActionType = z.infer<typeof browserToolActionTypeSchema>;
export type BrowserToolActionInput = z.infer<typeof browserToolActionInputSchema>;
export type BrowserToolActionResult = z.infer<typeof browserToolActionResultSchema>;
export type SpaceBrowserToolId = z.infer<typeof spaceBrowserToolIdSchema>;
export type SpaceAgentBrowserActionRequest = z.infer<typeof spaceAgentBrowserActionRequestSchema>;
export type SpaceAgentBrowserActionEnvelope = z.infer<typeof spaceAgentBrowserActionEnvelopeSchema>;
export type SpaceAgentBrowserActionBridgeRequest = z.infer<typeof spaceAgentBrowserActionBridgeRequestSchema>;
export type SpaceAgentBrowserActionObservation = z.infer<typeof spaceAgentBrowserActionObservationSchema>;
export type SpaceAgentBrowserActionExecutionResult = z.infer<typeof spaceAgentBrowserActionExecutionResultSchema>;
export type SpaceAgentBrowserActionBridgeResponse = z.infer<typeof spaceAgentBrowserActionBridgeResponseSchema>;
export type SpaceCliBrowserSessionSummary = z.infer<typeof spaceCliBrowserSessionSummarySchema>;
export type SpaceCliBrowserContextResponse = z.infer<typeof spaceCliBrowserContextResponseSchema>;
export type SpaceCliBrowserSessionStartRequest = z.infer<typeof spaceCliBrowserSessionStartRequestSchema>;
export type SpaceCliBrowserSessionStartResponse = z.infer<typeof spaceCliBrowserSessionStartResponseSchema>;
export type SpaceCliBrowserActionBridgeRequest = z.infer<typeof spaceCliBrowserActionBridgeRequestSchema>;
export type SpaceCliBrowserActionBridgeResponse = z.infer<typeof spaceCliBrowserActionBridgeResponseSchema>;
export type SpaceCliBrowserCommand = z.infer<typeof spaceCliBrowserCommandSchema>;
export type SpaceCliBrowserCommandRequest = z.infer<typeof spaceCliBrowserCommandRequestSchema>;
export type BrowserFrameWebSocketServerMessage = z.infer<typeof browserFrameWebSocketServerMessageSchema>;
export type SpaceAgentSessionRecord = z.infer<typeof spaceAgentSessionRecordSchema>;
export type CreateSpaceAgentSessionInput = z.infer<typeof createSpaceAgentSessionInputSchema>;
export type UpdateSpaceAgentSessionInput = z.infer<typeof updateSpaceAgentSessionInputSchema>;
export type SpaceAgentMessageRecord = z.infer<typeof spaceAgentMessageRecordSchema>;
export type CreateSpaceAgentMessageInput = z.infer<typeof createSpaceAgentMessageInputSchema>;
export type UpdateSpaceAgentMessageInput = z.infer<typeof updateSpaceAgentMessageInputSchema>;
export type SpaceAgentRunRecord = z.infer<typeof spaceAgentRunRecordSchema>;
export type CreateSpaceAgentRunInput = z.infer<typeof createSpaceAgentRunInputSchema>;
export type UpdateSpaceAgentRunInput = z.infer<typeof updateSpaceAgentRunInputSchema>;
export type CoderAgentProxyResource = z.infer<typeof coderAgentProxyResourceSchema>;
export type CoderAgentProxyMethod = z.infer<typeof coderAgentProxyMethodSchema>;
export type CoderAgentProxyRequest = z.infer<typeof coderAgentProxyRequestSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export type UpdateProviderSettingsInput = z.infer<typeof updateProviderSettingsInputSchema>;
export type VoiceTranscriptionModel = z.infer<typeof voiceTranscriptionModelSchema>;
export type VoiceTranscriptionLanguage = z.infer<typeof voiceTranscriptionLanguageSchema>;
export type VoiceTranscriptionDelay = z.infer<typeof voiceTranscriptionDelaySchema>;
export type VoiceTranscriptionSettings = z.infer<typeof voiceTranscriptionSettingsSchema>;
export type VoiceTranscriptionRequestFields = z.infer<typeof voiceTranscriptionRequestFieldsSchema>;
export type VoiceTranscriptionResponse = z.infer<typeof voiceTranscriptionResponseSchema>;
export type VoiceRealtimeSessionRequest = z.infer<typeof voiceRealtimeSessionRequestSchema>;
export type VoiceRealtimeSessionResponse = z.infer<typeof voiceRealtimeSessionResponseSchema>;
export type CreateProviderInput = z.infer<typeof createProviderInputSchema>;
export type UpdateProviderInput = z.infer<typeof updateProviderInputSchema>;
export type ProviderValidationResult = z.infer<typeof providerValidationResultSchema>;
export type CodexAppServerStatus = z.infer<typeof codexAppServerStatusSchema>;
export type CodexAppServerHandshakeCheck = z.infer<typeof codexAppServerHandshakeCheckSchema>;
export type CodexAppServerTurnSmokeInput = z.infer<typeof codexAppServerTurnSmokeInputSchema>;
export type CodexAppServerTurnSmokeResult = z.infer<typeof codexAppServerTurnSmokeResultSchema>;
export type CodexAppServerTurnSmokeCheck = z.infer<typeof codexAppServerTurnSmokeCheckSchema>;
export type CodexHistoryItem = z.infer<typeof codexHistoryItemSchema>;
export type CliTaskHistoryItem = z.infer<typeof cliTaskHistoryItemSchema>;
export type CliTaskHistoryResponse = z.infer<typeof cliTaskHistoryResponseSchema>;
export type CodexHistoryResponse = z.infer<typeof codexHistoryResponseSchema>;
export type CodexThreadPresentation = z.infer<typeof codexThreadPresentationSchema>;
export type CodexThreadItem = z.infer<typeof codexThreadItemSchema>;
export type CodexThreadResponse = z.infer<typeof codexThreadResponseSchema>;
export type CodexEnvironment = z.infer<typeof codexEnvironmentSchema>;
export type CodexUsageAccount = z.infer<typeof codexUsageAccountSchema>;
export type CodexUsageAccountList = z.infer<typeof codexUsageAccountListSchema>;
export type CliSessionDetail = z.infer<typeof cliSessionDetailSchema>;
export type CliSessionStats = z.infer<typeof cliSessionStatsSchema>;
export type CliSessionReapResponse = z.infer<typeof cliSessionReapResponseSchema>;
export type HostMemorySummary = z.infer<typeof hostMemorySummarySchema>;
export type HostMemoryDetails = z.infer<typeof hostMemoryDetailsSchema>;
export type MemoryReclaimResponse = z.infer<typeof memoryReclaimResponseSchema>;
export type ProviderSwitchTarget = z.infer<typeof providerSwitchTargetSchema>;
export type ProviderSwitchTargets = z.infer<typeof providerSwitchTargetsSchema>;
export type ProviderSwitchRequest = z.infer<typeof providerSwitchRequestSchema>;
export type ProviderSwitchResponse = z.infer<typeof providerSwitchResponseSchema>;
export type CodexLbSpeedTier = z.infer<typeof codexLbSpeedTierSchema>;
export type CodexLbSpeedDefaultUpdateRequest = z.infer<typeof codexLbSpeedDefaultUpdateRequestSchema>;
export type CodexLbSpeedDefaultsResponse = z.infer<typeof codexLbSpeedDefaultsResponseSchema>;
export type CodexHistoryPurgePreviewRequest = z.infer<typeof codexHistoryPurgePreviewRequestSchema>;
export type CodexHistoryPurgePreviewResponse = z.infer<typeof codexHistoryPurgePreviewResponseSchema>;
export type CodexHistoryPurgeExecuteRequest = z.infer<typeof codexHistoryPurgeExecuteRequestSchema>;
export type CodexHistoryPurgeResponse = z.infer<typeof codexHistoryPurgeResponseSchema>;
export type Model = z.infer<typeof modelSchema>;
export type Event = z.infer<typeof eventSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type CreateAuditEventInput = z.infer<typeof createAuditEventInputSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type ObservabilityDurationSummary = z.infer<typeof observabilityDurationSummarySchema>;
export type ObservabilityEndpointMetric = z.infer<typeof observabilityEndpointMetricSchema>;
export type ObservabilitySnapshot = z.infer<typeof observabilitySnapshotSchema>;
export type WorkerReadinessStatus = z.infer<typeof workerReadinessStatusSchema>;
export type WorkerReadiness = z.infer<typeof workerReadinessSchema>;
export type StorageReadinessStatus = z.infer<typeof storageReadinessStatusSchema>;
export type StorageReadinessMount = z.infer<typeof storageReadinessMountSchema>;
export type StorageReadiness = z.infer<typeof storageReadinessSchema>;
export type McpRiskLevel = z.infer<typeof mcpRiskLevelSchema>;
export type McpTransport = z.infer<typeof mcpTransportSchema>;
export type McpApprovalMode = z.infer<typeof mcpApprovalModeSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpGatewayStatus = z.infer<typeof mcpGatewayStatusSchema>;
export type McpServer = z.infer<typeof mcpServerSchema>;
export type McpTool = z.infer<typeof mcpToolSchema>;
export type SpaceCapabilitySnapshot = z.infer<typeof spaceCapabilitySnapshotSchema>;
export type SpaceCapabilitySource = z.infer<typeof spaceCapabilitySourceSchema>;
export type SpaceCapabilityMcpServer = z.infer<typeof spaceCapabilityMcpServerSchema>;
export type SpaceCapabilitySkill = z.infer<typeof spaceCapabilitySkillSchema>;
export type SpaceCapabilityMemory = z.infer<typeof spaceCapabilityMemorySchema>;
export type SpaceCapabilityVsCodeExtension = z.infer<typeof spaceCapabilityVsCodeExtensionSchema>;
export type SpaceCapabilityCliRuntime = z.infer<typeof spaceCapabilityCliRuntimeSchema>;
export type SpaceCapabilityCodexLbRoute = z.infer<typeof spaceCapabilityCodexLbRouteSchema>;
export type SpaceCapabilityGate = z.infer<typeof spaceCapabilityGateSchema>;
export type PaneCapabilityExecution = z.infer<typeof paneCapabilityExecutionSchema>;
export type PaneCapabilityItem = z.infer<typeof paneCapabilityItemSchema>;
export type PaneCapabilityGroup = z.infer<typeof paneCapabilityGroupSchema>;
export type PaneCapabilityMatrix = z.infer<typeof paneCapabilityMatrixSchema>;
export type McpDiscoverySmokeResult = z.infer<typeof mcpDiscoverySmokeResultSchema>;
export type McpDiscoverySmokeCheck = z.infer<typeof mcpDiscoverySmokeCheckSchema>;
export type McpToolPolicyDecision = z.infer<typeof mcpToolPolicyDecisionSchema>;
export type CreateMcpToolExecutionInput = z.infer<typeof createMcpToolExecutionInputSchema>;
export type McpToolExecutionResult = z.infer<typeof mcpToolExecutionResultSchema>;
export type SpaceAgentMcpActionEnvelope = z.infer<typeof spaceAgentMcpActionEnvelopeSchema>;
export type SpaceAgentMcpActionBridgeRequest = z.infer<typeof spaceAgentMcpActionBridgeRequestSchema>;
export type SpaceAgentMcpActionBridgeResponse = z.infer<typeof spaceAgentMcpActionBridgeResponseSchema>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export type Turn = z.infer<typeof turnSchema>;
export type TurnRuntime = z.infer<typeof turnRuntimeSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type DeleteRoomMediaResponse = z.infer<typeof deleteRoomMediaResponseSchema>;
export type CreateArtifactInput = z.infer<typeof createArtifactInputSchema>;
export type ListArtifactsQuery = z.infer<typeof listArtifactsQuerySchema>;
export type UpdateArtifactRetentionInput = z.infer<typeof updateArtifactRetentionInputSchema>;
export type CreateTurnInput = z.infer<typeof createTurnInputSchema>;
export type ListTurnsQuery = z.infer<typeof listTurnsQuerySchema>;
export type TurnStartResult = z.infer<typeof turnStartResultSchema>;
export type DummyTurnInput = z.infer<typeof dummyTurnInputSchema>;
export type RoomAgentSupervisorQueueItem = z.infer<typeof roomAgentSupervisorQueueItemSchema>;
export type RoomAgentSupervisorInput = z.infer<typeof roomAgentSupervisorInputSchema>;
export type RoomAgentSupervisorStopSignal = z.infer<typeof roomAgentSupervisorStopSignalSchema>;
export type DummyTurnResult = z.infer<typeof dummyTurnResultSchema>;
export type TurnWorkflowResult = z.infer<typeof turnWorkflowResultSchema>;
export type RoomAgentTurnOutcome = z.infer<typeof roomAgentTurnOutcomeSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemorySearchMode = z.infer<typeof memorySearchModeSchema>;
export type MemorySearchStatus = z.infer<typeof memorySearchStatusSchema>;
export type SpaceAgentMemoryActionEnvelope = z.infer<typeof spaceAgentMemoryActionEnvelopeSchema>;
export type SpaceMemoryToolId = z.infer<typeof spaceMemoryToolIdSchema>;
export type SpaceAgentClipboardActionEnvelope = z.infer<typeof spaceAgentClipboardActionEnvelopeSchema>;
export type SpaceClipboardToolId = z.infer<typeof spaceClipboardToolIdSchema>;
export type MemoryEmbeddingSmokeCode = z.infer<typeof memoryEmbeddingSmokeCodeSchema>;
export type MemoryEmbeddingSmokeResult = z.infer<typeof memoryEmbeddingSmokeResultSchema>;
export type MemoryEmbeddingSmokeCheck = z.infer<typeof memoryEmbeddingSmokeCheckSchema>;
export type MemoryVectorReadinessCode = z.infer<typeof memoryVectorReadinessCodeSchema>;
export type MemoryVectorReadiness = z.infer<typeof memoryVectorReadinessSchema>;
export type MemoryGraphNodeType = z.infer<typeof memoryGraphNodeTypeSchema>;
export type MemoryGraphEdgeType = z.infer<typeof memoryGraphEdgeTypeSchema>;
export type MemoryGraphTopicOrigin = z.infer<typeof memoryGraphTopicOriginSchema>;
export type MemoryGraphEdgeOrigin = z.infer<typeof memoryGraphEdgeOriginSchema>;
export type MemoryGraphTopicAssignment = z.infer<typeof memoryGraphTopicAssignmentSchema>;
export type MemoryLifecycleStatus = z.infer<typeof memoryLifecycleStatusSchema>;
export type MemoryIssueType = z.infer<typeof memoryIssueTypeSchema>;
export type MemoryIssueSeverity = z.infer<typeof memoryIssueSeveritySchema>;
export type MemoryIssueStatus = z.infer<typeof memoryIssueStatusSchema>;
export type MemoryGraphRecord = z.infer<typeof memoryGraphRecordSchema>;
export type MemoryGraphNode = z.infer<typeof memoryGraphNodeSchema>;
export type MemoryGraphEdge = z.infer<typeof memoryGraphEdgeSchema>;
export type MemoryGraphIssue = z.infer<typeof memoryGraphIssueSchema>;
export type MemoryGraphSummary = z.infer<typeof memoryGraphSummarySchema>;
export type MemoryGraphPayload = z.infer<typeof memoryGraphPayloadSchema>;
export type MemoryGraphOverviewPayload = z.infer<typeof memoryGraphOverviewPayloadSchema>;
export type MemoryGraphSnapshot = z.infer<typeof memoryGraphSnapshotSchema>;
export type MemoryGraphNodeDetail = z.infer<typeof memoryGraphNodeDetailSchema>;
export type ListMemoryGraphQuery = z.infer<typeof listMemoryGraphQuerySchema>;
export type ListMemoryGraphOverviewQuery = z.infer<typeof listMemoryGraphOverviewQuerySchema>;
export type ListMemoryIssuesQuery = z.infer<typeof listMemoryIssuesQuerySchema>;
export type PatchMemoryIssueInput = z.infer<typeof patchMemoryIssueInputSchema>;
export type MemoryCacheLinkSource = z.infer<typeof memoryCacheLinkSourceSchema>;
export type MemoryCacheLink = z.infer<typeof memoryCacheLinkSchema>;
export type LinkMemoryCacheInput = z.infer<typeof linkMemoryCacheInputSchema>;
export type ListMemoryCacheLinksQuery = z.infer<typeof listMemoryCacheLinksQuerySchema>;
export type MemoryIssueState = z.infer<typeof memoryIssueStateSchema>;
export type UpsertMemoryIssueStateInput = z.infer<typeof upsertMemoryIssueStateInputSchema>;
export type ListMemoryIssueStatesQuery = z.infer<typeof listMemoryIssueStatesQuerySchema>;
export type MemoryConsolidationMode = z.infer<typeof memoryConsolidationModeSchema>;
export type MemoryConsolidationTrigger = z.infer<typeof memoryConsolidationTriggerSchema>;
export type MemoryConsolidationStatus = z.infer<typeof memoryConsolidationStatusSchema>;
export type CreateMemoryConsolidationInput = z.infer<typeof createMemoryConsolidationInputSchema>;
export type MemoryConsolidationRun = z.infer<typeof memoryConsolidationRunSchema>;
export type CreateMemoryConsolidationRunInput = z.infer<typeof createMemoryConsolidationRunInputSchema>;
export type UpdateMemoryConsolidationRunInput = z.infer<typeof updateMemoryConsolidationRunInputSchema>;
export type MemoryConsolidationFinding = z.infer<typeof memoryConsolidationFindingSchema>;
export type CreateMemoryConsolidationFindingInput = z.infer<typeof createMemoryConsolidationFindingInputSchema>;
export type UpdateMemoryConsolidationFindingInput = z.infer<typeof updateMemoryConsolidationFindingInputSchema>;
export type MemoryConsolidationOperationKind = z.infer<typeof memoryConsolidationOperationKindSchema>;
export type MemoryConsolidationOperationStatus = z.infer<typeof memoryConsolidationOperationStatusSchema>;
export type MemoryConsolidationOperation = z.infer<typeof memoryConsolidationOperationSchema>;
export type CreateMemoryConsolidationOperationInput = z.infer<typeof createMemoryConsolidationOperationInputSchema>;
export type UpdateMemoryConsolidationOperationInput = z.infer<typeof updateMemoryConsolidationOperationInputSchema>;
export type MemoryConsolidationSchedule = z.infer<typeof memoryConsolidationScheduleSchema>;
export type MemoryConsolidationCommandResponse = z.infer<typeof memoryConsolidationCommandResponseSchema>;
export type MemoryConsolidationDetail = z.infer<typeof memoryConsolidationDetailSchema>;
export type MemoryConsolidationWorkflowInput = z.infer<typeof memoryConsolidationWorkflowInputSchema>;
export type MemoryAiAuditSuggestion = z.infer<typeof memoryAiAuditSuggestionSchema>;
export type MemoryAiAuditResponse = z.infer<typeof memoryAiAuditResponseSchema>;
export type MemoryAiAuditResult = z.infer<typeof memoryAiAuditResultSchema>;
export type MemoryCommandIdempotency = z.infer<typeof memoryCommandIdempotencySchema>;
export type ClaimMemoryCommandInput = z.infer<typeof claimMemoryCommandInputSchema>;
export type MemoryCommandClaim = z.infer<typeof memoryCommandClaimSchema>;
export type MemoryChangeKind = z.infer<typeof memoryChangeKindSchema>;
export type MemoryChangeStatus = z.infer<typeof memoryChangeStatusSchema>;
export type MemoryChangeSet = z.infer<typeof memoryChangeSetSchema>;
export type MemoryChangeSetSummary = z.infer<typeof memoryChangeSetSummarySchema>;
export type CreateMemoryChangeSetInput = z.infer<typeof createMemoryChangeSetInputSchema>;
export type CreateMemoryNodeChangeSetInput = z.infer<typeof createMemoryNodeChangeSetInputSchema>;
export type CreateMemoryRollbackInput = z.infer<typeof createMemoryRollbackInputSchema>;
export type MemoryChangeSetCommandInput = z.infer<typeof memoryChangeSetCommandInputSchema>;
export type UpdateMemoryChangeSetInput = z.infer<typeof updateMemoryChangeSetInputSchema>;
export type ListMemoryChangeSetsQuery = z.infer<typeof listMemoryChangeSetsQuerySchema>;
export type MemoryMaintenanceInput = z.infer<typeof memoryMaintenanceInputSchema>;
export type MemoryMaintenanceResult = z.infer<typeof memoryMaintenanceResultSchema>;
export type MemoryMutationJournalPhase = z.infer<typeof memoryMutationJournalPhaseSchema>;
export type MemoryMutationJournal = z.infer<typeof memoryMutationJournalSchema>;
export type MemoryMutationExecutionResult = z.infer<typeof memoryMutationExecutionResultSchema>;
export type MemoryMutationRecoveryResult = z.infer<typeof memoryMutationRecoveryResultSchema>;
export type MemoryMutationWorkflowInput = z.infer<typeof memoryMutationWorkflowInputSchema>;
export type MemoryMutationWorkflowResult = z.infer<typeof memoryMutationWorkflowResultSchema>;
export type CreateMemoryEntryInput = z.infer<typeof createMemoryEntryInputSchema>;
export type ListMemoryQuery = Omit<z.infer<typeof listMemoryQuerySchema>, "searchMode"> & { searchMode?: MemorySearchMode };
export type Skill = z.infer<typeof skillSchema>;
export type CreateSkillProposalInput = z.infer<typeof createSkillProposalInputSchema>;
export type SpaceSkillToolId = z.infer<typeof spaceSkillToolIdSchema>;
export type SpaceAgentSkillActionEnvelope = z.infer<typeof spaceAgentSkillActionEnvelopeSchema>;
export type SpaceAgentSkillActionBridgeRequest = z.infer<typeof spaceAgentSkillActionBridgeRequestSchema>;
export type SpaceAgentSkillActionBridgeResponse = z.infer<typeof spaceAgentSkillActionBridgeResponseSchema>;
export type ImportSourceKind = z.infer<typeof importSourceKindSchema>;
export type ImportTargetKind = z.infer<typeof importTargetKindSchema>;
export type ImportCandidateStatus = z.infer<typeof importCandidateStatusSchema>;
export type ImportCandidate = z.infer<typeof importCandidateSchema>;
export type CreateImportCandidateInput = z.infer<typeof createImportCandidateInputSchema>;
export type ImportCandidateDecisionInput = z.infer<typeof importCandidateDecisionInputSchema>;
export type ListImportCandidatesQuery = z.infer<typeof listImportCandidatesQuerySchema>;
export type ImportCandidateDecisionResult = z.infer<typeof importCandidateDecisionResultSchema>;
export type BrowserSession = z.infer<typeof browserSessionSchema>;
export type BrowserEvidenceViewport = z.infer<typeof browserEvidenceViewportSchema>;
export type CreateBrowserEvidenceInput = z.infer<typeof createBrowserEvidenceInputSchema>;
export type BrowserEvidenceCapture = z.infer<typeof browserEvidenceCaptureSchema>;
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
export type CreateReviewDecisionInput = z.infer<typeof createReviewDecisionInputSchema>;
export type ListReviewDecisionsQuery = z.infer<typeof listReviewDecisionsQuerySchema>;
export type ReviewCheckStatus = z.infer<typeof reviewCheckStatusSchema>;
export type ReviewDiffStatus = z.infer<typeof reviewDiffStatusSchema>;
export type ReviewCheck = z.infer<typeof reviewCheckSchema>;
export type CreateReviewCheckInput = z.infer<typeof createReviewCheckInputSchema>;
export type ListReviewChecksQuery = z.infer<typeof listReviewChecksQuerySchema>;
export type ReviewDiffSummary = z.infer<typeof reviewDiffSummarySchema>;
export type CreateReviewDiffSummaryInput = z.infer<typeof createReviewDiffSummaryInputSchema>;
export type ListReviewDiffSummariesQuery = z.infer<typeof listReviewDiffSummariesQuerySchema>;
export type ReviewRoomState = z.infer<typeof reviewRoomStateSchema>;
export type LaunchReadinessRequirementStatus = z.infer<typeof launchReadinessRequirementStatusSchema>;
export type LaunchReadinessBlockerSeverity = z.infer<typeof launchReadinessBlockerSeveritySchema>;
export type LaunchReadinessEvidence = z.infer<typeof launchReadinessEvidenceSchema>;
export type LaunchReadinessRequirement = z.infer<typeof launchReadinessRequirementSchema>;
export type LaunchReadiness = z.infer<typeof launchReadinessSchema>;
export type SwarmTaskRole = z.infer<typeof swarmTaskRoleSchema>;
export type SwarmTaskStatus = z.infer<typeof swarmTaskStatusSchema>;
export type SwarmLockStatus = z.infer<typeof swarmLockStatusSchema>;
export type SwarmReconcileDecision = z.infer<typeof swarmReconcileDecisionSchema>;
export type SwarmExecutionStatus = z.infer<typeof swarmExecutionStatusSchema>;
export type SwarmTask = z.infer<typeof swarmTaskSchema>;
export type CreateSwarmTaskInput = z.infer<typeof createSwarmTaskInputSchema>;
export type UpdateSwarmTaskInput = z.infer<typeof updateSwarmTaskInputSchema>;
export type RunSwarmTaskInput = z.infer<typeof runSwarmTaskInputSchema>;
export type RunSwarmTaskResponse = z.infer<typeof runSwarmTaskResponseSchema>;
export type ListSwarmTasksQuery = z.infer<typeof listSwarmTasksQuerySchema>;
export type SwarmLock = z.infer<typeof swarmLockSchema>;
export type ClaimSwarmLockInput = z.infer<typeof claimSwarmLockInputSchema>;
export type ReleaseSwarmLockInput = z.infer<typeof releaseSwarmLockInputSchema>;
export type SwarmMessage = z.infer<typeof swarmMessageSchema>;
export type PostSwarmMessageInput = z.infer<typeof postSwarmMessageInputSchema>;
export type SwarmReconcile = z.infer<typeof swarmReconcileSchema>;
export type CreateSwarmReconcileInput = z.infer<typeof createSwarmReconcileInputSchema>;
export type SwarmState = z.infer<typeof swarmStateSchema>;
export type SharedTaskSource = z.infer<typeof sharedTaskSourceSchema>;
export type CodexGoalStatus = z.infer<typeof codexGoalStatusSchema>;
export type SpaceSwarmSharedTask = z.infer<typeof spaceSwarmSharedTaskSchema>;
export type CodexGoalSharedTask = z.infer<typeof codexGoalSharedTaskSchema>;
export type SharedTask = z.infer<typeof sharedTaskSchema>;
export type ListSharedTasksQuery = z.infer<typeof listSharedTasksQuerySchema>;
export type UpdateCodexGoalTaskInput = z.infer<typeof updateCodexGoalTaskInputSchema>;
export type AuthUser = z.infer<typeof authUserSchema>;
export type AuthMe = z.infer<typeof authMeSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
export type SetupStatus = z.infer<typeof setupStatusSchema>;
export type SetupClaimInput = z.infer<typeof setupClaimInputSchema>;
export type SetupClaimResponse = z.infer<typeof setupClaimResponseSchema>;
export type UserLinkOpenMode = z.infer<typeof userLinkOpenModeSchema>;
export type UserLink = z.infer<typeof userLinkSchema>;
export type CreateUserLinkRequest = z.infer<typeof createUserLinkRequestSchema>;
export type UpdateUserLinkRequest = z.infer<typeof updateUserLinkRequestSchema>;
export type ListUserLinksQuery = z.infer<typeof listUserLinksQuerySchema>;
export type UserLinkListResponse = z.infer<typeof userLinkListResponseSchema>;
export type TelegramConnectionStatus = z.infer<typeof telegramConnectionStatusSchema>;
export type TelegramIntegrationStatus = z.infer<typeof telegramIntegrationStatusSchema>;
export type CreateTelegramPairingInput = z.infer<typeof createTelegramPairingInputSchema>;
export type TelegramPairingResponse = z.infer<typeof telegramPairingResponseSchema>;
export type UpdateTelegramIntegrationInput = z.infer<typeof updateTelegramIntegrationInputSchema>;
