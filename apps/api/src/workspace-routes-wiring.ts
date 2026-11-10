import { agentPaneGoalSchema } from "@space/contracts";
import type { PostgresDotHomeRepository, PostgresDotMemoryRepository, PostgresDotsRepository } from "@space/db";
import type { CodexGoalsAdapter, SpaceStore } from "@space/runtime";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { registerAppDiagnosticsCaptureRoutes } from "./app-diagnostics-routes.js";
import { registerAsteroidsDirectorRoutes } from "./asteroids-director.js";
import { cookieName, verifySession, type AuthConfig } from "./auth.js";
import { registerBenchmarkRoutes } from "./benchmark-routes.js";
import { createWorkerCliMoveRunner } from "./chess/chess-cli.js";
import { pickClaudeProfile, type ChessCliBridge } from "./chess/chess-players.js";
import { registerChessBenchmarkRoutes } from "./chess/chess-routes.js";
import { findRuntime, type createAgentRuntimeRegistryCache } from "./cli-runtimes.js";
import type { SpaceApiConfig } from "./config.js";
import { registerDatabasesRoutes } from "./databases/databases-routes.js";
import { createDemoProjectsService } from "./default-app-services.js";
import { registerDemoProjectsRoutes } from "./demo-projects/routes.js";
import { registerDotHomeRoutes } from "./dot-home.js";
import { registerDotsRoutes } from "./dots-routes.js";
import { registerFilesRoutes } from "./files-routes.js";
import { harnessRoleAllowed, registerHarnessRoutes } from "./harness-proxy.js";
import { isOtherSiteUpgradeRequest } from "./http-origin-guard.js";
import { registerPluginRoutes } from "./plugins-routes.js";
import { recordAudit } from "./request-audit.js";
import { cookieValueFromHeader } from "./request-helpers.js";
import { GitControlError } from "./source-control/errors.js";
import { registerSourceControlRoutes } from "./source-control/routes.js";
import type { SourceControlService } from "./source-control/service.js";
import type { SpaceAgentAdapter } from "./space-agent.js";
import { t3PublicOrigins } from "./t3code/access.js";
import { registerT3Bindings } from "./t3code/bindings.js";
import { registerT3Gateway } from "./t3code/gateway.js";
import { registerT3LegacyRetirement } from "./t3code/legacy.js";
import { createT3CodeServiceController, registerT3CodeAdminRoutes } from "./t3code/service-control.js";
import { registerT3StaticAssets, t3StartupAssets } from "./t3code/static-assets.js";
import { t3InlineBootstrapSupported } from "./t3code/upstream.js";
import { registerWorktreeRoutes } from "./worktrees/worktree-routes.js";
import type { WorktreeService } from "./worktrees/worktree-service.js";

type WorkspaceRoutesDeps = {
  store: SpaceStore; config: SpaceApiConfig; auth: Pick<AuthConfig, "sessionSecret">;
  options: { t3CodeServiceController?: Parameters<typeof registerT3CodeAdminRoutes>[1]["controller"]; resumeChessTournament?: boolean };
  appDiagnosticsService: Parameters<typeof registerAppDiagnosticsCaptureRoutes>[1]["appDiagnosticsService"];
  claudeUsageProvider: () => Promise<{ data: Parameters<typeof pickClaudeProfile>[0] }>;
  cliChatRuntimeState: ChessCliBridge["state"]; cliModelsExecutor: (runtimeId: string) => () => ReturnType<ChessCliBridge["listModels"]>;
  cliRuntimeRegistryCache: Pick<ReturnType<typeof createAgentRuntimeRegistryCache>, "read">;
  codexGoals: Pick<CodexGoalsAdapter, "list">;
  dotsRepository: PostgresDotsRepository | null; dotMemoryRepository: PostgresDotMemoryRepository | null; dotHomeRepository: PostgresDotHomeRepository | null;
  spaceAgentAdapter: Pick<SpaceAgentAdapter, "listModelChoices">;
  sourceControlService: SourceControlService; worktreeService: WorktreeService;
  publicBrowserOrigins: Parameters<typeof isOtherSiteUpgradeRequest>[1];
  defaultRouteRateLimitOptions: Record<string, unknown> & Parameters<typeof registerDotsRoutes>[1]["routeOptions"] & Parameters<typeof registerChessBenchmarkRoutes>[1];
};

