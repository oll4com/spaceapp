import { describe, expect, it } from "vitest";
import { CompressionCache, compressBlock, compressResponsesBodyAsync, type BlockResult, type Compressors } from "../src/compression/engine.js";
import { compressionDetail, compressionSignalRows } from "../src/compression/recorder.js";
import { detectWasteSignals } from "../src/compression/waste-signals.js";

/** One token per character keeps the arithmetic visible. */
const chars = { count: (text: string) => text.length };

describe("waste signals (Headroom detect_waste_signals)", () => {
  it("counts HTML tags and comments, base64 blobs, whitespace runs and JSON blocks over 500 tokens", () => {
    const html = "<div class=\"a\">x</div><!-- note -->";
    // As in Headroom, the tag pattern also matches the comment, so a comment counts twice.
    expect(detectWasteSignals(html, chars).html_noise).toBe("<div class=\"a\"></div><!-- note -->".length + "<!-- note -->".length);
    const blob = "A".repeat(60) + "==";
    expect(detectWasteSignals(`data:${blob} end`, chars).base64).toBe(62);
    expect(detectWasteSignals("short AAAA", chars).base64).toBe(0);
    // Two runs ("    " and "\n\n\n"): 7 characters joined, 8 joined by a space -> no saving with a 1-char-per-token count.
    expect(detectWasteSignals("a    b\n\n\nc", chars).whitespace).toBe(0);
    const words = { count: (text: string) => text.split(/(\s+)/).filter(Boolean).length };
    expect(detectWasteSignals("a        b\t\t\t\tc", words).whitespace).toBe(0);
    const json = `{${"\"k\":1,".repeat(120)}"end":0}`;
    expect(detectWasteSignals(json, chars).json_bloat).toBe(json.length);
    expect(detectWasteSignals(`{${"x".repeat(498)}}`, chars).json_bloat).toBe(0);
    expect(detectWasteSignals("", chars)).toEqual({ json_bloat: 0, html_noise: 0, base64: 0, whitespace: 0 });
  });
});

describe("compression analysis", () => {
  const compressors: Compressors = { smartCrusher: (text) => JSON.stringify(JSON.parse(text).slice(0, 3)) };
  const big = JSON.stringify(Array.from({ length: 40 }, (_, index) => ({ id: index, note: `<b>row ${index}</b>` })));

  it("times each stage and reports the block's waste", () => {
    let clock = 0;
    const result = compressBlock(big, compressors, chars, () => (clock += 1));
    expect(result.action.kind).toBe("compressed");
    expect(Object.keys(result.analysis!.stageMs).sort()).toEqual(["compressor:smart_crusher", "content_router", "error_protection", "json_check", "protected_lines", "token_count", "waste_signals"]);
    expect(result.analysis!.waste.html_noise).toBe(40 * "<b></b>".length);
    expect(compressBlock("tiny", compressors, chars).analysis).toBeUndefined();
  });

  it("sums waste and stage time per request, counts re-reads, and charges no stage time for cache hits", async () => {
    const cache = new CompressionCache();
    const run = async (text: string): Promise<BlockResult> => compressBlock(text, compressors, chars);
    const reread = "y".repeat(400);
    const body = { input: [
      { type: "function_call_output", call_id: "a", output: reread },
      { type: "message", role: "user", content: [] }, { type: "message", role: "user", content: [] }, { type: "message", role: "user", content: [] },
      { type: "function_call_output", call_id: "b", output: big },
      { type: "function_call_output", call_id: "c", output: reread }
    ] };
    const first = await compressResponsesBodyAsync(body, { run, cache, timeBudgetMs: 5000 });
    expect(first.modified).toBe(true);
    expect(first.waste.html_noise).toBe(40 * "<b></b>".length);
    // The whole array is one greedy {...} match above 500 tokens.
    expect(first.waste.json_bloat).toBe(big.length - 2);
    // The second serve of the same 100-token result, five positions later: 100 estimated tokens + 4.
    expect(first.waste.reread).toBe(104);
    expect(first.stageMs["compressor:smart_crusher"]).toBeGreaterThanOrEqual(0);
    expect(first.cacheHits).toBe(0);
    const second = await compressResponsesBodyAsync(body, { run, cache, timeBudgetMs: 5000 });
    expect(second.cacheHits).toBe(1);
    expect(second.stageMs).toEqual({});
    expect(second.waste.html_noise).toBe(first.waste.html_noise);

    const rows = compressionSignalRows(first, { at: "2030-01-01T10:20:00.000Z", mode: "ON", provider: "CODEX" });
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "waste", name: "html_noise", value: 280, count: 1 }),
      expect.objectContaining({ kind: "waste", name: "reread", value: 104 }),
      expect.objectContaining({ kind: "stage", name: "pipeline_total", count: 1 })
    ]));
    expect(compressionSignalRows(second, { at: "2030-01-01T10:20:00.000Z", mode: "ON", provider: "CODEX" }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "stage", name: "cache_hit", count: 1 })]));
    expect(compressionDetail(first)).toEqual({ strategies: ["smart_crusher"], waste: { html_noise: 280, json_bloat: big.length - 2, reread: 104 } });
    expect(compressionDetail({ ...first, blocks: [], waste: {} })).toBeNull();
  });

  it("counts a re-issued call (same tool and arguments, any key order) even when its result bytes differ, but not polling", async () => {
    const run = async (text: string): Promise<BlockResult> => compressBlock(text, compressors, chars);
    const listing = (stamp: string) => `${stamp}\n${"file.txt  4096 bytes\n".repeat(12)}`;
    const user = { type: "message", role: "user", content: [] };
    const body = { input: [
      { type: "function_call", call_id: "a", name: "exec_command", arguments: JSON.stringify({ cmd: "ls -l", workdir: "/repo" }) },
      { type: "function_call_output", call_id: "a", output: listing("10:00:00") },
      user, user, user,
      { type: "function_call", call_id: "b", name: "exec_command", arguments: JSON.stringify({ workdir: "/repo", cmd: "ls -l" }) },
      { type: "function_call_output", call_id: "b", output: listing("10:05:00") },
      { type: "function_call", call_id: "c", name: "exec_command", arguments: JSON.stringify({ cmd: "ls -l", workdir: "/repo" }) },
      { type: "function_call_output", call_id: "c", output: listing("10:06:00") }
    ] };
    const outcome = await compressResponsesBodyAsync(body, { run, timeBudgetMs: 5000 });
    // Call b repeats call a five positions later; call c repeats b two positions later (polling, not counted).
    expect(outcome.waste.reread).toBe(Math.ceil(listing("10:05:00").length / 4) + 4);
  });
});
