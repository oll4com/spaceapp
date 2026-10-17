import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeterminismViolationError } from "@temporalio/workflow";
import {
  defaultHistoryFixturesDir,
  EXPECTED_HISTORY_FIXTURES,
  historyHasPatchMarker,
  replayWorkflowHistoryFixtures,
  WORKFLOW_MODULE_PATHS,
  workerRoot
} from "./support/workflow-sandbox-harness.js";

describe("Temporal workflow replay determinism gate", () => {
  it(
    "replays all recorded workflow histories against the current workflow code, including both supervisor branches",
    async () => {
      const result = await replayWorkflowHistoryFixtures();

      for (const expected of EXPECTED_HISTORY_FIXTURES) {
        expect(result.replayedFiles).toContain(expected.fileName);
        expect(result.workflowTypes.has(expected.workflowType)).toBe(true);
      }
      expect(result.workflowTypes.size).toBe(8);
      expect(result.hasPrePatchSupervisor).toBe(true);

      const currentHistory = JSON.parse(
        readFileSync(path.join(defaultHistoryFixturesDir, "roomAgentSupervisorWorkflow.json"), "utf8")
      ) as Record<string, unknown>;
      const prePatchHistory = JSON.parse(
        readFileSync(
          path.join(defaultHistoryFixturesDir, "roomAgentSupervisorWorkflow-pre-patch.json"),
          "utf8"
        )
      ) as Record<string, unknown>;

      expect(historyHasPatchMarker(currentHistory, "room-background-continuation-v1")).toBe(true);
      expect(historyHasPatchMarker(prePatchHistory, "room-background-continuation-v1")).toBe(false);
    },
    120_000
  );

  it(
    "fails with DeterminismViolationError naming the workflow and history file when an unpatched timer is added",
    async () => {
      const scratchDir = mkdtempSync(path.join(workerRoot, "src", ".replay-neg-timer-"));
      const variantPath = path.join(scratchDir, "workflows-extra-timer.ts");
      try {
        const original = readFileSync(WORKFLOW_MODULE_PATHS.main, "utf8")
          .replace(/from "\.\//g, 'from "../')
          .replace(
            "export async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {",
            'export async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {\n  await condition(() => false, "1 second");'
          );
        writeFileSync(variantPath, original, "utf8");

        let caught: unknown;
        try {
          await replayWorkflowHistoryFixtures({
            workflowPathOverrides: { main: variantPath }
          });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(DeterminismViolationError);
        expect((caught as Error).message).toMatch(/dotGoalWorkflow[\s\S]*dotGoalWorkflow\.json/);
      } finally {
        rmSync(scratchDir, { recursive: true, force: true });
      }
    },
    120_000
  );

  it(
    "fails with DeterminismViolationError naming the workflow and history file when an unpatched activity is added",
    async () => {
      const scratchDir = mkdtempSync(path.join(workerRoot, "src", ".replay-neg-activity-"));
      const variantPath = path.join(scratchDir, "memory-mutation-extra-activity.ts");
      try {
        const original = readFileSync(WORKFLOW_MODULE_PATHS.memoryMutation, "utf8")
          .replace(/from "\.\//g, 'from "../')
          .replace(
            "return executePersistedMemoryChangeSet(input);",
            "await executePersistedMemoryChangeSet(input);\n  return executePersistedMemoryChangeSet(input);"
          );
        writeFileSync(variantPath, original, "utf8");

        let caught: unknown;
        try {
          await replayWorkflowHistoryFixtures({
            workflowPathOverrides: { memoryMutation: variantPath }
          });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(DeterminismViolationError);
        expect((caught as Error).message).toMatch(
          /memoryMutationWorkflow[\s\S]*memoryMutationWorkflow\.json/
        );
      } finally {
        rmSync(scratchDir, { recursive: true, force: true });
      }
    },
    120_000
  );
});
