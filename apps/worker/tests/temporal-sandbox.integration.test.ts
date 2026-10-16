import { afterAll, beforeAll, describe } from "vitest";
import { startTemporalSandbox, stopTemporalSandbox } from "./support/temporal-sandbox.js";
import { registerTurnCases } from "./temporal-turns.cases.js";
import { registerSupervisorCases } from "./temporal-supervisor.cases.js";
import { registerMemoryCases } from "./temporal-memory.cases.js";
import { registerReplayCases } from "./temporal-replay.cases.js";

// One synthetic server and sequential scenarios: virtual time is shared, so
// concurrent cases would make time-skipping and signal assertions ambiguous.
describe.sequential("real Temporal workflow sandbox and replay gate", () => {
  beforeAll(startTemporalSandbox, 120_000);
  afterAll(stopTemporalSandbox, 30_000);
  registerTurnCases();
  registerSupervisorCases();
  registerMemoryCases();
  registerReplayCases();
});
