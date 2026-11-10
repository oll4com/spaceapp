import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { captureSentryException } from "@space/contracts/sentry-node";
import { registerApiErrorHandler } from "../src/api-error-handler.js";
vi.mock("@space/contracts/sentry-node", () => ({ captureSentryException: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it("reports unexpected API errors with isolated W3C ids, excludes request content and leaves client errors alone", async () => {
  const app = Fastify();
  registerApiErrorHandler(app);
  app.get("/failure", async () => { throw new Error("private message"); });
  app.get("/bad-request", async () => { throw Object.assign(new Error("bad input"), { statusCode: 400 }); });
  try {
    const [first, second] = await Promise.all([
      app.inject({ url: "/failure?prompt=private", headers: { authorization: "Bearer private", traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" } }),
      app.inject({ url: "/failure" })
    ]);
    expect(first.statusCode).toBe(500);
    expect(second.statusCode).toBe(500);
    expect(first.body).not.toContain("private message");
    const calls = vi.mocked(captureSentryException).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toEqual({ trace_id: "0123456789abcdef0123456789abcdef", span_id: expect.stringMatching(/^[a-f0-9]{16}$/) });
    expect(calls[1]![1]!.trace_id).not.toBe(calls[0]![1]!.trace_id);
    expect(JSON.stringify(calls.map((call) => call[1]))).not.toContain("private");
    expect((await app.inject({ url: "/bad-request" })).statusCode).toBe(400);
    expect(captureSentryException).toHaveBeenCalledTimes(2);
  } finally { await app.close(); }
});
