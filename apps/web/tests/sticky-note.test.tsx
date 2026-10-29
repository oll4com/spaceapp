import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipboardItem } from "@space/contracts";

const mocks = vi.hoisted(() => ({
  createClipboardItem: vi.fn(),
  updateClipboardNoteText: vi.fn(),
  deleteClipboardItem: vi.fn(),
  clipboardItems: vi.fn()
}));

vi.mock("../src/api.js", () => ({ api: mocks }));

import {
  StickyNoteWindow,
  useStickyNoteWindows,
  StickyNoteLayer
} from "../src/features/clipboard-dock/StickyNoteWindow.js";
import {
  calculateRailDodgeShift,
  dispatchRailMenuChange
} from "../src/features/rail-popover.js";

const sampleNote: ClipboardItem = {
  id: "clipboard:test-note-1",
  text: "Sample note text for sticky window",
  source: "MANUAL_NOTE",
  title: null,
  minimumModel: null,
  isCompleted: false,
  executionStatus: "PLANNED",
  progressPercentage: 0,
  activeAgent: null,
  steps: [],
  lastProgressAt: null,
  roomId: "room:one",
  paneId: "pane:one",
  paneTitle: "Task",
  dependsOn: [], dueAt: null, waitsOn: null, occurrenceCount: 1,
  characterCount: 34,
  createdAt: "2026-09-22T12:00:00.000Z",
  lastUsedAt: "2026-09-22T12:00:00.000Z"
};

