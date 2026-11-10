import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startChessMoveServer } from "../src/chess-cli-move.js";
import { captureWorkerLogs } from "../src/worker-log.js";
import { NOUS_TURN_MAX_BODY_BYTES, type NousTurnInput, NousTurnInputError, parseNousTurnOutput, readNousStreamLine, splitNousStreamLines, validateNousTurnInput } from "../src/nous-turn.js";
import { NOUS_PROMPT_MAX_CHARS } from "@space/contracts";
import type { ServerSpan } from "@space/runtime";

const base: NousTurnInput = {
  provider: "claude",
  model: "claude-opus-5-5", effort: "xhigh", claudeProfile: "crew", system: "You are Nous.", prompt: "What waits?",
  mcpUrl: "http://127.0.0.1:4911/api/cli/nous/mcp", mcpToken: "nous.abcdefghijklmnopqrstuvwxyz0123456789", maxTurns: 40, timeoutMs: 1_200_000, shell: false, fallbackModel: null, stream: false, caller: "nous"
};

/** `body`: the first JSON line of the answer (the whole answer of a plain one); `raw`: every line, for the NDJSON stream. */
function post(socketPath: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: Record<string, unknown>; raw: string; requestId?: unknown }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const call = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text.trim().split("\n")[0]!) as Record<string, unknown>, raw: text,
        requestId: response.headers["x-request-id"] }));
    });
    call.on("error", reject);
    call.end(data);
  });
}

