import { it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundle, Harness } from "./support/temporal/harness.js";
import { basicScenarios } from "./support/temporal/basic-scenarios.js";
import { supervisorScenarios } from "./support/temporal/supervisor-scenarios.js";

it("executes all workflow families and regression paths in a real time-skipping sandbox", async () => {
  const code = await bundle();
  const h = new Harness(await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "synthetic-temporal-client" } }));
  try {
    await h.startWorkers(code, "synthetic-current");
    await basicScenarios(h, "synthetic-current", () => undefined);
    await supervisorScenarios(h, "synthetic-current", () => undefined);
  } finally { await h.close(); }
}, 180_000);

it("runs the preserved pre-patch supervisor source with real timers, signals, children and continue-as-new", async () => {
  const h = new Harness(await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "synthetic-temporal-client" } }));
  try {
    await h.startWorkers(await bundle("legacy"), "synthetic-legacy");
    await supervisorScenarios(h, "synthetic-legacy", () => undefined, true);
  } finally { await h.close(); }
}, 120_000);
