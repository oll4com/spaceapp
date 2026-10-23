import { describe, expect, it } from "vitest";
import {
  allowlistedAttributes,
  isAllowedSpanAttribute,
  workflowSpanIdForRun
} from "../src/workflow-observability.js";

describe("workflowSpanIdForRun", () => {
  it("derives a deterministic 16-hex span id from a run id", () => {
    const runId = "3b2a1f4e-8c7d-4a1b-9e2f-5d6c7b8a9e0f";
    const first = workflowSpanIdForRun(runId);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(workflowSpanIdForRun(runId)).toBe(first);
    expect(workflowSpanIdForRun(runId.toUpperCase())).toBe(first);
  });

  it("gives different runs different span ids", () => {
    expect(workflowSpanIdForRun("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).not.toBe(
      workflowSpanIdForRun("11111111-2222-3333-4444-555555555555")
    );
  });

  it("never returns an all-zero span id", () => {
    expect(workflowSpanIdForRun("00000000-0000-0000-0000-000000000000")).toBe("f".repeat(16));
  });
});

describe("span attribute allowlist", () => {
  it("allows only allowlisted keys with identifier or integer values", () => {
    expect(isAllowedSpanAttribute("workflow", "space.trace_id", "req:abcdefghijkl")).toBe(true);
    expect(isAllowedSpanAttribute("workflow", "space.status", "COMPLETED")).toBe(true);
    expect(isAllowedSpanAttribute("activity", "space.activity_type", "runCodexAppServerTurn")).toBe(true);
    expect(isAllowedSpanAttribute("activity", "space.attempt", 2)).toBe(true);
  });

  it("rejects non-allowlisted keys", () => {
    expect(isAllowedSpanAttribute("workflow", "space.prompt", "hello")).toBe(false);
    expect(isAllowedSpanAttribute("activity", "http.url", "http://example.com")).toBe(false);
    expect(isAllowedSpanAttribute("workflow", "space.error_message", "boom")).toBe(false);
  });

  it("rejects values that are not identifiers", () => {
    expect(isAllowedSpanAttribute("workflow", "space.trace_id", "has spaces")).toBe(false);
    expect(isAllowedSpanAttribute("workflow", "space.trace_id", "../../../etc/passwd")).toBe(false);
    expect(isAllowedSpanAttribute("activity", "space.reason_code", "Error: something failed")).toBe(false);
    expect(isAllowedSpanAttribute("workflow", "space.attempt", 1.5)).toBe(false);
  });

  it("drops non-allowlisted entries via allowlistedAttributes", () => {
    const secretPrompt = "PRIVATE PROMPT: deploy with token sk-live-123";
    const attributes = allowlistedAttributes("workflow", [
      ["space.trace_id", "req:abcdefghijkl"],
      ["space.workflow_type", "codexAppServerTurnWorkflow"],
      ["space.prompt", secretPrompt],
      ["space.error_message", "boom"],
      ["space.room_id", "room:alpha01"],
      ["space.custom", "value"],
      ["space.status", "COMPLETED"],
      ["space.null_value", null],
      ["space.undefined_value", undefined]
    ]);
    expect(attributes).toEqual({
      "space.trace_id": "req:abcdefghijkl",
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.room_id": "room:alpha01",
      "space.status": "COMPLETED"
    });
    expect(JSON.stringify(attributes)).not.toContain("sk-live-123");
  });

  it("enforces the allowlist on activity attributes", () => {
    const attributes = allowlistedAttributes("activity", [
      ["space.activity_type", "runCodexAppServerTurn"],
      ["space.outcome", "COMPLETED"],
      ["space.attempt", 1],
      ["space.reason_code", "ACTIVITY_TIMEOUT"],
      ["space.category", "TIMEOUT"],
      ["space.workflow_type", "codexAppServerTurnWorkflow"],
      ["space.run_id", "run-uuid-1"],
      ["space.file_path", "/etc/passwd"],
      ["space.url", "https://example.com/secret"]
    ]);
    expect(attributes).toEqual({
      "space.activity_type": "runCodexAppServerTurn",
      "space.outcome": "COMPLETED",
      "space.attempt": 1,
      "space.reason_code": "ACTIVITY_TIMEOUT",
      "space.category": "TIMEOUT",
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.run_id": "run-uuid-1"
    });
  });
});
