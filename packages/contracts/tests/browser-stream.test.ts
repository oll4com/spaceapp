import { describe, expect, it } from "vitest";
import {
  browserRuntimeInputSchema,
  browserStreamTicketResponseSchema,
  browserStreamWebSocketClientMessageSchema,
  browserStreamWebSocketServerMessageSchema
} from "../src/index.js";

const requestId = "browser-input-request:0001";

describe("browser realtime stream contracts", () => {
  it("validates the shared high-fidelity browser input boundary", () => {
    const input = browserRuntimeInputSchema.parse({
      type: "POINTER",
      leaseId: "browser_lease:test",
      eventType: "mouseWheel",
      x: 720,
      y: 450,
      button: "none",
      deltaX: 3,
      deltaY: 120,
      modifiers: 2
    });

    expect(input).toMatchObject({
      type: "POINTER",
      eventType: "mouseWheel",
      x: 720,
      y: 450,
      deltaY: 120
    });
    expect(() => browserRuntimeInputSchema.parse({ ...input, x: 10_001 })).toThrow();
  });

  it("accepts only bounded input messages from a stream client", () => {
    const message = browserStreamWebSocketClientMessageSchema.parse({
      type: "input",
      requestId,
      input: {
        type: "KEY",
        leaseId: "browser_lease:test",
        eventType: "keyDown",
        key: "a",
        code: "KeyA",
        text: "a"
      }
    });

    expect(message).toMatchObject({ type: "input", requestId, input: { type: "KEY", key: "a" } });
    expect(() => browserStreamWebSocketClientMessageSchema.parse({ ...message, unexpected: true })).toThrow();
    expect(() =>
      browserStreamWebSocketClientMessageSchema.parse({
        ...message,
        input: { ...message.input, text: "x".repeat(4_001) }
      })
    ).toThrow();
  });

  it("validates ready and sanitized input acknowledgement messages", () => {
    const ready = browserStreamWebSocketServerMessageSchema.parse({
      type: "ready",
      paneId: "pane:browser-test",
      sessionId: "browser_session:test",
      streamId: "browser_stream:test",
      encoding: "image/jpeg",
      requestedMode: "AUTO",
      resolvedMode: "INTERACTIVE",
      framesPerSecond: 10
    });
    const success = browserStreamWebSocketServerMessageSchema.parse({
      type: "inputAck",
      requestId,
      ok: true,
      serverDurationMs: 7
    });
    const failure = browserStreamWebSocketServerMessageSchema.parse({
      type: "inputAck",
      requestId,
      ok: false,
      serverDurationMs: 2,
      error: {
        code: "BROWSER_INPUT_REJECTED",
        message: "A valid active control lease is required."
      }
    });

    expect(ready).toMatchObject({ type: "ready", encoding: "image/jpeg", framesPerSecond: 10 });
    expect(success).toEqual({ type: "inputAck", requestId, ok: true, serverDurationMs: 7 });
    expect(failure).toMatchObject({ type: "inputAck", requestId, ok: false, error: { code: "BROWSER_INPUT_REJECTED" } });
    expect(() =>
      browserStreamWebSocketServerMessageSchema.parse({
        type: "inputAck",
        requestId,
        ok: false,
        serverDurationMs: 2,
        error: {
          code: "BROWSER_INPUT_REJECTED",
          message: "A valid active control lease is required.",
          details: { leaseId: "secret" }
        }
      })
    ).toThrow();
  });

  it("returns a fresh one-time stream ticket in a stable response envelope", () => {
    const response = browserStreamTicketResponseSchema.parse({
      websocket: {
        paneId: "pane:browser-test",
        sessionId: "browser_session:test",
        token: "browser-stream-ticket-test-value",
        expiresAt: "2026-07-18T12:00:00.000Z"
      }
    });

    expect(response.websocket).toMatchObject({
      paneId: "pane:browser-test",
      sessionId: "browser_session:test"
    });
  });
});
