import { z } from "zod";
import { taskAcceptanceSchema, validateTaskResult } from "./task-acceptance.js";
import { agentRunAttachmentSchema } from "./schemas.js";
import type { EvalCaseOutcome } from "./eval-gates.js";

/**
 * Space Dots Stage 7: evaluation cases that check what a Dot actually did,
 * not only what it wrote. A case may declare result checks on the answer
 * text and receipt checks on the run's recorded facts: which tools ran and
 * how they ended, what was read of each attached file, how a Goal ended.
 * Cases that need something not connected yet (for example a Slack
 * workspace) declare it and count as not run, never as passed.
 */
const toolPrefix = z.string().min(2).max(120).regex(/^[a-z0-9_.:-]+$/);
const checkBase = { id: z.string().min(1).max(60).regex(/^[a-z0-9_-]+$/), critical: z.boolean().default(true) };
export const evalReceiptCheckSchema = z.discriminatedUnion("kind", [
  /** A tool whose id starts with the prefix ran, optionally ending in one of the statuses. */
  z.object({ ...checkBase, kind: z.literal("TOOL_USED"), tool: toolPrefix, status: z.array(z.string().min(1).max(40)).max(6).optional() }).strict(),
  z.object({ ...checkBase, kind: z.literal("TOOL_NOT_USED"), tool: toolPrefix }).strict(),
  /** A sensitive call waited for the owner instead of running. */
  z.object({ ...checkBase, kind: z.literal("APPROVAL_REQUESTED"), tool: toolPrefix }).strict(),
  z.object({ ...checkBase, kind: z.literal("COVERAGE"), file: z.string().min(1).max(200), status: z.array(z.enum(["FULL", "PARTIAL", "UNAVAILABLE"])).min(1) }).strict(),
  z.object({ ...checkBase, kind: z.literal("GOAL_STATUS"), status: z.array(z.string().min(1).max(40)).min(1).max(6) }).strict(),
  z.object({ ...checkBase, kind: z.literal("RUN_STATUS"), status: z.array(z.string().min(1).max(40)).min(1).max(6) }).strict()
]);
export type EvalReceiptCheck = z.infer<typeof evalReceiptCheckSchema>;

export const evalDatasetCaseSchema = z.object({
  id: z.string().min(3).max(80).regex(/^[a-z0-9-]+$/),
  group: z.string().min(3).max(80),
  family: z.string().min(2).max(40),
  split: z.enum(["tuning", "holdout"]),
  language: z.enum(["en", "el"]),
  prompt: z.string().min(1).max(4000),
  /** Fixture files attached to the message, from the dataset's fixtures folder. */
  attachments: z.array(z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/)).max(8).default([]),
  acceptance: taskAcceptanceSchema.optional(),
  receiptChecks: z.array(evalReceiptCheckSchema).max(12).default([]),
  /** Connections the case needs, e.g. "connector:google-mail" or "channel:slack". */
  requires: z.array(z.string().min(3).max(60)).max(4).default([]),
  /** BACKGROUND cases start a Goal with the prompt as its objective and are checked when it ends. */
  mode: z.enum(["CHAT", "BACKGROUND"]).default("CHAT"),
  doneWhen: z.array(z.string().min(1).max(500)).max(5).optional(),
  provenance: z.string().min(1).max(80),
  requiresExternalEffects: z.boolean()
}).strict().refine((value) => value.acceptance || value.receiptChecks.length, "A case needs result or receipt checks.");
export type EvalDatasetCase = z.infer<typeof evalDatasetCaseSchema>;

/** What Space recorded about one evaluation run (exported by the eval receipts API). */
export const evalReceiptSchema = z.object({
  caseId: z.string().min(3).max(80),
  runId: z.string().min(1).max(200),
  status: z.string().min(1).max(40),
  /** The case ran but did not finish (timeout or runner error); it fails. */
  unfinished: z.boolean().optional(),
  result: z.string().max(50_000),
  tools: z.array(z.object({ toolId: z.string().min(1).max(200), status: z.string().min(1).max(40) }).strict()).max(200),
  attachments: z.array(z.object({ name: z.string().min(1).max(512), coverage: z.enum(["FULL", "PARTIAL", "UNAVAILABLE"]).nullable() }).strict()).max(8),
  goal: z.object({ status: z.string().min(1).max(40) }).strict().nullable(),
  model: z.string().max(200).nullable(),
  cost: z.object({ status: z.enum(["UNKNOWN", "ESTIMATED", "ACTUAL"]), amountUsd: z.number().nonnegative().nullable(),
    priceCatalogVersion: z.string().max(160).nullable() }).strict()
}).strict();
export type EvalReceipt = z.infer<typeof evalReceiptSchema>;

