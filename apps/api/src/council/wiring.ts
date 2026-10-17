import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import { councilModelIdSchema, jobApplyCandidateSchema, listMemoryQuerySchema, planStepSchema, type AuthUser, type ClipboardItem, type UpsertClipboardItemInput, type CouncilModel, type CouncilRun } from "@space/contracts";
import { InMemoryCouncilRepository, PostgresCouncilRepository, PostgresSpaceStore, type CouncilRepository, type JobApplyRepository } from "@space/db";
import type { CanonicalMemoryBridge } from "@space/runtime";
import { JEV_MODEL_ID, ProviderFailure, providerForModel, providerNoticeKind, requestModelText, runWithProviderSlot } from "../asteroids-arena/providers.js";
import { cookieName, verifySession } from "../auth.js";
import { loadArenaModelCatalog } from "../benchmark-routes.js";
import { createWorkerCliMoveRunner, type CliMoveRunner } from "../chess/chess-cli.js";
import { pickClaudeProfile } from "../chess/chess-players.js";
import type { JobApplyService } from "../job-apply/service.js";
import type { NotificationService } from "../notifications/service.js";
import { buildCouncilPersonalData, type CouncilPersonalSources } from "./personal-data.js";
import { clip } from "./ranking.js";
import { registerCouncilRoutes } from "./routes.js";
import { createCouncilService } from "./service.js";
import { searchWebThroughGateway } from "./web-search.js";

