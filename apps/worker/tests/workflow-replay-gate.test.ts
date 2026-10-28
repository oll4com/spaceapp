import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cleanPath = path.resolve(__dirname, "fixtures/replay/clean-workflows.ts");
const driftedPath = path.resolve(__dirname, "fixtures/replay/drifted-workflows.ts");

describe("workflow replay gate", () => {
  let history: any;
  const workflowId = "replay-probe-gate-run";

  beforeAll(async () => {
    const testEnv = await TestWorkflowEnvironment.createTimeSkipping();
    const taskQueue = "test-replay-gate-queue";

    const activities = {
      async step1(): Promise<void> {},
      async step2(): Promise<void> {},
      async step3(): Promise<void> {},
    };

    try {
      const worker = await Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue,
        workflowsPath: cleanPath,
        activities,
      });

      await worker.runUntil(async () => {
        const handle = await testEnv.workflowClient.start("replayProbeWorkflow", {
          workflowId,
          taskQueue,
        });
        const result = await handle.result();
        expect(result).toBe("done");
        history = await handle.fetchHistory();
      });
    } finally {
      await testEnv.teardown();
    }
  }, 60_000);

  it("records a complete execution history from clean workflow", () => {
    expect(history).toBeDefined();
    expect(history.events?.length).toBeGreaterThan(0);
  });

  it("proves replay succeeds against clean workflow", async () => {
    await expect(
      Worker.runReplayHistory({ workflowsPath: cleanPath }, history, workflowId)
    ).resolves.toBeUndefined();
  }, 30_000);

  it("proves replay fails against drifted workflow with DeterminismViolationError", async () => {
    let error: any;
    try {
      await Worker.runReplayHistory({ workflowsPath: driftedPath }, history, workflowId);
    } catch (err: any) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(DeterminismViolationError);
    expect(error.name).toBe("DeterminismViolationError");
    expect(error.message).toContain("Replay");
  }, 30_000);
});
