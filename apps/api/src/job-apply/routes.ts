import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  jobApplicationCreateSchema,
  jobApplicationListQuerySchema,
  jobApplicationUpdateSchema,
  jobApplyCsvImportRequestSchema,
  jobApplyCsvImportResultSchema,
  jobApplyDiscoverRequestSchema,
  jobApplyEventListQuerySchema,
  jobApplyGoogleAccountInputSchema,
  jobApplyMailCheckResultSchema,
  jobApplyMailboxInputSchema,
  jobApplyMemoryCreateSchema,
  jobApplyMemoryQuerySchema,
  jobApplyMemoryUpdateSchema,
  jobApplyPaneMetadataSchema,
  jobApplyProfileUpdateSchema,
  jobApplyQuestionAnswerSchema,
  jobApplyQueueAddSchema,
  jobApplyQueueReorderSchema,
  jobApplyResetRequestSchema,
  jobApplyResetResultSchema,
  jobApplyReviewDecideSchema,
  jobApplyStatsQuerySchema,
  jobApplyStatsSchema,
  jobApplicationQueueHolds,
  resolveJobApplyPaneMetadata,
  type JobApplyRun,
  type Pane
} from "@space/contracts";
import { createCopilotRunKick } from "../copilot-run-kick.js";
import type { RoomPaneObservation } from "../room-pane-control.js";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { JobApplyService } from "./service.js";

export interface JobApplyRouteDependencies {
  store: Pick<SpaceStore, "getPane" | "updateJobApplyMetadata" | "listRooms" | "listPanes">;
  routeOptions: Record<string, unknown>;
  /** Sends the run's kickoff prompt into the pane's CLI (the existing pane CLI input path). */
  kickoff(pane: Pane, run: JobApplyRun, discover: boolean): Promise<void>;
  /** Resolves the signed-in owner; throws the API's 401 error when absent. */
  authenticatedOwner(request: FastifyRequest): Promise<string>;
  assertPaneAccess(request: FastifyRequest, pane: Pane): Promise<void>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
  /** The pane's CLI as the Room Agent sees it; with it, a stalled RUNNING run is kicked again (app.ts passes it with stable's job-apply-mail-triage job). */
  inspect?(pane: Pane): Promise<RoomPaneObservation>;
  log?: { warn(details: unknown, message: string): void };
}

/** A RUNNING run with no activity this long, whose CLI sits at an empty prompt with postings queued, lost its loop. */
const RUN_IDLE_MS = 10 * 60_000;

/** The stalled-run kick of Job Copilot panes (see registerJobApplyRoutes); `now` for tests. */
export function createJobApplyRunKick(service: Pick<JobApplyService, "runView" | "markKickoff" | "pacing">, deps: Pick<JobApplyRouteDependencies, "store" | "kickoff">
  & { inspect(pane: Pane): Promise<RoomPaneObservation>; log: { warn(details: unknown, message: string): void }; now?: () => number }) {
  const now = deps.now ?? Date.now;
  return createCopilotRunKick<JobApplyRun>({ mode: "JOB_APPLY", store: deps.store, log: deps.log, inspect: deps.inspect, now,
    paused: (pane) => resolveJobApplyPaneMetadata(pane.jobApplyMetadata).settings.paused,
    runView: async (owner, pane) => {
      const { run, queue } = await service.runView(owner, pane.id);
      if (run === null || now() - Date.parse(run.lastActivityAt) < RUN_IDLE_MS) return { run, backlog: 0 };
      // 27/10 (queue item 22): with every site at its daily cap the kick re-typed all night and the agent answered PACING; a capped
      // site's postings wait for 00:00 UTC, when the count changes and the kick fires again.
      const eligible = jobApplicationQueueHolds(queue, new Date(now()).toISOString()).eligible;
      const capped = new Set<string>();
      for (const site of new Set(eligible.map((row) => row.ats))) {
        if ((await service.pacing(owner, site, pane.jobApplyMetadata)).nextAllowedAt === "tomorrow") capped.add(site);
      }
      return { run, backlog: eligible.filter((row) => !capped.has(row.ats)).length };
    },
    kickoff: async (pane, run) => {
      await deps.kickoff(pane, run, false);
      await service.markKickoff(run.ownerUserId, run.id);
    } });
}

