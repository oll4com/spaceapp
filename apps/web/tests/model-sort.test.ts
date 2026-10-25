import { describe, it, expect } from "vitest";
import { createDemoFixture } from "../src/demo/demo-fixture.js";
import { sortModels } from "../src/features/system-analytics/model-sort.js";
describe("model sorting", () => {
  it("sorts numbers numerically and keeps unknown values last in either direction", () => {
    const base = createDemoFixture().systemAnalyticsModels.models[0]!;
    const rows = [100, null, 9].map((tokens, i) => ({ ...base, modelId: String(i), tokensIn: tokens, tokensOut: tokens === null ? null : 0 }));
    expect(sortModels(rows, "total", "asc").map(row => row.tokensIn)).toEqual([9, 100, null]);
    expect(sortModels(rows, "total", "desc").map(row => row.tokensIn)).toEqual([100, 9, null]);
    expect(rows[0]!.tokensIn).toBe(100);
  });
});
