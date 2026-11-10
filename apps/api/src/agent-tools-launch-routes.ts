import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { agentToolLaunchTaskInputSchema, agentToolLaunchTaskResponseSchema, type Pane } from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import { discoverAgentRuntimes, findRuntime } from "./cli-runtimes.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import { sendApiError } from "./http-errors.js";
import { buildPaneCliSessionResponse } from "./pane-cli-session-response.js";
import { getPaneById } from "./pane-guards.js";
import { parseBody } from "./route-parsing.js";

/** ADMIN launch of an Agent Tools task: types the task into a new or reused TERMINAL pane's CLI. */
export function registerAgentToolsLaunchRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  cliTerminalManager: CliTerminalManager;
  routeOptions: RouteShorthandOptions;
}) {
  const { config, store, cliRuntimeVisibility, cliTerminalManager, routeOptions: defaultRouteRateLimitOptions } = options;
  app.post("/api/agent-tools/launch", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "Launching agent tool tasks requires the ADMIN role.");
    }
    const input = parseBody(agentToolLaunchTaskInputSchema, request.body ?? {});
    const registry = await discoverAgentRuntimes(config);
    const runtime = findRuntime(registry, input.runtimeId);
    if (!runtime) {
      throw new SpaceNotFoundError(`CLI runtime ${input.runtimeId} was not found.`);
    }
    if (!runtime.capabilities.includes("CLI")) {
      throw new SpaceConflictError(`Runtime ${runtime.id} does not support CLI sessions.`);
    }
    await cliRuntimeVisibility.assertEnabled(input.runtimeId);
    let pane: Pane;
    let reusedPane: boolean;
    if (input.paneId) {
      pane = await getPaneById(store, input.paneId);
      if (pane.roomId !== input.roomId) {
        throw new SpaceConflictError("The pane does not belong to the requested room.");
      }
      if (pane.mode !== "TERMINAL") {
        throw new SpaceConflictError("Agent tool tasks require a TERMINAL pane.");
      }
      reusedPane = true;
    } else {
      pane = await store.createPane({
        roomId: input.roomId,
        title: "Agent Tools task",
        mode: "TERMINAL",
        terminalRuntimeId: input.runtimeId
      }, request.requestIdForSpace);
      reusedPane = false;
    }
    const session = await cliTerminalManager.ensurePaneControlReady(pane, request.requestIdForSpace);
    await cliTerminalManager.sendInput(
      session.sessionId,
      input.taskText,
      request.requestIdForSpace,
      null,
      `agent-tools-launch:${pane.id}:${input.taskText.slice(0, 40)}`
    );
    const response = await buildPaneCliSessionResponse({
      store,
      runtime,
      sessionId: session.sessionId,
      includeWebsocket: true,
      includeTranscript: false,
      tokenTtlMs: config.cliTokenTtlMs,
      issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
    });
    return agentToolLaunchTaskResponseSchema.parse({
      pane,
      session: response,
      loaded: true,
      reusedPane
    });
  });
}
