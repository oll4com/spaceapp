/**
 * @fileoverview CLI script for recording canonical workflow histories using
 * a real time-skipping Temporal test environment.
 *
 * Usage:
 *   npm run temporal:record-histories -w @space/worker
 */
import process from "node:process";
import {
  defaultHistoryFixturesDir,
  writeWorkflowHistoryFixtures
} from "./workflow-sandbox-harness.js";

/**
 * Main entry point for recording workflow execution histories.
 *
 * @param targetDir - Optional custom directory path to write JSON history fixtures.
 * @param overwrite - Optional boolean to force overwriting existing fixture files.
 * @returns Resolves when recording and serialization complete.
 */
export async function recordWorkflowHistoriesCli(
  targetDir?: string,
  overwrite?: boolean
): Promise<void> {
  const args = process.argv.slice(2);
  const overwriteFlag =
    overwrite ?? (args.includes("--overwrite") || args.includes("-f"));
  const nonFlagArg = args.find((arg) => !arg.startsWith("-"));
  const outputDir = targetDir || nonFlagArg || defaultHistoryFixturesDir;
  const result = await writeWorkflowHistoryFixtures(outputDir, {
    overwrite: overwriteFlag
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        outputDir,
        count: result.written.length,
        skippedCount: result.skipped.length,
        skipped: result.skipped,
        files: result.written.map((f) => ({
          fileName: f.fileName,
          workflowType: f.workflowType,
          branch: f.branch ?? "current",
          events: f.history.events?.length ?? 0
        }))
      },
      null,
      2
    )}\n`
  );
}

await recordWorkflowHistoriesCli();


