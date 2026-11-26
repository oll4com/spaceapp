import { afterEach, describe, expect, it, vi } from "vitest";

const load = async () => {
  vi.resetModules();
  return import("../src/features/terminal-pane/cold-attach-trace.js");
};

describe("PERF-004 cold-attach trace", () => {
  afterEach(() => {
    sessionStorage.clear();
    performance.clearMarks();
  });

  it("marks nothing unless the cold benchmark document turned it on", async () => {
    const { markColdAttach } = await load();
    markColdAttach("socket-open", "pane:a");
    expect(performance.getEntriesByType("mark")).toHaveLength(0);
  });

  it("marks each stage with its pane when the key is set, reading the key once per document", async () => {
    const { COLD_ATTACH_TRACE_KEY, markColdAttach } = await load();
    sessionStorage.setItem(COLD_ATTACH_TRACE_KEY, "1");
    markColdAttach("barrier-released");
    sessionStorage.removeItem(COLD_ATTACH_TRACE_KEY);
    markColdAttach("setup-turn", "pane:a");
    const marks = performance.getEntriesByType("mark") as PerformanceMark[];
    expect(marks.map((mark) => [mark.name, mark.detail])).toEqual([
      ["space-cold-attach:barrier-released", null],
      ["space-cold-attach:setup-turn", "pane:a"]
    ]);
  });
});
