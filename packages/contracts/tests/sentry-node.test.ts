import { afterAll, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import { captureSentryException, createSentryTrace, flushSentry, initNodeSentry } from "../src/sentry-node.js";

const captured = vi.hoisted(() => ({ envelopes: [] as unknown[] }));
vi.mock("@sentry/node", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@sentry/node")>();
  return { ...sdk, init: vi.fn((options) => sdk.init({ ...options, transport: () => ({
    send: async (envelope: unknown) => { captured.envelopes.push(envelope); return { statusCode: 200 }; },
    flush: async () => true
  }) })) };
});
afterAll(async () => { await Sentry.close(); });

it("sends nothing and installs no handlers without a service DSN, then sends scrubbed, correlated SDK envelopes", async () => {
  const listeners = process.listenerCount("uncaughtException");
  expect(initNodeSentry("api", {})).toBe(false);
  captureSentryException(new Error("disabled secret"));
  await flushSentry();
  expect(Sentry.init).not.toHaveBeenCalled();
  expect(process.listenerCount("uncaughtException")).toBe(listeners);
  expect(captured.envelopes).toEqual([]);
  expect(initNodeSentry("api", { SENTRY_DSN_API: "https://public@example.invalid/42", SENTRY_RELEASE: "a".repeat(40), SPACE_INSTANCE: "dev" })).toBe(true);
  const first = createSentryTrace("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01");
  const second = createSentryTrace();
  captureSentryException(new TypeError("Bearer private-token; prompt text; mail body; 192.0.2.5"), first);
  captureSentryException(new Error("opaque Vault value"), second);
  await flushSentry();
  type EventEnvelope = [unknown, Array<[{ type: string }, Sentry.Event]>];
  const events = (captured.envelopes as EventEnvelope[]).flatMap((envelope) => envelope[1].filter((item) => item[0].type === "event").map((item) => item[1]));
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ release: "a".repeat(40), environment: "dev", tags: { service: "api" }, contexts: { trace: first } });
  expect(events[1]!.contexts!.trace).toEqual(second);
  const wire = JSON.stringify(captured.envelopes);
  for (const value of ["private-token", "prompt text", "mail body", "192.0.2.5", "opaque Vault value"]) expect(wire).not.toContain(value);
  expect(events[0]).not.toHaveProperty("server_name");
  expect(events[0]).not.toHaveProperty("user");
});

it("retains a valid parent trace, generates a fresh span, and rejects malformed or all-zero parents", () => {
  const parent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
  const first = createSentryTrace(parent), second = createSentryTrace(parent);
  expect(first.trace_id).toBe("0123456789abcdef0123456789abcdef");
  expect(first.span_id).not.toBe(second.span_id);
  expect(createSentryTrace("00-" + "0".repeat(32) + "-" + "0".repeat(16) + "-01").trace_id).not.toBe("0".repeat(32));
  expect(createSentryTrace("private prompt").trace_id).toMatch(/^[a-f0-9]{32}$/);
});
