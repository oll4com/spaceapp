import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionHistoryItem, AgentSessionHistoryResponse } from "@space/contracts";

const mocks = vi.hoisted(() => ({
  agentSessions: vi.fn(),
  agentSessionRename: vi.fn(),
  agentSessionArchive: vi.fn()
}));

vi.mock("../src/api.js", () => ({ api: mocks }));

import { AgentSessionsDock, resetAgentSessionsDockCache } from "../src/features/agent-sessions/AgentSessionsDock.js";

const checkedAt = "2026-08-07T12:00:00.000Z";

const historyResponse: AgentSessionHistoryResponse = {
  data: [
    {
      id: "codex:thread-1",
      kind: "codex",
      threadId: "thread-1",
      taskId: null,
      title: "Codex plan",
      preview: "Build the dock",
      providerLabel: "Codex",
      model: "gpt-5.6-terra",
      modelProvider: "codex",
      cwd: "/Users/Admin",
      source: "local",
      threadSource: "local",
      firstUserMessage: "Build the dock",
      archived: false,
      updatedAt: "2026-08-07T10:00:00.000Z",
      recencyAt: "2026-08-07T10:00:00.000Z",
      status: "completed",
      isCompleted: true
    },
    {
      id: "cli:task-1",
      kind: "cli",
      threadId: null,
      taskId: "task-1",
      title: "OpenCode task",
      preview: "Install opencode",
      providerLabel: "OpenCode",
      model: "deepseek-v4-flash-free",
      modelProvider: "opencode",
      cwd: "/work/space",
      source: "space",
      threadSource: "cli:opencode",
      firstUserMessage: "Install opencode",
      archived: false,
      updatedAt: "2026-08-07T11:00:00.000Z",
      recencyAt: "2026-08-07T11:00:00.000Z",
      status: "active",
      isCompleted: false
    }
  ],
  totalItems: 2,
  visibleItems: 2,
  checkedAt
};

function renderDock(overrides: {
  canResume?: boolean;
  codexEnabled?: boolean;
  onResume?: (item: AgentSessionHistoryItem) => Promise<string | null>;
} = {}) {
  return render(
    <AgentSessionsDock
      activePaneLabel="Main pane"
      canResume={overrides.canResume ?? true}
      codexEnabled={overrides.codexEnabled ?? true}
      onResume={overrides.onResume ?? vi.fn().mockResolvedValue(null)}
    />
  );
}

