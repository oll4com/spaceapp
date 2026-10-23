import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DeterminismViolationError } from "@temporalio/workflow";
import { DefaultLogger, Runtime } from "@temporalio/worker";
import { loadHistories, replayHistories } from "./support/replay-workflow-histories.mjs";
import { workflowPaths } from "./support/temporal-sandbox.mjs";

describe("recorded workflow replay gate", () => {
  Runtime.install({ logger: new DefaultLogger("ERROR") });

  it("replays every committed history with the current production workflows, including the pre-patch supervisor", async () => {
    const histories = await loadHistories();
    expect(await replayHistories(histories)).toBe(histories.length);
  }, 30_000);

  it("rejects an added timer with DeterminismViolationError and identifies its workflow and history file", async () => {
    const histories = (await loadHistories()).filter((history: any) => history.workflowName === "dotGoalWorkflow");
    let failure: any;
    try {
      await replayHistories(histories, { ...workflowPaths,
        turns: fileURLToPath(new URL("./fixtures/incompatible-dot-workflow.ts", import.meta.url)) });
    } catch (error) { failure = error; }
    expect(failure, "an unpatched extra timer must fail replay").toBeInstanceOf(Error);
    expect(failure.cause).toBeInstanceOf(DeterminismViolationError);
    expect(failure.message).toContain("dotGoalWorkflow");
    expect(failure.message).toContain(histories[0].filename);
  }, 30_000);
});
