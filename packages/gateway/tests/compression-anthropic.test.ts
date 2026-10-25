import { beforeAll, describe, expect, it, vi } from "vitest";
import { createCompressors, initCompressors } from "../src/compression/compressors.js";
import { compressAnthropicBodyAsync, compressBlock, compressResponsesBodyAsync, CompressionCache, RawBlockRegistry, type AsyncBlockRunner,
  type BlockResult } from "../src/compression/engine.js";

const tokens = { count: (text: string) => Math.ceil(text.length / 4) };
const compressors = createCompressors();
const real: AsyncBlockRunner = async (text, _deadline, options) => compressBlock(text, compressors, tokens, undefined, options);
const log = (tag: string) => Array.from({ length: 300 }, (_, index) => `2026-10-11T10:00:${String(index % 60).padStart(2, "0")} INFO ${tag} heartbeat ${index} ok`).join("\n")
  + `\n2026-10-11T10:05:00 ERROR ${tag} build failed: missing module\n`;
const compressed = (text: string): BlockResult => ({ replacement: text.slice(0, 600), action: { kind: "compressed", strategy: "log_compressor", contentType: "build",
  originalBytes: text.length, compressedBytes: 600, originalTokens: Math.ceil(text.length / 4), compressedTokens: 150 } });
const user = (id: string, text: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] });
const assistant = (id: string) => ({ role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "npm test" } }] });

beforeAll(async () => { await initCompressors(); });

describe("Anthropic compression across turns", () => {
  it("sends the same bytes for earlier messages on the next turn", async () => {
    const cache = new CompressionCache();
    const first = { messages: [assistant("a"), user("a", log("alpha")), assistant("b"), user("b", log("beta"))] };
    const turn1 = await compressAnthropicBodyAsync(first, { run: real, timeBudgetMs: 5000, cache });
    expect(turn1.modified).toBe(true);
    expect(turn1.blocks.filter((block) => block.action.kind === "compressed")).toHaveLength(2);
    const second = { messages: [...first.messages, assistant("c"), user("c", log("gamma"))] };
    const turn2 = await compressAnthropicBodyAsync(second, { run: real, timeBudgetMs: 5000, cache });
    expect(JSON.stringify((turn2.body.messages as unknown[]).slice(0, 4))).toBe(JSON.stringify((turn1.body.messages as unknown[]).slice(0, 4)));
    expect(turn2.cacheHits).toBe(2);
    expect(first.messages[1]!.content[0]!.content).toBe(log("alpha"));
  });

  it("keeps a block raw for the rest of its conversation after it missed the budget", async () => {
    const cache = new CompressionCache();
    const rawBlocks = new RawBlockRegistry();
    const slow = log("slow");
    let late = true;
    const run = vi.fn<AsyncBlockRunner>(async (text, _deadline, options) => {
      if (text === slow && late) { late = false; options?.onLate?.(compressed(text)); return null; }
      return compressed(text);
    });
    const body = { messages: [assistant("a"), user("a", slow), assistant("b"), user("b", log("fast"))] };
    const turn1 = await compressAnthropicBodyAsync(body, { run, timeBudgetMs: 1000, cache, rawBlocks, sessionKey: "s1" });
    expect(turn1.timedOut).toBe(true);
    expect(turn1.modified).toBe(true);
    const sent1 = turn1.body.messages as Array<{ content: Array<{ content: string }> }>;
    expect(sent1[1]!.content[0]!.content).toBe(slow);
    expect(sent1[3]!.content[0]!.content.length).toBe(600);
    // The late result is cached now, but this conversation already received the block raw.
    const turn2 = await compressAnthropicBodyAsync(body, { run, timeBudgetMs: 1000, cache, rawBlocks, sessionKey: "s1" });
    const sent2 = turn2.body.messages as Array<{ content: Array<{ content: string }> }>;
    expect(sent2[1]!.content[0]!.content).toBe(slow);
    expect(turn2.blocks.find((block) => block.itemIndex === 1)!.action).toEqual({ kind: "kept_raw", bytes: Buffer.byteLength(slow) });
    expect(turn2.timedOut).toBe(false);
    // Another conversation gets the cached result.
    const other = await compressAnthropicBodyAsync(body, { run, timeBudgetMs: 1000, cache, rawBlocks, sessionKey: "s2" });
    expect((other.body.messages as Array<{ content: Array<{ content: string }> }>)[1]!.content[0]!.content.length).toBe(600);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("applies the same rule to Responses bodies", async () => {
    const cache = new CompressionCache();
    const rawBlocks = new RawBlockRegistry();
    const slow = log("slow");
    let late = true;
    const run = vi.fn<AsyncBlockRunner>(async (text, _deadline, options) => {
      if (late) { late = false; options?.onLate?.(compressed(text)); return null; }
      return compressed(text);
    });
    const body = { input: [{ type: "function_call_output", call_id: "x", output: slow }] };
    const turn1 = await compressResponsesBodyAsync(body, { run, timeBudgetMs: 1000, cache, rawBlocks, sessionKey: "codex-1" });
    expect(turn1.modified).toBe(false);
    const turn2 = await compressResponsesBodyAsync(body, { run, timeBudgetMs: 1000, cache, rawBlocks, sessionKey: "codex-1" });
    expect(turn2.modified).toBe(false);
    expect(turn2.blocks[0]!.action.kind).toBe("kept_raw");
    const other = await compressResponsesBodyAsync(body, { run, timeBudgetMs: 1000, cache, rawBlocks, sessionKey: "codex-2" });
    expect(other.modified).toBe(true);
  });

  it("passes a tool error through whole and folds file reads losslessly only", async () => {
    const run = vi.fn<AsyncBlockRunner>(async (text, _deadline, options) => compressBlock(text, compressors, tokens, undefined, options));
    const repeated = `${"waiting for the build to finish\n".repeat(40)}build finished in 42s\n`;
    const failure = `${"npm run build\n> tsc -p tsconfig.json\n".repeat(30)}src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\nnpm ERR! code ELIFECYCLE\n`;
    expect(Buffer.byteLength(failure)).toBeLessThan(8000);
    const body = { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "/repo/build.log" } }, { type: "tool_use", id: "e", name: "Bash", input: { command: "npm run build" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "r", content: repeated }, { type: "tool_result", tool_use_id: "e", is_error: true, content: failure }] }
    ] };
    const outcome = await compressAnthropicBodyAsync(body, { run, timeBudgetMs: 5000, codeText: "ON", profile: "TOKEN" });
    expect(outcome.blocks.map((block) => block.action.kind)).toEqual(["compressed", "protected"]);
    expect(outcome.blocks[0]!.action).toMatchObject({ strategy: "lossless_fold" });
    expect(outcome.blocks[1]!.action).toMatchObject({ reason: "tool_error" });
    expect(run).toHaveBeenCalledTimes(1);
    const content = (outcome.body.messages as Array<{ content: Array<{ content: string }> }>)[1]!.content;
    expect(content[1]!.content).toBe(failure);
  });

  it("bounds the registry by sessions and refreshes a session on use", () => {
    const registry = new RawBlockRegistry(2);
    registry.add("s1", "k");
    registry.add("s2", "k");
    expect(registry.has("s1", "k")).toBe(true);
    registry.add("s3", "k");
    expect(registry.size).toBe(2);
    expect(registry.has("s2", "k")).toBe(false);
    expect(registry.has("s1", "k")).toBe(true);
    expect(registry.has("s3", "k")).toBe(true);
  });
});
