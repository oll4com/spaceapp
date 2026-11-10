import { readFile } from "node:fs/promises";
import { slackAppUrl } from "@space/contracts";
import { PostgresChannelsRepository, type ChannelsRepository, type PostgresDotHomeRepository } from "@space/db";
import { SpaceConflictError, makeSpaceId } from "@space/runtime";
import type { FastifyInstance } from "fastify";
import { cookieName, verifySession, type AuthConfig } from "./auth.js";
import { createPriceCatalogLoader } from "./auto-route-facts.js";
import { createSlackClient, parseSlackEnvelope, verifySlackSignature } from "./channel-slack.js";
import { createBotFrameworkVerifier, createTeamsClient, parseTeamsActivity } from "./channel-teams.js";
import type { SpaceApiConfig } from "./config.js";
import { createDotChannelService, registerDotChannelRoutes } from "./dot-channels.js";
import { registerDotComputerRoutes } from "./dot-computer.js";
import { registerDotLiveAndEvals } from "./dot-live-evals-wiring.js";
import { createDotProactiveService, createProactiveDecider } from "./dot-proactive.js";
import { getPaneById } from "./pane-guards.js";
import { GitControlError } from "./source-control/errors.js";

type DotChannelsProactiveWiringDeps = Omit<Parameters<typeof registerDotLiveAndEvals>[1], "channelsRepository" | "dotChannelService"> & {
  config: Pick<SpaceApiConfig, "optionalModules" | "modelPriceCatalogPath" | "codexLbBaseUrl" | "codexLbKeyFile" | "enableCodexTurns" | "instanceJobs">;
  options: { channelsRepository?: ChannelsRepository };
  auth: Pick<AuthConfig, "sessionSecret" | "googleRedirectUri">;
  dotHomeRepository: PostgresDotHomeRepository | null;
  dotComputerService: Parameters<typeof registerDotComputerRoutes>[1];
};

/**
 * Dots stages 6 to 8 (moved verbatim from app.ts, ARCH-001 step 71): Slack and Teams conversations with their signature-checked
 * routes, Dot Live and evaluations (registerDotLiveAndEvals), the Dot computer routes, the proactive mail and calendar notices, and
 * the timers of schedules, proactive checks, channel sweeps, delegation reports and Goal reconciliation (stable's dot-schedules job).
 * Returns the channel service and the evaluations repository, which the Dot tool gateway reads.
 */
