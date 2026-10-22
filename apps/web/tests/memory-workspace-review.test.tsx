import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../src/features/memory-workspace/MemoryWorkspace.js";
import { api } from "../src/live-api.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const graphMounted = vi.hoisted(() => vi.fn());
vi.mock("../src/features/memory-workspace/DesktopMemoryGraph.js", () => ({
  default: () => { graphMounted(); return <div data-testid="memory-graph-renderer" />; }
}));

const calendar = {
  data: {
    year: 2026, month: "2026-10", selectedDate: null, availableMonths: ["2026-10"], availableYears: [2026],
    stats: { totalMemories: 0, activeDays: 0, yearMemories: 0, maxDailyCount: 0 }, heatMap: {}, records: []
  }
};
const issue = {
  id: "memory-issue:dup", type: "DUPLICATE_CANDIDATE", severity: "WARNING", status: "OPEN", confidence: 0.9,
  evidence: "Two records share a title.", sourcePath: "/opt/spaceapp/docs/space_memory_2026-10.md", recordId: "memory:a",
  statusReason: null, stateVersion: 1
};

describe("Memory workspace Review mode and mobile view", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    vi.spyOn(api, "memoryCalendar").mockResolvedValue(calendar as never);
    vi.spyOn(api, "memoryGraphOverview").mockResolvedValue({ data: { nodes: [], edges: [], summary: { recordCount: 0 } } } as never);
    vi.spyOn(api, "memoryGraphIssues").mockResolvedValue({ data: [issue], pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } } as never);
    vi.spyOn(api, "memoryChangeSets").mockResolvedValue({ data: [], pagination: { page: 1, pageSize: 20, hasNext: false }, mutationsEnabled: false } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); graphMounted.mockReset(); });

  it.each(["desktop", "tablet"] as const)("mounts open issues, change sets and maintenance jobs in Review on %s", async shellMode => {
    render(<MemoryWorkspace shellMode={shellMode} activeRoomId={null} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("button", { name: "Review" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(screen.getByLabelText("Open memory issues").textContent).toContain("Two records share a title."));
    expect(api.memoryGraphIssues).toHaveBeenCalledWith({ status: "OPEN", pageSize: 100 });
    expect(screen.getByLabelText("Memory change sets")).toBeTruthy();
    expect(screen.getByLabelText("Memory maintenance jobs")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Atlas" })).toBeTruthy();
  });

  it("shows only the Calendar list on mobile, even when asked for the atlas, and never mounts the graph", async () => {
    render(<MemoryWorkspace shellMode="mobile" activeRoomId={null} onClose={() => undefined} initialMode="atlas" />);
    await waitFor(() => expect(api.memoryCalendar).toHaveBeenCalled());
    expect(document.querySelector("#memory-atlas")?.getAttribute("data-workspace-mode")).toBe("calendar");
    expect(screen.queryByRole("button", { name: "Atlas" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(screen.queryByTestId("memory-graph-renderer")).toBeNull();
    expect(graphMounted).not.toHaveBeenCalled();
    expect(api.memoryGraphOverview).not.toHaveBeenCalled();
  });
});
