import { describe, expect, it } from "vitest";
import { createCompressors } from "../src/compression/compressors.js";
import { compressBlock } from "../src/compression/engine.js";

const tokens = { count: (text: string) => Math.ceil(text.length / 4) };

describe("compressor registry", () => {
  it("compresses long build logs without retrieval markers", () => {
    const lines = Array.from({ length: 400 }, (_, index) => index % 50 === 0
      ? `2026-10-11 10:00:${String(index % 60).padStart(2, "0")} ERROR worker ${index} failed: connection reset`
      : `2026-10-11 10:00:${String(index % 60).padStart(2, "0")} INFO worker ${index} processed batch ${index * 7} in ${index % 13} ms`);
    const { replacement, action } = compressBlock(lines.join("\n"), createCompressors(), tokens);
    expect(action).toMatchObject({ kind: "compressed", strategy: "log_compressor", contentType: "build" });
    expect(replacement).toContain("ERROR worker 0 failed");
    expect(replacement).not.toContain("<<ccr:");
  });

  it("compresses large diffs without retrieval markers", () => {
    const hunk = (file: number) => [`diff --git a/f${file}.ts b/f${file}.ts`, "index 111..222 100644", `--- a/f${file}.ts`, `+++ b/f${file}.ts`, "@@ -1,40 +1,40 @@",
      ...Array.from({ length: 30 }, (_, line) => ` context line ${line} of file ${file}`), `-old value ${file}`, `+new value ${file}`].join("\n");
    const diff = Array.from({ length: 30 }, (_, file) => hunk(file)).join("\n");
    const { replacement, action } = compressBlock(diff, createCompressors(), tokens);
    expect(action.kind === "compressed" || action.kind === "no_compression" || action.kind === "rejected_not_smaller").toBe(true);
    if (replacement) expect(replacement).not.toContain("<<ccr:");
  });

  it("crushes large JSON arrays, keeping errors and boundaries, without retrieval markers", () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({ id: index, status: index % 17 === 0 ? "error" : "ok", latency_ms: 20 + (index % 5), path: `/api/items/${index}` }));
    const { replacement, action } = compressBlock(JSON.stringify(rows), createCompressors(), tokens);
    expect(action).toMatchObject({ kind: "compressed", strategy: "smart_crusher", contentType: "json_array" });
    const kept = JSON.parse(replacement!) as { id: number; status: string }[];
    expect(kept.length).toBeLessThan(rows.length);
    expect(kept.some((row) => row.id === 0)).toBe(true);
    expect(kept.filter((row) => row.status === "error").length).toBe(rows.filter((row) => row.status === "error").length);
    expect(replacement).not.toContain("<<ccr:");
  });
});
