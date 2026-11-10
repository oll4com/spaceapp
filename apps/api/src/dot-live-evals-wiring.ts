import { createHash, randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresDotEvalsRepository, type ChannelsRepository, type DotEvalsRepository, type PostgresDotGoalsRepository, type PostgresDotsRepository } from "@space/db";
import { SpaceConflictError, makeSpaceId, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { SpaceApiConfig } from "./config.js";
import type { createDotChannelService } from "./dot-channels.js";
import type { createConnectorService } from "./dot-connectors.js";
import type { createDotDelegationService } from "./dot-delegations.js";
import { createDotEvalService, registerDotEvalRoutes } from "./dot-evals.js";
import type { createDotGoalService } from "./dot-goals.js";
import { createDotLiveService, registerDotLiveRoutes } from "./dot-live.js";
import type { createDotScheduleService } from "./dot-schedules.js";
import type { createRoomPaneCommands } from "./room-pane-commands.js";
import type { SpaceAgentAdapter } from "./space-agent.js";
import type { createSpaceControl } from "./space-control.js";
import type { ControlActor } from "./space-control-settings.js";
import { buildGenericUserUploadStorage } from "./upload-media.js";

type DotLiveEvalsWiringDeps = {
  store: SpaceStore;
  config: Pick<SpaceApiConfig, "databaseUrl" | "browserEvidenceArtifactRoot">;
  options: { dotEvalsRepository?: DotEvalsRepository };
  eventBus: Pick<SpaceEventBus, "publish">;
  defaultRouteRateLimitOptions: RouteShorthandOptions;
  dotsAuthenticatedOwner: (request: FastifyRequest) => Promise<string>;
  dotsRepository: PostgresDotsRepository | null;
  dotGoalsRepository: PostgresDotGoalsRepository | null;
  channelsRepository: ChannelsRepository | null;
  dotGoalService: ReturnType<typeof createDotGoalService> | null;
  dotDelegationService: ReturnType<typeof createDotDelegationService> | null;
  dotScheduleService: ReturnType<typeof createDotScheduleService> | null;
  connectorService: ReturnType<typeof createConnectorService> | null;
  dotChannelService: ReturnType<typeof createDotChannelService> | null;
  cliRuntimeVisibility: Pick<CliRuntimeVisibilityPolicy, "assertEnabled">;
  roomPaneCommands: Pick<ReturnType<typeof createRoomPaneCommands>, "resolve">;
  spaceAgentAdapter: Pick<SpaceAgentAdapter, "createOrRestoreSession" | "sendMessage" | "updateSettings" | "interrupt">;
  spaceControl: Pick<ReturnType<typeof createSpaceControl>, "watches">;
  controlUser: (id: string) => Promise<ControlActor>;
};

/**
 * Dot Live (stage 6: Live hands work to a Dot, answers or steers its Goal, asks how it goes) and Dot evaluations (stage 7: frozen
 * datasets run on the real runtime for an ADMIN's Dot, cases a stopped process left open closed on start), with their routes.
 * Returns the evaluations repository, which the Dot runtime choice and the tool gateway read.
 */
export function registerDotLiveAndEvals(app: FastifyInstance, deps: DotLiveEvalsWiringDeps) {
  const { store, config, options, eventBus, defaultRouteRateLimitOptions, dotsAuthenticatedOwner, dotsRepository, dotGoalsRepository, channelsRepository,
    dotGoalService, dotDelegationService, dotScheduleService, connectorService, dotChannelService, cliRuntimeVisibility, roomPaneCommands,
    spaceAgentAdapter, spaceControl, controlUser } = deps;
  // Stage 6: Live hands work to a Dot, answers or steers its Goal, and asks how it is going, in that Dot's own conversation.
  const dotLiveService = dotsRepository && dotGoalsRepository && dotGoalService ? createDotLiveService({
    store, dots: dotsRepository,
    openPane: async ({ roomId, title }) => {
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const [input] = await roomPaneCommands.resolve(roomId, [{ mode: "CHAT" }]);
      const [pane] = await store.createPanes([{ ...input!, title }], makeSpaceId("trace"));
      for (const event of (await store.listEvents(roomId)).filter((event) => event.type === "PANE_CREATED" && event.paneId === pane!.id)) eventBus.publish(event);
      return pane!;
    },
    startSession: async ({ pane, owner, dotId }) => {
      const session = await spaceAgentAdapter.createOrRestoreSession({ pane, dotId, ownerUserId: owner });
      if (!session.binding.sessionId || session.dotId !== dotId) throw new SpaceConflictError("The Dot's conversation could not start.");
      return { sessionId: session.binding.sessionId };
    },
    send: async ({ pane, sessionId, owner, content, requestKey }) => {
      await spaceAgentAdapter.sendMessage({ pane, sessionId, content, operatorUserId: owner, clientRequestId: requestKey, traceId: makeSpaceId("trace") });
    },
    openGoal: async (sessionId) => {
      const goal = await dotGoalsRepository.openForSession(sessionId);
      return goal ? { goalId: goal.goalId, status: goal.status, objective: goal.objective, statusReason: goal.statusReason ?? null,
        steps: goal.usage.steps, maxSteps: goal.budget.maxSteps } : null;
    },
    steerGoal: async (owner, dotId, goalId, text, resume) => {
      await dotGoalService.steer(owner, dotId, goalId, { text: text.slice(0, 4000) }, null);
      if (resume) await dotGoalService.control(owner, dotId, goalId, { action: "RESUME" }, null);
    },
    pendingApprovals: async (owner, dotId, sessionId) => ((await dotsRepository.listPendingApprovals(owner, dotId, sessionId)) ?? [])
      .map((item) => ({ summary: item.approvalSummary ?? item.toolId })),
    watch: async (owner, roomId, paneId) => ((await spaceControl.watches(await controlUser(owner), roomId, "register", { paneId })) as { id?: string })?.id ?? null,
    isChannelSession: channelsRepository ? async (sessionId) => Boolean(await channelsRepository.threadForSession(sessionId, "SLACK")
      ?? await channelsRepository.threadForSession(sessionId, "TEAMS")) : undefined
  }) : null;
  registerDotLiveRoutes(app, dotLiveService, { routeOptions: defaultRouteRateLimitOptions, authenticatedOwner: dotsAuthenticatedOwner });
  // Stage 7: frozen evaluation datasets run on the real runtime, started explicitly by an ADMIN for one of their Dots.
  const dotEvalRunnerId = `api:${randomBytes(12).toString("hex")}`;
  const dotEvalsRepository = options.dotEvalsRepository
    ?? (dotsRepository && dotGoalsRepository && config.databaseUrl ? PostgresDotEvalsRepository.fromConnectionString(config.databaseUrl) : null);
  if (dotEvalsRepository && !options.dotEvalsRepository) {
    app.addHook("onClose", () => dotEvalsRepository.dispose());
    // Cases left open by a stopped API process are closed, never resumed silently, and their Goals are cancelled.
    app.addHook("onReady", async () => {
      const abandoned = await dotEvalsRepository.abandon(dotEvalRunnerId, "The server restarted during the evaluation.").catch(() => []);
      for (const item of abandoned) {
        if (item.goalId && dotGoalService) await dotGoalService.control(item.ownerUserId, item.dotId, item.goalId, { action: "CANCEL" }, null).catch(() => undefined);
      }
    });
  }
  const evalMimeTypes: Record<string, string> = { csv: "text/csv", md: "text/markdown", pdf: "application/pdf", png: "image/png",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  const dotEvalService = dotEvalsRepository && dotsRepository && dotGoalsRepository && dotGoalService && dotDelegationService ? createDotEvalService({
    datasetsRoot: process.env.SPACE_EVALS_ROOT || fileURLToPath(new URL("../../../evals/", import.meta.url)),
    evals: dotEvalsRepository,
    available: async (owner) => {
      const accounts = connectorService ? (await connectorService.status(owner).catch(() => null))?.accounts ?? [] : [];
      const capabilities = new Set(accounts.flatMap((account) => account.capabilities));
      const channels = dotChannelService ? await dotChannelService.available(owner).catch(() => []) : [];
      return new Set([...(capabilities.has("MAIL_READ") ? ["connector:mail-read"] : []), ...(capabilities.has("MAIL_COMPOSE") ? ["connector:mail-compose"] : []),
        ...(capabilities.has("CALENDAR") ? ["connector:calendar"] : []), ...channels]);
    },
    openPane: async ({ roomId, title }) => {
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const [input] = await roomPaneCommands.resolve(roomId, [{ mode: "CHAT" }]);
      const [pane] = await store.createPanes([{ ...input!, title }], makeSpaceId("trace"));
      for (const event of (await store.listEvents(roomId)).filter((event) => event.type === "PANE_CREATED" && event.paneId === pane!.id)) eventBus.publish(event);
      return pane!;
    },
    startSession: async ({ pane, owner, dotId, modelConfigId }) => {
      // A new conversation per case. Space tool writes wait for approval through the gateway while the case runs;
      // the runtime itself works in the sandboxed workspace mode when the installation allows it.
      const session = await spaceAgentAdapter.createOrRestoreSession({ pane, dotId, ownerUserId: owner, sessionId: null,
        ...(modelConfigId ? { selectedModelConfigId: modelConfigId } : {}) });
      if (!session.binding.sessionId || session.dotId !== dotId) throw new SpaceConflictError("The evaluation conversation could not start.");
      await spaceAgentAdapter.updateSettings({ pane, permissionMode: "approve_for_me" }).catch(() => undefined);
      return { sessionId: session.binding.sessionId };
    },
    uploadFixture: async ({ roomId, owner, name, data }) => {
      const mimeType = evalMimeTypes[name.split(".").pop() ?? ""] ?? "application/octet-stream";
      const storage = buildGenericUserUploadStorage({ artifactRoot: config.browserEvidenceArtifactRoot, roomId, originalFilename: name });
      await mkdir(dirname(storage.filePath), { recursive: true });
      await writeFile(storage.filePath, data, { flag: "wx" });
      try {
        const result = await store.createArtifact({ roomId, paneId: null, kind: mimeType.startsWith("image/") ? "IMAGE" : "EXPORT", mimeType,
          storageUri: storage.storageUri, sha256: createHash("sha256").update(data).digest("hex"), byteSize: data.length,
          metadata: { source: "USER_UPLOAD", originalFilename: name, storedFilename: storage.storedFilename, uploadedBy: owner, evaluation: true } }, makeSpaceId("trace"));
        eventBus.publish(result.event);
        return result.artifact.id;
      } catch (error) { await unlink(storage.filePath).catch(() => undefined); throw error; }
    },
    send: async ({ pane, sessionId, owner, content, artifactIds, requestKey }) => {
      await spaceAgentAdapter.sendMessage({ pane, sessionId, content, artifactIds, operatorUserId: owner, clientRequestId: requestKey, traceId: makeSpaceId("trace") });
    },
    createGoal: (owner, dotId, input) => dotGoalService.create(owner, dotId, input, null),
    goalStatus: async (goalId) => (await dotGoalsRepository.get(goalId))?.status ?? null,
    cancelGoal: async (owner, dotId, goalId) => { await dotGoalService.control(owner, dotId, goalId, { action: "CANCEL" }, null); },
    latestRunStatus: async (sessionId) => (await store.getLatestSpaceAgentRun(sessionId))?.status ?? null,
    interrupt: async (pane) => { await spaceAgentAdapter.interrupt({ pane }); },
    runnerId: dotEvalRunnerId,
    declinePending: async (owner, dotId, sessionId) => {
      for (const pending of (await dotsRepository.listPendingApprovals(owner, dotId, sessionId)) ?? []) {
        const decided = await dotsRepository.decideToolApproval(owner, dotId, pending.invocationId, "DECLINE", owner);
        const payload = decided?.payload as { kind?: string; scheduleId?: string } | undefined;
        if (payload?.kind === "schedule" && payload.scheduleId && dotScheduleService) {
          await dotScheduleService.control(owner, dotId, payload.scheduleId, { action: "CANCEL" }).catch(() => undefined);
        }
      }
    },
    log: (message, error) => app.log.warn({ err: error }, message)
  }) : null;
  registerDotEvalRoutes(app, dotEvalService, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: dotsAuthenticatedOwner,
    ownsDot: async (owner, dotId) => Boolean(dotsRepository && await dotsRepository.get(owner, dotId)),
    ownsRoom: async (owner, roomId) => (await Promise.resolve(store.getRoom(roomId)).catch(() => null))?.ownerUserId === owner
  });
  return { dotEvalsRepository };
}
