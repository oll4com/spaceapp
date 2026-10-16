import { afterEach, beforeEach, describe, it } from "vitest";
import { TemporalHarness } from "./support/temporal-harness.js";
import { runScenario, scenarios } from "./support/temporal-scenarios.js";

describe.sequential("production workflows on the time-skipping server", () => {
  let harness: TemporalHarness;
  // Time skipping is global to a server. A fresh server also prevents a closed,
  // cancelled child in one scenario from changing another scenario's clock.
  // The expensive production workflow bundle is reused across all scenarios.
  beforeEach(async () => { harness = await TemporalHarness.create(); }, 60_000);
  afterEach(async () => { await harness?.close(); }, 30_000);

  for (const scenario of scenarios) {
    it(scenario.name, async () => { await runScenario(harness, scenario); }, 30_000);
  }
});
