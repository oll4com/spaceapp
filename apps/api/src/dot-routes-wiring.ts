import type { FastifyInstance } from "fastify";
import { registerDotChannelsAndProactive } from "./dot-channels-proactive-wiring.js";
import { registerDotServices } from "./dot-services-wiring.js";
import { registerDotToolGatewayWiring } from "./dot-tools-gateway-wiring.js";
import { createStrandedChatRunSweep } from "./stranded-chat-run-sweep.js";

type D<F extends (app: FastifyInstance, deps: never) => unknown> = Parameters<F>[1];
/** What the block makes itself and hands from one registration to the next. */
type Made = "dotScheduleService" | "dotComputerService" | "dotDeliverablesService" | "connectorService" | "dotDelegationService" | "dotChannelService" | "dotEvalsRepository";
type DotRoutesDeps = D<typeof createStrandedChatRunSweep> & Omit<D<typeof registerDotServices>, Made> & Omit<D<typeof registerDotChannelsAndProactive>, Made>
  & Omit<D<typeof registerDotToolGatewayWiring>, Made>;

/** The Dot routes (moved verbatim from app.ts, ARCH-001 step 82): the stranded Chat run sweep, the Dot services, Slack and Teams with Live,
 * evaluations, the computer routes and proactive notices, and the Dot tool gateway, in the order app.ts registered them. Returns the sweep
 * (the start hook runs it) and the Dot evaluations repository (the Space Agent reads it per request). */
export function registerDotRoutes(app: FastifyInstance, deps: DotRoutesDeps) {
  const { config, store, options, auth, eventBus, cookieName, defaultRouteRateLimitOptions, dotsAuthenticatedOwner, dotsRepository, dotGoalsRepository, dotHomeRepository,
    dotGoalService, dotMemoryService, dotAtCapacity, autoRouteFactsLoader, browserSessionManager, browserAccountStore, youtubeAccountOwner, cliRuntimeVisibility,
    connectorCrypto, connectorServiceRef, connectorStateTools, roomPaneCommands, spaceAgentAdapter, spaceControl, controlUser, spaceControlRoutes, vault, designService,
    videoService, executeMcpToolWithPolicy } = deps;
  const { sweepStrandedChatRuns } = createStrandedChatRunSweep(app, { config, store, dotsRepository });
  // The Dot services: schedules, the Dot computer, deliverables, connectors, memory and auto-routing routes, delegations.
  const { dotScheduleService, dotComputerService, dotDeliverablesService, connectorService, dotDelegationService } = registerDotServices(app, { store, config, options,
    auth, eventBus, defaultRouteRateLimitOptions, dotsAuthenticatedOwner, dotsRepository, dotGoalsRepository, dotGoalService, dotMemoryService, dotAtCapacity,
    autoRouteFactsLoader, browserSessionManager, browserAccountStore, youtubeAccountOwner, cliRuntimeVisibility, connectorCrypto, connectorServiceRef,
    connectorStateTools, roomPaneCommands, spaceAgentAdapter });
  // Dots stages 6-8: Slack and Teams, Live and evaluations, the computer routes, proactive notices and the Dot timers.
  const { dotChannelService, dotEvalsRepository } = registerDotChannelsAndProactive(app, { store, config, options, auth, eventBus, defaultRouteRateLimitOptions,
    dotsAuthenticatedOwner, dotsRepository, dotGoalsRepository, dotHomeRepository, dotGoalService, dotDelegationService, dotScheduleService, connectorService,
    dotComputerService, cliRuntimeVisibility, roomPaneCommands, spaceAgentAdapter, spaceControl, controlUser });
  registerDotToolGatewayWiring(app, { store, config, auth, cookieName, defaultRouteRateLimitOptions, dotsRepository, dotHomeRepository, dotEvalsRepository,
    controlUser, spaceControlRoutes, browserSessionManager, vault, spaceAgentAdapter, connectorService, dotChannelService, dotGoalService, dotComputerService,
    dotDelegationService, dotMemoryService, dotDeliverablesService, dotScheduleService, designService, videoService,
    // Declared further down; read only when a Dot runs an MCP tool.
    executeMcpToolWithPolicy: (input, request) => executeMcpToolWithPolicy(input, request) });
  return { sweepStrandedChatRuns, dotEvalsRepository };
}
