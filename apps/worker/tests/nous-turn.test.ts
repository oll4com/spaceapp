import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startChessMoveServer } from "../src/chess-cli-move.js";
import { NOUS_TURN_MAX_BODY_BYTES, type NousTurnInput, NousTurnInputError, parseNousTurnOutput, readNousStreamLine, splitNousStreamLines, validateNousTurnInput } from "../src/nous-turn.js";

const base: NousTurnInput = {
  model: "claude-opus-5-5", effort: "xhigh", claudeProfile: "crew", system: "You are Nous.", prompt: "What waits?",
  mcpUrl: "http://127.0.0.1:4911/api/cli/nous/mcp", mcpToken: "nous.abcdefghijklmnopqrstuvwxyz0123456789", maxTurns: 40, timeoutMs: 1_200_000, shell: false, fallbackModel: null, stream: false, caller: "nous"
};

/** `body`: the first JSON line of the answer (the whole answer of a plain one); `raw`: every line, for the NDJSON stream. */
function post(socketPath: string, path: string, body: unknown) {
  return new Promise<{ status: number; body: Record<string, unknown>; raw: string }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const call = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text.trim().split("\n")[0]!) as Record<string, unknown>, raw: text }));
    });
    call.on("error", reject);
    call.end(data);
  });
}

