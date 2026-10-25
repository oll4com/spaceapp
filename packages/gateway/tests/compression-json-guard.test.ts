import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createCompressors, initCompressors } from "../src/compression/compressors.js";
import { compressBlock, compressGeminiBodyAsync, compressResponsesBodyAsync, type AsyncBlockRunner, type BlockResult } from "../src/compression/engine.js";
import { compressionRows } from "../src/compression/recorder.js";

const tokens = { count: (text: string) => Math.ceil(text.length / 4) };
const compressors = createCompressors();
const run: AsyncBlockRunner = async (text, _deadline, options = {}): Promise<BlockResult> => compressBlock(text, compressors, tokens, undefined, options);
/** Headroom's own CodeAware fixture: a Python module whose function bodies shorten to their first statements. */
const python = (JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "headroom-parity", "code_aware_compressor", "e79625ba83a6f22d.json"), "utf8")) as { input: string }).input;
const prose = Array.from({ length: 14 }, (_, index) => `The deploy step ${index} copied the bundle and restarted nothing at all today.`).join(" ")
  + " The readiness probe on port 4920 answered after 3 retries. The operator looked at it later.";
const buildLog = Array.from({ length: 120 }, (_, index) => `[2030-01-10 00:00:${String(index % 60).padStart(2, "0")}] INFO build step ${index + 1} compiled module src/mod${index % 7}.ts ok`)
  .join("\n");
/**
 * A Codex `exec` result as current Codex sends it: one line of JSON whose `output` is the command's text. Numbers are
 * written as the source wrote them: `1.50` and an id past 2^53 must survive.
 */
const execResult = (output: string) =>
  `{"chunk_id":"a1b2c3","wall_time_seconds":1.50,"exit_code":2,"original_token_count":260,"trace_id":12345678901234567890,"output":${JSON.stringify(output)}}`;
const lossy = { codeText: "ON" as const, lossy: true };

beforeAll(async () => { await initCompressors(); });

describe("JSON objects", () => {
  it("compresses the large string fields of a JSON object by their content and keeps every other field as written", () => {
    const text = execResult(buildLog);
    const result = compressBlock(text, compressors, tokens, undefined, lossy);
    expect(result.action).toMatchObject({ kind: "compressed", strategy: "json_fields" });
    const sent = result.replacement!;
    expect(sent.startsWith('{"chunk_id":"a1b2c3","wall_time_seconds":1.50,"exit_code":2,"original_token_count":260,"trace_id":12345678901234567890,"output":"')).toBe(true);
    const output = (JSON.parse(sent) as { output: string }).output;
    expect(output).toBe(compressBlock(buildLog, compressors, tokens, undefined, lossy).replacement);
    expect(output).toContain("lines omitted");
    // Prose in a field is crushed as prose, and the object stays JSON (TextCrusher on the whole object did not).
    const crushed = compressBlock(execResult(prose.toLowerCase()), compressors, tokens, undefined, lossy);
    expect(crushed.action).toMatchObject({ kind: "compressed", strategy: "json_fields" });
    expect((JSON.parse(crushed.replacement!) as { exit_code: number }).exit_code).toBe(2);
  });

  it("leaves a JSON object alone when no field is large enough, and texts that only look like objects take the usual routes", () => {
    const small = JSON.stringify({ ok: true, items: 3, note: "short" }).padEnd(600, " ");
    expect(compressBlock(small, compressors, tokens, undefined, lossy).action.kind).not.toBe("compressed");
    const notJson = `{ ${prose}`;
    const routed = compressBlock(notJson, compressors, tokens, undefined, lossy).action;
    expect(routed.kind).toBe("compressed");
    expect(routed).not.toMatchObject({ strategy: "json_fields" });
  });

  it("keeps a file read exact inside a JSON result, while other exec results get their fields compressed", async () => {
    const turn = (id: string, cmd: string) => [
      { type: "custom_tool_call", call_id: id, name: "exec", input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)} });\ntext(JSON.stringify(r));` },
      { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text: execResult(python) }] }
    ];
    const body = { input: [...turn("read", "sed -n '1,200p' app/logging_setup.py"), ...turn("run", "python3 scripts/print_module.py")] };
    const outcome = await compressResponsesBodyAsync(body, { run, timeBudgetMs: 5000, codeText: "ON", profile: "TOKEN" });
    const input = outcome.body.input as Array<{ output?: Array<{ text: string }> }>;
    expect(input[1]!.output![0]!.text).toBe(execResult(python));
    expect((JSON.parse(input[3]!.output![0]!.text) as { output: string }).output).toContain("# [9 lines omitted]");
  });
});

describe("JSON tool output stays JSON", () => {
  it("sends the original when a compressor turns JSON into something that no longer parses", () => {
    const rows = JSON.stringify(Array.from({ length: 80 }, (_, index) => ({ id: index, status: "ok" })));
    const broken = compressBlock(rows, { smartCrusher: (text) => text.slice(0, 200) }, tokens, undefined, lossy);
    expect(broken.replacement).toBeNull();
    expect(broken.action).toEqual({ kind: "rejected_invalid_json", strategy: "smart_crusher" });
    // SmartCrusher itself keeps arrays JSON.
    const crushed = compressBlock(rows, compressors, tokens, undefined, lossy);
    expect(crushed.action).toMatchObject({ kind: "compressed", strategy: "smart_crusher" });
    expect(() => JSON.parse(crushed.replacement!)).not.toThrow();
  });

  it("applies to Codex and Antigravity bodies, and counts a rejection as a rejected block", async () => {
    const rows = JSON.stringify(Array.from({ length: 80 }, (_, index) => ({ id: index, status: "ok" })));
    const breaking: AsyncBlockRunner = async (text, _deadline, options = {}) => compressBlock(text, { smartCrusher: (input) => input.slice(0, 200) }, tokens, undefined, options);
    const codex = { input: [{ type: "function_call_output", call_id: "x", output: rows }] };
    const outcome = await compressResponsesBodyAsync(codex, { run: breaking, timeBudgetMs: 5000, codeText: "ON", profile: "TOKEN" });
    expect(outcome.modified).toBe(false);
    expect(outcome.body).toBe(codex);
    expect(compressionRows(outcome, { at: "2030-01-10T00:00:00.000Z", mode: "ON", provider: "CODEX" }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ strategy: "smart_crusher", rejectedBlocks: 1, blocks: 0 })]));
    const agy = { request: { contents: [{ role: "model", parts: [{ functionCall: { id: "m", name: "mcp_status", args: {} } }] },
      { role: "model", parts: [{ functionResponse: { id: "m", name: "mcp_status", response: { output: rows } } }] }] } };
    const gemini = await compressGeminiBodyAsync(agy, { run: breaking, timeBudgetMs: 5000, codeText: "ON", profile: "TOKEN" });
    expect(gemini.modified).toBe(false);
    expect(gemini.blocks[0]!.action.kind).toBe("rejected_invalid_json");
  });
});