function rowOf(title: string): HTMLElement {
  const row = screen.getByText(title).closest("article");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("AgentSessionsDock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAgentSessionsDockCache();
    mocks.agentSessions.mockResolvedValue(historyResponse);
    mocks.agentSessionRename.mockResolvedValue({ ...historyResponse.data[0], title: "Renamed plan" });
    mocks.agentSessionArchive.mockResolvedValue({ ...historyResponse.data[0], archived: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the session list with a plain summary, provider labels, status badges and folder groups", async () => {
    const { container } = renderDock();
    expect(screen.getByRole("status").textContent).toContain("Loading sessions");
    expect(await screen.findByText("Codex plan")).toBeTruthy();
    expect(screen.getByText("OpenCode task")).toBeTruthy();
    expect(screen.getByText("Users/Admin")).toBeTruthy();
    expect(screen.getByText("work/space")).toBeTruthy();
    expect(container.querySelector(".agent-sessions-dock")).toBeTruthy();
    expect(container.querySelector(".dock-kit-summary")?.textContent).toBe("2 sessions");
    // The shell header already names the dock; no duplicate title or jargon.
    expect(screen.queryByText("Agent Session History")).toBeNull();
    expect(container.textContent).not.toMatch(/recent —|every active CLI runtime/);
    expect(within(rowOf("Codex plan")).getByText("Completed").className).toContain("is-success");
    expect(within(rowOf("OpenCode task")).getByText("Active").className).toContain("is-accent");
    expect(within(rowOf("Codex plan")).getByText(/Codex · .* · gpt-5\.6-terra/)).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search agent sessions" })).toBeTruthy();
    expect(container.querySelector("input[type='checkbox']:not([role='switch'])")).toBeNull();
  });

  it("searches as you type with a 300 ms debounce and clears the search", async () => {
    renderDock();
    await screen.findByText("Codex plan");
    const search = screen.getByRole("searchbox", { name: "Search agent sessions" }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "open" } });
    fireEvent.change(search, { target: { value: "opencode" } });
    await waitFor(() => {
      expect(mocks.agentSessions).toHaveBeenLastCalledWith(expect.objectContaining({ q: "opencode", page: 1 }));
    });
    expect(mocks.agentSessions.mock.calls.filter(([input]) => input.q)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search.value).toBe("");
    await waitFor(() => expect(mocks.agentSessions).toHaveBeenLastCalledWith(expect.objectContaining({ q: undefined })));
  });

  it("resumes a codex thread", async () => {
    const onResume = vi.fn().mockResolvedValue(null);
    renderDock({ onResume });
    await screen.findByText("Codex plan");
    const resume = within(rowOf("Codex plan")).getByRole("button", { name: "Resume session Codex plan" });
    expect(resume.getAttribute("title")).toBe("Resume in Main pane");
    fireEvent.click(resume);
    expect(onResume).toHaveBeenCalledWith(historyResponse.data[0]);
    await waitFor(() => expect((resume as HTMLButtonElement).disabled).toBe(false));
  });

  it("resumes a CLI task and surfaces failures in a dismissible notice", async () => {
    const onResume = vi.fn().mockResolvedValue("CLI resume failed");
    renderDock({ onResume });
    await screen.findByText("OpenCode task");
    fireEvent.click(within(rowOf("OpenCode task")).getByRole("button", { name: "Resume session OpenCode task" }));
    expect(onResume).toHaveBeenCalledWith(historyResponse.data[1]);
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("CLI resume failed");
    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains why Resume is unavailable without a room", async () => {
    const onResume = vi.fn().mockResolvedValue(null);
    renderDock({ canResume: false, onResume });
    await screen.findByText("Codex plan");
    const resume = within(rowOf("Codex plan")).getByRole("button", { name: "Resume session Codex plan" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    expect(resume.getAttribute("title")).toBe("Open a room to resume");
    expect(screen.getByText("Open a room to resume a session.")).toBeTruthy();
    fireEvent.click(resume);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("renames a codex session inline with Enter", async () => {
    renderDock();
    await screen.findByText("Codex plan");
    const row = rowOf("Codex plan");
    fireEvent.click(within(row).getByRole("button", { name: "Rename session Codex plan" }));
    const input = within(row).getByLabelText("Session title");
    fireEvent.change(input, { target: { value: "Renamed plan" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => {
      expect(mocks.agentSessionRename).toHaveBeenCalledWith("thread-1", "Renamed plan");
      expect(screen.getByText("Renamed plan")).toBeTruthy();
    });
    expect(within(row).queryByLabelText("Session title")).toBeNull();
  });

  it("saves a rename with the save button and blocks a second save while it is pending", async () => {
    const pending = deferred<AgentSessionHistoryItem>();
    mocks.agentSessionRename.mockReturnValue(pending.promise);
    renderDock();
    await screen.findByText("Codex plan");
    const row = rowOf("Codex plan");
    fireEvent.click(within(row).getByRole("button", { name: "Rename session Codex plan" }));
    fireEvent.change(within(row).getByLabelText("Session title"), { target: { value: "Renamed plan" } });
    const save = within(row).getByRole("button", { name: "Save session title" }) as HTMLButtonElement;
    fireEvent.click(save);
    await waitFor(() => expect(save.disabled).toBe(true));
    expect((within(row).getByRole("button", { name: "Cancel session rename" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(within(row).getByLabelText("Session title"), { key: "Enter" });
    expect(mocks.agentSessionRename).toHaveBeenCalledTimes(1);
    pending.resolve({ ...historyResponse.data[0]!, title: "Renamed plan" });
    expect(await screen.findByText("Renamed plan")).toBeTruthy();
  });

  it("disables Rename and Archive while an action on that session is pending", async () => {
    const pending = deferred<string | null>();
    renderDock({ onResume: () => pending.promise });
    await screen.findByText("Codex plan");
    const row = rowOf("Codex plan");
    fireEvent.click(within(row).getByRole("button", { name: "Resume session Codex plan" }));
    await waitFor(() => expect((within(row).getByRole("button", { name: "Rename session Codex plan" }) as HTMLButtonElement).disabled).toBe(true));
    expect((within(row).getByRole("button", { name: "Archive session Codex plan" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(row).getByText("Opening…")).toBeTruthy();
    pending.resolve(null);
    await waitFor(() => expect((within(row).getByRole("button", { name: "Rename session Codex plan" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("cancels rename on cancel button click or escape key", async () => {
    renderDock();
    await screen.findByText("Codex plan");
    const row = rowOf("Codex plan");
    fireEvent.click(within(row).getByRole("button", { name: "Rename session Codex plan" }));
    expect(within(row).getByLabelText("Session title")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "Cancel session rename" }));
    expect(within(row).queryByLabelText("Session title")).toBeNull();
    expect(within(row).getByText("Codex plan")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "Rename session Codex plan" }));
    fireEvent.keyDown(within(row).getByLabelText("Session title"), { key: "Escape", code: "Escape" });
    expect(within(row).queryByLabelText("Session title")).toBeNull();
    expect(mocks.agentSessionRename).not.toHaveBeenCalled();
  });

  it("asks before archiving and explains where archived sessions go", async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
    renderDock();
    await screen.findByText("Codex plan");
    fireEvent.click(within(rowOf("Codex plan")).getByRole("button", { name: "Archive session Codex plan" }));
    const dialog = screen.getByRole("alertdialog", { name: "Archive this session?" });
    expect(dialog.textContent).toContain("Include archived");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.agentSessionArchive).not.toHaveBeenCalled();

    fireEvent.click(within(rowOf("Codex plan")).getByRole("button", { name: "Archive session Codex plan" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Archive this session?" })).getByRole("button", { name: "Archive" }));
    await waitFor(() => {
      expect(mocks.agentSessionArchive).toHaveBeenCalledWith("thread-1");
      expect(screen.queryByText("Codex plan")).toBeNull();
    });
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("shows archived sessions with a badge when Include archived is on", async () => {
    renderDock();
    await screen.findByText("Codex plan");
    mocks.agentSessions.mockResolvedValue({
      ...historyResponse,
      data: [{ ...historyResponse.data[0]!, archived: true }, historyResponse.data[1]!]
    });
    fireEvent.click(screen.getByRole("switch", { name: "Include archived" }));
    await waitFor(() => {
      expect(mocks.agentSessions).toHaveBeenLastCalledWith(expect.objectContaining({ includeArchived: true, page: 1 }));
    });
    const row = rowOf("Codex plan");
    expect(await within(row).findByText("Archived")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Archive session Codex plan" })).toBeNull();
  });

  it("disables Codex rename and archive with a hint when Codex is off", async () => {
    renderDock({ codexEnabled: false });
    await screen.findByText("Codex plan");
    const rename = within(rowOf("Codex plan")).getByRole("button", { name: "Rename session Codex plan" }) as HTMLButtonElement;
    expect(rename.disabled).toBe(true);
    expect(rename.getAttribute("title")).toBe("Turn on Codex to rename or archive Codex sessions");
  });

  it("shows empty states for no history and for a filtered view", async () => {
    mocks.agentSessions.mockResolvedValue({ data: [], totalItems: 0, visibleItems: 0, checkedAt });
    renderDock();
    expect(await screen.findByText("No agent sessions yet")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("group", { name: "Session status" })).getByRole("button", { name: "Active" }));
    expect(await screen.findByText("No sessions match this view")).toBeTruthy();
  });

  it("does not crash when the response has no counts, as the demo workspace returns", async () => {
    // The demo store answers unknown calls with { data: [], pagination, status } and no totalItems.
    mocks.agentSessions.mockResolvedValue({ data: [], pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 }, status: "SIMULATED" });
    const { container } = renderDock();
    expect(await screen.findByText("No agent sessions yet")).toBeTruthy();
    expect(container.querySelector(".dock-kit-summary")?.textContent).toBe("0 sessions");
  });

  it("counts rows when the response has data but no totals", async () => {
    mocks.agentSessions.mockResolvedValue({ data: historyResponse.data, checkedAt });
    const { container } = renderDock();
    await screen.findByText("Codex plan");
    expect(container.querySelector(".dock-kit-summary")?.textContent).toBe("2 sessions");
  });

  it("toggles group collapse and expand", async () => {
    renderDock();
    expect(await screen.findByText("Codex plan")).toBeTruthy();
    const groupHeader = screen.getByRole("button", { name: /Users\/Admin/i });
    expect(groupHeader.getAttribute("aria-expanded")).toBe("true");
    expect(groupHeader.getAttribute("title")).toBe("/Users/Admin");

    fireEvent.click(groupHeader);
    expect(screen.queryByText("Codex plan")).toBeNull();
    expect(groupHeader.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(groupHeader);
    expect(screen.getByText("Codex plan")).toBeTruthy();
    expect(groupHeader.getAttribute("aria-expanded")).toBe("true");
  });

  it("loads more sessions when load more is clicked", async () => {
    const baseItem = historyResponse.data[0]!;
    const page1Data: AgentSessionHistoryItem[] = Array.from({ length: 50 }, (_, i) => ({
      ...baseItem,
      id: `codex:thread-${i}`,
      title: i === 0 ? "Codex plan" : `Session ${i}`
    }));

    mocks.agentSessions
      .mockResolvedValueOnce({ data: page1Data, totalItems: 51, visibleItems: 50, checkedAt })
      .mockResolvedValueOnce({
        data: [{ ...historyResponse.data[1]!, id: "cli:task-2", taskId: "task-2", title: "Third task" }],
        totalItems: 51,
        visibleItems: 51,
        checkedAt
      });

    const { container } = renderDock();
    expect(await screen.findByText("Codex plan")).toBeTruthy();
    expect(container.querySelector(".dock-kit-summary")?.textContent).toBe("51 sessions · 50 shown");
    const loadMoreButton = screen.getByRole("button", { name: "Load more" });
    expect(loadMoreButton.className).toContain("dock-kit-button");
    fireEvent.click(loadMoreButton);
    await waitFor(() => {
      expect(mocks.agentSessions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
      expect(screen.getByText("Third task")).toBeTruthy();
    });
    expect(screen.getByText("Codex plan")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("refreshes without replacing the list with a loading state", async () => {
    const { container } = renderDock();
    await screen.findByText("Codex plan");
    const pending = deferred<AgentSessionHistoryResponse>();
    mocks.agentSessions.mockReturnValueOnce(pending.promise);
    const refreshButton = screen.getByRole("button", { name: "Refresh agent session history" }) as HTMLButtonElement;
    fireEvent.click(refreshButton);
    await waitFor(() => expect(refreshButton.disabled).toBe(true));
    expect(mocks.agentSessions).toHaveBeenCalledTimes(2);
    // The list stays on screen during the refresh; no loading state replaces it.
    expect(screen.getByText("Codex plan")).toBeTruthy();
    expect(screen.queryByText("Loading sessions…")).toBeNull();
    expect(container.querySelector(".agent-sessions-list")?.getAttribute("aria-busy")).toBe("true");
    pending.resolve({ ...historyResponse, data: [{ ...historyResponse.data[0]!, title: "Fresh plan" }], totalItems: 1, visibleItems: 1 });
    expect(await screen.findByText("Fresh plan")).toBeTruthy();
    await waitFor(() => expect(refreshButton.disabled).toBe(false));
  });

  it("shows a readable error once with Try again when the first load fails", async () => {
    mocks.agentSessions.mockRejectedValueOnce(new Error("Codex history is unavailable."));
    const { container } = renderDock();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Session history could not be loaded");
    expect(alert.textContent).toContain("Codex history is unavailable.");
    expect(container.textContent).not.toContain("AGENT_SESSIONS_ERROR");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Codex plan")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the sessions and shows a dismissible notice when a refresh fails", async () => {
    const { container } = renderDock();
    await screen.findByText("Codex plan");
    mocks.agentSessions.mockRejectedValueOnce(new Error("Codex history is unavailable."));
    fireEvent.click(screen.getByRole("button", { name: "Refresh agent session history" }));
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toBe("Sessions could not be refreshed. Codex history is unavailable.");
    expect(screen.getByText("Codex plan")).toBeTruthy();
    expect(container.textContent).not.toContain("AGENT_SESSIONS_ERROR");
    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("filters by time range and status with chips", async () => {
    renderDock();
    await screen.findByText("Codex plan");
    const range = screen.getByRole("group", { name: "Time range" });
    expect(within(range).getAllByRole("button").map((button) => button.textContent)).toEqual(["Last 7 days", "3 days", "24 hours", "Today"]);
    expect(within(range).getByRole("button", { name: "Last 7 days" }).getAttribute("aria-pressed")).toBe("true");
    expect(mocks.agentSessions).toHaveBeenLastCalledWith(expect.objectContaining({ interval: "all" }));

    fireEvent.click(within(range).getByRole("button", { name: "Today" }));
    await waitFor(() => expect(mocks.agentSessions).toHaveBeenLastCalledWith(expect.objectContaining({ interval: "today" })));
    fireEvent.click(within(range).getByRole("button", { name: "24 hours" }));
    await waitFor(() => expect(mocks.agentSessions).toHaveBeenLastCalledWith(expect.objectContaining({ interval: "24h" })));
    fireEvent.click(within(range).getByRole("button", { name: "3 days" }));
    await waitFor(() => expect(mocks.agentSessions).toHaveBeenLastCalledWith(expect.objectContaining({ interval: "3d" })));

    const status = screen.getByRole("group", { name: "Session status" });
    fireEvent.click(within(status).getByRole("button", { name: "Completed" }));
    await waitFor(() => expect(mocks.agentSessions).toHaveBeenLastCalledWith(expect.objectContaining({ status: "completed", interval: "3d" })));
    expect(within(status).getByRole("button", { name: "Completed" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(status).getByRole("button", { name: "All" }));
    await waitFor(() => expect(mocks.agentSessions).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined })));
  });

  it("does not shadow the global setInterval", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(testDir, "../src/features/agent-sessions/AgentSessionsDock.tsx"), "utf8");
    expect(source).not.toMatch(/\bsetInterval\b/);
  });

  it("opens and leaves fullscreen", async () => {
    const { container } = renderDock();
    await screen.findByText("Codex plan");
    fireEvent.click(screen.getByRole("button", { name: "Open sessions fullscreen" }));
    expect(container.querySelector(".dock-kit-shell.is-fullscreen")).toBeTruthy();
    expect(container.querySelector(".dock-kit-title")?.textContent).toBe("Sessions");
    fireEvent.click(screen.getByRole("button", { name: "Exit sessions fullscreen" }));
    expect(container.querySelector(".dock-kit-shell.is-fullscreen")).toBeNull();
  });
});
