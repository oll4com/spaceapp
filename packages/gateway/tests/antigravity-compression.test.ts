import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createCompressors, initCompressors } from "../src/compression/compressors.js";
import { CompressionCache, compressBlock, compressGeminiBodyAsync, RawBlockRegistry, splitOutputPreamble, type AsyncBlockRunner, type BlockResult } from "../src/compression/engine.js";
import { compressionDetail, compressionRows } from "../src/compression/recorder.js";
import { createTokenCounter } from "../src/compression/tokenizer.js";

const compressors = createCompressors();
const run: AsyncBlockRunner = async (text, _deadline, options = {}): Promise<BlockResult> =>
  compressBlock(text, compressors, createTokenCounter(options.tokenizer ?? "o200k"), undefined, options);
/** Headroom's own CodeAware fixture: a Python module whose function bodies shorten to their first statements. */
const python = (JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "headroom-parity", "code_aware_compressor", "e79625ba83a6f22d.json"), "utf8")) as { input: string }).input;
/** A build log as Antigravity's run_command returns it (agy 1.3.3): a header, then the command's output. */
const buildLog = ["Created At: 2030-01-10T00:00:00Z", "Completed At: 2030-01-10T00:00:01Z", "", "The command exited with code 1.", "Output:",
  ...Array.from({ length: 120 }, (_, index) => `[2030-01-10 00:00:${String(index % 60).padStart(2, "0")}] INFO build step ${index + 1} compiled module src/mod${index % 7}.ts ok`),
  "ERROR: tsc failed in src/mod3.ts"].join("\n");

type Json = Record<string, unknown>;
type Content = { role: string; parts: Json[] };
/** Antigravity sends both the call and its result in `model` turns, paired by id. */
const call = (id: string | null, name: string, args: Json): Content => ({ role: "model", parts: [{ functionCall: { ...(id ? { id } : {}), name, args } }] });
const result = (id: string | null, name: string, response: Json): Content => ({ role: "model", parts: [{ functionResponse: { ...(id ? { id } : {}), name, response } }] });
const agy = (contents: Content[]) => ({ project: "project-a", requestId: "agent/r1", model: "gemini-3.8-flash-high", userAgent: "antigravity", requestType: "agent",
  request: { contents, sessionId: "session-1", generationConfig: { maxOutputTokens: 65536 } } });
const contentsOf = (body: Json) => (body.request as { contents: Content[] }).contents;
const responseOf = (content: Content) => (content.parts[0]!.functionResponse as { response: Json }).response;
/** The user pastes the same log: the user's own words are never rewritten. */
const user: Content = { role: "user", parts: [{ text: `<USER_REQUEST>\nFix the build:\n${buildLog}\n</USER_REQUEST>` }] };

beforeAll(async () => { await initCompressors(); });

