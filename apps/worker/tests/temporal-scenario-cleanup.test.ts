import assert from "node:assert/strict";
import { afterEach, it, vi } from "vitest";
import type { TemporalSandbox } from "./support/temporal-sandbox.js";
import { runScenario } from "./support/temporal-scenarios.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

for (const diagnosticFailure of ["rejects", "never responds"] as const) {
  it(`preserves the scenario error and closes when a diagnostic ${diagnosticFailure}`, async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = Error("Synthetic original scenario failure");
    const close = vi.fn(async () => {});
    const sandbox = {
      open: async () => {}, close,
      handles: [
        { workflowId: "synthetic-broken-history", fetchHistory: () => diagnosticFailure === "rejects"
          ? Promise.reject(Error("Synthetic history connection failure")) : new Promise<never>(() => {}) },
        { workflowId: "synthetic-readable-history", fetchHistory: async () => ({ events: [] }) }
      ]
    } as unknown as TemporalSandbox;

    const result = runScenario(sandbox, { name: "synthetic failing scenario", run: async () => { throw original; } });
    const rejected = assert.rejects(result, error => error === original);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;

    assert.equal(close.mock.calls.length, 1);
    assert(log.mock.calls.some(call => call[0] === "Synthetic scenario diagnostic unavailable"));
    assert(log.mock.calls.some(call => call[0] === "Synthetic scenario diagnostic"));
    assert.equal(vi.getTimerCount(), 0, "All diagnostic and scenario deadlines must be cleared");
  });
}