const artifactIdBodySchema = z.object({ artifactId: z.string().regex(/^artifact:[A-Za-z0-9_-]{6,80}$/) }).strict();
const paneParamsSchema = z.object({ id: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/) }).strict();
const applicationParamsSchema = z.object({ id: z.string().regex(/^jobapp:[A-Za-z0-9_-]{6,80}$/) }).strict();
const memoryParamsSchema = z.object({ id: z.string().regex(/^jobmem:[A-Za-z0-9_-]{6,80}$/) }).strict();
const fieldParamsSchema = z.object({ id: z.string().regex(/^jobfield:[A-Za-z0-9_-]{6,80}$/) }).strict();
const fieldEditSchema = z.object({ value: z.string().max(4000).nullable() }).strict();
const eventsQuerySchema = jobApplyEventListQuerySchema.extend({ paneId: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/).optional() });

/** Operator-facing routes of the Job Applications pane. Profiles are per signed-in owner; settings are per pane. */
export function registerJobApplyRoutes(app: FastifyInstance, service: JobApplyService, deps: JobApplyRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  // A side prompt typed into the copilot's CLI ends its space_job_next loop and nothing restarted it (27/10: jobrun:Oi8f4FqqNQUo idled
  // 06:47-14:46 UTC): an unpaused pane whose RUNNING run idled 10 minutes with postings it can take gets its kickoff again, only at an
  // empty prompt (no draft, no usage limit), at most once a minute, the same run state at most every 10 minutes (Mail Copilot's rule).
  if (deps.inspect && deps.log) {
    const kick = createJobApplyRunKick(service, { ...deps, inspect: deps.inspect, log: deps.log });
    kick.start();
    app.addHook("onClose", async () => kick.stop());
  }

  app.get("/api/job-apply/profile", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    return { profile: await service.getProfile(owner) };
  });

  app.patch("/api/job-apply/profile", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(jobApplyProfileUpdateSchema, request.body ?? {});
    const profile = await service.updateProfile(owner, input);
    await deps.audit(request, "job_apply.profile.update", owner, { fields: Object.keys(input) });
    return { profile };
  });

  app.post("/api/job-apply/profile/cv", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(artifactIdBodySchema, request.body ?? {});
    const result = await service.importCv(owner, input.artifactId);
    await deps.audit(request, "job_apply.profile.cv_import", owner, { artifactId: input.artifactId, coverage: result.coverage });
    return result;
  });

  // Operator rule 2026-10-17: photo upload fields get the CV's photo (copied into the copilot's own files).
  app.post("/api/job-apply/profile/photo-from-cv", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const { path: _path, ...photo } = await service.savePhotoFromCv(owner);
    await deps.audit(request, "job_apply.profile.photo_from_cv", owner, { width: photo.width, height: photo.height, bytes: photo.bytes });
    return { photo };
  });

  app.put("/api/job-apply/mailbox", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(jobApplyMailboxInputSchema, request.body ?? {});
    const profile = await service.setMailbox(owner, input);
    await deps.audit(request, "job_apply.mailbox.connect", owner, { host: input.host, user: input.user });
    return { profile };
  });

  app.post("/api/job-apply/mailbox/test", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    return service.testMailbox(owner);
  });

  app.delete("/api/job-apply/mailbox", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const profile = await service.clearMailbox(owner);
    await deps.audit(request, "job_apply.mailbox.disconnect", owner);
    return { profile };
  });

  // The copilot's Google account: mail and calendar go through the owner's Google connector for that email.
  app.put("/api/job-apply/google", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(jobApplyGoogleAccountInputSchema, request.body ?? {});
    const profile = await service.setGoogleAccount(owner, input.email);
    await deps.audit(request, "job_apply.google_account.set", owner, { email: input.email });
    return { profile };
  });

  app.get("/api/job-apply/applications", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const query = parseQuery(jobApplicationListQuerySchema, request.query ?? {});
    return { applications: await service.listApplications(owner, query) };
  });

  app.get("/api/job-apply/stats", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const query = parseQuery(jobApplyStatsQuerySchema, request.query ?? {});
    return { stats: jobApplyStatsSchema.parse(await service.stats(owner, query.tz)) };
  });

  app.post("/api/job-apply/reset", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(jobApplyResetRequestSchema, request.body);
    const reset = jobApplyResetResultSchema.parse(await service.resetCampaign(owner, { expectedCampaignStartedAt: input.expectedCampaignStartedAt }));
    await deps.audit(request, "job_apply.campaign.reset", null, { campaignStartedAt: reset.campaignStartedAt, closed: reset.closed, runsStopped: reset.runsStopped });
    return { reset };
  });

  app.post("/api/job-apply/applications", routeOptions, async (request, reply) => {
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(jobApplicationCreateSchema, request.body ?? {});
    const result = await service.createApplication(owner, input);
    if (result.created) {
      reply.code(201);
      await deps.audit(request, "job_apply.application.create", result.application.id, { ats: input.ats, company: input.company });
    }
    return result;
  });

  app.patch("/api/job-apply/applications/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(applicationParamsSchema, request.params);
    const input = parseBody(jobApplicationUpdateSchema, request.body ?? {});
    const application = await service.updateApplication(owner, params.id, input);
    await deps.audit(request, "job_apply.application.update", application.id, { status: application.status });
    return { application };
  });

  app.post("/api/job-apply/applications/import-csv", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(jobApplyCsvImportRequestSchema, request.body ?? {});
    const result = jobApplyCsvImportResultSchema.parse(await service.importCsv(owner, input.csv, input.paneId ?? null));
    await deps.audit(request, "job_apply.application.import_csv", owner, result);
    return result;
  });

  // Check with Gmail: sent applications are confirmed by their confirmation emails, or marked as having none.
  app.post("/api/job-apply/applications/check-mail", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(z.object({ paneId: paneParamsSchema.shape.id.optional() }).strict(), request.body ?? {});
    const result = jobApplyMailCheckResultSchema.parse(await service.checkWithMail(owner, { paneId: input.paneId ?? null }));
    await deps.audit(request, "job_apply.application.check_mail", owner, result);
    return result;
  });

  app.delete("/api/job-apply/applications/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(applicationParamsSchema, request.params);
    await service.removeFromQueue(owner, params.id);
    await deps.audit(request, "job_apply.application.remove", params.id);
    return { removed: true };
  });

  app.get("/api/job-apply/applications/:id/fields", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(applicationParamsSchema, request.params);
    return { fields: await service.listFields(owner, params.id) };
  });

  app.patch("/api/job-apply/fields/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(fieldParamsSchema, request.params);
    const input = parseBody(fieldEditSchema, request.body ?? {});
    const field = await service.editField(owner, params.id, input.value);
    await deps.audit(request, "job_apply.field.edit", field.id, { applicationId: field.applicationId });
    return { field };
  });

  app.post("/api/job-apply/applications/:id/answer", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(applicationParamsSchema, request.params);
    const input = parseBody(jobApplyQuestionAnswerSchema, request.body ?? {});
    const result = await service.answerQuestion(owner, params.id, input);
    await deps.audit(request, "job_apply.question.answer", params.id, { questionId: input.questionId });
    return result;
  });

  app.post("/api/job-apply/applications/:id/review", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(applicationParamsSchema, request.params);
    const input = parseBody(jobApplyReviewDecideSchema, request.body ?? {});
    const result = await service.decideReview(owner, params.id, input);
    await deps.audit(request, "job_apply.review.decide", params.id, { reviewId: input.reviewId, decision: input.decision });
    return result;
  });

  // Memory: the copilot's own facts, answers, lessons and preferences (never Dot memory).
  app.get("/api/job-apply/memory", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const query = parseQuery(jobApplyMemoryQuerySchema, request.query ?? {});
    return { memories: await service.listMemory(owner, query), total: await service.memoryCount(owner) };
  });

  app.post("/api/job-apply/memory", routeOptions, async (request, reply) => {
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(jobApplyMemoryCreateSchema, request.body ?? {});
    const memory = await service.rememberMemory(owner, { ...input, source: input.source ?? "USER" });
    reply.code(201);
    await deps.audit(request, "job_apply.memory.remember", memory.id, { kind: memory.kind });
    return { memory };
  });

  app.patch("/api/job-apply/memory/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(memoryParamsSchema, request.params);
    const input = parseBody(jobApplyMemoryUpdateSchema, request.body ?? {});
    const memory = await service.updateMemory(owner, params.id, input);
    await deps.audit(request, "job_apply.memory.update", memory.id, { fields: Object.keys(input) });
    return { memory };
  });

  app.delete("/api/job-apply/memory/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(memoryParamsSchema, request.params);
    await service.forgetMemory(owner, params.id);
    await deps.audit(request, "job_apply.memory.forget", params.id);
    return { forgotten: true };
  });

  app.get("/api/job-apply/events", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const query = parseQuery(eventsQuerySchema, request.query ?? {});
    return { events: await service.listEvents(owner, query) };
  });

  // Run supervisor and queue, per pane.
  async function jobApplyPane(request: FastifyRequest): Promise<Pane> {
    const params = parseQuery(paneParamsSchema, request.params);
    const pane = await deps.store.getPane(params.id);
    await deps.assertPaneAccess(request, pane);
    if (pane.mode !== "JOB_APPLY") throw new SpaceConflictError("This is not a Job Copilot pane.");
    return pane;
  }

  app.get("/api/panes/:id/job-apply/run", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const pane = await jobApplyPane(request);
    return service.runView(owner, pane.id);
  });

  app.post("/api/panes/:id/job-apply/run/start", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const pane = await jobApplyPane(request);
    const started = await service.startRun(owner, pane.id);
    let kickoffSent = false;
    if (started.kickoff) {
      await deps.kickoff(pane, started.run, started.discover);
      await service.markKickoff(owner, started.run.id);
      kickoffSent = true;
    }
    await deps.audit(request, "job_apply.run.start", started.run.id, { paneId: pane.id, resumed: started.resumed, kickoffSent });
    return { ...(await service.runView(owner, pane.id)), kickoffSent };
  });

  app.post("/api/panes/:id/job-apply/run/pause", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const pane = await jobApplyPane(request);
    const run = await service.pauseRun(owner, pane.id);
    await deps.audit(request, "job_apply.run.pause", run.id, { paneId: pane.id });
    return service.runView(owner, pane.id);
  });

  app.post("/api/panes/:id/job-apply/run/stop", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const pane = await jobApplyPane(request);
    const run = await service.stopRun(owner, pane.id);
    await deps.audit(request, "job_apply.run.stop", run.id, { paneId: pane.id, counters: run.counters });
    return service.runView(owner, pane.id);
  });

  app.get("/api/panes/:id/job-apply/queue", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const pane = await jobApplyPane(request);
    return { queue: await service.listQueue(owner, pane.id) };
  });

  app.post("/api/panes/:id/job-apply/queue", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const pane = await jobApplyPane(request);
    const input = parseBody(jobApplyQueueAddSchema, request.body ?? {});
    const result = await service.addToQueue(owner, pane.id, input.urls, { paneId: pane.id });
    await deps.audit(request, "job_apply.queue.add", pane.id, { queued: result.queued.length, existing: result.existing, rejected: result.rejected.length });
    return result;
  });

  app.post("/api/panes/:id/job-apply/discover", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const pane = await jobApplyPane(request);
    const input = parseBody(jobApplyDiscoverRequestSchema, request.body ?? {});
    const result = await service.discover(owner, input);
    await deps.audit(request, "job_apply.discover", pane.id, { boards: result.scanned.length, postings: result.postings.length });
    return result;
  });

  app.put("/api/panes/:id/job-apply/queue/order", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const pane = await jobApplyPane(request);
    const input = parseBody(jobApplyQueueReorderSchema, request.body ?? {});
    await service.reorderQueue(owner, input.applicationIds);
    return { queue: await service.listQueue(owner, pane.id) };
  });

  app.get("/api/panes/:id/job-apply/settings", routeOptions, async (request) => {
    await deps.authenticatedOwner(request);
    const params = parseQuery(paneParamsSchema, request.params);
    const pane = await deps.store.getPane(params.id);
    await deps.assertPaneAccess(request, pane);
    if (pane.mode !== "JOB_APPLY") throw new SpaceConflictError("Settings belong to a Job Copilot pane.");
    return { metadata: resolveJobApplyPaneMetadata(pane.jobApplyMetadata) };
  });

  app.put("/api/panes/:id/job-apply/settings", routeOptions, async (request) => {
    await deps.authenticatedOwner(request);
    const params = parseQuery(paneParamsSchema, request.params);
    const pane = await deps.store.getPane(params.id);
    await deps.assertPaneAccess(request, pane);
    const metadata = parseBody(jobApplyPaneMetadataSchema, request.body ?? {});
    const updated = await deps.store.updateJobApplyMetadata(pane.id, metadata);
    await deps.audit(request, "job_apply.settings.update", pane.id, { paused: metadata.settings.paused, submitMode: metadata.settings.submitMode });
    return { metadata: resolveJobApplyPaneMetadata(updated.jobApplyMetadata) };
  });
}