export function registerDotChannelsAndProactive(app: FastifyInstance, deps: DotChannelsProactiveWiringDeps) {
  const { store, config, options, auth, eventBus, defaultRouteRateLimitOptions, dotsAuthenticatedOwner, dotsRepository, dotGoalsRepository, dotHomeRepository,
    dotGoalService, dotDelegationService, dotScheduleService, connectorService, dotComputerService, cliRuntimeVisibility, roomPaneCommands, spaceAgentAdapter,
    spaceControl, controlUser } = deps;
  // Stage 6: Slack and Teams conversations with Dots. Configured per installation; inbound requests are verified by signature.
  const channelsRepository = options.channelsRepository
    ?? (dotsRepository && dotGoalsRepository && config.databaseUrl ? PostgresChannelsRepository.fromConnectionString(config.databaseUrl) : null);
  if (channelsRepository && !options.channelsRepository) app.addHook("onClose", () => channelsRepository.dispose());
  const slackSigningSecret = process.env.SPACE_SLACK_SIGNING_SECRET || null;
  const slackClient = slackSigningSecret && process.env.SPACE_SLACK_BOT_TOKEN ? createSlackClient({ botToken: process.env.SPACE_SLACK_BOT_TOKEN }) : null;
  const teamsAppId = process.env.SPACE_TEAMS_APP_ID || null;
  const teamsClient = teamsAppId && process.env.SPACE_TEAMS_APP_PASSWORD
    ? createTeamsClient({ appId: teamsAppId, appPassword: process.env.SPACE_TEAMS_APP_PASSWORD, tenant: process.env.SPACE_TEAMS_TENANT || null }) : null;
  const appOrigin = (() => {
    if (process.env.SPACE_PUBLIC_ORIGIN) return process.env.SPACE_PUBLIC_ORIGIN.replace(/\/$/, "");
    try { return auth.googleRedirectUri ? new URL(auth.googleRedirectUri).origin : null; } catch { return null; }
  })();
  const dotChannelService = config.optionalModules.has("channels") && channelsRepository && dotsRepository && dotGoalsRepository && dotGoalService ? createDotChannelService({
    repo: channelsRepository, slack: slackClient, teams: teamsClient,
    providers: [
      { provider: "SLACK", configured: Boolean(slackClient), reason: slackClient ? null : "Slack needs an app on this server (SPACE_SLACK_SIGNING_SECRET and SPACE_SLACK_BOT_TOKEN).",
        appUrl: slackClient ? slackAppUrl(process.env.SPACE_SLACK_APP_ID) : null },
      { provider: "TEAMS", configured: Boolean(teamsClient), reason: teamsClient ? null : "Teams needs a bot registration on this server (SPACE_TEAMS_APP_ID and SPACE_TEAMS_APP_PASSWORD)." }
    ],
    store, dots: dotsRepository,
    pickRoom: async (owner) => {
      const rooms = (await store.listRooms(owner)).filter((room) => room.kind === "WORKSPACE" && room.ownerUserId === owner);
      return rooms.sort((a, b) => a.order - b.order)[0]?.id ?? null;
    },
    openPane: async ({ roomId, title }) => {
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const [input] = await roomPaneCommands.resolve(roomId, [{ mode: "CHAT" }]);
      const [pane] = await store.createPanes([{ ...input!, title }], makeSpaceId("trace"));
      for (const event of (await store.listEvents(roomId)).filter((event) => event.type === "PANE_CREATED" && event.paneId === pane!.id)) eventBus.publish(event);
      return pane!;
    },
    startSession: async ({ pane, owner, dotId }) => {
      const session = await spaceAgentAdapter.createOrRestoreSession({ pane, dotId, ownerUserId: owner });
      if (!session.binding.sessionId || session.dotId !== dotId) throw new SpaceConflictError("The channel conversation could not start.");
      return { sessionId: session.binding.sessionId };
    },
    send: async ({ paneId, sessionId, owner, content, requestKey }) => {
      await spaceAgentAdapter.sendMessage({ pane: await getPaneById(store, paneId), sessionId, content, operatorUserId: owner, clientRequestId: requestKey,
        traceId: makeSpaceId("trace") });
    },
    pendingApprovals: async (owner, dotId, sessionId) => ((await dotsRepository.listPendingApprovals(owner, dotId, sessionId)) ?? [])
      .map((item) => ({ invocationId: item.invocationId, summary: item.approvalSummary ?? item.toolId })),
    goalFor: async (owner, dotId, sessionId) => {
      const goal = (await dotGoalsRepository.list(owner, dotId, sessionId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return goal ? { goalId: goal.goalId, status: goal.status, statusReason: goal.statusReason ?? null, createdAt: goal.createdAt, updatedAt: goal.updatedAt } : null;
    },
    answerGoal: async (owner, dotId, goalId, text) => {
      await dotGoalService.steer(owner, dotId, goalId, { text: text.slice(0, 4000) }, null);
      await dotGoalService.control(owner, dotId, goalId, { action: "RESUME" }, null);
    },
    appOrigin,
    log: (message, error) => app.log.warn({ err: error }, message)
  }) : null;
  registerDotChannelRoutes(app, dotChannelService, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: dotsAuthenticatedOwner,
    verifySlack: slackSigningSecret ? (input) => verifySlackSignature({ ...input, signingSecret: slackSigningSecret }) : null,
    parseSlack: parseSlackEnvelope,
    verifyTeams: teamsAppId && teamsClient ? createBotFrameworkVerifier({ appId: teamsAppId }) : null,
    parseTeams: parseTeamsActivity,
    log: (message, error) => app.log.warn({ err: error }, message)
  });
  const { dotEvalsRepository } = registerDotLiveAndEvals(app, { store, config, options, eventBus, defaultRouteRateLimitOptions, dotsAuthenticatedOwner,
    dotsRepository, dotGoalsRepository, channelsRepository, dotGoalService, dotDelegationService, dotScheduleService, connectorService, dotChannelService,
    cliRuntimeVisibility, roomPaneCommands, spaceAgentAdapter, spaceControl, controlUser });
  registerDotComputerRoutes(app, dotComputerService, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: async request => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    }
  });
  // Stage 8: the Dot writes to the user on its own about new email and upcoming events (read-only checks).
  const dotProactiveModel = process.env.SPACE_DOT_PROACTIVE_MODEL || "gpt-5.6-sol";
  const dotProactiveService = dotHomeRepository && dotsRepository && connectorService ? createDotProactiveService({
    home: dotHomeRepository, dots: dotsRepository,
    accounts: async (owner) => (await connectorService.status(owner)).accounts,
    connectorTool: (owner, toolId, args) => connectorService.tool(owner, toolId, args),
    timeZone: async (owner) => (await store.getUserSettings(owner)).dateTime.timeZone,
    alsoSlack: dotChannelService ? (owner, notice) => dotChannelService.notifyOwner(owner, notice) : undefined,
    usage: { model: dotProactiveModel, prices: createPriceCatalogLoader(config.modelPriceCatalogPath ?? null),
      record: (owner, entry) => dotHomeRepository.addProactiveUsage(owner, entry) },
    decide: createProactiveDecider({ baseUrl: config.codexLbBaseUrl, model: dotProactiveModel,
      apiKey: async () => config.codexLbKeyFile ? (await readFile(config.codexLbKeyFile, "utf8").catch(() => "")).trim() || null : null }),
    log: (message, detail) => app.log.warn(detail, message)
  }) : null;
  let dotProactiveTimer: NodeJS.Timeout | null = null;
  let dotChannelTimer: NodeJS.Timeout | null = null;
  let dotScheduleTimer: NodeJS.Timeout | null = null;
  let dotDelegationTimer: NodeJS.Timeout | null = null;
  let dotGoalReconcileTimer: NodeJS.Timeout | null = null;
  app.addHook("onReady", async () => {
    if (!config.enableCodexTurns || !config.instanceJobs["dot-schedules"]) return;
    if (dotScheduleService) {
      dotScheduleTimer = setInterval(() => void dotScheduleService.tick().catch((error) => app.log.warn({ err: error }, "Dot schedule tick failed.")), 30_000);
      dotScheduleTimer.unref();
    }
    if (dotProactiveService) {
      dotProactiveTimer = setInterval(() => void dotProactiveService.tick().catch((error) => app.log.warn({ err: error }, "Dot proactive tick failed.")), 5 * 60_000);
      dotProactiveTimer.unref();
    }
    if (dotChannelService) {
      // Slack and Teams: answers, Goal questions and approval notices, and messages that waited for a busy Dot.
      dotChannelTimer = setInterval(() => void dotChannelService.sweep().catch((error) => app.log.warn({ err: error }, "Channel sweep failed.")), 15_000);
      dotChannelTimer.unref();
    }
    if (dotDelegationService) {
      // Delegated Goals report their outcome to the delegating conversation; a busy conversation is retried.
      dotDelegationTimer = setInterval(() => void dotDelegationService.reportOutcomes().catch((error) => app.log.warn({ err: error }, "Dot delegation reports failed.")), 60_000);
      dotDelegationTimer.unref();
    }
    if (dotGoalService) {
      const reconcile = () => void dotGoalService.reconcile().then((restarted) => {
        if (restarted) app.log.warn({ restarted }, "Restarted drivers for open Dot Goals.");
      }).catch((error) => app.log.warn({ err: error }, "Dot Goal reconciliation failed."));
      setTimeout(reconcile, 60_000).unref();
      dotGoalReconcileTimer = setInterval(reconcile, 5 * 60_000);
      dotGoalReconcileTimer.unref();
    }
  });
  app.addHook("onClose", async () => { if (dotScheduleTimer) clearInterval(dotScheduleTimer); if (dotGoalReconcileTimer) clearInterval(dotGoalReconcileTimer);
    if (dotDelegationTimer) clearInterval(dotDelegationTimer); if (dotChannelTimer) clearInterval(dotChannelTimer);
    if (dotProactiveTimer) clearInterval(dotProactiveTimer); });
  return { dotChannelService, dotEvalsRepository };
}
