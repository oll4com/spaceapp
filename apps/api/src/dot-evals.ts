import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { checkEvalReceipt, evalDatasetCaseSchema, type EvalDatasetCase, type EvalReceipt, type Pane } from "@space/contracts";
import type { DotEvalsRepository } from "@space/db";

/**
 * Space Dots Stage 7: runs a frozen evaluation dataset on the real runtime.
 *
 * An ADMIN starts a run for one of their Dots. Each case runs in a new
 * conversation in one evaluation pane, in ask-for-approval mode so nothing
 * changes outside the conversation: any write waits for approval and is
 * declined once the case is recorded. Background cases start a Goal with the
 * case as its objective. Cases that need a connection the owner has not made
 * are skipped, never passed. Receipts are rebuilt from what Space recorded.
 */
export const dotEvalStartSchema = z.object({
  dataset: z.enum(["dots-v1"]),
  split: z.enum(["tuning", "holdout", "all"]).default("holdout"),
  roomId: z.string().min(1).max(200),
  /** Runs every case on this model; omitted means the Dot's default. */
  modelConfigId: z.string().min(1).max(500).optional(),
  caseIds: z.array(z.string().min(3).max(80)).max(200).optional()
}).strict();
export type DotEvalStart = z.infer<typeof dotEvalStartSchema>;

export interface DotEvalDeps {
  datasetsRoot: string;
  evals: DotEvalsRepository;
  /** Connections the owner has made, e.g. "connector:google-mail". */
  available(owner: string): Promise<Set<string>>;
  openPane(input: { owner: string; roomId: string; title: string }): Promise<Pane>;
  startSession(input: { pane: Pane; owner: string; dotId: string; modelConfigId: string | null }): Promise<{ sessionId: string }>;
  uploadFixture(input: { roomId: string; paneId: string; owner: string; name: string; data: Buffer }): Promise<string>;
  send(input: { pane: Pane; sessionId: string; owner: string; content: string; artifactIds: string[]; requestKey: string }): Promise<void>;
  createGoal(owner: string, dotId: string, input: { sessionId: string; objective: string; criteria: string[]; budget: { maxSteps: number; maxMinutes: number } }): Promise<{ goalId: string }>;
  goalStatus(goalId: string): Promise<string | null>;
  cancelGoal(owner: string, dotId: string, goalId: string): Promise<void>;
  latestRunStatus(sessionId: string): Promise<string | null>;
  /** Stops the pane's running turn when a case times out or the evaluation is stopped. */
  interrupt(pane: Pane): Promise<void>;
  /** Identifies this API process; a restart closes only cases of processes that are gone. */
  runnerId: string;
  /** Declines approvals the case left waiting, so nothing it asked for happens later. */
  declinePending(owner: string, dotId: string, sessionId: string): Promise<void>;
  sleep?(ms: number): Promise<void>;
  log?(message: string, error?: unknown): void;
  timeouts?: { chatMs: number; goalMs: number; pollMs: number; idleMs: number };
}

const finishedRun = new Set(["COMPLETED", "FAILED", "INTERRUPTED", "BLOCKED"]);
const finishedGoal = new Set(["COMPLETED", "BLOCKED", "CANCELLED", "BUDGET_EXHAUSTED", "FAILED"]);

