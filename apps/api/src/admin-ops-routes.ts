import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  codexAppServerTurnSmokeInputSchema, type LaunchReadinessRequirement, launchReadinessSchema,
  observabilitySnapshotSchema, paginationRequestSchema, serviceRestartRequestSchema, serviceRestartResponseSchema,
  spaceCapabilitySnapshotSchema, type StorageReadiness, storageReadinessSchema, systemHealthHistorySchema,
  systemHealthRangeSchema, systemHealthSnapshotSchema, systemTopologySnapshotSchema, workerReadinessSchema
} from "@space/contracts";
import { nowIso, type SpaceStore } from "@space/runtime";
import type { AuthConfig } from "./auth.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import { getCodexAppServerStatus, runCodexAppServerHandshake, runCodexAppServerTurnSmoke } from "./codex-app-server.js";
import type { SpaceApiConfig } from "./config.js";
import { sendApiError } from "./http-errors.js";
import { discoverMcpCatalog, type McpDiscoveryCatalog, runMcpDiscoverySmoke } from "./mcp.js";
import { runMemoryEmbeddingSmoke } from "./memory-embedding-smoke.js";
import type { createHttpObservability } from "./observability.js";
import { recordAudit } from "./request-audit.js";
import { parseBody, parseQuery } from "./route-parsing.js";
import {
  CORE_RESTART_SERVICES, CORE_SERVICE_RESTART_COMMAND, type CoreServiceRestarter, readServiceRestartCooldown,
  writeServiceRestartCooldown
} from "./service-restarts.js";
import type { SpaceCapabilityInventoryCollector } from "./space-capability-inventory.js";
import type { SystemHealthMonitor } from "./system-health-service.js";
import type { SystemTopologyService } from "./system-topology-service.js";
import type { WorkerReadinessChecker } from "./worker-readiness.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evidence(label: string, ref: string | null = null) {
  return { label, ref };
}

function passedRequirement(
  id: string,
  label: string,
  message: string,
  refs: Array<{ label: string; ref?: string | null }> = []
): LaunchReadinessRequirement {
  return {
    id,
    label,
    status: "PASS",
    severity: "none",
    message,
    evidence: refs.map((item) => evidence(item.label, item.ref ?? null))
  };
}

function gatedRequirement(
  id: string,
  label: string,
  status: "WARN" | "FAIL" | "MISSING",
  severity: "gate" | "hard",
  message: string,
  refs: Array<{ label: string; ref?: string | null }> = []
): LaunchReadinessRequirement {
  return {
    id,
    label,
    status,
    severity,
    message,
    evidence: refs.map((item) => evidence(item.label, item.ref ?? null))
  };
}

function hasCompletedCodexAppServerTurn(events: Awaited<ReturnType<SpaceStore["listEvents"]>>) {
  return events.find((event) => {
    if (event.type !== "TURN_COMPLETED") return false;
    const metadata = isRecord(event.payload.metadata) ? event.payload.metadata : null;
    const codexAppServer = metadata && isRecord(metadata.codexAppServer) ? metadata.codexAppServer : null;
    return codexAppServer?.turnStatus === "completed" || Boolean(codexAppServer?.turnId);
  });
}

function hasBrowserEvidenceSet(artifacts: Awaited<ReturnType<SpaceStore["listArtifacts"]>>) {
  const requiredKinds = new Set(["SCREENSHOT", "DOM_SNAPSHOT", "CONSOLE_LOG", "NETWORK_LOG"]);
  const groups = new Map<string, Set<string>>();
  for (const artifact of artifacts) {
    const captureId = typeof artifact.metadata.browserCaptureId === "string" ? artifact.metadata.browserCaptureId : "legacy";
    const group = groups.get(captureId) ?? new Set<string>();
    group.add(artifact.kind);
    groups.set(captureId, group);
  }
  for (const [captureId, kinds] of groups) {
    if ([...requiredKinds].every((kind) => kinds.has(kind))) {
      return { captureId, kindCount: kinds.size };
    }
  }
  return null;
}

