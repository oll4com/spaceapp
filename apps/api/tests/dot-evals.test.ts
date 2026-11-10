import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalReceipt, Pane } from "@space/contracts";
import type { DotEvalCaseRecord, DotEvalsRepository } from "@space/db";
import { createDotEvalService, loadEvalDataset } from "../src/dot-evals.js";

const evalsRoot = fileURLToPath(new URL("../../../evals/", import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function memoryRepository() {
  const rows: DotEvalCaseRecord[] = [];
  const receipts: EvalReceipt[] = [];
  const repo: DotEvalsRepository = {
    createRun: async (input) => { input.cases.forEach((item, position) => rows.push({ evalRunId: input.evalRunId, caseId: item.caseId, ownerUserId: input.ownerUserId,
      dotId: input.dotId, roomId: input.roomId, datasetVersion: input.datasetVersion, modelConfigId: input.modelConfigId, position, sessionId: null, goalId: null,
      status: item.status, statusReason: item.statusReason, startedAt: null, finishedAt: null, createdAt: new Date().toISOString() })); },
    update: async (evalRunId, caseId, patch) => { const row = rows.find((item) => item.evalRunId === evalRunId && item.caseId === caseId)!;
      if (row.status === "CANCELLED" || row.status === "SKIPPED") return;
      Object.assign(row, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))); },
    list: async (owner, evalRunId) => rows.filter((item) => item.ownerUserId === owner && item.evalRunId === evalRunId),
    runs: async () => [],
    isRunningSession: async (sessionId) => rows.some((row) => row.sessionId === sessionId && row.status === "RUNNING"),
    abandon: async () => [],
    receipts: async () => receipts,
    dispose: async () => undefined
  };
  return { repo, rows, receipts };
}
const pane = { id: "pane:eval", roomId: "room:1", title: "Evaluation" } as Pane;
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

function fixture(options: { runStatus?: string; goalStatus?: string; available?: string[]; openPane?: () => Promise<Pane> } = {}) {
  const memory = memoryRepository();
  let session = 0;
  const deps = {
    datasetsRoot: evalsRoot, evals: memory.repo,
    available: vi.fn(async () => new Set(options.available ?? [])),
    openPane: vi.fn(options.openPane ?? (async () => pane)),
    startSession: vi.fn(async () => ({ sessionId: `session:${++session}` })),
    uploadFixture: vi.fn(async ({ name }: { name: string }) => `artifact:${name}`),
    send: vi.fn(async () => undefined),
    createGoal: vi.fn(async () => ({ goalId: `goal:${session}` })),
    goalStatus: vi.fn(async () => options.goalStatus ?? "COMPLETED"),
    cancelGoal: vi.fn(async () => undefined),
    latestRunStatus: vi.fn(async () => options.runStatus ?? "COMPLETED"),
    interrupt: vi.fn(async () => undefined),
    runnerId: "api:test-runner",
    declinePending: vi.fn(async () => undefined),
    sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
    timeouts: { chatMs: 50, goalMs: 50, pollMs: 1, idleMs: 20 }
  };
  return { service: createDotEvalService(deps), deps, memory };
}

