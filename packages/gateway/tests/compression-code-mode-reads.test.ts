import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createCompressors, initCompressors } from "../src/compression/compressors.js";
import { compressBlock, compressResponsesBodyAsync, type AsyncBlockRunner, type BlockResult } from "../src/compression/engine.js";
import { expandRuns, searchUnheading } from "../src/compression/lossless/index.js";
import { CompressionPool } from "../src/compression/pool.js";
import { codeModeCommands } from "../src/compression/read-protection.js";

const tokens = { count: (text: string) => Math.ceil(text.length / 4) };
const compressors = createCompressors();
const run: AsyncBlockRunner = async (text, _deadline, options = {}): Promise<BlockResult> => compressBlock(text, compressors, tokens, undefined, options);
/** Headroom's own CodeAware fixture: a Python module whose function bodies shorten to their first statements. */
const python = (JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "headroom-parity", "code_aware_compressor", "e79625ba83a6f22d.json"), "utf8")) as { input: string }).input;

/** A Codex code-mode turn: `exec` runs JavaScript that calls tools, and its output comes back as text parts. */
const execTurn = (id: string, source: string) => [
  { type: "custom_tool_call", call_id: id, name: "exec", input: source },
  { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text: python }] }
];

beforeAll(async () => { await initCompressors(); });

describe("Codex code-mode file reads", () => {
  it("reads the commands of code-mode JavaScript, decoding string escapes", () => {
    const source = `const a = await tools.exec_command({ cmd: "sed -n '1,120p' app/logging_setup.py", yield_time_ms: 1000 });
text(a.output);
const b = await exec_command({cmd:'cat "a b.txt"'});
await exec_command({ cmd: \`git status --short\` });
await exec_command({ cmd: "printf \\"x\\\\n\\" | head -n 1" });`;
    expect(codeModeCommands(source)).toEqual(["sed -n '1,120p' app/logging_setup.py", "cat \"a b.txt\"", "git status --short", "printf \"x\\n\" | head -n 1"]);
    expect(codeModeCommands("text('no commands here')")).toEqual([]);
  });

  it("keeps a file read through exec exact and still compresses other exec output", async () => {
    const body = { input: [
      ...execTurn("read", `const r = await tools.exec_command({ cmd: "cd /repo && sed -n '1,120p' app/logging_setup.py" });\ntext(r.output);`),
      ...execTurn("run", `const r = await tools.exec_command({ cmd: "python3 scripts/print_module.py" });\ntext(r.output);`)
    ] };
    const outcome = await compressResponsesBodyAsync(body, { run, timeBudgetMs: 5000, codeText: "ON", profile: "TOKEN" });
    const input = outcome.body.input as Array<{ output?: Array<{ text: string }> }>;
    expect(input[1]!.output![0]!.text).toBe(python);
    expect(input[3]!.output![0]!.text).toContain("# [9 lines omitted]");
  });
});

describe("file reads stay exact for every content type", () => {
  const exact = { codeText: "ON" as const, lossy: false, exact: true };
  const rows = JSON.stringify(Array.from({ length: 80 }, (_, index) => ({ id: index, status: index === 41 ? "error" : "ok", path: `/api/items/${index}` })), null, 2);
  const grep = Array.from({ length: 40 }, (_, index) => `src/compression/engine.ts:${index + 10}:  const value${index} = compressBlock(text);`).join("\n");
  const colored = `${"\x1b[32mok\x1b[0m step done\n".repeat(60)}\x1b[31mfinished\x1b[0m`;

  it("never drops items, lines or color from a read; only exact folds apply", () => {
    // SmartCrusher would drop array items; a read keeps them all.
    expect(compressBlock(rows, compressors, tokens, undefined, { codeText: "ON", lossy: true }).action).toMatchObject({ kind: "compressed", strategy: "smart_crusher" });
    expect(compressBlock(rows, compressors, tokens, undefined, exact).replacement).toBeNull();
    // A grep-shaped read folds under file headings, and the inverse gives back every byte.
    const folded = compressBlock(grep, compressors, tokens, undefined, exact);
    expect(folded.action).toMatchObject({ kind: "compressed", strategy: "lossless_fold" });
    expect(searchUnheading(folded.replacement!)).toBe(grep);
    // The log fold strips ANSI color; a read keeps it and only collapses the repeated lines.
    const runs = compressBlock(colored, compressors, tokens, undefined, exact);
    expect(runs.action).toMatchObject({ kind: "compressed", strategy: "lossless_fold" });
    expect(expandRuns(runs.replacement!)).toBe(colored);
    // A JSON result of a read keeps every field and item; repeated lines inside a field fold exactly.
    const result = JSON.stringify({ exit_code: 0, output: colored, rows: JSON.parse(rows) as unknown[] });
    const jsonRead = compressBlock(result, compressors, tokens, undefined, exact);
    expect(jsonRead.action).toMatchObject({ kind: "compressed", strategy: "json_fields" });
    const back = JSON.parse(jsonRead.replacement!) as { exit_code: number; output: string; rows: unknown[] };
    expect(expandRuns(back.output)).toBe(colored);
    expect(back.rows).toEqual(JSON.parse(rows));
    // With code and prose off, a read of source code passes through as that setting says.
    expect(compressBlock(python, compressors, tokens, undefined, { exact: true }).replacement).toBeNull();
  });

  it("applies to a read through code-mode exec, and the worker pool passes the flag to its workers", async () => {
    const turn = (id: string, cmd: string) => [
      { type: "custom_tool_call", call_id: id, name: "exec", input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)} });\ntext(r.output);` },
      { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text: rows }] }
    ];
    const body = { input: [...turn("read", "cat data/items.json"), ...turn("query", "curl -s localhost:4910/api/items")] };
    const outcome = await compressResponsesBodyAsync(body, { run, timeBudgetMs: 5000, codeText: "ON", profile: "TOKEN" });
    const input = outcome.body.input as Array<{ output?: Array<{ text: string }> }>;
    expect(input[1]!.output![0]!.text).toBe(rows);
    expect(input[3]!.output![0]!.text).not.toBe(rows);
    const directory = mkdtempSync(join(tmpdir(), "gateway-exact-"));
    writeFileSync(join(directory, "worker.mjs"), `import { parentPort } from "node:worker_threads";
parentPort.on("message", (job) => parentPort.postMessage({ id: job.id, replacement: JSON.stringify({ exact: job.exact ?? false, lossy: job.lossy ?? null }),
  action: { kind: "no_compression", contentType: "text" } }));
parentPort.postMessage({ ready: true });`);
    const pool = new CompressionPool(pathToFileURL(join(directory, "worker.mjs")), 1);
    try {
      expect(JSON.parse((await pool.run("x", Date.now() + 5000, { codeText: "ON", lossy: false, exact: true }))!.replacement!)).toEqual({ exact: true, lossy: false });
      expect(JSON.parse((await pool.run("x", Date.now() + 5000, { exact: true }))!.replacement!)).toEqual({ exact: true, lossy: null });
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