function resolveDemoPublicOrigin(request: { headers: Record<string, unknown> }, config: SpaceApiConfig): string {
  if (config.demoProjectsPublicOrigin) return config.demoProjectsPublicOrigin;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const forwardedHost = request.headers["x-forwarded-host"];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers["host"];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ?? "https";
  if (typeof host === "string" && host.length > 0) return `${String(proto).split(",")[0]!.trim()}://${host.split(",")[0]!.trim()}`;
  return `http://127.0.0.1:${config.port}`;
}

/** The workspace tool routes (moved verbatim from app.ts, ARCH-001 step 76): demo projects, T3 Code, the games (benchmarks, chess, the
 * Asteroids director), Dots and Dot Home, plugins, personal source control and worktrees, the Harness, files, databases and the app
 * diagnostics capture, in the order app.ts registered them. Returns the demo projects service, which app.ts disposes on close. */
export async function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRoutesDeps) {
  const { store, config, auth, options, appDiagnosticsService, claudeUsageProvider, cliChatRuntimeState, cliModelsExecutor, cliRuntimeRegistryCache,
    codexGoals, dotsRepository, dotMemoryRepository, dotHomeRepository, spaceAgentAdapter, sourceControlService, worktreeService, publicBrowserOrigins,
    defaultRouteRateLimitOptions } = deps;
  const demoProjectsService = createDemoProjectsService({
    config,
    log: (event, detail) => app.log.info({ ...detail, event }, "demo projects")
  });

  registerDemoProjectsRoutes(app, {
    service: demoProjectsService,
    enabled: config.demoProjectsEnabled,
    rateLimitOptions: defaultRouteRateLimitOptions,
    sessionToken: (request) => request.cookies[cookieName] ?? "",
    ownerId: async (request) => (await store.upsertUser(request.user!)).id,
    resolvePublicOrigin: (request) => resolveDemoPublicOrigin(request, config)
  });

  // T3 Code: the feature flag scopes only these encapsulated T3 namespaces.
  // The configured public UI origin is accepted alongside the derived one, as
  // for voice sessions, because the TLS/web proxy hides the browser origin.
  const t3Origins = t3PublicOrigins(config.browserEvidenceTargetOrigin, config.demoProjectsPublicOrigin);
  const t3Bindings = await registerT3Bindings(app, { enabled: config.t3CodeEnabled, sessionSecret: auth.sessionSecret, store, publicOrigins: t3Origins,
    socketPath: config.t3CodeSocketPath, healthTimeoutMs: config.t3CodeHealthTimeoutMs, agentTokens: { config } });
  await registerT3Gateway(app, { enabled: config.t3CodeEnabled, sessionSecret: auth.sessionSecret, store, publicOrigins: t3Origins,
    socketPath: config.t3CodeSocketPath, timeoutMs: config.t3CodeProxyTimeoutMs,
    documentBootstrap: t3Bindings.openForDocument, inlineBootstrapEnabled: t3InlineBootstrapSupported, startupAssets: () => t3StartupAssets() });
  await registerT3StaticAssets(app, { enabled: config.t3CodeEnabled, sessionSecret: auth.sessionSecret });
  await registerT3LegacyRetirement(app);
  registerT3CodeAdminRoutes(app, {
    featureEnabled: config.t3CodeEnabled,
    controller: options.t3CodeServiceController ?? createT3CodeServiceController(),
    socketPath: config.t3CodeSocketPath,
    healthTimeoutMs: config.t3CodeHealthTimeoutMs,
    routeOptions: defaultRouteRateLimitOptions,
    audit: (request, action, metadata) => recordAudit(store, request, { action, targetType: "managed_service", targetId: "space-t3code.service", metadata })
  });

  if (config.optionalModules.has("games")) registerBenchmarkRoutes(app, defaultRouteRateLimitOptions, {
    // Claude pilots fly on the signed-in account with the most quota left, like chess and T3 Code.
    claudeProfile: async () => pickClaudeProfile((await claudeUsageProvider()).data)
  });
  if (config.optionalModules.has("games")) registerChessBenchmarkRoutes(app, defaultRouteRateLimitOptions, {
    // Chess CLI moves run in the worker: CLI processes must never live in the space-api cgroup.
    runCliMove: createWorkerCliMoveRunner(),
    cli: {
      listModels: (runtimeId) => cliModelsExecutor(runtimeId)(),
      // A chess player must also be signed in (Kimi and Autohand can be enabled but not connected).
      state: async (runtimeId) => {
        const state = await cliChatRuntimeState(runtimeId);
        if (!state.enabled) return state;
        const runtime = findRuntime(await cliRuntimeRegistryCache.read(), runtimeId);
        return runtime?.authState === "READY" ? state : { enabled: false, reason: runtime?.authReason ?? "Sign-in required." };
      }
    },
    // Claude moves go to the signed-in account with the most quota left, like T3 Code.
    claudeProfile: async () => pickClaudeProfile((await claudeUsageProvider()).data),
    autoResume: options.resumeChessTournament === true
  });

  if (config.optionalModules.has("games")) registerAsteroidsDirectorRoutes(app, defaultRouteRateLimitOptions);

  if (dotsRepository) app.addHook("onClose", () => dotsRepository.dispose());
  if (dotMemoryRepository) app.addHook("onClose", () => dotMemoryRepository.dispose());
  if (dotHomeRepository) app.addHook("onClose", () => dotHomeRepository.dispose());
  registerDotsRoutes(app, {
    repository: dotsRepository, routeOptions: defaultRouteRateLimitOptions,
    // Goals and schedules have dedicated Stage 4 routes; their Stage 2 collections live under /collections.
    dedicatedResources: ["goals", "schedules"],
    nativeGoals: async () => (await codexGoals.list()).map(goal => agentPaneGoalSchema.parse({
      threadId: goal.threadId, goalId: goal.goalId, objective: goal.title, status: goal.status,
      tokenBudget: goal.tokenBudget, tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds,
      createdAt: goal.createdAt, updatedAt: goal.updatedAt
    })),
    authenticatedOwner: async request => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    }
  });

  registerDotHomeRoutes(app, {
    repository: dotHomeRepository, routeOptions: defaultRouteRateLimitOptions,
    modelChoices: spaceAgentAdapter.listModelChoices ? () => spaceAgentAdapter.listModelChoices!() : undefined,
    authenticatedOwner: async request => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    }
  });

  const personalGitOwner = async (request: FastifyRequest) => {
    if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) throw new GitControlError("UNAUTHENTICATED", "Sign in to use personal Source Control.", 401);
    return (await store.upsertUser(request.user)).id;
  };
  registerPluginRoutes(app, defaultRouteRateLimitOptions, {
    service: sourceControlService,
    owner: personalGitOwner
  }, { recordAudit: (request, input) => recordAudit(store, request, input) });
  registerSourceControlRoutes(app, { service: sourceControlService, store, rateLimitOptions: defaultRouteRateLimitOptions, authenticatedOwner: personalGitOwner });
  registerWorktreeRoutes(app, {
    service: worktreeService,
    rateLimitOptions: defaultRouteRateLimitOptions,
    authorizeDestructive: (request) => request.user?.role === "ADMIN" || request.user?.role === "OPERATOR"
  });
  app.addHook("onClose", async () => { await sourceControlService.close(); });

  registerHarnessRoutes(app, config, store, {
    agentTokens: { config },
    authorizeUpgrade: (upgradeRequest) => {
      const user = verifySession(cookieValueFromHeader(upgradeRequest.headers.cookie, cookieName), auth.sessionSecret);
      return !isOtherSiteUpgradeRequest(upgradeRequest.headers, publicBrowserOrigins) && Boolean(user) && harnessRoleAllowed(user?.role)
        // The Harness is a UI pane: a proof session may open it, an admin action's session never.
        && (!user?.brokerScope || user.brokerScope === "UI_PROOF") && !(user?.id === "user:operator-proof" && user.proofScope);
    }
  });

  registerFilesRoutes(app, { hostModeEnabled: config.filesHostModeEnabled, store });
  registerDatabasesRoutes(app);

  registerAppDiagnosticsCaptureRoutes(app, { appDiagnosticsService, routeOptions: defaultRouteRateLimitOptions });
  return { demoProjectsService };
}
