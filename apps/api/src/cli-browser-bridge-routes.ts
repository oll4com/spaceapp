import { registerSiteSigninAgentRoutes, siteSigninFor, signinHandoffRecipe } from "./site-signins.js";
import { checkSiteAccount, moveTabToWantedAccount, signinTarget, siteAccountLine, tabGoogleAccounts } from "./site-signin-account.js";
import { handoffTtlSeconds, ownerHandsAnswer, ownerQuietNow } from "./owner-clock.js";
import { BROWSER_CONTROL_AGENT_RECLAIM_IDLE_MS, BROWSER_CONTROL_PRESENCE_HOLD_MAX_MS, createBrowserControlActivity, ownBrowserPane, releaseBrowserControlLease, settleEndedOperatorLease, type BrowserControlActivity } from "./browser-control-activity.js";
import type {} from "./request-context.js";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  type Artifact, browserDiagnosticsResponseSchema, type Pane, type PaneBrowserSession, spaceCliBrowserActionBridgeRequestSchema,
  spaceCliBrowserActionBridgeResponseSchema, spaceCliBrowserCommandRequestSchema,
  spaceCliBrowserContextResponseSchema, spaceCliBrowserSessionStartRequestSchema,
  spaceCliBrowserSessionStartResponseSchema, siteSigninKeySchema
} from "@space/contracts";
import {
  nowIso, redactMemoryText, SpaceConflictError, type SpaceEventBus, SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceStore
} from "@space/runtime";
import type { BrowserHostActorContext } from "@space/browser-host";
import { withStagedAgentFiles } from "./agent-file-upload.js";
import { withPersistedUpload } from "./multipart-upload.js";
import { buildGenericUserUploadStorage, inferUploadMimeType, isAllowedImageMime, isVideoMimeType, sniffImageMime } from "./upload-media.js";
import { recordUploadedArtifact } from "./upload-record.js";
import { BrowserControlHeldError } from "./browser-errors.js";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import { assertBrowserHostPressKey } from "./browser-sessions.js";
import { uploadablePaths, uploadBrowserFiles } from "./browser-file-upload.js";
import { mailCodeHandoff, pageChallenge, pageReadout } from "./browser-page-readout.js";
import { markSignin, OPERATOR_HANDS, RESET_ASK, RESET_URL, resetRefusal, VAULT_SIGNIN_ASK, vaultSigninHold } from "./signin-readback.js";
import { createTextCaptchaService } from "./browser-text-captcha.js";
import { createSliderCaptchaService } from "./browser-slider-captcha.js";
import { NOUS_FILES_ROOT } from "./nous/files.js";
import { handoffHeldFrom } from "./cli-browser-cdp.js";
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
import { registerDesignAgentRoutes } from "./design/agent-routes.js";
import { registerMailCampaignsAgentRoutes } from "./mail-campaigns/routes.js";
import type { MailCampaignsService } from "./mail-campaigns/service.js";
import { registerVideoAgentRoutes } from "./video/agent-routes.js";
import type { VideoService } from "./video/service.js";
import type { DesignService } from "./design/service.js";
import { registerAppStudioAgentRoutes } from "./app-studio/agent-routes.js";
import type { AppStudioService } from "./app-studio/service.js";
import { registerSecurityCopilotAgentRoutes } from "./security-copilot/agent-routes.js";
import type { SecurityCopilotService } from "./security-copilot/service.js";
import { registerMonitoringCopilotAgentRoutes } from "./monitoring-copilot/agent-routes.js";
import type { MonitoringCopilotService } from "./monitoring-copilot/service.js";
import { registerFreelanceCopilotAgentRoutes } from "./freelance-copilot/agent-routes.js";
import { registerTaskAgentRoutes } from "./task-agent-routes.js";
import { registerAppointmentAgentRoutes } from "./appointments.js";
import { registerSignatureAgentRoutes } from "./signatures.js";
import { registerPaneReportRoutes } from "./pane-report-routes.js";
import { registerQueueOperatorGrantRoute } from "./queue-operator-grants.js";
import type { PaneReports } from "./pane-reports.js";
import { registerVaultAgentBridge, type VaultModule } from "./vault/wiring.js";
import type { FreelanceCopilotService } from "./freelance-copilot/service.js";
import type { JobApplyService } from "./job-apply/service.js";
import { isT3AgentSessionId, t3AgentPrincipal, T3_AGENT_RUNTIME_ID } from "./t3code/agent-tokens.js";
import { harnessAgentPrincipal, HARNESS_AGENT_RUNTIME_ID, isHarnessAgentSessionId } from "./harness-agent-tokens.js";

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
  /** Design requests (every CLI pane) and the Design pane's worker tools; see design/agent-routes.ts. */
  designService?: DesignService;
  videoService?: VideoService;
  /** The App Studio pane's agent tools; see app-studio/agent-routes.ts. */
  appStudioService?: AppStudioService;
  /** The Security Copilot pane's agent tools; see security-copilot/agent-routes.ts. */
  securityCopilotService?: SecurityCopilotService;
  /** The Monitoring Copilot pane's agent tools; see monitoring-copilot/agent-routes.ts. */
  monitoringCopilotService?: MonitoringCopilotService;
  /** Mail Campaigns for every CLI pane; see mail-campaigns/routes.ts. */
  mailCampaignsService?: MailCampaignsService;
  vault?: VaultModule;
  /** Set once the pane browser routes are registered; agents choose saved Google sign-ins through it. */
  paneBrowserAccounts: { current: PaneBrowserAccountControl | null };
  /** Operator input per control lease (shared with the browser routes); RECLAIM_CONTROL reads it. */
  controlActivity?: BrowserControlActivity;
  /** Set once Nous is registered; panes report their progress to it (/api/cli/progress), and its allowances cover what agents may do. */
  nous?: { current: { paneReports: PaneReports; coversApproval?(owner: string): Promise<boolean> } | null };
  /** Drops the pane's Playwright connections but the requester's when its handoff starts (the CDP proxy is created after these routes). */
  dropOtherAgents?(paneId: string, keepCliSessionId: string): void;
}) {
  const { options, config, store, eventBus, browserSessionManager, cliRuntimeVisibility, controlActivity,
    routeOptions: defaultRouteRateLimitOptions, paneBrowserAccounts } = deps;
  const textCaptcha = createTextCaptchaService();
  const sliderCaptcha = createSliderCaptchaService();
  // While another agent's handoff waits, the operator's tab stays as they were sent to it: an agent may only read (handoffHeldFrom).
  const handoffReadCommands = new Set(["DEVTOOLS", "LIST_PAGES", "LIST_ACCOUNTS", "CAPTURE_STATUS", "LIST_ARTIFACTS", "PIN_ARTIFACT", "UNPIN_ARTIFACT", "HANDOFF_STATUS", "CANCEL_HANDOFF"]);
  async function assertNoForeignHandoff(paneId: string, cliSessionId: string) {
    const session = await store.getActivePaneBrowserSession(paneId);
    const held = session ? await handoffHeldFrom(store, session.sessionId, `cli:${cliSessionId}`) : null;
    if (held) throw new SpaceConflictError(held);
  }
  // The Google account a site wants (its sign-in recipe, or the account a Google sign-in page names) against the tab's account
  // (operator nous_msg:05e5af9f81ec45caa1f50f1b): never the pane's default account by accident. Like the account tools, only in a
  // room an ADMIN owns, since it reads the owner's saved Google sign-ins.
  async function siteAccountFor(pane: Pane, address: string | null | undefined, pageId?: string | null) {
    const accounts = paneBrowserAccounts.current;
    if (!accounts || !address) return null;
    const ownerUserId = (await store.getRoom(pane.roomId)).ownerUserId;
    const owner = ownerUserId ? await store.getControlActor(ownerUserId) : null;
    if (owner?.role !== "ADMIN") return null;
    const listPages = browserSessionManager.listPages ? (target: Pane) => browserSessionManager.listPages!(target) : undefined;
    const check = await checkSiteAccount({ store, accounts, listPages }, owner.id, pane, address, pageId).catch(() => null);
    return check ? { owner: owner.id, accounts, check } : null;
  }
  // Each tab with its Google account ("google: <email>"), same operator request: never silent which account a tab uses. Only an ADMIN's Google account panes.
  async function tabAccountsFor(pane: Pane) {
    const accounts = paneBrowserAccounts.current;
    if (!accounts || !browserSessionManager.listPages || !["BROWSER", "FREELANCE_COPILOT", "JOB_APPLY", "MARKETING_COPILOT"].includes(pane.mode)) return null;
    const ownerUserId = (await store.getRoom(pane.roomId)).ownerUserId;
    if (!ownerUserId || (await store.getControlActor(ownerUserId))?.role !== "ADMIN") return null;
    return tabGoogleAccounts(accounts, (target) => browserSessionManager.listPages!(target), ownerUserId, pane).catch(() => null);
  }
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
    if (isHarnessAgentSessionId(claims.cliSessionId)) {
      if (!await harnessAgentPrincipal(store, claims)) {
        await sendApiError(reply, 404, "HARNESS_PANE_NOT_FOUND", "The Harness pane for this browser bridge token is closed or was not found.");
        return null;
      }
      return { claims, runtimeId: HARNESS_AGENT_RUNTIME_ID };
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
      candidate: deps.jobApplyService ? async (owner) => (await deps.jobApplyService!.getProfile(owner)).candidate : undefined,
      bookmarks: deps.marketingCopilotService
    });
  }
  if (deps.designService) {
    registerDesignAgentRoutes(app, deps.designService, {
      store,
      routeOptions: defaultRouteRateLimitOptions,
      requireBridge: requireCliBrowserBridgeContext,
      parseBody,
      parseQuery,
      uploadRoot: config.browserEvidenceArtifactRoot,
      audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "design", targetId, metadata })
    });
  }
  if (deps.videoService) {
    registerVideoAgentRoutes(app, deps.videoService, {
      store,
      routeOptions: defaultRouteRateLimitOptions,
      requireBridge: requireCliBrowserBridgeContext,
      parseBody,
      parseQuery,
      uploadRoot: config.browserEvidenceArtifactRoot,
      audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "video", targetId, metadata })
    });
  }
  if (deps.appStudioService) {
    registerAppStudioAgentRoutes(app, deps.appStudioService, {
      store,
      routeOptions: defaultRouteRateLimitOptions,
      requireBridge: requireCliBrowserBridgeContext,
      parseBody,
      parseQuery,
      uploadRoot: config.browserEvidenceArtifactRoot,
      audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "app_studio", targetId, metadata })
    });
  }
  if (deps.mailCampaignsService) {
    registerMailCampaignsAgentRoutes(app, deps.mailCampaignsService, {
      store,
      routeOptions: defaultRouteRateLimitOptions,
      requireBridge: requireCliBrowserBridgeContext,
      parseBody,
      parseQuery,
      audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "mail_campaigns", targetId, metadata }),
      coversApproval: async (owner) => Boolean(await deps.nous?.current?.coversApproval?.(owner))
    });
  }
  if (deps.securityCopilotService) {
    registerSecurityCopilotAgentRoutes(app, deps.securityCopilotService, {
      store,
      routeOptions: defaultRouteRateLimitOptions,
      requireBridge: requireCliBrowserBridgeContext,
      parseBody,
      parseQuery,
      audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "security_copilot", targetId, metadata })
    });
  }
  if (deps.monitoringCopilotService) {
    registerMonitoringCopilotAgentRoutes(app, deps.monitoringCopilotService, {
      store,
      routeOptions: defaultRouteRateLimitOptions,
      requireBridge: requireCliBrowserBridgeContext,
      parseBody,
      parseQuery,
      audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "monitoring_copilot", targetId, metadata })
    });
  }
  registerSiteSigninAgentRoutes(app, {store, requireBridge: requireCliBrowserBridgeContext});
  registerAppointmentAgentRoutes(app, { store, requireBridge: requireCliBrowserBridgeContext });
  registerSignatureAgentRoutes(app, { store, requireBridge: requireCliBrowserBridgeContext });
  if (deps.vault) registerVaultAgentBridge(app, deps.vault, { store, requireBridge: requireCliBrowserBridgeContext });
  registerTaskAgentRoutes(app, {
    store,
    routeOptions: defaultRouteRateLimitOptions,
    requireBridge: requireCliBrowserBridgeContext,
    parseBody,
    parseQuery,
    audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "task_item", targetId, metadata })
  });
  registerPaneReportRoutes(app, { store, routeOptions: defaultRouteRateLimitOptions, requireBridge: requireCliBrowserBridgeContext, parseBody,
    reports: () => deps.nous?.current?.paneReports ?? null });
  registerQueueOperatorGrantRoute(app, { routeOptions: defaultRouteRateLimitOptions, requireBridge: requireCliBrowserBridgeContext });
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
    if (isHarnessAgentSessionId(claims.cliSessionId)) {
      if (!await harnessAgentPrincipal(store, claims)) {
        await sendApiError(reply, 404, "HARNESS_PANE_NOT_FOUND", "The Harness pane for this Agent Files token is closed or was not found.");
        return null;
      }
      return { claims, runtimeId: HARNESS_AGENT_RUNTIME_ID };
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
    let media = false;
    return withStagedAgentFiles(request, config.browserEvidenceArtifactRoot, async (uploads, totalBytes) => {
      const artifacts: Artifact[] = [];
      // collection=media puts the files in the pane's own room's Media dock: images by their bytes, videos by extension.
      const mediaTypes = media ? uploads.map((upload) => sniffImageMime(upload.sample) ?? inferUploadMimeType(upload.filename, "")) : [];
      const refused = mediaTypes.findIndex((mimeType) => !isAllowedImageMime(mimeType) && !isVideoMimeType(mimeType));
      if (refused >= 0) {
        return sendApiError(reply, 422, "UNSUPPORTED_MEDIA_TYPE", `${uploads[refused]!.filename} is not a PNG, JPEG or WebP image or an MP4, MOV or WebM video.`);
      }
      for (const [index, upload] of uploads.entries()) {
        if (media) {
          const mimeType = mediaTypes[index]!;
          const storage = buildGenericUserUploadStorage({ artifactRoot: config.browserEvidenceArtifactRoot, roomId: bridge.claims.roomId, originalFilename: upload.filename });
          const saved = await withPersistedUpload(config.browserEvidenceArtifactRoot, upload, storage.filePath, (pinnedPath) =>
            recordUploadedArtifact(store, { roomId: bridge.claims.roomId, paneId: bridge.claims.paneId, kind: isVideoMimeType(mimeType) ? "VIDEO" : "IMAGE",
              mimeType, storageUri: storage.storageUri, sha256: upload.sha256, byteSize: upload.byteSize,
              metadata: { source: "CLI_AGENT", originalFilename: upload.filename, storedFilename: storage.storedFilename,
                cliSessionId: bridge.claims.cliSessionId, runtimeId: bridge.runtimeId } }, request.requestIdForSpace, pinnedPath));
          eventBus.publish(saved.event);
          artifacts.push(saved.artifact);
          continue;
        }
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
        action: media ? "room_media.publish" : "agent_file.publish",
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
      if (name === "collection") media = value === "media";
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
      browserSessions: await Promise.all(browserSessions.map(async (session) => {
        const target = signinTarget(session.currentUrl);
        const pane = await getPaneById(store, session.paneId).catch(() => null);
        const account = pane ? await siteAccountFor(pane, session.currentUrl) : null;
        const tabs = pane ? await tabAccountsFor(pane) : null;
        return {...summarizeCliBrowserSession(session),
          signin: await siteSigninFor(store, (await store.getRoom(bridge.claims.roomId)).ownerUserId, target.site ? `https://${target.site}/` : session.currentUrl),
          signinAccount: account ? siteAccountLine(account.check, false) : null,
          ...(tabs ? { tabAccounts: tabs.pages.map((page) => ({ pageId: page.pageId, isActive: page.isActive, google: page.google })) } : {})};
      }))
    });
  });
  app.post("/api/cli/browser/session", defaultRouteRateLimitOptions, async (request, reply) => {
    const bridge = await requireCliBrowserBridgeContext(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(spaceCliBrowserSessionStartRequestSchema, request.body ?? {});
    const panes = await store.listPanes(bridge.claims.roomId, false);
    // No target: this pane's own browser, else a new one; never a browser another agent drives.
    let browserPane = input.targetPaneId ? panes.find((pane) => pane.id === input.targetPaneId) : ownBrowserPane(panes, bridge.claims.paneId, controlActivity);
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
    controlActivity?.noteAgent(browserPane.id, bridge.claims.paneId);
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
        await assertBrowserHostPressKey(browserSessionManager, actionRequest.action);
        await assertNoForeignHandoff(browserPane.id, bridge.claims.cliSessionId);
        // A site whose sign-in lives in another Google account opens in that account's browser, not in the pane's default one.
        let accountNote: string | null = null;
        // nous_msg:fe72e061: no reset or forgot-password page while the stored sign-in works, unless the operator's order is passed.
        if (actionRequest.action.type === "navigate" && RESET_URL.test(actionRequest.action.url)) {
          const owner = (await store.getRoom(bridge.claims.roomId)).ownerUserId;
          const guard = resetRefusal(await siteSigninFor(store, owner, actionRequest.action.url).catch(() => null), input.operatorOrder);
          if (guard.refusal) throw new SpaceConflictError(guard.refusal);
          if (guard.override) await recordAudit(store, request, { action: "pane.cli.browser_action.reset_override", targetType: "pane", targetId: browserPane.id,
            metadata: { roomId: bridge.claims.roomId, cliPaneId: bridge.claims.paneId, operatorOrder: guard.override } });
        }
        if (actionRequest.action.type === "navigate") {
          const site = await siteAccountFor(browserPane, actionRequest.action.url);
          const held = (await store.getActivePaneBrowserSession(browserPane.id))?.controlState === "OPERATOR";
          if (site && !site.check.matches && !held) {
            const actor: BrowserHostActorContext = { holderType: "AGENT", holderId: `cli:${bridge.claims.cliSessionId}` };
            const move = await moveTabToWantedAccount(site.accounts, site.owner, browserPane, site.check, actionRequest.action.url, false, request.requestIdForSpace, actor);
            accountNote = `${siteAccountLine(site.check, move.moved)}${move.error ? ` The tab could not move (${move.error}); switch it with the pane's account menu or space_browser_select_account.` : ""}`;
            const moved = move.moved ? await store.getActivePaneBrowserSession(browserPane.id) : null;
            if (moved) {
              controlActivity?.noteAgent(browserPane.id, bridge.claims.paneId);
              results.push({
                request: safeBrowserActionRequestForResponse(actionRequest),
                status: "EXECUTED" as const,
                statusReason: `Opened in the site's Google account. ${accountNote}`.slice(0, 500),
                observation: { sessionId: moved.sessionId, paneId: moved.paneId, roomId: moved.roomId, actionType: actionRequest.action.type,
                  viewport: moved.viewport, currentUrl: safeBrowserObservationUrl(moved.currentUrl ?? actionRequest.action.url),
                  title: moved.title ? redactMemoryText(moved.title).slice(0, 500) : null, text: null, capturedAt: moved.lastFrameAt ?? null }
              });
              await recordAudit(store, request, { action: "pane.cli.browser_action.executed", targetType: "pane", targetId: browserPane.id,
                metadata: { roomId: bridge.claims.roomId, cliPaneId: bridge.claims.paneId, cliSessionId: bridge.claims.cliSessionId, sessionId: moved.sessionId,
                  actionType: actionRequest.action.type, siteAccount: site.check.wanted.email, site: site.check.site } });
              continue;
            }
          } else if (site) accountNote = siteAccountLine(site.check, false);
        }
        const actionResult = await browserSessionManager.action(
          browserPane,
          actionRequest.action,
          request.requestIdForSpace,
          { holderType: "AGENT", holderId: `cli:${bridge.claims.cliSessionId}` }
        );
        controlActivity?.noteAgent(browserPane.id, bridge.claims.paneId);
        const google = actionRequest.action.type === "navigate" ? (await tabAccountsFor(browserPane))?.pages.find((page) => page.isActive)?.google : undefined;
        // A Browser Host started before these actions existed ignores them and answers no text: say so (fail closed).
        if ((actionRequest.action.type === "press" || actionRequest.action.type === "masked_screenshot") && !actionResult.text) {
          throw new SpaceFeatureDisabledError("BROWSER_ACTION_UNAVAILABLE", `${actionRequest.action.type} needs the Browser Host restart that brings it.`);
        }
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
          statusReason: `Browser action executed through Space CLI mediation.${google ? ` Tab's Google account: google: ${google}.` : ""}${accountNote ? ` ${accountNote}` : ""}`.slice(0, 500),
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
    if (!handoffReadCommands.has(input.command.type)) await assertNoForeignHandoff(pane.id, bridge.claims.cliSessionId);
    if (input.command.type === "LIST_ACCOUNTS" || input.command.type === "SELECT_ACCOUNT") {
      // Saved Google sign-ins belong to the room's owner and, as in the pane's account menu, need the ADMIN role.
      // Credentials never leave Chrome: the agent only chooses which saved profile the pane opens.
      const ownerUserId = (await store.getRoom(pane.roomId)).ownerUserId;
      const owner = ownerUserId ? await store.getControlActor(ownerUserId) : null;
      if (owner?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Google account selection requires a room owned by an ADMIN.");
      // Freelance Copilot (operator 2026-10-18): the copilot saves each platform's bookmark with the account its sign-in lives in.
      // Marketing Copilot (Nous 12/11, plan clipboard:NdUqdzgGp_BR): it posts from the account its channels are signed in to.
      // Reading which account a pane and its tabs use is open to every pane with Google accounts (Job Copilot too); a Job Copilot's
      // pane account is also the copilot's mail and calendar account (pane-browser-routes.ts), so only its account menu changes it.
      const listable = ["BROWSER", "FREELANCE_COPILOT", "JOB_APPLY", "MARKETING_COPILOT"].includes(pane.mode);
      if (input.command.type === "LIST_ACCOUNTS" ? !listable : !listable || pane.mode === "JOB_APPLY") {
        throw new SpaceConflictError(input.command.type === "LIST_ACCOUNTS" ? "Google accounts are listed for Browser and copilot panes."
          : "Google account selection requires a Browser, Freelance Copilot or Marketing Copilot pane (a Job Copilot's account is chosen in its account menu).");
      }
      const accounts = paneBrowserAccounts.current;
      if (!accounts) throw new SpaceFeatureDisabledError("BROWSER_ACCOUNTS_UNAVAILABLE", "Google account selection is unavailable on this runtime.");
      const actor: BrowserHostActorContext = { holderType: "AGENT", holderId: `cli:${bridge.claims.cliSessionId}` };
      let accountResult: Record<string, unknown>;
      if (input.command.type === "LIST_ACCOUNTS") {
        const listing = await accounts.list(owner.id, pane);
        const effective = listing.profiles.find((profile) => profile.profileId === listing.effectiveProfileId);
        const pages = browserSessionManager.listPages ? await browserSessionManager.listPages(pane).catch(() => null) : null;
        accountResult = { ...listing,
          // Never silent: which account the pane opens by default, and each tab's account.
          effectiveEmail: effective?.email ?? null,
          byDefault: listing.selectedProfileId === null,
          ...(pages ? { tabs: pages.pages.map((page) => ({ pageId: page.pageId, isActive: page.isActive, url: page.url,
            profileId: page.account?.profileId ?? listing.effectiveProfileId, email: page.account?.label ?? effective?.email ?? null })) } : {}),
          note: listing.selectedProfileId === null && effective?.email
            ? `No account was chosen for this pane: it opens in ${effective.email} (the primary Google account) by default. Sites whose sign-in recipe (space_site_signin_get) names another Google account open in that account's browser.`
            : "Sites whose sign-in recipe (space_site_signin_get) names a Google account open in that account's browser." };
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
    if (input.command.type === "SET_ROUTE") {
      // Operator 31/10 (plan clipboard:iLvBs5eOMZjF): the CLI VPN routes are the room owner's, and like the pane's toolbar choice need an ADMIN.
      const ownerUserId = (await store.getRoom(pane.roomId)).ownerUserId;
      const owner = ownerUserId ? await store.getControlActor(ownerUserId) : null;
      if (owner?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "The browser's network route requires a room owned by an ADMIN.");
      const accounts = paneBrowserAccounts.current;
      if (!accounts) throw new SpaceFeatureDisabledError("BROWSER_ACCOUNTS_UNAVAILABLE", "The browser's network route is unavailable on this runtime.");
      const result = await accounts.setRoute(owner.id, pane, input.command.route, request.requestIdForSpace, { holderType: "AGENT", holderId: `cli:${bridge.claims.cliSessionId}` });
      await recordAudit(store, request, { action: "pane.cli.browser_route", targetType: "pane", targetId: pane.id,
        metadata: { roomId: pane.roomId, cliPaneId: bridge.claims.paneId, cliSessionId: bridge.claims.cliSessionId, route: result.route, restarted: result.restarted } });
      return { ...result, note: "The Browser Host applies the route when it starts the pane's Chrome; a route that is down fails closed (pages do not load)." };
    }
    const session = await getActiveBrowserSessionForPane(store, pane);
    controlActivity?.noteAgent(pane.id, bridge.claims.paneId);
    const actorId = `cli:${bridge.claims.cliSessionId}`;
    const captchaControl = async () => {
      const current = await store.getActivePaneBrowserSession(pane.id);
      if (!current || current.sessionId !== session.sessionId || current.activePageId !== session.activePageId) {
        throw new SpaceConflictError("The active browser tab/session changed; inspect the CAPTCHA again.");
      }
      if (await store.getActiveBrowserControlLease(session.sessionId)) throw new SpaceConflictError("An operator holds browser control; wait for the handoff to finish.");
    };
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
        result = await tabAccountsFor(pane) ?? await browserSessionManager.listPages(pane);
        break;
      case "CREATE_PAGE":
        if (!browserSessionManager.createPage) {
          throw new SpaceFeatureDisabledError("BROWSER_PAGES_UNAVAILABLE", "Browser page management is unavailable on this runtime.");
        }
        {
          // A new tab for a site whose sign-in lives in another Google account opens straight in that account's browser.
          const site = input.command.url ? await siteAccountFor(pane, input.command.url) : null;
          if (site) {
            const check = { ...site.check, tab: site.check.pane, matches: site.check.wanted.profileId === null
              ? site.check.pane.email?.toLowerCase() === site.check.wanted.email : site.check.wanted.profileId === site.check.paneProfileId };
            if (!check.matches && check.wanted.profileId !== null && pane.mode !== "FREELANCE_COPILOT" && session.controlState !== "OPERATOR") {
              try {
                const pages = await site.accounts.openTab(site.owner, pane, input.command.url!, check.wanted.profileId, request.requestIdForSpace, { holderType: "AGENT", holderId: actorId });
                result = { ...pages, siteAccount: `New tab opened in ${check.wanted.email}'s browser. ${siteAccountLine({ ...check, matches: true }, false)}` };
                break;
              } catch (error) {
                result = { ...await browserSessionManager.createPage(pane, input.command.url, input.command.activate, request.requestIdForSpace, { holderType: "AGENT", holderId: actorId }),
                  siteAccount: `${siteAccountLine(check, false)} The tab could not open in it (${error instanceof Error ? error.message.slice(0, 200) : "error"}).` };
                break;
              }
            }
            result = { ...await browserSessionManager.createPage(pane, input.command.url, input.command.activate, request.requestIdForSpace, { holderType: "AGENT", holderId: actorId }),
              siteAccount: siteAccountLine(check, false) };
            break;
          }
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
        // The summary leaves out the base64 frame, which flooded agent context (~357K characters).
        result = { session: summarizeCliBrowserSession((await browserSessionManager.setStreamMode(
          pane,
          input.command.streamMode,
          request.requestIdForSpace,
          { holderType: "AGENT", holderId: actorId }
        )).session) };
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
        // The operator's local time (plan clipboard:9XSwTPyxXP1W): at night the request waits for their morning, alive until an hour after it.
        const owner = (await store.getRoom(pane.roomId)).ownerUserId;
        const signinKind = ["LOGIN", "MFA"].includes(input.command.kind);
        // A Google sign-in page stands for the site it continues to: that site's recipe names the account.
        const target = signinTarget(session.currentUrl);
        const recipe = signinKind ? await signinHandoffRecipe(store, owner, target.site ? `https://${target.site}/` : session.currentUrl, input.command.triedStored) : {signin: null, blocked: false, site: null};
        // The Google account this sign-in needs, never the pane's default one (operator nous_msg:05e5af9f81ec45caa1f50f1b): a tab in another
        // account moves into the wanted account's browser; signed in there, the agent goes on without the operator.
        let accountLine: string | null = null;
        const site = signinKind ? await siteAccountFor(pane, session.currentUrl) : null;
        if (site) {
          const held = session.controlState === "OPERATOR";
          const move = held ? { moved: false, error: "the operator holds this browser" }
            : await moveTabToWantedAccount(site.accounts, site.owner, pane, site.check, target.destination ?? session.currentUrl ?? undefined, !site.check.wanted.signedIn,
              request.requestIdForSpace, { holderType: "AGENT", holderId: actorId });
          accountLine = siteAccountLine(site.check, move.moved) + (move.error && !site.check.matches ? ` (The tab could not move: ${move.error}.)` : "");
          if (move.moved && site.check.wanted.signedIn) {
            result = {status: "SWITCHED_ACCOUNT", account: site.check.wanted.email, siteAccount: accountLine,
              message: `The tab now runs in ${site.check.wanted.email}'s browser, which is signed in. Continue the sign-in there; request the handoff again only if it still needs the operator.`};
            break;
          }
          // Already in the wanted account and signed in: no sign-in card; one the agent tried and failed (triedStored) still reaches the operator.
          if (site.check.matches && site.check.wanted.signedIn && input.command.kind === "LOGIN" && !input.command.triedStored) {
            result = {status: "ALREADY_SIGNED_IN", account: site.check.wanted.email, siteAccount: accountLine,
              message: `This tab already runs in ${site.check.wanted.email}'s browser, which is signed in: continue the sign-in yourself ("Sign in with Google" picks it). Request the handoff again with triedStored: true only if it still fails.`};
            break;
          }
        }
        // nous_msg:fe72e061: a reset or recovery handoff while the stored sign-in works is refused, unless the operator's order is passed.
        if (owner && RESET_ASK.test(input.command.reason)) {
          const guard = resetRefusal(recipe.signin ?? await siteSigninFor(store, owner, target.site ? `https://${target.site}/` : session.currentUrl).catch(() => null), input.command.operatorOrder);
          if (guard.refusal) { result = {status: "SIGNIN_WORKS", message: guard.refusal}; break; }
          if (guard.override) await recordAudit(store, request, { action: "pane.cli.browser_handoff.reset_override", targetType: "pane", targetId: pane.id,
            metadata: { roomId: pane.roomId, operatorOrder: guard.override } });
        }
        if (recipe.blocked) { result = {status: "TRY_STORED_SIGNIN", signin: recipe.signin, ...(accountLine ? {siteAccount: accountLine} : {}), message: "Use this stored method, profile and mailbox first. If it fails, record FAILURE and request handoff with triedStored: true."}; break; }
        // 7/11 Oracle: a sign-in the Vault holds goes to the operator only once its login was filled and the page read back since the last
        // reset; triedStored alone does not say so. A bot check, a phone push or code, a camera and a payment still go through.
        const signinAsk = input.command.kind === "LOGIN" || (input.command.kind === "OTHER" && VAULT_SIGNIN_ASK.test(input.command.reason));
        const vaultSite = signinAsk && owner && !OPERATOR_HANDS.test(input.command.reason) ? siteSigninKeySchema.safeParse({site: target.site ?? session.currentUrl ?? ""}) : null;
        if (owner && vaultSite?.success) {
          const vault = deps.vault;
          const step = await vaultSigninHold(owner, vaultSite.data.site, recipe.signin ?? await siteSigninFor(store, owner, vaultSite.data.site), async () => {
            if (!vault) return null;
            const listed = await vault.agent.call({ owner, paneId: pane.id, roomId: pane.roomId, path: "list", body: { site: vaultSite.data.site }, traceId: request.requestIdForSpace ?? "" }) as { items?: unknown[] };
            return Array.isArray(listed.items) ? listed.items.length : null;
          });
          if (step) { result = {status: "READ_BACK_FIRST", message: step}; break; }
        }
        // nous_msg:243370cb: a check, code or other hands handoff whose page asks for an e-mailed code is the agent's (an unread page: its reason).
        if (input.command.kind !== "LOGIN") {
          const page = await pageChallenge({ config, pane, session }).catch(() => null);
          const mailCode = mailCodeHandoff(page, input.command.reason, target.site);
          if (mailCode) { result = {status: "MAIL_CODE", message: mailCode}; break; }
        }
        const night = await ownerQuietNow(owner ? await store.getUserSettings(owner) : null, owner);
        const handoff = await store.createBrowserHandoffRequest({
          sessionId: session.sessionId,
          paneId: pane.id,
          roomId: pane.roomId,
          requestedByType: "AGENT",
          requestedById: actorId,
          reason: `${input.command.kind}: ${recipe.site ? `[site:${recipe.site}] ` : ""}${accountLine ? `${accountLine} ` : ""}${recipe.signin ? `Stored method ${recipe.signin.method}, account ${recipe.signin.googleAccountEmail ?? recipe.signin.siteAccountEmail ?? "main"}. ` : ""}${input.command.reason}`.slice(0, 500),
          // A login or MFA needs the operator to come to the pane and a phone; five minutes ran out before
          // they arrived and "Take control" then had nothing to accept. The agent waits up to 15 minutes.
          ttlSeconds: handoffTtlSeconds(night)
        });
        const handoffEvent = (await store.listEvents(pane.roomId)).find((event) => event.traceId === handoff.handoffRequestId);
        if (handoffEvent) eventBus.publish(handoffEvent);
        deps.dropOtherAgents?.(pane.id, bridge.claims.cliSessionId);
        result = { handoff, operator: ownerHandsAnswer(night) };
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
        result = { cancelled: false, handoff: active ?? null };
        if (active?.requestedByType !== "AGENT" || active.requestedById !== actorId) break;
        if (active.status === "REQUESTED") {
          result = { cancelled: true, handoff: await store.updateBrowserHandoffRequest(active.handoffRequestId, { status: "CANCELLED" }) };
        } else if (active.status === "ACCEPTED" && active.controlLeaseId) {
          const lease = await store.getActiveBrowserControlLease(session.sessionId);
          const activity = controlActivity ?? createBrowserControlActivity();
          if (lease?.leaseId !== active.controlLeaseId || lease.paneId !== pane.id || lease.holderType !== "OPERATOR"
            || activity.inputIdleMs(lease) < BROWSER_CONTROL_PRESENCE_HOLD_MAX_MS) break;
          await releaseBrowserControlLease({ store, browserSessionManager, activity },
            { pane, lease, request, handoffStatus: "CANCELLED", auditAction: "pane.browser.control.agent_cancel", auditMetadata: { agent: actorId } });
          result = { cancelled: true, handoff: await store.getBrowserHandoffRequest(active.handoffRequestId) };
        }
        break;
      }
      case "TEXT_CAPTCHA": {
        result = await textCaptcha({ config, pane, session, actor: actorId, command: input.command, checkControl: captchaControl });
        break;
      }
      case "SLIDER_CAPTCHA": {
        result = await sliderCaptcha({ config, pane, session, command: input.command, checkControl: captchaControl });
        break;
      }
      case "UPLOAD_FILE": {
        // Like the CDP proxy: no automation while an operator holds the browser.
        if (await store.getActiveBrowserControlLease(session.sessionId)) throw new SpaceConflictError("An operator holds browser control; wait for the handoff to finish.");
        const owner = (await store.getRoom(pane.roomId)).ownerUserId;
        const job = owner && deps.jobApplyService ? await deps.jobApplyService.uploadableFiles(owner) : null;
        const paths = await uploadablePaths(input.command.paths, { roots: [NOUS_FILES_ROOT, ...(job ? [job.dir] : [])], files: job?.files ?? [] });
        result = await uploadBrowserFiles({ config, pane, session, paths, index: input.command.index });
        break;
      }
      case "PAGE_READOUT": {
        if (await store.getActiveBrowserControlLease(session.sessionId)) throw new SpaceConflictError("An operator holds browser control; wait for the handoff to finish.");
        const owner = (await store.getRoom(pane.roomId)).ownerUserId;
        const readout = await pageReadout({ config, pane, session });
        // The read-back a sign-in handoff or card and the next password reset wait for (signin-readback.ts).
        if (owner) markSignin(owner, `https://${readout.host}/`, "read");
        result = readout;
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