const matches = (toolId: string, prefix: string) => toolId.startsWith(prefix);

/** Checks one receipt against its case; `passed` is true only when every critical check passed. */
export function checkEvalReceipt(item: EvalDatasetCase, receipt: EvalReceipt, available: ReadonlySet<string> = new Set()) {
  if (item.requires.some((need) => !available.has(need))) {
    return { passed: null, checks: [], reason: `Needs ${item.requires.filter((need) => !available.has(need)).join(", ")}.` };
  }
  if (receipt.unfinished) return { passed: false, checks: [{ id: "finished", passed: false, critical: true }], reason: "The case did not finish." };
  const checks: Array<{ id: string; passed: boolean; critical: boolean }> = [];
  if (item.acceptance) {
    for (const check of validateTaskResult(item.acceptance, receipt.result)) checks.push({ id: `result:${check.id}`, passed: check.passed, critical: check.critical });
  }
  for (const check of item.receiptChecks) {
    let passed = false;
    switch (check.kind) {
      case "TOOL_USED":
        passed = receipt.tools.some((tool) => matches(tool.toolId, check.tool) && (!check.status || check.status.includes(tool.status)));
        break;
      case "TOOL_NOT_USED":
        passed = !receipt.tools.some((tool) => matches(tool.toolId, check.tool) && tool.status !== "BLOCKED" && tool.status !== "DECLINED");
        break;
      case "APPROVAL_REQUESTED":
        passed = receipt.tools.some((tool) => matches(tool.toolId, check.tool) && ["APPROVAL_REQUIRED", "PENDING", "DECLINED"].includes(tool.status))
          && !receipt.tools.some((tool) => matches(tool.toolId, check.tool) && tool.status === "COMPLETED");
        break;
      case "COVERAGE": {
        const file = receipt.attachments.find((attachment) => attachment.name === check.file);
        passed = Boolean(file?.coverage && check.status.includes(file.coverage));
        break;
      }
      case "GOAL_STATUS":
        passed = Boolean(receipt.goal && check.status.includes(receipt.goal.status));
        break;
      case "RUN_STATUS":
        passed = check.status.includes(receipt.status);
        break;
    }
    checks.push({ id: `receipt:${check.id}`, passed, critical: check.critical });
  }
  return { passed: checks.every((check) => !check.critical || check.passed), checks, reason: null };
}

/** Turns receipts into gate outcomes; cases without a receipt, or needing a missing connection, did not run. */
export function evalOutcomes(cases: EvalDatasetCase[], receipts: EvalReceipt[], available: ReadonlySet<string> = new Set()): EvalCaseOutcome[] {
  const byCase = new Map<string, EvalReceipt>();
  for (const receipt of receipts) {
    if (byCase.has(receipt.caseId)) throw new Error(`Duplicate receipt for ${receipt.caseId}.`);
    byCase.set(receipt.caseId, receipt);
  }
  return cases.map((item) => {
    const receipt = byCase.get(item.id);
    if (!receipt) return { caseId: item.id, passed: null, costStatus: "UNKNOWN", costUsd: null, priceCatalogVersion: null };
    return { caseId: item.id, passed: checkEvalReceipt(item, receipt, available).passed, costStatus: receipt.cost.status,
      costUsd: receipt.cost.amountUsd, priceCatalogVersion: receipt.cost.priceCatalogVersion };
  });
}

/** The attachment receipts of a run's execution record; an older or partial record still yields them. */
export function evalAttachmentsOf(execution: unknown): EvalReceipt["attachments"] {
  const files = z.object({ attachments: z.array(agentRunAttachmentSchema).max(8) }).safeParse(execution);
  return files.success ? files.data.attachments.map((file) => ({ name: file.name, coverage: file.coverage?.status ?? null })) : [];
}

/** API shapes for evaluation runs (Space Dots Stage 7). */
export type DotEvalCaseState = "PENDING" | "RUNNING" | "DONE" | "SKIPPED" | "FAILED" | "CANCELLED";
export interface DotEvalRunSummary { evalRunId: string; datasetVersion: string; modelConfigId: string | null; createdAt: string; counts: Record<DotEvalCaseState, number> }
export interface DotEvalReport {
  evalRunId: string; datasetVersion: string; modelConfigId: string | null; running: boolean; calibrationComplete: boolean;
  families: Record<string, { cases: number; passed: number; failed: number; notRun: number }>;
  results: Array<{ caseId: string; family: string | null; split: string | null; status: DotEvalCaseState; statusReason: string | null; passed: boolean | null;
    checks: Array<{ id: string; passed: boolean; critical: boolean }>; model: string | null; cost: EvalReceipt["cost"] | null }>;
  note: string;
}
