import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { captureSentryException } from "@space/contracts/sentry-node";
import { internalErrorText, registerApiErrorHandler } from "../src/api-error-handler.js";
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

it("keeps a 500's cause for the in-process caller only, first line and redacted (Daily Nous errors 14/11, copilot_control)", async () => {
  const app = Fastify();
  registerApiErrorHandler(app);
  app.post("/session", async () => { throw new TypeError("host said token=abcd1234efgh\nstack line"); });
  try {
    const response = await app.inject({ method: "POST", url: "/session" });
    expect(response.json().error.message).toBe("The request could not be completed.");
    expect(internalErrorText("POST", "/session?x=1", response)).toBe("NOT CONFIRMED POST /session: TypeError: host said token=[REDACTED]. It may have run in part: read the pane before repeating it.");
    expect(internalErrorText("GET", "/missing", await app.inject({ url: "/missing" }))).toBeNull();
  } finally { await app.close(); }
});
