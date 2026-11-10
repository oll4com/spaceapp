import { afterEach, describe, expect, it, vi } from "vitest";

// OBS-011: the worker's free-text log lines never carry a failure's credentials or database text.
const activities: Record<string, (...args: any[]) => Promise<any>> = {};
vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => new Proxy({}, { get: (_, name) => (...args: any[]) => activities[String(name)]!(...args) }),
  executeChild: async () => undefined
}));
import { memoryMaintenanceWorkflow } from "../src/memory-maintenance-workflows.js";
import { StreamingBotLoop } from "../src/streaming-bot-runtime.js";

afterEach(() => vi.restoreAllMocks());

describe("worker free-text log redaction (OBS-011)", () => {
  it("logs only the activity failure's type when a maintenance step fails, never its message", async () => {
    const leak = "password=hunter22secret relation memory_records row 'private memory text'";
    const failure = Object.assign(new Error(`Activity task failed: ${leak}`), { name: "ActivityFailure", cause: { type: "DatabaseError", message: leak } });
    Object.assign(activities, {
      refreshMemoryGraphSnapshot: async () => ({ sourceHash: "a".repeat(64) }),
      refreshAllMonthsMemoryGraphSnapshot: async () => { throw failure; },
      reconcileStaleSpaceAgentSessions: async () => { throw new Error(leak); },
      createScheduledMemoryAudit: async () => ({ id: "memory_audit:1", workflowId: "memory-consolidation:1" })
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await memoryMaintenanceWorkflow({ traceId: "req:obs-011" } as never);
    expect(warn.mock.calls.map((call) => call[1])).toEqual([{ failure: "DatabaseError" }, { failure: "Error" }]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/hunter22|private memory text|memory_records/);
  });

  it("redacts credential-shaped text in a failed streaming bot cycle", async () => {
    const records: Array<Record<string, unknown>> = [];
    const loop = new StreamingBotLoop({
      intervalMs: 60_000,
      runCycle: async () => { throw new Error("YouTube answered 401 for Bearer ya29abcdef123456 with access_token=tok-abcdef123"); }, // synthetic tokens the redaction must hide; gitleaks:allow
      log: (record) => records.push(record)
    });
    await loop.runOnce();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "FAILED" });
    expect(String(records[0]!.error)).toContain("YouTube answered 401");
    expect(String(records[0]!.error)).not.toMatch(/ya29abcdef123456|tok-abcdef123/);
  });
});
