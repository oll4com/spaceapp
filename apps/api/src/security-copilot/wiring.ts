import type { FastifyInstance } from "fastify";
import { eventSchema, nousSettingsSchema, type Pane, type SecurityEvent } from "@space/contracts";
import { InMemorySecurityCopilotRepository, PostgresSecurityCopilotRepository, type SecurityCopilotRepository } from "@space/db";
import { makeSpaceId, SpaceConflictError, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import { submitCliPrompt } from "../cli-prompt-submit.js";
import type { CliTerminalManager } from "../cli-terminal.js";
import { atEmptyPrompt } from "../room-agent-autopilot.js";
import type { RoomPaneObservation } from "../room-pane-control.js";
import type { NotificationService } from "../notifications/service.js";
import { allowPaneQueueCommand } from "../queue-operator-grants.js";
import { createFeeds, type SecurityFeeds } from "./feeds.js";
import { registerSecurityCopilotRoutes, type SecurityCopilotRouteDependencies } from "./routes.js";
import { createSecurityCopilotService, SECURITY_KICKOFF, type SecurityCopilotService } from "./service.js";

const WATCH_EVERY_MS = 30 * 60_000;
const FIRST_WATCH_MS = 2 * 60_000;

export interface SecurityCopilotWiring extends Omit<SecurityCopilotRouteDependencies, "store"> {
  store: SpaceStore;
  eventBus: SpaceEventBus;
  databaseUrl: string | null | undefined;
  /** Tests pass an in-memory repository and feeds; otherwise Postgres when a database is configured and the public feeds. */
  repository?: SecurityCopilotRepository;
  feeds?: SecurityFeeds;
  terminal: Pick<CliTerminalManager, "runSerializedTerminalMutation" | "sendInput" | "observeRoomScreenUndimmed">;
  notifications: Pick<NotificationService, "raise" | "resolve">;
  /** Instance job security-copilot-watch (stable only; dev on SPACE_INSTANCE_ENABLED_JOBS or the pane's "Check now"). */
  watch: boolean;
  /** Tests replace the CLI kickoff. */
  kickoff?: (pane: Pane) => Promise<void>;
  /** The pane's terminal as the Room Agent reads it: a kickoff is typed only at an empty prompt. */
  inspect?(pane: Pane): Promise<RoomPaneObservation>;
  log: { warn(details: unknown, message: string): void; info?(details: unknown, message: string): void };
}

/**
 * The Security Copilot pane's backend, kept out of the composition root: its repository, the service whose feed reaches the room
 * stream (SECURITY_COPILOT_UPDATED) and the notification system, the operator routes, the kickoff typed into the pane's CLI, and
 * the 30-minute watch pass. Returns the service for the agent bridge and Nous.
 */
export function registerSecurityCopilot(app: FastifyInstance, deps: SecurityCopilotWiring): SecurityCopilotService {
  const { store, eventBus, terminal } = deps;
  const repository = deps.repository ?? (deps.databaseUrl ? PostgresSecurityCopilotRepository.fromConnectionString(deps.databaseUrl) : new InMemorySecurityCopilotRepository());
  app.addHook("onClose", () => repository.dispose());
  const paneRooms = new Map<string, string>();
  const roomOf = async (paneId: string) => {
    const known = paneRooms.get(paneId);
    if (known) return known;
    const roomId = (await Promise.resolve(store.getPane(paneId)).catch(() => null))?.roomId ?? null;
    if (roomId) paneRooms.set(paneId, roomId);
    return roomId;
  };
  const activeSession = async (pane: Pane) => {
    const session = await store.getActivePaneCliSession(pane.id);
    return session && session.purpose === "NORMAL" && session.isActive && session.status !== "EXITED" && session.status !== "ERROR" ? session : null;
  };
  const send = deps.kickoff ?? (async (pane: Pane) => {
    const session = await activeSession(pane);
    if (!session) throw new SpaceConflictError("Open the Security Copilot terminal first: the pane has no running CLI session.");
    const traceId = `security-copilot:${makeSpaceId("kickoff")}`;
    await terminal.runSerializedTerminalMutation(session.sessionId, async () => {
      await submitCliPrompt(terminal, session.sessionId, SECURITY_KICKOFF, traceId, `${traceId}:kickoff`);
    });
  });
  const service = createSecurityCopilotService({
    repository, store, notifications: deps.notifications, feeds: deps.feeds ?? createFeeds(),
    hotfix: { allowed: async (owner) => nousSettingsSchema.parse((await store.getUserSettings(owner)).nous ?? {}).maySecurityHotfix, grant: allowPaneQueueCommand },
    kickoff: { ready: async (pane) => deps.kickoff !== undefined || (Boolean(await activeSession(pane))
      && (!deps.inspect || atEmptyPrompt(await deps.inspect(pane).catch(() => ({ state: "UNKNOWN" }) as unknown as RoomPaneObservation)))), send },
    onEvent: (event: SecurityEvent) => {
      void (async () => {
        const roomId = await roomOf(event.paneId);
        if (!roomId) return;
        eventBus.publish(eventSchema.parse({
          id: makeSpaceId("event"), roomId, paneId: event.paneId, turnId: null, workflowId: null, traceId: `security-copilot:${event.id}`,
          type: "SECURITY_COPILOT_UPDATED", message: event.message.slice(0, 1000), payload: { eventId: event.id, type: event.type, status: event.status }, createdAt: event.updatedAt
        }));
      })().catch((error: unknown) => deps.log.warn({ err: error }, "Security Copilot event listener failed"));
    }
  });
  registerSecurityCopilotRoutes(app, service, deps);
  if (deps.watch) {
    let running = false;
    const pass = () => {
      if (running) return;
      running = true;
      void service.watch().then((result) => deps.log.info?.(result, "Security Copilot watch pass"))
        .catch((error: unknown) => deps.log.warn({ err: error }, "Security Copilot watch pass failed")).finally(() => { running = false; });
    };
    const first = setTimeout(pass, FIRST_WATCH_MS);
    const timer = setInterval(pass, WATCH_EVERY_MS);
    first.unref();
    timer.unref();
    app.addHook("onClose", async () => { clearTimeout(first); clearInterval(timer); });
  }
  return service;
}
