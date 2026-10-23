import { WorkflowNotFoundError } from "@temporalio/client";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { expect, it, vi } from "vitest";
import { runScenario } from "./trace-contracts/harness.js";

// Fault injection for cleanup only; real workers and replay are covered by the
// separate workflow-trace-contracts suite.
vi.mock("@temporalio/worker", async importOriginal => ({
  ...await importOriginal<typeof import("@temporalio/worker")>(),
  bundleWorkflowCode: vi.fn(async () => ({ code: "" })),
  Worker: {
    create: vi.fn(async () => ({
      runUntil: async (run: () => Promise<void>) => run(),
      getState: () => "STOPPED"
    }))
  }
}));

function cleanupCase(terminators: Array<() => Promise<void>>) {
  const handles = terminators.map(terminate => ({ terminate: vi.fn(terminate) }));
  let next = 0;
  const env = {
    client: { workflow: { start: async () => handles[next++]! } }
  } as unknown as TestWorkflowEnvironment;
  return {
    handles,
    run: (failure?: { error: unknown }) => runScenario(env, {
      name: "cleanup fault injection",
      workflowType: "syntheticWorkflow",
      async run(ctx) {
        for (let index = 0; index < handles.length; index++) await ctx.start("syntheticWorkflow", {});
        if (failure) throw failure.error;
      }
    })
  };
}

it.each([
  { label: "an assertion error", error: Error("original scenario failure") },
  { label: "a falsy thrown value", error: undefined }
])("preserves $label and attempts every termination after cleanup failures", async ({ error }) => {
  const fixture = cleanupCase([
    async () => { throw Error("first termination failed"); },
    async () => {},
    async () => { throw Error("last termination failed"); }
  ]);
  await expect(fixture.run({ error })).rejects.toBe(error);
  for (const handle of fixture.handles) {
    expect(handle.terminate).toHaveBeenCalledExactlyOnceWith("Synthetic contract test completed");
  }
});

it("reports all cleanup failures when the scenario succeeded", async () => {
  const first = Error("first termination failed");
  const last = Error("last termination failed");
  const fixture = cleanupCase([
    async () => { throw first; },
    async () => {},
    async () => { throw last; }
  ]);
  await expect(fixture.run()).rejects.toMatchObject({
    name: "AggregateError",
    message: "Failed to terminate owned workflows in cleanup fault injection",
    errors: [first, last]
  });
  for (const handle of fixture.handles) expect(handle.terminate).toHaveBeenCalledOnce();
});

it("ignores already-closed workflows and still terminates the remaining handles", async () => {
  const fixture = cleanupCase([
    async () => { throw new WorkflowNotFoundError("Already closed", "synthetic-workflow", undefined); },
    async () => {}
  ]);
  await expect(fixture.run()).resolves.toEqual([]);
  for (const handle of fixture.handles) expect(handle.terminate).toHaveBeenCalledOnce();
});

it("returns normally when the scenario and cleanup succeed", async () => {
  const fixture = cleanupCase([async () => {}, async () => {}]);
  await expect(fixture.run()).resolves.toEqual([]);
  for (const handle of fixture.handles) expect(handle.terminate).toHaveBeenCalledOnce();
});
