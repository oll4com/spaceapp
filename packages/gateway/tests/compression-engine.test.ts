import { describe, expect, it } from "vitest";
import { compressBlock, compressResponsesBody, type Compressors } from "../src/compression/engine.js";

const tokens = { count: (text: string) => Math.ceil(text.length / 4) };
const bigJson = JSON.stringify(Array.from({ length: 60 }, (_, index) => ({ id: index, status: index % 7 ? "ok" : "error", message: `line ${index}` })));
const compressors: Compressors = { smartCrusher: (text) => JSON.stringify(JSON.parse(text).slice(0, 5)) };

describe("compression engine (live zone)", () => {
  it("compresses large tool outputs, keeps small ones and other items byte-identical", () => {
    const body = {
      model: "gpt-5.5", instructions: "x",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "c1", name: "list", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: bigJson },
        { type: "function_call_output", call_id: "c2", output: "short" }
      ]
    };
    const outcome = compressResponsesBody(body, { compressors, tokens, timeBudgetMs: 1000 });
    expect(outcome.modified).toBe(true);
    const input = outcome.body.input as Record<string, unknown>[];
    expect(input[0]).toBe(body.input[0]);
    expect(input[3]).toBe(body.input[3]);
    expect(JSON.parse(String(input[2]!.output))).toHaveLength(5);
    expect(body.input[2]!.output).toBe(bigJson);
    expect(outcome.blocks.map((block) => block.action.kind)).toEqual(["compressed", "below_threshold"]);
    expect(outcome.tokensBefore).toBeGreaterThan(outcome.tokensAfter);
    // Deterministic: the same body compresses to the same bytes next turn (prompt cache stays warm).
    expect(JSON.stringify(compressResponsesBody(body, { compressors, tokens, timeBudgetMs: 1000 }).body)).toBe(JSON.stringify(outcome.body));
  });

  it("leaves retrieval tool outputs, unknown types and unsupported content alone", () => {
    const body = { input: [
      { type: "function_call", call_id: "r1", name: "mcp__headroom_retrieve", arguments: "{}" },
      { type: "function_call_output", call_id: "r1", output: bigJson },
      { type: "function_call_output", call_id: "c3", output: "plain words ".repeat(100) }
    ] };
    const outcome = compressResponsesBody(body, { compressors, tokens, timeBudgetMs: 1000 });
    expect(outcome.modified).toBe(false);
    expect(outcome.body).toBe(body);
    expect(outcome.blocks.map((block) => block.action)).toEqual([{ kind: "no_compression", contentType: "text" }]);
  });

  it("rejects results that are not smaller in tokens and reports compressor errors", () => {
    const inflate: Compressors = { smartCrusher: (text) => `${text} ` };
    expect(compressBlock(bigJson, inflate, tokens).action.kind).toBe("rejected_not_smaller");
    const broken: Compressors = { smartCrusher: () => { throw new Error("bad input"); } };
    expect(compressBlock(bigJson, broken, tokens).action).toEqual({ kind: "error", strategy: "smart_crusher", error: "bad input" });
  });

  it("sends the original body when the time budget runs out", () => {
    let clock = 0;
    const slow: Compressors = { smartCrusher: (text) => { clock += 500; return JSON.stringify(JSON.parse(text).slice(0, 2)); } };
    const body = { input: [{ type: "function_call_output", call_id: "a", output: bigJson }, { type: "function_call_output", call_id: "b", output: bigJson }] };
    const outcome = compressResponsesBody(body, { compressors: slow, tokens, timeBudgetMs: 250, now: () => clock });
    expect(outcome).toMatchObject({ modified: false, timedOut: true });
    expect(outcome.body).toBe(body);
  });
});
