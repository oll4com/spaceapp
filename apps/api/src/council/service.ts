import {
  COUNCIL_ANSWER_MAX_CHARS, COUNCIL_CLAIM_MAX_CHARS, COUNCIL_MAX_CLAIMS, COUNCIL_MAX_EVIDENCE, COUNCIL_MAX_MEMBERS, COUNCIL_MAX_POSITIONS,
  COUNCIL_MAX_QUESTION_ROUNDS, COUNCIL_MAX_REVIEW_ROUNDS, COUNCIL_MAX_SEARCHES, COUNCIL_MAX_TOTAL_ROUNDS, COUNCIL_PERSONAL_CONTEXT_MAX_CHARS, COUNCIL_TOP,
  councilPlanSchema, councilVerdictSchema,
  type CouncilAnswer, type CouncilApproveInput, type CouncilEvidence, type CouncilModel, type CouncilPlan, type CouncilPosition, type CouncilReview,
  type CouncilRound, type CouncilRun, type CouncilRunSummary, type CreateCouncilRunInput
} from "@space/contracts";
import { CouncilActiveRunError, newCouncilRunId, type CouncilRepository } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import { extractJsonObject } from "../asteroids-arena/protocol.js";
import { buildAnswerPrompt, buildClipboardPlanPrompt, buildFinalPrompt, buildMergePrompt, buildPlanPrompt, buildReviewPrompt } from "./prompts.js";
import { anonymizeModelText, clip, councilAgreementReached, councilTopEntries, deriveClaims, rankCouncilPositions, scrubContactDetails, shuffled } from "./ranking.js";

/** A run gives up after this long, whatever stage it reached. */
const RUN_DEADLINE_MS = 30 * 60_000;
/** Models the plan falls back to, in this order, when the coordinator names too few available ones. */
const PREFERRED_MEMBERS = ["codex/gpt-6-astra", "claude/claude-opus-5-5", "claude/claude-fable-5-1", "antigravity/gemini-3.8-flash-medium", "codex/gpt-6.1-sol", "codex/gpt-5.6-sol"];

export interface CouncilServiceDeps {
  repository: CouncilRepository;
  /** Every model with its availability on this instance. */
  catalog(): Promise<CouncilModel[]>;
  /** Text from one model; the dependency enforces the per-call timeout and the provider's concurrency. */
  callModel(input: { modelId: string; prompt: string; role: "coordinator" | "member"; signal: AbortSignal }): Promise<string>;
  searchWeb(query: string, question: string, signal: AbortSignal): Promise<CouncilEvidence[]>;
  webSearchAvailable: boolean;
  /** The operator's CV, profile and memory as one text block for the coordinator (extra keyword searches optional). */
  personalData(owner: string, question: string, memoryQueries: readonly string[]): Promise<string>;
  /** Saves the coordinator's plan as a PLAN record in the owner's clipboard. */
  savePlan(owner: string, plan: CouncilClipboardPlanDraft & { text: string }): Promise<{ id: string }>;
  coordinatorDefault: string;
  /** Told of each new status of a run (null once it is deleted), one after another; notifications hang off it. */
  onStatus?(owner: string, id: string, run: CouncilRun | null): Promise<void>;
  now?: () => Date;
  random?: () => number;
  log?: { warn(meta: object, message: string): void };
}

export type CouncilService = ReturnType<typeof createCouncilService>;

class StopRequested extends Error {}

const errorText = (error: unknown) => clip(error instanceof Error ? error.message : String(error), 280);

/** Models often put raw line breaks and tabs inside JSON strings; escaping them keeps an otherwise valid reply. */
export function escapeControlCharactersInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of json) {
    if (inString && !escaped && (char === "\n" || char === "\r" || char === "\t")) {
      out += char === "\n" ? "\\n" : char === "\r" ? "\\r" : "\\t";
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    out += char;
  }
  return out;
}

/** Parses the first JSON object of a reply; null when there is none or it does not parse. */
export function jsonReply(text: string): Record<string, unknown> | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  for (const candidate of [json, escapeControlCharactersInStrings(json)]) {
    try {
      const value = JSON.parse(candidate) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
      // Try the repaired text next.
    }
  }
  return null;
}

const strings = (value: unknown, max: number, chars: number): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, max).map((item) => clip(item.trim(), chars)) : [];

export function estimateCouncil(plan: CouncilPlan): { calls: number; minutes: number } {
  const members = plan.members.length;
  const calls = plan.searchQueries.length + members + plan.reviewRounds * (members + 1) + (plan.reviewRounds - 1) + 1;
  const minutes = Math.ceil((plan.searchQueries.length ? 1.5 : 0) + 1.5 + plan.reviewRounds * 2 + 1);
  return { calls, minutes };
}

