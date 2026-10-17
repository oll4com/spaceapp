import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { createRef, type MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { createPaneCompletionLifecycleState, type PaneCompletionLifecycleState } from "../src/pane-completion-lifecycle.js";
import { useMinimizedPaneBar } from "../src/features/pane-float/useMinimizedPaneBar.js";
import { MinimizedPaneBar } from "../src/features/pane-float/MinimizedPaneBar.js";
import { resetCliUpdateRun, startCliUpdateRun } from "../src/features/admin-operations/cli-update-run.js";
import {
  formatPaneFullTitle,
  minimizedPaneSubtitle,
  paneModeLabel,
  paneTitleForMode
} from "../src/features/pane-float/pane-mode-labels.js";

const PREVIEW_KEY = "space.minimized.bar.preview.v1";

function pane(id: string, overrides: Partial<Pane> = {}): Pane {
  return {
    id,
    roomId: "room:test",
    title: `Title ${id}`,
    titleSource: "auto",
    paneName: null,
    mode: "CHAT",
    status: "IDLE",
    providerId: null,
    modelId: null,
    terminalRuntimeId: null,
    reasoningEffort: "medium",
    cwd: "/opt/spaceapp",
    order: 0,
    columnSpan: 1,
    isMaximized: false,
    isMinimized: false,
    isClosed: false,
    categoryColor: null,
    vncTarget: null,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    ...overrides
  } as Pane;
}

function runningLifecycle(paneIds: string[]): PaneCompletionLifecycleState {
  const state = createPaneCompletionLifecycleState();
  return {
    ...state,
    panes: Object.fromEntries(paneIds.map((id) => [id, {
      activeRunKey: `run:${id}`,
      activeRunAllowsCompletion: true,
      pendingCompletionEventId: null,
      latestCompletionEventId: null
    }]))
  };
}

describe("pane mode labels", () => {
  it("keeps the mode labels, new-pane titles and minimized card text", () => {
    expect(paneModeLabel("TERMINAL")).toBe("CLI");
    expect(paneModeLabel("DEMOS")).toBe("Demo Projects");
    expect(paneTitleForMode("FILES", 3)).toBe("Files 3");
    expect(formatPaneFullTitle({ mode: "TERMINAL", title: "Terminal 2", paneName: null })).toBe("CLI 2");
    expect(formatPaneFullTitle({ mode: "CHAT", title: "Plan", paneName: "Iris" })).toBe("Iris · Plan");
    expect(formatPaneFullTitle({ mode: "CHAT", title: "iris", paneName: "Iris" })).toBe("Iris");
    expect(minimizedPaneSubtitle({ mode: "CHAT", title: "Plan", paneName: "Iris", terminalRuntimeId: null })).toBe("Plan");
    expect(minimizedPaneSubtitle({ mode: "CHAT", title: "Iris", paneName: "Iris", terminalRuntimeId: null })).toBe("Chat");
    expect(minimizedPaneSubtitle({ mode: "TERMINAL", title: "Terminal 1", paneName: null, terminalRuntimeId: null })).toBe("CLI");
  });
});

describe("useMinimizedPaneBar", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.localStorage.clear();
  });
  afterEach(() => cleanup());

  it("lists minimized panes, counts running ones and only opens off mobile", () => {
    const panes = [pane("a"), pane("b", { isMinimized: true }), pane("c", { isMinimized: true })];
    const { result, rerender } = renderHook(
      ({ shellMode }: { shellMode: "desktop" | "mobile" }) =>
        useMinimizedPaneBar({ panes, shellMode, paneCompletionLifecycle: runningLifecycle(["c", "a"]) }),
      { initialProps: { shellMode: "desktop" } }
    );
    expect(result.current.minimizedPanes.map((entry) => entry.id)).toEqual(["b", "c"]);
    expect(result.current.minimizedPaneRunningCount).toBe(1);
    expect(result.current.showMinimizedBarToggle).toBe(true);
    expect(result.current.showMinimizedBar).toBe(false);
    act(() => result.current.setMinimizedBarExpanded((value) => !value));
    expect(result.current.showMinimizedBar).toBe(true);
    rerender({ shellMode: "mobile" });
    expect(result.current.showMinimizedBar).toBe(false);
    expect(result.current.showMinimizedBarToggle).toBe(false);
  });

  it("hides the toggle without minimized panes", () => {
    const { result } = renderHook(() =>
      useMinimizedPaneBar({ panes: [pane("a")], shellMode: "desktop", paneCompletionLifecycle: createPaneCompletionLifecycleState() })
    );
    act(() => result.current.setMinimizedBarExpanded(true));
    expect(result.current.showMinimizedBar).toBe(false);
    expect(result.current.showMinimizedBarToggle).toBe(false);
  });

  it("restores and stores the preview mode per browser", () => {
    window.localStorage.setItem(PREVIEW_KEY, "true");
    const { result } = renderHook(() =>
      useMinimizedPaneBar({ panes: [], shellMode: "desktop", paneCompletionLifecycle: createPaneCompletionLifecycleState() })
    );
    expect(result.current.minimizedBarPreviewMode).toBe(true);
    act(() => result.current.toggleMinimizedBarPreviewMode());
    expect(result.current.minimizedBarPreviewMode).toBe(false);
    expect(window.localStorage.getItem(PREVIEW_KEY)).toBe("false");
  });
});

