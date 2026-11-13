import type { MailCampaignsService } from "./mail-campaigns/service.js";
import type { MailCopilotGoogleAccess } from "./mail-copilot/service.js";
import { controlExecuteSchema, type Pane } from "@space/contracts";
import { PostgresSpaceStore } from "@space/db";
import { makeSpaceId, type GoogleAccount, type SpaceStore } from "@space/runtime";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { registerAdminUserRoutes } from "./admin-user-routes.js";
import { registerAgentSessionHistoryRoutes, registerAgentSessionThreadRoutes } from "./agent-session-routes.js";
import { registerAppSignIn } from "./app-signin.js";
import { cookieName, defaultSessionRevocationStore, googleRedirectUriFor, requestOrigin, signOAuthState, verifyOAuthState, verifySession } from "./auth.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { googleBrowserProfilePathFor } from "./browser-sessions.js";
import { registerClientErrorRoutes } from "./client-error-routes.js";
import { registerClipboardRoutes } from "./clipboard-routes.js";
import { createCodexEnvironmentStats } from "./codex-environment-stats.js";
import type { SpaceApiConfig } from "./config.js";
import { startMakeWebhooks } from "./make-webhooks.js";
import type { createConnectorService } from "./dot-connectors.js";
import { registerGatewayAdminRoutes } from "./gateway/gateway-routes.js";
import { createGatewayAdminService, type GatewayAdminService } from "./gateway/gateway-service.js";
import { readGoogleBrowserCheck, summarizeGoogleBrowserStatus, type GoogleBrowserStatusSummary } from "./google-browser-session-check.js";
import type { createInstallTelemetry } from "./install-telemetry.js";
import { registerFirstAnswerWatch, registerInstallTelemetryRoutes } from "./install-telemetry-routes.js";
import { registerLinkInspectRoutes } from "./link-inspect-routes.js";
import type { NousWiring } from "./nous/wiring.js";
import { recordAudit } from "./request-audit.js";
import type { createRoomCliControl } from "./room-cli-control.js";
import type { createRoomPaneCliController } from "./room-pane-cli-controller.js";
import type { createSessionAccess } from "./session-access.js";
import { registerSharedChatRoutes } from "./shared-chat-routes.js";
import { GitControlError } from "./source-control/errors.js";
import type { createSpaceControl } from "./space-control.js";
import { registerSystemServicesRoutes } from "./system-services-routes.js";
import { registerTaskItemRoutes } from "./task-item-routes.js";
import type { TaskScheduleRunnerDeps } from "./task-schedules.js";
import { registerTraceRoutes } from "./trace-routes.js";
import { registerUserLinkRoutes } from "./user-link-routes.js";

type Deps<F extends (app: FastifyInstance, deps: never) => unknown> = Parameters<F>[1];
type AppSignInDeps = Parameters<typeof registerAppSignIn>[1];
type SpaceControlExecute = ReturnType<typeof createSpaceControl>["execute"];
type SignInRoutesDeps = Pick<Deps<typeof registerAuthRoutes>, "auth" | "browserSessionManager" | "persistRevocation">
  & Pick<Deps<typeof registerAdminUserRoutes>, "userRoleCache">
  & {
    store: SpaceStore; config: SpaceApiConfig; nousRef: { current: NousWiring | null };
    connectorCrypto: AppSignInDeps["crypto"]; eventBus: AppSignInDeps["events"]; notificationService: AppSignInDeps["notifications"];
    sessionAccess: Pick<ReturnType<typeof createSessionAccess>, "forget">;
    defaultRouteRateLimitOptions: Deps<typeof registerAuthRoutes>["routeOptions"] & AppSignInDeps["routeOptions"];
    /** Tests' Google access and Gmail fetch (createApp's mailCopilot* options), for the pairing e-mail. */
    mailCopilotGoogle?: MailCopilotGoogleAccess; mailCopilotGmailFetch?: typeof fetch;
    /** Tests: Forgot password's mail, instead of the owner's Mail Campaigns sender. */
    passwordResetMail?: (owner: string, to: string, subject: string, text: string) => Promise<void>;
    /** Mail Campaigns is created later, with the copilot panes; read per request. */
    mailCampaigns?: () => MailCampaignsService | undefined;
  };