export async function loadEvalDataset(root: string, version: string) {
  const dir = join(root, version);
  const raw = await readFile(join(dir, "dataset.json"));
  const manifest = z.object({ version: z.literal(version), datasetSha256: z.string().regex(/^[a-f0-9]{64}$/), fixtures: z.record(z.string(), z.string()),
    independentCalibrationComplete: z.boolean() }).passthrough().parse(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")));
  if (createHash("sha256").update(raw).digest("hex") !== manifest.datasetSha256) throw new Error("The evaluation dataset does not match its frozen hash.");
  const cases = z.array(evalDatasetCaseSchema).parse(JSON.parse(raw.toString("utf8")));
  const fixtures = new Map<string, Buffer>();
  for (const [name, sha] of Object.entries(manifest.fixtures)) {
    const data = await readFile(join(dir, "fixtures", name));
    if (createHash("sha256").update(data).digest("hex") !== sha) throw new Error(`Fixture ${name} does not match its frozen hash.`);
    fixtures.set(name, data);
  }
  return { manifest, cases, fixtures };
}

export function createDotEvalService(deps: DotEvalDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeouts = deps.timeouts ?? { chatMs: 10 * 60_000, goalMs: 30 * 60_000, pollMs: 5_000, idleMs: 60_000 };
  const active = new Map<string, { evalRunId: string; cancelled: boolean }>();

  async function waitFor(check: () => Promise<boolean>, limitMs: number, run: { cancelled: boolean }) {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
      if (run.cancelled) return "CANCELLED" as const;
      if (await check()) return "DONE" as const;
      await sleep(timeouts.pollMs);
    }
    return "TIMEOUT" as const;
  }

  async function runCase(owner: string, dotId: string, evalRunId: string, item: EvalDatasetCase, pane: Pane, input: DotEvalStart,
    fixtures: Map<string, Buffer>, run: { cancelled: boolean }) {
    const { sessionId } = await deps.startSession({ pane, owner, dotId, modelConfigId: input.modelConfigId ?? null });
    await deps.evals.update(evalRunId, item.id, { sessionId, status: "RUNNING" });
    let outcome: "DONE" | "TIMEOUT" | "CANCELLED";
    if (item.mode === "BACKGROUND") {
      const goal = await deps.createGoal(owner, dotId, { sessionId, objective: item.prompt, criteria: item.doneWhen ?? [], budget: { maxSteps: 8, maxMinutes: 30 } });
      await deps.evals.update(evalRunId, item.id, { goalId: goal.goalId });
      outcome = await waitFor(async () => finishedGoal.has((await deps.goalStatus(goal.goalId)) ?? ""), timeouts.goalMs, run);
      if (outcome !== "DONE") await deps.cancelGoal(owner, dotId, goal.goalId).catch((error) => deps.log?.("Cancelling an evaluation Goal failed.", error));
    } else {
      const artifactIds: string[] = [];
      for (const name of item.attachments) {
        const data = fixtures.get(name);
        if (!data) throw new Error(`Fixture ${name} is missing.`);
        artifactIds.push(await deps.uploadFixture({ roomId: pane.roomId, paneId: pane.id, owner, name, data }));
      }
      await deps.send({ pane, sessionId, owner, content: item.prompt, artifactIds, requestKey: `eval-${evalRunId.slice(9)}-${item.id}`.slice(0, 128) });
      // Waiting on an approval counts as an outcome: the receipt records it.
      outcome = await waitFor(async () => finishedRun.has((await deps.latestRunStatus(sessionId)) ?? "") , timeouts.chatMs, run);
    }
    if (outcome !== "DONE") await deps.interrupt(pane).catch((error) => deps.log?.("Interrupting an evaluation case failed.", error));
    await deps.declinePending(owner, dotId, sessionId).catch((error) => deps.log?.("Declining evaluation approvals failed.", error));
    // The next case starts a new conversation in the same pane, which needs this one to be idle.
    const idle = async () => !["QUEUED", "RUNNING"].includes((await deps.latestRunStatus(sessionId)) ?? "");
    if (await waitFor(idle, timeouts.idleMs, { cancelled: false }) !== "DONE") {
      await deps.interrupt(pane).catch(() => undefined);
      await waitFor(idle, timeouts.idleMs, { cancelled: false });
    }
    await deps.evals.update(evalRunId, item.id, outcome === "DONE" ? { status: "DONE", statusReason: null }
      : outcome === "CANCELLED" ? { status: "CANCELLED", statusReason: "The evaluation was stopped." }
        : { status: "FAILED", statusReason: "The case did not finish in time." });
  }

  async function start(owner: string, dotId: string, raw: unknown) {
    const input = dotEvalStartSchema.parse(raw);
    if (active.has(owner)) throw new Error("An evaluation is already running for this account.");
    const evalRunId = `dot_eval:${randomBytes(8).toString("hex")}`;
    // Reserve the slot before any await so two requests cannot both start.
    const run = { evalRunId, cancelled: false };
    active.set(owner, run);
    let cases: EvalDatasetCase[], fixtures: Map<string, Buffer>, pane: Pane, missing: (item: EvalDatasetCase) => string[];
    try {
      const loaded = await loadEvalDataset(deps.datasetsRoot, input.dataset);
      fixtures = loaded.fixtures;
      const wanted = input.caseIds ? new Set(input.caseIds) : null;
      cases = loaded.cases.filter((item) => (input.split === "all" || item.split === input.split) && (!wanted || wanted.has(item.id)));
      if (!cases.length) throw new Error("No cases match.");
      const available = await deps.available(owner);
      missing = (item: EvalDatasetCase) => item.requires.filter((need) => !available.has(need));
      // The pane opens first: when it cannot, no case is recorded as waiting.
      pane = await deps.openPane({ owner, roomId: input.roomId, title: `Evaluation · ${input.dataset} · ${evalRunId.slice(9, 15)}` });
      await deps.evals.createRun({ evalRunId, ownerUserId: owner, dotId, roomId: input.roomId, datasetVersion: input.dataset, modelConfigId: input.modelConfigId ?? null,
        runnerId: deps.runnerId, cases: cases.map((item) => missing(item).length ? { caseId: item.id, status: "SKIPPED" as const, statusReason: `Needs ${missing(item).join(", ")}.` }
          : { caseId: item.id, status: "PENDING" as const, statusReason: null }) });
    } catch (error) {
      if (active.get(owner) === run) active.delete(owner);
      throw error;
    }
    void (async () => {
      try {
        for (const item of cases) {
          if (missing(item).length) continue;
          if (run.cancelled) { await deps.evals.update(evalRunId, item.id, { status: "CANCELLED", statusReason: "The evaluation was stopped." }); continue; }
          try {
            await runCase(owner, dotId, evalRunId, item, pane, input, fixtures, run);
          } catch (error) {
            deps.log?.(`Evaluation case ${item.id} failed.`, error);
            await deps.evals.update(evalRunId, item.id, { status: "FAILED", statusReason: (error instanceof Error ? error.message : "Unknown error").slice(0, 300) }).catch(() => undefined);
          }
        }
      } finally {
        if (active.get(owner) === run) active.delete(owner);
      }
    })();
    return { evalRunId, paneId: pane.id, cases: cases.length, skipped: cases.filter((item) => missing(item).length).length };
  }

  /** Per-case results: the receipt checks for finished cases, and the reason for the rest. */
  async function report(owner: string, evalRunId: string) {
    const records = await deps.evals.list(owner, evalRunId);
    if (!records.length) return null;
    const { cases, manifest } = await loadEvalDataset(deps.datasetsRoot, records[0]!.datasetVersion);
    const byId = new Map(cases.map((item) => [item.id, item]));
    const receipts = new Map<string, EvalReceipt>((await deps.evals.receipts(owner, evalRunId)).map((receipt) => [receipt.caseId, receipt]));
    const available = await deps.available(owner);
    const results = records.map((record) => {
      const item = byId.get(record.caseId);
      const receipt = receipts.get(record.caseId);
      const checked = item && receipt ? checkEvalReceipt(item, receipt, available) : null;
      return { caseId: record.caseId, family: item?.family ?? null, split: item?.split ?? null, status: record.status, statusReason: record.statusReason,
        passed: checked?.passed ?? null, checks: checked?.checks ?? [], model: receipt?.model ?? null, cost: receipt?.cost ?? null };
    });
    const families: Record<string, { cases: number; passed: number; failed: number; notRun: number }> = {};
    for (const result of results) {
      const family = families[result.family ?? "unknown"] ??= { cases: 0, passed: 0, failed: 0, notRun: 0 };
      family.cases += 1;
      if (result.passed === true) family.passed += 1; else if (result.passed === false) family.failed += 1; else family.notRun += 1;
    }
    return { evalRunId, datasetVersion: manifest.version, modelConfigId: records[0]!.modelConfigId, running: active.get(owner)?.evalRunId === evalRunId,
      calibrationComplete: manifest.independentCalibrationComplete, families, results,
      note: "Release decisions compare a candidate run with a baseline run through the gates (scripts/dots-eval-gates.mjs); one run alone proves nothing." };
  }

  function stop(owner: string, evalRunId: string) {
    const run = active.get(owner);
    if (!run || run.evalRunId !== evalRunId) return false;
    run.cancelled = true;
    return true;
  }
  return { start, report, stop, receipts: (owner: string, evalRunId: string) => deps.evals.receipts(owner, evalRunId),
    runs: (owner: string, dotId: string) => deps.evals.runs(owner, dotId, 20) };
}
export type DotEvalService = ReturnType<typeof createDotEvalService>;