describe("MinimizedPaneBar", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.localStorage.clear();
  });
  afterEach(() => cleanup());

  function renderBar(visiblePaneCount: number) {
    const panes = [pane("a", { isMinimized: true, paneName: "Iris", title: "Plan" }), pane("b", { isMinimized: true })];
    const lifecycle = createPaneCompletionLifecycleState();
    const restorePane = vi.fn(async (_pane: Pane) => undefined);
    const minimizeAllPanes = vi.fn(async () => undefined);
    const restoreAllPanes = vi.fn(async () => undefined);
    const restoreRefs = createRef<Map<string, HTMLButtonElement>>() as MutableRefObject<Map<string, HTMLButtonElement>>;
    restoreRefs.current = new Map();
    function Harness() {
      const bar = useMinimizedPaneBar({ panes, shellMode: "desktop", paneCompletionLifecycle: lifecycle });
      return (
        <MinimizedPaneBar
          bar={bar}
          visiblePaneCount={visiblePaneCount}
          paneCompletionLifecycle={lifecycle}
          turns={[]}
          restoreRefs={restoreRefs}
          restorePane={restorePane}
          minimizeAllPanes={minimizeAllPanes}
          restoreAllPanes={restoreAllPanes}
          minimizeAllPending={false}
          restoreAllPending={false}
        />
      );
    }
    const view = render(<Harness />);
    return { view, restorePane, minimizeAllPanes, restoreAllPanes, restoreRefs };
  }

  it("renders chips with restore refs and runs the bar actions", () => {
    const { view, restorePane, minimizeAllPanes, restoreAllPanes, restoreRefs } = renderBar(1);
    const bar = view.container.querySelector("#minimized-pane-bar, section.minimized-pane-bar");
    expect(bar?.getAttribute("aria-label")).toBe("Minimized panes");
    expect(bar?.classList.contains("is-preview-mode")).toBe(false);
    expect(screen.queryByText("All panes minimized")).toBeNull();
    expect(restoreRefs.current.size).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Restore pane Iris · Plan" }));
    expect(restorePane).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    fireEvent.click(screen.getByRole("button", { name: "Minimize all visible panes" }));
    expect(minimizeAllPanes).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Restore all minimized panes" }));
    expect(restoreAllPanes).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Expand pane preview" }));
    expect(bar?.classList.contains("is-preview-mode")).toBe(true);
    expect(screen.getByRole("button", { name: "Collapse pane preview" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("lists a minimized CLI update and reopens it in Manage", async () => {
    let finish!: () => void;
    const run = startCliUpdateRun(() => new Promise((resolve, reject) => { finish = () => reject(new Error("boom")); }), {}, "Hermes Agent CLI");
    const { result } = renderHook(() =>
      useMinimizedPaneBar({ panes: [], shellMode: "desktop", paneCompletionLifecycle: createPaneCompletionLifecycleState() })
    );
    expect(result.current).toMatchObject({ minimizedCount: 1, minimizedPaneRunningCount: 1, showMinimizedBarToggle: true });
    const opened = vi.fn();
    window.addEventListener("space:manage", opened);
    renderBar(1);
    fireEvent.click(screen.getByRole("button", { name: "Restore Updating Hermes Agent CLI" }));
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ action: "cli-update-all" });
    await act(async () => { finish(); await run; });
    expect(result.current).toMatchObject({ minimizedCount: 1, minimizedPaneRunningCount: 0 });
    expect(screen.getByRole("button", { name: "Restore CLI update failed" })).toBeTruthy();
    window.removeEventListener("space:manage", opened);
    act(() => resetCliUpdateRun());
    expect(result.current.minimizedCount).toBe(0);
  });

  it("announces when every pane is minimized and disables Minimize all", () => {
    renderBar(0);
    expect(screen.getByRole("status").textContent).toBe("All panes minimized");
    expect((screen.getByRole("button", { name: "Minimize all visible panes" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
