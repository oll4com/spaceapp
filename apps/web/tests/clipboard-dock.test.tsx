import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipboardItem } from "@space/contracts";

const mocks = vi.hoisted(() => ({
  clipboardItems: vi.fn(),
  createClipboardItem: vi.fn(),
  setClipboardItemCompleted: vi.fn(),
  deleteClipboardItem: vi.fn(),
  clearClipboardItems: vi.fn(),
  rooms: vi.fn()
}));

vi.mock("../src/api.js", () => ({ api: mocks }));

import { SPACE_CLIPBOARD_ITEM_MIME, SPACE_CLIPBOARD_ITEM_TITLE_MIME } from "../src/features/clipboard-dock/clipboard-events.js";
import { CLIPBOARD_SOURCE_FILTER_STORAGE_KEY } from "../src/features/clipboard-dock/ClipboardDock.js";
import { SPACE_OPEN_PLAN_PANE_EVENT } from "../src/features/clipboard-dock/plan-assignee.js";
import { ClipboardDock } from "../src/features/clipboard-dock/ClipboardDock.js";
import { formatAppDateTime } from "../src/features/date-time-settings/date-time-settings.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const item: ClipboardItem = {
  id: "clipboard:one",
  text: "Remember to verify the fallback policy before rollout.",
  source: "AGENT_NOTE",
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
  paneTitle: "Model Task",
  dependsOn: [], dueAt: null, waitsOn: null, occurrenceCount: 2,
  characterCount: 54,
  createdAt: "2026-07-15T11:00:00.000Z",
  lastUsedAt: "2026-07-15T11:18:00.000Z"
};

const planItem: ClipboardItem = {
  id: "clipboard:plan",
  text: "# Rollout plan\nContinue from here.",
  source: "PLAN",
  title: "Rollout plan",
  minimumModel: "gpt-5.6-sol",
  isCompleted: false,
  executionStatus: "IN_PROGRESS",
  progressPercentage: 50,
  activeAgent: "antigravity",
  steps: [
    {
      id: "step-1",
      order: 1,
      title: "Step 1",
      status: "COMPLETED",
      progress: 100,
      agent: "antigravity",
      notes: null,
      proof: null,
      startedAt: null,
      completedAt: null
    }
  ],
  lastProgressAt: "2026-07-15T12:05:00.000Z",
  roomId: "room:one",
  paneId: "pane:one",
  paneTitle: "Model Task",
  dependsOn: [], dueAt: null, waitsOn: null, occurrenceCount: 1,
  characterCount: 33,
  createdAt: "2026-07-15T12:00:00.000Z",
  lastUsedAt: "2026-07-15T12:05:00.000Z"
};

