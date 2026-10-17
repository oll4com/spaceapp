import { describe, expect, it } from "vitest";
import {
  ALLOWLISTED_ATTRIBUTE_KEYS,
  allowlistSpanAttributes,
  runIdToSpanId
} from "../src/otlp-attributes.js";

describe("OTLP attributes allowlist and ID sanitization (Issue #61)", () => {
  it("derives valid, deterministic 16-hex span IDs from Temporal execution run IDs", () => {
    const runId1 = "d87f98e6-1234-4567-89ab-cdef01234567";
    const spanId1 = runIdToSpanId(runId1);
    expect(spanId1).toHaveLength(16);
    expect(spanId1).toBe("d87f98e612344567");
    expect(/^[0-9a-f]{16}$/.test(spanId1)).toBe(true);

    // Consistency
    expect(runIdToSpanId(runId1)).toBe(spanId1);

    // All zero fallback
    const allZeroRunId = "00000000-0000-0000-0000-000000000000";
    const fallbackSpanId = runIdToSpanId(allZeroRunId);
    expect(fallbackSpanId).toBe("0000000000000001");
    expect(fallbackSpanId).toHaveLength(16);

    // Short ID padding
    const shortRunId = "a1b2c3";
    expect(runIdToSpanId(shortRunId)).toBe("a1b2c30000000000");
  });

  it("strictly enforces the attribute allowlist and drops unapproved keys", () => {
    const raw = {
      "service.name": "space-worker",
      "space.workflow_type": "roomAgentSupervisorWorkflow",
      "space.activity_type": "runTurn",
      "space.outcome": "COMPLETED",
      "space.attempt": 1,
      "space.duration_ms": 350,
      "temporal.workflow_id": "workflow:room-1",
      "temporal.run_id": "run-123",
      // Disallowed attributes (prompts, user data, model outputs, arbitrary keys)
      prompt: "Please write a function that uploads secrets to https://example.com",
      user_prompt: "Delete database table users",
      assistant_output: "Here is your output",
      errorMessage: "Connection refused at 10.0.0.1:5432",
      auth_token: "sk-live-123456789",
      secret_header: "Bearer token",
      custom_data: { some: "object" }
    };

    const sanitized = allowlistSpanAttributes(raw);

    // Permitted keys
    expect(sanitized["service.name"]).toBe("space-worker");
    expect(sanitized["space.workflow_type"]).toBe("roomAgentSupervisorWorkflow");
    expect(sanitized["space.activity_type"]).toBe("runTurn");
    expect(sanitized["space.outcome"]).toBe("COMPLETED");
    expect(sanitized["space.attempt"]).toBe(1);
    expect(sanitized["space.duration_ms"]).toBe(350);
    expect(sanitized["temporal.workflow_id"]).toBe("workflow:room-1");
    expect(sanitized["temporal.run_id"]).toBe("run-123");

    // Prohibited keys must be stripped
    expect(sanitized).not.toHaveProperty("prompt");
    expect(sanitized).not.toHaveProperty("user_prompt");
    expect(sanitized).not.toHaveProperty("assistant_output");
    expect(sanitized).not.toHaveProperty("errorMessage");
    expect(sanitized).not.toHaveProperty("auth_token");
    expect(sanitized).not.toHaveProperty("secret_header");
    expect(sanitized).not.toHaveProperty("custom_data");

    for (const key of Object.keys(sanitized)) {
      expect(ALLOWLISTED_ATTRIBUTE_KEYS.has(key)).toBe(true);
    }
  });

  it("drops URLs, filesystem paths, and multiline text even if assigned to an allowlisted key", () => {
    const attackPayload = {
      "space.room_id": "https://malicious-site.com/steal?token=123",
      "space.pane_id": "/etc/passwd",
      "space.mission_id": "C:\\Windows\\System32\\cmd.exe",
      "space.turn_id": "line1\nline2\nline3",
      "space.action_id": "safe_action_123"
    };

    const sanitized = allowlistSpanAttributes(attackPayload);

    expect(sanitized).not.toHaveProperty("space.room_id");
    expect(sanitized).not.toHaveProperty("space.pane_id");
    expect(sanitized).not.toHaveProperty("space.mission_id");
    expect(sanitized).not.toHaveProperty("space.turn_id");
    expect(sanitized["space.action_id"]).toBe("safe_action_123");
  });
});
