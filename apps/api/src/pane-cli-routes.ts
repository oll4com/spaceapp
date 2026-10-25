import type {} from "./request-context.js";
import { type CliAccountBalancer, isCliBalancedRuntimeId } from "./cli-account-balancer.js";
import type {} from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import type { CodexAppServerSocketControlService, CodexAppServerSocketModelOption } from "@space/codex-app-server";
import {
  cliModelIdentifierSchema, cliTerminalClientEventInputSchema, cliTerminalClientEventResponseSchema, idSchema,
  type Pane, type PaneCliModelSettings, paneCliModelSettingsStatusSchema, type PaneCliSession,
  paneCliTurnActivityResponseSchema, paneCliWebSocketServerMessageSchema
} from "@space/contracts";
import { type OpenCodeServerControl, parseOpenCodeCompositeModelId } from "@space/opencode-control";
import { SpaceConflictError, SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { loadClaudeNativeTurns } from "./claude-native-turns.js";
import type { OpenCodeCurrentSource } from "./cli-opencode-model-picker.js";
import type { CliPaneReopener } from "./cli-pane-reopen.js";
import { codexDirectParityCodexHome, isCodexDirectParityRuntime, isOpenCodeDirectParityRuntime } from "./cli-parity.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import { activeCliSessionObserverRuntime, type createAgentRuntimeRegistryCache, findRuntime } from "./cli-runtimes.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import {
  canonicalCodexAdvertisedModelId, cliModelReasoningEffortSchema, CodexRuntimeModelSettingsUnconfirmedError
} from "./codex-model-settings.js";
import { type CodexCliTurnActivity, findCodexTaskTimeline } from "./codex-rollout-diagnostics.js";
import type { SpaceApiConfig } from "./config.js";
import { loadGeminiNativeTurns } from "./gemini-native-turns.js";
import type { createHttpObservability } from "./observability.js";
import { buildPaneCliSessionResponse } from "./pane-cli-session-response.js";
import { assertCliPaneCompatible, assertNormalCliSession, getPaneById } from "./pane-guards.js";
import { createPaneWorkingTime } from "./pane-working-time.js";
import { assertManagedPlanMutationScope } from "./plan-execution-routes.js";
import { recordAudit } from "./request-audit.js";
import type { RoomPaneController } from "./room-pane-control.js";
import type { NativeTaskExecution } from "./room-task-telemetry.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";

const cliTerminalClientEventBodyLimitBytes = 2 * 1024;

const updateCliModelSettingsBodySchema = z.object({
  expectedSessionId: idSchema,
  modelId: cliModelIdentifierSchema,
  reasoningEffort: cliModelReasoningEffortSchema,
  continueActiveTurn: z.boolean().default(false)
});

const cliTerminalQuerySchema = z
  .object({
    sessionId: idSchema,
    token: z.string().min(24).max(512),
    clientId: z.string().uuid().optional(),
    protocolVersion: z.coerce.number().int().min(1).max(2).optional(),
    browserClientId: z.string().uuid().optional(),
    tabLineageId: z.string().uuid().optional(),
    pageClientId: z.string().uuid().optional(),
    clientMode: z.enum(["INTERACTIVE", "OBSERVER"]).optional(),
    leaseId: idSchema.optional(),
    initialCols: z.coerce.number().int().min(2).max(400).optional(),
    initialRows: z.coerce.number().int().min(2).max(200).optional()
  })
  .superRefine((input, context) => {
    if ((input.initialCols === undefined) !== (input.initialRows === undefined)) {
      context.addIssue({
        code: "custom",
        path: input.initialCols === undefined ? ["initialCols"] : ["initialRows"],
        message: "Initial terminal columns and rows must be provided together."
      });
    }
    if (input.protocolVersion !== 2) return;
    for (const field of ["browserClientId", "tabLineageId", "pageClientId"] as const) {
      if (input[field]) continue;
      context.addIssue({
        code: "custom",
        path: [field],
        message: `Protocol-v2 CLI terminal connections require ${field}.`
      });
    }
  });

const cliSessionQuerySchema = z.object({
  includeTranscript: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .default(true)
    .transform((value) => value === true || value === "true"),
  compactTranscript: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((value) => value === true || value === "true")
});

const cliTurnActivityQuerySchema = z.object({
  marker: z.string().uuid()
});

function closeCliSocketWithSetupError(
  socket: { readyState: number; send(data: string): void; close(code?: number, reason?: string): void },
  message: string
) {
  if (socket.readyState !== 1) return;
  socket.send(
    JSON.stringify(
      paneCliWebSocketServerMessageSchema.parse({
        type: "error",
        code: "CLI_TERMINAL_SETUP_FAILED",
        message
      })
    )
  );
  socket.close(1008, "CLI terminal unavailable");
}

/**
 * CLI terminal client events, the pane CLI terminal WebSocket attach and the pane CLI session view; moved verbatim,
 * the parent retains authentication, CSRF, errors and rate limits.
 */
export function registerPaneCliTerminalRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  observability: ReturnType<typeof createHttpObservability>;
  cliRuntimeRegistryCache: ReturnType<typeof createAgentRuntimeRegistryCache>;
  cliTerminalManager: CliTerminalManager;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  assertRootAdmin: (request: FastifyRequest, runtimeId: string | null | undefined) => void;
  assertPaneCliRuntimeEnabled: (pane: Pane) => Promise<void>;
  cliPaneReopener: CliPaneReopener;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  websocketRouteOptions: Pick<RouteShorthandOptions, "config"> & { websocket: true };
  cliAccountBalancer?: Pick<CliAccountBalancer, "isAuto">;
}) {
  const { config, store, observability, cliRuntimeRegistryCache, cliTerminalManager, cliRuntimeVisibility,
    assertRootAdmin, assertPaneCliRuntimeEnabled, cliPaneReopener, routeOptions: defaultRouteRateLimitOptions,
    websocketRouteOptions: defaultWebsocketRateLimitOptions, cliAccountBalancer } = options;
  app.post(
    "/api/cli/client-events",
    {
      bodyLimit: cliTerminalClientEventBodyLimitBytes,
      config: { rateLimit: { max: 240, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      const input = parseBody(cliTerminalClientEventInputSchema, request.body);
      observability.observeCliTerminalEvent({
        source: "CLIENT",
        event: input.event,
        outcome: input.outcome,
        reason: input.reason
      });
      request.log.info(
        {
          event: "cli_terminal.lifecycle",
          source: "CLIENT",
          eventType: input.event,
          outcome: input.outcome,
          reason: input.reason,
          paneId: input.paneId,
          sessionId: input.sessionId ?? null,
          runtimeId: input.runtimeId ?? null,
          controlState: input.controlState ?? null,
          protocolVersion: input.protocolVersion ?? null,
          clientMode: input.clientMode ?? null,
          socketGeneration: input.socketGeneration ?? null,
          attempt: input.attempt ?? null,
          delayMs: input.delayMs ?? null,
          closeCode: input.closeCode ?? null,
          wasClean: input.wasClean ?? null,
          clientAt: input.clientAt,
          requestId: request.requestIdForSpace
        },
        "CLI terminal lifecycle event."
      );
      return reply
        .code(202)
        .send(cliTerminalClientEventResponseSchema.parse({ accepted: true }));
    }
  );
  app.get("/api/panes/:id/cli/terminal", defaultWebsocketRateLimitOptions, (socket, request) => {
    try {
      const params = parseQuery(idParamSchema, request.params);
      const query = parseQuery(cliTerminalQuerySchema, request.query);
      const pane = getPaneById(store, params.id).then(async (candidate) => {
        assertCliPaneCompatible(candidate);
        await assertPaneCliRuntimeEnabled(candidate);
        return candidate;
      });
      cliTerminalManager.handleSocket(socket, {
        paneId: params.id,
        pane,
        sessionId: query.sessionId,
        token: query.token,
        clientId: query.clientId,
        ...(query.protocolVersion === 2
          ? {
              protocolVersion: 2 as const,
              browserClientId: query.browserClientId,
              tabLineageId: query.tabLineageId,
              pageClientId: query.pageClientId,
        clientMode: query.clientMode,
              requestedLeaseId: query.leaseId
            }
          : {}),
        initialCols: query.initialCols,
        initialRows: query.initialRows,
        userId: request.user!.id,
        proofScope: request.user?.proofScope,
        proofSession: request.sessionPrincipal === "user:operator-proof",
        requestId: request.requestIdForSpace
      });
    } catch (error) {
      closeCliSocketWithSetupError(socket, error instanceof Error ? error.message : "CLI terminal setup failed.");
    }
  });
  app.get("/api/panes/:id/cli/session", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const query = parseQuery(cliSessionQuerySchema, request.query);
    const pane = await getPaneById(store, params.id);
    assertCliPaneCompatible(pane);
    await assertPaneCliRuntimeEnabled(pane);
    assertRootAdmin(request, pane.terminalRuntimeId);
    await cliPaneReopener.settled(pane.id);
    let active = await store.getActivePaneCliSession(pane.id);
    if (!active || !active.isActive || active.status === "EXITED" || active.status === "ERROR") {
      return null;
    }
    active = await cliTerminalManager.reconcileNormalSessionHostState(active);
    if (!active.isActive || active.status === "EXITED" || active.status === "ERROR") {
      return null;
    }
    assertRootAdmin(request, active.runtimeId);
    await cliRuntimeVisibility.assertEnabled(active.runtimeId);
    const runtime = request.user?.automationScope === "APP_DIAGNOSTICS"
      ? activeCliSessionObserverRuntime(config, active.runtimeId)
      : findRuntime(await cliRuntimeRegistryCache.readStaleWhileRefreshing(), active.runtimeId);
    if (!runtime) {
      throw new SpaceNotFoundError(`CLI runtime ${active.runtimeId} was not found.`);
    }
    // A balanced CLI's pane learns whether it is on Auto, so its account picker shows it after a reload.
    const accountMode = cliAccountBalancer && isCliBalancedRuntimeId(active.runtimeId)
      ? { accountMode: await cliAccountBalancer.isAuto(pane.id) ? "AUTO" as const : "PROFILE" as const } : {};
    return { ...accountMode, ...await buildPaneCliSessionResponse({
      store,
      runtime,
      sessionId: active.sessionId,
      includeWebsocket: true,
      includeTranscript:
        request.user?.automationScope === "APP_DIAGNOSTICS"
          ? false
          : query.includeTranscript,
      compactTranscript:
        request.user?.automationScope === "APP_DIAGNOSTICS"
          ? false
          : Boolean(query.compactTranscript),
      proofScope: request.user?.proofScope,
      tokenTtlMs: config.cliTokenTtlMs,
      issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
    }) };
  });
}

/**
 * Pane CLI model settings (read, status, update), turn activity and working time; the parent retains
 * authentication, CSRF, errors and rate limits.
 */
export function registerPaneCliModelRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  cliRuntimeRegistryCache: ReturnType<typeof createAgentRuntimeRegistryCache>;
  cliTerminalManager: CliTerminalManager;
  assertCliHttpMutationControl: (request: FastifyRequest, session: PaneCliSession) => Promise<void>;
  waitForCodexThreadSettings: (input: { threadId: string; cwd: string | null; sessionId: string; modelId: string; reasoningEffort: string; models: CodexAppServerSocketModelOption[]; }) => Promise<void>;
  readPaneNativeModelSettings: (session: PaneCliSession) => Promise<PaneCliModelSettings>;
  applyNativePaneModel: (input: {
    pane: Pane; active: PaneCliSession; modelId: string; reasoningEffort: string; traceId: string;
    assertControl: (current: PaneCliSession) => Promise<void>;
  }) => Promise<{ before: PaneCliModelSettings; current: { modelId: string; reasoningEffort: string }; updated: PaneCliSession }>;
  readPaneCliModelSettings: (pane: Pane, session: PaneCliSession, traceId: string) => Promise<{
    settings: {
      sessionId: string; threadId: string | null; current: { modelId: string; reasoningEffort: string } | null;
      models: CodexAppServerSocketModelOption[]; controlMode: "DIRECT"; isTurnActive: boolean;
    };
    activity: CodexCliTurnActivity; directControl: CodexAppServerSocketControlService; primaryThreadId: string | null | undefined;
    controlCwd: string | null; session: PaneCliSession;
  }>;
  resolveOpenCodeServerControl: (session: PaneCliSession) => Promise<OpenCodeServerControl>;
  readPaneOpenCodeModelSettings: (pane: Pane, session: PaneCliSession, traceId: string) => Promise<{
    settings: Omit<PaneCliModelSettings, "threadId" | "controlMode" | "currentSource"> & {
      currentSource?: OpenCodeCurrentSource; threadId: null; controlMode: "OPENCODE";
    };
    session: PaneCliSession;
  }>;
  applyOpenCodePaneSelection: (
    pane: Pane, session: PaneCliSession, model: PaneCliModelSettings["models"][number], effort: string, traceId: string,
    assertControl?: (current: PaneCliSession) => Promise<void>, allModels?: PaneCliModelSettings["models"]
  ) => Promise<void>;
  roomOpenCodeTasks: (control: OpenCodeServerControl) => Promise<NativeTaskExecution[]>;
  assertNoManagedModelMutation: (paneId: string) => Promise<void>;
  roomPaneController: RoomPaneController;
  assertRootAdmin: (request: FastifyRequest, runtimeId: string | null | undefined) => void;
  assertPaneCliRuntimeEnabled: (pane: Pane) => Promise<void>;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { config, store, cliRuntimeRegistryCache, cliTerminalManager, assertCliHttpMutationControl,
    waitForCodexThreadSettings, readPaneNativeModelSettings, applyNativePaneModel, readPaneCliModelSettings,
    resolveOpenCodeServerControl, readPaneOpenCodeModelSettings, applyOpenCodePaneSelection, roomOpenCodeTasks,
    assertNoManagedModelMutation, roomPaneController, assertRootAdmin, assertPaneCliRuntimeEnabled,
    routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/panes/:id/cli/model-settings", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const pane = await getPaneById(store, params.id);
    assertCliPaneCompatible(pane);
    await assertPaneCliRuntimeEnabled(pane);
    const active = await store.getActivePaneCliSession(pane.id);
    if (!active || !active.isActive || active.status === "EXITED" || active.status === "ERROR") {
      throw new SpaceConflictError("Attach a CLI session before changing its model settings.");
    }
    assertNormalCliSession(active);
    assertRootAdmin(request, active.runtimeId);
    if (!isCodexDirectParityRuntime(active.runtimeId) && !isOpenCodeDirectParityRuntime(active.runtimeId)) {
      return readPaneNativeModelSettings(active);
    }
    return isOpenCodeDirectParityRuntime(active.runtimeId)
      ? (await readPaneOpenCodeModelSettings(pane, active, request.requestIdForSpace)).settings
      : (await readPaneCliModelSettings(pane, active, request.requestIdForSpace)).settings;
  });
  app.get("/api/panes/:id/cli/model-settings/status", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const pane = await getPaneById(store, params.id);
    assertCliPaneCompatible(pane);
    await assertPaneCliRuntimeEnabled(pane);
    const active = await store.getActivePaneCliSession(pane.id);
    if (!active || !active.isActive || active.status === "EXITED" || active.status === "ERROR") {
      throw new SpaceConflictError("Attach a CLI session before checking its model settings.");
    }
    assertNormalCliSession(active);
    assertRootAdmin(request, active.runtimeId);
    try {
      const settings = !isCodexDirectParityRuntime(active.runtimeId) && !isOpenCodeDirectParityRuntime(active.runtimeId)
        ? await readPaneNativeModelSettings(active)
        : isOpenCodeDirectParityRuntime(active.runtimeId)
        ? (await readPaneOpenCodeModelSettings(pane, active, request.requestIdForSpace)).settings
        : (await readPaneCliModelSettings(pane, active, request.requestIdForSpace)).settings;
      return paneCliModelSettingsStatusSchema.parse({ status: "AVAILABLE", settings });
    } catch (error) {
      if (error instanceof SpaceConflictError) {
        return paneCliModelSettingsStatusSchema.parse({
          status: "UNAVAILABLE",
          reasonCode: "CONFLICT",
          reason: error.message
        });
      }
      if (
        error instanceof SpaceFeatureDisabledError &&
        (error.errorCode === "CODEX_SESSION_CONTROL_UNAVAILABLE" ||
          error.errorCode === "CODEX_MODEL_CATALOG_UNAVAILABLE" ||
          error.errorCode === "OPENCODE_SESSION_CONTROL_UNAVAILABLE" ||
          error.errorCode === "OPENCODE_MODEL_CATALOG_UNAVAILABLE" ||
          error.errorCode === "CLI_MODEL_CATALOG_UNAVAILABLE")
      ) {
        return paneCliModelSettingsStatusSchema.parse({
          status: "UNAVAILABLE",
          reasonCode: error.errorCode,
          reason: error.message
        });
      }
      throw error;
    }
  });
  app.patch("/api/panes/:id/cli/model-settings", defaultRouteRateLimitOptions, async (request) => {
    assertManagedPlanMutationScope(request);
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(updateCliModelSettingsBodySchema, request.body ?? {});
    const pane = await getPaneById(store, params.id);
    assertCliPaneCompatible(pane);
    await assertPaneCliRuntimeEnabled(pane);
    const active = await store.getActivePaneCliSession(pane.id);
    if (!active || !active.isActive || active.status === "EXITED" || active.status === "ERROR") {
      throw new SpaceConflictError("Attach a CLI session before changing its model settings.");
    }
    assertNormalCliSession(active);
    assertRootAdmin(request, active.runtimeId);
    await assertCliHttpMutationControl(request, active);
    if (active.sessionId !== input.expectedSessionId) {
      throw new SpaceConflictError("The CLI session changed before the model switch could be applied.");
    }
    await assertNoManagedModelMutation(pane.id);

    if (!isCodexDirectParityRuntime(active.runtimeId) && !isOpenCodeDirectParityRuntime(active.runtimeId)) {
      return cliTerminalManager.runSerializedTerminalMutation(active.sessionId, async () => {
        const { before, current, updated } = await applyNativePaneModel({ pane, active, modelId: input.modelId,
          reasoningEffort: input.reasoningEffort, traceId: request.requestIdForSpace,
          assertControl: (session) => assertCliHttpMutationControl(request, session) });
        const runtime = findRuntime(await cliRuntimeRegistryCache.read(), updated.runtimeId);
        if (!runtime) throw new SpaceNotFoundError("The CLI runtime is unavailable.");
        await recordAudit(store, request, { action: "pane.cli.model-settings", targetType: "pane", targetId: pane.id,
          metadata: { roomId: pane.roomId, sessionId: active.sessionId, ...current, transport: "NATIVE" } });
        return { settings: { ...before, current },
          session: await buildPaneCliSessionResponse({ store, runtime, sessionId: updated.sessionId,
            includeWebsocket: true, tokenTtlMs: config.cliTokenTtlMs,
            issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs) }),
          appliedScope: "MODEL_AND_REASONING", wasActive: false, interrupted: false,
          continuation: "NOT_NEEDED", transport: "NATIVE", warning: null };
      });
    }

    if (isOpenCodeDirectParityRuntime(active.runtimeId)) {
      const before = await readPaneOpenCodeModelSettings(pane, active, request.requestIdForSpace);
      const parsedRef = parseOpenCodeCompositeModelId(input.modelId);
      const advertised = before.settings.models.some((model) => model.id === input.modelId);
      if (!parsedRef || !advertised) {
        throw new SpaceConflictError("The selected model is not advertised by this OpenCode runtime.");
      }
      const wasActive = before.settings.isTurnActive;
      const advertisedModel = before.settings.models.find(model => model.id === input.modelId)!;
      await applyOpenCodePaneSelection(pane, active, advertisedModel, input.reasoningEffort, request.requestIdForSpace,
        current => assertCliHttpMutationControl(request, current), before.settings.models);
      const updatedSession = await store.updatePaneCliSession(
        active.sessionId,
        {
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort,
          statusReason: "OpenCode model settings saved for this pane."
        },
        request.requestIdForSpace
      );
      try {
        await store.updatePane(
          pane.id,
          {
            modelId: input.modelId
          },
          request.requestIdForSpace
        );
      } catch {}
      const registry = await cliRuntimeRegistryCache.read();
      const runtime = findRuntime(registry, updatedSession.runtimeId);
      if (!runtime) throw new SpaceNotFoundError(`CLI runtime ${updatedSession.runtimeId} was not found.`);
      const afterSettings: PaneCliModelSettings = {
        ...before.settings,
        current: { modelId: input.modelId, reasoningEffort: input.reasoningEffort },
        // OpenCode 2's TUI follows the server's session model, so the server is the source of the selection.
        currentSource: "server"
      };
      await recordAudit(store, request, {
        action: "pane.cli.model-settings",
        targetType: "pane",
        targetId: pane.id,
        metadata: {
          roomId: pane.roomId,
          sessionId: updatedSession.sessionId,
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort,
          appliedScope: "MODEL_AND_REASONING",
          interrupted: false,
          continuation: "NOT_NEEDED"
        }
      });
      return {
        settings: afterSettings,
        session: await buildPaneCliSessionResponse({
          store,
          runtime,
          sessionId: updatedSession.sessionId,
          includeWebsocket: true,
          tokenTtlMs: config.cliTokenTtlMs,
          issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
        }),
        appliedScope: "MODEL_AND_REASONING",
        wasActive,
        interrupted: false,
        continuation: "NOT_NEEDED",
        transport: "OPENCODE",
        warning: null
      };
    }

    return cliTerminalManager.runSerializedTerminalMutation(active.sessionId, async () => {
      const currentSession = await store.getActivePaneCliSession(pane.id);
      if (!currentSession?.isActive || currentSession.sessionId !== input.expectedSessionId) {
        throw new SpaceConflictError("The CLI session changed before the model switch could be applied.");
      }
      await assertCliHttpMutationControl(request, currentSession);
      const before = await readPaneCliModelSettings(pane, active, request.requestIdForSpace);
      const selectedModel = before.settings.models.find((model) => model.id === input.modelId);
      if (!selectedModel || !selectedModel.supportedReasoningEfforts.includes(input.reasoningEffort)) {
        throw new SpaceConflictError("The selected model and reasoning effort are not advertised by this Codex runtime.");
      }
      if (!before.settings.current) {
        throw new SpaceConflictError("Codex runtime model settings are still being detected.");
      }

      const wasActive = before.settings.isTurnActive;
      const interrupted = false;
      const continuation = "NOT_NEEDED" as const;
      const appliedScope = "MODEL_AND_REASONING" as const;
      const warning = null;
      const appliedModelId = input.modelId;
      if (!before.settings.threadId) {
        throw new SpaceConflictError("Codex model control is still starting. Try the selection again in a moment.");
      }
      // Settings affect subsequent turns. Selecting a model never submits a
      // prompt, cancels an active turn, or starts an automatic continuation.
      await before.directControl.updateThreadSettings({
        threadId: before.settings.threadId,
        ...(before.primaryThreadId !== undefined ? { requireCurrentThread: true } : {}),
        model: input.modelId,
        reasoningEffort: input.reasoningEffort,
        beforeSend: async () => {
          await assertCliHttpMutationControl(request, currentSession);
          await assertNoManagedModelMutation(pane.id);
          if (before.primaryThreadId !== undefined &&
              await before.directControl.readCurrentThreadId?.() !== before.settings.threadId) {
            throw new SpaceConflictError("The active Codex task changed. Try the selection again.");
          }
        }
      });
      if (before.directControl.readThreadSettings) {
        const confirmed = await before.directControl.readThreadSettings(before.settings.threadId);
        if (confirmed.cwd !== before.controlCwd ||
            canonicalCodexAdvertisedModelId(confirmed.modelId, before.settings.models) !== input.modelId ||
            confirmed.reasoningEffort !== input.reasoningEffort) {
          throw new CodexRuntimeModelSettingsUnconfirmedError({ stage: "THREAD_CONFIRMATION",
            expected: { modelId: input.modelId, reasoningEffort: input.reasoningEffort }, observed: confirmed, attempts: 1 });
        }
      } else {
        await waitForCodexThreadSettings({
          threadId: before.settings.threadId, cwd: before.session.cwd, sessionId: before.session.sessionId,
          modelId: input.modelId, reasoningEffort: input.reasoningEffort, models: before.settings.models
        });
      }

      const updatedSession = await store.updatePaneCliSession(
        active.sessionId,
        {
          modelId: appliedModelId,
          reasoningEffort: input.reasoningEffort,
          statusReason: "Codex model settings saved for this pane."
        },
        request.requestIdForSpace
      );
      // Pane model changes (including Save to memory) stay with this pane: a fresh
      // Codex session starts on Codex's own configured default.
      const registry = await cliRuntimeRegistryCache.read();
      const runtime = findRuntime(registry, updatedSession.runtimeId);
      if (!runtime) throw new SpaceNotFoundError(`CLI runtime ${updatedSession.runtimeId} was not found.`);
      const afterSettings = { ...before.settings, current: { modelId: appliedModelId, reasoningEffort: input.reasoningEffort } };
      await recordAudit(store, request, {
        action: "pane.cli.model-settings",
        targetType: "pane",
        targetId: pane.id,
        metadata: {
          roomId: pane.roomId,
          sessionId: updatedSession.sessionId,
          modelId: appliedModelId,
          reasoningEffort: input.reasoningEffort,
          appliedScope,
          interrupted,
          continuation
        }
      });
      return {
        settings: afterSettings,
        session: await buildPaneCliSessionResponse({
          store,
          runtime,
          sessionId: updatedSession.sessionId,
          includeWebsocket: true,
          tokenTtlMs: config.cliTokenTtlMs,
          issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
        }),
        appliedScope,
        wasActive,
        interrupted,
        continuation,
        transport: "DIRECT",
        warning
      };
    });
  });
  app.get("/api/panes/:id/cli/turn-activity", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const query = parseQuery(cliTurnActivityQuerySchema, request.query);
    const pane = await getPaneById(store, params.id);
    assertCliPaneCompatible(pane);
    await assertPaneCliRuntimeEnabled(pane);
    const active = await store.getActivePaneCliSession(pane.id);
    if (!active) {
      return paneCliTurnActivityResponseSchema.parse({ marker: query.marker, status: "UNAVAILABLE", turnId: null });
    }
    if (active.purpose !== "NORMAL") {
      return paneCliTurnActivityResponseSchema.parse({ marker: query.marker, status: "UNAVAILABLE", turnId: null });
    }
    assertRootAdmin(request, active.runtimeId);
    return paneCliTurnActivityResponseSchema.parse(await cliTerminalManager.getTurnActivity(active.sessionId, query.marker));
  });
  const paneWorkingTimeResponseSchema = z.object({
    paneId: idSchema,
    cumulativeWorkingMs: z.number().int().min(0),
    isWorking: z.boolean(),
    state: z.string()
  });
  // Badge polls read only native task timelines (see pane-working-time.ts),
  // never the full inspectRoomCli; Room Agent inspections are unaffected.
  const paneWorkingTime = createPaneWorkingTime({
    latestCliSession: async (paneId) => await store.getActivePaneCliSession(paneId) ?? (await store.listPaneCliSessions(paneId, 1))[0] ?? null,
    codexTasks: (threadId) => findCodexTaskTimeline({ codexHome: codexDirectParityCodexHome, threadId }),
    openCodeTasks: async (session) => {
      const control = await resolveOpenCodeServerControl(session).catch(() => null);
      return control ? roomOpenCodeTasks(control).catch(() => null) : null;
    },
    sessionRootPid: async (session) => (await cliTerminalManager.activeSessionPids([session]).catch(() => null))?.get(session.sessionId) ?? null,
    geminiTasks: async (input) => (await loadGeminiNativeTurns(input).catch(() => null))?.turns
      .map(({ finalResponse: _response, inputText: _input, aborted: _aborted, ...task }) => task) ?? null,
    claudeTasks: (input) => loadClaudeNativeTurns(input).catch(() => null),
    inspectNonCli: (pane) => roomPaneController.inspect(pane)
  });
  app.get("/api/panes/:id/working-time", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const pane = await getPaneById(store, params.id);
    return paneWorkingTimeResponseSchema.parse(await paneWorkingTime.read(pane));
  });
}
