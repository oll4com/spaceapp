// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/live-api.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";

afterEach(() => { vi.unstubAllGlobals(); api.setCliTerminalControlLease("pane:1", null); });
it("uses versioned managed endpoints, exact bodies and existing terminal control headers", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "execution:1" }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  api.setCliTerminalControlLease("pane:1", "lease:test");
  await api.startPlanExecution("pane:1", { planId: "plan:1", expectedSessionId: "session:1", requestId: "request:1" });
  await api.panePlanExecution("pane:1"); await api.planExecution("execution:1");
  await api.overridePlanExecutionStage("execution:1", "stage:2", { selection: null, revision: 7 }, "pane:1");
  await api.controlPlanExecution("execution:1", { action: "pause", revision: 8 }, "pane:1");
  const calls = (fetch.mock.calls as unknown as Array<[string, RequestInit]>).filter(call => call[0] !== "/api/auth/csrf");
  expect(calls.map(call => call[0])).toEqual(["/api/panes/pane%3A1/plan-executions", "/api/panes/pane%3A1/plan-executions", "/api/plan-executions/execution%3A1", "/api/plan-executions/execution%3A1/stages/stage%3A2/override", "/api/plan-executions/execution%3A1/control"]);
  expect(calls.map(call => call[1].method ?? "GET")).toEqual(["POST", "GET", "GET", "PATCH", "POST"]);
  expect(JSON.parse(String(calls[0]![1].body))).toEqual({ planId: "plan:1", expectedSessionId: "session:1", requestId: "request:1" });
  expect(JSON.parse(String(calls[3]![1].body))).toEqual({ selection: null, revision: 7 });
  expect(JSON.parse(String(calls[4]![1].body))).toEqual({ action: "pause", revision: 8 });
  expect(new Headers(calls[0]![1].headers).get("x-space-cli-control-lease-id")).toBe("lease:test");
});
it("demo discovery is local and managed start honestly refuses to execute stages", async () => {
  const { runtime } = createDemoRuntime();
  expect(await runtime.api.panePlanExecution("pane:1")).toBeNull();
  await expect(runtime.api.startPlanExecution("pane:1", { planId: "plan:1", expectedSessionId: "session:1", requestId: "request:1" })).rejects.toThrow(/live Codex session/);
  runtime.reset();
});
