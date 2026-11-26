import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOUS_ANSWERED_EXIT_MS, NOUS_FIRST_REPLY_MS, runNousTurn, type NousTurnInput } from "../src/nous-turn.js";

// Daily Nous errors 15/11 02:23Z: the turn answered at 02:10Z, its CLI stayed open and the turn ended at the 20-minute stop as a TIMEOUT.
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn }));
vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>(), mkdir: vi.fn(async () => undefined) }));

const input: NousTurnInput = {
  provider: "claude", model: "claude-opus-5-5", effort: "xhigh", claudeProfile: "crew", system: "You are Nous.", prompt: "What waits?",
  mcpUrl: "http://127.0.0.1:4911/api/cli/nous/mcp", mcpToken: "nous.abcdefghijklmnopqrstuvwxyz0123456789", maxTurns: 40, timeoutMs: 1_200_000,
  shell: false, fallbackModel: null, stream: true, caller: "nous"
};
const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "All clear.", num_turns: 2 });

function child() {
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  spawn.mockReturnValueOnce(proc);
  return proc;
}

afterEach(() => { vi.useRealTimers(); spawn.mockReset(); });

describe("a Nous turn whose CLI lingers after its answer", () => {
  it("keeps the answer and stops the CLI shortly after the result record, not at the deadline", async () => {
    vi.useFakeTimers();
    const proc = child();
    const turn = runNousTurn(input, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(`${result}\n`);
    await vi.advanceTimersByTimeAsync(NOUS_ANSWERED_EXIT_MS - 1);
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(turn).resolves.toMatchObject({ text: "All clear." });
  });

  it("still lets an exit within the grace period decide (the launcher's quota stop after the result)", async () => {
    vi.useFakeTimers();
    const proc = child();
    const turn = runNousTurn(input, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(`${result}\n`);
    proc.stderr.write("Space: no available tokens/quota for cli:claude\n");
    await vi.advanceTimersByTimeAsync(10);
    proc.emit("close", 1, null);
    await expect(turn).rejects.toThrow("no available tokens/quota");
    expect(proc.kill).not.toHaveBeenCalled();
  });
});

// Daily Nous errors 23/11 07:29-07:49Z: no request reached Space Gateway and the turn waited the whole 20 minutes for its first reply.
describe("a streamed Claude turn whose first reply never starts", () => {
  const started = `${JSON.stringify({ type: "stream_event", event: { type: "message_start" } })}\n`;

  it("fails as unavailable at the first-reply stop, not the 20-minute deadline", async () => {
    vi.useFakeTimers();
    const proc = child();
    const turn = runNousTurn(input, new AbortController().signal);
    const failed = expect(turn).rejects.toThrow(/no reply within 5 minutes.*unavailable/);
    await vi.advanceTimersByTimeAsync(NOUS_FIRST_REPLY_MS - 1);
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    await failed;
  });

  it("keeps running once the reply has started (long tool runs come after it)", async () => {
    vi.useFakeTimers();
    const proc = child();
    const turn = runNousTurn(input, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(started);
    await vi.advanceTimersByTimeAsync(NOUS_FIRST_REPLY_MS * 2);
    expect(proc.kill).not.toHaveBeenCalled();
    proc.stdout.write(`${result}\n`);
    proc.emit("close", 0, null);
    await expect(turn).resolves.toMatchObject({ text: "All clear." });
  });

  it("leaves other providers' turns to the deadline (their streams carry no message_start)", async () => {
    vi.useFakeTimers();
    const proc = child();
    const turn = runNousTurn({ ...input, provider: "codex" }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(NOUS_FIRST_REPLY_MS * 2);
    expect(proc.kill).not.toHaveBeenCalled();
    proc.stdout.write(`${result}\n`);
    proc.emit("close", 0, null);
    await expect(turn).resolves.toMatchObject({ text: "All clear." });
  });
});
