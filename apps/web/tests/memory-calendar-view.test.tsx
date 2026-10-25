import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCalendarView } from "../src/features/memory-workspace/MemoryCalendarView.js";
import { MemoryWorkspace } from "../src/features/memory-workspace/MemoryWorkspace.js";
import { api, type MemoryCalendarResponseEnvelope } from "../src/live-api.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";

const mockCalendarData: MemoryCalendarResponseEnvelope = {
  data: {
    year: 2026,
    month: "2026-10",
    selectedDate: null,
    availableMonths: ["2026-09", "2026-10"],
    availableYears: [2026],
    stats: {
      totalMemories: 42,
      activeDays: 4,
      yearMemories: 42,
      maxDailyCount: 20
    },
    heatMap: {
      "2026-10-01": { count: 18, bytes: 9000 },
      "2026-10-02": { count: 3, bytes: 1200 },
      "2026-10-03": { count: 20, bytes: 11000 },
      "2026-09-28": { count: 1, bytes: 500 }
    },
    records: [
      {
        id: "memory:test-1",
        title: "Test Release Memory",
        createdAt: "2026-10-01T21:00:00.000Z",
        sourcePath: "/opt/spaceapp/docs/gemini_history_2026-10.md",
        excerpt: "This is a test release note summary",
        tags: ["release"],
        topics: ["production"],
        charCount: 240
      },
      {
        id: "memory:test-2",
        title: "Another Memory",
        createdAt: "2026-10-01T22:30:00.000Z",
        sourcePath: "/opt/spaceapp/docs/gemini_history_2026-10.md",
        excerpt: "Second memory for the same day",
        tags: ["setup"],
        topics: [],
        charCount: 180
      }
    ]
  }
};