describe("ClipboardDock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.clipboardItems.mockResolvedValue({
      data: [item],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    mocks.createClipboardItem.mockImplementation(async (input: { text: string; source: ClipboardItem["source"] }) => ({
      ...item,
      id: input.source === "MANUAL_NOTE" ? "clipboard:manual" : item.id,
      text: input.text,
      source: input.source
    }));
    mocks.deleteClipboardItem.mockResolvedValue({ id: item.id, deleted: true });
    mocks.setClipboardItemCompleted.mockResolvedValue({ ...planItem, isCompleted: true });
    mocks.clearClipboardItems.mockResolvedValue({ deletedCount: 1 });
    mocks.rooms.mockResolvedValue({ data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 1 } });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
    installSpaceRuntime(liveRuntime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads, copies, drags, filters, and inserts a private clip", async () => {
    const onInsert = vi.fn();
    render(<ClipboardDock canInsert activePaneLabel="Model Task" onInsert={onInsert} />);

    expect(screen.getByRole("searchbox", { name: "Search clips" }).getAttribute("name")).toBe("clipboard-search");

    const copyButton = await screen.findByRole("button", { name: "Copy clip text" });
    fireEvent.click(copyButton);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(item.text));
    expect(await screen.findByText("Copied", { selector: ".clipboard-copied" })).toBeTruthy();

    const setData = vi.fn();
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag clip" }), {
      dataTransfer: { setData, effectAllowed: "" }
    });
    expect(setData).toHaveBeenCalledWith("text/plain", item.text);
    expect(setData).toHaveBeenCalledWith(SPACE_CLIPBOARD_ITEM_MIME, item.id);

    const planSetData = vi.fn();
    mocks.clipboardItems.mockResolvedValue({
      data: [planItem],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    fireEvent.click(screen.getByRole("button", { name: "Plans" }));
    await waitFor(() => expect(screen.getByText("Rollout plan")).toBeTruthy());
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag clip" }), {
      dataTransfer: { setData: planSetData, effectAllowed: "" }
    });
    expect(planSetData).toHaveBeenCalledWith(SPACE_CLIPBOARD_ITEM_TITLE_MIME, "Rollout plan");
    mocks.clipboardItems.mockResolvedValue({
      data: [item],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(screen.getByText("Remember to verify the fallback policy before rollout.")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Insert into Model Task" }));
    expect(onInsert).toHaveBeenCalledWith(item);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search clips" }), { target: { value: "fallback" } });
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    await waitFor(() => expect(mocks.clipboardItems).toHaveBeenCalledWith({
      q: "fallback",
      includeCompleted: false,
      page: 1,
      pageSize: 100,
      source: "MANUAL_NOTE"
    }));
    expect(mocks.clipboardItems).toHaveBeenCalledWith({
      q: "fallback",
      includeCompleted: false,
      page: 1,
      pageSize: 100,
      source: "AGENT_NOTE"
    });
  });

  it("routes copy through the runtime clipboard instead of the native clipboard", async () => {
    const nativeWriteText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    const runtimeWriteText = vi.fn().mockResolvedValue(undefined);
    installSpaceRuntime({
      ...liveRuntime,
      platform: {
        ...liveRuntime.platform,
        clipboard: { read: vi.fn(), readText: vi.fn(), write: vi.fn(), writeText: runtimeWriteText }
      }
    });

    render(<ClipboardDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy clip text" }));

    await waitFor(() => expect(runtimeWriteText).toHaveBeenCalledWith(item.text));
    expect(nativeWriteText).not.toHaveBeenCalled();
  });

  it("copies the item text via the per-item copy icon next to delete", async () => {
    const runtimeWriteText = vi.fn().mockResolvedValue(undefined);
    installSpaceRuntime({
      ...liveRuntime,
      platform: {
        ...liveRuntime.platform,
        clipboard: { read: vi.fn(), readText: vi.fn(), write: vi.fn(), writeText: runtimeWriteText }
      }
    });

    render(<ClipboardDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);
    await screen.findByText("Remember to verify the fallback policy before rollout.");

    const iconCopy = screen.getByRole("button", { name: "Copy clip" });
    expect(iconCopy).toBeTruthy();
    fireEvent.click(iconCopy);

    await waitFor(() => expect(runtimeWriteText).toHaveBeenCalledWith(item.text));
    expect(screen.getByText("Copied", { selector: ".clipboard-copied" })).toBeTruthy();
  });

  it("creates manual notes and supports delete, clear, and fullscreen without pause or refresh controls", async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
    render(<ClipboardDock canInsert={false} activePaneLabel={null} onInsert={vi.fn()} />);
    await screen.findByText("Remember to verify the fallback policy before rollout.");

    expect(screen.queryByRole("button", { name: "Pause automatic capture" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume automatic capture" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh clipboard" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add clipboard note" }));
    const note = screen.getByRole("textbox", { name: "Manual clipboard note" });
    fireEvent.change(note, { target: { value: "  manual note  " } });
    expect(screen.getByText("15 / 100,000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(mocks.createClipboardItem).toHaveBeenCalledWith({
      text: "  manual note  ",
      source: "MANUAL_NOTE"
    }));

    fireEvent.click(screen.getByRole("button", { name: "Delete clip" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this note?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.deleteClipboardItem).toHaveBeenCalledWith(item.id));

    fireEvent.click(screen.getByRole("button", { name: "Clear all clipboard items" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Clear all clipboard history?" })).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(mocks.clearClipboardItems).toHaveBeenCalled());
    expect(nativeConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open clipboard fullscreen" }));
    expect(screen.getByLabelText("Clipboard history").className).toContain("is-fullscreen");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByLabelText("Clipboard history").className).not.toContain("is-fullscreen");
  });

  it("shows a newly saved agent note while the dock stays open", async () => {
    vi.useFakeTimers();
    let listLoads = 0;
    // The first list load is empty; plan counts (pageSize 1) are not list loads.
    mocks.clipboardItems.mockImplementation(async (query: { pageSize: number }) => query.pageSize === 1 || listLoads++ > 0
      ? { data: [item], pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } }
      : { data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } });

    render(<ClipboardDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(151);
    });
    expect(screen.queryByText(item.text)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText(item.text)).toBeTruthy();
    vi.useRealTimers();
  });

  it("shows the share of every plan that is completed above the list", async () => {
    mocks.clipboardItems.mockImplementation(async (query: { source?: string; includeCompleted?: boolean; pageSize: number }) => ({
      data: query.pageSize === 1 ? [planItem] : [item],
      pagination: { page: 1, pageSize: query.pageSize, totalItems: query.source !== "PLAN" ? 1 : query.includeCompleted ? 4 : 1, totalPages: 1 }
    }));
    render(<ClipboardDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);

    const stats = await screen.findByRole("group", { name: "Plan completion" });
    expect(within(stats).getByText("3 / 4")).toBeTruthy();
    expect(within(stats).getByText("75%")).toBeTruthy();
    expect(within(stats).getByRole("progressbar", { name: "Plans completed" }).getAttribute("aria-valuenow")).toBe("75");
    expect(mocks.clipboardItems).toHaveBeenCalledWith({ source: "PLAN", includeCompleted: false, page: 1, pageSize: 1 });
  });

  it("filters saved plans and renders the PLAN badge and title", async () => {
    mocks.clipboardItems.mockResolvedValue({
      data: [planItem],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    render(<ClipboardDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Plans" }));
    await waitFor(() => expect(mocks.clipboardItems).toHaveBeenLastCalledWith({
      source: "PLAN",
      includeCompleted: false,
      page: 1,
      pageSize: 100
    }));
    expect(await screen.findByText("Rollout plan")).toBeTruthy();
    expect(screen.getByRole("listitem").className).toContain("is-plan");
    expect(screen.getByText("Plan", { selector: ".dock-kit-badge" })).toBeTruthy();
    // The plan's model shows once on the card, not again on each stage that uses it.
    expect(screen.getAllByText((_, element) => Boolean(element?.matches(".clipboard-plan-min-model") && element.textContent?.trim() === "gpt-5.6-sol"))).toHaveLength(1);
    expect(document.querySelector(".clipboard-plan-step-model")).toBeNull();
    expect(document.body.textContent).not.toMatch(/🧠|🤖/);
    expect(screen.getByText("(antigravity)")).toBeTruthy();
  });

  it("shows who took a plan in which room, its stages in order, and a compact completed toggle", async () => {
    const step = (order: number, title: string, status: "PENDING" | "COMPLETED" = "PENDING") => ({
      ...planItem.steps[0]!, id: `step-${order}`, order, title, status, progress: status === "COMPLETED" ? 100 : 0, agent: null
    });
    mocks.clipboardItems.mockResolvedValue({
      data: [{
        ...planItem,
        roomId: "room:ops",
        paneTitle: "Cody",
        steps: [step(1, "Step 1"), step(7, "Step 7"), step(3, "Step 3", "COMPLETED"), step(2, "Review [claude-opus-5-5 / high]"), step(4, "Step 4"), step(5, "Step 5"), step(6, "Step 6")]
      }],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    mocks.rooms.mockResolvedValue({ data: [{ id: "room:ops", name: "Ops" }], pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } });
    render(<ClipboardDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);

    await waitFor(() => expect(document.querySelector(".clipboard-plan-assignee")?.textContent).toBe("antigravity · Linked to Cody · Room: Ops"));
    const card = screen.getByRole("listitem");
    // The time stays in the meta line; the agent and room have their own line.
    expect(card.querySelector(".dock-kit-meta-text")?.textContent).not.toContain("Cody");
    const titles = () => Array.from(card.querySelectorAll(".clipboard-plan-step-title")).map((element) => element.textContent);
    expect(titles()).toEqual(["Step 1", "Review", "Step 3", "Step 4", "Step 5"]);
    // Only the stage with a model of its own carries a model tag.
    expect(Array.from(card.querySelectorAll(".clipboard-plan-step-model")).map((element) => element.textContent?.trim())).toEqual(["claude-opus-5-5 · high"]);
    // The collapsed card shows the plan's prose without its heading.
    expect(card.querySelector(".clipboard-card-snippet")?.textContent).toBe("Continue from here.");

    fireEvent.click(within(card).getByRole("button", { name: "+2 more stages" }));
    expect(titles()).toEqual(["Step 1", "Review", "Step 3", "Step 4", "Step 5", "Step 6", "Step 7"]);
    expect(card.querySelector(".clipboard-card-snippet")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Collapse" }));
    expect(titles()).toHaveLength(5);

    // The icon at the end of the line asks the workspace to open the plan's room and pane.
    const opened = vi.fn();
    window.addEventListener(SPACE_OPEN_PLAN_PANE_EVENT, opened);
    fireEvent.click(within(card).getByRole("button", { name: "Open Cody in Ops" }));
    window.removeEventListener(SPACE_OPEN_PLAN_PANE_EVENT, opened);
    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ roomId: "room:ops", paneId: "pane:one" });

    const toggle = screen.getByRole("switch", { name: "Show completed plans" }).closest("label")!;
    expect(toggle.textContent).not.toMatch(/Disabled|Enabled/);
  });

  it("restores the last selected source filter when the dock opens", async () => {
    localStorage.setItem(CLIPBOARD_SOURCE_FILTER_STORAGE_KEY, "PLANS");
    mocks.clipboardItems.mockResolvedValue({
      data: [planItem],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });

    render(<ClipboardDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Plans" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(mocks.clipboardItems).toHaveBeenLastCalledWith({
      source: "PLAN",
      includeCompleted: false,
      page: 1,
      pageSize: 100
    }));
    expect(await screen.findByText("Rollout plan")).toBeTruthy();
  });

  it("marks a plan completed and hides completed plans until the Completed filter is enabled", async () => {
    const completedPlan: ClipboardItem = { ...planItem, isCompleted: true };
    mocks.clipboardItems.mockImplementation(async (query: { includeCompleted?: boolean }) => ({
      data: query.includeCompleted ? [completedPlan] : [],
      pagination: { page: 1, pageSize: 100, totalItems: query.includeCompleted ? 1 : 0, totalPages: 1 }
    }));

    render(<ClipboardDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);
    await waitFor(() => expect(mocks.clipboardItems).toHaveBeenLastCalledWith(expect.objectContaining({
      includeCompleted: false
    })));
    expect(screen.queryByText("Rollout plan")).toBeNull();
    expect(screen.getByRole("switch", { name: "Show completed plans" })).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Show completed plans" }));
    expect(await screen.findByText("Rollout plan")).toBeTruthy();
    expect(screen.getByText("Completed", { selector: ".clipboard-status-completed" })).toBeTruthy();
    expect(mocks.clipboardItems).toHaveBeenLastCalledWith(expect.objectContaining({ includeCompleted: true }));

    fireEvent.click(screen.getByRole("button", { name: "Mark plan not completed" }));
    await waitFor(() => expect(mocks.setClipboardItemCompleted).toHaveBeenCalledWith(planItem.id, false));
  });

  it("marks an open plan as completed from its card actions", async () => {
    mocks.clipboardItems.mockResolvedValue({
      data: [planItem],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    render(<ClipboardDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Plans" }));
    await screen.findByText("Rollout plan");
    fireEvent.click(screen.getByRole("button", { name: "Mark plan completed" }));
    await waitFor(() => expect(mocks.setClipboardItemCompleted).toHaveBeenCalledWith(planItem.id, true));
  });

  it("renders the header close button only in fullscreen mode and not in dock mode", async () => {
    const onClose = vi.fn();
    render(<ClipboardDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} onClose={onClose} />);
    await screen.findByText("Remember to verify the fallback policy before rollout.");

    // In dock mode, close button is NOT rendered
    expect(screen.queryByRole("button", { name: "Close clipboard" })).toBeNull();

    // In fullscreen mode, close button is rendered and clicking it exits fullscreen and calls onClose
    fireEvent.click(screen.getByRole("button", { name: "Open clipboard fullscreen" }));
    expect(screen.getByLabelText("Clipboard history").className).toContain("is-fullscreen");

    const closeBtn = screen.getByRole("button", { name: "Close clipboard" });
    expect(closeBtn).toBeTruthy();

    fireEvent.click(closeBtn);
    expect(screen.getByLabelText("Clipboard history").className).not.toContain("is-fullscreen");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("displays both date and time in card metadata", async () => {
    render(<ClipboardDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);
    await screen.findByText("Remember to verify the fallback policy before rollout.");

    const expectedDateTime = formatAppDateTime(item.lastUsedAt);
    expect(screen.getByText(new RegExp(expectedDateTime.replace("/", "\\/")))).toBeTruthy();
  });

  it("expands and collapses clip text on double-click while single click still copies", async () => {
    const runtimeWriteText = vi.fn().mockResolvedValue(undefined);
    installSpaceRuntime({
      ...liveRuntime,
      platform: {
        ...liveRuntime.platform,
        clipboard: { read: vi.fn(), readText: vi.fn(), write: vi.fn(), writeText: runtimeWriteText }
      }
    });

    render(<ClipboardDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);
    const textButton = await screen.findByRole("button", { name: "Copy clip text" });
    expect(textButton.className).not.toContain("expanded");

    // Single click copies the text
    fireEvent.click(textButton);
    await waitFor(() => expect(runtimeWriteText).toHaveBeenCalledWith(item.text));
    expect(textButton.className).not.toContain("expanded");

    // Double click expands the text
    fireEvent.doubleClick(textButton);
    expect(textButton.className).toContain("expanded");

    // Double click again collapses the text
    fireEvent.doubleClick(textButton);
    expect(textButton.className).not.toContain("expanded");

    // Double click on card container also toggles expand
    const card = screen.getByRole("listitem");
    fireEvent.doubleClick(card);
    expect(textButton.className).toContain("expanded");
  });
});
