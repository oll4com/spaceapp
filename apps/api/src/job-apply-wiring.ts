import { eventSchema, resolveJobApplyPaneMetadata, type AuthUser, type JobApplyRun, type Pane } from "@space/contracts";
import { PostgresJobApplyRepository } from "@space/db";
import { SpaceConflictError, makeSpaceId, type SpaceEventBus, type SpaceStore, type TelegramIntegrationManager } from "@space/runtime";
import type { FastifyInstance } from "fastify";
import { cookieName, verifySession, type AuthConfig } from "./auth.js";
import { clearIdleClaudeSession, submitCliPrompt } from "./cli-prompt-submit.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import type { ConnectorCrypto, createConnectorService } from "./dot-connectors.js";
import { createImapMailboxFactory, type MailboxFactory } from "./job-apply/mailbox.js";
import { scheduleJobApplyMailTriage } from "./job-apply/mail-triage-timer.js";
import { InMemoryJobApplyRepository } from "./job-apply/memory-repository.js";
import { registerJobApplyRoutes } from "./job-apply/routes.js";
import { createJobApplyService, jobApplyNeedsYouAsk, type JobApplyGoogleAccess, type JobApplyService, type JobApplyServiceOptions } from "./job-apply/service.js";
import { browserHandoffFocus } from "./notifications/browser-handoff.js";
import type { NotificationService } from "./notifications/service.js";
import { recordAudit } from "./request-audit.js";
import type { createRoomPaneCliController } from "./room-pane-cli-controller.js";
import { parseBody, parseQuery } from "./route-parsing.js";
import { GitControlError } from "./source-control/errors.js";
import { afterWrite, emitMakeEvent } from "./make-webhooks.js";

type JobApplyWiringDeps = {
  store: SpaceStore;
  /** Plan clipboard:7L5KyWp3kQsP step 3: the operator's pinned Space Memory entries sharing a question's words. */
  operatorMemory?: JobApplyServiceOptions["operatorMemory"];
  config: Pick<SpaceApiConfig, "databaseUrl" | "browserEvidenceArtifactRoot" | "jobApplyRoot" | "instanceJobs" | "optionalModules">;
  options: {
    jobApplyService?: JobApplyService;
    jobApplyMailboxes?: MailboxFactory;
    jobApplyGoogle?: JobApplyGoogleAccess;
    jobApplyGmailFetch?: typeof fetch;
    jobApplyMailTriage?: boolean;
    jobApplyKickoff?: (pane: Pane, run: JobApplyRun, discover: boolean) => Promise<void>;
  };
  auth: Pick<AuthConfig, "sessionSecret">;
  eventBus: Pick<SpaceEventBus, "publish">;
  defaultRouteRateLimitOptions: Record<string, unknown>;
  connectorCrypto: ConnectorCrypto;
  connectorServiceRef: { current: ReturnType<typeof createConnectorService> | null };
  notificationService: Pick<NotificationService, "raise" | "resolve" | "list">;
  roomOwner: (roomId: string) => Promise<string | null>;
  telegramIntegrationManager: Pick<TelegramIntegrationManager, "notify">;
  roomPaneController: Pick<ReturnType<typeof createRoomPaneCliController>, "inspect">;
  cliTerminalManager: Pick<CliTerminalManager, "runSerializedTerminalMutation" | "sendInput" | "observeRoomScreenUndimmed">;
  assertRoomAccess: (roomId: string, user: AuthUser | null | undefined) => Promise<unknown>;
};

/**
 * Job Copilot pane wiring (moved verbatim from app.ts, ARCH-001 step 70): the per-owner repository, the service whose
 * activity events reach the pane's room stream, "needs you" notifications and Telegram, the stable-only mail triage timer,
 * and the routes with the run kickoff typed into the pane's CLI. Returns the repository and service other wiring uses.
 */