describe("StickyNoteWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("keeps one clipboard item per note: each save changes its text in place and deletes nothing", async () => {
    vi.useFakeTimers();
    try {
      mocks.updateClipboardNoteText.mockImplementation(async (id: string, text: string) => ({ ...sampleNote, id, source: "AGENT_NOTE", text }));
      const onUpdateItemId = vi.fn();
      render(<StickyNoteWindow id="note" initialText={sampleNote.text} itemId={sampleNote.id} onClose={vi.fn()} onUpdateItemId={onUpdateItemId} />);
      const textarea = screen.getByRole("textbox", { name: "Sticky note content" });

      fireEvent.change(textarea, { target: { value: "First edit" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
      expect(mocks.updateClipboardNoteText).toHaveBeenLastCalledWith(sampleNote.id, "First edit");

      fireEvent.change(textarea, { target: { value: "Second edit" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
      expect(mocks.updateClipboardNoteText).toHaveBeenLastCalledWith(sampleNote.id, "Second edit");
      expect(mocks.updateClipboardNoteText).toHaveBeenCalledTimes(2);
      expect(mocks.createClipboardItem).not.toHaveBeenCalled();
      expect(mocks.deleteClipboardItem).not.toHaveBeenCalled();
      expect(onUpdateItemId).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves a note whose record was deleted meanwhile as a new manual note", async () => {
    vi.useFakeTimers();
    try {
      mocks.updateClipboardNoteText.mockRejectedValue(Object.assign(new Error("Clipboard note was not found."), { status: 404 }));
      mocks.createClipboardItem.mockImplementation(async (input: { text: string }) => ({ ...sampleNote, id: "clipboard:new", text: input.text }));
      const onUpdateItemId = vi.fn();
      render(<StickyNoteWindow id="note" initialText={sampleNote.text} itemId={sampleNote.id} onClose={vi.fn()} onUpdateItemId={onUpdateItemId} />);
      fireEvent.change(screen.getByRole("textbox", { name: "Sticky note content" }), { target: { value: "Edited after delete" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
      expect(mocks.createClipboardItem).toHaveBeenCalledWith({ text: "Edited after delete", source: "MANUAL_NOTE" });
      expect(onUpdateItemId).toHaveBeenLastCalledWith("clipboard:new");
      expect(mocks.deleteClipboardItem).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves the last edit when the note is closed before the auto-save delay", async () => {
    mocks.createClipboardItem.mockResolvedValue({ ...sampleNote, id: "clipboard:closed", text: "Typed then closed" });
    const { unmount } = render(<StickyNoteWindow id="note" initialText="" onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Sticky note content" }), { target: { value: "Typed then closed" } });
    unmount();
    await waitFor(() => expect(mocks.createClipboardItem).toHaveBeenCalledWith({ text: "Typed then closed", source: "MANUAL_NOTE" }));
    expect(mocks.createClipboardItem).toHaveBeenCalledTimes(1);
  });

  it("renders with initial note text, title, and luminous bright color by default", () => {
    const onClose = vi.fn();
    render(
      <StickyNoteWindow
        id="test-1"
        initialText={sampleNote.text}
        itemId={sampleNote.id}
        onClose={onClose}
      />
    );

    expect(screen.getByText("Sticky Note")).toBeTruthy();
    const textarea = screen.getByRole("textbox", { name: "Sticky note content" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe(sampleNote.text);

    const windowEl = textarea.closest(".sticky-note-window");
    expect(windowEl?.getAttribute("data-sticky-color")).toBe("yellow");
  });

  it("allows switching sticky note colors", () => {
    const onUpdateColor = vi.fn();
    render(
      <StickyNoteWindow
        id="test-1"
        initialText="Test note"
        onClose={vi.fn()}
        onUpdateColor={onUpdateColor}
      />
    );

    // Open color palette
    const toggle = screen.getByRole("button", { name: "Change sticky note color" });
    fireEvent.click(toggle);

    // Pick Mint green
    const mintBtn = screen.getByRole("button", { name: "Mint" });
    fireEvent.click(mintBtn);

    expect(onUpdateColor).toHaveBeenCalledWith("green");
    const windowEl = screen.getByRole("textbox", { name: "Sticky note content" }).closest(".sticky-note-window");
    expect(windowEl?.getAttribute("data-sticky-color")).toBe("green");
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <StickyNoteWindow
        id="test-1"
        initialText="Test note"
        onClose={onClose}
      />
    );

    const closeBtn = screen.getByRole("button", { name: "Close sticky note" });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("StickyNoteLayer renders windows and passes text correctly", () => {
    const onClose = vi.fn();
    const windows = [
      {
        id: "win-1",
        text: "Note 1 content",
        x: 100,
        y: 100,
        color: "blue" as const,
        itemId: "item-1"
      }
    ];

    render(
      <StickyNoteLayer windows={windows} onClose={onClose} />
    );

    const textarea = screen.getByRole("textbox", { name: "Sticky note content" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Note 1 content");
    const windowEl = textarea.closest(".sticky-note-window");
    expect(windowEl?.getAttribute("data-sticky-color")).toBe("blue");
  });

  it("calculates rail dodge shift correctly when a rail menu overlaps", () => {
    // When no menus exist
    expect(calculateRailDodgeShift({ left: 1000, top: 200, width: 290, height: 220 })).toBe(0);

    // Create a mock rail menu element in the document
    const menuEl = document.createElement("div");
    menuEl.className = "desktop-navigation-menu";
    vi.spyOn(menuEl, "getBoundingClientRect").mockReturnValue({
      left: 1100,
      top: 100,
      right: 1350,
      bottom: 600,
      width: 250,
      height: 500,
      x: 1100,
      y: 100,
      toJSON: () => ({})
    });
    document.body.appendChild(menuEl);

    try {
      // Window at left 1000, right 1290. Menu at left 1100.
      // Overlap: (1290 - 1100) + 12 = 202
      const shift = calculateRailDodgeShift({ left: 1000, top: 200, width: 290, height: 220 });
      expect(shift).toBe(202);

      // Window far to the left (no overlap horizontally: left 200, right 490 < menu left 1100)
      const noShift = calculateRailDodgeShift({ left: 200, top: 200, width: 290, height: 220 });
      expect(noShift).toBe(0);

      // Window below menu (no overlap vertically: top 700 > menu bottom 600)
      const belowShift = calculateRailDodgeShift({ left: 1000, top: 700, width: 290, height: 220 });
      expect(belowShift).toBe(0);
    } finally {
      document.body.removeChild(menuEl);
    }
  });

  it("applies smooth translateX dodge when a rail popover is active and resets when cleared", async () => {
    const menuEl = document.createElement("div");
    menuEl.className = "desktop-navigation-menu";
    vi.spyOn(menuEl, "getBoundingClientRect").mockReturnValue({
      left: 1100,
      top: 100,
      right: 1350,
      bottom: 600,
      width: 250,
      height: 500,
      x: 1100,
      y: 100,
      toJSON: () => ({})
    });
    document.body.appendChild(menuEl);

    try {
      const { container } = render(
        <StickyNoteWindow
          id="test-dodge"
          initialX={1000}
          initialY={200}
          onClose={vi.fn()}
        />
      );

      const noteEl = container.querySelector(".sticky-note-window") as HTMLElement;
      expect(noteEl).toBeTruthy();
      expect(noteEl.style.transform).toContain("translateX(-202px)");

      // Now remove the menu and dispatch change event
      act(() => {
        document.body.removeChild(menuEl);
        dispatchRailMenuChange();
      });

      await waitFor(() => {
        expect(noteEl.style.transform).toBe("");
      });
    } finally {
      if (menuEl.parentNode) {
        document.body.removeChild(menuEl);
      }
    }
  });
});
