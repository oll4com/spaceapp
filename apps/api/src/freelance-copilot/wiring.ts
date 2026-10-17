import type { FastifyInstance } from "fastify";
import { eventSchema, type FreelanceEvent, type FreelanceRun, type Pane } from "@space/contracts";
import { InMemoryFreelanceCopilotRepository, PostgresFreelanceCopilotRepository, type FreelanceCopilotRepository } from "@space/db";
import { makeSpaceId, SpaceConflictError, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import type { CliTerminalManager } from "../cli-terminal.js";
import type { ConnectorCrypto } from "../dot-connectors.js";
import type { MailboxFactory } from "../job-apply/mailbox.js";
import type { NotificationService } from "../notifications/service.js";
import { registerFreelanceCopilotRoutes, type FreelanceCopilotRouteDependencies } from "./routes.js";
import { createFreelanceCopilotScheduler } from "./scheduler.js";
import { createFreelanceCopilotService, type FreelanceCopilotService } from "./service.js";

export interface FreelanceCopilotWiring extends Omit<FreelanceCopilotRouteDependencies, "store" | "kickoff"> {
  store: SpaceStore;
  eventBus: SpaceEventBus;
  databaseUrl: string | null | undefined;
  crypto: ConnectorCrypto;
  mailboxes: MailboxFactory;
  /** Tests pass an in-memory repository; otherwise Postgres when a database is configured. */
  repository?: FreelanceCopilotRepository;
  /** Tests replace the CLI kickoff of a run. */
  kickoff?: (pane: Pane, run: FreelanceRun) => Promise<void>;
  terminal: Pick<CliTerminalManager, "runSerializedTerminalMutation" | "sendInput" | "ensurePaneControlReady">;
  notifications: Pick<NotificationService, "raise" | "resolve">;
  roomOwner(roomId: string): Promise<string | null>;
  /** The instance job `freelance-copilot-scheduler` (stable; dev opts in). */
  scheduler: boolean;
  log: { warn(details: unknown, message: string): void };
}

const KICKOFF = (runId: string) => `Freelance Copilot run ${runId} started in this pane. Read the space-freelance-copilot skill (SKILL.md and its references), then loop: call space_freelancecopilot space_freelance_next until it returns done=true (without MCP tools in this session, call them on demand: JSON {"serverId","toolName","arguments"} on stdin to space-capability call); recall memory before writing, ground every claim in PROFILE, CASE_STUDY and FACT memories, send only after space_freelance_send_begin succeeds, report the sent URL with space_freelance_send_done, and call space_freelance_client_ready as soon as a client wants to go ahead.`;

/** Which notification an event raises or resolves: the key pairs a request with the decision that ends it. */
export function freelanceNotificationFor(event: FreelanceEvent): { action: "raise" | "resolve" | "clientReady"; key: string } | null {
  switch (event.type) {
    case "CLIENT_READY": return { action: "clientReady", key: `client-ready:${event.leadId}` };
    case "LEAD_DECIDED": return { action: "resolve", key: `client-ready:${event.leadId}` };
    case "REVIEW_REQUESTED": return { action: "raise", key: `review:${event.messageId}` };
    case "REVIEW_DECIDED": return { action: "resolve", key: `review:${event.messageId}` };
    case "QUESTION": return { action: "raise", key: `question:${String(event.payload.questionId)}` };
    case "ANSWERED": return { action: "resolve", key: `question:${String(event.payload.questionId)}` };
    case "RULE_PROPOSED": return { action: "raise", key: `rule:${String(event.payload.ruleId)}` };
    case "RULE_DECIDED": return { action: "resolve", key: `rule:${String(event.payload.ruleId)}` };
    case "SEND_FAILED": return { action: "raise", key: `failed:${event.messageId}` };
    case "SENDING": return { action: "resolve", key: `failed:${event.messageId}` };
    case "NEEDS_USER": return { action: "raise", key: `event:${event.id}` };
    default: return null;
  }
}

/**
 * The Freelance Copilot pane's backend, kept out of the composition root: its repository, the service whose events
 * reach the room stream and (when a client is ready or the copilot needs the operator) the notification system, the
 * operator routes, the run kickoff typed into the pane's CLI and the scheduler. Returns the service for the bridge.
 */
export function registerFreelanceCopilot(app: FastifyInstance, deps: FreelanceCopilotWiring): FreelanceCopilotService {
  const { store, eventBus, terminal, notifications } = deps;
  const repository = deps.repository ?? (deps.databaseUrl ? PostgresFreelanceCopilotRepository.fromConnectionString(deps.databaseUrl) : new InMemoryFreelanceCopilotRepository());
  app.addHook("onClose", () => repository.dispose());
  const paneOf = (paneId: string) => Promise.resolve(store.getPane(paneId)).catch(() => null);

  async function notify(event: FreelanceEvent): Promise<void> {
    const plan = freelanceNotificationFor(event);
    const pane = plan && event.paneId ? await paneOf(event.paneId) : null;
    if (!plan || !pane || pane.mode !== "FREELANCE_COPILOT") return;
    const owner = await deps.roomOwner(pane.roomId);
    if (!owner) return;
    const dedupeKey = `freelance-copilot:${plan.key}`;
    if (plan.action === "resolve") { await notifications.resolve(owner, dedupeKey); return; }
    const settings = service.settingsOf(pane).notifications;
    const clientReady = plan.action === "clientReady";
    if (clientReady ? !settings.clientReady : !settings.needsYou) return;
    await notifications.raise({ ownerUserId: owner, roomId: pane.roomId, paneId: pane.id, source: "FREELANCE_COPILOT", kind: event.type, severity: "ATTENTION",
      title: clientReady ? `A client wants to go ahead (${pane.title})` : `Freelance Copilot needs you (${pane.title})`, body: event.message.slice(0, 2000),
      link: { roomId: pane.roomId, paneId: pane.id, target: event.leadId ? `lead:${event.leadId}` : `event:${event.id}` }, dedupeKey, payload: { eventId: event.id },
      telegram: settings.telegram ? true : null });
  }

  const paneRooms = new Map<string, string>();
  const service = createFreelanceCopilotService({
    repository, crypto: deps.crypto, mailboxes: deps.mailboxes,
    onEvent: (event) => {
      void (async () => {
        if (!event.paneId) return;
        let roomId = paneRooms.get(event.paneId) ?? null;
        if (!roomId) {
          roomId = (await paneOf(event.paneId))?.roomId ?? null;
          if (roomId) paneRooms.set(event.paneId, roomId);
        }
        if (!roomId) return;
        eventBus.publish(eventSchema.parse({
          id: makeSpaceId("event"), roomId, paneId: event.paneId, turnId: null, workflowId: null, traceId: `freelance-copilot:${event.id}`,
          type: "FREELANCE_COPILOT_UPDATED", message: event.message, payload: { eventId: event.id, type: event.type, leadId: event.leadId, messageId: event.messageId }, createdAt: event.createdAt
        }));
        await notify(event);
      })().catch((error: unknown) => deps.log.warn({ err: error }, "Freelance Copilot event listener failed"));
    }
  });
  // The run's kickoff goes through the pane CLI input path Room Agent uses (typed line + Enter).
  const activeSession = async (pane: Pane) => {
    const session = await store.getActivePaneCliSession(pane.id);
    return session && session.purpose === "NORMAL" && session.isActive && session.status !== "EXITED" && session.status !== "ERROR" ? session : null;
  };
  // The copilot works without anyone watching: the kickoff starts the pane's CLI when it is not running (the Room
  // Agent's headless start) and types the prompt once the CLI's composer is ready.
  const kickoff = deps.kickoff ?? (async (pane: Pane, run: FreelanceRun) => {
    const traceId = `freelance-copilot:${run.id}`;
    const session = await activeSession(pane) ?? await terminal.ensurePaneControlReady(pane, traceId);
    if (!session) throw new SpaceConflictError("The copilot's CLI could not start.");
    await terminal.runSerializedTerminalMutation(session.sessionId, async () => {
      await terminal.sendInput(session.sessionId, KICKOFF(run.id), traceId, null, `${traceId}:kickoff`, true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await terminal.sendInput(session.sessionId, "\r", traceId, null, `${traceId}:kickoff-submit`);
    });
  });
  registerFreelanceCopilotRoutes(app, service, { ...deps, kickoff });

  if (deps.scheduler) {
    const scheduler = createFreelanceCopilotScheduler({
      service, store, log: deps.log,
      // A pane with a CLI runtime always has an agent: the kickoff starts its CLI when needed.
      hasAgent: async (pane) => deps.kickoff !== undefined || Boolean(pane.terminalRuntimeId) || Boolean(await activeSession(pane)),
      hasActiveRun: async (pane) => Boolean(await service.activeRun(pane.id)),
      startRun: async (owner, pane) => {
        const started = await service.startRun(owner, pane.id);
        if (!started.kickoff) return;
        await kickoff(pane, started.run);
        await service.markKickoff(owner, started.run.id);
      },
      notifyBacklog: async (owner, room, pane, backlog) => {
        await notifications.raise({ ownerUserId: owner, roomId: room.id, paneId: pane.id, source: "FREELANCE_COPILOT", kind: "WORK_WAITING", severity: "ATTENTION",
          title: `${backlog} Freelance Copilot item${backlog === 1 ? " is" : "s are"} waiting (${pane.title})`,
          body: "Open the Freelance Copilot's terminal so it can answer clients, send approved messages and follow up.",
          link: { roomId: room.id, paneId: pane.id }, dedupeKey: `freelance-copilot:waiting:${pane.id}`, payload: { backlog }, telegram: null });
      }
    });
    scheduler.start();
    app.addHook("onClose", async () => scheduler.stop());
  }
  return service;
}