describe("Dot evaluation runs", () => {
  it("verifies the frozen dataset and its fixtures", async () => {
    const { cases, fixtures } = await loadEvalDataset(evalsRoot, "dots-v1");
    expect(cases.length).toBeGreaterThan(40);
    expect(fixtures.get("orders.csv")?.toString()).toContain("A-101");
    const dir = mkdtempSync(join(tmpdir(), "space-evals-")); dirs.push(dir);
    cpSync(join(evalsRoot, "dots-v1"), join(dir, "dots-v1"), { recursive: true });
    writeFileSync(join(dir, "dots-v1", "fixtures", "orders.csv"), "tampered");
    await expect(loadEvalDataset(dir, "dots-v1")).rejects.toThrow(/Fixture orders.csv/);
  });

  it("runs each case in its own conversation, attaches fixtures, starts Goals and skips missing connections", async () => {
    const f = fixture({ available: ["connector:mail-read"] });
    const started = await f.service.start("user:1", "dot:1", { dataset: "dots-v1", split: "holdout", roomId: "room:1" });
    expect(started).toMatchObject({ evalRunId: expect.stringMatching(/^dot_eval:[a-f0-9]{16}$/), paneId: "pane:eval" });
    await until(() => f.memory.rows.every((row) => row.status !== "PENDING" && row.status !== "RUNNING"));
    const rows = f.memory.rows;
    expect(rows.filter((row) => row.status === "SKIPPED").map((row) => row.statusReason)).toEqual(expect.arrayContaining([expect.stringMatching(/^Needs channel:/)]));
    expect(rows.filter((row) => row.status === "DONE")).toHaveLength(started.cases - started.skipped);
    expect(f.deps.startSession).toHaveBeenCalledTimes(started.cases - started.skipped);
    const image = f.deps.send.mock.calls.find(([input]) => (input as { content: string }).content.startsWith("What color"))![0] as { artifactIds: string[]; requestKey: string };
    expect(image.artifactIds).toEqual(["artifact:red-square.png"]);
    expect(image.requestKey).toBe(`eval-${started.evalRunId.slice(9)}-multimodal-07-image-color-en`);
    expect(f.deps.createGoal).toHaveBeenCalledWith("user:1", "dot:1", expect.objectContaining({ criteria: ["The user chose the city"], budget: { maxSteps: 8, maxMinutes: 30 } }));
    expect(f.deps.declinePending).toHaveBeenCalledTimes(started.cases - started.skipped);
  });

  it("allows one evaluation at a time, records timeouts, cancels stuck Goals and stops on request", async () => {
    const stuck = fixture({ runStatus: "RUNNING", goalStatus: "ACTIVE" });
    const first = await stuck.service.start("user:1", "dot:1", { dataset: "dots-v1", split: "tuning", roomId: "room:1", caseIds: ["background-03-delegate-en", "background-04-schedule-en"] });
    await expect(stuck.service.start("user:1", "dot:1", { dataset: "dots-v1", roomId: "room:1" })).rejects.toThrow(/already running/);
    expect(stuck.service.stop("user:1", first.evalRunId)).toBe(true);
    await until(() => stuck.memory.rows.every((row) => row.status !== "PENDING" && row.status !== "RUNNING"));
    expect(stuck.memory.rows.map((row) => row.status)).toEqual(["CANCELLED", "CANCELLED"]);

    expect(stuck.deps.interrupt).toHaveBeenCalledWith(pane);

    const goals = fixture({ goalStatus: "ACTIVE" });
    await goals.service.start("user:1", "dot:1", { dataset: "dots-v1", split: "tuning", roomId: "room:1", caseIds: ["background-01-goal-arithmetic-en"] });
    await until(() => goals.memory.rows.every((row) => row.status !== "PENDING" && row.status !== "RUNNING"));
    expect(goals.memory.rows[0]).toMatchObject({ status: "FAILED", statusReason: "The case did not finish in time.", goalId: "goal:1" });
    expect(goals.deps.cancelGoal).toHaveBeenCalledWith("user:1", "dot:1", "goal:1");
  });

  it("never runs two evaluations at once and records nothing when the pane cannot open", async () => {
    const racing = fixture();
    const first = racing.service.start("user:1", "dot:1", { dataset: "dots-v1", split: "tuning", roomId: "room:1", caseIds: ["mcp-01-room-count-en"] });
    await expect(racing.service.start("user:1", "dot:1", { dataset: "dots-v1", split: "tuning", roomId: "room:1" })).rejects.toThrow(/already running/);
    await first;
    const blocked = fixture({ openPane: async () => { throw new Error("The room has no free pane."); } });
    await expect(blocked.service.start("user:1", "dot:1", { dataset: "dots-v1", roomId: "room:1" })).rejects.toThrow(/no free pane/);
    expect(blocked.memory.rows).toHaveLength(0);
    await expect(blocked.service.start("user:1", "dot:1", { dataset: "dots-v1", roomId: "room:1" })).rejects.toThrow(/no free pane/);
  });

  it("reports each case from its receipt and never passes a case that did not run", async () => {
    const f = fixture();
    const started = await f.service.start("user:1", "dot:1", { dataset: "dots-v1", split: "tuning", roomId: "room:1",
      caseIds: ["multimodal-01-csv-sum-en", "multimodal-02-markdown-fact-en", "channels-01-mail-search-en"] });
    await until(() => f.memory.rows.every((row) => row.status !== "PENDING" && row.status !== "RUNNING"));
    f.memory.receipts.push({ caseId: "multimodal-01-csv-sum-en", runId: "run:1", status: "COMPLETED", result: "430.5", tools: [],
      attachments: [{ name: "orders.csv", coverage: "FULL" }], goal: null, model: "m", cost: { status: "UNKNOWN", amountUsd: null, priceCatalogVersion: null } },
    { caseId: "multimodal-02-markdown-fact-en", runId: "run:2", status: "COMPLETED", result: "Acme", tools: [],
      attachments: [{ name: "meeting-notes.md", coverage: "FULL" }], goal: null, model: "m", cost: { status: "UNKNOWN", amountUsd: null, priceCatalogVersion: null } });
    const report = await f.service.report("user:1", started.evalRunId);
    expect(report?.results.map((result) => [result.caseId, result.passed])).toEqual([["multimodal-01-csv-sum-en", true], ["multimodal-02-markdown-fact-en", false],
      ["channels-01-mail-search-en", null]]);
    expect(report?.families).toMatchObject({ multimodal: { cases: 2, passed: 1, failed: 1 }, channels: { notRun: 1 } });
    expect(await f.service.report("user:2", started.evalRunId)).toBeNull();
  });
});
