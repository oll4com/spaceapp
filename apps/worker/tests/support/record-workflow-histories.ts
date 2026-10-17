import process from "node:process";
import {
  defaultHistoryFixturesDir,
  writeWorkflowHistoryFixtures
} from "./workflow-sandbox-harness.js";

const outputDir = process.argv[2] || defaultHistoryFixturesDir;
const fixtures = await writeWorkflowHistoryFixtures(outputDir);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      outputDir,
      count: fixtures.length,
      files: fixtures.map((f) => ({
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