describe("Nous turns in the worker", () => {
  it("accepts only a Nous turn for its own tool endpoint, with a bounded model, effort and turn limit", () => {
    expect(validateNousTurnInput(base)).toEqual(base);
    expect(validateNousTurnInput({ ...base, timeoutMs: 99_000_000 }).timeoutMs).toBe(1_200_000);
    // The shell only on an explicit true (operator order 2026-10-24).
    expect(validateNousTurnInput({ ...base, shell: true }).shell).toBe(true);
    expect(validateNousTurnInput({ ...base, shell: "yes" }).shell).toBe(false);
    // The fallback model (Settings, off by default) is bounded like the model.
    expect(validateNousTurnInput({ ...base, fallbackModel: "claude-opus-5-5" }).fallbackModel).toBe("claude-opus-5-5");
    // The gateway log tag: a helper, else a turn.
    expect(validateNousTurnInput({ ...base, caller: "nous-helper" }).caller).toBe("nous-helper");
    expect(validateNousTurnInput({ ...base, caller: "x-space-project: evil" }).caller).toBe("nous");
    for (const bad of [{ mcpUrl: "https://evil.example/collect" }, { mcpToken: "short" }, { effort: "ultra" }, { model: "../../x" }, { maxTurns: 0 },
      { prompt: " " }, { claudeProfile: "Bad Profile" }, { prompt: "x".repeat(400_001) }, { fallbackModel: "../../x" }, { fallbackModel: 7 }]) {
      expect(() => validateNousTurnInput({ ...base, ...bad })).toThrow(NousTurnInputError);
    }
  });

  it("reads Claude Code's JSON result, an error result included", () => {
    expect(parseNousTurnOutput('{"type":"result","subtype":"success","is_error":false,"result":"Όλα κινούνται.","num_turns":3}\n'))
      .toEqual({ text: "Όλα κινούνται.", isError: false, turns: 3, costUsd: null, tokens: null });
    expect(parseNousTurnOutput('{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":40}'))
      .toEqual({ text: "Claude Code stopped (error_max_turns).", isError: true, turns: 40, costUsd: null, tokens: null });
    // What the run cost and used per model (2026-10-21, the model study): kept when present, dropped when absurd or huge.
    const usage = { "claude-opus-5-5": { inputTokens: 12, outputTokens: 300, cacheReadInputTokens: 900_000, costUSD: 0.91 } };
    expect(parseNousTurnOutput(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 2, total_cost_usd: 0.91, modelUsage: usage })))
      .toEqual({ text: "ok", isError: false, turns: 2, costUsd: 0.91, tokens: usage });
    expect(parseNousTurnOutput(JSON.stringify({ type: "result", subtype: "success", result: "ok", total_cost_usd: -1, modelUsage: { huge: "x".repeat(9_000) } })))
      .toMatchObject({ costUsd: null, tokens: null });
    expect(() => parseNousTurnOutput("API Error: 529 overloaded")).toThrow("API Error: 529 overloaded");
  });

  it("reads the stream-json lines that matter for the dock's draft: a message start, a text delta, the result; the rest is nothing", () => {
    expect(readNousStreamLine(JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } }))).toEqual({ start: true });
    expect(readNousStreamLine(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Όλα " } } }))).toEqual({ text: "Όλα " });
    expect(readNousStreamLine(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } }))).toBeNull();
    expect(readNousStreamLine(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"a" } } }))).toBeNull();
    expect(readNousStreamLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "whole" }] } }))).toBeNull();
    expect(readNousStreamLine(JSON.stringify({ type: "result", subtype: "success", result: "ok" }))).toEqual({ result: true });
    expect(readNousStreamLine("not json")).toBeNull();
    // The stream flag is a plain boolean like the shell's.
    expect(validateNousTurnInput({ ...base, stream: true }).stream).toBe(true);
    expect(validateNousTurnInput({ ...base, stream: "yes" }).stream).toBe(false);
  });

  it("drops a streamed line too long to keep (a tool result's image) and fails only on an oversized result record", () => {
    const taken: string[] = [];
    const lines = splitNousStreamLines(100, (line) => taken.push(line));
    const image = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "image", source: { data: "A".repeat(500) } }] }] } });
    // Split across chunks the way a pipe delivers it: the long line must not be buffered whole.
    expect(lines.push(`{"type":"stream_event"}\n${image.slice(0, 60)}`)).toBeNull();
    expect(lines.push(image.slice(60, 300))).toBeNull();
    expect(lines.push(`${image.slice(300)}\n{"type":"result","result":"ok"}`)).toBeNull();
    expect(lines.end()).toBeNull();
    expect(taken).toEqual(['{"type":"stream_event"}', '{"type":"result","result":"ok"}']);
    // A long line that arrives in one chunk is dropped too.
    expect(splitNousStreamLines(100, (line) => taken.push(line)).push(`${image}\n`)).toBeNull();
    const result = JSON.stringify({ type: "result", subtype: "success", result: "x".repeat(500) });
    expect(splitNousStreamLines(100, () => {}).push(`${result}\n`)).toBe("Claude Code's answer exceeded the output limit.");
    const unfinished = splitNousStreamLines(100, () => {});
    expect(unfinished.push(result)).toBeNull();
    expect(unfinished.end()).toBe("Claude Code's answer exceeded the output limit.");
  });

  it("streams a route's events as NDJSON and ends with the result; a route that emits nothing answers plain JSON", async () => {    const dir = await mkdtemp(join(tmpdir(), "nous-turn-"));
    const socketPath = join(dir, "worker.sock");
    const server = await startChessMoveServer(socketPath, async () => "move", {
      "/nous-turn": { maxBodyBytes: NOUS_TURN_MAX_BODY_BYTES, isInputError: (error) => error instanceof NousTurnInputError,
        handle: async (body, _signal, emit) => {
          const input = validateNousTurnInput(body);
          if (input.stream) { emit({ start: true }); emit({ text: "Όλα " }); emit({ text: "κινούνται." }); }
          if (input.prompt === "fail") throw new Error("socket hang up");
          return { text: "Όλα κινούνται.", isError: false, turns: 2 };
        } }
    });
    try {
      const streamed = await post(socketPath, "/nous-turn", { ...base, stream: true });
      expect(streamed.status).toBe(200);
      expect(String(streamed.raw).trim().split("\n").map((line) => JSON.parse(line))).toEqual([{ start: true }, { text: "Όλα " }, { text: "κινούνται." }, { result: { text: "Όλα κινούνται.", isError: false, turns: 2 } }]);
      expect(await post(socketPath, "/nous-turn", base)).toEqual({ status: 200, body: { text: "Όλα κινούνται.", isError: false, turns: 2 }, raw: expect.any(String) });
      const failed = await post(socketPath, "/nous-turn", { ...base, stream: true, prompt: "fail" });
      expect(String(failed.raw).trim().split("\n").at(-1)).toBe(JSON.stringify({ error: "socket hang up" }));
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves the turn on the move socket next to the chess moves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nous-turn-"));
    const socketPath = join(dir, "worker.sock");
    const server = await startChessMoveServer(socketPath, async () => "move", {
      "/nous-turn": { maxBodyBytes: NOUS_TURN_MAX_BODY_BYTES, isInputError: (error) => error instanceof NousTurnInputError,
        handle: async (body) => { const input = validateNousTurnInput(body); return { text: `answered ${input.prompt}`, isError: false, turns: 1 }; } }
    });
    try {
      expect(await post(socketPath, "/nous-turn", base)).toMatchObject({ status: 200, body: { text: "answered What waits?", isError: false, turns: 1 } });
      expect((await post(socketPath, "/nous-turn", { ...base, mcpUrl: "https://evil.example/x" })).status).toBe(400);
      expect((await post(socketPath, "/elsewhere", base)).status).toBe(404);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