const COUNCIL_PROVIDERS = new Set(["codex", "claude", "antigravity", "opencode", "openrouter"]);
// shortcut: the gateway's /v1/models follows whichever account answers and sometimes omits the GPT-6 models every
// account runs (2026-10-14); drop this list once the listing is stable.
const KNOWN_GATEWAY_MODELS = [
  { id: "codex/gpt-6-astra", displayName: "GPT-6 Astra" }, { id: "codex/gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
  { id: "codex/gpt-6-sol", displayName: "GPT-6 Sol" }, { id: "codex/gpt-6-luna", displayName: "GPT-6 Luna" }
];
const CALL_TIMEOUT_MS = 180_000;

export interface CouncilWiringOptions {
  config: { databaseUrl?: string | null; instance: string };
  auth: { sessionSecret: string };
  store: { upsertUser(user: AuthUser): Promise<AuthUser> | AuthUser; upsertClipboardItem(input: UpsertClipboardItemInput): Promise<ClipboardItem> | ClipboardItem };
  routeOptions: Record<string, unknown>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  claudeUsageProvider(): Promise<{ data: Parameters<typeof pickClaudeProfile>[0] }>;
  jobApplyRepository: Pick<JobApplyRepository, "getProfile">;
  jobApplyService: Pick<JobApplyService, "listMemory">;
  livePersonalMemory: { read(owner: string): Promise<{ items: Array<{ key: string; value: string; category?: string }> }> };
  canonicalMemory: CanonicalMemoryBridge;
  notifications?: Pick<NotificationService, "raise" | "resolve">;
  repository?: CouncilRepository;
  runCliMove?: CliMoveRunner;
}

/** The signed-in ADMIN or OPERATOR: a council reads their CV and spends their model quota. */
async function councilOwner(options: CouncilWiringOptions, request: FastifyRequest): Promise<string> {
  if (!request.user || !verifySession(request.cookies[cookieName], options.auth.sessionSecret)) {
    throw Object.assign(new Error("Sign in to use the Council."), { statusCode: 401 });
  }
  if (request.user.role !== "ADMIN" && request.user.role !== "OPERATOR") {
    throw Object.assign(new Error("The Council is available to administrators and operators."), { statusCode: 403 });
  }
  return (await options.store.upsertUser(request.user)).id;
}

/** Read-only views of the owner's CV, profile and memory; none of them counts as a use or creates a record. */
function personalSources(options: CouncilWiringOptions): CouncilPersonalSources {
  return {
    candidate: async (owner) => {
      const record = await options.jobApplyRepository.getProfile(owner);
      const parsed = record ? jobApplyCandidateSchema.safeParse(record.candidate) : null;
      return parsed?.success ? parsed.data : null;
    },
    cvText: async (owner) => (await options.jobApplyRepository.getProfile(owner))?.cvText ?? null,
    personalMemory: async (owner) => (await options.livePersonalMemory.read(owner)).items,
    jobMemory: async (owner, query) =>
      (await options.jobApplyService.listMemory(owner, { query: query ?? undefined, kinds: ["FACT", "PREFERENCE"], limit: 15 })).map((memory) => memory.text),
    spaceMemory: async (query) => (await options.canonicalMemory.list(listMemoryQuerySchema.parse({ q: query.slice(0, 200), pageSize: 4 })))
      .slice(0, 4).map((entry) => ({ title: entry.title, body: entry.body }))
  };
}

/** A short provider notice ("usage limit reached", "log in required") is a failure, not the model's answer. */
function answerText(text: string): string {
  const trimmed = text.trim();
  const notice = trimmed.length < 300 ? providerNoticeKind(trimmed) : null;
  if (notice) throw new ProviderFailure(notice, clip(trimmed, 160));
  return trimmed;
}

const NEEDS_YOU: Partial<Record<CouncilRun["status"], string>> = {
  NEEDS_INPUT: "The council needs your answers", AWAITING_APPROVAL: "The council's plan waits for your approval", FAILED: "The council run failed"
};

/** What needs the operator stays open until the run moves on; a finished run is news with its Top 3. */
export async function notifyCouncilStatus(notifications: Pick<NotificationService, "raise" | "resolve">, owner: string, id: string, run: CouncilRun | null): Promise<void> {
  const dedupeKey = `council:${id}`;
  // Raising an open key only refreshes it, so the previous state is resolved first and the next one pops up again.
  await notifications.resolve(owner, dedupeKey);
  if (!run) return;
  const base = { ownerUserId: owner, roomId: null, paneId: null, source: "COUNCIL" as const, kind: run.status, link: { surface: "shared-chat" }, payload: { runId: id }, telegram: null };
  const title = NEEDS_YOU[run.status];
  if (title) {
    await notifications.raise({ ...base, severity: "ATTENTION", title, body: clip(run.status === "FAILED" && run.error ? `${run.question}\n${run.error}` : run.question, 2_000), dedupeKey });
  } else if (run.status === "COMPLETED") {
    const top = (run.final?.top ?? []).map((entry, index) => `${index + 1}. ${entry.title}`);
    await notifications.raise({ ...base, severity: "INFO", title: "The council finished", body: clip([run.question, ...top].join("\n"), 2_000), dedupeKey: null });
  }
}

/** Builds the Research Council and registers its routes; work runs in this process and stops with it. */
export function registerCouncil(app: FastifyInstance, options: CouncilWiringOptions): void {
  const databaseUrl = options.store instanceof PostgresSpaceStore && options.config.databaseUrl ? options.config.databaseUrl : null;
  const repository = options.repository ?? (databaseUrl ? PostgresCouncilRepository.fromConnectionString(databaseUrl) : new InMemoryCouncilRepository());
  // Claude and Gemini run as CLI turns in stable's worker; the dev instance must never use stable's worker socket.
  const cliModels = options.config.instance === "stable";
  const runCliMove = options.runCliMove ?? createWorkerCliMoveRunner();
  const sources = personalSources(options);
  const service = createCouncilService({
    repository,
    coordinatorDefault: "claude/claude-opus-5-5",
    webSearchAvailable: true,
    async catalog(): Promise<CouncilModel[]> {
      const listed = (await loadArenaModelCatalog()).models
        .map((model) => ({ ...model, displayName: KNOWN_GATEWAY_MODELS.find((known) => known.id === model.id)?.displayName ?? model.displayName }));
      const models = [...KNOWN_GATEWAY_MODELS.filter((known) => !listed.some((model) => model.id === known.id)).map((known) => ({ ...known, providerId: "codex", status: "VERIFIED" })), ...listed];
      return models.filter((model) => COUNCIL_PROVIDERS.has(model.providerId) && model.id !== JEV_MODEL_ID && councilModelIdSchema.safeParse(model.id).success)
        .map((model) => {
          const cli = model.providerId === "claude" || model.providerId === "antigravity";
          return { id: model.id, displayName: clip(model.displayName, 200), providerId: model.providerId, available: !cli || cliModels,
            note: cli && !cliModels ? "Runs only on the stable instance." : null };
        });
    },
    async callModel({ modelId, prompt, role, signal }) {
      const provider = providerForModel(modelId);
      if (provider === "claude" || provider === "antigravity") {
        if (!cliModels) throw new ProviderFailure("error", "Claude and Gemini models run only on the stable instance.");
        const claudeProfile = provider === "claude" ? await options.claudeUsageProvider().then((usage) => pickClaudeProfile(usage.data)).catch(() => null) : null;
        return answerText(await runWithProviderSlot(provider, () => runCliMove({
          runtimeId: provider === "claude" ? "cli:claude" : "cli:gemini",
          model: modelId.slice(modelId.indexOf("/") + 1),
          effort: provider === "claude" ? "medium" : null,
          claudeProfile,
          prompt,
          signal
        }), signal));
      }
      const reply = await requestModelText({
        modelId, system: "Follow the instructions in the user message exactly.", user: prompt,
        signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
        maxTokens: role === "coordinator" ? 8_000 : 6_000, reasoningEffort: "medium", timeoutMs: CALL_TIMEOUT_MS
      });
      return answerText(reply.text);
    },
    searchWeb: searchWebThroughGateway,
    personalData: (owner, question, memoryQueries) => buildCouncilPersonalData(sources, owner, question, memoryQueries),
    async savePlan(owner, plan) {
      const item = await options.store.upsertClipboardItem({
        ownerUserId: owner, source: "PLAN", text: plan.text, title: plan.title, minimumModel: plan.minimumModel, paneTitle: "Council",
        ...(plan.minimumReasoning ? { minimumReasoning: plan.minimumReasoning } : {}),
        steps: plan.steps.map((step, index) => planStepSchema.parse({ id: `step-${index + 1}`, order: index + 1, title: step.title,
          ...(step.instructions ? { instructions: step.instructions } : {}), ...(step.completionCriteria.length ? { completionCriteria: step.completionCriteria } : {}) }))
      });
      return { id: item.id };
    },
    onStatus: options.notifications ? (owner, id, run) => notifyCouncilStatus(options.notifications!, owner, id, run) : undefined,
    log: { warn: (meta, message) => app.log.warn(meta, message) }
  });

  app.addHook("onReady", async () => {
    try {
      const interrupted = await service.interruptStale();
      if (interrupted > 0) app.log.info({ interrupted }, "Council runs interrupted by the restart were closed.");
    } catch (error) {
      app.log.warn({ err: error }, "Council recovery failed.");
    }
  });
  app.addHook("onClose", async () => {
    await service.abortAll();
    await repository.dispose();
  });

  registerCouncilRoutes(app, service, { routeOptions: options.routeOptions, owner: (request) => councilOwner(options, request), parseBody: options.parseBody, parseQuery: options.parseQuery });
}
