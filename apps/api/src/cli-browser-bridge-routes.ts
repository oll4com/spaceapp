import { BROWSER_CONTROL_AGENT_RECLAIM_IDLE_MS, createBrowserControlActivity, releaseBrowserControlLease, settleEndedOperatorLease, type BrowserControlActivity } from "./browser-control-activity.js";
import type {} from "./request-context.js";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  type Artifact, browserDiagnosticsResponseSchema, type PaneBrowserSession, spaceCliBrowserActionBridgeRequestSchema,
  spaceCliBrowserActionBridgeResponseSchema, spaceCliBrowserCommandRequestSchema,
  spaceCliBrowserContextResponseSchema, spaceCliBrowserSessionStartRequestSchema,
  spaceCliBrowserSessionStartResponseSchema
} from "@space/contracts";
import {
  nowIso, redactMemoryText, SpaceConflictError, type SpaceEventBus, SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceStore
} from "@space/runtime";
import type { BrowserHostActorContext } from "@space/browser-host";
import { withStagedAgentFiles } from "./agent-file-upload.js";
import { BrowserControlHeldError } from "./browser-errors.js";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import {
  safeBrowserActionRequestForResponse, safeBrowserObservationText, safeBrowserObservationUrl
} from "./browser-observation.js";
import {
  AgentFileDocxNormalizationError, type AgentFileDocxNormalizer, cliAgentFilesEnabled, cliAgentFilesTokenHeader,
  persistAgentFile, verifyCliAgentFilesToken
} from "./cli-agent-files.js";
import {
  cliBrowserBridgeEnabled, cliBrowserBridgeTokenHeader, verifyCliBrowserBridgeToken
} from "./cli-browser-bridge.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { PaneBrowserAccountControl } from "./pane-browser-routes.js";
import { selectYouTubeAccountSchema } from "./youtube-accounts.js";
import type { SpaceApiConfig } from "./config.js";
import { sendApiError } from "./http-errors.js";
import { assertBrowserPaneCompatible, getActiveBrowserSessionForPane, getPaneById } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import { headerString } from "./request-helpers.js";
import { parseBody, parseQuery } from "./route-parsing.js";
import { registerJobApplyAgentRoutes } from "./job-apply/agent-routes.js";
import { registerMailCopilotAgentRoutes } from "./mail-copilot/agent-routes.js";
import type { MailCopilotService } from "./mail-copilot/service.js";
import { registerMarketingCopilotAgentRoutes } from "./marketing-copilot/agent-routes.js";
import type { MarketingCopilotService } from "./marketing-copilot/service.js";
import { registerFreelanceCopilotAgentRoutes } from "./freelance-copilot/agent-routes.js";
import { registerTaskAgentRoutes } from "./task-agent-routes.js";
import type { FreelanceCopilotService } from "./freelance-copilot/service.js";
import type { JobApplyService } from "./job-apply/service.js";
import { isT3AgentSessionId, t3AgentPrincipal, T3_AGENT_RUNTIME_ID } from "./t3code/agent-tokens.js";

/**
 * Browser status and the CLI bridge routes (Agent Files publishing, browser context, session, actions and commands
 * for CLI panes); the parent retains authentication, CSRF, errors and rate limits.
 */