describe("Nous turns in the worker", () => {
  it("accepts only a Nous turn for its own tool endpoint, with a bounded model, effort and turn limit", () => {
    expect(validateNousTurnInput(base)).toEqual(base);
    expect(validateNousTurnInput({ ...base, provider: undefined }).provider).toBe("claude");
    for (const provider of ["codex", "openai", "gemini", "openrouter", "deepseek", "opencode"]) {
      expect(validateNousTurnInput({ ...base, provider, model: "gpt-6-astra", effort: "high" }).provider).toBe(provider);
    }
    expect(validateNousTurnInput({ ...base, timeoutMs: 99_000_000 }).timeoutMs).toBe(1_200_000);
    // The shell only on an explicit true (operator order 2026-10-24).
    expect(validateNousTurnInput({ ...base, shell: true }).shell).toBe(true);
    expect(validateNousTurnInput({ ...base, shell: "yes" }).shell).toBe(false);
    // The fallback model (Settings, off by default) is bounded like the model.
    expect(validateNousTurnInput({ ...base, fallbackModel: "claude-opus-5-5" }).fallbackModel).toBe("claude-opus-5-5");
    // The gateway log tag: a helper, else a turn.
    expect(validateNousTurnInput({ ...base, caller: "nous-helper" }).caller).toBe("nous-helper");
    expect(validateNousTurnInput({ ...base, caller: "nous-operator" }).caller).toBe("nous-operator");
    expect(validateNousTurnInput({ ...base, caller: "x-space-project: evil" }).caller).toBe("nous");
    for (const bad of [{ provider: "unknown" }, { mcpUrl: "https://evil.example/collect" }, { mcpToken: "short" }, { effort: "ultra" }, { model: "../../x" }, { maxTurns: 0 },
      { prompt: " " }, { claudeProfile: "Bad Profile" }, { prompt: "x".repeat(400_001) }, { fallbackModel: "../../x" }, { fallbackModel: 7 }]) {
      expect(() => validateNousTurnInput({ ...base, ...bad })).toThrow(NousTurnInputError);
    }
    // Operator 1/11: the API cuts every turn prompt to NOUS_PROMPT_MAX_CHARS (prompt-budget.ts), so the worker's 400,000 is never reached.
    expect(NOUS_PROMPT_MAX_CHARS).toBeLessThan(400_000);
    expect(validateNousTurnInput({ ...base, prompt: "x".repeat(NOUS_PROMPT_MAX_CHARS) }).prompt).toHaveLength(NOUS_PROMPT_MAX_CHARS);
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
      expect(await post(socketPath, "/nous-turn", base)).toEqual({ status: 200, body: { text: "Όλα κινούνται.", isError: false, turns: 2 }, raw: expect.any(String), requestId: expect.stringMatching(/^req_/) });
      const failed = await post(socketPath, "/nous-turn", { ...base, stream: true, prompt: "fail" });
      expect(String(failed.raw).trim().split("\n").at(-1)).toBe(JSON.stringify({ error: "socket hang up" }));
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("OBS-006 (2026-11-02): logs each socket request with the caller's trace and turn ids, never its text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nous-turn-"));
    const socketPath = join(dir, "worker.sock");
    const records: Array<Record<string, unknown>> = [];
    const restore = captureWorkerLogs((line) => { records.push(JSON.parse(line) as Record<string, unknown>); });
    const server = await startChessMoveServer(socketPath, async () => { throw new Error("no move"); }, {
      "/nous-turn": { maxBodyBytes: NOUS_TURN_MAX_BODY_BYTES, isInputError: (error) => error instanceof NousTurnInputError,
        handle: async (body) => { const input = validateNousTurnInput(body); if (input.prompt === "fail") throw new Error("socket hang up"); return { text: "ok", isError: false, turns: 1 }; } }
    });
    const ids = { traceId: "trace:0123456789abcdef01234567", turnId: "nous_turn:0123456789abcdef01234567" };
    try {
      await post(socketPath, "/nous-turn", { ...base, ...ids });
      await post(socketPath, "/nous-turn", { ...base, ...ids, prompt: "fail" });
      await post(socketPath, "/nous-turn", { ...base, ...ids, mcpUrl: "https://evil.example/x" });
      await post(socketPath, "/move", { runtimeId: "cli:claude", model: "m", prompt: "e4?", timeoutMs: 1_000 });
    } finally {
      restore();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
    const lines = records.filter((record) => record.event === "worker.socket_request");
    expect(lines.map(({ route, status, traceId, turnId }) => ({ route, status, traceId, turnId }))).toEqual([
      { route: "nous-turn", status: "COMPLETED", ...ids }, { route: "nous-turn", status: "FAILED", ...ids }, { route: "nous-turn", status: "INVALID", ...ids },
      { route: "move", status: "FAILED", traceId: undefined, turnId: undefined }]);
    expect(lines[0]).toMatchObject({ service: "space-worker", level: "info", durationMs: expect.any(Number) });
    expect(JSON.stringify(lines)).not.toMatch(/What waits|You are Nous|socket hang up|nous\.abcdef/);
  });

  it("OBS-006 (2026-11-05): keeps a Space-shaped x-request-id on its line and answer, and makes its own for anything else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nous-turn-"));
    const socketPath = join(dir, "worker.sock");
    const records: Array<Record<string, unknown>> = [];
    const restore = captureWorkerLogs((line) => { records.push(JSON.parse(line) as Record<string, unknown>); });
    const server = await startChessMoveServer(socketPath, async () => "move");
    const move = { runtimeId: "cli:claude", model: "m", prompt: "e4?", timeoutMs: 1_000 };
    const answers = [];
    try {
      answers.push(await post(socketPath, "/move", move, { "x-request-id": "trace:0123456789abcdef01234567" }));
      for (const header of ["short", "a".repeat(65), "req/../x\"quoted\""]) answers.push(await post(socketPath, "/move", move, { "x-request-id": header }));
      answers.push(await post(socketPath, "/move", move));
    } finally {
      restore();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
    const lines = records.filter((record) => record.event === "worker.socket_request");
    expect(lines.map((line) => line.requestId)).toEqual(answers.map((answer) => answer.requestId));
    expect(answers[0]!.requestId).toBe("trace:0123456789abcdef01234567");
    for (const answer of answers.slice(1)) expect(answer.requestId).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it("OBS-006 (2026-11-02): exports one span per socket request, under the caller's traceparent or as its own trace the log line names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nous-turn-"));
    const socketPath = join(dir, "worker.sock");
    const records: Array<Record<string, unknown>> = [];
    const spans: ServerSpan[] = [];
    const exporter = { record: (span: ServerSpan) => { spans.push(span); }, close: async () => {}, stats: () => ({ exported: 0, dropped: 0, failed: 0 }) };
    const restore = captureWorkerLogs((line) => { records.push(JSON.parse(line) as Record<string, unknown>); });
    const server = await startChessMoveServer(socketPath, async () => { throw new Error("no move"); }, {
      "/nous-turn": { maxBodyBytes: NOUS_TURN_MAX_BODY_BYTES, isInputError: (error) => error instanceof NousTurnInputError,
        handle: async (body) => { validateNousTurnInput(body); return { text: "ok", isError: false, turns: 1 }; } }
    }, exporter);
    const parent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    try {
      await post(socketPath, "/nous-turn", { ...base, traceId: "trace:0123456789abcdef01234567", traceparent: parent });
      await post(socketPath, "/move", { runtimeId: "cli:claude", model: "m", prompt: "e4?", timeoutMs: 1_000, traceId: "council_run:abc" });
    } finally {
      restore();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
    expect(spans.map(({ traceId, parentSpanId, name, error, kind, attributes }) => ({ traceId, parentSpanId, name, error, kind, attributes }))).toEqual([
      { traceId: "0123456789abcdef0123456789abcdef", parentSpanId: "0123456789abcdef", name: "worker.socket nous-turn", error: false, kind: 2,
        attributes: { "space.route": "nous-turn", "space.outcome": "COMPLETED", "space.trace_id": "trace:0123456789abcdef01234567" } },
      { traceId: expect.stringMatching(/^[0-9a-f]{32}$/), parentSpanId: null, name: "worker.socket move", error: true, kind: 2,
        attributes: { "space.route": "move", "space.outcome": "FAILED", "space.trace_id": "council_run:abc" } }]);
    expect(spans[0]!.endTimeUnixNano >= spans[0]!.startTimeUnixNano).toBe(true);
    const lines = records.filter((record) => record.event === "worker.socket_request");
    expect(lines.map((line) => line.w3cTraceId)).toEqual(spans.map((span) => span.traceId));
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toMatch(/What waits|You are Nous|e4\?/);
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
