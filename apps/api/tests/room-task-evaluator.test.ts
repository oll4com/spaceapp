import { describe, expect, it, vi } from "vitest";
import { createRoomTaskEvaluator } from "../src/room-task-evaluator.js";

describe("Room task evaluator", () => {
  it("retries invalid JSON once and returns weighted strict rubric scores without tools", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content = requestBodies.length === 1
        ? "not-json"
        : JSON.stringify({ correctness: 90, completeness: 80, instructionAdherence: 100, evidence: 70, clarity: 90, summary: "Verified and complete." });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    });
    const evaluator = createRoomTaskEvaluator({
      baseUrl: "http://codex-lb.test/v1",
      apiKey: "test-key",
      model: "gpt-5.6-sol",
      fetch
    });

    const result = await evaluator.evaluate({ instruction: "Implement it.", finalResult: "Done.", completionEvidence: "Tests passed." });

    expect(result).toMatchObject({ available: true, qualityScore: 86.5, summary: "Verified and complete.", attempts: 2 });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies.every((body) => !("tools" in body))).toBe(true);
    expect(requestBodies[0]?.response_format).toMatchObject({ type: "json_schema" });
  });

  it("returns quality unavailable after two invalid responses", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "invalid" } }] }), { status: 200 }));
    const evaluator = createRoomTaskEvaluator({ baseUrl: "http://codex-lb.test/v1", apiKey: "test-key", model: "gpt-5.6-sol", fetch });

    await expect(evaluator.evaluate({ instruction: "Do it.", finalResult: "Done.", completionEvidence: "Verified." })).resolves.toMatchObject({
      available: false,
      attempts: 2
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("Quality evaluation budget", () => {
  const input = { instruction: "Check result", finalResult: "Answer", completionEvidence: "Receipt" };
  it.each(["request", "body"])("bounds a stalled %s and aborts without retry", async stage => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      if (stage === "request") return new Promise<Response>(() => {});
      return { ok: true, json: () => new Promise(() => {}) } as Response;
    });
    const evaluator = createRoomTaskEvaluator({ baseUrl: "http://test/v1", apiKey: "fixture", model: "judge", timeoutMs: 20, fetch });
    await expect(evaluator.evaluate(input)).resolves.toMatchObject({ available: false, attempts: 1, reason: expect.stringContaining("deadline") });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
  });
  it("does not call the provider when already cancelled", async () => {
    const fetch = vi.fn(); const controller = new AbortController(); controller.abort();
    const evaluator = createRoomTaskEvaluator({ baseUrl: "http://test/v1", apiKey: "fixture", model: "judge", fetch });
    await expect(evaluator.evaluate({ ...input, signal: controller.signal })).resolves.toMatchObject({ available: false, attempts: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cancels an in-flight request without retry", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => { controller.abort(); return new Promise<Response>(() => {}); });
    const evaluator = createRoomTaskEvaluator({ baseUrl: "http://test/v1", apiKey: "fixture", model: "judge", fetch });
    await expect(evaluator.evaluate({ ...input, signal: controller.signal })).resolves.toMatchObject({ available: false,
      attempts: 1, reason: expect.stringContaining("cancelled") });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
