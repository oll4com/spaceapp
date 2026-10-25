import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompressionCache, compressResponsesBodyAsync } from "../src/compression/engine.js";
import { CompressionPool } from "../src/compression/pool.js";

// A stand-in worker: "slow" inputs spin until killed; others come back shortened.
const workerSource = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", ({ id, text }) => {
  if (text.startsWith("slow")) { const end = Date.now() + 60_000; while (Date.now() < end) {} }
  if (text.startsWith("late")) { const end = Date.now() + 300; while (Date.now() < end) {} }
  parentPort.postMessage({ id, replacement: text.slice(0, 600), action: { kind: "compressed", strategy: "smart_crusher", contentType: "json_array",
    originalBytes: text.length, compressedBytes: 600, originalTokens: Math.ceil(text.length / 4), compressedTokens: 150 } });
});
parentPort.postMessage({ ready: true });`;
const directory = mkdtempSync(join(tmpdir(), "gateway-pool-"));
writeFileSync(join(directory, "worker.mjs"), workerSource);
const pools: CompressionPool[] = [];
const pool = (size: number) => { const created = new CompressionPool(pathToFileURL(join(directory, "worker.mjs")), size, 300); pools.push(created); return created; };
afterEach(async () => { await Promise.all(pools.splice(0).map((item) => item.close())); });

describe("compression worker pool", () => {
  it("runs blocks off the event loop and gives up on blocks that miss the deadline", async () => {
    const workers = pool(1);
    expect((await workers.run("x".repeat(1000), Date.now() + 5000))?.replacement).toHaveLength(600);
    const started = Date.now();
    expect(await workers.run(`slow${"y".repeat(1000)}`, Date.now() + 200)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    // The stuck worker was replaced at the hard limit, so the pool keeps serving.
    expect((await workers.run("z".repeat(1000), Date.now() + 5000))?.action.kind).toBe("compressed");
  });

  it("hands a result that misses the deadline to onLate for the next request", async () => {
    const workers = new CompressionPool(pathToFileURL(join(directory, "worker.mjs")), 1, 3000);
    pools.push(workers);
    await workers.run("x".repeat(1000), Date.now() + 5000);
    const late: unknown[] = [];
    expect(await workers.run(`late${"q".repeat(1000)}`, Date.now() + 100, { onLate: (result) => late.push(result) })).toBeNull();
    await vi.waitFor(() => expect(late).toHaveLength(1), { timeout: 4000, interval: 25 });
    expect((await workers.run("w".repeat(1000), Date.now() + 2000))?.replacement).toHaveLength(600);
  });

  it("compresses a body's blocks concurrently, caches them, and keeps blocks that time out", async () => {
    const workers = pool(2);
    const cache = new CompressionCache();
    const body = { input: [
      { type: "function_call_output", call_id: "a", output: "a".repeat(2000) },
      { type: "function_call_output", call_id: "b", output: `slow${"b".repeat(2000)}` }
    ] };
    // The budget leaves a busy host time for the quick block; the slow one spins far past it.
    const first = await compressResponsesBodyAsync(body, { run: workers.run, cache, timeBudgetMs: 2000 });
    expect(first.modified).toBe(true);
    expect(first.timedOut).toBe(true);
    const input = first.body.input as { output: string }[];
    expect(input[0]!.output).toHaveLength(600);
    expect(input[1]!.output).toBe(body.input[1]!.output);
    const again = await compressResponsesBodyAsync({ input: [body.input[0]!] }, { run: async () => { throw new Error("not called"); }, cache, timeBudgetMs: 300 });
    expect((again.body.input as { output: string }[])[0]!.output).toHaveLength(600);
    expect(cache.hits).toBe(1);
  });
});

describe("compression worker readiness", () => {
  it("holds jobs until a worker is ready and gives up on them at their deadline", async () => {
    const lateDirectory = mkdtempSync(join(tmpdir(), "gateway-pool-late-"));
    writeFileSync(join(lateDirectory, "worker.mjs"), `
import { parentPort } from "node:worker_threads";
const end = Date.now() + 400; while (Date.now() < end) {}
parentPort.on("message", ({ id, text }) => parentPort.postMessage({ id, replacement: null, action: { kind: "no_compression", contentType: "text" } }));
parentPort.postMessage({ ready: true });`);
    const workers = new CompressionPool(pathToFileURL(join(lateDirectory, "worker.mjs")), 1);
    pools.push(workers);
    const started = Date.now();
    expect(await workers.run("early", Date.now() + 100)).toBeNull();
    expect(Date.now() - started).toBeLessThan(350);
    expect((await workers.run("later", Date.now() + 5000))?.action.kind).toBe("no_compression");
  });
});

describe("Codex custom tool outputs", () => {
  it("compresses custom_tool_call_output text parts and string outputs, leaving other parts and the original body untouched", async () => {
    const { compressBlock } = await import("../src/compression/engine.js");
    const { createCompressors } = await import("../src/compression/compressors.js");
    const compressors = createCompressors();
    const run = async (text: string) => compressBlock(text, compressors, { count: (value: string) => Math.ceil(value.length / 4) });
    const log = Array.from({ length: 300 }, (_, index) => `2026-10-12 10:00:${String(index % 60).padStart(2, "0")} INFO worker ${index % 4} processed batch ${index}`).join("\n")
      + "\n2026-10-12 10:05:00 ERROR worker 2 failed: connection reset\n";
    const body = { input: [
      { type: "custom_tool_call", call_id: "c1", name: "exec", input: "make" },
      { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "Exit code 0, wall time 2s" }, { type: "input_text", text: log }] },
      { type: "custom_tool_call_output", call_id: "c2", output: log }
    ] };
    const outcome = await compressResponsesBodyAsync(body, { run, timeBudgetMs: 5000 });
    expect(outcome.modified).toBe(true);
    const input = outcome.body.input as Array<{ output: unknown }>;
    const parts = input[1]!.output as Array<{ type: string; text: string }>;
    expect(parts[0]).toEqual({ type: "input_text", text: "Exit code 0, wall time 2s" });
    expect(parts[1]!.type).toBe("input_text");
    expect(parts[1]!.text.length).toBeLessThan(log.length);
    expect(parts[1]!.text).toContain("ERROR worker 2 failed");
    expect((input[2]!.output as string).length).toBeLessThan(log.length);
    expect((body.input[1]!.output as Array<{ text: string }>)[1]!.text).toBe(log);
    expect(outcome.blocks.map((block) => block.blockType)).toEqual(["custom_tool_call_output#0", "custom_tool_call_output#1", "custom_tool_call_output"]);
  });
});
