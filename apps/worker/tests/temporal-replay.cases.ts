import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { temporal } from "@temporalio/proto";
import { Worker } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
import {
  getTemporalWorkflowBundle,
  recordingWorkflowHistories,
  workflowHistoryDirectory,
  type RecordedWorkflowHistory
} from "./support/temporal-sandbox.js";

const requiredLabels = [
  "dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow",
  "roomAgentSupervisorWorkflow", "roomAgentSupervisorWorkflow.pre-patch",
  "roomAgentActionWorkflow", "memoryMaintenanceWorkflow",
  "memoryConsolidationWorkflow", "memoryMutationWorkflow"
] as const;
const productionWorkflowTypes = new Set(requiredLabels.map((label) => label.split(".")[0]!));

/** Loads every golden history, requiring all workflow labels and validating their start events. */
async function histories() {
  let names: string[];
  try {
    names = (await readdir(workflowHistoryDirectory)).filter((name) => name.endsWith(".json")).sort();
  } catch (cause) {
    throw new Error("Missing recorded workflow histories. Run the explicit history-recording command and commit genuine synthetic histories.", { cause });
  }
  for (const label of requiredLabels) {
    if (!names.includes(`${label}.json`)) throw new Error(`Missing required golden history: ${label}.json`);
  }
  return Promise.all(names.map(async (filename) => {
    const expectedWorkflowType = filename.split(/[.-]/)[0]!;
    try {
      const fixture = JSON.parse(await readFile(join(workflowHistoryDirectory, filename), "utf8")) as RecordedWorkflowHistory;
      if (fixture.format !== 1 || fixture.label !== filename.slice(0, -5) || !fixture.workflowId ||
          fixture.workflowType !== expectedWorkflowType || !productionWorkflowTypes.has(fixture.workflowType)) {
        throw new Error("Invalid recorded-history envelope or workflow type.");
      }
      const history = temporal.api.history.v1.History.fromObject(fixture.history);
      const started = history.events?.find((event) => event.workflowExecutionStartedEventAttributes)
        ?.workflowExecutionStartedEventAttributes?.workflowType?.name;
      if (!history.events?.length || started !== fixture.workflowType) {
        throw new Error("Missing or mismatched workflow start event.");
      }
      return { filename, fixture, history };
    } catch (cause) {
      throw new Error(`Cannot load ${filename} (${expectedWorkflowType}).`, { cause });
    }
  }));
}

/** Searches the error cause chain for a determinism violation without revisiting objects. */
function hasDeterminismViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ((current as { name?: string }).name === "DeterminismViolationError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Registers replay compatibility and extra-timer rejection cases outside explicit recording mode. */
export function registerReplayCases(): void {
  describe("recorded production workflow compatibility", () => {
    // Recording bootstrap runs real scenarios first; it may create absent
    // golden files. Only this explicit mode skips replay, never normal tests.
    it.skipIf(recordingWorkflowHistories)("replays every checked-in history against current production code", async () => {
      const fixtures = await histories();
      const workflowBundle = await getTemporalWorkflowBundle();
      let replayed = 0;
      for (const { filename, fixture, history } of fixtures) {
        try {
          let results = 0;
          for await (const result of Worker.runReplayHistories({ workflowBundle }, [{ workflowId: fixture.workflowId, history }])) {
            results++;
            if (result.error) throw result.error;
          }
          if (results !== 1) throw new Error(`Expected one replay result, received ${results}.`);
          replayed++;
        } catch (cause) {
          throw new Error(`Replay failed for ${filename} (${fixture.workflowType}).`, { cause });
        }
      }
      expect(replayed).toBe(fixtures.length);
      expect(replayed).toBeGreaterThanOrEqual(requiredLabels.length);
    }, 60_000);

    it.skipIf(recordingWorkflowHistories)("rejects an unpatched extra timer with DeterminismViolationError", async () => {
      const recorded = (await histories()).find(({ fixture }) => fixture.label === "dotGoalWorkflow")!;
      const workflowBundle = await getTemporalWorkflowBundle({ negative: true });
      let failure: unknown;
      try {
        let count = 0;
        for await (const result of Worker.runReplayHistories({ workflowBundle }, [{
          workflowId: recorded.fixture.workflowId,
          history: recorded.history
        }])) {
          count++;
          if (result.error) failure = result.error;
        }
        expect(count).toBe(1);
      } catch (error) {
        failure = error;
      }
      expect(failure, `extra timer must break ${recorded.filename}`).toBeDefined();
      expect(hasDeterminismViolation(failure), `expected DeterminismViolationError for ${recorded.filename}, got ${String(failure)}`).toBe(true);
    }, 60_000);
  });
}
