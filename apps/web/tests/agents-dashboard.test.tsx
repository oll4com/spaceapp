import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paneSchema, roomSchema, type Pane } from "@space/contracts";
import { AgentsDashboard, isRedundantPreview, readStoredRoomFilter } from "../src/features/agents-dashboard/AgentsDashboard.js";
import { compareAgentEntries, dashboardElapsed, dashboardStatus, isDashboardAgent, dashboardProject, getAgentsIndicatorBorder, markAgentsSeen, resolveAgentStatus } from "../src/features/agents-dashboard/dashboard-model.js";

const { panes } = vi.hoisted(() => ({ panes: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: { dashboardAgents: panes } }));
const at = "2026-09-27T00:00:00.000Z";
const room = roomSchema.parse({ id: "room:dashboard", name: "Dashboard test", description: null, order: 0, createdAt: at, updatedAt: at, archivedAt: null, paneCap: 16, traceId: "trace:dashboard" });
function pane(id: string, patch: Partial<Pane> = {}): Pane {
  return paneSchema.parse({ id: `pane:test-${id.replaceAll(" ", "-")}`, roomId: room.id, title: id, mode: "TERMINAL", status: "IDLE", providerId: null, modelId: null, terminalRuntimeId: "cli:codex", cwd: "/work/space", order: 0, columnSpan: 1, isMaximized: false, isMinimized: false, isClosed: false, split: { parentId: null, direction: null, size: null }, createdAt: at, updatedAt: at, ...patch });
}
beforeEach(() => {
  try { window.localStorage?.clear(); } catch {}
  panes.mockReset();
  HTMLDialogElement.prototype.show = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("agents dashboard", () => {
  it("counts AI panes without treating an open idle CLI as working or a root shell as an agent", () => {
    expect(dashboardStatus(pane("idle"))).toBe("idle");
    expect(isDashboardAgent(pane("root", { terminalRuntimeId: "cli:root" }))).toBe(false);
    expect(isDashboardAgent(pane("browser", { mode: "BROWSER" }))).toBe(false);
    expect(isDashboardAgent(pane("closed", { isClosed: true }))).toBe(false);
    expect(isDashboardAgent(pane("minimized", { isMinimized: true }))).toBe(true);
    expect(dashboardStatus(pane("failed", { status: "ERROR" }))).toBe("waiting");
    expect(dashboardStatus(pane("busy"), { activeRunKey: "turn:one", activeRunAllowsCompletion: true, latestCompletionEventId: "event:old", pendingCompletionEventId: null })).toBe("working");
    expect(dashboardStatus(pane("done"), { activeRunKey: null, activeRunAllowsCompletion: false, latestCompletionEventId: "event:done", pendingCompletionEventId: "event:done" })).toBe("done");
    expect(dashboardStatus(pane("old-completion"), { activeRunKey: null, activeRunAllowsCompletion: false, latestCompletionEventId: "event:old", pendingCompletionEventId: null })).toBe("idle");
    expect(dashboardProject(pane("a", { cwd: "/srv/one/app" }), room.name).key).not.toBe(dashboardProject(pane("b", { cwd: "/srv/two/app" }), room.name).key);
  });
  it("filters by status and search, groups projects and opens the selected pane", async () => {
    const active = pane("Build dashboard", { status: "RUNNING" });
    panes.mockResolvedValue({ data: [active, pane("Review", { status: "BLOCKED", cwd: "/srv/review" }), pane("Finished", { status: "COMPLETE" }), pane("Shell", { terminalRuntimeId: "cli:root" })] });
    const onOpenPane = vi.fn(), onClose = vi.fn();
    render(<AgentsDashboard rooms={[room]} completions={{}} onOpenPane={onOpenPane} onClose={onClose} />);
    await screen.findByRole("button", { name: "Open Build dashboard in Dashboard test" });
    const filters = screen.getByRole("group", { name: "Filter agents by status" });
    fireEvent.click(within(filters).getByRole("button", { name: "Waiting for you 1" }));
    expect(screen.queryByRole("button", { name: /Open Build/ })).toBeNull();
    fireEvent.click(within(filters).getByRole("button", { name: "All 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    expect(screen.getByRole("region", { name: "space" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Build" } });
    expect(screen.queryByRole("button", { name: /Open Review/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Open Build dashboard/ }));
    await act(async () => {});
    expect(onOpenPane).toHaveBeenCalledWith(active);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("does not overlap requests, pauses in hidden tabs and stops on unmount", async () => {
    vi.useFakeTimers();
    let resolve!: (value: { data: Pane[] }) => void;
    panes.mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = render(<AgentsDashboard rooms={[room]} completions={{}} onOpenPane={vi.fn()} onClose={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(panes).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ data: [pane("idle")] }); });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(panes).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(panes).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { resolve({ data: [] }); await vi.advanceTimersByTimeAsync(30_000); });
    expect(panes).toHaveBeenCalledTimes(2);
  });
  it("shows all three native working tasks on a fresh browser and replaces stale local activity", async () => {
    const agents = [pane("one"), pane("two"), pane("three"), pane("finished")];
    panes.mockResolvedValue({ data: agents, activity: {
      [agents[0]!.id]: "working", [agents[1]!.id]: "working", [agents[2]!.id]: "working", [agents[3]!.id]: "done"
    } });
    render(<AgentsDashboard rooms={[room]} completions={{ [agents[3]!.id]: { activeRunKey: "stale", activeRunAllowsCompletion: true, latestCompletionEventId: null, pendingCompletionEventId: null } }} onOpenPane={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Working 3" });
    expect(screen.getByRole("button", { name: "Done 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Working 3" }));
    expect(document.querySelectorAll('.agents-dashboard-card')).toHaveLength(3);
    expect(document.querySelector('.agents-dashboard')?.hasAttribute('aria-modal')).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Expand agents dashboard" }));
    expect(document.querySelector('.agents-dashboard')?.classList.contains('is-maximized')).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Collapse agents dashboard" }));
    expect(document.querySelector('.agents-dashboard')?.classList.contains('is-maximized')).toBe(false);
  });
  it("keeps the last complete counts if a room refresh fails", async () => {
    vi.useFakeTimers();
    panes.mockResolvedValueOnce({ data: [pane("idle")] }).mockRejectedValueOnce(Error("offline"));
    render(<AgentsDashboard rooms={[room]} completions={{}} onOpenPane={vi.fn()} onClose={vi.fn()} />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole("alert").textContent).toContain("Keeping available agents");
    expect(screen.getByRole("button", { name: "Open idle in Dashboard test" })).toBeTruthy();
  });
  it("prefetches while closed and opens/reopens immediately without a new request", async () => {
    panes.mockResolvedValue({ data: [pane("cached")], activity: {} });
    const props = { rooms: [room], completions: {}, onOpenPane: vi.fn(), onClose: vi.fn() };
    const view = render(<AgentsDashboard {...props} open={false} />);
    await act(async () => {});
    expect(document.querySelector("dialog")).toBeNull();
    view.rerender(<AgentsDashboard {...props} open />);
    expect(screen.getByRole("button", { name: "Open cached in Dashboard test" })).toBeTruthy();
    view.rerender(<AgentsDashboard {...props} open={false} />);
    view.rerender(<AgentsDashboard {...props} open />);
    expect(screen.getByRole("button", { name: "Open cached in Dashboard test" })).toBeTruthy();
    expect(panes).toHaveBeenCalledTimes(1);
  });
  it("publishes healthy rooms even when another fails and evicts deleted rooms", async () => {
    vi.useFakeTimers();
    const other = { ...room, id: "room:other" };
    panes.mockImplementation(async (id: string) => {
      if (id === other.id) throw Error("offline");
      return { data: [pane("healthy")], activity: {} };
    });
    render(<AgentsDashboard rooms={[room, other]} completions={{}} onOpenPane={vi.fn()} onClose={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Open healthy in Dashboard test" })).toBeTruthy();
    panes.mockRejectedValue(Object.assign(Error("deleted"), { status: 404 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByRole("button", { name: "Open healthy in Dashboard test" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    const calls = panes.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(panes).toHaveBeenCalledTimes(calls);
  });
  it("determines live indicator border state: green run, yellow waiting-only, blue done-only, and idle", () => {
    expect(getAgentsIndicatorBorder(null)).toBe("idle");
    expect(getAgentsIndicatorBorder({ total: 7, working: 2, waiting: 5, done: 0, idle: 0, loaded: true })).toBe("run");
    expect(getAgentsIndicatorBorder({ total: 5, working: 0, waiting: 5, done: 0, idle: 0, loaded: true })).toBe("waiting-only");
    expect(getAgentsIndicatorBorder({ total: 3, working: 0, waiting: 0, done: 3, idle: 0, loaded: true })).toBe("done-only");
    expect(getAgentsIndicatorBorder({ total: 2, working: 0, waiting: 0, done: 0, idle: 2, loaded: true })).toBe("idle");
    expect(getAgentsIndicatorBorder({ total: 0, working: 0, waiting: 0, done: 0, idle: 0, loaded: true })).toBe("idle");
  });
  it("reports live summary updates through onSummaryChange callback", async () => {
    const onSummaryChange = vi.fn();
    const active = pane("Build", { status: "RUNNING" });
    const waiting = pane("Need input", { status: "BLOCKED" });
    panes.mockResolvedValue({ data: [active, waiting], activity: {} });
    render(<AgentsDashboard rooms={[room]} completions={{}} onOpenPane={vi.fn()} onClose={vi.fn()} onSummaryChange={onSummaryChange} />);
    await screen.findByRole("button", { name: "Open Build in Dashboard test" });
    expect(onSummaryChange).toHaveBeenCalledWith(expect.objectContaining({
      total: 2,
      working: 1,
      waiting: 1,
      done: 0,
      loaded: true,
    }));
  });
  it("remembers user selected filter across close and reopen", async () => {
    panes.mockResolvedValue({ data: [pane("Active", { status: "RUNNING" }), pane("Waiting", { status: "BLOCKED" })] });
    const props = { rooms: [room], completions: {}, onOpenPane: vi.fn(), onClose: vi.fn(), userId: "user-123" };
    const view = render(<AgentsDashboard {...props} open />);
    await screen.findByRole("button", { name: "Open Active in Dashboard test" });
    const filters = screen.getByRole("group", { name: "Filter agents by status" });
    fireEvent.click(within(filters).getByRole("button", { name: /Working/ }));
    expect(within(filters).getByRole("button", { name: /Working/ }).getAttribute("aria-pressed")).toBe("true");
    view.rerender(<AgentsDashboard {...props} open={false} />);
    view.rerender(<AgentsDashboard {...props} open />);
    const reopenedFilters = screen.getByRole("group", { name: "Filter agents by status" });
    expect(within(reopenedFilters).getByRole("button", { name: /Working/ }).getAttribute("aria-pressed")).toBe("true");
  });
  it("scopes agents with one This room / All rooms control and keeps room grouping for All rooms only", async () => {
    const roomA = room;
    const roomB = { ...room, id: "room:secondary", name: "Secondary Room" };
    const roomC = { ...room, id: "room:archived", name: "Archived Room", archivedAt: at };
    const agentA = pane("Agent Alpha", { roomId: roomA.id, status: "RUNNING" });
    const agentB = pane("Agent Beta", { id: "pane:test-beta", roomId: roomB.id, status: "IDLE" });

    panes.mockImplementation(async (id: string) => {
      if (id === roomA.id) return { data: [agentA], activity: {} };
      if (id === roomB.id) return { data: [agentB], activity: {} };
      return { data: [], activity: {} };
    });

    const props = {
      rooms: [roomA, roomB, roomC],
      currentRoomId: roomA.id,
      completions: {},
      onOpenPane: vi.fn(),
      onClose: vi.fn(),
      userId: "user-room-test",
    };

    const { rerender } = render(<AgentsDashboard {...props} open />);
    await screen.findByRole("button", { name: `Open ${agentA.title} in ${roomA.name}` });
    expect(screen.queryByRole("button", { name: `Open ${agentB.title} in ${roomB.name}` })).toBeNull();
    // The archived room is never polled.
    expect(panes.mock.calls.map(call => call[0])).not.toContain(roomC.id);

    // One scope control, no room dropdown, and the room name shown once (header), not again in the footer.
    const scope = screen.getByRole("group", { name: "Show agents from" });
    const currentBtn = within(scope).getByRole("button", { name: /This room/ });
    const allBtn = within(scope).getByRole("button", { name: /All rooms/ });
    expect(within(scope).getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(currentBtn.getAttribute("aria-pressed")).toBe("true");
    expect(currentBtn.textContent).toBe("This room 1");
    expect(allBtn.textContent).toBe("All rooms 2");
    expect(document.querySelector(".agents-dashboard-heading p")?.textContent).toBe(`Room: ${roomA.name}`);
    expect(document.querySelector(".agents-dashboard-footer")?.textContent).not.toContain(roomA.name);
    // Grouping by room is pointless inside one room.
    const grouping = screen.getByRole("group", { name: "Group agents by" });
    expect(within(grouping).queryByRole("button", { name: "Room" })).toBeNull();

    fireEvent.click(allBtn);
    expect(screen.getByRole("button", { name: `Open ${agentA.title} in ${roomA.name}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Open ${agentB.title} in ${roomB.name}` })).toBeTruthy();
    expect(allBtn.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".agents-dashboard-heading p")?.textContent).toBe("2 rooms with agents");

    fireEvent.click(within(grouping).getByRole("button", { name: "Room" }));
    expect(screen.getByRole("region", { name: roomA.name })).toBeTruthy();
    expect(screen.getByRole("region", { name: roomB.name })).toBeTruthy();

    // Scope and grouping survive a reopen.
    rerender(<AgentsDashboard {...props} open={false} />);
    rerender(<AgentsDashboard {...props} open />);
    expect(screen.getByRole("button", { name: `Open ${agentB.title} in ${roomB.name}` })).toBeTruthy();
    expect(screen.getByRole("region", { name: roomB.name })).toBeTruthy();

    // Back to this room: room groups fall back to status groups, the saved Room choice returns with All rooms.
    fireEvent.click(within(screen.getByRole("group", { name: "Show agents from" })).getByRole("button", { name: /This room/ }));
    expect(screen.getByRole("button", { name: `Open ${agentA.title} in ${roomA.name}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: `Open ${agentB.title} in ${roomB.name}` })).toBeNull();
    expect(screen.getByRole("region", { name: "Working" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("group", { name: "Show agents from" })).getByRole("button", { name: /All rooms/ }));
    expect(screen.getByRole("region", { name: roomB.name })).toBeTruthy();
  });
  it("reads a room saved by the old room picker as All rooms", () => {
    window.localStorage.setItem("space.agentsDashboard.roomFilter.user-legacy", "room:secondary");
    expect(readStoredRoomFilter("user-legacy", room.id)).toBe("all");
    window.localStorage.setItem("space.agentsDashboard.roomFilter.user-legacy", "current");
    expect(readStoredRoomFilter("user-legacy", room.id)).toBe("current");
    expect(readStoredRoomFilter("user-legacy", null)).toBe("all");
    expect(readStoredRoomFilter("user-new", room.id)).toBe("current");
  });
  it("shows a card description only when it adds to the title, and each time only once", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-11T06:10:00.000Z"), toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const meta = (description: string) => ({ taskKey: "k", version: 1, description, steps: [], earlierWork: "", source: "ai" as const, generationStatus: "ready" as const, nativeSyncStatus: "synced" as const, providerId: null, modelId: null, updatedAt: at });
    const echo = pane("echo", { title: "τα ελληνικα", taskMetadata: meta("τα ελληνικα!!!") });
    const detailed = pane("detailed", { title: "CLI του SpaceApp", taskMetadata: meta("Στόχος είναι να οργανωθεί η εργασία σχετικά με το CLI του SpaceApp.") });
    const idle = pane("Old task", { paneName: "Oscar" });
    panes.mockResolvedValue({ data: [echo, detailed, idle], activity: { [echo.id]: "working", [detailed.id]: "working", [idle.id]: "idle" }, details: {
      [echo.id]: { status: "working", since: "2026-10-11T06:05:00.000Z", source: "native" },
      [detailed.id]: { status: "working", since: "2026-10-11T06:09:00.000Z", source: "native" },
      [idle.id]: { status: "idle", source: "screen" }
    } });
    render(<AgentsDashboard rooms={[room]} completions={{}} onOpenPane={vi.fn()} onClose={vi.fn()} />);
    await act(async () => {});
    const echoCard = screen.getByRole("button", { name: "Open τα ελληνικα in Dashboard test" });
    expect(echoCard.querySelector(".agents-dashboard-preview")).toBeNull();
    const detailedCard = screen.getByRole("button", { name: "Open CLI του SpaceApp in Dashboard test" });
    expect(detailedCard.querySelector(".agents-dashboard-preview")?.textContent).toContain("Στόχος");
    // Working time is on the badge only; the footer no longer repeats it as a start time.
    expect(within(echoCard).getByText("Working 5m")).toBeTruthy();
    expect(echoCard.querySelector("time")).toBeNull();
    expect(echoCard.textContent).not.toContain("Started");
    // The pane's name leads its card title.
    const named = screen.getByRole("button", { name: "Open Oscar · Old task in Dashboard test" });
    expect(named.querySelector("strong")?.textContent).toBe("Oscar · Old task");
    expect(named.querySelector("time")).toBeTruthy();
    expect(isRedundantPreview("Implement the plan", "Implement the plan.")).toBe(true);
    expect(isRedundantPreview("Implement the following plan: (\"Upgrade\")", "Implement the following plan: (\"Upgrade\") Plan ID: clipboard:wxc6q7AaaMt6")).toBe(false);
    expect(isRedundantPreview("Fix", "")).toBe(true);
  });
  it("clears the search from its own button", async () => {
    panes.mockResolvedValue({ data: [pane("Alpha"), pane("Beta")] });
    render(<AgentsDashboard rooms={[room]} completions={{}} onOpenPane={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Open Alpha in Dashboard test" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Alpha" } });
    expect(screen.queryByRole("button", { name: /Open Beta/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("button", { name: "Open Beta in Dashboard test" })).toBeTruthy();
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  });
  it("shows live Claude status details: elapsed working time, model and the waiting reason", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-11T06:10:00.000Z"), toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const busy = pane("Implement the plan", { terminalRuntimeId: "cli:claude" });
    const blocked = pane("Review the migration", { terminalRuntimeId: "cli:claude" });
    const stopped = pane("Old task", { terminalRuntimeId: "cli:claude" });
    panes.mockResolvedValue({ data: [stopped, busy, blocked], activity: { [busy.id]: "working", [blocked.id]: "waiting", [stopped.id]: "idle" }, details: {
      [busy.id]: { status: "working", since: "2026-10-11T06:00:00.000Z", modelId: "claude-opus-5-5", source: "native" },
      [blocked.id]: { status: "waiting", reason: "Permission prompt", since: "2026-10-11T06:08:00.000Z", source: "native" },
      [stopped.id]: { status: "idle", reason: "Not running", source: "session" }
    } });
    render(<AgentsDashboard rooms={[room]} completions={{}} onOpenPane={vi.fn()} onClose={vi.fn()} />);
    await act(async () => {});
    const working = screen.getByRole("button", { name: "Open Implement the plan in Dashboard test" });
    expect(working.dataset.status).toBe("working");
    expect(within(working).getByText("Working 10m")).toBeTruthy();
    expect(working.textContent).toContain("Claude Code");
    expect(working.textContent).toContain("claude-opus-5-5");
    const waiting = screen.getByRole("button", { name: "Open Review the migration in Dashboard test" });
    expect(within(waiting).getByText("Permission prompt")).toBeTruthy();
    expect(within(waiting).getByText("Waiting 2m")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: "Open Old task in Dashboard test" })).getByText("Not running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Working 1" })).toBeTruthy();
    // Waiting agents sort first in every grouping.
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    expect([...document.querySelectorAll<HTMLElement>(".agents-dashboard-card")].map(card => card.dataset.status)).toEqual(["waiting", "working", "idle"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(within(screen.getByRole("button", { name: "Open Implement the plan in Dashboard test" })).getByText("Working 11m")).toBeTruthy();
  });
  it("keeps finished work Done until the operator looks at it", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-11T06:00:00.000Z"), toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const before = pane("Finished before first visit");
    const fresh = pane("Finished just now");
    const other = pane("Finished elsewhere");
    const done = (since: string) => ({ status: "done" as const, since, source: "native" as const });
    // The first visit was at 05:30: only work finished after it is news.
    try { window.localStorage.setItem("space.agentsDashboard.seen.v1.user-seen", JSON.stringify({ baseline: "2026-10-11T05:30:00.000Z", panes: {} })); } catch {}
    panes.mockResolvedValue({ data: [before, fresh, other], activity: { [before.id]: "done", [fresh.id]: "done", [other.id]: "done" }, details: {
      [before.id]: done("2026-10-11T05:00:00.000Z"), [fresh.id]: done("2026-10-11T05:50:00.000Z"), [other.id]: done("2026-10-11T05:55:00.000Z")
    } });
    const onOpenPane = vi.fn();
    const props = { rooms: [room], currentRoomId: room.id, completions: {}, onOpenPane, onClose: vi.fn(), userId: "user-seen" };
    const view = render(<AgentsDashboard {...props} />);
    await act(async () => {});
    const status = (title: string) => screen.getByRole("button", { name: `Open ${title} in Dashboard test` }).dataset.status;
    expect([status(before.title), status(fresh.title), status(other.title)]).toEqual(["idle", "done", "done"]);
    expect(screen.getByText("2 agents finished since you last looked.")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    fireEvent.click(screen.getByRole("button", { name: `Open ${fresh.title} in Dashboard test` }));
    await act(async () => {});
    expect(onOpenPane).toHaveBeenCalledWith(fresh);
    expect(status(fresh.title)).toBe("idle");
    // Selecting a pane in the current room is looking at it.
    view.rerender(<AgentsDashboard {...props} selectedPaneId={other.id} />);
    expect(status(other.title)).toBe("idle");
    expect(screen.queryByText(/finished since you last looked/)).toBeNull();
    expect(screen.getByRole("button", { name: `Open ${fresh.title} in Dashboard test` }).querySelector("time")?.textContent).toBe("Finished 10m ago");
    // The record survives a reload of the dashboard.
    view.unmount();
    render(<AgentsDashboard {...props} />);
    await act(async () => {});
    expect(status(fresh.title)).toBe("idle");
  });
  it("marks every finished agent as seen at once", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-11T06:00:00.000Z"), toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try { window.localStorage.setItem("space.agentsDashboard.seen.v1.user-all", JSON.stringify({ baseline: "2026-10-11T05:00:00.000Z", panes: {} })); } catch {}
    const agents = [pane("one"), pane("two")];
    panes.mockResolvedValue({ data: agents, activity: Object.fromEntries(agents.map(agent => [agent.id, "done"])),
      details: Object.fromEntries(agents.map(agent => [agent.id, { status: "done", since: "2026-10-11T05:30:00.000Z" }])) });
    render(<AgentsDashboard rooms={[room]} completions={{}} onOpenPane={vi.fn()} onClose={vi.fn()} userId="user-all" />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Done 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark all as seen" }));
    expect(screen.getByRole("button", { name: "Done 0" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Idle 2" })).toBeTruthy();
  });
  it("polls faster while open, refreshes stale data on open and on demand", async () => {
    vi.useFakeTimers();
    panes.mockResolvedValue({ data: [pane("agent")], activity: {} });
    const props = { rooms: [room], completions: {}, onOpenPane: vi.fn(), onClose: vi.fn() };
    const view = render(<AgentsDashboard {...props} open={false} />);
    await act(async () => {});
    expect(panes).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(panes).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(panes).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
    view.rerender(<AgentsDashboard {...props} open />);
    await act(async () => {});
    expect(panes).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(panes).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
    await act(async () => {});
    expect(panes).toHaveBeenCalledTimes(5);
  });
  it("treats an incomplete response as a failed refresh and offers a retry", async () => {
    panes.mockResolvedValueOnce(undefined).mockResolvedValue({ data: [pane("recovered")], activity: {} });
    render(<AgentsDashboard rooms={[room]} completions={{}} onOpenPane={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole("alert");
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Open recovered in Dashboard test" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("supports keyboard search and card navigation, and collapsible groups that persist", async () => {
    panes.mockResolvedValue({ data: [pane("Alpha", { status: "RUNNING" }), pane("Beta")], activity: {} });
    const props = { rooms: [room], completions: {}, onOpenPane: vi.fn(), onClose: vi.fn(), userId: "user-keys" };
    const view = render(<AgentsDashboard {...props} />);
    const alpha = await screen.findByRole("button", { name: "Open Alpha in Dashboard test" });
    const search = screen.getByRole("searchbox");
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "/" });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(alpha);
    fireEvent.keyDown(alpha, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open Beta in Dashboard test" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "codex" } });
    expect(document.querySelectorAll(".agents-dashboard-card")).toHaveLength(2);
    fireEvent.change(search, { target: { value: "" } });
    const toggle = screen.getByRole("button", { name: "Collapse Idle group" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: "Open Beta in Dashboard test" })).toBeNull();
    expect(screen.getByRole("button", { name: "Expand Idle group" }).getAttribute("aria-expanded")).toBe("false");
    view.unmount();
    render(<AgentsDashboard {...props} />);
    await screen.findByRole("button", { name: "Open Alpha in Dashboard test" });
    expect(screen.queryByRole("button", { name: "Open Beta in Dashboard test" })).toBeNull();
  });
  it("resolves seen finishes, ordering and elapsed labels in the model", () => {
    const seen = { baseline: "2026-10-11T06:00:00.000Z", panes: {} };
    const agent = pane("model");
    expect(resolveAgentStatus(agent, { activity: "done", detail: { status: "done", since: "2026-10-11T05:59:59.000Z" }, seen })).toMatchObject({ status: "idle", seenFinish: true });
    expect(resolveAgentStatus(agent, { activity: "done", detail: { status: "done", since: "2026-10-11T06:00:01.000Z" }, seen }).status).toBe("done");
    expect(resolveAgentStatus(agent, { activity: "done", seen }).status).toBe("done");
    expect(resolveAgentStatus(agent, { seen, completion: { activeRunKey: "run", activeRunAllowsCompletion: true, latestCompletionEventId: null, pendingCompletionEventId: null } }).status).toBe("working");
    const marked = markAgentsSeen(seen, [agent.id], "2026-10-11T06:00:02.000Z");
    expect(resolveAgentStatus(agent, { activity: "done", detail: { status: "done", since: "2026-10-11T06:00:01.000Z" }, seen: marked }).status).toBe("idle");
    expect(Object.keys(markAgentsSeen({ baseline: seen.baseline, panes: Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`pane:${i}`, `2026-10-11T06:${String(i % 60).padStart(2, "0")}:00.000Z`])) }, [], seen.baseline).panes)).toHaveLength(500);
    const entry = (status: "waiting" | "working" | "done" | "idle", lastActivityAt: string, id: string) => ({ status, lastActivityAt, pane: pane(id) });
    expect([entry("idle", "2026-10-11T07:00:00.000Z", "a"), entry("working", "2026-10-11T05:00:00.000Z", "b"), entry("working", "2026-10-11T06:00:00.000Z", "c"), entry("waiting", "2026-10-11T01:00:00.000Z", "d")]
      .sort(compareAgentEntries).map(item => item.pane.title)).toEqual(["d", "c", "b", "a"]);
    const now = Date.parse("2026-10-11T06:00:00.000Z");
    expect(["2026-10-11T05:59:15.000Z", "2026-10-11T05:48:00.000Z", "2026-10-11T04:55:00.000Z", "2026-10-11T04:00:00.000Z", "2026-10-09T03:00:00.000Z"].map(since => dashboardElapsed(since, now)))
      .toEqual(["45s", "12m", "1h 5m", "2h", "2d 3h"]);
  });
});
