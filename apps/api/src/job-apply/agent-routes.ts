import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  jobApplicationCreateSchema,
  jobApplicationFieldsRecordSchema,
  jobApplyCandidateSchema,
  jobApplyCsvImportRequestSchema,
  jobApplicationListQuerySchema,
  jobApplicationUpdateSchema,
  jobApplyDiscoverRequestSchema,
  jobApplyEventInputSchema,
  jobApplyMailboxConnected,
  jobApplyMailOrganizeSchema,
  jobApplyMemoryCreateSchema,
  jobApplyMemoryQuerySchema,
  jobApplyMemoryUpdateSchema,
  jobApplyNextRequestSchema,
  jobApplyQaSourceSchema,
  jobApplyQuestionAskSchema,
  jobApplyQuestionWaitSchema,
  jobApplyReportRequestSchema,
  jobApplyReviewRequestSchema,
  jobApplyReviewWaitSchema,
  jobApplySiteSchema,
  resolveJobApplyPaneMetadata
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { JobApplyService } from "./service.js";
import { settleEndedOperatorLease } from "../browser-control-activity.js";

// Agent-facing routes of the Job Applications pane. They are reached with the
// pane-scoped CLI browser bridge token; the owner is the room owner. The agent
// gets answers, codes, links and tracker rows, never the mailbox credential.
export const cliJobApplyPathPrefix = "/api/cli/job-apply/";

export interface CliBridgeClaims { roomId: string; paneId: string; cliSessionId: string }
export interface JobApplyAgentRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane" | "getActivePaneBrowserSession" | "getActiveBrowserControlLease" | "getActiveBrowserHandoffRequest"
    | "getBrowserControlLease" | "updateBrowserControlLease" | "updateBrowserHandoffRequest">;
  routeOptions: Record<string, unknown>;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims } | null>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
}

const questionSchema = z.object({ question: z.string().trim().min(1).max(500) }).strict();
const recordAnswerSchema = z.object({
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().max(4000),
  source: jobApplyQaSourceSchema.optional()
}).strict();
const applicationParamsSchema = z.object({ id: z.string().regex(/^jobapp:[A-Za-z0-9_-]{6,80}$/) }).strict();
const pacingQuerySchema = z.object({ site: jobApplySiteSchema, company: z.string().trim().min(1).max(200).optional() }).strict();
const mailFilterSchema = {
  fromContains: z.string().trim().min(1).max(200).nullable().optional(),
  subjectContains: z.string().trim().min(1).max(200).nullable().optional(),
  since: z.string().datetime({ offset: true }).nullable().optional(),
  timeoutMs: z.number().int().min(0).max(180_000).default(90_000)
};
const waitCodeSchema = z.object({ ...mailFilterSchema, pattern: z.string().min(1).max(300) }).strict();
const findLinkSchema = z.object({ ...mailFilterSchema, urlContains: z.string().trim().min(1).max(200).nullable().optional() }).strict();
const recentQuerySchema = z.object({
  fromContains: z.string().trim().min(1).max(200).optional(),
  subjectContains: z.string().trim().min(1).max(200).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10)
}).strict();
// `account` names one of the Google accounts allowed for Space; without it a search spans them all and the
// other tools use the copilot's chosen account.
const googleAccountField = { account: z.string().trim().toLowerCase().email().max(320).optional() };
const mailSearchSchema = z.object({ query: z.string().trim().max(300).default(""), limit: z.number().int().min(1).max(25).default(10), ...googleAccountField }).strict();
const mailReadSchema = z.object({ messageId: z.string().trim().min(1).max(300), ...googleAccountField }).strict();
const mailDraftSchema = z.object({
  to: z.array(z.string().trim().email().max(320)).min(1).max(20), subject: z.string().max(300), body: z.string().max(20_000), ...googleAccountField
}).strict();
const isoTimeSchema = z.string().trim().refine((value) => !Number.isNaN(Date.parse(value)), "Use an ISO 8601 time.");
const calendarListSchema = z.object({ from: isoTimeSchema.optional(), to: isoTimeSchema.optional(), limit: z.number().int().min(1).max(50).default(20), ...googleAccountField }).strict();
// Events go to the operator's own calendar only: no attendees, so Google sends no invitation.
const calendarCreateSchema = z.object({
  title: z.string().trim().min(1).max(300), start: isoTimeSchema, end: isoTimeSchema, timeZone: z.string().max(80).optional(),
  location: z.string().max(300).optional(), description: z.string().max(5000).optional(), ...googleAccountField
}).strict();
const paneQuerySchema = z.object({ paneId: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/).optional() }).strict();
const memoryParamsSchema = z.object({ id: z.string().regex(/^jobmem:[A-Za-z0-9_-]{6,80}$/) }).strict();
const artifactIdSchema = z.string().regex(/^artifact:[A-Za-z0-9_-]{6,80}$/);
const profileBootstrapSchema = z.object({ candidate: jobApplyCandidateSchema }).strict();
const profileFilesSchema = z.object({ cvArtifactId: artifactIdSchema.optional(), coverLetterArtifactId: artifactIdSchema.optional() }).strict()
  .refine((value) => value.cvArtifactId !== undefined || value.coverLetterArtifactId !== undefined, "Name the CV or the cover letter artifact.");