/** Turns the coordinator's raw plan into a valid one: only available models, bounded lists, scrubbed personal context. */
export function normalizeCouncilPlan(raw: Record<string, unknown>, available: readonly CouncilModel[], webSearch: boolean): CouncilPlan {
  const availableIds = new Set(available.filter((model) => model.available).map((model) => model.id));
  const members: CouncilPlan["members"] = [];
  for (const entry of Array.isArray(raw.members) ? raw.members : []) {
    const modelId = typeof (entry as { modelId?: unknown })?.modelId === "string" ? (entry as { modelId: string }).modelId.trim() : "";
    if (!availableIds.has(modelId) || members.some((member) => member.modelId === modelId)) continue;
    members.push({ modelId, reason: clip(String((entry as { reason?: unknown }).reason ?? "").trim(), 300) });
  }
  for (const modelId of [...PREFERRED_MEMBERS, ...availableIds]) {
    if (members.length >= 3) break;
    if (availableIds.has(modelId) && !members.some((member) => member.modelId === modelId)) members.push({ modelId, reason: "Added so the council has enough voices." });
  }
  const criteria = (Array.isArray(raw.criteria) ? raw.criteria : []).flatMap((entry, index) => {
    const label = clip(String((entry as { label?: unknown })?.label ?? "").trim(), 80);
    const id = String((entry as { id?: unknown })?.id ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").replace(/^[^a-z]+/, "").slice(0, 31) || `criterion${index + 1}`;
    return label ? [{ id, label }] : [];
  }).slice(0, 6);
  const rounds = Number(raw.reviewRounds);
  const target = Number(raw.agreementTarget);
  return councilPlanSchema.parse({
    understanding: clip(String(raw.understanding ?? "").trim(), 1_500) || "Answer the operator's question.",
    personalContext: clip(scrubContactDetails(String(raw.personalContext ?? "").trim()), COUNCIL_PERSONAL_CONTEXT_MAX_CHARS),
    members: members.slice(0, COUNCIL_MAX_MEMBERS),
    reviewRounds: Number.isInteger(rounds) ? Math.min(COUNCIL_MAX_REVIEW_ROUNDS, Math.max(1, rounds)) : 1,
    agreementTarget: Number.isFinite(target) ? Math.min(1, Math.max(0.5, target)) : 0.67,
    criteria: criteria.length ? criteria : [{ id: "accuracy", label: "Accurate and realistic" }, { id: "usefulness", label: "Useful for the operator" }],
    searchQueries: webSearch ? strings(raw.searchQueries, Math.min(4, COUNCIL_MAX_SEARCHES), 200).filter((query) => query.length >= 3) : []
  });
}

/** A member's answer: the JSON shape when it complied, otherwise its text with claims taken from it. */
export function parseCouncilAnswer(text: string): { text: string; claims: string[] } | null {
  const json = jsonReply(text);
  const answer = typeof json?.answer === "string" ? json.answer.trim() : "";
  if (answer) {
    const claims = strings(json?.claims, COUNCIL_MAX_CLAIMS, COUNCIL_CLAIM_MAX_CHARS);
    return { text: clip(answer, COUNCIL_ANSWER_MAX_CHARS), claims: claims.length ? claims : deriveClaims(answer) };
  }
  // Broken JSON (quotes inside the text not escaped): take the answer between its key and the claims.
  // The broken claims array cannot be trusted either, so the claims come from the answer itself.
  const loose = /"answer"\s*:\s*"([\s\S]+?)"\s*,\s*"claims"\s*:/.exec(text);
  if (loose?.[1]) {
    const answerText = loose[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
    return { text: clip(answerText, COUNCIL_ANSWER_MAX_CHARS), claims: deriveClaims(answerText) };
  }
  const plain = text.trim();
  return plain.length >= 40 && !plain.startsWith("{") ? { text: clip(plain, COUNCIL_ANSWER_MAX_CHARS), claims: deriveClaims(plain) } : null;
}

export function parseCouncilMerge(text: string): { merged: string; positions: CouncilPosition[] } | null {
  const json = jsonReply(text);
  if (!json || typeof json.merged !== "string" || !Array.isArray(json.positions)) return null;
  const positions = json.positions.flatMap((raw) => {
    const entry = raw as Record<string, unknown>;
    const title = clip(anonymizeModelText(String(entry.title ?? "").trim()), 160);
    return title ? [{ title, summary: clip(anonymizeModelText(String(entry.summary ?? "").trim()), 600), support: Math.max(0, Math.round(Number(entry.support) || 0)), id: String(entry.id ?? "") }] : [];
  }).slice(0, COUNCIL_MAX_POSITIONS);
  if (!positions.length) return null;
  // Keep the coordinator's ids when they are valid and unique (revisions keep them); renumber otherwise.
  const ids = positions.map((position) => position.id);
  const keep = ids.every((id) => /^P[0-9]{1,2}$/.test(id)) && new Set(ids).size === ids.length;
  return {
    merged: clip(anonymizeModelText(json.merged.trim()), 8_000),
    positions: positions.map((position, index) => ({ ...position, id: keep ? position.id : `P${index + 1}` }))
  };
}

export function parseCouncilReview(text: string, positions: readonly CouncilPosition[]): Pick<CouncilReview, "scores" | "corrections" | "missing"> | null {
  const json = jsonReply(text);
  if (!json || !Array.isArray(json.scores)) return null;
  const known = new Set(positions.map((position) => position.id));
  const seen = new Set<string>();
  const scores = json.scores.flatMap((raw) => {
    const entry = raw as Record<string, unknown>;
    const positionId = String(entry.positionId ?? "");
    const score = Math.round(Number(entry.score));
    if (!known.has(positionId) || seen.has(positionId) || !Number.isFinite(score)) return [];
    seen.add(positionId);
    const verdict = councilVerdictSchema.safeParse(String(entry.verdict ?? "").toLowerCase());
    const bounded = Math.min(10, Math.max(1, score));
    return [{ positionId, score: bounded, verdict: verdict.success ? verdict.data : bounded >= 7 ? "agree" as const : bounded >= 4 ? "partly" as const : "disagree" as const,
      issue: clip(String(entry.issue ?? "").trim(), 300) }];
  });
  if (!scores.length) return null;
  return { scores, corrections: strings(json.corrections, 5, 300), missing: strings(json.missing, 5, 300) };
}

export interface CouncilClipboardPlanDraft {
  title: string;
  summary: string;
  minimumModel: string;
  minimumReasoning: "low" | "medium" | "high" | null;
  steps: Array<{ title: string; instructions: string; completionCriteria: string[] }>;
}

/** The coordinator's plan for the clipboard; null without a title or a single step. */
export function parseCouncilClipboardPlan(text: string): CouncilClipboardPlanDraft | null {
  const json = jsonReply(text);
  const title = clip(String(json?.title ?? "").trim(), 120);
  const steps = (Array.isArray(json?.steps) ? json.steps : []).flatMap((raw) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const stepTitle = clip(String(entry.title ?? "").trim(), 120);
    return stepTitle ? [{ title: stepTitle, instructions: clip(String(entry.instructions ?? "").trim(), 1_500), completionCriteria: strings(entry.completionCriteria, 5, 300) }] : [];
  }).slice(0, 12);
  if (!title || !steps.length) return null;
  const reasoning = String(json?.minimumReasoning ?? "").toLowerCase();
  return { title, summary: clip(String(json?.summary ?? "").trim(), 1_000), minimumModel: clip(String(json?.minimumModel ?? "").trim(), 80),
    minimumReasoning: reasoning === "low" || reasoning === "medium" || reasoning === "high" ? reasoning : null, steps };
}

/** The PLAN record's text: the plan, then where it came from, so the clipboard links back to the run. */
export function councilClipboardPlanText(run: Pick<CouncilRun, "id" | "question">, draft: CouncilClipboardPlanDraft, coordinator: string): string {
  const steps = draft.steps.map((step, index) => [`${index + 1}. **${step.title}**`, step.instructions ? `   ${step.instructions.replace(/\n/g, "\n   ")}` : "",
    step.completionCriteria.length ? `   Done when: ${step.completionCriteria.join("; ")}` : ""].filter(Boolean).join("\n"));
  return [`# ${draft.title}`, draft.summary, `Source: Research Council run ${run.id}, coordinated by ${coordinator}.\nQuestion: ${run.question}`, `## Steps\n${steps.join("\n")}`]
    .filter(Boolean).join("\n\n");
}

export function createCouncilService(deps: CouncilServiceDeps) {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const random = deps.random ?? Math.random;
  const running = new Map<string, { controller: AbortController; stop: "STOPPED" | "CANCELLED" | null; done: Promise<void> }>();
  let catalogCache: { at: number; models: CouncilModel[] } | null = null;

  async function catalog(): Promise<CouncilModel[]> {
    if (catalogCache && Date.now() - catalogCache.at < 5 * 60_000) return catalogCache.models;
    const models = await deps.catalog();
    catalogCache = { at: Date.now(), models };
    return models;
  }
  const displayName = (models: readonly CouncilModel[], modelId: string) => models.find((model) => model.id === modelId)?.displayName ?? modelId;

  // Queued, so a resolve for one status never overtakes the raise for the next.
  const lastStatus = new Map<string, CouncilRun["status"]>();
  let statusQueue: Promise<unknown> = Promise.resolve();
  function statusChanged(owner: string, id: string, run: CouncilRun | null) {
    if (!deps.onStatus) return;
    statusQueue = statusQueue.then(() => deps.onStatus!(owner, id, run))
      .catch((error: unknown) => deps.log?.warn({ err: error, runId: id }, "Council status hook failed."));
  }
  async function save(run: CouncilRun): Promise<CouncilRun> {
    const saved = await deps.repository.save(run);
    if (lastStatus.get(saved.id) !== saved.status) {
      lastStatus.set(saved.id, saved.status);
      statusChanged(saved.ownerUserId, saved.id, saved);
    }
    return saved;
  }

  /** The only writer of a run: every change is applied to the latest copy and saved in order. */
  function writer(initial: CouncilRun) {
    let current = initial;
    let queue: Promise<unknown> = Promise.resolve();
    return {
      get current() { return current; },
      update(change: (run: CouncilRun) => CouncilRun, event?: string): Promise<CouncilRun> {
        const next = queue.then(async () => {
          let updated = change(current);
          if (event) updated = { ...updated, events: [...updated.events, { at: now(), text: clip(event, 300) }].slice(-200) };
          current = await save({ ...updated, updatedAt: now() });
          return current;
        });
        queue = next.catch(() => undefined);
        return next;
      }
    };
  }
  type Writer = ReturnType<typeof writer>;

  async function load(owner: string, id: string): Promise<CouncilRun> {
    const run = await deps.repository.get(owner, id);
    if (!run) throw new SpaceNotFoundError(`Council run ${id} was not found.`);
    return run;
  }

  function assertStatus(run: CouncilRun, allowed: readonly CouncilRun["status"][], action: string) {
    if (!allowed.includes(run.status)) throw new SpaceConflictError(`This Council run is ${run.status.toLowerCase().replace(/_/g, " ")}; it cannot ${action} now.`);
  }

  /** Runs one background job for a run; stop and cancel abort it, and a crash leaves the run FAILED with the reason. */
  function launch(run: CouncilRun, job: (w: Writer, signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(RUN_DEADLINE_MS)]);
    const w = writer(run);
    const entry = { controller, stop: null as "STOPPED" | "CANCELLED" | null, done: Promise.resolve() };
    running.set(run.id, entry);
    entry.done = (async () => {
      try {
        await job(w, signal);
      } catch (error) {
        const stopped = entry.stop;
        const timedOut = !stopped && signal.aborted;
        await w.update((current) => ({
          ...current,
          status: stopped === "CANCELLED" ? "CANCELLED" : stopped === "STOPPED" ? "INTERRUPTED" : "FAILED",
          error: stopped === "CANCELLED" ? "Cancelled." : stopped === "STOPPED" ? "Stopped by you. Resume continues where it stopped." : timedOut ? "The run passed its 30-minute limit." : errorText(error)
        }), stopped ? "Stopped." : timedOut ? "Time limit reached." : `Failed: ${errorText(error)}`).catch((saveError: unknown) => deps.log?.warn({ err: saveError, runId: run.id }, "Council run state could not be saved."));
      } finally {
        running.delete(run.id);
      }
    })();
  }

  function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) throw new StopRequested("The run was stopped.");
  }

  async function plan(w: Writer, signal: AbortSignal): Promise<void> {
    const models = await catalog();
    const run = w.current;
    const questionsAllowed = run.qa.length < COUNCIL_MAX_QUESTION_ROUNDS;
    let personalData = await deps.personalData(run.ownerUserId, run.question, []);
    let memoryQueriesAllowed = true;
    let malformed = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      throwIfAborted(signal);
      const prompt = buildPlanPrompt({ question: run.question, qa: w.current.qa, questionsAllowed, models, webSearch: deps.webSearchAvailable, personalData,
        previousPlan: w.current.plan, changeRequests: w.current.changeRequests, memoryQueriesAllowed });
      const reply = await deps.callModel({ modelId: run.coordinatorModelId, prompt, role: "coordinator", signal });
      const json = jsonReply(reply);
      const questions = strings(json?.questions, 4, 400);
      if (questionsAllowed && questions.length && !json?.plan) {
        await w.update((current) => ({ ...current, status: "NEEDS_INPUT", stage: "PLAN",
          qa: [...current.qa, { questions: questions.map((text, index) => ({ id: `q${index + 1}`, text })), answers: {} }] }), "The coordinator has questions for you.");
        return;
      }
      const rawPlan = json?.plan && typeof json.plan === "object" ? json.plan as Record<string, unknown> : null;
      if (!rawPlan) {
        malformed += 1;
        if (malformed >= 2) throw new Error("The coordinator did not return a usable plan.");
        continue;
      }
      const memoryQueries = strings(json?.memoryQueries, 3, 120);
      if (memoryQueries.length && memoryQueriesAllowed) {
        memoryQueriesAllowed = false;
        await w.update((current) => current, `The coordinator searched your memory: ${memoryQueries.join(", ")}.`);
        personalData = await deps.personalData(run.ownerUserId, run.question, memoryQueries);
        continue;
      }
      const normalized = normalizeCouncilPlan(rawPlan, models, deps.webSearchAvailable);
      await w.update((current) => ({ ...current, status: "AWAITING_APPROVAL", stage: "PLAN", plan: normalized, estimate: estimateCouncil(normalized), error: null }),
        "The plan is ready for your approval.");
      return;
    }
    throw new Error("The coordinator did not finish the plan.");
  }

  async function research(w: Writer, signal: AbortSignal): Promise<void> {
    const queries = w.current.plan?.searchQueries ?? [];
    if (queries.length) {
      await w.update((current) => current, `Searching the web (${queries.length} ${queries.length === 1 ? "search" : "searches"}).`);
      const results = await Promise.allSettled(queries.map((query) => deps.searchWeb(query, w.current.question, signal)));
      throwIfAborted(signal);
      const found: CouncilEvidence[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") for (const item of result.value) if (!found.some((other) => other.url === item.url)) found.push(item);
      }
      const failed = results.filter((result) => result.status === "rejected").length;
      await w.update((current) => ({ ...current, evidence: found.slice(0, COUNCIL_MAX_EVIDENCE) }),
        `Web search found ${found.length} ${found.length === 1 ? "source" : "sources"}${failed ? `; ${failed} ${failed === 1 ? "search" : "searches"} failed` : ""}.`);
    }
    await w.update((current) => ({ ...current, stage: "ANSWERS" }));
  }

  async function answers(w: Writer, signal: AbortSignal, models: readonly CouncilModel[]): Promise<void> {
    const plan = w.current.plan!;
    await w.update((current) => ({
      ...current,
      answers: plan.members.map((member) => current.answers.find((answer) => answer.modelId === member.modelId && answer.status === "DONE")
        ?? { modelId: member.modelId, status: "PENDING", text: "", claims: [], error: null, ms: null })
    }), "Every model answers independently.");
    const prompt = buildAnswerPrompt({ question: w.current.question, plan, evidence: w.current.evidence });
    await Promise.all(w.current.answers.filter((answer) => answer.status !== "DONE").map(async ({ modelId }) => {
      const started = Date.now();
      let result: CouncilAnswer;
      try {
        let parsed: ReturnType<typeof parseCouncilAnswer> = null;
        for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) parsed = parseCouncilAnswer(await deps.callModel({ modelId, prompt, role: "member", signal }));
        result = parsed ? { modelId, status: "DONE", text: parsed.text, claims: parsed.claims, error: null, ms: Date.now() - started }
          : { modelId, status: "FAILED", text: "", claims: [], error: "No usable answer.", ms: Date.now() - started };
      } catch (error) {
        if (signal.aborted) return;
        result = { modelId, status: "FAILED", text: "", claims: [], error: errorText(error), ms: Date.now() - started };
      }
      await w.update((current) => ({ ...current, answers: current.answers.map((answer) => answer.modelId === modelId ? result : answer) }),
        result.status === "DONE" ? `${displayName(models, modelId)} answered.` : `${displayName(models, modelId)} failed: ${result.error}`);
    }));
    throwIfAborted(signal);
    if (w.current.answers.filter((answer) => answer.status === "DONE").length < 2) throw new Error("Fewer than two models answered, so there is nothing to compare.");
    await w.update((current) => ({ ...current, stage: "MERGE" }));
  }

  async function merge(w: Writer, signal: AbortSignal): Promise<void> {
    const run = w.current;
    const previous = run.rounds.at(-1) ?? null;
    const done = shuffled(run.answers.filter((answer) => answer.status === "DONE"), random);
    const prompt = buildMergePrompt({ question: run.question, plan: run.plan!, answers: done,
      previous: previous ? { merged: previous.merged, positions: previous.positions, ranking: previous.ranking, reviews: previous.reviews } : null });
    await w.update((current) => current, previous ? `The coordinator revises the merged answer (round ${previous.round + 1}).` : "The coordinator merges the answers without names.");
    let merged: ReturnType<typeof parseCouncilMerge> = null;
    for (let attempt = 0; attempt < 2 && !merged; attempt += 1) merged = parseCouncilMerge(await deps.callModel({ modelId: run.coordinatorModelId, prompt, role: "coordinator", signal }));
    if (!merged) throw new Error("The coordinator did not return a usable merge.");
    const round: CouncilRound = { round: (previous?.round ?? 0) + 1, merged: merged.merged, positions: merged.positions, reviews: [], ranking: [] };
    await w.update((current) => ({ ...current, stage: "REVIEW", rounds: [...current.rounds, round] }), `Merged into ${round.positions.length} positions.`);
  }

  async function review(w: Writer, signal: AbortSignal, models: readonly CouncilModel[]): Promise<void> {
    const run = w.current;
    const round = run.rounds.at(-1)!;
    const reviewers = run.answers.filter((answer) => answer.status === "DONE").map((answer) => answer.modelId);
    await w.update((current) => ({
      ...current,
      rounds: current.rounds.map((item) => item.round !== round.round ? item : {
        ...item, reviews: reviewers.map((modelId) => item.reviews.find((entry) => entry.modelId === modelId && entry.status === "DONE")
          ?? { modelId, status: "PENDING" as const, scores: [], corrections: [], missing: [], error: null })
      })
    }), `Every model reviews and scores the merged answer (round ${round.round}).`);
    const prompt = buildReviewPrompt({ question: run.question, plan: run.plan!, evidence: run.evidence, merged: round.merged, positions: round.positions });
    const pending = w.current.rounds.at(-1)!.reviews.filter((entry) => entry.status !== "DONE");
    await Promise.all(pending.map(async ({ modelId }) => {
      let result: CouncilReview;
      try {
        let parsed: ReturnType<typeof parseCouncilReview> = null;
        for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) parsed = parseCouncilReview(await deps.callModel({ modelId, prompt, role: "member", signal }), round.positions);
        result = parsed ? { modelId, status: "DONE", ...parsed, error: null } : { modelId, status: "FAILED", scores: [], corrections: [], missing: [], error: "No usable review." };
      } catch (error) {
        if (signal.aborted) return;
        result = { modelId, status: "FAILED", scores: [], corrections: [], missing: [], error: errorText(error) };
      }
      await w.update((current) => ({
        ...current,
        rounds: current.rounds.map((item) => item.round !== round.round ? item : { ...item, reviews: item.reviews.map((entry) => entry.modelId === modelId ? result : entry) })
      }), result.status === "DONE" ? `${displayName(models, modelId)} reviewed.` : `${displayName(models, modelId)} could not review: ${result.error}`);
    }));
    throwIfAborted(signal);
    const reviews = w.current.rounds.at(-1)!.reviews;
    if (!reviews.some((entry) => entry.status === "DONE")) throw new Error("No model returned a usable review.");
    const ranking = rankCouncilPositions(round.positions, reviews);
    await w.update((current) => ({ ...current, rounds: current.rounds.map((item) => item.round !== round.round ? item : { ...item, ranking }) }));
  }

  async function finish(w: Writer, signal: AbortSignal): Promise<void> {
    const run = w.current;
    const round = run.rounds.at(-1)!;
    await w.update((current) => ({ ...current, stage: "FINAL" }), "The coordinator writes the final answer.");
    const prompt = buildFinalPrompt({ question: run.question, plan: run.plan!, evidence: run.evidence, merged: round.merged, positions: round.positions,
      ranking: round.ranking, reviews: round.reviews, top: COUNCIL_TOP });
    const text = anonymizeModelText((await deps.callModel({ modelId: run.coordinatorModelId, prompt, role: "coordinator", signal })).trim());
    if (text.length < 40) throw new Error("The coordinator returned no final answer.");
    const byId = new Map(round.positions.map((position) => [position.id, position]));
    const top = councilTopEntries(round.ranking, COUNCIL_TOP).map((entry) => ({
      positionId: entry.positionId, title: byId.get(entry.positionId)?.title ?? entry.positionId, mean: entry.mean,
      agree: Math.round(entry.agreeShare * entry.reviewers), reviewers: entry.reviewers
    }));
    await w.update((current) => ({ ...current, status: "COMPLETED", stage: "DONE", final: { text: clip(text, 12_000), top }, error: null }), "The council finished.");
  }

  /** Never throws: a plan that fails leaves the finished run as it was and only reports why. */
  async function writeClipboardPlan(w: Writer, signal: AbortSignal): Promise<void> {
    const run = w.current;
    try {
      const prompt = buildClipboardPlanPrompt({ question: run.question, personalContext: run.plan?.personalContext ?? "", final: run.final?.text ?? "" });
      let parsed: CouncilClipboardPlanDraft | null = null;
      for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) parsed = parseCouncilClipboardPlan(await deps.callModel({ modelId: run.coordinatorModelId, prompt, role: "coordinator", signal }));
      if (!parsed) throw new Error("The coordinator did not return a usable plan.");
      const draft = parsed;
      const coordinator = displayName(await catalog(), run.coordinatorModelId);
      const item = await deps.savePlan(run.ownerUserId, { ...draft, minimumModel: draft.minimumModel || coordinator, text: councilClipboardPlanText(run, draft, coordinator) });
      await w.update((current) => ({ ...current, clipboardPlan: { status: "DONE", itemId: item.id, title: draft.title, error: null } }),
        `The coordinator saved the plan "${draft.title}" to your clipboard.`);
    } catch (error) {
      const reason = signal.aborted ? "Stopped before the plan was saved." : errorText(error);
      await w.update((current) => ({ ...current, clipboardPlan: { status: "FAILED", itemId: null, title: null, error: reason } }), `The plan could not be written: ${reason}`);
    }
  }

  /** Continues from the saved stage, so a resumed run skips what is already done. */
  async function execute(w: Writer, signal: AbortSignal, extraRound = false): Promise<void> {
    const models = await catalog();
    if (w.current.stage === "RESEARCH") await research(w, signal);
    if (w.current.stage === "ANSWERS") await answers(w, signal, models);
    let extra = extraRound;
    for (;;) {
      throwIfAborted(signal);
      if (w.current.stage === "MERGE") await merge(w, signal);
      if (w.current.stage === "REVIEW") {
        const last = w.current.rounds.at(-1);
        if (!last || !last.ranking.length) await review(w, signal, models);
        const current = w.current;
        const round = current.rounds.at(-1)!;
        const more = extra
          ? false
          : round.round < (current.plan?.reviewRounds ?? 1) && !councilAgreementReached(round.ranking, current.plan?.agreementTarget ?? 0.67);
        if (more && round.round < COUNCIL_MAX_TOTAL_ROUNDS) {
          await w.update((run) => ({ ...run, stage: "MERGE" }), "Agreement is still below the target; another round follows.");
          continue;
        }
        extra = false;
        await finish(w, signal);
      }
      if (w.current.stage === "FINAL") await finish(w, signal);
      return;
    }
  }

  return {
    async models() {
      const models = await catalog();
      return { models, coordinatorDefault: deps.coordinatorDefault, webSearch: deps.webSearchAvailable };
    },

    async create(owner: string, input: CreateCouncilRunInput): Promise<CouncilRun> {
      const models = await catalog();
      const available = (id: string | undefined) => (id && models.some((model) => model.id === id && model.available) ? id : null);
      const coordinator = available(input.coordinatorModelId) ?? available(deps.coordinatorDefault)
        ?? available("codex/gpt-6-astra") ?? models.find((model) => model.available && model.id.startsWith("codex/"))?.id ?? null;
      if (!coordinator) throw new SpaceConflictError("No Council model is available on this instance.");
      const at = now();
      const run: CouncilRun = {
        id: newCouncilRunId(), ownerUserId: owner, question: input.question, coordinatorModelId: coordinator, status: "PLANNING", stage: "PLAN",
        plan: null, estimate: null, qa: [], changeRequests: [], evidence: [], answers: [], rounds: [], final: null,
        events: [{ at, text: clip(`${displayName(models, coordinator)} coordinates and prepares a plan.`, 300) }], error: null, createdAt: at, updatedAt: at
      };
      let created: CouncilRun;
      try {
        created = await deps.repository.create(run);
      } catch (error) {
        if (error instanceof CouncilActiveRunError) throw new SpaceConflictError(error.message);
        throw error;
      }
      launch(created, plan);
      return created;
    },

    list(owner: string, limit = 20): Promise<CouncilRunSummary[]> {
      return deps.repository.list(owner, limit);
    },

    /** A restart drops the job writing a plan, so a plan left WRITING without one shows as failed and can be asked again. */
    async get(owner: string, id: string): Promise<CouncilRun> {
      const run = await load(owner, id);
      return run.clipboardPlan?.status === "WRITING" && !running.has(id)
        ? { ...run, clipboardPlan: { status: "FAILED", itemId: null, title: null, error: "Stopped: the server restarted." } } : run;
    },

    async answer(owner: string, id: string, provided: Record<string, string>): Promise<CouncilRun> {
      const run = await load(owner, id);
      assertStatus(run, ["NEEDS_INPUT"], "take answers");
      const last = run.qa.at(-1)!;
      const answersById = Object.fromEntries(last.questions.map((question) => [question.id, clip((provided[question.id] ?? "").trim(), 2_000)]));
      const saved = await save({ ...run, status: "PLANNING", qa: [...run.qa.slice(0, -1), { ...last, answers: answersById }],
        events: [...run.events, { at: now(), text: "You answered; the coordinator continues the plan." }].slice(-200), updatedAt: now() });
      launch(saved, plan);
      return saved;
    },

    async requestChanges(owner: string, id: string, text: string): Promise<CouncilRun> {
      const run = await load(owner, id);
      assertStatus(run, ["AWAITING_APPROVAL"], "change its plan");
      if (run.changeRequests.length >= 10) throw new SpaceConflictError("This plan has had ten change requests; approve it or start a new question.");
      const saved = await save({ ...run, status: "PLANNING", changeRequests: [...run.changeRequests, text],
        events: [...run.events, { at: now(), text: "You asked for changes; the coordinator revises the plan." }].slice(-200), updatedAt: now() });
      launch(saved, plan);
      return saved;
    },

    async approve(owner: string, id: string, edits: CouncilApproveInput): Promise<CouncilRun> {
      const run = await load(owner, id);
      assertStatus(run, ["AWAITING_APPROVAL"], "be approved");
      const models = await catalog();
      const current = run.plan!;
      let members = current.members;
      if (edits.members) {
        const unavailable = edits.members.filter((modelId) => !models.some((model) => model.id === modelId && model.available));
        if (unavailable.length) throw new SpaceConflictError(`Not available on this instance: ${unavailable.join(", ")}.`);
        members = [...new Set(edits.members)].map((modelId) => current.members.find((member) => member.modelId === modelId) ?? { modelId, reason: "Added by you." });
      }
      const approved = councilPlanSchema.parse({ ...current, members, personalContext: edits.personalContext ?? current.personalContext, reviewRounds: edits.reviewRounds ?? current.reviewRounds });
      let saved: CouncilRun;
      try {
        saved = await save({ ...run, status: "RUNNING", stage: "RESEARCH", plan: approved, estimate: estimateCouncil(approved), error: null,
          events: [...run.events, { at: now(), text: "You approved the plan." }].slice(-200), updatedAt: now() });
      } catch (error) {
        if (error instanceof CouncilActiveRunError) throw new SpaceConflictError(error.message);
        throw error;
      }
      launch(saved, (w, signal) => execute(w, signal));
      return saved;
    },

    async stop(owner: string, id: string): Promise<CouncilRun> {
      await load(owner, id);
      const entry = running.get(id);
      if (!entry) throw new SpaceConflictError("This Council run is not working right now.");
      entry.stop = "STOPPED";
      entry.controller.abort();
      await entry.done;
      return load(owner, id);
    },

    async cancel(owner: string, id: string): Promise<CouncilRun> {
      const run = await load(owner, id);
      assertStatus(run, ["PLANNING", "NEEDS_INPUT", "AWAITING_APPROVAL", "RUNNING", "INTERRUPTED"], "be cancelled");
      const entry = running.get(id);
      if (entry) {
        entry.stop = "CANCELLED";
        entry.controller.abort();
        await entry.done;
        return load(owner, id);
      }
      return save({ ...run, status: "CANCELLED", error: "Cancelled.", events: [...run.events, { at: now(), text: "Cancelled." }].slice(-200), updatedAt: now() });
    },

    async resume(owner: string, id: string): Promise<CouncilRun> {
      const run = await load(owner, id);
      assertStatus(run, ["INTERRUPTED", "FAILED"], "resume");
      if (running.has(id)) throw new SpaceConflictError("This Council run is already working.");
      const planning = run.plan === null || run.stage === "PLAN";
      let saved: CouncilRun;
      try {
        saved = await save({ ...run, status: planning ? "PLANNING" : "RUNNING", error: null,
          events: [...run.events, { at: now(), text: "Resumed where it stopped." }].slice(-200), updatedAt: now() });
      } catch (error) {
        if (error instanceof CouncilActiveRunError) throw new SpaceConflictError(error.message);
        throw error;
      }
      launch(saved, planning ? plan : (w, signal) => execute(w, signal));
      return saved;
    },

    async anotherRound(owner: string, id: string): Promise<CouncilRun> {
      const run = await load(owner, id);
      assertStatus(run, ["COMPLETED"], "run another review round");
      if (run.rounds.length >= COUNCIL_MAX_TOTAL_ROUNDS) throw new SpaceConflictError(`A council run stops at ${COUNCIL_MAX_TOTAL_ROUNDS} review rounds.`);
      if (running.has(id)) throw new SpaceConflictError("This Council run is already working.");
      let saved: CouncilRun;
      try {
        saved = await save({ ...run, status: "RUNNING", stage: "MERGE", error: null,
          events: [...run.events, { at: now(), text: "You asked for another review round." }].slice(-200), updatedAt: now() });
      } catch (error) {
        if (error instanceof CouncilActiveRunError) throw new SpaceConflictError(error.message);
        throw error;
      }
      launch(saved, (w, signal) => execute(w, signal, true));
      return saved;
    },

    /** "Create plan": the coordinator turns the final answer into a PLAN record in the owner's clipboard. */
    async createClipboardPlan(owner: string, id: string): Promise<CouncilRun> {
      const run = await load(owner, id);
      assertStatus(run, ["COMPLETED"], "write a plan");
      if (running.has(id)) throw new SpaceConflictError("This Council run is already working.");
      const saved = await save({ ...run, clipboardPlan: { status: "WRITING", itemId: null, title: null, error: null },
        events: [...run.events, { at: now(), text: "You asked the coordinator for a plan in your clipboard." }].slice(-200), updatedAt: now() });
      launch(saved, writeClipboardPlan);
      return saved;
    },

    async remove(owner: string, id: string): Promise<void> {
      await load(owner, id);
      if (running.has(id)) throw new SpaceConflictError("Stop this Council run before deleting it.");
      await deps.repository.delete(owner, id);
      lastStatus.delete(id);
      statusChanged(owner, id, null);
    },

    /** On start: runs a stopped process left working end as INTERRUPTED. */
    interruptStale(): Promise<number> {
      return deps.repository.interruptStale("Stopped: the server restarted. Resume continues where it stopped.");
    },

    async abortAll(): Promise<void> {
      for (const entry of running.values()) {
        entry.stop = "STOPPED";
        entry.controller.abort();
      }
      await Promise.allSettled([...running.values()].map((entry) => entry.done));
    },

    /** Test hook: resolves when the run's background work ends. */
    async settled(id: string): Promise<void> {
      await running.get(id)?.done;
      await statusQueue;
    }
  };
}
