import type { FastifyInstance } from "fastify";
import { eventSchema, type AppStudioEvent, type Pane } from "@space/contracts";
import { InMemoryAppStudioRepository, PostgresAppStudioRepository, type AppStudioRepository } from "@space/db";
import { makeSpaceId, SpaceConflictError, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import { submitCliPrompt } from "../cli-prompt-submit.js";
import type { CliTerminalManager } from "../cli-terminal.js";
import { atEmptyPrompt } from "../room-agent-autopilot.js";
import type { RoomPaneObservation } from "../room-pane-control.js";
import type { NotificationService } from "../notifications/service.js";
import { registerAppStudioRoutes, type AppStudioRouteDependencies } from "./routes.js";
import { APP_STUDIO_KICKOFF, createAppStudioService, type AppStudioService } from "./service.js";

export interface AppStudioWiring extends Omit<AppStudioRouteDependencies, "store"> {
  store: SpaceStore;
  eventBus: SpaceEventBus;
  databaseUrl: string | null | undefined;
  /** Tests pass an in-memory repository; otherwise Postgres when a database is configured. */
  repository?: AppStudioRepository;
  terminal: Pick<CliTerminalManager, "runSerializedTerminalMutation" | "sendInput" | "observeRoomScreenUndimmed">;
  notifications: Pick<NotificationService, "raise" | "resolve">;
  artifactRoot: string;
  /** Tests replace the CLI kickoff. */
  kickoff?: (pane: Pane) => Promise<void>;
  /** The pane's terminal as the Room Agent reads it: a kickoff is typed only at an empty prompt. */
  inspect?(pane: Pane): Promise<RoomPaneObservation>;
  log: { warn(details: unknown, message: string): void };
}

/**
 * The App Studio pane's backend, kept out of the composition root: its repository, the service whose feed reaches the room stream
 * (APP_STUDIO_UPDATED) and the notification system, the operator routes and the kickoff typed into the pane's CLI when a brief
 * arrives. Returns the service for the agent bridge and Nous.
 */
export function registerAppStudio(app: FastifyInstance, deps: AppStudioWiring): AppStudioService {
  const { store, eventBus, terminal } = deps;
  const repository = deps.repository ?? (deps.databaseUrl ? PostgresAppStudioRepository.fromConnectionString(deps.databaseUrl) : new InMemoryAppStudioRepository());
  app.addHook("onClose", () => repository.dispose());
  const paneRooms = new Map<string, string>();
  const roomOf = async (paneId: string) => {
    const known = paneRooms.get(paneId);
    if (known) return known;
    const roomId = (await Promise.resolve(store.getPane(paneId)).catch(() => null))?.roomId ?? null;
    if (roomId) paneRooms.set(paneId, roomId);
    return roomId;
  };
  // The kickoff goes through the pane CLI input path Room Agent uses (typed line + Enter).
  const activeSession = async (pane: Pane) => {
    const session = await store.getActivePaneCliSession(pane.id);
    return session && session.purpose === "NORMAL" && session.isActive && session.status !== "EXITED" && session.status !== "ERROR" ? session : null;
  };
  const send = deps.kickoff ?? (async (pane: Pane) => {
    const session = await activeSession(pane);
    if (!session) throw new SpaceConflictError("Open the App Studio terminal first: the pane has no running CLI session.");
    const traceId = `app-studio:${makeSpaceId("kickoff")}`;
    await terminal.runSerializedTerminalMutation(session.sessionId, async () => {
      await submitCliPrompt(terminal, session.sessionId, APP_STUDIO_KICKOFF, traceId, `${traceId}:kickoff`);
    });
  });
  const service = createAppStudioService({
    repository, store, artifactRoot: deps.artifactRoot, notifications: deps.notifications,
    kickoff: { ready: async (pane) => deps.kickoff !== undefined || (Boolean(await activeSession(pane))
      && (!deps.inspect || atEmptyPrompt(await deps.inspect(pane).catch(() => ({ state: "UNKNOWN" }) as unknown as RoomPaneObservation)))), send },
    onArtifact: (event) => eventBus.publish(event),
    onEvent: (event: AppStudioEvent) => {
      void (async () => {
        const roomId = await roomOf(event.paneId);
        if (!roomId) return;
        eventBus.publish(eventSchema.parse({
          id: makeSpaceId("event"), roomId, paneId: event.paneId, turnId: null, workflowId: null, traceId: `app-studio:${event.id}`,
          type: "APP_STUDIO_UPDATED", message: event.message, payload: { eventId: event.id, type: event.type, status: event.status }, createdAt: event.updatedAt
        }));
      })().catch((error: unknown) => deps.log.warn({ err: error }, "App Studio event listener failed"));
    }
  });
  registerAppStudioRoutes(app, service, deps);
  const queuePass = setInterval(() => void service.dispatchPending().catch((error: unknown) => deps.log.warn({ err: error }, "App Studio queue pass failed")), 60_000);
  queuePass.unref();
  app.addHook("onClose", async () => clearInterval(queuePass));
  return service;
}
