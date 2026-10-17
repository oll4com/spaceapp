import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  generateSyntheticWorkflowHistories,
  replayHistoryFixtures,
  workflowHistoriesDir
} from "./temporal-test-harness.js";

async function main(): Promise<void> {
  mkdirSync(workflowHistoriesDir, { recursive: true });
  const fixtures = await generateSyntheticWorkflowHistories();

  // Verify every generated fixture replays cleanly against current workflow code before writing.
  await replayHistoryFixtures(fixtures);

  for (const fixture of fixtures) {
    const targetPath = path.join(workflowHistoriesDir, fixture.fileName);
    const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
    writeFileSync(targetPath, serialized, "utf8");
    console.log(`Recorded ${fixture.workflowType} -> ${ path.relative(process.cwd(), targetPath) }`);
  }
}

await main();
