import { type PostgresDotsRepository, PostgresDotGoalsRepository } from "@space/db";
import { type SpaceStore, SpaceConflictError, makeSpaceId } from "@space/runtime";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import { type AuthConfig, cookieName, verifySession } from "./auth.js";
import type { SpaceApiConfig } from "./config.js";
import { type DotGoalWorkflowCoordinator, createDotGoalService, createDotGoalWorkflowCoordinator, registerDotGoalRoutes } from "./dot-goals.js";
import { getPaneById } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import { GitControlError } from "./source-control/errors.js";
import type { SpaceAgentAdapter } from "./space-agent.js";
import { registerSpaceControlRoutes } from "./space-control-routes.js";

type ControlRoutesOptions = NonNullable<Parameters<typeof registerSpaceControlRoutes>[2]>;
type SpaceControlDotGoalRoutesDeps = {
  config: SpaceApiConfig; store: SpaceStore; auth: Pick<AuthConfig, "sessionSecret">; options: { dotGoalWorkflow?: DotGoalWorkflowCoordinator | null };
  spaceControl: Parameters<typeof registerSpaceControlRoutes>[1]; controlCliRooms: Pick<WeakMap<FastifyRequest, string>, "get">;
  controlUser: NonNullable<ControlRoutesOptions["resolveActor"]>; dotsRepository: PostgresDotsRepository | null;
  spaceAgentAdapter: Pick<SpaceAgentAdapter, "sendMessage" | "interrupt">; defaultRouteRateLimitOptions: RouteShorthandOptions;
};

/** The Space Control routes and the Dot Goals (moved verbatim from app.ts, ARCH-001 step 80): the Space Control HTTP routes, the Dot Goals
 * repository and its close, the Dot concurrent-task check, the Dot Goal service and the Dot Goal routes, in the order app.ts registered them.
 * Returns the Space Control routes (earlier request-time closures call them) and the Goal repository, service and capacity check later Dot
 * services read. */
export function registerSpaceControlAndDotGoalRoutes(app: FastifyInstance, deps: SpaceControlDotGoalRoutesDeps) {
  const { config, store, auth, options, spaceControl, controlCliRooms, controlUser, dotsRepository, spaceAgentAdapter, defaultRouteRateLimitOptions } = deps;
  const spaceControlRoutes = registerSpaceControlRoutes(app,spaceControl,{cliRoom:request=>controlCliRooms.get(request)??null,resolveActor:controlUser});
  const dotGoalsRepository = dotsRepository && config.databaseUrl ? PostgresDotGoalsRepository.fromConnectionString(config.databaseUrl) : null;
  if (dotGoalsRepository) app.addHook("onClose", () => dotGoalsRepository.dispose());
  /** Autonomous work (Goal steps, schedules) respects each Dot's concurrent-task limit; the user's own sends never do. */
  async function dotAtCapacity(input: { sessionId: string; dotId: string; roomId: string }): Promise<boolean> {
    if (!dotsRepository) return false;
    const owner = (await store.getRoom(input.roomId)).ownerUserId;
    const dot = owner ? await dotsRepository.get(owner, input.dotId) : null;
    if (!dot) return false;
    return await dotsRepository.countActiveDotRuns(input.dotId, input.sessionId) >= dot.workLimits.maxConcurrentTasks;
  }
  const dotGoalService = dotsRepository && dotGoalsRepository ? createDotGoalService({
    store, dots: dotsRepository, goals: dotGoalsRepository,
    workflow: options.dotGoalWorkflow ?? createDotGoalWorkflowCoordinator({ enabled: config.enableCodexTurns, address: config.temporalAddress,
      namespace: config.temporalNamespace, taskQueue: config.temporalTaskQueue }),
    sendStep: async ({ paneId, sessionId, ownerUserId, content, requestKey }) => {
      const pane = await getPaneById(store, paneId);
      const result = await spaceAgentAdapter.sendMessage({ pane, sessionId, content, operatorUserId: ownerUserId, clientRequestId: requestKey,
        traceId: makeSpaceId("trace") });
      if (!result.submission) throw new SpaceConflictError(result.session.statusReason ?? "The Goal step could not start.");
      return { runId: result.submission.runId };
    },
    interrupt: async (paneId, reason) => { await spaceAgentAdapter.interrupt({ pane: await getPaneById(store, paneId), reason }); },
    submission: async (paneId, requestKey) => {
      const run = await store.getSpaceAgentSubmission(paneId, requestKey);
      return run ? { runId: run.runId, status: run.status } : null;
    },
    atCapacity: dotAtCapacity,
    supportsGoalTools: (session) => config.dotToolGatewayEnabled && (!session.selectedProviderId || session.selectedProviderId === "codex")
      && session.permissionMode !== "ask_for_approval",
    audit: (request, action, roomId, metadata) => request ? recordAudit(store, request, { action, targetType: "room", targetId: roomId, metadata }) : Promise.resolve()
  }) : null;
  registerDotGoalRoutes(app, dotGoalService, dotGoalsRepository ? { goals: dotGoalsRepository } : null, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: async request => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    }
  });
  return { spaceControlRoutes, dotGoalsRepository, dotAtCapacity, dotGoalService };
}
