import { afterAll, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import { captureSentryProcessGone, flushSentry, initNodeSentry } from "../src/sentry-node.js";

// Own file: initNodeSentry initializes once per process.
const captured = vi.hoisted(() => ({ envelopes: [] as unknown[] }));
vi.mock("@sentry/node", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@sentry/node")>();
  return { ...sdk, init: vi.fn((options) => sdk.init({ ...options, transport: () => ({
    send: async (envelope: unknown) => { captured.envelopes.push(envelope); return { statusCode: 200 }; },
    flush: async () => true
  }) })) };
});
afterAll(async () => { await Sentry.close(); });

it("reports a crashed desktop process with its version and reason, and keeps the main process alive on rejections", async () => {
  captureSentryProcessGone("RenderProcessGone", "crashed");
  expect(Sentry.init).not.toHaveBeenCalled();
  expect(initNodeSentry("desktop", { SENTRY_DSN_DESKTOP: "https://public@example.invalid/7" }, "0.1.27")).toBe(true);
  const rejection = (vi.mocked(Sentry.init).mock.calls[0]![0]!.integrations as Array<{ name: string }>).find((item) => item.name === "OnUnhandledRejection");
  expect(rejection).toBeDefined();
  captureSentryProcessGone("RenderProcessGone", "crashed");
  await flushSentry();
  type EventEnvelope = [unknown, Array<[{ type: string }, Sentry.Event]>];
  const events = (captured.envelopes as EventEnvelope[]).flatMap((envelope) => envelope[1].filter((item) => item[0].type === "event").map((item) => item[1]));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ dist: "0.1.27", level: "fatal", environment: "stable", tags: { reason: "crashed", service: "desktop" },
    exception: { values: [{ type: "RenderProcessGone", value: "[Filtered]" }] } });
});
