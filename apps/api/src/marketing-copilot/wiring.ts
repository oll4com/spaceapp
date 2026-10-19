import type { FastifyInstance } from "fastify";
import { eventSchema, MARKETING_CHANNEL_LABELS, type MarketingEvent, type MarketingRun, type Pane } from "@space/contracts";
import { InMemoryMarketingCopilotRepository, PostgresMarketingCopilotRepository, type MarketingCopilotRepository } from "@space/db";
import { makeSpaceId, SpaceConflictError, SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import { localArtifactFilePath } from "../artifact-storage.js";
import type { CliTerminalManager } from "../cli-terminal.js";
import type { PaneBrowserAccountControl } from "../pane-browser-routes.js";
import { GitControlError } from "../source-control/errors.js";
import type { NotificationService } from "../notifications/service.js";
import { apiPackageVersion } from "../package-version.js";
import { registerMarketingCopilotRoutes, type MarketingCopilotRouteDependencies } from "./routes.js";
import { createMarketingCopilotMetrics } from "./metrics.js";
import { createMarketingCopilotScheduler } from "./scheduler.js";
import { createMarketingCopilotService, type MarketingCopilotService } from "./service.js";

export interface MarketingCopilotWiring extends Omit<MarketingCopilotRouteDependencies, "store" | "kickoff"> {
  store: SpaceStore;
  eventBus: SpaceEventBus;
  databaseUrl: string | null | undefined;
  /** Tests pass an in-memory repository; otherwise Postgres when a database is configured. */
  repository?: MarketingCopilotRepository;
  /** Tests replace the CLI kickoff of a run. */
  kickoff?: (pane: Pane, run: MarketingRun) => Promise<void>;
  terminal: Pick<CliTerminalManager, "runSerializedTerminalMutation" | "sendInput">;
  notifications: Pick<NotificationService, "raise" | "resolve">;
  roomOwner(roomId: string): Promise<string | null>;
  /** Where room artifacts live (config.browserEvidenceArtifactRoot): captured post media are read from there. */
  artifactRoot: string;
  /** The browser routes' account control (set once they register): bookmarks open through its openTab. */
  paneBrowserAccounts: { current: PaneBrowserAccountControl | null };
  /** The instance jobs `marketing-copilot-scheduler` and `marketing-copilot-metrics` (stable; dev opts in). */
  scheduler: boolean;
  metrics: boolean;
  log: { warn(details: unknown, message: string): void };
}

const KICKOFF = (runId: string) => `Marketing Copilot run ${runId} started in this pane. Read the space-marketing-copilot skill (SKILL.md and references/channels.md), then loop: call space_marketingcopilot space_marketing_next until it returns done=true (without MCP tools in this session, call them on demand: JSON {"serverId","toolName","arguments"} on stdin to space-capability call); ground every claim in space_marketing_facts, recall memory before drafting, ask for a review under Assist and on capped channels, publish only after space_marketing_publish_begin succeeds, and report the published URL with space_marketing_publish_done. For a post's graphic ask the Design pane with space_design space_design_request (callback {kind:"MARKETING_POST", postId}): the delivery attaches it to the post.`;

/** Which notification an event raises or resolves: the key pairs a request with the decision that ends it. */
export function marketingNotificationFor(event: MarketingEvent): { action: "raise" | "resolve" | "published"; key: string } | null {
  switch (event.type) {
    case "REVIEW_REQUESTED": return { action: "raise", key: `review:${event.postId}` };
    case "REVIEW_DECIDED": return { action: "resolve", key: `review:${event.postId}` };
    case "QUESTION": return { action: "raise", key: `question:${String(event.payload.questionId)}` };
    case "ANSWERED": return { action: "resolve", key: `question:${String(event.payload.questionId)}` };
    case "RULE_PROPOSED": return { action: "raise", key: `rule:${String(event.payload.ruleId)}` };
    case "RULE_DECIDED": return { action: "resolve", key: `rule:${String(event.payload.ruleId)}` };
    case "CAMPAIGN_PROPOSED": return { action: "raise", key: `campaign:${event.campaignId}` };
    case "CAMPAIGN_DECIDED": return { action: "resolve", key: `campaign:${event.campaignId}` };
    case "PUBLISH_FAILED": return { action: "raise", key: `failed:${event.postId}` };
    case "PUBLISHING": return { action: "resolve", key: `failed:${event.postId}` };
    case "NEEDS_USER": return { action: "raise", key: `event:${event.id}` };
    case "PUBLISHED": return { action: "published", key: `published:${event.postId}` };
    default: return null;
  }
}

/**
 * The Marketing Copilot pane's backend, kept out of the composition root: its repository, the service whose events
 * reach the room stream and (when the copilot needs the operator, or published) the notification system, the
 * operator routes, the run kickoff typed into the pane's CLI and the scheduler of due posts. Returns the service
 * for the agent bridge.
 */
export function registerMarketingCopilot(app: FastifyInstance, deps: MarketingCopilotWiring): MarketingCopilotService {
  const { store, eventBus, terminal, notifications } = deps;
  const repository = deps.repository ?? (deps.databaseUrl ? PostgresMarketingCopilotRepository.fromConnectionString(deps.databaseUrl) : new InMemoryMarketingCopilotRepository());
  app.addHook("onClose", () => repository.dispose());
  const paneOf = (paneId: string) => Promise.resolve(store.getPane(paneId)).catch(() => null);

  async function notify(event: MarketingEvent): Promise<void> {
    const plan = marketingNotificationFor(event);
    const pane = plan && event.paneId ? await paneOf(event.paneId) : null;
    if (!plan || !pane || pane.mode !== "MARKETING_COPILOT") return;
    const owner = await deps.roomOwner(pane.roomId);
    if (!owner) return;
    const dedupeKey = `marketing-copilot:${plan.key}`;
    if (plan.action === "resolve") { await notifications.resolve(owner, dedupeKey); return; }
    const settings = service.settingsOf(pane).notifications;
    if (plan.action === "published" ? !settings.published : !settings.needsYou) return;
    await notifications.raise({ ownerUserId: owner, roomId: pane.roomId, paneId: pane.id, source: "MARKETING_COPILOT", kind: event.type, severity: plan.action === "published" ? "INFO" : "ATTENTION",
      title: plan.action === "published" ? `Published by Marketing Copilot (${pane.title})` : `Marketing Copilot needs you (${pane.title})`, body: event.message.slice(0, 2000),
      link: { roomId: pane.roomId, paneId: pane.id, target: event.postId ? `post:${event.postId}` : `event:${event.id}` }, dedupeKey, payload: { eventId: event.id },
      telegram: settings.telegram ? true : null });
  }

  const paneRooms = new Map<string, string>();
  const service = createMarketingCopilotService({
    repository,
    openInBrowser: async (owner, pane, bookmark, traceId, actor) => {
      // Tabs in another Google account are ADMIN-only, like the browser's account menu and the CLI bridge's SELECT_ACCOUNT.
      if (bookmark.profileId !== null && (await store.getControlActor(owner))?.role !== "ADMIN") throw new GitControlError("ADMIN_REQUIRED", "Google account selection requires a room owned by an ADMIN.", 403);
      const accounts = deps.paneBrowserAccounts.current;
      if (!accounts) throw new SpaceFeatureDisabledError("BROWSER_ACCOUNTS_UNAVAILABLE", "Google account selection is unavailable on this runtime.");
      return accounts.openTab(owner, pane, bookmark.url, bookmark.profileId, traceId, actor);
    },
    resolveArtifactAsset: async (owner, artifactId) => {
      const artifact = await Promise.resolve(store.getArtifact(artifactId)).catch(() => null);
      const roomOwner = artifact?.roomId ? await deps.roomOwner(artifact.roomId) : null;
      if (!artifact || artifact.deletedAt || !["IMAGE", "SCREENSHOT", "VIDEO"].includes(artifact.kind) || roomOwner !== owner) {
        throw new SpaceNotFoundError(`Captured media ${artifactId} was not found in your rooms.`);
      }
      // A post keeps its media: neither the 7-day sweep nor deleting the Studio room (room_id becomes null) removes a pinned file.
      await store.updateArtifactRetention(artifact.id, { pinnedAt: new Date().toISOString(), expiresAt: null });
      return { path: localArtifactFilePath({ artifactRoot: deps.artifactRoot, artifact }), kind: artifact.kind === "VIDEO" ? "VIDEO" : "IMAGE" };
    },
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
          id: makeSpaceId("event"), roomId, paneId: event.paneId, turnId: null, workflowId: null, traceId: `marketing-copilot:${event.id}`,
          type: "MARKETING_COPILOT_UPDATED", message: event.message, payload: { eventId: event.id, type: event.type, postId: event.postId, campaignId: event.campaignId }, createdAt: event.createdAt
        }));
        await notify(event);
      })().catch((error: unknown) => deps.log.warn({ err: error }, "Marketing Copilot event listener failed"));
    }
  });
  // The run's kickoff goes through the pane CLI input path Room Agent uses (typed line + Enter).
  const activeSession = async (pane: Pane) => {
    const session = await store.getActivePaneCliSession(pane.id);
    return session && session.purpose === "NORMAL" && session.isActive && session.status !== "EXITED" && session.status !== "ERROR" ? session : null;
  };
  const kickoff = deps.kickoff ?? (async (pane: Pane, run: MarketingRun) => {
    const session = await activeSession(pane);
    if (!session) throw new SpaceConflictError("Open the copilot's terminal first: the pane has no running CLI session to receive the run.");
    const traceId = `marketing-copilot:${run.id}`;
    await terminal.runSerializedTerminalMutation(session.sessionId, async () => {
      await terminal.sendInput(session.sessionId, KICKOFF(run.id), traceId, null, `${traceId}:kickoff`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await terminal.sendInput(session.sessionId, "\r", traceId, null, `${traceId}:kickoff-submit`);
    });
  });
  registerMarketingCopilotRoutes(app, service, { ...deps, kickoff });

  if (deps.scheduler) {
    const scheduler = createMarketingCopilotScheduler({
      service, store, log: deps.log, version: apiPackageVersion,
      hasAgent: async (pane) => deps.kickoff !== undefined || Boolean(await activeSession(pane)),
      hasActiveRun: async (pane) => Boolean(await service.activeRun(pane.id)),
      startRun: async (owner, pane) => {
        const started = await service.startRun(owner, pane.id);
        if (!started.kickoff) return;
        await kickoff(pane, started.run);
        await service.markKickoff(owner, started.run.id);
      },
      notifyDue: async (owner, room, pane, due) => {
        await notifications.raise({ ownerUserId: owner, roomId: room.id, paneId: pane.id, source: "MARKETING_COPILOT", kind: "POSTS_DUE", severity: "ATTENTION",
          title: `${due.length} approved post${due.length === 1 ? " is" : "s are"} due (${pane.title})`,
          body: `Open the Marketing Copilot's terminal so it can publish: ${[...new Set(due.map((post) => MARKETING_CHANNEL_LABELS[post.channel]))].join(", ")}.`,
          link: { roomId: room.id, paneId: pane.id }, dedupeKey: `marketing-copilot:due:${pane.id}`, payload: { postIds: due.map((post) => post.id) }, telegram: null });
      }
    });
    scheduler.start();
    app.addHook("onClose", async () => scheduler.stop());
  }
  if (deps.metrics) {
    const metrics = createMarketingCopilotMetrics({ service, store, log: deps.log, githubTrafficToken: process.env.SPACE_GITHUB_TRAFFIC_TOKEN || undefined });
    metrics.start();
    app.addHook("onClose", async () => metrics.stop());
  }
  return service;
}
