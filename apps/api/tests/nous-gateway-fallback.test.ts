import { beforeEach, describe, expect, it, vi } from "vitest";

// Stable 2026-10-24: Nous paused on exhausted direct accounts. Every turn and helper goes to Space Gateway, which serves Claude Code
// from the Claude Max pool only: the API key never serves Claude Code (operator rule 2026-10-27, packages/gateway/tests/claude-api-key.test.ts).
const post = vi.hoisted(() => vi.fn());
vi.mock("../src/nous/mcp.js", async (original) => ({ ...(await original<typeof import("../src/nous/mcp.js")>()), postToWorkerWhenUp: post }));
const { runOnWorker } = await import("../src/nous/wiring.js");

const QUOTA = "Claude Code has no available tokens/quota right now: the account quota is exhausted.";
const profiles = () => post.mock.calls.map((call) => (call[2] as { claudeProfile: string | null }).claudeProfile);

describe("Nous turns and helpers through Space Gateway", () => {
  beforeEach(() => post.mockReset());

  it("starts on Gateway without checking subscription availability; the gateway picks the Max account", async () => {
    post.mockResolvedValue({ text: "Done.", isError: false });
    // Both a turn and a helper take this route, even if an old caller supplies a direct account.
    for (const body of [{ prompt: "Turn", maxTurns: 80, stream: true }, { prompt: "Helper", maxTurns: 40, claudeProfile: "crew" }]) {
      expect(await runOnWorker(body, new AbortController().signal)).toEqual({ text: "Done.", isError: false, costUsd: null, tokens: null });
    }
    expect(profiles()).toEqual(["space-gateway", "space-gateway"]);
  });

  it("preserves the model, tools, cancellation, streamed text and usage through the gateway route", async () => {
    const signal = new AbortController().signal;
    const onText = vi.fn();
    const body = { model: "claude-opus-5-5", effort: "xhigh", fallbackModel: null, prompt: "p", system: "s", shell: true,
      stream: true, maxTurns: 80, timeoutMs: 60_000, mcpUrl: "http://localhost/api/cli/nous/mcp", mcpToken: "test-token" };
    const result = { text: "Done.", isError: false, costUsd: 0.02, tokens: { "claude-opus-5-5": { inputTokens: 10, outputTokens: 2 } } };
    post.mockImplementationOnce(async (_socket, _path, _body, _signal, _fetch, _timeout, emit) => {
      emit({ start: true });
      emit({ text: "Done." });
      return result;
    });
    expect(await runOnWorker(body, signal, onText)).toEqual(result);
    expect(post).toHaveBeenCalledExactlyOnceWith(expect.any(String), "/nous-turn", { ...body, claudeProfile: "space-gateway" }, signal,
      undefined, undefined, expect.any(Function));
    expect(onText.mock.calls).toEqual([[{ start: true }], [{ text: "Done." }]]);
  });

  it("reports gateway failures without replaying a turn on a direct account", async () => {
    for (const message of [QUOTA, "No answer within 10 minutes."]) {
      post.mockRejectedValueOnce(new Error(message));
      await expect(runOnWorker({}, new AbortController().signal)).rejects.toThrow(message);
    }
    post.mockResolvedValueOnce({ text: QUOTA, isError: true });
    expect(await runOnWorker({}, new AbortController().signal)).toMatchObject({ text: QUOTA, isError: true });
    expect(profiles()).toEqual(["space-gateway", "space-gateway", "space-gateway"]);
  });
});