export function registerJobApply(app: FastifyInstance, deps: JobApplyWiringDeps): { jobApplyRepository: PostgresJobApplyRepository | InMemoryJobApplyRepository; jobApplyService: JobApplyService } {
  const { store, config, options, auth, eventBus, defaultRouteRateLimitOptions, connectorCrypto, connectorServiceRef, notificationService, roomOwner,
    telegramIntegrationManager, roomPaneController, cliTerminalManager, assertRoomAccess } = deps;
  // Job Copilot pane: per-owner candidate profile, sealed mailbox credential, tracker, memory, fields, events and runs.
  const jobApplyRepository = config.databaseUrl ? PostgresJobApplyRepository.fromConnectionString(config.databaseUrl) : new InMemoryJobApplyRepository();
  app.addHook("onClose", () => jobApplyRepository.dispose());
  // Every status change (the service, a run's own writes, the mailbox) goes through this one repository method.
  afterWrite(jobApplyRepository, "updateApplication", (row, [owner, , patch]) => {
    if (row && patch.status) emitMakeEvent(owner, "job_application.status", `${row.id}:${row.status}`, { id: row.id, company: row.company, role: row.role, ats: row.ats,
      url: row.url, status: row.status, appliedAt: row.appliedAt, externalConfirmation: row.externalConfirmation, updatedAt: row.updatedAt });
  });
  const jobApplyPaneRooms = new Map<string, string>();
  const jobApplyService = options.jobApplyService ?? createJobApplyService({
    repository: jobApplyRepository,
    crypto: connectorCrypto,
    store,
    artifactRoot: config.browserEvidenceArtifactRoot,
    jobApplyRoot: config.jobApplyRoot,
    mailboxes: options.jobApplyMailboxes ?? createImapMailboxFactory(),
    // Gmail and Calendar of the Google account chosen in the pane, through the owner's Google connector.
    google: () => options.jobApplyGoogle ?? connectorServiceRef.current,
    gmailFetch: options.jobApplyGmailFetch, notifications: () => notificationService,
    operatorMemory: deps.operatorMemory,
    // Every activity event reaches the pane's room over the event stream; "needs you" moments and run
    // summaries also go to Telegram when the pane settings ask for it.
    onEvent: (event) => {
      void (async () => {
        if (!event.paneId) return;
        let roomId = jobApplyPaneRooms.get(event.paneId) ?? null;
        let pane: Pane | null = null;
        if (!roomId) {
          pane = await Promise.resolve(store.getPane(event.paneId)).catch(() => null);
          roomId = pane?.roomId ?? null;
          if (roomId) jobApplyPaneRooms.set(event.paneId, roomId);
        }
        if (!roomId) return;
        eventBus.publish(eventSchema.parse({
          id: makeSpaceId("event"), roomId, paneId: event.paneId, turnId: null, workflowId: null, traceId: `job-apply:${event.id}`,
          type: "JOB_APPLY_UPDATED", message: event.message, payload: { event }, createdAt: event.createdAt
        }));
        // A question answered, a review decided or a handoff resolved closes its "needs you" notification.
        const needsYouKey = (kind: string, id: unknown) => `job-apply:${kind}:${String(id ?? event.id)}`;
        const resolves = event.type === "ANSWERED" ? needsYouKey("question", event.payload.questionId) : event.type === "REVIEW_DECIDED" ? needsYouKey("review", event.payload.reviewId)
          : event.type === "HANDOFF_RESOLVED" ? needsYouKey("handoff", event.paneId) : null;
        if (resolves) {
          const owner = await roomOwner(roomId);
          if (owner) await notificationService.resolve(owner, resolves);
          return;
        }
        // Mail triage reaches Telegram only when an application email asks for something.
        const mailNeedsYou = event.type === "MAIL" && event.payload.category === "ACTION_NEEDED";
        // A posting parked as NEEDS_USER logs a QUESTION without a questionId: nothing to answer, nothing resolves it (its real question notifies).
        if (!mailNeedsYou && (!["HANDOFF_REQUESTED", "QUESTION", "REVIEW_REQUESTED", "RUN_FINISHED", "RUN_STOPPED"].includes(event.type) || (event.type === "QUESTION" && typeof event.payload.questionId !== "string"))) return;
        pane ??= await Promise.resolve(store.getPane(event.paneId)).catch(() => null);
        if (!pane || pane.mode !== "JOB_APPLY") return;
        // "Needs you" moments and run summaries are notifications; the pane's own toggles decide in-app and Telegram.
        const notifications = resolveJobApplyPaneMetadata(pane.jobApplyMetadata).settings.notifications;
        if (!notifications.inApp && !notifications.telegram) return;
        const owner = await roomOwner(roomId);
        if (!owner) return;
        const needsYou = mailNeedsYou || event.type === "HANDOFF_REQUESTED" || event.type === "QUESTION" || event.type === "REVIEW_REQUESTED";
        // A sign-in, code or CAPTCHA the agent logs is a focus card like the browser handoff's: Go now to its tab, one question, steps behind Details.
        const focus = event.type === "HANDOFF_REQUESTED"
          ? browserHandoffFocus(await Promise.resolve(store.getActivePaneBrowserSession(pane.id)).catch(() => null), event.message) : null;
        const raised = await notificationService.raise({ ownerUserId: owner, roomId, paneId: event.paneId, source: "JOB_COPILOT", kind: event.type, severity: needsYou ? "ATTENTION" : "INFO",
          title: needsYou ? `${pane.title} needs you` : `${pane.title}: ${event.type === "RUN_FINISHED" ? "run finished" : "run stopped"}`,
          // A question's card asks it under its own heading: its body is the question alone ("Needs you: <question>" repeated it, operator 1/11 23:09 BKK).
          body: focus?.body ?? (event.type === "QUESTION" && typeof event.payload.question === "string" ? event.payload.question : event.message),
          link: { roomId, paneId: event.paneId, target: focus ? focus.target ?? "browser" : `job-apply-event:${event.id}` },
          dedupeKey: !needsYou ? null : event.type === "QUESTION" ? needsYouKey("question", event.payload.questionId) : event.type === "REVIEW_REQUESTED" ? needsYouKey("review", event.payload.reviewId)
            : event.type === "HANDOFF_REQUESTED" ? needsYouKey("handoff", event.paneId) : `job-apply:${event.type}:${event.id}`, payload: { eventId: event.id, ...jobApplyNeedsYouAsk(event), ...(focus ? { ask: focus.ask } : {}) }, telegram: false });
        if (!notifications.telegram || raised.payload.heldForNous || raised.payload.heldUntil) return; // held for Nous (Ask Last step 7) or the night: no direct line
        await telegramIntegrationManager.notify(`Job Copilot (${pane.title}): ${event.message}`).catch((error: unknown) => {
          app.log.warn({ err: error, paneId: event.paneId }, "Job Copilot Telegram notification failed");
        });
      })().catch((error: unknown) => app.log.warn({ err: error }, "Job Copilot event listener failed"));
    }
  });
  // Job Copilot mail triage every 15 minutes (stable only; a dev copy would act on real Gmail).
  scheduleJobApplyMailTriage(app, { enabled: config.instanceJobs["job-apply-mail-triage"] && options.jobApplyMailTriage !== false && config.optionalModules.has("job-copilot"), triage: (onError) => jobApplyService.triageMailForAllOwners(onError) });
  if (config.optionalModules.has("job-copilot")) registerJobApplyRoutes(app, jobApplyService, {
    store, ...(config.instanceJobs["job-apply-mail-triage"] ? { inspect: (pane: Pane) => roomPaneController.inspect(pane, { fresh: true }), log: app.log } : {}),
    routeOptions: defaultRouteRateLimitOptions,
    // The run's kickoff goes through the pane CLI input path Room Agent uses (typed line + Enter).
    kickoff: options.jobApplyKickoff ?? (async (pane, run, discover) => {
      const session = await store.getActivePaneCliSession(pane.id);
      if (!session || session.purpose !== "NORMAL" || !session.isActive || session.status === "EXITED" || session.status === "ERROR") {
        throw new SpaceConflictError("Open the copilot's terminal first: the pane has no running CLI session to receive the run.");
      }
      const prompt = `Job Copilot run ${run.id} started in this pane. Read the space-job-applications skill (SKILL.md), then ${discover ? "first find new postings, because nothing queued can be taken now (the queue is empty or every posting waits for an employer limit): follow references/discovery.md (space_job_discover_search with the operator's PREFERENCE filters, score each against the CV) and queue each one scoring 3 or more with space_job_application_start status QUEUED; then " : ""}call space_jobapply space_job_next (again while it answers waiting=true) until it hands you one application or returns done=true (without MCP tools in this session, call them on demand: JSON {"serverId","toolName","arguments"} on stdin to space-capability call); follow the skill's steps for that one application (space_job_memory_recall before asking, space_job_fields_record on every step, evidence before VERIFIED), close it with space_job_report and end your turn: Space starts a fresh session for the next one.`;
      const traceId = `job-apply:${run.id}`;
      await cliTerminalManager.runSerializedTerminalMutation(session.sessionId, async () => {
        // A run with no application in progress starts a fresh Claude session (plan clipboard:qH5emwVaV6yO step 4); one application a turn (step 6:
        // one turn looping over every application re-sent ~200k tokens a request), so each application starts fresh.
        if (!run.currentApplicationId) await clearIdleClaudeSession(cliTerminalManager, session, traceId, traceId);
        await submitCliPrompt(cliTerminalManager, session.sessionId, prompt, traceId, `${traceId}:kickoff`);
      });
    }),
    authenticatedOwner: async (request) => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Job Copilot.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    },
    assertPaneAccess: async (request, pane) => { await assertRoomAccess(pane.roomId, request.user); },
    parseBody,
    parseQuery,
    audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "job_apply", targetId, metadata })
  });
  return { jobApplyRepository, jobApplyService };
}