describe("MemoryCalendarView", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders Month View by default with current month and weekdays", async () => {
    vi.spyOn(api, "memoryCalendar").mockResolvedValue(mockCalendarData);
    const onSelectNode = vi.fn();
    const onCloseDetail = vi.fn();

    render(
      <MemoryCalendarView
        onSelectNode={onSelectNode}
        selectedNodeId={null}
        onCloseDetail={onCloseDetail}
      />
    );

    // Weekdays header
    expect(screen.getByText("Mon")).toBeDefined();
    expect(screen.getByText("Sun")).toBeDefined();

    // Mode buttons
    const monthBtn = screen.getByRole("button", { name: "Month" });
    const yearBtn = screen.getByRole("button", { name: "Year" });
    expect(monthBtn.getAttribute("aria-pressed")).toBe("true");
    expect(yearBtn.getAttribute("aria-pressed")).toBe("false");

    // Wait for calendar data
    await waitFor(() => {
      expect(screen.getByText("2026")).toBeDefined();
    });
  });

  it("selects a day on click and shows Day Inspector with memories", async () => {
    vi.spyOn(api, "memoryCalendar").mockResolvedValue(mockCalendarData);
    const onSelectNode = vi.fn();
    const onCloseDetail = vi.fn();

    render(
      <MemoryCalendarView
        onSelectNode={onSelectNode}
        selectedNodeId={null}
        onCloseDetail={onCloseDetail}
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/2026-10-01: 18 memories/)).toBeDefined();
    });

    const dayCell = screen.getByLabelText(/2026-10-01: 18 memories/);
    act(() => {
      fireEvent.click(dayCell);
    });

    // Day inspector drawer should appear
    await waitFor(() => {
      expect(screen.getByText("DAY INSPECTOR")).toBeDefined();
      expect(screen.getByText("Test Release Memory")).toBeDefined();
      expect(screen.getByText("Another Memory")).toBeDefined();
    });

    // Inspect Details button
    const inspectBtns = screen.getAllByRole("button", { name: /Inspect Details/ });
    expect(inspectBtns.length).toBeGreaterThan(0);
    act(() => {
      fireEvent.click(inspectBtns[0]!);
    });

    expect(onSelectNode).toHaveBeenCalledWith("memory:test-1");
  });

  it("switches to Year View and displays 12-month matrix and stats", async () => {
    vi.spyOn(api, "memoryCalendar").mockResolvedValue(mockCalendarData);
    const onSelectNode = vi.fn();
    const onCloseDetail = vi.fn();

    render(
      <MemoryCalendarView
        onSelectNode={onSelectNode}
        selectedNodeId={null}
        onCloseDetail={onCloseDetail}
      />
    );

    const yearBtn = screen.getByRole("button", { name: "Year" });
    act(() => {
      fireEvent.click(yearBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("YEAR MEMORIES")).toBeDefined();
      expect(screen.getByText("ACTIVE DAYS")).toBeDefined();
      expect(screen.getByText("BUSIEST DAY")).toBeDefined();
    });

    // Month cards in year view
    expect(screen.getByText("January")).toBeDefined();
    expect(screen.getByText("December")).toBeDefined();
  });

  it("selects a day in Year View and opens Day Inspector", async () => {
    vi.spyOn(api, "memoryCalendar").mockResolvedValue(mockCalendarData);
    const onSelectNode = vi.fn();
    const onCloseDetail = vi.fn();

    render(
      <MemoryCalendarView
        onSelectNode={onSelectNode}
        selectedNodeId={null}
        onCloseDetail={onCloseDetail}
      />
    );

    const yearBtn = screen.getByRole("button", { name: "Year" });
    act(() => {
      fireEvent.click(yearBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("October")).toBeDefined();
    });

    const miniCell = screen.getByRole("button", { name: "2026-10-01: 18 memories" });
    expect(miniCell.classList.contains("mini-cell")).toBe(true);

    act(() => {
      fireEvent.click(miniCell);
    });

    await waitFor(() => {
      expect(screen.getByText("DAY INSPECTOR")).toBeDefined();
      expect(screen.getByText("Test Release Memory")).toBeDefined();
    });
  });

  it("opens in Calendar mode by default when mounted inside MemoryWorkspace", async () => {
    vi.spyOn(api, "memoryCalendar").mockResolvedValue(mockCalendarData);
    vi.spyOn(api, "memoryGraphOverview").mockResolvedValue({
      data: {
        version: 2,
        layoutVersion: 2,
        taxonomyVersion: 1,
        revisionHash: "c".repeat(64),
        generatedAt: "2026-07-16T08:00:00.000Z",
        sourceHash: "a".repeat(64),
        isStale: false,
        summary: { sourceCount: 1, recordCount: 42, nodeCount: 0, edgeCount: 0, issueCount: 0 },
        nodes: [],
        edges: [],
        totalMatchingNodes: 0,
        totalMatchingEdges: 0,
        truncated: false,
        filters: { q: null, nodeType: null, scope: null, roomId: null, sourcePath: null, lifecycleStatus: null, relationMode: "CLUSTERED" },
        months: []
      }
    });

    await act(async () => {
      render(
        <MemoryWorkspace
          shellMode="desktop"
          activeRoomId="room:test"
          onClose={() => undefined}
        />
      );
    });

    expect(api.memoryGraphOverview).not.toHaveBeenCalled();

    // Verify brand shows CALENDAR
    expect(screen.getByText("CALENDAR")).toBeDefined();

    // Verify mode switcher has Calendar active
    const calendarPill = screen.getByRole("button", { name: /Calendar/ });
    expect(calendarPill.getAttribute("aria-pressed")).toBe("true");
    const atlasPill = screen.getByRole("button", { name: /Atlas/ });
    expect(atlasPill.getAttribute("aria-pressed")).toBe("false");

    // Verify Month view is rendered
    expect(screen.getByRole("button", { name: "Month" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Year" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /^Atlas$/ }));
    await waitFor(() => expect(api.memoryGraphOverview).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /^Calendar$/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search canonical memory" }), { target: { value: "release" } });
    fireEvent.submit(screen.getByRole("search"));
    await act(async () => {});
    expect(api.memoryGraphOverview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /^Atlas$/ }));
    await waitFor(() => expect(api.memoryGraphOverview).toHaveBeenLastCalledWith({ q: "release", month: "all", relationMode: "RELATIONS" }));

  });
});