function latestExecutedMcpAudit(auditEvents: Awaited<ReturnType<SpaceStore["listAuditEvents"]>>) {
  return auditEvents.find((event) => {
    if (event.action !== "mcp.tool.execute") return false;
    return event.metadata.status === "EXECUTED" && event.metadata.code === "TOOL_EXECUTION_OK";
  });
}

async function buildLaunchReadinessReport(input: {
  store: SpaceStore;
  config: SpaceApiConfig;
  auth: AuthConfig;
  storageReadiness: StorageReadiness;
  workerReadiness: z.infer<typeof workerReadinessSchema>;
  observability: z.infer<typeof observabilitySnapshotSchema>;
}) {
  const [
    providers,
    models,
    gateway,
    latestMcpSmoke,
    latestEmbeddingSmoke,
    vectorReadiness,
    latestCodexHandshake,
    latestCodexTurnSmoke,
    turns,
    events,
    auditEvents,
    memoryEntries,
    artifacts,
    reviewDecisions,
    reviewChecks,
    reviewDiffs,
    swarmState
  ] = await Promise.all([
    input.store.listProviders(),
    input.store.listModels(),
    input.store.getMcpGatewayStatus(),
    input.store.getLatestMcpDiscoverySmoke(),
    input.store.getLatestMemoryEmbeddingSmoke(),
    input.store.getMemoryVectorReadiness(input.config.memoryEmbeddingDimensions),
    input.store.getLatestCodexAppServerHandshake(),
    input.store.getLatestCodexAppServerTurnSmoke(),
    input.store.listTurns(),
    input.store.listEvents(),
    input.store.listAuditEvents(),
    input.store.listMemoryEntries({ page: 1, pageSize: 100, sortOrder: "desc" }),
    input.store.listArtifacts({ page: 1, pageSize: 100, sortOrder: "desc" }),
    input.store.listReviewDecisions({ page: 1, pageSize: 100, sortOrder: "desc" }),
    input.store.listReviewChecks({ page: 1, pageSize: 100, sortOrder: "desc" }),
    input.store.listReviewDiffSummaries({ page: 1, pageSize: 100, sortOrder: "desc" }),
    input.store.getSwarmState()
  ]);

  const verifiedProviders = providers.filter((provider) => provider.status === "VERIFIED");
  const verifiedModels = models.filter((model) => model.status === "VERIFIED");
  const completedCodexEvent = hasCompletedCodexAppServerTurn(events);
  const executedMcpAudit = latestExecutedMcpAudit(auditEvents);
  const mcpResultArtifact = artifacts.find((artifact) => artifact.kind === "MCP_RESULT");
  const browserEvidence = hasBrowserEvidenceSet(artifacts);
  const swarmRoles = new Set(swarmState.tasks.map((task) => task.role));
  const requiredSwarmRoles = ["PLANNER", "WORKER", "REVIEWER"] as const;
  const swarmReady = requiredSwarmRoles.every((role) => swarmRoles.has(role)) && swarmState.reconciles.length > 0;
  const reviewReady =
    reviewDecisions.some((decision) => decision.decision === "SHIP" || decision.decision === "BLOCK") &&
    reviewChecks.length > 0 &&
    reviewDiffs.length > 0 &&
    !reviewChecks.some((check) => check.status === "FAIL" || check.status === "RUNNING");
  const operatorCredentialsConfigured = Boolean(input.auth.operatorEmail && input.auth.operatorPasswordHash);
  const authMessage = input.auth.devLogin
    ? "Development login is enabled; production launch requires SPACE_DEV_LOGIN=false with verified operator credentials."
    : operatorCredentialsConfigured
      ? "Development login is disabled and operator credentials are configured."
      : "Operator email and password hash are required when development login is disabled.";

  const requirements: LaunchReadinessRequirement[] = [
    input.storageReadiness.status === "VERIFIED"
      ? passedRequirement("storage", "Dedicated Space storage", input.storageReadiness.statusReason, [
          { label: "Storage status", ref: input.storageReadiness.status },
          { label: "App free bytes", ref: String(input.storageReadiness.app.availableBytes) }
        ])
      : gatedRequirement(
          "storage",
          "Dedicated Space storage",
          input.storageReadiness.status === "WARN" ? "WARN" : "FAIL",
          input.storageReadiness.status === "BLOCKED" ? "hard" : "gate",
          input.storageReadiness.statusReason,
          [
            { label: "Storage status", ref: input.storageReadiness.status },
            { label: "Dedicated app volume", ref: input.storageReadiness.dedicatedAppVolume ? "yes" : "no" }
          ]
        ),
    !input.auth.devLogin && operatorCredentialsConfigured
      ? passedRequirement("auth_config", "Production operator auth", authMessage, [
          { label: "Development login", ref: "disabled" },
          { label: "Operator email", ref: "configured" },
          { label: "Password hash", ref: "configured" }
        ])
      : gatedRequirement("auth_config", "Production operator auth", "FAIL", "hard", authMessage, [
          { label: "Development login", ref: input.auth.devLogin ? "enabled" : "disabled" },
          { label: "Operator email", ref: input.auth.operatorEmail ? "configured" : "missing" },
          { label: "Password hash", ref: input.auth.operatorPasswordHash ? "configured" : "missing" }
        ]),
    input.config.runtimeStore === "postgres"
      ? passedRequirement("postgres", "Postgres canonical state", "Runtime state is backed by Postgres.", [
          { label: "Runtime store", ref: input.config.runtimeStore }
        ])
      : gatedRequirement("postgres", "Postgres canonical state", "FAIL", "gate", "SPACE_RUNTIME_STORE=postgres is required for canonical state.", [
          { label: "Runtime store", ref: input.config.runtimeStore }
        ]),
    input.config.enableDummyTurns || input.config.enableCodexTurns
      ? passedRequirement("temporal", "Temporal workflow plane", "Temporal-backed turn workflows are enabled.", [
          { label: "Dummy turns", ref: String(input.config.enableDummyTurns) },
          { label: "Codex turns", ref: String(input.config.enableCodexTurns) }
        ])
      : gatedRequirement("temporal", "Temporal workflow plane", "MISSING", "gate", "No Temporal turn workflow gate is enabled."),
    input.workerReadiness.status === "RUNNING" && input.workerReadiness.pollerCount > 0
      ? passedRequirement("worker", "Temporal worker pollers", "Temporal worker pollers are visible.", [
          { label: "Pollers", ref: String(input.workerReadiness.pollerCount) },
          { label: "Task queue", ref: input.workerReadiness.taskQueue }
        ])
      : gatedRequirement("worker", "Temporal worker pollers", "FAIL", "gate", input.workerReadiness.statusReason, [
          { label: "Worker status", ref: input.workerReadiness.status }
        ]),
    input.config.enableCodexTurns && completedCodexEvent
      ? passedRequirement("codex_turn", "Real Codex App Server turn", "A real Codex App Server turn completed through Temporal.", [
          { label: "Event", ref: completedCodexEvent.id },
          { label: "Turn", ref: completedCodexEvent.turnId }
        ])
      : gatedRequirement("codex_turn", "Real Codex App Server turn", "MISSING", "gate", "No completed Codex App Server turn event is available.", [
          { label: "Codex turns enabled", ref: String(input.config.enableCodexTurns) },
          { label: "Latest turn smoke", ref: latestCodexTurnSmoke?.code ?? null }
        ]),
    verifiedProviders.length > 0 && verifiedModels.length > 0
      ? passedRequirement("provider_model", "Verified provider and model", "At least one provider and model are verified.", [
          { label: "Providers", ref: String(verifiedProviders.length) },
          { label: "Models", ref: String(verifiedModels.length) }
        ])
      : gatedRequirement("provider_model", "Verified provider and model", "MISSING", "gate", "Provider/model registry lacks verified runtime evidence.", [
          { label: "Providers", ref: String(verifiedProviders.length) },
          { label: "Models", ref: String(verifiedModels.length) }
        ]),
    gateway.status === "VERIFIED" && latestMcpSmoke?.status === "VERIFIED"
      ? passedRequirement("mcp_discovery", "MCP discovery catalog", "MCP discovery smoke and catalog metadata are verified.", [
          { label: "Gateway", ref: gateway.status },
          { label: "Smoke", ref: latestMcpSmoke.checkId }
        ])
      : gatedRequirement("mcp_discovery", "MCP discovery catalog", "MISSING", "gate", "MCP discovery has not produced verified catalog evidence.", [
          { label: "Gateway", ref: gateway.status },
          { label: "Latest smoke", ref: latestMcpSmoke?.code ?? null }
        ]),
    executedMcpAudit && mcpResultArtifact
      ? passedRequirement("mcp_execution", "Approved MCP tool execution", "An approved MCP tool execution produced an artifact.", [
          { label: "Audit", ref: executedMcpAudit.id },
          { label: "Artifact", ref: mcpResultArtifact.id }
        ])
      : gatedRequirement("mcp_execution", "Approved MCP tool execution", "MISSING", "gate", "No approved MCP tool execution artifact is recorded.", [
          { label: "Execution audit", ref: executedMcpAudit?.id ?? null },
          { label: "MCP result artifact", ref: mcpResultArtifact?.id ?? null }
        ]),
    memoryEntries.length > 0
      ? passedRequirement("memory_registry", "Space memory registry", "Memory entries are saved and searchable by keyword.", [
          { label: "Memory entries", ref: String(memoryEntries.length) }
        ])
      : gatedRequirement("memory_registry", "Space memory registry", "MISSING", "gate", "No saved Space memory entries are available for search."),
    vectorReadiness.status === "VERIFIED" && latestEmbeddingSmoke?.status === "VERIFIED" && latestEmbeddingSmoke.embeddingProviderReady
      ? passedRequirement("semantic_memory", "Semantic memory search", "Vector storage and embedding provider smoke are verified.", [
          { label: "Vector", ref: vectorReadiness.code },
          { label: "Embedding smoke", ref: latestEmbeddingSmoke.checkId }
        ])
      : gatedRequirement("semantic_memory", "Semantic memory search", "MISSING", "gate", "Semantic memory remains gated until pgvector and embedding smoke are both verified.", [
          { label: "Vector", ref: vectorReadiness.code },
          { label: "Embedding smoke", ref: latestEmbeddingSmoke?.code ?? null }
        ]),
    browserEvidence
      ? passedRequirement("browser_evidence", "Browser evidence artifact set", "A browser evidence capture contains screenshot, DOM, console and network artifacts.", [
          { label: "Capture", ref: browserEvidence.captureId },
          { label: "Artifact kinds", ref: String(browserEvidence.kindCount) }
        ])
      : gatedRequirement("browser_evidence", "Browser evidence artifact set", "MISSING", "gate", "No complete browser evidence artifact set is recorded."),
    swarmReady
      ? passedRequirement("swarm", "Planner/worker/reviewer swarm flow", "Swarm tasks cover planner, worker and reviewer roles with a reconcile record.", [
          { label: "Tasks", ref: String(swarmState.tasks.length) },
          { label: "Reconciles", ref: String(swarmState.reconciles.length) }
        ])
      : gatedRequirement("swarm", "Planner/worker/reviewer swarm flow", "MISSING", "gate", "Swarm control-plane evidence is incomplete.", [
          { label: "Tasks", ref: String(swarmState.tasks.length) },
          { label: "Reconciles", ref: String(swarmState.reconciles.length) }
        ]),
    reviewReady
      ? passedRequirement("review", "Review Room ship/block gate", "Review decision, checks and diffs are recorded without failing checks.", [
          { label: "Decisions", ref: String(reviewDecisions.length) },
          { label: "Checks", ref: String(reviewChecks.length) },
          { label: "Diffs", ref: String(reviewDiffs.length) }
        ])
      : gatedRequirement("review", "Review Room ship/block gate", "MISSING", "gate", "Review Room evidence is incomplete or still running/failing.", [
          { label: "Decisions", ref: String(reviewDecisions.length) },
          { label: "Checks", ref: String(reviewChecks.length) },
          { label: "Diffs", ref: String(reviewDiffs.length) }
        ]),
    input.observability.totals.errorCount === 0
      ? passedRequirement("observability", "Observability snapshot", "Metrics snapshot is available with no recorded errors.", [
          { label: "Requests", ref: String(input.observability.totals.requestCount) },
          { label: "p95", ref: String(input.observability.totals.p95Ms) }
        ])
      : gatedRequirement("observability", "Observability snapshot", "WARN", "gate", "Observability has recorded HTTP errors.", [
          { label: "Errors", ref: String(input.observability.totals.errorCount) }
        ]),
    latestCodexHandshake?.status === "VERIFIED" || input.config.enableCodexTurns
      ? passedRequirement("codex_adapter", "Isolated Codex adapter gate", "Codex adapter is explicitly enabled or handshake evidence is verified.", [
          { label: "Handshake", ref: latestCodexHandshake?.code ?? null },
          { label: "Turn execution gate", ref: String(input.config.enableCodexTurns) }
        ])
      : gatedRequirement("codex_adapter", "Isolated Codex adapter gate", "MISSING", "gate", "Codex adapter handshake/enablement evidence is missing.")
  ];

  const passedCount = requirements.filter((requirement) => requirement.status === "PASS").length;
  const hardBlockerCount = requirements.filter((requirement) => requirement.status !== "PASS" && requirement.severity === "hard").length;
  const gateCount = requirements.filter((requirement) => requirement.status !== "PASS" && requirement.severity === "gate").length;
  const totalCount = requirements.length;
  const status = hardBlockerCount > 0 ? "BLOCKED" : gateCount > 0 ? "GATED" : "READY";
  return launchReadinessSchema.parse({
    id: "launch-readiness",
    status,
    generatedAt: nowIso(),
    completionPct: Math.round((passedCount / totalCount) * 100),
    passedCount,
    totalCount,
    hardBlockerCount,
    gateCount,
    summary:
      status === "READY"
        ? "All golden launch requirements have evidence."
        : hardBlockerCount > 0
          ? "Production launch remains blocked by hard infrastructure requirements."
          : "Production launch remains gated by missing verification evidence.",
    requirements
  });
}

