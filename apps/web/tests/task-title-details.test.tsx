import { createRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { TaskTitleDetails } from "../src/features/task-titles/TaskTitleDetails.js";
vi.mock("../src/api.js", () => ({
  api: {
    generatePaneTitle: vi.fn(),
    updatePane: vi.fn(),
    taskTitleAvailability: vi.fn(async () => ({ candidates: [] })),
  },
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function fixture() {
  return {
    id: "pane:test",
    title: "[Image #1] [Image #2] Improve menu layout",
    titleSource: "auto",
    mode: "TERMINAL",
    taskMetadata: {
      description: "Improve workspace navigation and simplify task controls.",
      steps: ["Review menu layout", "Update task controls"],
      earlierWork: "",
      generationStatus: "ready",
      nativeSyncStatus: "synced",
    },
  } as Pane;
}
describe("task title details", () => {
  it("keeps root shell titles intact and hides AI summary actions", () => {
    render(<TaskTitleDetails pane={{ ...fixture(), title: "Root CLI", terminalRuntimeId: "cli:root" }} titleRef={createRef()} onRename={() => {}} onUpdated={() => {}} />);
    fireEvent.click(screen.getByLabelText("Show task details Root CLI"));
    expect(screen.queryByRole("button", { name: "Regenerate summary" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Title model" })).toBeNull();
  });
  it("shows a clean compact title and opens the description after the hover delay", () => {
    vi.useFakeTimers();
    render(
      <TaskTitleDetails
        pane={fixture()}
        titleRef={createRef()}
        onRename={() => {}}
        onUpdated={() => {}}
      />,
    );
    expect(screen.getByText("Improve menu layout")).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
    const details = screen.getByText("Improve menu layout").closest("details")!;
    fireEvent.pointerEnter(details, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(299));
    expect(details.open).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    fireEvent(details, new Event("toggle"));
    expect(
      screen.getByText(
        "Improve workspace navigation and simplify task controls.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
  it("supports keyboard focus and closes with Escape", () => {
    render(
      <TaskTitleDetails
        pane={fixture()}
        titleRef={createRef()}
        onRename={() => {}}
        onUpdated={() => {}}
      />,
    );
    const summary = screen.getByLabelText(
      "Show task details Improve menu layout",
    );
    fireEvent.focus(summary);
    const details = summary.closest("details")!;
    fireEvent(details, new Event("toggle"));
    expect(details.open).toBe(true);
    fireEvent.keyDown(summary, { key: "Escape" });
    expect(details.open).toBe(false);
  });
  it("opens on click after pointer focus without the native details toggle closing it again", () => {
    render(
      <TaskTitleDetails
        pane={fixture()}
        titleRef={createRef()}
        onRename={() => {}}
        onUpdated={() => {}}
      />,
    );
    const summary = screen.getByLabelText(
      "Show task details Improve menu layout",
    );
    fireEvent.focus(summary);
    fireEvent.click(summary);
    expect(summary.closest("details")!.open).toBe(true);
    expect(screen.getByRole("region", { name: "Task details" })).toBeTruthy();
  });
  it.each(["space", "native"])(
    "exposes automatic title restoration after a %s manual rename",
    (source) => {
      render(
        <TaskTitleDetails
          pane={{
            ...fixture(),
            title: "My task",
            titleSource: source === "space" ? "manual" : "auto",
            taskMetadata: {
              ...fixture().taskMetadata!,
              nativeTitleManual: source === "native",
            },
          }}
          titleRef={createRef()}
          onRename={() => {}}
          onUpdated={() => {}}
        />,
      );
      const summary = screen.getByLabelText("Show task details My task");
      fireEvent.focus(summary);
      fireEvent(summary.closest("details")!, new Event("toggle"));
      expect(
        screen.getByRole("button", { name: "Use automatic title" }),
      ).toBeTruthy();
    },
  );
  it("constrains the pane title details and summary hit-area to the title text width", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(
      resolve(import.meta.dirname, "../src/features/ui-theme/workspace-chrome.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.pane-title-details,\s*\.space-shell \.pane-title-details\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;/s,
    );
    expect(css).toMatch(
      /\.pane-title-details > summary,\s*\.space-shell \.pane-title-details > summary\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;/s,
    );
  });
  it("lists every summarized title line with the CLI's saved title", () => {
    const pane = {
      ...fixture(),
      paneName: "Oscar",
      title: "Login 500 error fix",
      terminalRuntimeId: "cli:claude",
      taskMetadata: {
        ...fixture().taskMetadata!,
        description: "Repair the failing login.",
        steps: ["Workspace menu layout", "Login 500 error fix"],
        nativeTitle: "Αναβάθμιση τίτλων task",
        nativeTitleLabel: "Claude Code",
        topics: [
          { title: "Workspace menu layout", summary: "Improve the menu.", source: "native", at: "2026-10-12T08:00:00.000Z" },
          { title: "Login 500 error fix", summary: "Repair the failing login.", source: "ai", at: "2026-10-12T08:05:00.000Z", hasImages: true },
        ],
      },
    } as Pane;
    render(<TaskTitleDetails pane={pane} titleRef={createRef()} onRename={() => {}} onUpdated={() => {}} />);
    fireEvent.click(screen.getByLabelText("Show task details Oscar - Login 500 error fix"));
    expect(screen.getByText("Saved in Claude Code")).toBeTruthy();
    expect(screen.getByText("Αναβάθμιση τίτλων task")).toBeTruthy();
    const lines = screen.getByRole("list", { name: "Task title lines" }).querySelectorAll("li");
    expect([...lines].map((line) => line.textContent)).toEqual([
      "Workspace menu layoutImprove the menu.",
      "Login 500 error fixImageRepair the failing login.",
    ]);
    expect(lines[1]!.getAttribute("aria-current")).toBe("step");
    expect(screen.queryByText("Repair the failing login.", { selector: ".task-title-description" })).toBeNull();
  });
  it("never shows the raw prompt while the first summary is pending", () => {
    const pane = {
      ...fixture(),
      title: "New task",
      taskMetadata: { ...fixture().taskMetadata!, description: "", steps: [], topics: [], generationStatus: "pending" },
    } as Pane;
    render(<TaskTitleDetails pane={pane} titleRef={createRef()} onRename={() => {}} onUpdated={() => {}} />);
    fireEvent.click(screen.getByLabelText("Show task details New task"));
    expect(screen.getByRole("status").textContent).toBe("Summarizing the request…");
    expect(screen.queryByText("Task details will appear after a request is submitted.")).toBeNull();
  });
  it("explains a local fallback line when no title model answered", () => {
    const pane = {
      ...fixture(),
      title: "Improve menu layout",
      taskMetadata: {
        ...fixture().taskMetadata!,
        generationStatus: "unavailable",
        topics: [{ title: "Improve menu layout", summary: "", source: "local", at: "2026-10-12T08:00:00.000Z" }],
      },
    } as Pane;
    render(<TaskTitleDetails pane={pane} titleRef={createRef()} onRename={() => {}} onUpdated={() => {}} />);
    fireEvent.click(screen.getByLabelText("Show task details Improve menu layout"));
    expect(screen.getByRole("status").textContent).toBe("AI summary unavailable. Showing a local title.");
  });
});
