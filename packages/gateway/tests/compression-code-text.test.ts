import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createCompressors, initCompressors } from "../src/compression/compressors.js";
import { compressAnthropicBodyAsync, compressBlock, compressResponsesBodyAsync, type AsyncBlockRunner, type BlockResult } from "../src/compression/engine.js";
import { compressionDetail, compressionRows } from "../src/compression/recorder.js";

const tokens = { count: (text: string) => Math.ceil(text.length / 4) };
const compressors = createCompressors();
/** Headroom's own CodeAware fixture: a Python module whose function bodies shorten to their first statements. */
const python = (JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "headroom-parity", "code_aware_compressor", "e79625ba83a6f22d.json"), "utf8")) as { input: string }).input;
const prose = Array.from({ length: 14 }, (_, index) => `The deploy step ${index} copied the bundle and restarted nothing at all today.`).join(" ")
  + " The readiness probe on port 4920 answered after 3 retries. The operator looked at it later.";
const repeated = `${"waiting for the build to finish\n".repeat(40)}build finished in 42s\n`;

beforeAll(async () => { await initCompressors(); });

describe("code and prose compression", () => {
  it("leaves code and prose alone while it is off, as Headroom 0.37's live zone does", () => {
    expect(compressBlock(python, compressors, tokens).action.kind).toBe("no_compression");
    expect(compressBlock(prose, compressors, tokens).action.kind).toBe("no_compression");
  });

  it("shortens function bodies with CodeAware and keeps signatures and imports", () => {
    const result = compressBlock(python, compressors, tokens, undefined, { codeText: "ON", lossy: true });
    expect(result.action).toMatchObject({ kind: "compressed", strategy: "code_aware", contentType: "source_code" });
    expect(result.replacement).toContain("def configure(level, handlers, fmt, propagate, capture_warnings):");
    expect(result.replacement).toContain("import logging");
    expect(result.replacement).toContain("# [9 lines omitted]");
  });

  it("crushes prose to its salient sentences, and only folds losslessly when lossy transforms are not allowed", () => {
    const crushed = compressBlock(prose, compressors, tokens, undefined, { codeText: "ON", lossy: true });
    expect(crushed.action).toMatchObject({ kind: "compressed", strategy: "text_crusher" });
    expect(crushed.replacement).toContain("The readiness probe on port 4920 answered after 3 retries.");
    expect(compressBlock(prose, compressors, tokens, undefined, { codeText: "ON", lossy: false }).action.kind).toBe("no_compression");
    const folded = compressBlock(repeated, compressors, tokens, undefined, { codeText: "ON", lossy: false });
    expect(folded.action).toMatchObject({ kind: "compressed", strategy: "lossless_fold" });
    expect(folded.replacement).toBe("waiting for the build to finish\n... (repeated 40 times)\nbuild finished in 42s\n");
  });

  it("compresses mixed content section by section and keeps the lines between sections byte-identical", () => {
    const rows = JSON.stringify(Array.from({ length: 40 }, (_, index) => ({ id: index, status: index === 7 ? "error" : "ok", note: `row ${index}` })), null, 1);
    const text = ["The Service Report Follows Here", "Every Request Was Logged Today", "Some Results Are Shown Below", "Most Rows Look Fine Now",
      "Other Lines Follow Next", "Final Words Come Last", rows, "Done With The Report Now", "```python", python.trimEnd(), "```", "End Of Output Here"].join("\n");
    const result = compressBlock(text, compressors, tokens, undefined, { codeText: "ON", lossy: true });
    expect(result.action).toMatchObject({ kind: "compressed", strategy: "mixed" });
    const lines = result.replacement!.split("\n");
    expect(lines.slice(0, 6)).toEqual(text.split("\n").slice(0, 6));
    expect(result.replacement).toMatch(/"status": ?"error"/);
    expect(result.replacement!.length).toBeLessThan(text.length / 2);
    expect(result.replacement).toContain("Done With The Report Now\n```python\nimport logging");
    expect(result.replacement).toContain("# [9 lines omitted]");
    expect(lines.at(-2)).toBe("```");
    expect(lines.at(-1)).toBe("End Of Output Here");
  });
});

describe("tool results in request bodies", () => {
  const run: AsyncBlockRunner = async (text, _deadline, options = {}): Promise<BlockResult> => compressBlock(text, compressors, tokens, undefined, options);

  it("protects file reads from lossy compression and compresses other code tool output (Codex)", async () => {
    const body = { input: [
      { type: "function_call", call_id: "read", name: "exec_command", arguments: JSON.stringify({ cmd: "cd /repo && sed -n '1,120p' app/logging_setup.py" }) },
      { type: "function_call_output", call_id: "read", output: python },
      { type: "function_call", call_id: "show", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "git show HEAD:app/logging_setup.py | python3 -m tokenize -e"] }) },
      { type: "function_call_output", call_id: "show", output: python }
    ] };
    const outcome = await compressResponsesBodyAsync(body, { run, timeBudgetMs: 5000, codeText: "ON", profile: "TOKEN" });
    const input = outcome.body.input as Array<Record<string, unknown>>;
    expect(input[1]!.output).toBe(python);
    expect(String(input[3]!.output)).toContain("# [9 lines omitted]");
    expect(outcome.blocks.map((block) => block.action.kind)).toEqual(["no_compression", "compressed"]);
    // The Cache-safe profile allows lossless folds only.
    const cacheSafe = await compressResponsesBodyAsync(body, { run, timeBudgetMs: 5000, codeText: "ON", profile: "CACHE" });
    expect(cacheSafe.modified).toBe(false);
  });

  it("compresses Claude tool results but never the Read tool's file content or the user's own text", async () => {
    const body = { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/app/logging_setup.py" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "python3 scripts/print_module.py" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: python }, { type: "tool_result", tool_use_id: "t2", content: python },
        { type: "text", text: prose }] }
    ] };
    const outcome = await compressAnthropicBodyAsync(body, { run, timeBudgetMs: 5000, codeText: "ON", profile: "TOKEN" });
    const content = (outcome.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[1]!.content;
    expect(content[0]!.content).toBe(python);
    expect(String(content[1]!.content)).toContain("# [9 lines omitted]");
    expect(content[2]!.text).toBe(prose);
  });

  it("records code and prose blocks of an ON request as ON rows inside the request's savings", async () => {
    const body = { input: [{ type: "function_call_output", call_id: "x", output: python }] };
    const outcome = await compressResponsesBodyAsync(body, { run, timeBudgetMs: 5000, codeText: "ON", profile: "TOKEN" });
    expect(outcome.modified).toBe(true);
    expect(outcome.tokensBefore).toBeGreaterThan(outcome.tokensAfter);
    const rows = compressionRows(outcome, { at: "2030-01-01T10:00:00.000Z", mode: "ON", provider: "CODEX" });
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ mode: "ON", strategy: "", requests: 1, modifiedRequests: 1 }),
      expect.objectContaining({ mode: "ON", strategy: "code_aware", blocks: 1 })]));
    expect(rows.some((row) => row.mode !== "ON")).toBe(false);
    expect(compressionDetail(outcome)?.strategies).toEqual(["code_aware"]);
  });
});