/**
 * ADMIN integration overview, audit log, MCP discovery smoke and memory readiness status; the parent retains
 * authentication, CSRF, errors and rate limits.
 */
export function registerAdminIntegrationRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  spaceCapabilityInventoryCollector: SpaceCapabilityInventoryCollector;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { config, store, spaceCapabilityInventoryCollector, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/admin/integrations/space", defaultRouteRateLimitOptions, async () =>
    spaceCapabilitySnapshotSchema.parse(await spaceCapabilityInventoryCollector({ store, config }))
  );
  app.get("/api/admin/audit", defaultRouteRateLimitOptions, async (request) => {
    const page = parseQuery(paginationRequestSchema, request.query);
    const events = await store.listAuditEvents();
    const start = (page.page - 1) * page.pageSize;
    return {
      data: events.slice(start, start + page.pageSize),
      pagination: {
        page: page.page,
        pageSize: page.pageSize,
        totalItems: events.length,
        totalPages: Math.ceil(events.length / page.pageSize)
      }
    };
  });
  app.get("/api/admin/mcp/discovery-smoke", defaultRouteRateLimitOptions, async () => ({
    data: await store.getLatestMcpDiscoverySmoke()
  }));
  app.post("/api/admin/mcp/discovery-smoke", defaultRouteRateLimitOptions, async (request) => {
    const context = {
      gatewayStatus: await store.getMcpGatewayStatus(),
      servers: await store.listMcpServers()
    };
    let discoveredCatalog: McpDiscoveryCatalog | null = null;
    const result = await runMcpDiscoverySmoke(config, context, {
      performDiscovery: async () => {
        discoveredCatalog = await discoverMcpCatalog(config, context);
        return {
          serverCount: discoveredCatalog.servers.length,
          toolCount: discoveredCatalog.tools.length
        };
      }
    });
    if (result.status === "VERIFIED" && discoveredCatalog) {
      await store.recordMcpDiscoveryCatalog(discoveredCatalog);
    }
    const persistedActor = request.user ? await store.upsertUser(request.user) : null;
    const recorded = await store.recordMcpDiscoverySmoke({
      ...result,
      actorUserId: persistedActor?.id ?? null,
      traceId: request.requestIdForSpace,
      checkedAt: result.finishedAt
    });
    await recordAudit(store, request, {
      action: "mcp.discovery_smoke",
      targetType: "mcp_gateway",
      targetId: "mcp-gateway",
      metadata: {
        checkId: recorded.checkId,
        status: recorded.status,
        code: recorded.code,
        discoveryEnabled: recorded.discoveryEnabled,
        serverCount: recorded.serverCount,
        toolCount: recorded.toolCount
      }
    });
    return recorded;
  });
  app.get("/api/admin/memory/embedding-smoke", defaultRouteRateLimitOptions, async () => ({
    data: await store.getLatestMemoryEmbeddingSmoke()
  }));
  app.get("/api/admin/memory/vector-readiness", defaultRouteRateLimitOptions, async () => ({
    data: await store.getMemoryVectorReadiness(config.memoryEmbeddingDimensions)
  }));
}

