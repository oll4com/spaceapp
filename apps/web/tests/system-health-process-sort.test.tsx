import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemAnalyticsProcessesResponse } from "@space/contracts";
import {
  HealthProcessTable,
  processSortDefaultDirection,
} from "../src/features/system-health/HealthTables.js";
import { defaultHealthThresholds } from "../src/features/system-health/health-model.js";

const mocks = vi.hoisted(() => ({ processes: vi.fn() }));
vi.mock("../src/api.js", () => ({
  api: { systemAnalyticsProcesses: mocks.processes },
}));

const fixture: SystemAnalyticsProcessesResponse = {
  data: [
    {
      pid: 100,
      parentPid: 1,
      name: "space-api",
      state: "S",
      threadCount: 12,
      uptimeSeconds: 600,
      rssBytes: 1024,
      virtualBytes: 2048,
      swapBytes: 0,
      cpuOneCorePercent: 12.5,
      cpuHostPercent: 0.8,
      ownership: "OTHER",
      roomName: null,
      paneTitle: null,
      runtimeId: null,
      sessionId: null,
    },
  ],
  pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
  sampledAt: "2026-09-11T08:00:00.000Z",
};

const headerCells = () =>
  Array.from(document.querySelectorAll("thead th"));

const waitForLoad = () => waitFor(() => expect(mocks.processes).toHaveBeenCalled());

describe("health process column sorting", () => {
  afterEach(() => {
    cleanup();
    mocks.processes.mockReset();
  });

  it("defaults text columns to ascending and numeric columns to descending", () => {
    expect(processSortDefaultDirection("name")).toBe("asc");
    expect(processSortDefaultDirection("state")).toBe("asc");
    for (const key of ["cpu", "rss", "pid", "threads", "uptime"] as const) {
      expect(processSortDefaultDirection(key), key).toBe("desc");
    }
  });

  it("sorts by a clicked column header and toggles direction on repeat clicks", async () => {
    mocks.processes.mockResolvedValue(fixture);
    render(<HealthProcessTable thresholds={defaultHealthThresholds} />);
    await waitForLoad();
    expect(mocks.processes).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: "cpu", direction: "desc" }),
    );
    expect(headerCells()[1]?.getAttribute("aria-sort")).toBe("descending");
    expect(headerCells()[2]?.getAttribute("aria-sort")).toBe("none");

    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    await waitFor(() =>
      expect(mocks.processes).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: "rss", direction: "desc" }),
      ),
    );
    expect(headerCells()[2]?.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(screen.getByRole("button", { name: "State" }));
    await waitFor(() =>
      expect(mocks.processes).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: "state", direction: "asc" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "CPU" }));
    await waitFor(() =>
      expect(mocks.processes).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: "cpu", direction: "desc" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "CPU" }));
    await waitFor(() =>
      expect(mocks.processes).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: "cpu", direction: "asc" }),
      ),
    );
    expect(headerCells()[1]?.getAttribute("aria-sort")).toBe("ascending");
  });

  it("keeps the sort dropdown in sync with the column headers", async () => {
    mocks.processes.mockResolvedValue(fixture);
    render(<HealthProcessTable thresholds={defaultHealthThresholds} />);
    await waitForLoad();

    fireEvent.change(screen.getByLabelText("Sort processes"), {
      target: { value: "threads" },
    });
    await waitFor(() =>
      expect(mocks.processes).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: "threads", direction: "desc" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    await waitFor(() =>
      expect(mocks.processes).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: "threads", direction: "asc" }),
      ),
    );
    expect(
      (screen.getByLabelText("Sort processes") as HTMLSelectElement).value,
    ).toBe("threads");
  });
});