describe("Antigravity (Gemini) compression", () => {
  it("compresses tool results in model turns, as Antigravity sends them, and leaves everything else byte-identical", async () => {
    const body = agy([user, call("c1", "run_command", { CommandLine: "npm run build", Cwd: "/repo" }), result("c1", "run_command", { output: buildLog }),
      call("c2", "view_file", { AbsolutePath: "/repo/app/logging_setup.py" }), result("c2", "view_file", { output: python })]);
    const before = JSON.stringify(body);
    const outcome = await compressGeminiBodyAsync(body, { run, timeBudgetMs: 5000 });
    expect(outcome.modified).toBe(true);
    expect(JSON.stringify(body)).toBe(before);
    const contents = contentsOf(outcome.body);
    const original = contentsOf(body);
    for (const index of [0, 1, 3, 4]) expect(contents[index]).toBe(original[index]);
    const output = String(responseOf(contents[2]!).output);
    expect(output).toContain("lines omitted");
    expect(output).toContain("ERROR: tsc failed in src/mod3.ts");
    // The preamble, with the exit code, reaches the model as sent.
    expect(output.startsWith("Created At: 2030-01-10T00:00:00Z\nCompleted At: 2030-01-10T00:00:01Z\n\nThe command exited with code 1.\nOutput:\n")).toBe(true);
    expect(contents[2]!.parts[0]!.functionResponse).toMatchObject({ id: "c1", name: "run_command" });
    expect(outcome.body).toMatchObject({ project: "project-a", requestType: "agent", request: { sessionId: "session-1", generationConfig: { maxOutputTokens: 65536 } } });
    expect(outcome.blocks).toEqual([
      { itemIndex: 2, blockType: "functionResponse#0.output", action: expect.objectContaining({ kind: "compressed", strategy: "log_compressor", contentType: "build" }) },
      { itemIndex: 4, blockType: "functionResponse#0.output", action: expect.objectContaining({ kind: "no_compression" }) }
    ]);
    expect(outcome.tokensBefore).toBeGreaterThan(outcome.tokensAfter * 5);
    expect(compressionDetail(outcome)?.strategies).toEqual(["log_compressor"]);
    expect(compressionRows(outcome, { at: "2030-01-10T00:00:00.000Z", mode: "ON", provider: "ANTIGRAVITY" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "ANTIGRAVITY", strategy: "", requests: 1, modifiedRequests: 1 }),
      expect.objectContaining({ provider: "ANTIGRAVITY", strategy: "log_compressor", blocks: 1 })]));
  });

  it("compresses only the output after an Antigravity preamble, so a log that collapses still shows its exit code", async () => {
    const preamble = "Created At: 2030-01-10T00:00:00Z\nCompleted At: 2030-01-10T00:00:01Z\n\nThe command exited with code 0.\nOutput:\n";
    const log = Array.from({ length: 120 }, (_, index) => `[2030-01-10 00:00:${String(index % 60).padStart(2, "0")}] INFO build step ${index + 1} compiled ok`).join("\n");
    expect(splitOutputPreamble(preamble + log)).toEqual({ preamble, output: log });
    // No preamble: an `Output:` line past the first lines, or none at all, leaves the text whole.
    expect(splitOutputPreamble(log)).toEqual({ preamble: "", output: log });
    const late = `${"note\n".repeat(12)}Output:\n${log}`;
    expect(splitOutputPreamble(late)).toEqual({ preamble: "", output: late });
    const body = agy([user, call("c1", "run_command", { CommandLine: "npm run build" }), result("c1", "run_command", { output: preamble + log })]);
    const outcome = await compressGeminiBodyAsync(body, { run, timeBudgetMs: 5000 });
    const sent = String(responseOf(contentsOf(outcome.body)[2]!).output);
    expect(sent.startsWith(preamble)).toBe(true);
    expect(sent.slice(preamble.length)).toBe(compressBlock(log, compressors, createTokenCounter("gemini")).replacement);
    // Savings are counted on the output alone.
    expect(outcome.blocks[0]!.action).toMatchObject({ kind: "compressed", originalBytes: Buffer.byteLength(log) });
  });

  it("finds tool results under any response key, nested ones too, and skips small values and Headroom's retrieval tool", async () => {
    // A Gemini API body without the Code Assist envelope.
    const body = { contents: [user,
      result(null, "search", { result: buildLog }),
      result(null, "mcp_tool", { content: [{ type: "text", text: buildLog }], isError: false }),
      result(null, "run_command", { output: "ok" }),
      result(null, "headroom_retrieve", { output: buildLog })] };
    const outcome = await compressGeminiBodyAsync(body, { run, timeBudgetMs: 5000 });
    const contents = outcome.body.contents as Content[];
    expect(String(responseOf(contents[1]!).result)).toContain("lines omitted");
    const nested = responseOf(contents[2]!) as { content: Json[]; isError: boolean };
    expect(String(nested.content[0]!.text)).toContain("lines omitted");
    expect(nested).toMatchObject({ isError: false, content: [{ type: "text" }] });
    expect(contents[3]).toBe(body.contents[3]);
    expect(contents[4]).toBe(body.contents[4]);
    expect(outcome.blocks.map((block) => [block.itemIndex, block.blockType, block.action.kind])).toEqual([
      [1, "functionResponse#0.result", "compressed"], [2, "functionResponse#0.content.0.text", "compressed"], [3, "functionResponse#0", "below_threshold"]]);
  });

  it("gives file reads lossless folds only: view_file, and cat through run_command with or without call ids", async () => {
    const body = agy([user,
      call("v", "view_file", { AbsolutePath: "/repo/app/logging_setup.py" }), result("v", "view_file", { output: python }),
      call("r", "run_command", { CommandLine: "cd /repo && cat app/logging_setup.py" }), result("r", "run_command", { output: python }),
      call(null, "run_command", { CommandLine: "sed -n '1,120p' app/logging_setup.py" }), result(null, "run_command", { output: python }),
      call("p", "run_command", { CommandLine: "python3 scripts/print_module.py" }), result("p", "run_command", { output: python })]);
    const outcome = await compressGeminiBodyAsync(body, { run, timeBudgetMs: 5000, codeText: "ON", profile: "TOKEN" });
    const contents = contentsOf(outcome.body);
    for (const index of [2, 4, 6]) expect(responseOf(contents[index]!).output).toBe(python);
    expect(String(responseOf(contents[8]!).output)).toContain("# [9 lines omitted]");
    // The Cache-safe profile allows lossless folds only, for every tool.
    const cacheSafe = await compressGeminiBodyAsync(body, { run, timeBudgetMs: 5000, codeText: "ON", profile: "CACHE" });
    expect(cacheSafe.modified).toBe(false);
  });

  it("keeps earlier turns byte-identical from one request to the next, so Gemini's prefix cache keeps hitting", async () => {
    const cache = new CompressionCache();
    const first = [user, call("c1", "run_command", { CommandLine: "npm run build" }), result("c1", "run_command", { output: buildLog })];
    const turn1 = await compressGeminiBodyAsync(agy(first), { run, cache, timeBudgetMs: 5000 });
    const second = [...first, call("c2", "run_command", { CommandLine: "npm run build -- --verbose" }), result("c2", "run_command", { output: `${buildLog}\nretry` })];
    const turn2 = await compressGeminiBodyAsync(agy(second), { run, cache, timeBudgetMs: 5000 });
    expect(turn1.modified && turn2.modified).toBe(true);
    expect(JSON.stringify(contentsOf(turn2.body).slice(0, 3))).toBe(JSON.stringify(contentsOf(turn1.body)));
    expect(turn2.cacheHits).toBe(1);
    // A different tokenizer counts differently, so it never reuses these results.
    expect((await compressGeminiBodyAsync(agy(first), { run, cache, timeBudgetMs: 5000, tokenizer: "claude" })).cacheHits).toBe(0);
  });

  it("keeps a block raw for the rest of its session after it missed the budget, and compresses it for other sessions", async () => {
    const cache = new CompressionCache();
    const rawBlocks = new RawBlockRegistry();
    let late = true;
    const slow = vi.fn<AsyncBlockRunner>(async (text, deadline, options) => {
      if (late) { late = false; options?.onLate?.((await run(text, deadline, options))!); return null; }
      return run(text, deadline, options);
    });
    const body = agy([user, call("c1", "run_command", { CommandLine: "npm run build" }), result("c1", "run_command", { output: buildLog })]);
    const turn1 = await compressGeminiBodyAsync(body, { run: slow, cache, rawBlocks, sessionKey: "agy-1", timeBudgetMs: 5000 });
    expect(turn1).toMatchObject({ timedOut: true, modified: false });
    const turn2 = await compressGeminiBodyAsync(body, { run: slow, cache, rawBlocks, sessionKey: "agy-1", timeBudgetMs: 5000 });
    expect(turn2.body).toBe(body);
    expect(turn2.blocks).toEqual([{ itemIndex: 2, blockType: "functionResponse#0.output", action: { kind: "kept_raw", bytes: Buffer.byteLength(splitOutputPreamble(buildLog).output) } }]);
    const other = await compressGeminiBodyAsync(body, { run: slow, cache, rawBlocks, sessionKey: "agy-2", timeBudgetMs: 5000 });
    expect(other).toMatchObject({ modified: true, cacheHits: 1 });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("sends the original body when the time budget runs out, and passes bodies without tool results through", async () => {
    const late = vi.fn(async () => null);
    const body = agy([user, call("c1", "run_command", { CommandLine: "npm run build" }), result("c1", "run_command", { output: buildLog })]);
    const outcome = await compressGeminiBodyAsync(body, { run: late, timeBudgetMs: 5000 });
    expect(outcome).toMatchObject({ timedOut: true, modified: false });
    expect(outcome.body).toBe(body);
    const plain = agy([user]);
    const untouched = await compressGeminiBodyAsync(plain, { run, timeBudgetMs: 5000 });
    expect(untouched).toMatchObject({ modified: false, blocks: [] });
    expect(untouched.body).toBe(plain);
    expect((await compressGeminiBodyAsync({ model: "gemini-3.8-flash-high" }, { run, timeBudgetMs: 5000 })).modified).toBe(false);
  });
});