export function registerCliBrowserBridgeRoutes(app: FastifyInstance, deps: {
  options: { agentFileDocxNormalizer?: AgentFileDocxNormalizer };
  config: SpaceApiConfig;
  store: SpaceStore;
  eventBus: SpaceEventBus;
  browserSessionManager: BrowserSessionManagerWithHostHealth;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  /** Job Applications tools share the pane bridge token; see job-apply/agent-routes.ts. */
  jobApplyService?: JobApplyService;
  mailCopilotService?: MailCopilotService;
  marketingCopilotService?: MarketingCopilotService;
  freelanceCopilotService?: FreelanceCopilotService;
  /** Set once the pane browser routes are registered; agents choose saved Google sign-ins through it. */
  paneBrowserAccounts: { current: PaneBrowserAccountControl | null };
  /** Operator input per control lease (shared with the browser routes); RECLAIM_CONTROL reads it. */
  controlActivity?: BrowserControlActivity;
}) {
  const { options, config, store, eventBus, browserSessionManager, cliRuntimeVisibility, controlActivity,
    routeOptions: defaultRouteRateLimitOptions, paneBrowserAccounts } = deps;
  async function requireCliBrowserBridgeContext(request: FastifyRequest, reply: FastifyReply) {
    if (!cliBrowserBridgeEnabled(config)) {
      await sendApiError(
        reply,
        503,
        "CLI_BROWSER_BRIDGE_DISABLED",
        "Space CLI browser bridge is disabled. Set SPACE_BROWSER_TOOL_BRIDGE_ENABLED=true after configuring internal API auth."
      );
      return null;
    }
    const claims = verifyCliBrowserBridgeToken(config, headerString(request.headers[cliBrowserBridgeTokenHeader]));
    if (!claims) {
      await sendApiError(reply, 401, "CLI_BROWSER_TOKEN_INVALID", "CLI browser bridge token is missing, invalid, or expired.");
      return null;
    }
    if (isT3AgentSessionId(claims.cliSessionId)) {
      if (!await t3AgentPrincipal(store, claims)) {
        await sendApiError(reply, 404, "T3_PANE_NOT_FOUND", "The T3 Code pane for this browser bridge token is closed or was not found.");
        return null;
      }
      return { claims, runtimeId: T3_AGENT_RUNTIME_ID };
    }
    const cliSession = await store.getPaneCliSession(claims.cliSessionId);
    // A moved pane keeps its running CLI session; the token then acts in the pane's current room.
    if (!cliSession || cliSession.paneId !== claims.paneId) {
      await sendApiError(reply, 404, "CLI_SESSION_NOT_FOUND", "CLI session for browser bridge token was not found.");
      return null;
    }
    if (!cliSession.isActive || cliSession.status === "EXITED" || cliSession.status === "ERROR") {
      await sendApiError(reply, 409, "CLI_SESSION_INACTIVE", "CLI session for browser bridge token is not active.");
      return null;
    }
    if (cliSession.purpose !== "NORMAL") {
      await sendApiError(reply, 409, "CLI_LOGIN_SESSION_RESTRICTED", "CLI login sessions cannot use the Space browser bridge.");
      return null;
    }
    await cliRuntimeVisibility.assertEnabled(cliSession.runtimeId);
    return { claims: { ...claims, roomId: cliSession.roomId }, runtimeId: cliSession.runtimeId };
  }

  if (deps.jobApplyService) {
    registerJobApplyAgentRoutes(app, deps.jobApplyService, {
      store,
      routeOptions: defaultRouteRateLimitOptions,
      requireBridge: requireCliBrowserBridgeContext,
      parseBody,
      parseQuery,
      audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "job_apply", targetId, metadata })
    });
  }
  if (deps.mailCopilotService) {
    registerMailCopilotAgentRoutes(app, deps.mailCopilotService, {
      store,
      routeOptions: defaultRouteRateLimitOptions,
      requireBridge: requireCliBrowserBridgeContext,
      parseBody,
      parseQuery,
      audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "mail_copilot", targetId, metadata })
    });
  }
  if (deps.marketingCopilotService) {
    registerMarketingCopilotAgentRoutes(app, deps.marketingCopilotService, {
      store,
      routeOptions: defaultRouteRateLimitOptions,
      requireBridge: requireCliBrowserBridgeContext,
      parseBody,
      parseQuery,
      audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "marketing_copilot", targetId, metadata })
    });
  }
  if (deps.freelanceCopilotService) {
    registerFreelanceCopilotAgentRoutes(app, deps.freelanceCopilotService, {
      store,
      routeOptions: defaultRouteRateLimitOptions,
      requireBridge: requireCliBrowserBridgeContext,
      parseBody,
      parseQuery,
      audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "freelance_copilot", targetId, metadata }),
      candidate: deps.jobApplyService ? async (owner) => (await deps.jobApplyService!.getProfile(owner)).candidate : undefined
    });
  }
  registerTaskAgentRoutes(app, {
    store,
    routeOptions: defaultRouteRateLimitOptions,
    requireBridge: requireCliBrowserBridgeContext,
    parseBody,
    parseQuery,
    audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "task_item", targetId, metadata })
  });
  async function requireCliAgentFilesContext(request: FastifyRequest, reply: FastifyReply) {
    if (!cliAgentFilesEnabled(config)) {
      await sendApiError(
        reply,
        503,
        "CLI_AGENT_FILES_DISABLED",
        "Space Agent Files publishing is unavailable until internal API authentication is configured."
      );
      return null;
    }
    const dedicatedClaims = verifyCliAgentFilesToken(
      config,
      headerString(request.headers[cliAgentFilesTokenHeader])
    );
    const legacyClaims = dedicatedClaims
      ? null
      : verifyCliBrowserBridgeToken(config, headerString(request.headers[cliBrowserBridgeTokenHeader]));
    const claims = dedicatedClaims ?? legacyClaims;
    if (!claims) {
      await sendApiError(
        reply,
        401,
        "CLI_AGENT_FILES_TOKEN_INVALID",
        "The Space Agent Files token is missing, invalid, or expired. Start a new normal Space CLI session and try again."
      );
      return null;
    }
    if (isT3AgentSessionId(claims.cliSessionId)) {
      if (!await t3AgentPrincipal(store, claims)) {
        await sendApiError(reply, 404, "T3_PANE_NOT_FOUND", "The T3 Code pane for this Agent Files token is closed or was not found.");
        return null;
      }
      return { claims, runtimeId: T3_AGENT_RUNTIME_ID };
    }
    const cliSession = await store.getPaneCliSession(claims.cliSessionId);
    if (!cliSession || cliSession.paneId !== claims.paneId) {
      await sendApiError(reply, 404, "CLI_SESSION_NOT_FOUND", "CLI session for the Agent Files token was not found.");
      return null;
    }
    if (!cliSession.isActive || cliSession.status === "EXITED" || cliSession.status === "ERROR") {
      await sendApiError(reply, 409, "CLI_SESSION_INACTIVE", "Only an active CLI session can publish Agent Files.");
      return null;
    }
    if (cliSession.purpose !== "NORMAL") {
      await sendApiError(reply, 409, "CLI_LOGIN_SESSION_RESTRICTED", "CLI login sessions cannot publish Agent Files.");
      return null;
    }
    await cliRuntimeVisibility.assertEnabled(cliSession.runtimeId);
    return { claims: { ...claims, roomId: cliSession.roomId }, runtimeId: cliSession.runtimeId };
  }
  function summarizeCliBrowserSession(session: PaneBrowserSession) {
    return {
      sessionId: session.sessionId,
      paneId: session.paneId,
      roomId: session.roomId,
      agentNumber: session.agentNumber,
      viewport: session.viewport,
      streamMode: session.streamMode,
      resolvedStreamMode: session.resolvedStreamMode,
      controlState: session.controlState,
      activePageId: session.activePageId,
      pageCount: session.pages.length,
      status: session.status,
      currentUrl: safeBrowserObservationUrl(session.currentUrl),
      title: session.title ? redactMemoryText(session.title).slice(0, 500) : null,
      lastFrameAt: session.lastFrameAt
    };
  }
  app.get("/api/browser/status", defaultRouteRateLimitOptions, async () => browserSessionManager.status());
  app.post("/api/cli/agent-files", defaultRouteRateLimitOptions, async (request, reply) => {
    const bridge = await requireCliAgentFilesContext(request, reply);
    if (!bridge) return undefined;
    if (!request.isMultipart()) {
      return sendApiError(reply, 400, "BAD_REQUEST", "Agent Files publishing must use multipart/form-data.");
    }

    let folder: string | null = null;
    return withStagedAgentFiles(request, config.browserEvidenceArtifactRoot, async (uploads, totalBytes) => {
      const artifacts: Artifact[] = [];
      for (const upload of uploads) {
        let record: Awaited<ReturnType<typeof persistAgentFile>>;
        try {
          record = await persistAgentFile({
            store,
            artifactRoot: config.browserEvidenceArtifactRoot,
            roomId: bridge.claims.roomId,
            paneId: bridge.claims.paneId,
            cliSessionId: bridge.claims.cliSessionId,
            runtimeId: bridge.runtimeId,
            originalFilename: upload.filename,
            declaredMimeType: upload.declaredMimeType,
            sourcePath: upload.sourcePath,
            traceId: request.requestIdForSpace,
            folder: folder || undefined,
            docxNormalizer: options.agentFileDocxNormalizer
          });
        } catch (error) {
          if (error instanceof AgentFileDocxNormalizationError) {
            return sendApiError(reply, 422, "DOCX_NORMALIZATION_FAILED", error.message);
          }
          throw error;
        }
        eventBus.publish(record.event);
        artifacts.push(record.artifact);
      }
      await recordAudit(store, request, {
        action: "agent_file.publish",
        targetType: "pane",
        targetId: bridge.claims.paneId,
        metadata: {
          roomId: bridge.claims.roomId,
          cliSessionId: bridge.claims.cliSessionId,
          runtimeId: bridge.runtimeId,
          folder: folder || undefined,
          artifactCount: artifacts.length,
          artifactIds: artifacts.map((artifact) => artifact.id),
          totalBytes
        }
      });
      return { artifacts };
    }, (name, value) => {
      if (name === "folder") folder = typeof value === "string" ? value.trim() : null;
    });
  });
  app.get("/api/cli/browser/context", defaultRouteRateLimitOptions, async (request, reply) => {
    const bridge = await requireCliBrowserBridgeContext(request, reply);
    if (!bridge) return undefined;
    const browserSessions = await store.listActivePaneBrowserSessions(bridge.claims.roomId);
    await recordAudit(store, request, {
      action: "pane.cli.browser_context",
      targetType: "pane",
      targetId: bridge.claims.paneId,
      metadata: {
        roomId: bridge.claims.roomId,
        cliSessionId: bridge.claims.cliSessionId,
        browserSessionCount: browserSessions.length
      }
    });
    return spaceCliBrowserContextResponseSchema.parse({
      roomId: bridge.claims.roomId,
      cliPaneId: bridge.claims.paneId,
      cliSessionId: bridge.claims.cliSessionId,
      browserSessions: browserSessions.map(summarizeCliBrowserSession)
    });
  });
  app.post("/api/cli/browser/session", defaultRouteRateLimitOptions, async (request, reply) => {
    const bridge = await requireCliBrowserBridgeContext(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(spaceCliBrowserSessionStartRequestSchema, request.body ?? {});
    const panes = await store.listPanes(bridge.claims.roomId, false);
    let browserPane = input.targetPaneId ? panes.find((pane) => pane.id === input.targetPaneId) : panes.find((pane) => pane.mode === "BROWSER");
    if (input.targetPaneId && !browserPane) {
      throw new SpaceNotFoundError(`Browser pane ${input.targetPaneId} was not found in room ${bridge.claims.roomId}.`);
    }
    if (browserPane) {
      assertBrowserPaneCompatible(browserPane);
    } else {
      browserPane = await store.createPane(
        {
          roomId: bridge.claims.roomId,
          title: "CLI Browser",
          mode: "BROWSER"
        },
        request.requestIdForSpace
      );
    }

    const response = await browserSessionManager.startOrRestore({
      pane: browserPane,
      viewport: input.viewport,
      targetUrl: input.targetUrl ?? null,
      streamMode: input.streamMode,
      ownerAgentId: `cli:${bridge.claims.cliSessionId}`,
      traceId: request.requestIdForSpace
    }, { holderType: "AGENT", holderId: `cli:${bridge.claims.cliSessionId}` });
    await recordAudit(store, request, {
      action: "pane.cli.browser_session",
      targetType: "pane",
      targetId: browserPane.id,
      metadata: {
        roomId: bridge.claims.roomId,
        cliPaneId: bridge.claims.paneId,
        cliSessionId: bridge.claims.cliSessionId,
        sessionId: response.session.sessionId,
        streamMode: response.session.streamMode,
        reusedPane: Boolean(input.targetPaneId || panes.some((pane) => pane.id === browserPane.id))
      }
    });
    return spaceCliBrowserSessionStartResponseSchema.parse({
      session: summarizeCliBrowserSession(response.session)
    });
  });
  app.post("/api/cli/browser/actions", defaultRouteRateLimitOptions, async (request, reply) => {
    const bridge = await requireCliBrowserBridgeContext(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(spaceCliBrowserActionBridgeRequestSchema, request.body ?? {});
    const results = [];
    for (const actionRequest of input.actions) {
      try {
        const browserPane = await getPaneById(store, actionRequest.targetPaneId);
        assertBrowserPaneCompatible(browserPane);
        if (browserPane.roomId !== bridge.claims.roomId) {
          throw new SpaceNotFoundError(`Browser pane ${browserPane.id} was not found in room ${bridge.claims.roomId}.`);
        }
        const actionResult = await browserSessionManager.action(
          browserPane,
          actionRequest.action,
          request.requestIdForSpace,
          { holderType: "AGENT", holderId: `cli:${bridge.claims.cliSessionId}` }
        );
        const observation = {
          sessionId: actionResult.session.sessionId,
          paneId: actionResult.session.paneId,
          roomId: actionResult.session.roomId,
          actionType: actionRequest.action.type,
          viewport: actionResult.session.viewport,
          currentUrl: safeBrowserObservationUrl(actionResult.session.currentUrl),
          title: actionResult.session.title ? redactMemoryText(actionResult.session.title).slice(0, 500) : null,
          text: safeBrowserObservationText(actionResult.text),
          capturedAt: actionResult.frame?.capturedAt ?? actionResult.session.lastFrameAt
        };
        results.push({
          request: safeBrowserActionRequestForResponse(actionRequest),
          status: "EXECUTED" as const,
          statusReason: "Browser action executed through Space CLI mediation.",
          observation
        });
        await recordAudit(store, request, {
          action: "pane.cli.browser_action.executed",
          targetType: "pane",
          targetId: browserPane.id,
          metadata: {
            roomId: bridge.claims.roomId,
            cliPaneId: bridge.claims.paneId,
            cliSessionId: bridge.claims.cliSessionId,
            sessionId: actionResult.session.sessionId,
            actionType: actionRequest.action.type
          }
        });
      } catch (error) {
        if (error instanceof BrowserControlHeldError) throw error;
        const message = error instanceof Error ? error.message : "Browser action failed.";
        results.push({
          request: safeBrowserActionRequestForResponse(actionRequest),
          status: "FAILED" as const,
          statusReason: redactMemoryText(message).slice(0, 500),
          observation: null
        });
        await recordAudit(store, request, {
          action: "pane.cli.browser_action.failed",
          targetType: "pane",
          targetId: bridge.claims.paneId,
          metadata: {
            roomId: bridge.claims.roomId,
            cliSessionId: bridge.claims.cliSessionId,
            targetPaneId: actionRequest.targetPaneId,
            actionType: actionRequest.action.type
          }
        });
      }
    }
    return spaceCliBrowserActionBridgeResponseSchema.parse({ results });
  });
  app.post("/api/cli/browser/commands", defaultRouteRateLimitOptions, async (request, reply) => {
    const bridge = await requireCliBrowserBridgeContext(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(spaceCliBrowserCommandRequestSchema, request.body ?? {});
    const pane = await getPaneById(store, input.targetPaneId);
    assertBrowserPaneCompatible(pane);
    if (pane.roomId !== bridge.claims.roomId) {
      throw new SpaceNotFoundError(`Browser pane ${pane.id} was not found in room ${bridge.claims.roomId}.`);
    }
    if (input.command.type === "LIST_ACCOUNTS" || input.command.type === "SELECT_ACCOUNT") {
      // Saved Google sign-ins belong to the room's owner and, as in the pane's account menu, need the ADMIN role.
      // Credentials never leave Chrome: the agent only chooses which saved profile the pane opens.
      const ownerUserId = (await store.getRoom(pane.roomId)).ownerUserId;
      const owner = ownerUserId ? await store.getControlActor(ownerUserId) : null;
      if (owner?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Google account selection requires a room owned by an ADMIN.");
      if (pane.mode !== "BROWSER") throw new SpaceConflictError("Google account selection requires a Browser pane.");
      const accounts = paneBrowserAccounts.current;
      if (!accounts) throw new SpaceFeatureDisabledError("BROWSER_ACCOUNTS_UNAVAILABLE", "Google account selection is unavailable on this runtime.");
      const actor: BrowserHostActorContext = { holderType: "AGENT", holderId: `cli:${bridge.claims.cliSessionId}` };
      let accountResult: Record<string, unknown>;
      if (input.command.type === "LIST_ACCOUNTS") {
        accountResult = await accounts.list(owner.id, pane);
      } else {
        const { profileId, signIn } = parseBody(selectYouTubeAccountSchema,
          { profileId: input.command.profileId, ...(input.command.signIn === undefined ? {} : { signIn: input.command.signIn }) });
        const current = await store.getActivePaneBrowserSession(pane.id);
        const selected = await accounts.select(owner.id, pane, profileId, signIn, request.requestIdForSpace, actor);
        const started = await accounts.start(owner.id, pane, { viewport: current?.viewport ?? "desktop", targetUrl: selected.targetUrl,
          streamMode: current?.streamMode ?? "AUTO", includeInitialFrame: false, ownerAgentId: actor.holderId }, request.requestIdForSpace, actor);
        accountResult = { selectedProfileId: selected.selectedProfileId, session: summarizeCliBrowserSession(started.session) };
      }
      await recordAudit(store, request, {
        action: "pane.cli.browser_account",
        targetType: "pane",
        targetId: pane.id,
        metadata: { roomId: pane.roomId, cliPaneId: bridge.claims.paneId, cliSessionId: bridge.claims.cliSessionId, commandType: input.command.type,
          selectedProfileId: input.command.type === "SELECT_ACCOUNT" ? input.command.profileId : null }
      });
      return accountResult;
    }
    const session = await getActiveBrowserSessionForPane(store, pane);
    const actorId = `cli:${bridge.claims.cliSessionId}`;
    let result: unknown;

    switch (input.command.type) {
      case "DEVTOOLS":
        if (!browserSessionManager.diagnostics) {
          throw new SpaceFeatureDisabledError("BROWSER_DIAGNOSTICS_UNAVAILABLE", "Browser DevTools are unavailable on this runtime.");
        }
        // Read-only inspection stays available during an exclusive operator lease.
        result = browserDiagnosticsResponseSchema.parse(await browserSessionManager.diagnostics(
          pane, input.command.includeNetwork, input.command.limit
        ));
        break;
      case "LIST_PAGES":
        if (!browserSessionManager.listPages) {
          throw new SpaceFeatureDisabledError("BROWSER_PAGES_UNAVAILABLE", "Browser page management is unavailable on this runtime.");
        }
        result = await browserSessionManager.listPages(pane);
        break;
      case "CREATE_PAGE":
        if (!browserSessionManager.createPage) {
          throw new SpaceFeatureDisabledError("BROWSER_PAGES_UNAVAILABLE", "Browser page management is unavailable on this runtime.");
        }
        result = await browserSessionManager.createPage(
          pane,
          input.command.url,
          input.command.activate,
          request.requestIdForSpace,
          { holderType: "AGENT", holderId: actorId }
        );
        break;
      case "ACTIVATE_PAGE":
        if (!browserSessionManager.activatePage) {
          throw new SpaceFeatureDisabledError("BROWSER_PAGES_UNAVAILABLE", "Browser page management is unavailable on this runtime.");
        }
        result = await browserSessionManager.activatePage(
          pane,
          input.command.pageId,
          request.requestIdForSpace,
          { holderType: "AGENT", holderId: actorId }
        );
        break;
      case "CLOSE_PAGE":
        if (!browserSessionManager.closePage) {
          throw new SpaceFeatureDisabledError("BROWSER_PAGES_UNAVAILABLE", "Browser page management is unavailable on this runtime.");
        }
        result = await browserSessionManager.closePage(
          pane,
          input.command.pageId,
          request.requestIdForSpace,
          { holderType: "AGENT", holderId: actorId }
        );
        break;
      case "SET_STREAM_MODE":
        if (!browserSessionManager.setStreamMode) {
          throw new SpaceFeatureDisabledError("BROWSER_STREAM_MODE_UNAVAILABLE", "Adaptive browser stream modes are unavailable on this runtime.");
        }
        result = await browserSessionManager.setStreamMode(
          pane,
          input.command.streamMode,
          request.requestIdForSpace,
          { holderType: "AGENT", holderId: actorId }
        );
        break;
      case "START_CAPTURE":
        if (!browserSessionManager.createCapture) {
          throw new SpaceFeatureDisabledError("BROWSER_CAPTURE_UNAVAILABLE", "Browser capture jobs are unavailable on this runtime.");
        }
        result = {
          job: await browserSessionManager.createCapture(
            pane,
            input.command.kind === "SCREENSHOT"
              ? { kind: "SCREENSHOT", format: "PNG", target: "VIEWPORT", selector: null, quality: null }
              : {
                  kind: "RECORDING",
                  format: "WEBM",
                  maxDurationMs: input.command.durationMs ?? 60_000,
                  maxBytes: 1_073_741_824,
                  frameIntervalMs: 100
                },
            { requestedByType: "AGENT", requestedById: actorId, traceId: request.requestIdForSpace }
          )
        };
        break;
      case "CAPTURE_STATUS":
        if (!browserSessionManager.getCapture) {
          throw new SpaceFeatureDisabledError("BROWSER_CAPTURE_UNAVAILABLE", "Browser capture jobs are unavailable on this runtime.");
        }
        result = { job: await browserSessionManager.getCapture(pane, input.command.jobId) };
        break;
      case "STOP_CAPTURE":
        if (!browserSessionManager.stopCapture) {
          throw new SpaceFeatureDisabledError("BROWSER_CAPTURE_CONTROL_UNAVAILABLE", "Stopping browser captures is unavailable on this runtime.");
        }
        result = { job: await browserSessionManager.stopCapture(
          pane,
          input.command.jobId,
          request.requestIdForSpace,
          { holderType: "AGENT", holderId: actorId }
        ) };
        break;
      case "CANCEL_CAPTURE":
        if (!browserSessionManager.cancelCapture) {
          throw new SpaceFeatureDisabledError("BROWSER_CAPTURE_CONTROL_UNAVAILABLE", "Cancelling browser captures is unavailable on this runtime.");
        }
        result = { job: await browserSessionManager.cancelCapture(
          pane,
          input.command.jobId,
          request.requestIdForSpace,
          { holderType: "AGENT", holderId: actorId }
        ) };
        break;
      case "LIST_ARTIFACTS": {
        const artifacts = await store.listArtifacts({ page: 1, pageSize: 100, sortOrder: "desc", roomId: pane.roomId, paneId: pane.id });
        result = { artifacts: artifacts.filter((artifact) => artifact.metadata.source === "BROWSER_CAPTURE_JOB") };
        break;
      }
      case "PIN_ARTIFACT":
      case "UNPIN_ARTIFACT": {
        const artifact = await store.getArtifact(input.command.artifactId);
        if (artifact.roomId !== pane.roomId || artifact.paneId !== pane.id || artifact.metadata.source !== "BROWSER_CAPTURE_JOB") {
          throw new SpaceNotFoundError(`Browser artifact ${artifact.id} was not found for pane ${pane.id}.`);
        }
        const pinned = input.command.type === "PIN_ARTIFACT";
        result = {
          artifact: await store.updateArtifactRetention(artifact.id, {
            pinnedAt: pinned ? nowIso() : null,
            expiresAt: pinned ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          })
        };
        break;
      }
      case "REQUEST_HANDOFF": {
        const handoff = await store.createBrowserHandoffRequest({
          sessionId: session.sessionId,
          paneId: pane.id,
          roomId: pane.roomId,
          requestedByType: "AGENT",
          requestedById: actorId,
          reason: `${input.command.kind}: ${input.command.reason}`.slice(0, 500),
          // A login or MFA needs the operator to come to the pane and a phone; five minutes ran out before
          // they arrived and "Take control" then had nothing to accept. The agent waits up to 15 minutes.
          ttlSeconds: 1800
        });
        const handoffEvent = (await store.listEvents(pane.roomId)).find((event) => event.traceId === handoff.handoffRequestId);
        if (handoffEvent) eventBus.publish(handoffEvent);
        result = { handoff };
        break;
      }
      case "HANDOFF_STATUS": {
        // A handoff whose operator lease already ended reads COMPLETED, not ACCEPTED until its own expiry.
        await settleEndedOperatorLease(store, session.sessionId);
        const active = await store.getActiveBrowserHandoffRequest(session.sessionId);
        const latest = active ?? (await store.listBrowserHandoffRequests(pane.roomId)).find((handoff) => handoff.sessionId === session.sessionId) ?? null;
        result = { handoff: latest };
        break;
      }
      case "CANCEL_HANDOFF": {
        const active = await store.getActiveBrowserHandoffRequest(session.sessionId);
        // Only this agent's own request that the operator has not taken; an accepted handoff is the operator's.
        const cancellable = active?.status === "REQUESTED" && active.requestedByType === "AGENT" && active.requestedById === actorId;
        result = cancellable
          ? { cancelled: true, handoff: await store.updateBrowserHandoffRequest(active.handoffRequestId, { status: "CANCELLED" }) }
          : { cancelled: false, handoff: active ?? null };
        break;
      }
      case "RECLAIM_CONTROL": {
        const lease = await store.getActiveBrowserControlLease(session.sessionId);
        if (!lease || lease.holderType !== "OPERATOR") {
          // The operator's lease may have ended without a release (tab closed): its accepted handoff ends with it.
          await settleEndedOperatorLease(store, session.sessionId);
          result = { reclaimed: false, reason: "NO_OPERATOR_CONTROL", idleSeconds: null, retryAfterSeconds: 0 };
          break;
        }
        const activity = controlActivity ?? createBrowserControlActivity();
        const idleMs = activity.idleMs(lease);
        // The operator is still using the page: never take it mid-use.
        if (idleMs < BROWSER_CONTROL_AGENT_RECLAIM_IDLE_MS) {
          result = { reclaimed: false, reason: "OPERATOR_ACTIVE", idleSeconds: Math.floor(idleMs / 1000),
            retryAfterSeconds: Math.ceil((BROWSER_CONTROL_AGENT_RECLAIM_IDLE_MS - idleMs) / 1000) };
          break;
        }
        const released = await releaseBrowserControlLease({ store, browserSessionManager, activity },
          { pane, lease, request, auditAction: "pane.browser.control.agent_reclaim", auditMetadata: { agent: actorId, idleSeconds: Math.floor(idleMs / 1000) } });
        result = { reclaimed: true, reason: "RECLAIMED", idleSeconds: Math.floor(idleMs / 1000), retryAfterSeconds: 0, lease: released };
        break;
      }
    }

    await recordAudit(store, request, {
      action: "pane.cli.browser_command",
      targetType: "pane",
      targetId: pane.id,
      metadata: {
        roomId: pane.roomId,
        cliPaneId: bridge.claims.paneId,
        cliSessionId: bridge.claims.cliSessionId,
        sessionId: session.sessionId,
        commandType: input.command.type
      }
    });
    return result;
  });
}
