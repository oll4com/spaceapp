import { describe, expect, it } from "vitest";
import {
  ALLOWED_SPAN_ATTRIBUTE_KEYS,
  isAllowlistedSpanAttributeKey,
  sanitizeSpanAttributes,
  sanitizeSpanAttributeValue
} from "@space/runtime";

describe("span attributes allowlist enforcement", () => {
  it("allows safe identifiers, types, status codes, outcomes, and durations", () => {
    const rawAttributes = {
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.workflow_id": "workflow:codex-app-server:room:alpha:pane:one:req:123",
      "space.run_id": "agent_run:123456",
      "space.temporal_run_id": "8bb3845b-6fcf-49b8-a773-5ca733cbef89",
      "space.activity_type": "runCodexAppServerTurn",
      "space.activity_id": "3",
      "space.room_id": "room:alpha",
      "space.pane_id": "pane:one",
      "space.mission_id": "mission:xyz",
      "space.turn_id": "turn:abc",
      "space.goal_id": "goal:test",
      "space.dot_id": "dot:1",
      "space.attempt": 1,
      "space.status": "COMPLETED",
      "space.outcome": "COMPLETED",
      "space.duration_ms": 250,
      "space.queue_ms": 15,
      "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT",
      "space.category": "TIMEOUT",
      "http.request.method": "POST",
      "http.route": "/api/rooms/:roomId/turns",
      "http.response.status_code": 200,
      "link.reason": "continue_as_new"
    };

    const sanitized = sanitizeSpanAttributes(rawAttributes);
    expect(sanitized).toEqual(rawAttributes);
  });

  it("strictly rejects prompts, model outputs, free text, credentials, and error messages", () => {
    const forbiddenAttributes = {
      // Forbidden keys
      "prompt": "deploy with token sk-live-secret-12345",
      "space.prompt": "Write a python script to hack NASA",
      "model_output": "Here is your requested response with full details...",
      "user_message": "Can you help me solve this problem?",
      "error_message": "Uncaught TypeError: Cannot read properties of undefined (reading 'foo')",
      "file_path": "/var/log/secret/passwords.txt",
      "url": "https://api.openai.com/v1/chat/completions",
      "headers.authorization": "Bearer sk-live-secret",

      // Allowed keys with forbidden values (e.g. text containing spaces, newlines, paths, or URLs)
      "space.workflow_id": "workflow id with spaces in it",
      "space.reason_code": "Error: database connection timeout occurred at 10.0.0.1",
      "space.room_id": "https://evil.com/leak?room=1",
      "space.mission_id": "multi\nline\nprompt\ntext",
      "space.turn_id": "/etc/passwd",
      "space.activity_type": "Prompt: deploy the following code...",
      "http.route": "https://evil.com/path",
      "space.duration_ms": Number.NaN
    };

    const sanitized = sanitizeSpanAttributes(forbiddenAttributes);
    expect(sanitized).toEqual({});
  });

  it("checks individual key allowlisting", () => {
    expect(isAllowlistedSpanAttributeKey("space.workflow_type")).toBe(true);
    expect(isAllowlistedSpanAttributeKey("space.activity_type")).toBe(true);
    expect(isAllowlistedSpanAttributeKey("space.attempt")).toBe(true);
    expect(isAllowlistedSpanAttributeKey("prompt")).toBe(false);
    expect(isAllowlistedSpanAttributeKey("content")).toBe(false);
    expect(isAllowlistedSpanAttributeKey("message")).toBe(false);
    expect(isAllowlistedSpanAttributeKey("user_input")).toBe(false);
  });

  it("enforces safe error code format for space.reason_code", () => {
    expect(sanitizeSpanAttributeValue("space.reason_code", "CODEX_TURN_FAILED")).toBe("CODEX_TURN_FAILED");
    expect(sanitizeSpanAttributeValue("space.reason_code", "failed because of connection reset by peer")).toBeNull();
    expect(sanitizeSpanAttributeValue("space.reason_code", "TOKEN=sk-live-123")).toBeNull();
  });
});