type UserToolRoutesDeps = Pick<Deps<typeof registerAgentSessionThreadRoutes>, "codexParity" | "unifiedCliTaskRegistry" | "cliRuntimeVisibility" | "visibleCliRuntimeIds">
  & Pick<Deps<typeof registerAgentSessionHistoryRoutes>, "agentSessionHistoryService">
  & Pick<Deps<typeof registerSharedChatRoutes>, "auth" | "cliTerminalManager">
  & Pick<Deps<typeof registerSystemServicesRoutes>, "systemServicesProvider">
  & Pick<Parameters<typeof createCodexEnvironmentStats>[1], "hostStatsProvider">
  & {
    store: SpaceStore; config: SpaceApiConfig; options: { gatewayAdminService?: GatewayAdminService }; nousRef: { current: NousWiring | null };
    gatewayRepositoryFor: () => Parameters<typeof createGatewayAdminService>[0]["repository"];
    gatewayVaultKey?: Deps<typeof registerGatewayAdminRoutes>["vaultKey"];
    installTelemetry: Pick<ReturnType<typeof createInstallTelemetry>, "active" | "firstAnswer">;
    readDashboardAgents: Deps<typeof registerFirstAnswerWatch>["readRoom"];
    roomPaneController: Pick<ReturnType<typeof createRoomPaneCliController>, "inspect">;
    commandRoomCli: ReturnType<typeof createRoomCliControl>["commandRoomCli"];
    spaceControl: { execute: SpaceControlExecute }; controlUser: (id: string) => Promise<Parameters<SpaceControlExecute>[0]>;
    defaultRouteRateLimitOptions: Deps<typeof registerClipboardRoutes>["routeOptions"] & Deps<typeof registerSharedChatRoutes>["routeOptions"];
    defaultWebsocketRateLimitOptions: Deps<typeof registerSharedChatRoutes>["websocketRouteOptions"];
  };

/** Sign-in support and the account routes (moved verbatim from app.ts, ARCH-001 step 75): Google accounts' browser statuses, the Dots
 * owner check, the OAuth state tools and redirect base, the auth routes with the Space apps' sign-in, and the admin user routes. Returns
 * what app.ts reads elsewhere. */
