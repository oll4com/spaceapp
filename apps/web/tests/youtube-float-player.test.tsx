import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { App } from "../src/App.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";
import { SpaceRuntimeProvider } from "../src/runtime/SpaceRuntime.js";
import { VoiceInputProvider } from "../src/features/voice-input/VoiceInputProvider.js";

vi.mock("../src/features/terminal-pane/TerminalPane.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/features/terminal-pane/TerminalPane.js")>();
  return { ...original, TerminalPane: ({ pane }: { pane: Pane }) => <div data-test-terminal={pane.id}>Terminal</div> };
});

vi.mock("../src/features/browser-pane/BrowserPane.js", () => ({
  BrowserPane: () => <div>Browser</div>
}));

vi.mock("../src/features/browser-pane/YouTubePane.js", () => ({
  YouTubePane: ({ isFloating, onToggleFloat }: { isFloating?: boolean; onToggleFloat?: () => void }) => (
    <div data-testid="mock-youtube-pane">
      <span>YouTube Player</span>
      {onToggleFloat ? (
        <button type="button" onClick={onToggleFloat}>
          {isFloating ? "Restore" : "Float"}
        </button>
      ) : null}
    </div>
  )
}));

type FixtureStore = {
  fixture: {
    rooms: Array<{ id: string }>;
    panes: Array<{
      id: string;
      roomId: string;
      title: string;
      titleSource: "auto" | "manual" | "ai";
      mode: "YOUTUBE";
      status: "IDLE";
      providerId: null;
      modelId: null;
      reasoningEffort: "medium";
      cwd: null;
      order: number;
      columnSpan: number;
      isMaximized: boolean;
      isMinimized: boolean;
      isClosed: boolean;
      split: { parentId: null; direction: null; size: null };
      categoryColor: null;
      vncTarget: null;
      createdAt: string;
      updatedAt: string;
    }>;
  };
};

