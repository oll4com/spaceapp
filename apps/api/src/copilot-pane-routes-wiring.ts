import { siteSigninFor } from "./site-signins.js";
import { eventSchema, type AuthUser, type MailCopilotRun, type Pane } from "@space/contracts";
import { InMemoryMailCopilotRepository, PostgresMailCopilotRepository, type MailCopilotRepository, type SpaceNotificationsRepository } from "@space/db";
import { makeSpaceId, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { fileURLToPath } from "node:url";
import { registerAppStudio, type AppStudioWiring } from "./app-studio/wiring.js";
import { cookieName, verifySession, type AuthConfig } from "./auth.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import { createHostSwap } from "./nous/server-load.js";
import { registerDesign, type DesignWiring } from "./design/wiring.js";
import { readConnectorKey, type ConnectorCrypto } from "./dot-connectors.js";
import { registerFreelanceCopilot, type FreelanceCopilotWiring } from "./freelance-copilot/wiring.js";
import { registerCodexQuotaResetWatch } from "./gateway/gateway-codex-services.js";
import { registerGatewayDownWatch } from "./gateway/gateway-down-watch.js";
import { createImapMailboxFactory } from "./job-apply/mailbox.js";
import { completeAppointment } from "./job-apply/interview-tasks.js";
import { registerJobApply } from "./job-apply-wiring.js";
import { registerMailCampaigns } from "./mail-campaigns/wiring.js";
import type { MailTransportDeps } from "./mail-campaigns/transports.js";
import { createMailCopilotKickoff } from "./mail-copilot/kickoff.js";
import { mailCopilotEventNotifies, notifyMailCopilotEvent } from "./mail-copilot/notify.js";
import { registerMailCopilotRoutes } from "./mail-copilot/routes.js";
import { createMailCopilotService, type MailCopilotGoogleAccess } from "./mail-copilot/service.js";
import { createMailCopilotSync } from "./mail-copilot/sync.js";
import { registerMarketingCopilot, type MarketingCopilotWiring } from "./marketing-copilot/wiring.js";
import { registerMemoryMaintenanceFailureWatch } from "./memory-maintenance-watch.js";
import { registerMonitoringCopilot, type MonitoringCopilotWiring } from "./monitoring-copilot/wiring.js";
import { startBrowserHandoffNotifications } from "./notifications/browser-handoff.js";
import { registerNotificationRoutes } from "./notifications/routes.js";
import type { NotificationService } from "./notifications/service.js";
import { startPaneCli } from "./nous/copilot-control.js";
import type { NousWiring } from "./nous/wiring.js";
import type { PaneBrowserAccountControl } from "./pane-browser-routes.js";
import { recordAudit } from "./request-audit.js";
import type { createRoomPaneCliController } from "./room-pane-cli-controller.js";
import { parseBody, parseQuery } from "./route-parsing.js";
import { registerMakeAppRoutes } from "./make-app-routes.js";
import { registerSecurityCopilot, type SecurityCopilotWiring } from "./security-copilot/wiring.js";
import { GitControlError } from "./source-control/errors.js";
import type { registerUserToolRoutes } from "./user-routes-wiring.js";
import type { VaultModule } from "./vault/wiring.js";
import { registerVideo, type VideoWiring } from "./video/wiring.js";
import { pinnedMemoryFor } from "./nous/operator-facts.js";
import { registerAppointments } from "./appointments.js";
import { submitCliPrompt } from "./cli-prompt-submit.js";
import { registerSignatures } from "./signatures.js";

type CopilotPaneRoutesDeps = {
  store: SpaceStore; config: SpaceApiConfig; auth: Pick<AuthConfig, "sessionSecret" | "operatorEmail">; eventBus: SpaceEventBus;
  options: Parameters<typeof registerJobApply>[1]["options"] & {
    /** A test app's canonical memory: no Space Memory file to read. */
    canonicalMemory?: unknown;
    mailCopilotGoogle?: MailCopilotGoogleAccess; mailCopilotGmailFetch?: typeof fetch; mailCopilotRepository?: MailCopilotRepository;
    mailCopilotKickoff?: (pane: Pane, run: MailCopilotRun) => Promise<void>; mailCopilotSync?: boolean;
    marketingCopilotRepository?: MarketingCopilotWiring["repository"]; marketingCopilotKickoff?: MarketingCopilotWiring["kickoff"]; marketingCopilotScheduler?: boolean;
    marketingCopilotMetrics?: boolean; freelanceCopilotRepository?: FreelanceCopilotWiring["repository"]; freelanceCopilotKickoff?: FreelanceCopilotWiring["kickoff"];
    freelanceCopilotScheduler?: boolean; freelanceCopilotMailboxes?: FreelanceCopilotWiring["mailboxes"];
    designRepository?: DesignWiring["repository"]; designGenerate?: DesignWiring["generate"]; designRender?: DesignWiring["render"]; designKickoff?: DesignWiring["kickoff"];
    appStudioRepository?: AppStudioWiring["repository"]; appStudioKickoff?: AppStudioWiring["kickoff"]; securityCopilotRepository?: SecurityCopilotWiring["repository"];
    securityCopilotFeeds?: SecurityCopilotWiring["feeds"]; securityCopilotKickoff?: SecurityCopilotWiring["kickoff"]; securityCopilotWatch?: boolean;
    monitoringCopilotRepository?: MonitoringCopilotWiring["repository"]; monitoringCopilotCollector?: MonitoringCopilotWiring["collector"];
    monitoringCopilotKickoff?: MonitoringCopilotWiring["kickoff"]; monitoringCopilotWatch?: boolean; mailCampaignsRepository?: import("@space/db").MailCampaignsRepository;
    mailCampaignsSmtp?: MailTransportDeps["smtp"]; mailCampaignsSender?: boolean; videoRepository?: VideoWiring["repository"]; videoEngine?: VideoWiring["engine"];
    videoKickoff?: VideoWiring["kickoff"];
  };
  defaultRouteRateLimitOptions: Parameters<typeof registerJobApply>[1]["defaultRouteRateLimitOptions"] & Parameters<typeof registerMailCopilotRoutes>[2]["routeOptions"];
  connectorCrypto: ConnectorCrypto; connectorServiceRef: Parameters<typeof registerJobApply>[1]["connectorServiceRef"];
  notificationsRepository: Pick<SpaceNotificationsRepository, "dispose">; notificationService: NotificationService;
  notificationPrune: ReturnType<typeof setInterval>; stopMorningBatches: () => void; stopNotificationProducers: () => void;
  roomOwner: (roomId: string) => Promise<string | null>; telegramIntegrationManager: Parameters<typeof registerJobApply>[1]["telegramIntegrationManager"];
  roomPaneController: Pick<ReturnType<typeof createRoomPaneCliController>, "inspect" | "start">; cliTerminalManager: CliTerminalManager;
  assertRoomAccess: (roomId: string, user: AuthUser | null | undefined) => Promise<unknown>; nousRef: { current: NousWiring | null };
  railCli: Omit<Parameters<typeof startPaneCli>[0], "invoke" | "store">; controlInvoke: Parameters<typeof startPaneCli>[0]["invoke"];
  toolbarUsageProvider: Parameters<typeof registerCodexQuotaResetWatch>[1]["usage"]; reopenClosedPane: ReturnType<typeof registerUserToolRoutes>["reopenClosedPane"]; taskBrief: ReturnType<typeof registerUserToolRoutes>["taskBrief"];
  // Registered after these routes; Mail Campaigns reads its repository per kept-key send, long after start.
  vault: Pick<VaultModule, "repository">;
};

/** The notification and copilot pane routes (moved verbatim from app.ts, ARCH-001 step 77): the notification store's close and the browser
 * handoff notices, the Job Copilot, the Mail Copilot with its sync, the notification routes and the quota, gateway and memory watches, then
 * the copilot-style panes (Marketing, Freelance, Design, App Studio, Security, Monitoring, Mail Campaigns, Video), in the order app.ts
 * registered them. Returns the services and the pane browser account reference app.ts reads afterwards. */
export function registerCopilotPaneRoutes(app: FastifyInstance, deps: CopilotPaneRoutesDeps) {
  const { store, config, auth, eventBus, options, defaultRouteRateLimitOptions, connectorCrypto, connectorServiceRef, notificationsRepository, notificationService,
    notificationPrune, stopMorningBatches, stopNotificationProducers, roomOwner, telegramIntegrationManager, roomPaneController, cliTerminalManager, assertRoomAccess,
    nousRef, railCli, controlInvoke, toolbarUsageProvider, reopenClosedPane, taskBrief, vault } = deps;
  app.addHook("onClose", () => notificationsRepository.dispose());
  app.addHook("onClose", () => { clearInterval(notificationPrune); stopMorningBatches(); stopNotificationProducers(); });
  app.addHook("onClose", startBrowserHandoffNotifications({ store, notifications: notificationService, eventBus, roomOwner, log: app.log }));
  // The operator's appointments and their reminders (operator 2/11 15:22 BKK); the store finds them for Nous, the CLI bridge and the Job Copilot.
  registerAppointments(app, { store, databaseUrl: config.databaseUrl, notifications: notificationService, routeOptions: defaultRouteRateLimitOptions,
    reminders: config.instanceJobs["appointment-reminders"], log: app.log,
    annotate: async (owner, text, hint) => await nousRef.current?.fileMentions.annotate(owner, text, hint) ?? text, onDone: async (owner, item) => {
      // The Job Copilot is registered below; DONE only comes once the app serves requests.
      const done = await completeAppointment({ store, notifications: notificationService,
        jobApply: { listEvents: (who, filter) => jobApplyRepository.listEvents(who, filter), logEvent: (who, input) => jobApplyService.logEvent(who, input) } }, owner, item);
      const what = [done.applicationId ? `application ${done.applicationId} has a NOTE` : "", done.taskId ? `task ${done.taskId} is done` : "", done.closed ? `${done.closed} card${done.closed === 1 ? "" : "s"} closed` : ""].filter(Boolean);
      await nousRef.current?.service.notice(owner, `appointment-done:${item.id}`, `Appointment completed: ${item.title}${what.length ? ` (${what.join("; ")})` : ""}. Update the goal notes and plans it touches.`);
    } });
  // Signature from the phone (plan clipboard:2qSLIT_csvPm): the owner's signature, agents' signature requests, signed copies in Agent Files.
  registerSignatures(app, { store, databaseUrl: config.databaseUrl, artifactRoot: config.browserEvidenceArtifactRoot, notifications: notificationService,
    routeOptions: defaultRouteRateLimitOptions, log: app.log, publish: (event) => eventBus.publish(event as Parameters<typeof eventBus.publish>[0]),
    notice: (owner, key, line) => nousRef.current?.service.notice(owner, key, line),
    tellPane: async (pane, text) => {
      const session = await store.getActivePaneCliSession(pane.id);
      if (!session) throw new Error("The pane has no CLI session.");
      // Only into a free prompt: a working CLI gets nothing typed (Nous's inbox has the line).
      await submitCliPrompt(cliTerminalManager, session.sessionId, text, `trace:signature:${pane.id}`, `signature:${pane.id}:${Date.now()}`, { onlyWhenReady: true, paneId: pane.id });
    } });
  // Job Copilot pane: per-owner candidate profile, sealed mailbox credential, tracker, memory, fields, events and runs.
  // Plan clipboard:7L5KyWp3kQsP step 3: Job and Freelance questions meet the operator's pinned Space Memory first (a test app's canonical memory has no file).
  const operatorMemory = options.canonicalMemory ? undefined : (question: string) => pinnedMemoryFor(config.spaceMemoryMonthlyPath, question);
  const { jobApplyRepository, jobApplyService } = registerJobApply(app, { store, config, options, auth, eventBus, defaultRouteRateLimitOptions, connectorCrypto, connectorServiceRef,
    notificationService, roomOwner, telegramIntegrationManager, roomPaneController, cliTerminalManager, assertRoomAccess, operatorMemory });
  // Mail Copilot pane: settings and the operator's view live on the pane; the mailbox is the owner's Google accounts;
  // memory, activity (the agent's work queue) and runs are per owner. Events reach the room stream and, when the
  // copilot needs the operator, the notification system.
  const mailCopilotRepository = options.mailCopilotRepository ?? (config.databaseUrl ? PostgresMailCopilotRepository.fromConnectionString(config.databaseUrl) : new InMemoryMailCopilotRepository());
  app.addHook("onClose", () => mailCopilotRepository.dispose());
  const mailCopilotPaneRooms = new Map<string, string>();
  const mailCopilotKickoff = createMailCopilotKickoff({ store, terminal: cliTerminalManager, send: options.mailCopilotKickoff, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), start: async (pane) => startPaneCli({ invoke: controlInvoke, store, ...railCli }, (await roomOwner(pane.roomId)) ?? "", pane) });
  // nous_msg:8f84e7e6: a copilot review naming the operator's order to Nous is checked against these.
  const operatorMessages = async (owner: string) => (await nousRef.current?.service.operatorMessageRefs(owner)) ?? [];
  const mailCopilotService = createMailCopilotService({
    kickoff: mailCopilotKickoff, operatorMessages, siteSignin: (owner, domain) => siteSigninFor(store, owner, `https://${domain}/`), notice: (owner, key, line, urgent) => nousRef.current?.service.notice(owner, key, line, undefined, urgent ? { soonMs: 5_000 } : {}),
    google: () => options.mailCopilotGoogle ?? connectorServiceRef.current,
    gmailFetch: options.mailCopilotGmailFetch,
    repository: mailCopilotRepository, resolveNotice: (owner, key) => notificationService.resolve(owner, key),
    onEvent: (event) => {
      void (async () => {
        if (!event.paneId) return;
        let roomId = mailCopilotPaneRooms.get(event.paneId) ?? null;
        let pane: Pane | null = null;
        if (!roomId) {
          pane = await Promise.resolve(store.getPane(event.paneId)).catch(() => null);
          roomId = pane?.roomId ?? null;
          if (roomId) mailCopilotPaneRooms.set(event.paneId, roomId);
        }
        if (!roomId) return;
        eventBus.publish(eventSchema.parse({
          id: makeSpaceId("event"), roomId, paneId: event.paneId, turnId: null, workflowId: null, traceId: `mail-copilot:${event.id}`,
          type: "MAIL_COPILOT_UPDATED", message: event.message, payload: { eventId: event.id, type: event.type, threadId: event.threadId, accountEmail: event.accountEmail }, createdAt: event.createdAt
        }));
        if (!mailCopilotEventNotifies(event)) return;
        pane ??= await Promise.resolve(store.getPane(event.paneId)).catch(() => null);
        const owner = pane?.mode === "MAIL_COPILOT" ? await roomOwner(roomId) : null;
        if (pane && owner) await notifyMailCopilotEvent(event, { roomId, pane, owner, notifications: notificationService });
      })().catch((error: unknown) => app.log.warn({ err: error }, "Mail Copilot event listener failed"));
    }
  });
  registerNotificationRoutes(app, notificationService, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: async (request) => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to read notifications.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    },
    parseBody,
    parseQuery
  });
  // New mail: Gmail history polling for every open Mail Copilot pane (stable only, like Job Copilot's mail triage).
  const mailCopilotSync = createMailCopilotSync({ service: mailCopilotService, store, log: app.log });
  app.addHook("onReady", async () => {
    if (config.instanceJobs["mail-copilot-sync"] && options.mailCopilotSync !== false && config.optionalModules.has("mail-copilot")) mailCopilotSync.start();
  });
  app.addHook("onClose", async () => mailCopilotSync.stop());
  registerCodexQuotaResetWatch(app, { enabled: config.instanceJobs["codex-quota-reset-notify"], usage: toolbarUsageProvider, store, notifications: notificationService });
  registerGatewayDownWatch(app, { enabled: config.instanceJobs["gateway-down-notify"], publicDistribution: config.publicDistribution, gatewayUrl: config.gatewayUrl, store, notifications: notificationService });
  registerMemoryMaintenanceFailureWatch(app, { enabled: config.instanceJobs["memory-maintenance-notify"] && config.memoryGraphEnabled && config.memoryMaintenanceEnabled,
    address: config.temporalAddress, namespace: config.temporalNamespace, store, notifications: notificationService });
  if (config.optionalModules.has("mail-copilot")) registerMailCopilotRoutes(app, mailCopilotService, {
    store,
    routeOptions: defaultRouteRateLimitOptions,
    kickoff: mailCopilotKickoff.send,
    authenticatedOwner: async (request) => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Mail Copilot.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    },
    assertPaneAccess: async (request, pane) => { await assertRoomAccess(pane.roomId, request.user); },
    parseBody,
    parseQuery,
    audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "mail_copilot", targetId, metadata })
  });
  const paneBrowserAccounts: { current: PaneBrowserAccountControl | null } = { current: null };
  // The copilot-style panes (Marketing, Freelance, Design, App Studio, Video, Security Copilot) share one route auth: the room's access, the audit row's target type, the signed-in owner.
  const paneModuleAuth = (targetType: string, product: string) => ({ assertPaneAccess: async (request: FastifyRequest, pane: Pane) => { await assertRoomAccess(pane.roomId, request.user); },
    audit: (request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>) => recordAudit(store, request, { action, targetType, targetId, metadata }),
    authenticatedOwner: async (request: FastifyRequest) => { if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) throw new GitControlError("UNAUTHENTICATED", `Sign in to use ${product}.`, 401); return (await store.upsertUser(request.user)).id; } });
  const marketingCopilotService = !config.optionalModules.has("marketing-copilot") ? undefined : registerMarketingCopilot(app, { store, operatorMessages, eventBus, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), paneBrowserAccounts, artifactRoot: config.browserEvidenceArtifactRoot, terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.marketingCopilotRepository, kickoff: options.marketingCopilotKickoff, routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log, notifications: notificationService, roomOwner, scheduler: config.instanceJobs["marketing-copilot-scheduler"] && options.marketingCopilotScheduler !== false, metrics: config.instanceJobs["marketing-copilot-metrics"] && options.marketingCopilotMetrics !== false, notice: (owner, key, line) => nousRef.current?.service.notice(owner, key, line), reopen: reopenClosedPane, ...paneModuleAuth("marketing_copilot", "Marketing Copilot") });
  const freelanceCopilotService = !config.optionalModules.has("freelance-copilot") ? undefined : registerFreelanceCopilot(app, { store, operatorMessages, eventBus, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.freelanceCopilotRepository, kickoff: options.freelanceCopilotKickoff, crypto: connectorCrypto, mailboxes: options.freelanceCopilotMailboxes ?? createImapMailboxFactory(), routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log, notifications: notificationService, roomOwner, scheduler: config.instanceJobs["freelance-copilot-scheduler"] && options.freelanceCopilotScheduler !== false, reopen: reopenClosedPane, notice: (owner, key, line) => nousRef.current?.service.notice(owner, key, line), ...paneModuleAuth("freelance_copilot", "Freelance Copilot"),
    operatorMemory });

  const designService = !config.optionalModules.has("design") ? undefined : registerDesign(app, { store, eventBus, terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.designRepository,
    generate: options.designGenerate, render: options.designRender, kickoff: options.designKickoff, notifications: notificationService, roomOwner, artifactRoot: config.browserEvidenceArtifactRoot,
    brandRoot: fileURLToPath(new URL("../../web/public/brand", import.meta.url)), gatewayUrl: config.gatewayUrl, gatewayKeyFile: config.designGatewayKeyFile,
    routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log,
    marketingPostExists: marketingCopilotService ? async (owner, postId) => Boolean(await marketingCopilotService.getPost(owner, postId).catch(() => null)) : undefined,
    attachToMarketingPost: marketingCopilotService ? async (owner, postId, assets) => { await marketingCopilotService.attachAssets(owner, postId, assets); } : undefined,
    invoke: controlInvoke, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), start: (pane) => roomPaneController.start(pane, makeSpaceId("trace")), ...paneModuleAuth("design", "the Design pane") });
  const appStudioService = !config.optionalModules.has("app-studio") ? undefined : registerAppStudio(app, { store, eventBus, terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.appStudioRepository, kickoff: options.appStudioKickoff, notifications: notificationService, artifactRoot: config.browserEvidenceArtifactRoot, routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), notice: (owner, key, line) => nousRef.current?.service.notice(owner, key, line), ...paneModuleAuth("app_studio", "App Studio") });
  const securityCopilotService = !config.optionalModules.has("security-copilot") ? undefined : registerSecurityCopilot(app, { store, eventBus, terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.securityCopilotRepository, feeds: options.securityCopilotFeeds, kickoff: options.securityCopilotKickoff, notifications: notificationService, watch: config.instanceJobs["security-copilot-watch"] && options.securityCopilotWatch !== false, routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), ...paneModuleAuth("security_copilot", "the Security Copilot") }); const monitoringCopilotService = !config.optionalModules.has("monitoring-copilot") ? undefined : registerMonitoringCopilot(app, { store, eventBus, terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.monitoringCopilotRepository, collector: options.monitoringCopilotCollector, collectorConfig: config.monitoringCollector, kickoff: options.monitoringCopilotKickoff, notifications: notificationService, watch: config.instanceJobs["monitoring-copilot-watch"] && options.monitoringCopilotWatch !== false, routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), reopen: reopenClosedPane, notice: (owner, key, line) => nousRef.current?.service.notice(owner, key, line), ...paneModuleAuth("monitoring_copilot", "the Monitoring Copilot") }); const mailCampaignsService = !config.optionalModules.has("mail-campaigns") ? undefined : registerMailCampaigns(app, { store, databaseUrl: config.databaseUrl, repository: options.mailCampaignsRepository, google: () => options.mailCopilotGoogle ?? connectorServiceRef.current, vaultStore: () => vault.repository, crypto: connectorCrypto, smtp: options.mailCampaignsSmtp, notifications: notificationService, coversApproval: async (owner) => Boolean(await nousRef.current?.coversApproval(owner)), unsubscribeSecret: readConnectorKey(config.connectorKeyFile) ?? auth.sessionSecret, senderJob: config.instanceJobs["mail-campaign-sender"] && options.mailCampaignsSender !== false, healthJob: config.instanceJobs["mail-campaign-health"] && options.mailCampaignsSender !== false, log: app.log, routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, threadParticipants: async (owner, account, threadId) => (await mailCopilotService.thread(owner, null, account, threadId)).messages.flatMap((message) => [message.from, ...message.to, ...message.cc]), ...paneModuleAuth("mail_campaigns", "Mail Campaigns") });

  const videoService = !config.optionalModules.has("video") ? undefined : registerVideo(app, { store, eventBus, hostSwap: createHostSwap({ collectorConfig: config.monitoringCollector, hostSelector: config.loadHostSelector }), terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.videoRepository,
    engine: options.videoEngine, kickoff: options.videoKickoff, notifications: notificationService, roomOwner, artifactRoot: config.browserEvidenceArtifactRoot, workRoot: config.videoWorkRoot, toolsDir: config.videoToolsDir,
    sourceMaxBytes: config.videoSourceMaxBytes, routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log, invoke: controlInvoke, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), start: (pane) => roomPaneController.start(pane, makeSpaceId("trace")), marketingPostExists: marketingCopilotService ? async (owner, postId) => Boolean(await marketingCopilotService.getPost(owner, postId).catch(() => null)) : undefined,
    attachToMarketingPost: marketingCopilotService ? async (owner, postId, assets) => { await marketingCopilotService.attachAssets(owner, postId, assets); } : undefined, ...paneModuleAuth("video", "the Video pane") });
  // A scheduled task bound to a copilot that takes briefs goes to it as one (task-schedules.ts BRIEF_MODES; R58: all seven, as Nous's sends do).
  taskBrief.current = async (pane, owner, text) => {
    const off = (name: string) => new Error(`The ${name} is off on this instance.`);
    const requester = { kind: "OPERATOR" as const, roomId: pane.roomId, label: "Scheduled task" };
    switch (pane.mode) {
      case "MARKETING_COPILOT": if (!marketingCopilotService) throw off("Marketing Copilot"); return marketingCopilotService.createBrief(owner, pane, { text });
      case "FREELANCE_COPILOT": if (!freelanceCopilotService) throw off("Freelance Copilot"); return freelanceCopilotService.createBrief(owner, pane, { text });
      case "DESIGN": if (!designService) throw off("Design pane"); return designService.createRequest(owner, requester, { brief: text, formatIds: [], referenceArtifactIds: [], designPaneId: pane.id });
      case "VIDEO": if (!videoService) throw off("Video pane"); return videoService.createRequest(owner, requester, { brief: text, videoPaneId: pane.id });
      case "APP_STUDIO": if (!appStudioService) throw off("App Studio"); return appStudioService.addBrief(owner, pane, text, "OPERATOR");
      case "SECURITY_COPILOT": if (!securityCopilotService) throw off("Security Copilot"); return securityCopilotService.addBrief(owner, pane, text, "OPERATOR");
      case "MONITORING_COPILOT": if (!monitoringCopilotService) throw off("Monitoring Copilot"); return monitoringCopilotService.addBrief(owner, pane, text, "OPERATOR");
      default: throw new Error(`A ${pane.mode} pane takes no brief.`);
    }
  };
  registerMakeAppRoutes(app, { store, operatorEmail: auth.operatorEmail, nous: () => nousRef.current, notifications: notificationService, brief: () => taskBrief.current, roomOwner, routeOptions: defaultRouteRateLimitOptions });
  return { jobApplyRepository, jobApplyService, mailCopilotService, paneBrowserAccounts, marketingCopilotService, freelanceCopilotService, designService,
    appStudioService, securityCopilotService, monitoringCopilotService, mailCampaignsService, videoService };
}
