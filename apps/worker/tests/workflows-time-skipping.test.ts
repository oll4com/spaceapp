import { afterAll, beforeAll, describe, it } from "vitest";
import { createTestEnvironment, runScenario } from "./support/temporal-test-harness.js";
import { additionalScenarios, basicScenarios, memoryScenarios } from "./support/workflow-scenarios.js";
import { supervisorScenarios } from "./support/supervisor-scenarios.js";

describe.sequential("production workflows on a real time-skipping server", () => {
  let env: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => { env = await createTestEnvironment(); }, 60_000);
  afterAll(async () => { await env?.teardown(); }, 15_000);
  for (const scenario of [...basicScenarios, ...memoryScenarios, ...supervisorScenarios, ...additionalScenarios]) {
    it(scenario.name, async () => { await runScenario(env, scenario); }, 30_000);
  }
});