function getDemoFixture(store: unknown) {
  return (store as unknown as FixtureStore).fixture;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("YouTube mini float player", () => {
  it("converts YouTube pane to a floating mini player from quick actions and restores it", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });

    const bundle = createDemoRuntime();
    // Add a YouTube pane to the demo room
    const fixture = getDemoFixture(bundle.store);
    const roomId = fixture.rooms[0]!.id;
    fixture.panes.push({
      id: "pane:youtube-test",
      roomId,
      title: "Deep Relaxation | 4k",
      titleSource: "manual",
      mode: "YOUTUBE",
      status: "IDLE",
      providerId: null,
      modelId: null,
      reasoningEffort: "medium",
      cwd: null,
      order: 10,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null },
      categoryColor: null,
      vncTarget: null,
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z"
    });

    render(
      <SpaceRuntimeProvider runtime={bundle.runtime}>
        <VoiceInputProvider>
          <App />
        </VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    // Find the YouTube pane card
    const paneCard = await screen.findByRole("article", { name: /Deep Relaxation/i });
    expect(paneCard).toBeTruthy();
    expect(paneCard.classList.contains("is-floating-mini-player")).toBe(false);

    // Open pane overflow menu (...)
    const moreBtn = within(paneCard).getByRole("button", { name: /More pane actions/i });
    fireEvent.click(moreBtn);

    // Click "Float mini player" in Quick actions menu
    const floatCommand = await screen.findByRole("menuitem", { name: "Float mini player" });
    expect(floatCommand).toBeTruthy();
    fireEvent.click(floatCommand);

    // Verify the pane card has transitioned to floating mini player
    await waitFor(() => {
      expect(paneCard.classList.contains("is-floating-mini-player")).toBe(true);
    });

    // Check that floating mini player header is rendered with title, drag icon, and restore button
    const floatHeader = paneCard.querySelector(".youtube-mini-float-header");
    expect(floatHeader).toBeTruthy();
    expect(within(floatHeader as HTMLElement).getByText("Deep Relaxation | 4k")).toBeTruthy();

    // Check resize handle is present
    expect(paneCard.querySelector(".youtube-mini-float-resize-handle")).toBeTruthy();

    // Click "Restore pane to grid" button in floating header
    const restoreBtn = within(floatHeader as HTMLElement).getByRole("button", { name: "Restore pane to grid" });
    expect(restoreBtn).toBeTruthy();
    fireEvent.click(restoreBtn);

    // Verify it is restored back to the grid
    await waitFor(() => {
      expect(paneCard.classList.contains("is-floating-mini-player")).toBe(false);
    });
    expect(paneCard.querySelector(".youtube-mini-float-header")).toBeNull();
  });

  it("floats and restores via toolbar button", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });

    const bundle = createDemoRuntime();
    const fixture = getDemoFixture(bundle.store);
    const roomId = fixture.rooms[0]!.id;
    fixture.panes.push({
      id: "pane:youtube-toolbar-test",
      roomId,
      title: "Lo-Fi Beats",
      titleSource: "manual",
      mode: "YOUTUBE",
      status: "IDLE",
      providerId: null,
      modelId: null,
      reasoningEffort: "medium",
      cwd: null,
      order: 11,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null },
      categoryColor: null,
      vncTarget: null,
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z"
    });

    render(
      <SpaceRuntimeProvider runtime={bundle.runtime}>
        <VoiceInputProvider>
          <App />
        </VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    const paneCard = await screen.findByRole("article", { name: /Lo-Fi Beats/i });
    const mockPane = within(paneCard).getByTestId("mock-youtube-pane");
    const toolbarFloatBtn = within(mockPane).getByRole("button", { name: "Float" });
    fireEvent.click(toolbarFloatBtn);

    await waitFor(() => {
      expect(paneCard.classList.contains("is-floating-mini-player")).toBe(true);
    });

    // In floating mode, clicking restore in toolbar button restores it
    const toolbarRestoreBtn = within(mockPane).getByRole("button", { name: "Restore" });
    fireEvent.click(toolbarRestoreBtn);

    await waitFor(() => {
      expect(paneCard.classList.contains("is-floating-mini-player")).toBe(false);
    });
  });

  it("supports dragging and resizing the mini float player", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });

    const bundle = createDemoRuntime();
    const fixture = getDemoFixture(bundle.store);
    const roomId = fixture.rooms[0]!.id;
    fixture.panes.push({
      id: "pane:youtube-drag-test",
      roomId,
      title: "Drag Test Video",
      titleSource: "manual",
      mode: "YOUTUBE",
      status: "IDLE",
      providerId: null,
      modelId: null,
      reasoningEffort: "medium",
      cwd: null,
      order: 12,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null },
      categoryColor: null,
      vncTarget: null,
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z"
    });

    render(
      <SpaceRuntimeProvider runtime={bundle.runtime}>
        <VoiceInputProvider>
          <App />
        </VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    const paneCard = await screen.findByRole("article", { name: /Drag Test Video/i });
    const mockPane = within(paneCard).getByTestId("mock-youtube-pane");
    fireEvent.click(within(mockPane).getByRole("button", { name: "Float" }));

    await waitFor(() => {
      expect(paneCard.classList.contains("is-floating-mini-player")).toBe(true);
    });

    const header = paneCard.querySelector(".youtube-mini-float-header") as HTMLElement;
    expect(header).toBeTruthy();

    // Simulate drag
    header.setPointerCapture = vi.fn();
    header.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(header, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(header, { pointerId: 1, clientX: 150, clientY: 130 });
    fireEvent.pointerUp(header, { pointerId: 1 });

    // Simulate resize via handle
    const resizeHandle = paneCard.querySelector(".youtube-mini-float-resize-handle") as HTMLElement;
    expect(resizeHandle).toBeTruthy();
    resizeHandle.setPointerCapture = vi.fn();
    resizeHandle.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(resizeHandle, { pointerId: 2, button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(resizeHandle, { pointerId: 2, clientX: 550, clientY: 450 });
    fireEvent.pointerUp(resizeHandle, { pointerId: 2 });

    expect(paneCard.classList.contains("is-floating-mini-player")).toBe(true);
    const saved = JSON.parse(window.localStorage.getItem("space.youtube.float-layout.v1:pane:youtube-drag-test") || "{}");
    expect(saved.width).toBe(430);
    expect(saved.height).toBe(290);
  });

  it("smoothly expands when resized at the bottom-right viewport boundary without locking up", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });

    const bundle = createDemoRuntime();
    const fixture = getDemoFixture(bundle.store);
    const roomId = fixture.rooms[0]!.id;
    fixture.panes.push({
      id: "pane:youtube-corner-test",
      roomId,
      title: "Corner Test Video",
      titleSource: "manual",
      mode: "YOUTUBE",
      status: "IDLE",
      providerId: null,
      modelId: null,
      reasoningEffort: "medium",
      cwd: null,
      order: 13,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null },
      categoryColor: null,
      vncTarget: null,
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z"
    });

    render(
      <SpaceRuntimeProvider runtime={bundle.runtime}>
        <VoiceInputProvider>
          <App />
        </VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    const paneCard = await screen.findByRole("article", { name: /Corner Test Video/i });
    const mockPane = within(paneCard).getByTestId("mock-youtube-pane");
    fireEvent.click(within(mockPane).getByRole("button", { name: "Float" }));

    await waitFor(() => {
      expect(paneCard.classList.contains("is-floating-mini-player")).toBe(true);
    });

    const resizeHandle = paneCard.querySelector(".youtube-mini-float-resize-handle") as HTMLElement;
    expect(resizeHandle).toBeTruthy();
    resizeHandle.setPointerCapture = vi.fn();
    resizeHandle.releasePointerCapture = vi.fn();

    // Default position: x = 1000 - 380 - 24 = 596, y = 700 - 240 - 24 = 436.
    // Client pointer starts at the bottom-right corner of the window (around x=976, y=676)
    // Moving +120px right and +80px down would exceed viewport right/bottom (1000, 700).
    // The player should expand smoothly by shifting left/up instead of clamping to 24px and freezing.
    fireEvent.pointerDown(resizeHandle, { pointerId: 3, button: 0, clientX: 976, clientY: 676 });
    fireEvent.pointerMove(resizeHandle, { pointerId: 3, clientX: 1096, clientY: 756 });
    fireEvent.pointerUp(resizeHandle, { pointerId: 3 });

    const layout = JSON.parse(window.localStorage.getItem("space.youtube.float-layout.v1:pane:youtube-corner-test") || "{}");
    // Desired width was 380 + 120 = 500, desired height was 240 + 80 = 320.
    // Both expand properly, and x & y shift left/up to stay within margin (8px)
    expect(layout.width).toBe(500);
    expect(layout.height).toBe(320);
    expect(layout.x).toBeLessThan(596);
    expect(layout.y).toBeLessThan(436);
  });

  it("hides float button and never opens a second line when header space is cramped", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });

    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function clientWidth(this: HTMLElement) {
      if (this.tagName === "HEADER" && this.closest(".pane-card")) return 400;
      if (this.classList?.contains("pane-agent-badge")) return 32;
      if (this.classList?.contains("pane-title-text")) return 200;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function offsetWidth(this: HTMLElement) {
      if (this.tagName === "BUTTON" && this.closest(".pane-actions")) return 36;
      if (this.tagName === "BUTTON" && this.closest(".pane-actions-fixed")) return 36;
      if (this.classList?.contains("pane-actions-overflow")) return 36;
      if (this.classList?.contains("pane-agent-badge")) return 32;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function scrollWidth(this: HTMLElement) {
      return this.classList?.contains("pane-title-text") ? 200 : 0;
    });

    const bundle = createDemoRuntime();
    const fixture = getDemoFixture(bundle.store);
    const roomId = fixture.rooms[0]!.id;
    fixture.panes.push({
      id: "pane:youtube-cramped-test",
      roomId,
      title: "Day 91 vibecoding | Long Title",
      titleSource: "manual",
      mode: "YOUTUBE",
      status: "IDLE",
      providerId: null,
      modelId: null,
      reasoningEffort: "medium",
      cwd: null,
      order: 13,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null },
      categoryColor: null,
      vncTarget: null,
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z"
    });

    render(
      <SpaceRuntimeProvider runtime={bundle.runtime}>
        <VoiceInputProvider>
          <App />
        </VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    const paneCard = await screen.findByRole("article", { name: /Day 91 vibecoding/i });
    const header = paneCard.querySelector("header");
    expect(header).toBeTruthy();

    // Verify it NEVER opens a second line (is-actions-stacked is false)
    await waitFor(() => {
      expect(header?.classList.contains("is-actions-stacked")).toBe(false);
    });

    // Verify float button is hidden from header .pane-actions
    const paneActions = paneCard.querySelector(".pane-actions");
    expect(paneActions?.querySelectorAll("button")).toHaveLength(0);

    // But it is still available in More menu (...)
    const moreBtn = within(paneCard).getByRole("button", { name: /More pane actions/i });
    fireEvent.click(moreBtn);

    const floatCommand = await screen.findByRole("menuitem", { name: "Float mini player" });
    expect(floatCommand).toBeTruthy();
    fireEvent.click(floatCommand);

    await waitFor(() => {
      expect(paneCard.classList.contains("is-floating-mini-player")).toBe(true);
    });
  });

  it("shows hide youtube toolbar button in toolbox when pane window has enough width", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });

    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function clientWidth(this: HTMLElement) {
      if (this.tagName === "HEADER" && this.closest(".pane-card")) return 700;
      if (this.classList?.contains("pane-agent-badge")) return 32;
      if (this.classList?.contains("pane-title-text")) return 160;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function offsetWidth(this: HTMLElement) {
      if (this.tagName === "BUTTON" && this.closest(".pane-actions")) return 36;
      if (this.tagName === "BUTTON" && this.closest(".pane-actions-fixed")) return 36;
      if (this.classList?.contains("pane-actions-overflow")) return 36;
      if (this.classList?.contains("pane-agent-badge")) return 32;
      return 0;
    });

    const bundle = createDemoRuntime();
    const fixture = getDemoFixture(bundle.store);
    const roomId = fixture.rooms[0]!.id;
    fixture.panes.push({
      id: "pane:youtube-toolbox-test",
      roomId,
      title: "Wide Window Track",
      titleSource: "manual",
      mode: "YOUTUBE",
      status: "IDLE",
      providerId: null,
      modelId: null,
      reasoningEffort: "medium",
      cwd: null,
      order: 14,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null },
      categoryColor: null,
      vncTarget: null,
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z"
    });

    render(
      <SpaceRuntimeProvider runtime={bundle.runtime}>
        <VoiceInputProvider>
          <App />
        </VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    const paneCard = await screen.findByRole("article", { name: /Wide Window Track/i });
    expect(within(paneCard).queryByRole("status", { name: /Active working time/i })).toBeNull();
    const paneActions = paneCard.querySelector(".pane-actions");
    expect(paneActions).toBeTruthy();

    // Verify both "Float mini player" and "Hide YouTube toolbar" appear in the toolbox (pane-actions)
    await waitFor(() => {
      const actionButtons = within(paneActions as HTMLElement).getAllByRole("button");
      expect(actionButtons.length).toBeGreaterThanOrEqual(2);
    });

    const hideToolbarBtn = within(paneActions as HTMLElement).getByRole("button", { name: "Hide YouTube toolbar" });
    expect(hideToolbarBtn).toBeTruthy();

    // Click "Hide YouTube toolbar"
    fireEvent.click(hideToolbarBtn);

    // Verify the button updates to "Show YouTube toolbar"
    await waitFor(() => {
      expect(within(paneActions as HTMLElement).getByRole("button", { name: "Show YouTube toolbar" })).toBeTruthy();
    });

    // Click "Show YouTube toolbar" to restore
    const showToolbarBtn = within(paneActions as HTMLElement).getByRole("button", { name: "Show YouTube toolbar" });
    fireEvent.click(showToolbarBtn);

    await waitFor(() => {
      expect(within(paneActions as HTMLElement).getByRole("button", { name: "Hide YouTube toolbar" })).toBeTruthy();
    });
  });
});

