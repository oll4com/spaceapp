import type {} from "./request-context.js";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import type { Pane, PaneCliSession, Room } from "@space/contracts";
import type { ControlRepository } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { CliTerminalManager } from "./cli-terminal.js";
import { CliTerminalControlRequiredError, parseCliHttpControlAuthority } from "./cli-http-control.js";
import { cliLocalComposerSubmissionSchema, createCliLocalComposerService } from "./cli-local-composer.js";
import { sendApiError } from "./http-errors.js";
import { assertCliPaneCompatible, assertNormalCliSession } from "./pane-guards.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";

const receiptParamsSchema = idParamSchema.extend({ submissionId: z.string().uuid() });

export function registerCliLocalComposerRoutes(app: FastifyInstance, deps: {
  store: SpaceStore;
  repository: ControlRepository;
  cliTerminalManager: Pick<CliTerminalManager, "runSerializedTerminalMutation" | "sendInput">;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  assertRoomAccess: (roomId: string, user: FastifyRequest["user"]) => Promise<Room>;
  paneOwner: (paneId: string) => Promise<string | null>;
  assertPaneCliRuntimeEnabled: (pane: Pane) => Promise<void>;
  assertCliHttpMutationControl: (request: FastifyRequest, session: PaneCliSession) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
}) {
  const service = createCliLocalComposerService({ repository: deps.repository,
    serialize: (sessionId, work) => deps.cliTerminalManager.runSerializedTerminalMutation(sessionId, work),
    sendInput: (sessionId, data, traceId, key) => deps.cliTerminalManager.sendInput(sessionId, data, traceId, null, key, data !== "\r"),
    wait: deps.wait });
  const ownedPane = async (request: FastifyRequest, paneId: string) => {
    const pane = await deps.store.getPane(paneId);
    const room = await deps.assertRoomAccess(pane.roomId, request.user);
    const owner = await deps.paneOwner(paneId) ?? room.ownerUserId;
    if (!request.user || owner !== request.user.id) throw new SpaceNotFoundError(`Pane ${paneId} was not found.`);
    return pane;
  };

  app.get("/api/panes/:id/cli/local-composer/submissions/:submissionId", deps.routeOptions, async (request, reply) => {
    const params = parseQuery(receiptParamsSchema, request.params);
    await ownedPane(request, params.id);
    reply.header("cache-control", "no-store");
    return service.get({ ownerUserId: request.user!.id, paneId: params.id }, params.submissionId);
  });

  app.post("/api/panes/:id/cli/local-composer/submissions", { ...deps.routeOptions, bodyLimit: 1024 * 1024 }, async (request, reply) => {
    if (request.user?.proofScope === "READ_ONLY" || request.user?.automationScope === "APP_DIAGNOSTICS")
      return sendApiError(reply, 403, "AUTOMATION_SCOPE_READ_ONLY", "This session cannot send CLI composer drafts.");
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(cliLocalComposerSubmissionSchema, request.body);
    const pane = await ownedPane(request, params.id);
    let generation: string | null | undefined;
    return service.submit({ ownerUserId: request.user!.id, paneId: pane.id, roomId: pane.roomId }, input, {
      traceId: request.requestIdForSpace,
      assertCurrent: async () => {
        const currentPane = await ownedPane(request, pane.id);
        assertCliPaneCompatible(currentPane);
        const active = await deps.store.getActivePaneCliSession(pane.id);
        if (!active || !active.isActive || active.status !== "RUNNING" || active.sessionId !== input.expectedSessionId)
          throw new SpaceConflictError("The CLI session changed before the composer draft could be sent.");
        assertNormalCliSession(active);
        if (active.runtimeId === "cli:root" || currentPane.terminalRuntimeId === "cli:root")
          throw new SpaceConflictError("The local composer is not available for root shells.");
        if (input.imagePaths?.length && !["cli:codex", "cli:claude"].includes(active.runtimeId))
          throw new SpaceConflictError("This CLI does not support native image pastes.");
        const currentGeneration = active.terminalGeometry?.generationId ?? null;
        if (generation !== undefined && currentGeneration !== generation)
          throw new SpaceConflictError("The CLI process changed before the composer draft could be sent.");
        generation = currentGeneration;
        await deps.assertPaneCliRuntimeEnabled(currentPane);
        // Unlike legacy HTTP mutations, this new composer always requires a
        // current terminal controller, including when no lease exists yet.
        if (!parseCliHttpControlAuthority(request) || !await deps.store.getActivePaneCliTerminalControlLease(active.sessionId))
          throw new CliTerminalControlRequiredError();
        await deps.assertCliHttpMutationControl(request, active);
      }
    });
  });
  return service;
}