export function registerSignInRoutes(app: FastifyInstance, deps: SignInRoutesDeps) {
  const { store, config, auth, browserSessionManager, persistRevocation, userRoleCache, nousRef, connectorCrypto, eventBus, notificationService,
    sessionAccess, defaultRouteRateLimitOptions } = deps;
  async function googleAccountBrowserStatuses(accounts: GoogleAccount[]): Promise<Map<string, GoogleBrowserStatusSummary>> {
    const active = accounts.length ? await store.listActivePaneBrowserSessions() : [];
    return new Map(await Promise.all(accounts.map(async (account): Promise<[string, GoogleBrowserStatusSummary]> => {
      const path = googleBrowserProfilePathFor(config.browserSessionsProfileRoot, account.ownerUserId, account.id);
      // Only a definite ENOENT means "no profile"; other stat errors stay Unknown.
      const profileExists = await stat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
      const check = profileExists ? await readGoogleBrowserCheck(path).catch(() => null) : null;
      const activeUrls = active.filter(candidate => candidate.profileId === `google-account:${account.id}`).map(candidate => candidate.currentUrl);
      return [account.id, summarizeGoogleBrowserStatus({ profileExists, check, activeUrls })];
    })));
  }
  const dotsAuthenticatedOwner = async (request: FastifyRequest) => {
    if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
      throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
    }
    return (await store.upsertUser(request.user)).id;
  };
  const connectorStateTools = {
    sign: (value: string) => signOAuthState(value, auth.sessionSecret),
    verify: (token: string | undefined) => verifyOAuthState(token, auth.sessionSecret),
    sessionHash: (request: FastifyRequest) => createHash("sha256").update(request.cookies[cookieName] ?? "").digest("hex"),
    redirectUri: (request: FastifyRequest, provider: "GOOGLE" | "MICROSOFT") => provider === "GOOGLE"
      ? googleRedirectUriFor(request, auth, config.port)
      : process.env.SPACE_MICROSOFT_REDIRECT_URI || `${requestOrigin(request, auth.secureCookies, config.port)}/api/connectors/microsoft/callback`,
    secureCookies: auth.secureCookies
  };
  // The connector service is created with the other Dot services; the sign-in callback reaches it through this reference.
  const connectorServiceRef: { current: ReturnType<typeof createConnectorService> | null } = { current: null };
  // Forgot password's mail (Nous 13/11): the owner's personal sender. shortcut: this install's sender id; a Settings choice if another install needs it.
  const passwordResetMail = { get current() {
    const campaigns = deps.mailCampaigns?.();
    return deps.passwordResetMail ?? (campaigns ? (owner: string, to: string, subject: string, text: string) => campaigns.sendTransactional(owner, "msender:Yp9r40K3jQ46", { to, subject, text }) : null);
  } };
  registerAuthRoutes(app, {
    config, auth, store, browserSessionManager, routeOptions: defaultRouteRateLimitOptions, passwordResetMail,
    googleAccountBrowserStatuses, dotsAuthenticatedOwner, connectorStateTools, connectorServiceRef, persistRevocation, appSignIn: registerAppSignIn(app, { store, crypto: connectorCrypto, version: config.version, events: eventBus, notifications: notificationService, decision: async (owner, id) => (await nousRef.current?.service.decisions(owner))?.find((item) => item.id === id) ?? null, goal: async (owner, id) => (await nousRef.current?.service.goalsView(owner))?.goals.find((item) => item.id === id) ?? null, sessionSecret: auth.sessionSecret, routeOptions: defaultRouteRateLimitOptions, persistRevocation, revocations: defaultSessionRevocationStore, databaseUrl: store instanceof PostgresSpaceStore ? config.databaseUrl : null, mobileRelayUrl: config.mobileRelayUrl, mobilePushUrl: config.mobilePushUrl, mobileDemo: config.mobileDemo, playIntegrityFile: config.playIntegrityServiceAccountFile,
      google: () => deps.mailCopilotGoogle ?? connectorServiceRef.current, gmailFetch: deps.mailCopilotGmailFetch })
  });

  registerAdminUserRoutes(app, {
    store, userRoleCache, routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input),
    multiUserEnabled: config.multiUserEnabled === true,
    revokeUserSessions: (userId) => persistRevocation(defaultSessionRevocationStore.revokeUser(userId)).finally(() => sessionAccess.forget(userId))
  });
  return { googleAccountBrowserStatuses, dotsAuthenticatedOwner, connectorStateTools, connectorServiceRef };
}

/** The user's own tool routes (moved verbatim from app.ts, ARCH-001 step 75): Space Gateway admin, clipboard, client errors and install
 * telemetry, trace, shared chat, tasks with their schedules, link inspection, user links, agent session history and threads, system
 * services. Returns the gateway admin service and the closed-pane reopener that app.ts reads elsewhere. */