export function registerDotEvalRoutes(app: FastifyInstance, service: DotEvalService | null, options: {
  routeOptions: RouteShorthandOptions;
  authenticatedOwner: (request: FastifyRequest) => Promise<string>;
  ownsDot(owner: string, dotId: string): Promise<boolean>;
  ownsRoom(owner: string, roomId: string): Promise<boolean>;
}) {
  const evalRunId = z.string().regex(/^dot_eval:[a-f0-9]{16}$/);
  // Evaluations spend model usage and open a pane, so they need an ADMIN acting on their own Dot.
  async function guard(request: FastifyRequest, reply: FastifyReply) {
    const owner = await options.authenticatedOwner(request);
    if (request.user?.role !== "ADMIN") { await reply.code(403).send({ error: { code: "ADMIN_REQUIRED", message: "Evaluations require ADMIN." } }); return null; }
    if (!service) { await reply.code(503).send({ error: { code: "DOT_EVALS_UNAVAILABLE", message: "Evaluations need the database." } }); return null; }
    const { dotId } = z.object({ dotId: z.string().min(1).max(200) }).parse(request.params);
    if (!await options.ownsDot(owner, dotId)) { await reply.code(404).send({ error: { code: "DOT_NOT_FOUND", message: "Dot not found." } }); return null; }
    return { owner, dotId, service };
  }
  app.get("/api/dots/:dotId/evals", options.routeOptions, async (request, reply) => {
    const context = await guard(request, reply);
    return context ? { runs: await context.service.runs(context.owner, context.dotId) } : reply;
  });
  app.post("/api/dots/:dotId/evals", options.routeOptions, async (request, reply) => {
    const context = await guard(request, reply);
    if (!context) return reply;
    const parsed = dotEvalStartSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: "DOT_EVAL_INVALID", message: "Choose a dataset, split and room." } });
    if (!await options.ownsRoom(context.owner, parsed.data.roomId)) return reply.code(404).send({ error: { code: "ROOM_NOT_FOUND", message: "Room not found." } });
    try {
      return reply.code(202).send(await context.service.start(context.owner, context.dotId, parsed.data));
    } catch (error) {
      return reply.code(409).send({ error: { code: "DOT_EVAL_CONFLICT", message: error instanceof Error ? error.message.slice(0, 300) : "The evaluation could not start." } });
    }
  });
  app.get("/api/dots/:dotId/evals/:evalRunId", options.routeOptions, async (request, reply) => {
    const context = await guard(request, reply);
    if (!context) return reply;
    const id = evalRunId.safeParse((request.params as { evalRunId?: unknown }).evalRunId);
    const report = id.success ? await context.service.report(context.owner, id.data) : null;
    return report ?? reply.code(404).send({ error: { code: "DOT_EVAL_NOT_FOUND", message: "Evaluation not found." } });
  });
  app.get("/api/dots/:dotId/evals/:evalRunId/receipts", options.routeOptions, async (request, reply) => {
    const context = await guard(request, reply);
    if (!context) return reply;
    const id = evalRunId.safeParse((request.params as { evalRunId?: unknown }).evalRunId);
    return id.success ? { evalRunId: id.data, receipts: await context.service.receipts(context.owner, id.data) }
      : reply.code(404).send({ error: { code: "DOT_EVAL_NOT_FOUND", message: "Evaluation not found." } });
  });
  app.post("/api/dots/:dotId/evals/:evalRunId/stop", options.routeOptions, async (request, reply) => {
    const context = await guard(request, reply);
    if (!context) return reply;
    const id = evalRunId.safeParse((request.params as { evalRunId?: unknown }).evalRunId);
    return { stopped: id.success ? context.service.stop(context.owner, id.data) : false };
  });
}
