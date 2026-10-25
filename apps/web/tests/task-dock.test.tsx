import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskItem } from "@space/contracts";
import { taskTitleMaxCharacters } from "@space/contracts";

const mocks = vi.hoisted(() => ({
  taskItems: vi.fn(),
  createTaskItem: vi.fn(),
  updateTaskItem: vi.fn(),
  deleteTaskItem: vi.fn(),
  clearTaskItems: vi.fn()
}));

vi.mock("../src/api.js", () => ({ api: mocks }));

import { SPACE_TASK_ITEM_MIME } from "../src/features/task-dock/task-events.js";
import { TaskDock } from "../src/features/task-dock/TaskDock.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const item: TaskItem = {
  id: "task:one",
  title: "Verify fallback",
  objective: "Verify the fallback policy before rollout.",
  status: "OPEN",
  source: "MANUAL",
  roomId: "room:one",
  paneId: "pane:one",
  paneTitle: "Model Task",
  occurrenceCount: 2,
  characterCount: 44,
  createdAt: "2026-07-15T11:00:00.000Z",
  lastUsedAt: "2026-07-15T11:18:00.000Z",
  schedule: null
};

describe("TaskDock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.taskItems.mockResolvedValue({
      data: [item],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    mocks.createTaskItem.mockImplementation(async (input: { title: string; objective: string; status: TaskItem["status"] }) => ({
      ...item,
      id: "task:manual",
      title: input.title,
      objective: input.objective,
      status: input.status
    }));
    mocks.updateTaskItem.mockImplementation(async (_id: string, input: { status: TaskItem["status"] }) => ({
      ...item,
      status: input.status
    }));
    mocks.deleteTaskItem.mockResolvedValue({ id: item.id, deleted: true });
    mocks.clearTaskItems.mockResolvedValue({ deletedCount: 1 });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
    installSpaceRuntime(liveRuntime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads, copies, drags, filters, and starts a task", async () => {
    const onInsert = vi.fn();
    render(<TaskDock canInsert activePaneLabel="Model Task" onInsert={onInsert} />);

    expect(screen.getByRole("searchbox", { name: "Search tasks" }).getAttribute("name")).toBe("task-search");

    const copyButton = await screen.findByRole("button", { name: "Copy task objective" });
    fireEvent.click(copyButton);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(item.objective));
    expect(await screen.findByText("Copied")).toBeTruthy();

    const setData = vi.fn();
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag task to a CLI" }), {
      dataTransfer: { setData, effectAllowed: "" }
    });
    expect(setData).toHaveBeenCalledWith("text/plain", item.objective);
    expect(setData).toHaveBeenCalledWith(SPACE_TASK_ITEM_MIME, item.id);

    fireEvent.click(screen.getByRole("button", { name: "Start in Model Task" }));
    expect(onInsert).toHaveBeenCalledWith(item);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "fallback" } });
    await waitFor(() => expect(mocks.taskItems).toHaveBeenLastCalledWith({
      q: "fallback",
      page: 1,
      pageSize: 100
    }));
  });

  it("groups tasks by when they are due, like Google Tasks, with completed ones folded away", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T09:00:00.000Z"));
    const schedule = (recurrence: NonNullable<TaskItem["schedule"]>["recurrence"], nextRunAt: string | null, lastOutcome: string | null = null) =>
      ({ recurrence, timeZone: "UTC", nextRunAt, lastRunAt: null, lastOutcome });
    mocks.taskItems.mockResolvedValue({
      data: [
        { ...item, id: "task:watch", title: "Hetzner VAT watch", source: "AGENT", paneTitle: "Claude", schedule: schedule({ kind: "INTERVAL", minutes: 120 }, "2026-10-15T12:47:00.000Z", "Sent to the CLI at 10:47.") },
        { ...item, id: "task:late", title: "Pay invoice", paneTitle: null, schedule: schedule({ kind: "ONCE", at: "2026-10-14T09:00:00.000Z" }, null) },
        { ...item, id: "task:tomorrow", title: "Backup report", schedule: schedule({ kind: "DAILY", time: "18:00" }, "2026-10-16T18:00:00.000Z") },
        { ...item, id: "task:plain", title: "Plain note" },
        { ...item, id: "task:done", title: "Old task", status: "DONE" }
      ],
      pagination: { page: 1, pageSize: 100, totalItems: 5, totalPages: 1 }
    });
    render(<TaskDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);
    await screen.findByText("Hetzner VAT watch");
    const groups = screen.getAllByRole("list");
    expect(groups.map((list) => list.getAttribute("aria-label"))).toEqual(["Overdue", "Today", "Tomorrow", "No date"]);
    const today = within(screen.getByRole("list", { name: "Today" }));
    expect(today.getByText("Hetzner VAT watch")).toBeTruthy();
    const chip = today.getByText(/every 2 h/);
    expect(chip.textContent).toMatch(/12:47 UTC · every 2 h/);
    expect(chip.getAttribute("title")).toBe("Sent to the CLI at 10:47.");
    expect(today.getByText("Claude")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Overdue" })).getByText("Pay invoice")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Tomorrow" })).getByText(/18:00 UTC · daily/)).toBeTruthy();
    expect(screen.queryByText("Old task")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Completed (1)" }));
    expect(within(screen.getByRole("list", { name: "Completed" })).getByText("Old task")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: 'Mark "Old task" as not done' }));
    await waitFor(() => expect(mocks.updateTaskItem).toHaveBeenCalledWith("task:done", { status: "OPEN" }));
  });

  it("adds a timed task that runs in the active CLI", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T09:00:00.000Z"));
    localStorage.setItem("space.dateTime.settings", JSON.stringify({ timeZone: "Europe/Athens" }));
    render(<TaskDock canInsert activePaneLabel="Claude" activeCliPaneId="pane:cli" onInsert={vi.fn()} />);
    await screen.findByText("Verify the fallback policy before rollout.");
    fireEvent.click(screen.getByRole("button", { name: "Add a task" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), { target: { value: "Backups" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Task objective" }), { target: { value: "Check the backup report." } });
    fireEvent.change(screen.getByRole("combobox", { name: "Repeat" }), { target: { value: "DAILY" } });
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "18:30" } });
    expect((screen.getByRole("combobox", { name: "Run in" }) as HTMLSelectElement).value).toBe("pane:cli");
    expect(screen.getByText(/Times in Europe\/Athens/)).toBeTruthy();
    expect(screen.getByText(/does not track whether the CLI finishes it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(mocks.createTaskItem).toHaveBeenCalledWith({
      title: "Backups",
      objective: "Check the backup report.",
      status: "OPEN",
      schedule: { recurrence: { kind: "DAILY", time: "18:30" }, timeZone: "Europe/Athens" },
      paneId: "pane:cli",
      paneTitle: "Claude"
    }));

    // A one-time reminder: wall-clock time in the zone, no pane.
    fireEvent.click(screen.getByRole("button", { name: "Add a task" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), { target: { value: "Pay" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Task objective" }), { target: { value: "Pay the invoice." } });
    fireEvent.change(screen.getByRole("combobox", { name: "Repeat" }), { target: { value: "ONCE" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-16" } });
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Run in" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(mocks.createTaskItem).toHaveBeenLastCalledWith({
      title: "Pay",
      objective: "Pay the invoice.",
      status: "OPEN",
      schedule: { recurrence: { kind: "ONCE", at: "2026-10-16T06:00:00.000Z" }, timeZone: "Europe/Athens" }
    }));
  });

  it("creates tasks and supports completing, delete, clear, and fullscreen", async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
    render(<TaskDock canInsert={false} activePaneLabel={null} onInsert={vi.fn()} />);
    await screen.findByText("Verify the fallback policy before rollout.");

    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), { target: { value: "Manual task" } });
    const objective = screen.getByRole("textbox", { name: "Task objective" });
    fireEvent.change(objective, { target: { value: "manual objective" } });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(mocks.createTaskItem).toHaveBeenCalledWith({
      title: "Manual task",
      objective: "manual objective",
      status: "OPEN"
    }));

    fireEvent.click(screen.getByRole("button", { name: 'Mark "Verify fallback" as done' }));
    await waitFor(() => expect(mocks.updateTaskItem).toHaveBeenCalledWith(item.id, { status: "DONE" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    const deleteDialog = screen.getByRole("alertdialog", { name: "Delete this task?" });
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "Cancel" }));
    expect(mocks.deleteTaskItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.deleteTaskItem).toHaveBeenCalledWith(item.id));

    fireEvent.click(screen.getByRole("button", { name: "Clear all tasks" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Clear all tasks?" })).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(mocks.clearTaskItems).toHaveBeenCalled());
    expect(nativeConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open tasks fullscreen" }));
    expect(screen.getByLabelText("Task list").className).toContain("is-fullscreen");
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByLabelText("Task list").className).not.toContain("is-fullscreen");
  });

  it("blocks over-limit titles and shows a spinning Save while saving", async () => {
    let finishSave: (value: TaskItem) => void = () => undefined;
    mocks.createTaskItem.mockImplementation(() => new Promise<TaskItem>((resolve) => { finishSave = resolve; }));
    render(<TaskDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);
    await screen.findByText("Verify the fallback policy before rollout.");
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), { target: { value: "x".repeat(taskTitleMaxCharacters + 1) } });
    fireEvent.change(screen.getByRole("textbox", { name: "Task objective" }), { target: { value: "objective" } });
    expect(screen.getByText(`Title is over ${taskTitleMaxCharacters} characters`)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save task" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), { target: { value: "Short" } });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save task" }).querySelector(".dock-kit-spin")).toBeTruthy());
    await act(async () => finishSave(item));
  });

  it("reports copy failures instead of failing silently", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    render(<TaskDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy task objective" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Clipboard access was unavailable");
  });

  it("keeps the last tasks visible with a dismissible notice when a refresh fails", async () => {
    mocks.taskItems.mockRejectedValueOnce(new Error("Network down"));
    render(<TaskDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Network down");
    expect(screen.getByText("Verify the fallback policy before rollout.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an empty state when no tasks match", async () => {
    mocks.taskItems.mockResolvedValue({
      data: [],
      pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
    });
    render(<TaskDock canInsert activePaneLabel="Model Task" onInsert={vi.fn()} />);
    expect(await screen.findByText("No tasks yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add your first task" }));
    expect(screen.getByRole("textbox", { name: "Task title" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "nothing" } });
    expect(await screen.findByText("No tasks match this view.")).toBeTruthy();
  });
});