/**
 * ADMIN smoke checks (memory embedding, Codex App Server), service restarts, health, topology, storage,
 * observability, worker and launch readiness; the parent retains authentication, CSRF, errors and rate limits.
 */
export function registerAdminOperationsRoutes(app: FastifyInstance, options: {
  apiStartedAt: string;
  config: SpaceApiConfig;
  auth: AuthConfig;
  store: SpaceStore;
  observability: ReturnType<typeof createHttpObservability>;
  workerReadinessChecker: WorkerReadinessChecker;
  storageReadinessChecker: () => Promise<StorageReadiness>;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  healthMonitor: SystemHealthMonitor;
  systemTopologyService: SystemTopologyService;
  serviceRestarter: CoreServiceRestarter;
  serviceRestartCooldownPath: string;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { apiStartedAt, config, auth, store, observability, workerReadinessChecker, storageReadinessChecker,
    cliRuntimeVisibility, healthMonitor, systemTopologyService, serviceRestarter, serviceRestartCooldownPath,
    routeOptions: defaultRouteRateLimitOptions } = options;
  let serviceRestartInFlight = false;
  app.post("/api/admin/memory/embedding-smoke", defaultRouteRateLimitOptions, async (request) => {
    const vectorReadiness = await store.getMemoryVectorReadiness(config.memoryEmbeddingDimensions);
    const result = await runMemoryEmbeddingSmoke(config, {
      pgvectorReady: vectorReadiness.status === "VERIFIED"
    });
    const recorded = await store.recordMemoryEmbeddingSmoke({
      ...result,
      actorUserId: request.user?.id ?? null,
      traceId: request.requestIdForSpace,
      checkedAt: result.finishedAt
    });
    await recordAudit(store, request, {
      action: "memory.embedding_smoke",
      targetType: "memory_embedding",
      targetId: "memory-embedding-smoke",
      metadata: {
        checkId: recorded.checkId,
        status: recorded.status,
        code: recorded.code,
        smokeEnabled: recorded.smokeEnabled,
        provider: recorded.provider,
        model: recorded.model,
        dimensions: recorded.dimensions,
        pgvectorReady: recorded.pgvectorReady,
        embeddingProviderReady: recorded.embeddingProviderReady,
        vectorReadinessCode: vectorReadiness.code,
        vectorIndexReady: vectorReadiness.vectorIndexReady
      }
    });
    return recorded;
  });
  app.get("/api/admin/codex-app-server", defaultRouteRateLimitOptions, async () => getCodexAppServerStatus(config));
  app.get("/api/admin/codex-app-server/handshake", defaultRouteRateLimitOptions, async () => ({
    data: await store.getLatestCodexAppServerHandshake()
  }));
  app.post("/api/admin/codex-app-server/handshake", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    const status = getCodexAppServerStatus(config);
    const result = await runCodexAppServerHandshake(config, { schemaManifest: status.schemaManifest });
    const recorded = await store.recordCodexAppServerHandshake({
      ...result,
      actorUserId: request.user?.id ?? null,
      traceId: request.requestIdForSpace,
      schemasGenerated: status.schemasGenerated,
      schemaManifest: status.schemaManifest,
      checkedAt: result.finishedAt
    });
    await recordAudit(store, request, {
      action: "codex_app_server.handshake",
      targetType: "codex_app_server",
      targetId: "codex-app-server",
      metadata: {
        checkId: recorded.checkId,
        status: recorded.status,
        code: recorded.code,
        transport: recorded.transport,
        schemasGenerated: recorded.schemasGenerated
      }
    });
    return recorded;
  });
  app.get("/api/admin/codex-app-server/turn-smoke", defaultRouteRateLimitOptions, async () => ({
    data: await store.getLatestCodexAppServerTurnSmoke()
  }));
  app.post("/api/admin/codex-app-server/turn-smoke", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    const input = parseBody(codexAppServerTurnSmokeInputSchema, request.body ?? {});
    const status = getCodexAppServerStatus(config);
    const result = await runCodexAppServerTurnSmoke(config, input, { schemaManifest: status.schemaManifest });
    const recorded = await store.recordCodexAppServerTurnSmoke({
      ...result,
      actorUserId: request.user?.id ?? null,
      traceId: request.requestIdForSpace,
      schemasGenerated: status.schemasGenerated,
      schemaManifest: status.schemaManifest,
      model: input.model ?? null,
      checkedAt: result.finishedAt
    });
    await recordAudit(store, request, {
      action: "codex_app_server.turn_smoke",
      targetType: "codex_app_server",
      targetId: "codex-app-server",
      metadata: {
        checkId: recorded.checkId,
        status: recorded.status,
        code: recorded.code,
        transport: recorded.transport,
        schemasGenerated: recorded.schemasGenerated,
        threadId: recorded.threadId,
        turnId: recorded.turnId,
        turnStatus: recorded.turnStatus,
        notificationCount: recorded.notificationCount
      }
    });
    return recorded;
  });
  app.post("/api/admin/service-restarts", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "Server restart requires the ADMIN role.");
    }
    const input = parseBody(serviceRestartRequestSchema, request.body);
    if (serviceRestartInFlight) {
      return sendApiError(reply, 429, "SERVICE_RESTART_IN_PROGRESS", "A Space core restart request is already in progress.");
    }
    serviceRestartInFlight = true;
    try {
      const now = new Date();
      const cooldown = await readServiceRestartCooldown(serviceRestartCooldownPath);
      if (cooldown && new Date(cooldown.cooldownUntil).getTime() > now.getTime()) {
        return sendApiError(reply, 429, "SERVICE_RESTART_COOLDOWN", "A Space core restart was requested recently.", {
          cooldownUntil: cooldown.cooldownUntil
        });
      }
      const requestedAt = now.toISOString();
      const cooldownUntil = new Date(now.getTime() + 60_000).toISOString();
      // Persist the cooldown before the no-block systemd start so a fast API restart cannot allow a duplicate request.
      await writeServiceRestartCooldown(serviceRestartCooldownPath, {
        scope: input.scope,
        requestedAt,
        cooldownUntil,
        apiStartedAt,
        actorUserId: request.user.id
      });
      await serviceRestarter(CORE_SERVICE_RESTART_COMMAND);
      await recordAudit(store, request, {
        action: "admin.service_restart.requested",
        targetType: "service_restart",
        targetId: input.scope,
        metadata: {
          scope: input.scope,
          services: [...CORE_RESTART_SERVICES],
          cooldownUntil,
          command: `${CORE_SERVICE_RESTART_COMMAND.command} ${CORE_SERVICE_RESTART_COMMAND.args.join(" ")}`
        }
      });
      reply.code(202);
      return serviceRestartResponseSchema.parse({
        status: "ACCEPTED",
        scope: input.scope,
        services: CORE_RESTART_SERVICES,
        requestedAt,
        cooldownUntil,
        apiStartedAt
      });
    } finally {
      serviceRestartInFlight = false;
    }
  });
  app.get("/api/admin", defaultRouteRateLimitOptions, async () => {
    const storageReadiness = storageReadinessSchema.parse(await storageReadinessChecker());
    return {
      status: "ok",
      mode: config.runtimeStore === "postgres" ? "v0-postgres" : "v0-in-memory",
      capabilities: await store.listCapabilities(),
      storageWarning:
        config.browserSessionsEnabled && storageReadiness.status !== "VERIFIED"
          ? storageReadiness.statusReason
          : ""
    };
  });
  app.get("/api/system-health", { config: { rateLimit: { max: 180, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    reply.header("Cache-Control", "no-store");
    return systemHealthSnapshotSchema.parse(await healthMonitor.snapshot());
  });
  app.get("/api/admin/system-analytics/health", { config: { rateLimit: { max: 180, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "System health requires the ADMIN role.");
    reply.header("Cache-Control", "no-store");
    return systemHealthSnapshotSchema.parse(await healthMonitor.snapshot());
  });
  app.get("/api/admin/system-analytics/health/history", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "System health requires the ADMIN role.");
    const { range } = z.object({ range: systemHealthRangeSchema.default("10m") }).strict().parse(request.query);
    reply.header("Cache-Control", "no-store");
    return systemHealthHistorySchema.parse(await healthMonitor.history(range));
  });
  app.get("/api/admin/system-analytics/topology", { config: { rateLimit: { max: 180, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "System topology requires the ADMIN role.");
    reply.header("Cache-Control", "no-store");
    return systemTopologySnapshotSchema.parse(await systemTopologyService.snapshot());
  });
  app.get("/api/admin/topology", { config: { rateLimit: { max: 180, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "System topology requires the ADMIN role.");
    reply.header("Cache-Control", "no-store");
    return systemTopologySnapshotSchema.parse(await systemTopologyService.snapshot());
  });
  app.get("/api/admin/storage", defaultRouteRateLimitOptions, async () => storageReadinessSchema.parse(await storageReadinessChecker()));
  app.get("/api/admin/observability", defaultRouteRateLimitOptions, async () => observabilitySnapshotSchema.parse(observability.snapshot()));
  app.get("/api/admin/worker", defaultRouteRateLimitOptions, async () => workerReadinessSchema.parse(await workerReadinessChecker()));
  app.get("/api/admin/launch-readiness", defaultRouteRateLimitOptions, async () =>
    buildLaunchReadinessReport({
      store,
      config,
      auth,
      storageReadiness: storageReadinessSchema.parse(await storageReadinessChecker()),
      workerReadiness: workerReadinessSchema.parse(await workerReadinessChecker()),
      observability: observabilitySnapshotSchema.parse(observability.snapshot())
    })
  );
}