export function registerJobApplyAgentRoutes(app: FastifyInstance, service: JobApplyService, deps: JobApplyAgentRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;

  async function owner(claims: CliBridgeClaims): Promise<string> {
    const room = await deps.store.getRoom(claims.roomId);
    if (!room.ownerUserId) throw new SpaceConflictError("This room has no owner; open the Job Copilot pane from a signed-in operator account.");
    return room.ownerUserId;
  }

  async function paneSettings(paneId: string) {
    try {
      const pane = await deps.store.getPane(paneId);
      return pane.mode === "JOB_APPLY" ? resolveJobApplyPaneMetadata(pane.jobApplyMetadata) : null;
    } catch {
      return null;
    }
  }

  const route = (path: string) => `${cliJobApplyPathPrefix}${path}`;

  app.get(route("profile"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const ownerId = await owner(bridge.claims);
    const [profile, cv, settings] = await Promise.all([service.getProfile(ownerId), service.cvText(ownerId), paneSettings(bridge.claims.paneId)]);
    const coverLetterPath = profile.coverLetterArtifactId ? await service.artifactPath(profile.coverLetterArtifactId) : null;
    return {
      candidate: profile.candidate,
      qaBank: profile.qaBank,
      cv: { artifactId: cv.artifactId, path: cv.path, chars: cv.text?.length ?? 0 },
      coverLetter: { artifactId: profile.coverLetterArtifactId, path: coverLetterPath },
      mailboxConnected: jobApplyMailboxConnected(profile),
      google: profile.google,
      googleAccounts: profile.googleAccounts,
      settings: settings?.settings ?? null
    };
  });

  // First-run setup by the copilot, from the operator's own files: allowed only while the profile is
  // empty (no name and no email) or has no CV yet. Afterwards only the operator edits identity in Setup.
  app.patch(route("profile/candidate"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(profileBootstrapSchema, request.body ?? {});
    const ownerId = await owner(bridge.claims);
    const current = await service.getProfile(ownerId);
    if (current.candidate.fullName || current.candidate.email) {
      throw new SpaceConflictError("The operator's profile is already set; identity facts change only in the pane's Setup.");
    }
    const profile = await service.updateProfile(ownerId, { candidate: input.candidate });
    await deps.audit(request, "job_apply.agent.profile_bootstrap", ownerId, { fields: Object.entries(input.candidate).filter(([, value]) => value !== null && value !== "" && !(Array.isArray(value) && value.length === 0)).map(([key]) => key) });
    return { candidate: profile.candidate };
  });

  app.post(route("profile/files"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(profileFilesSchema, request.body ?? {});
    const ownerId = await owner(bridge.claims);
    const current = await service.getProfile(ownerId);
    if (input.cvArtifactId && current.cvArtifactId) throw new SpaceConflictError("A CV is already set; replace it in the pane's Setup.");
    if (input.coverLetterArtifactId && current.coverLetterArtifactId) throw new SpaceConflictError("A cover letter is already set; replace it in the pane's Setup.");
    let coverage: string | null = null;
    if (input.cvArtifactId) coverage = (await service.importCv(ownerId, input.cvArtifactId)).coverage;
    if (input.coverLetterArtifactId) await service.updateProfile(ownerId, { coverLetterArtifactId: input.coverLetterArtifactId });
    const profile = await service.getProfile(ownerId);
    await deps.audit(request, "job_apply.agent.profile_files", ownerId, { cvArtifactId: input.cvArtifactId ?? null, coverLetterArtifactId: input.coverLetterArtifactId ?? null, coverage });
    return { cvArtifactId: profile.cvArtifactId, cvTextChars: profile.cvTextChars, coverage, coverLetterArtifactId: profile.coverLetterArtifactId };
  });

  // The operator's earlier campaign tracker, imported with the same parser and status mapping as the pane's Import CSV.
  app.post(route("applications/check-mail"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const result = await service.checkWithMail(await owner(bridge.claims), { paneId: bridge.claims.paneId });
    await deps.audit(request, "job_apply.agent.check_mail", bridge.claims.paneId, result);
    return result;
  });

  app.post(route("applications/import-csv"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(jobApplyCsvImportRequestSchema.omit({ paneId: true }), request.body ?? {});
    const result = await service.importCsv(await owner(bridge.claims), input.csv, bridge.claims.paneId);
    await deps.audit(request, "job_apply.agent.import_csv", bridge.claims.paneId, result);
    return result;
  });

  app.get(route("profile/cv-text"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const cv = await service.cvText(await owner(bridge.claims));
    return { artifactId: cv.artifactId, text: cv.text ?? "" };
  });

  // Answer bank lookups and records live in the copilot's memory (ANSWER kind).
  app.post(route("profile/answer"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(questionSchema, request.body ?? {});
    const match = await service.answerFor(await owner(bridge.claims), input.question);
    return match ? { found: true, answer: match.text, source: match.source, question: match.key, memoryId: match.id } : { found: false, answer: null, source: null, question: null, memoryId: null };
  });

  app.post(route("profile/answers"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(recordAnswerSchema, request.body ?? {});
    const ownerId = await owner(bridge.claims);
    const memory = await service.rememberMemory(ownerId, { kind: "ANSWER", key: input.question, text: input.answer, source: input.source ?? "AGENT" });
    await deps.audit(request, "job_apply.agent.answer_recorded", ownerId, { source: memory.source });
    return { recorded: true, entry: { question: input.question, answer: memory.text, source: memory.source, updatedAt: memory.updatedAt }, memory };
  });

  // Memory tools: recall before asking, remember after answering.
  app.get(route("memory"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const query = parseQuery(jobApplyMemoryQuerySchema, request.query ?? {});
    return { memories: await service.listMemory(await owner(bridge.claims), query) };
  });

  app.post(route("memory/recall"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const query = parseBody(jobApplyMemoryQuerySchema, request.body ?? {});
    return { memories: await service.recallMemory(await owner(bridge.claims), query) };
  });

  app.post(route("memory"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(jobApplyMemoryCreateSchema, request.body ?? {});
    const memory = await service.rememberMemory(await owner(bridge.claims), { ...input, source: input.source ?? "AGENT" });
    await deps.audit(request, "job_apply.agent.memory_remember", memory.id, { kind: memory.kind });
    return { memory };
  });

  app.patch(route("memory/:id"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const params = parseQuery(memoryParamsSchema, request.params);
    const input = parseBody(jobApplyMemoryUpdateSchema, request.body ?? {});
    return { memory: await service.updateMemory(await owner(bridge.claims), params.id, input) };
  });

  app.delete(route("memory/:id"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const params = parseQuery(memoryParamsSchema, request.params);
    await service.forgetMemory(await owner(bridge.claims), params.id);
    return { forgotten: true };
  });

  // Activity events the agent reports explicitly (screenshots, notes, steps).
  app.post(route("events"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(jobApplyEventInputSchema, request.body ?? {});
    const run = await service.runView(await owner(bridge.claims), bridge.claims.paneId);
    return { event: await service.logEvent(await owner(bridge.claims), { ...input, paneId: bridge.claims.paneId, runId: run.run?.id ?? null }) };
  });

  app.post(route("discover"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(jobApplyDiscoverRequestSchema, request.body ?? {});
    return service.discover(await owner(bridge.claims), input);
  });

  // The run loop: space_job_next long-polls for the next allowed posting; space_job_report closes it.
  app.post(route("job/next"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(jobApplyNextRequestSchema, request.body ?? {});
    const settings = await paneSettings(bridge.claims.paneId);
    return service.nextJob(await owner(bridge.claims), bridge.claims.paneId, { waitMs: input.waitMs, metadata: settings });
  });

  app.post(route("job/report"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(jobApplyReportRequestSchema, request.body ?? {});
    const result = await service.reportJob(await owner(bridge.claims), bridge.claims.paneId, input);
    await deps.audit(request, "job_apply.agent.job_report", input.applicationId, { outcome: input.outcome, runId: result.run.id });
    return result;
  });

  // Questions only the operator can answer; the answer becomes memory and the agent resumes the same posting.
  app.post(route("applications/:id/question"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const params = parseQuery(applicationParamsSchema, request.params);
    const input = parseBody(jobApplyQuestionAskSchema, request.body ?? {});
    const result = await service.askQuestion(await owner(bridge.claims), params.id, input, { paneId: bridge.claims.paneId });
    await deps.audit(request, "job_apply.agent.question", params.id, { answered: result.answered });
    return result;
  });

  app.post(route("applications/:id/question/wait"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const params = parseQuery(applicationParamsSchema, request.params);
    const input = parseBody(jobApplyQuestionWaitSchema, request.body ?? {});
    return service.waitForAnswer(await owner(bridge.claims), params.id, input);
  });

  app.post(route("applications/:id/review"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const params = parseQuery(applicationParamsSchema, request.params);
    const input = parseBody(jobApplyReviewRequestSchema, request.body ?? {});
    const result = await service.requestReview(await owner(bridge.claims), params.id, input, { paneId: bridge.claims.paneId });
    await deps.audit(request, "job_apply.agent.review_request", params.id, { fields: input.fields.length });
    return result;
  });

  app.post(route("applications/:id/review/wait"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const params = parseQuery(applicationParamsSchema, request.params);
    const input = parseBody(jobApplyReviewWaitSchema, request.body ?? {});
    return service.waitForReview(await owner(bridge.claims), params.id, input);
  });

  app.get(route("applications"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const query = parseQuery(jobApplicationListQuerySchema, request.query ?? {});
    return { applications: await service.listApplications(await owner(bridge.claims), query) };
  });

  app.post(route("applications"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(jobApplicationCreateSchema, request.body ?? {});
    // A Job Copilot pane's own agent queues for that pane. An agent working from another CLI pane
    // (the pane queue lists rows without a pane too) queues for every Job Copilot pane of the owner.
    const bridgePane = await deps.store.getPane(bridge.claims.paneId);
    const paneId = input.paneId ?? (bridgePane?.mode === "JOB_APPLY" ? bridge.claims.paneId : null);
    const result = await service.createApplication(await owner(bridge.claims), { ...input, paneId }, { paneId: bridge.claims.paneId });
    if (result.created) await deps.audit(request, "job_apply.agent.application_start", result.application.id, { ats: input.ats });
    return result;
  });

  app.patch(route("applications/:id"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const params = parseQuery(applicationParamsSchema, request.params);
    const input = parseBody(jobApplicationUpdateSchema, request.body ?? {});
    const application = await service.updateApplication(await owner(bridge.claims), params.id, input, { paneId: bridge.claims.paneId });
    await deps.audit(request, "job_apply.agent.application_update", application.id, { status: application.status });
    return { application };
  });

  // Field storage: every filled control per step (idempotent per step+label); SUBMITTED needs it.
  app.get(route("applications/:id/fields"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const params = parseQuery(applicationParamsSchema, request.params);
    return { fields: await service.listFields(await owner(bridge.claims), params.id) };
  });

  app.post(route("applications/:id/fields"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const params = parseQuery(applicationParamsSchema, request.params);
    const input = parseBody(jobApplicationFieldsRecordSchema, request.body ?? {});
    const fields = await service.recordFields(await owner(bridge.claims), params.id, input.fields, { paneId: bridge.claims.paneId });
    await deps.audit(request, "job_apply.agent.fields_record", params.id, { count: fields.length });
    return { recorded: fields.length, fields };
  });

  app.get(route("pacing"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const query = parseQuery(pacingQuerySchema, request.query ?? {});
    const settings = await paneSettings(bridge.claims.paneId);
    return service.pacing(await owner(bridge.claims), query.site, settings, query.company);
  });

  app.post(route("mail/wait-code"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(waitCodeSchema, request.body ?? {});
    const result = await service.waitForCode(await owner(bridge.claims), input);
    await deps.audit(request, "job_apply.agent.mail_wait_code", bridge.claims.paneId, { found: result !== null, fromContains: input.fromContains ?? null });
    return result ?? { code: null };
  });

  app.post(route("mail/find-link"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(findLinkSchema, request.body ?? {});
    const result = await service.findLink(await owner(bridge.claims), input);
    await deps.audit(request, "job_apply.agent.mail_find_link", bridge.claims.paneId, { found: result !== null, urlContains: input.urlContains ?? null });
    return result ?? { link: null };
  });

  app.get(route("mail/recent"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const query = parseQuery(recentQuerySchema, request.query ?? {});
    return { messages: await service.recentMail(await owner(bridge.claims), query) };
  });

  // Gmail and Calendar of the copilot's Google account (Setup → Google account). Content is third-party data;
  // mail is only drafted (the operator sends it from Gmail) and events invite nobody.
  app.post(route("mail/search"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(mailSearchSchema, request.body ?? {});
    return service.googleTool(await owner(bridge.claims), "mail.search", input);
  });

  app.post(route("mail/read"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(mailReadSchema, request.body ?? {});
    return service.googleTool(await owner(bridge.claims), "mail.read", input);
  });

  app.post(route("mail/draft"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(mailDraftSchema, request.body ?? {});
    const result = await service.googleTool(await owner(bridge.claims), "mail.draft", input);
    await deps.audit(request, "job_apply.agent.mail_draft", bridge.claims.paneId, { recipients: input.to.length });
    return result;
  });

  // Mail triage: file application emails under the Job Applications labels (never deletes). A pass also runs
  // on the server every 15 minutes; the copilot can trigger one and file what the rules missed.
  app.post(route("mail/organize"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(jobApplyMailOrganizeSchema, request.body ?? {});
    const result = await service.organizeMail(await owner(bridge.claims), input, { paneId: bridge.claims.paneId });
    await deps.audit(request, "job_apply.agent.mail_organize", bridge.claims.paneId, { category: result.category, count: result.organized, archived: result.archived });
    return result;
  });

  app.post(route("mail/triage"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    parseBody(z.object({}).strict(), request.body ?? {});
    const result = await service.triageMail(await owner(bridge.claims), { paneId: bridge.claims.paneId });
    await deps.audit(request, "job_apply.agent.mail_triage", bridge.claims.paneId, { ...result, accounts: result.accounts.length });
    return result;
  });

  app.post(route("calendar/list"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(calendarListSchema, request.body ?? {});
    return service.googleTool(await owner(bridge.claims), "calendar.list", input);
  });

  app.post(route("calendar/create"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const input = parseBody(calendarCreateSchema, request.body ?? {});
    if (Date.parse(input.end) <= Date.parse(input.start)) throw new SpaceConflictError("The event must end after it starts.");
    const result = await service.googleTool(await owner(bridge.claims), "calendar.create", input);
    await deps.audit(request, "job_apply.agent.calendar_create", bridge.claims.paneId, {});
    return result;
  });

  // Handoff state of the pane browser: the agent waits here while an operator solves a CAPTCHA or signs in.
  app.get(route("handoff/status"), routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return undefined;
    const query = parseQuery(paneQuerySchema, request.query ?? {});
    const paneId = query.paneId ?? bridge.claims.paneId;
    const pane = await deps.store.getPane(paneId);
    if (pane.roomId !== bridge.claims.roomId) throw new SpaceConflictError("Browser pane is not in this room.");
    const session = await deps.store.getActivePaneBrowserSession(pane.id);
    if (!session) return { paneId, browserRunning: false, held: false, lease: null, handoff: null };
    await settleEndedOperatorLease(deps.store, session.sessionId);
    const [lease, handoff] = await Promise.all([
      deps.store.getActiveBrowserControlLease(session.sessionId),
      deps.store.getActiveBrowserHandoffRequest(session.sessionId)
    ]);
    return {
      paneId,
      browserRunning: true,
      held: lease !== null,
      lease: lease ? { leaseId: lease.leaseId, holderType: lease.holderType, expiresAt: lease.expiresAt } : null,
      handoff: handoff ? { handoffRequestId: handoff.handoffRequestId, status: handoff.status, reason: handoff.reason } : null
    };
  });
}
