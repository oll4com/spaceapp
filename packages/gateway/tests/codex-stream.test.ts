import { describe, expect, it } from "vitest";
import { buildCodexUpstreamHeaders } from "../src/providers/codex/headers.js";
import { readCodexRateLimitEvent, readCodexRateLimitHeaders, ResponseStreamInspector } from "../src/providers/codex/stream.js";
import { parseCodexUsage } from "../src/providers/codex/usage.js";

const encoder = new TextEncoder();
const event = (type: string, body: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;

describe("Responses stream inspection", () => {
  it("marks output start after pre-output events and reads terminal usage", () => {
    const inspector = new ResponseStreamInspector();
    expect(inspector.push(encoder.encode(event("response.created", { response: { id: "resp_1", model: "gpt-5.6-sol", service_tier: "priority" } })))).toBe(false);
    expect(inspector.outputStarted).toBe(false);
    // An event split across chunks is parsed once it is complete.
    const delta = event("response.output_text.delta", { delta: "Hi" });
    expect(inspector.push(encoder.encode(delta.slice(0, 10)))).toBe(false);
    expect(inspector.push(encoder.encode(delta.slice(10)))).toBe(true);
    expect(inspector.push(encoder.encode(event("response.output_text.delta", { delta: "!" })))).toBe(false);
    inspector.push(encoder.encode(event("response.completed", { response: { id: "resp_1", model: "gpt-5.6-sol",
      usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 30 } } } })));
    expect(inspector.outcome).toEqual({ status: "success", model: "gpt-5.6-sol", serviceTier: "priority", responseId: "resp_1",
      usage: { inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 80, reasoningTokens: 30 }, errorCode: null, errorMessage: null });
  });

  it("keeps missing usage unknown and records failures", () => {
    const inspector = new ResponseStreamInspector();
    inspector.push(encoder.encode(event("response.failed", { response: { error: { code: "usage_limit_reached", message: "limit" } } })));
    expect(inspector.outcome).toMatchObject({ status: "failed", errorCode: "usage_limit_reached", errorMessage: "limit", usage: null });
    expect(inspector.outputStarted).toBe(false);
    const errored = new ResponseStreamInspector();
    errored.push(encoder.encode("data: {\"type\":\"error\",\"error\":{\"code\":\"rate_limit_exceeded\",\"message\":\"Try again in 5s\"}}\r\n\r\n"));
    expect(errored.outcome).toMatchObject({ status: "failed", errorCode: "rate_limit_exceeded" });
    const partial = new ResponseStreamInspector();
    partial.push(encoder.encode(event("response.output_text.delta", { delta: "x" })));
    expect(partial.outcome.status).toBe("unterminated");
  });

  it("reads passive x-codex usage headers", () => {
    const headers = new Headers({ "x-codex-primary-used-percent": "37.5", "x-codex-secondary-used-percent": "12", "x-codex-primary-reset-after-seconds": "600", "x-codex-secondary-window-minutes": "" });
    expect(readCodexRateLimitHeaders(headers)).toEqual({ primaryUsedPercent: 37.5, secondaryUsedPercent: 12, primaryResetAfterSeconds: 600,
      secondaryResetAfterSeconds: null, primaryWindowMinutes: null, secondaryWindowMinutes: null });
    // A Prolite account (weekly window only) gets its missing window as 0 minutes, 0% and reset 0: read as absent, and its week,
    // reported as the primary window, lands in the weekly slot (niggmopai, 2026-10-27).
    const prolite = new Headers({ "x-codex-primary-used-percent": "39", "x-codex-primary-window-minutes": "10080", "x-codex-primary-reset-after-seconds": "600",
      "x-codex-secondary-used-percent": "0", "x-codex-secondary-window-minutes": "0", "x-codex-secondary-reset-after-seconds": "0" });
    expect(readCodexRateLimitHeaders(prolite)).toEqual({ primaryUsedPercent: null, secondaryUsedPercent: 39, primaryResetAfterSeconds: null,
      secondaryResetAfterSeconds: 600, primaryWindowMinutes: null, secondaryWindowMinutes: 10080 });
    expect(readCodexRateLimitEvent({ rate_limits: { primary: { used_percent: 39, window_minutes: 10080 }, secondary: { used_percent: 0, window_minutes: 0, reset_at: 5 } } }, 0))
      .toMatchObject({ primaryUsedPercent: null, secondaryUsedPercent: 39, primaryWindowMinutes: null, secondaryWindowMinutes: 10080 });
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 8, reset_at: 2_000_000_000, limit_window_seconds: 604_800 } } }))
      .toMatchObject({ primary: null, secondary: { usedPercent: 8, resetAt: 2_000_000_000, limitWindowSeconds: 604_800 } });
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 61, limit_window_seconds: 18_000 }, secondary_window: { used_percent: 45, limit_window_seconds: 604_800 } } }))
      .toMatchObject({ primary: { usedPercent: 61 }, secondary: { usedPercent: 45 } });
  });
});

describe("Codex upstream headers", () => {
  it("replaces credentials, keeps the client's own identity and drops proxy headers", () => {
    const headers = buildCodexUpstreamHeaders({
      authorization: "Bearer sk-sgw-client", "chatgpt-account-id": "spoofed", "user-agent": "codex_cli_rs/0.150.1 (Linux; x86_64)",
      originator: "codex_cli_rs", version: "0.150.1", session_id: "s-1", "x-codex-turn-state": "ts", "x-forwarded-for": "10.0.0.1",
      "cf-ray": "1", host: "127.0.0.1:4920", "content-length": "10", connection: "keep-alive, x-private", "x-private": "1",
      "x-space-gateway-compression": "off", cookie: "a=b", accept: "*/*", "content-type": "text/plain"
    }, "access-123", "acct-1");
    expect(headers).toEqual({
      "user-agent": "codex_cli_rs/0.150.1 (Linux; x86_64)", originator: "codex_cli_rs", version: "0.150.1", session_id: "s-1",
      "x-codex-turn-state": "ts", authorization: "Bearer access-123", accept: "text/event-stream", "content-type": "application/json",
      "chatgpt-account-id": "acct-1"
    });
    expect(buildCodexUpstreamHeaders({}, "t", "local_x")).not.toHaveProperty("chatgpt-account-id");
  });
});