export function registerUserToolRoutes(app: FastifyInstance, deps: UserToolRoutesDeps) {
  const { store, config, options, auth, nousRef, cliTerminalManager, cliRuntimeVisibility, codexParity, unifiedCliTaskRegistry, agentSessionHistoryService,
    visibleCliRuntimeIds, hostStatsProvider, systemServicesProvider, installTelemetry, readDashboardAgents, gatewayRepositoryFor, roomPaneController,
    commandRoomCli, spaceControl, controlUser, defaultRouteRateLimitOptions, defaultWebsocketRateLimitOptions, gatewayVaultKey } = deps;
  startMakeWebhooks(store, config.instance);
  /** Briefs a Marketing or Freelance Copilot pane (registerCopilotPaneRoutes sets it once those services exist): scheduled tasks reach them so. */
  const taskBrief: { current: TaskScheduleRunnerDeps["brief"] | null } = { current: null };
  let gatewayAdminService = options.gatewayAdminService;
  if (!gatewayAdminService) {
    gatewayAdminService = createGatewayAdminService({ repository: gatewayRepositoryFor(), gatewayUrl: config.gatewayUrl, internalToken: config.gatewayAdminToken || config.internalApiToken });
  }
  registerGatewayAdminRoutes(app, {
    service: gatewayAdminService, routeOptions: defaultRouteRateLimitOptions, vaultKey: gatewayVaultKey,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });

  registerClipboardRoutes(app, {
    store, routeOptions: defaultRouteRateLimitOptions
  });

  registerClientErrorRoutes(app);
  registerInstallTelemetryRoutes(app, { onActive: (fields) => installTelemetry.active.observe(fields) });
  registerFirstAnswerWatch(app, { reporter: installTelemetry.firstAnswer, rooms: async () => store.listRooms(), readRoom: readDashboardAgents });

  registerTraceRoutes(app, { store, routeOptions: defaultRouteRateLimitOptions });

  registerSharedChatRoutes(app, {
    auth, store, cliTerminalManager, routeOptions: defaultRouteRateLimitOptions,
    websocketRouteOptions: defaultWebsocketRateLimitOptions
  });
  const reopenClosedPane = async (pane: Pane, owner: string) => spaceControl.execute(await controlUser(owner), controlExecuteSchema.parse({ roomId: pane.roomId, requestId: makeSpaceId("task_reopen"), actions: [{ kind: "pane", operation: pane.mode === "TERMINAL" ? "reopen" : "start", target: { paneIds: [pane.id], state: "ALL" }, when: "NOW" }] }));
  // R44-3: a recurring agent task whose pane is gone gets a new Claude Code pane in its room (the pane Space Control's panes.open adds).
  const openTaskPane = async (roomId: string, owner: string) => {
    const before = new Set((await store.listPanes(roomId, true)).map((pane) => pane.id));
    const receipt = await spaceControl.execute(await controlUser(owner), controlExecuteSchema.parse({ roomId, requestId: makeSpaceId("task_open"),
      actions: [{ kind: "resource", operation: "panes.open", input: { counts: { claude: 1 } } }] }));
    const pane = (await store.listPanes(roomId, false)).find((entry) => !before.has(entry.id));
    if (!pane) throw new Error((receipt as { results?: Array<{ error?: string }> }).results?.find((result) => result.error)?.error ?? "Space Control opened no pane.");
    return pane;
  };
  registerTaskItemRoutes(app, { store, routeOptions: defaultRouteRateLimitOptions, recordAudit: (request, input) => recordAudit(store, request, input),
    schedules: config.instanceJobs["task-schedules"] ? { inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }),
      answer: (pane, input, requestId) => commandRoomCli(pane, { type: "cli_command", paneId: pane.id, ...input, when: "NOW" }, requestId ?? makeSpaceId("trace")), reopen: reopenClosedPane, openPane: openTaskPane,
      brief: async (pane, owner, text) => { if (!taskBrief.current) throw new Error("The copilots are not available here."); return taskBrief.current(pane, owner, text); }, notice: async (owner, key, line) => { await nousRef.current?.service.notice(owner, key, line); } } : null });

  registerLinkInspectRoutes(app, { routeOptions: defaultRouteRateLimitOptions });

  registerUserLinkRoutes(app, {
    store, routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });

  registerAgentSessionHistoryRoutes(app, {
    store, codexParity, unifiedCliTaskRegistry, agentSessionHistoryService, visibleCliRuntimeIds,
    routeOptions: defaultRouteRateLimitOptions
  });

  registerSystemServicesRoutes(app, { systemServicesProvider, routeOptions: defaultRouteRateLimitOptions });

  const { readCodexEnvironmentSpaceStats, readCodexEnvironmentHostStats } =
    createCodexEnvironmentStats(app, { store, hostStatsProvider });
  registerAgentSessionThreadRoutes(app, {
    store, codexParity, unifiedCliTaskRegistry, cliRuntimeVisibility, visibleCliRuntimeIds,
    readCodexEnvironmentSpaceStats, readCodexEnvironmentHostStats, routeOptions: defaultRouteRateLimitOptions
  });
  return { gatewayAdminService, reopenClosedPane, taskBrief };
}
