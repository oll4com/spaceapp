import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateMemoryQueries } from "../src/index.js";

describe("memory query evaluation", () => {
  it("meets the v1 recall, reciprocal-rank and false-positive gates deterministically", async () => {
    const fixture = JSON.parse(await readFile(resolve(process.cwd(), "eval/memory-query-fixtures.json"), "utf8"));
    const first = evaluateMemoryQueries(fixture.documents, fixture.queries);
    const second = evaluateMemoryQueries(fixture.documents, fixture.queries);

    expect(first.counts).toEqual({ documents: 15, positiveQueries: 30, negativeQueries: 10 });
    expect(first.metrics.recallAt5).toBeGreaterThanOrEqual(0.85);
    expect(first.metrics.meanReciprocalRank).toBeGreaterThanOrEqual(0.75);
    expect(first.metrics.falsePositiveRate).toBeLessThanOrEqual(0.05);
    expect(first.passed).toBe(true);
    expect(second).toEqual(first);
  });

  it("counts a missed known record and a negative false positive", () => {
    const report = evaluateMemoryQueries(
      [{ id: "memory:one", title: "Room graph", body: "Durable memory", provenance: "test", createdAt: "2026-07-13T00:00:00.000Z" }],
      [
        { id: "positive", query: "missing record", expectedIds: ["memory:missing"] },
        { id: "negative", query: "room graph", expectedIds: [] }
      ]
    );

    expect(report.metrics).toEqual({ recallAt5: 0, meanReciprocalRank: 0, falsePositiveRate: 1 });
    expect(report.passed).toBe(false);
  });
});
