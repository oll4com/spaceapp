import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxEvent, InboxPage, InboxThreadView } from "@space/contracts";
import { NousInbox, useInboxView } from "../src/features/nous/NousInbox.js";
import { requestInboxView } from "../src/features/nous/nous-done-events.js";
import { resetNotificationStore } from "../src/features/notifications/notification-store.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";

const apiMock = vi.hoisted(() => ({
  inbox: vi.fn(), inboxThread: vi.fn(), actInbox: vi.fn(async () => ({ badge: 0, attention: false, thread: null, display: null })),
  inboxDoneAll: vi.fn(async () => ({ done: [], skipped: [], badge: 0, attention: false })),
  notificationsPending: vi.fn(async () => ({ total: 0, bySource: {}, byRoom: {}, byPane: {}, latest: [] })), notifications: vi.fn(async () => ({ notifications: [] })),
  nousPaneBoard: vi.fn(async () => ({ board: { rooms: [], settings: {} } })),
  nousRequests: vi.fn(async () => ({ requests: [], hasMore: false, counts: {} })),
  deployQueueTicket: vi.fn(async (id: string) => ({ ticket: { id, status: "DEPLOYED", summary: "Tabs on dev", note: null } })),
  // Pane-report text renders AgentFileMentions, which reads the Agent Files index.
  artifacts: vi.fn(async () => ({ data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } }))
}));
vi.mock("../src/api.js", () => ({ api: apiMock }));

const at = "2026-11-15T10:00:00.000Z";
const event = (id: string, extra: Partial<InboxEvent>): InboxEvent => ({ id: `inbox_event:${id}`, threadId: "", at, type: "UPDATE", actor: "nous", title: id, body: "", priority: "ATTENTION", ...extra });
const thread = (id: string, extra: Partial<InboxThreadView>): InboxThreadView => ({ id: `inbox_thread:${id}`, ownerUserId: "user:me", key: id, title: id, origin: "NOUS", originLabel: "Nous",
  waitingFor: "NOBODY", unseen: false, closedAt: null, closedBy: null, priority: "ATTENTION", now: "", progress: null, refs: {}, createdAt: at, lastEventAt: at, openAsks: [], ...extra });
const ask = thread("ask", { title: "Pick a colour", waitingFor: "OPERATOR", tab: "NEEDS", openAsks: [event("q", { type: "ASK", title: "Red or blue?", ref: "notification:q",
  ask: { open: true, forOperator: true, kind: "QUESTION", options: ["red", "blue"], recommended: "red" } })] });
const done = thread("done", { title: "Rename the tab", unseen: true, tab: "DONE", news: "REPORT", report: "Renamed\nChecked: the tab reads Updates on dev", refs: { where: "dev", ticketIds: ["q-1"] } });
const fresh = thread("fresh", { title: "Tests passed", unseen: true, tab: "UPDATES", news: "UPDATE" });
const alert = thread("alert", { title: "Deploy failed", origin: "SYSTEM", originLabel: "System", unseen: true, tab: "UPDATES", news: "ALERT" });
const quiet = thread("quiet", { title: "Mail from a shop", origin: "COPILOT", originLabel: "Mail Copilot", unseen: true, priority: "INFO", tab: "UPDATES", news: "ALERT" });
// An open request with a plan and unread news: under Requests, and under Updates too until it is seen (plan JD8EbQgQdRls §3).
const working = thread("working", { title: "Build the inbox", waitingFor: "NOUS", progress: 40, now: "Step 2 · 40%: Step 2 is live", refs: { planId: "clipboard:p1" }, unseen: true, openRequest: true,
  tab: "REQUESTS", news: "PROGRESS", requestNews: true });
const closed = thread("closed", { title: "Old report", closedAt: at, closedBy: "SOURCE" });
const page: InboxPage = { threads: [ask, done, fresh, alert, quiet, working, closed], cursor: "older", summary: { operator: 1, unseen: 3, working: 1, tabs: { needs: 1, done: 1, updates: 3, requests: 1 } }, badge: 5, attention: true };
const titles = () => [...document.querySelectorAll("article.inbox-thread")].map((card) => card.getAttribute("aria-label"));
const openTab = (name: RegExp) => fireEvent.click(within(screen.getByRole("group", { name: "Inbox tabs" })).getByRole("button", { name }));

function Harness() {
  const [opened, setOpened] = useState(0);
  const [plan, setPlan] = useState("");
  useInboxView(() => setOpened((value) => value + 1));
  return <><output aria-label="opened">{opened}</output><output aria-label="plan">{plan}</output>
    <NousInbox active focus={null} sources={{ decisions: [], needs: [], renderDecision: () => null, onOpenPlan: setPlan }} /></>;
}

beforeEach(() => {
  // The chosen tab is kept in the runtime's localStorage (nous-ui-state), which the test setup empties before each test.
  installSpaceRuntime(liveRuntime);
  resetNotificationStore("user:me");
  apiMock.inbox.mockImplementation(async ({ cursor, q }: { cursor?: string; q?: string } = {}) =>
    q ? { ...page, threads: [fresh], cursor: null } : cursor ? { ...page, threads: [thread("older", { title: "Older report", closedAt: at })], cursor: null } : page);
  apiMock.inboxThread.mockResolvedValue({ thread: working, events: [event("r", { type: "REQUEST", title: "Build the inbox" }), event("n", { type: "NOTE", title: "Checked the queue" })] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Nous › «Εισερχόμενα» v2 in four tabs (plans clipboard:aE7U1J_gU9OV step 3, clipboard:JD8EbQgQdRls step 2)", () => {
  it("opens the first tab with something, shows each Thread under its tab with the server's counter and keeps the chosen tab", async () => {
    const view = render(<Harness />);
    const card = await screen.findByRole("article", { name: "Pick a colour" });
    const tabs = screen.getByRole("group", { name: "Inbox tabs" });
    expect(within(tabs).getAllByRole("button").map((chip) => [chip.textContent, chip.getAttribute("aria-pressed")])).toEqual([["Needs you1", "true"], ["Done1", "false"], ["Updates3", "false"], ["Requests1", "false"], ["Archived", "false"]]);
    expect(titles()).toEqual(["Pick a colour"]);
    // The closed page this view asks for is the Archive, every tab's.
    expect(apiMock.inbox).toHaveBeenCalledWith({});
    expect(within(card).queryByRole("button", { name: "Done" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "red" }));
    await waitFor(() => expect(apiMock.actInbox).toHaveBeenCalledWith("inbox_thread:ask", { verb: "ANSWER", askId: "notification:q", option: "red" }));

    // Done: the request, its summary and what was checked, where it is live and its ticket, seen with «Seen it».
    openTab(/^Done/);
    expect(titles()).toEqual(["Rename the tab"]);
    const report = screen.getByRole("article", { name: "Rename the tab" });
    expect(report.querySelector(".inbox-thread-report")!.textContent).toBe("Renamed\nChecked: the tab reads Updates on dev");
    expect(report.querySelector(".inbox-thread-meta")!.textContent).toContain("Dev");
    fireEvent.click(within(report).getByRole("link", { name: "q-1" }));
    expect(await within(report).findByText("q-1 · Live")).toBeTruthy();
    fireEvent.click(within(report).getByRole("button", { name: "Seen it" }));
    await waitFor(() => expect(apiMock.actInbox).toHaveBeenCalledWith("inbox_thread:done", { verb: "DONE" }));

    // Updates: the request's news first, then every counted update or alert, then the uncounted (INFO) alerts in one fold; «Seen all» leaves Done alone.
    // Operator 26/11 20:38 BKK: the chip (3) is the unseen cards, never one card and the rest folded; 27/11: a read one leaves for the Archive.
    openTab(/^Updates/);
    expect(titles()).toEqual(["Build the inbox", "Tests passed", "Deploy failed", "Mail from a shop"]);
    const top = [...document.querySelectorAll(".nous-inbox > article.inbox-thread")].map((card) => card.getAttribute("aria-label"));
    expect(top).toHaveLength(page.summary.tabs!.updates);
    const fold = document.querySelector("details.nous-inbox-alerts")!;
    expect(fold.querySelector("summary")!.textContent).toBe("Alerts from copilots and the system (1)");
    expect(within(fold as HTMLElement).getByRole("article", { name: "Mail from a shop" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("article", { name: "Tests passed" })).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(apiMock.actInbox).toHaveBeenCalledWith("inbox_thread:fresh", { verb: "DONE" }));
    fireEvent.click(screen.getByRole("button", { name: "Seen all" }));
    await waitFor(() => expect(apiMock.inboxDoneAll).toHaveBeenCalledWith(["inbox_thread:working", "inbox_thread:fresh", "inbox_thread:alert", "inbox_thread:quiet"]));
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();

    // Archived: every closed Thread whatever its tab, paged back with Load earlier.
    openTab(/^Archived/);
    expect(titles()).toEqual(["Old report"]);
    fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    expect(await screen.findByRole("article", { name: "Older report" })).toBeTruthy();
    expect(apiMock.inbox).toHaveBeenCalledWith({ cursor: "older" });

    // Requests: the work in progress with its last progress line (seen, never closed, from here too), then every request.
    openTab(/^Requests/);
    expect(titles()).toEqual(["Build the inbox"]);
    const request = screen.getByRole("article", { name: "Build the inbox" });
    expect(request.querySelector(".inbox-thread-now")!.textContent).toBe("Step 2 · 40%: Step 2 is live");
    expect(within(request).queryByRole("button", { name: "Done" })).toBeNull();
    expect(within(request).getByRole("button", { name: "Seen it" })).toBeTruthy();
    expect(within(request).getByRole("button", { name: "Not relevant" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "All requests" })).toBeTruthy();
    await waitFor(() => expect(apiMock.nousRequests).toHaveBeenCalled());

    // The choice is kept on this device: the Inbox opens on it again.
    view.unmount();
    render(<Harness />);
    await screen.findByRole("article", { name: "Build the inbox" });
    expect(within(screen.getByRole("group", { name: "Inbox tabs" })).getByRole("button", { name: /^Requests/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("opens on Needs you with nothing anywhere and says so", async () => {
    apiMock.inbox.mockResolvedValue({ threads: [closed], cursor: null, summary: { operator: 0, unseen: 0, working: 0, tabs: { needs: 0, done: 0, updates: 0, requests: 0 } }, badge: 0, attention: false });
    render(<Harness />);
    expect(await screen.findByText("Nothing waits for you")).toBeTruthy();
    expect(titles()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Seen all" })).toBeNull();
  });

  it("confirms Not relevant before cancelling an open ask, opens a timeline with Nous's notes folded and searches every Thread", async () => {
    render(<Harness />);
    const card = await screen.findByRole("article", { name: "Pick a colour" });
    fireEvent.click(within(card).getByRole("button", { name: "Not relevant" }));
    expect(apiMock.actInbox).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole("alertdialog", { hidden: true })).getByRole("button", { name: "Not relevant", hidden: true }));
    await waitFor(() => expect(apiMock.actInbox).toHaveBeenCalledWith("inbox_thread:ask", { verb: "DISMISS" }));

    openTab(/^Requests/);
    const plan = screen.getByRole("article", { name: "Build the inbox" });
    fireEvent.click(within(plan).getByRole("button", { name: "Open plan" }));
    expect(screen.getByLabelText("plan").textContent).toBe("clipboard:p1");
    fireEvent.click(within(plan).getByRole("button", { expanded: false }));
    await within(plan).findByText("Nous notes (1)");
    expect(within(plan).getByText("Request", { exact: false })).toBeTruthy();

    fireEvent.change(screen.getAllByRole("searchbox")[0]!, { target: { value: "tests" } });
    await waitFor(() => expect(apiMock.inbox).toHaveBeenCalledWith({ q: "tests" }));
    await waitFor(() => expect(titles()).toEqual(["Tests passed"]));
    expect(screen.queryByRole("group", { name: "Inbox tabs" })).toBeNull();
  });

  it("shows «Seen all» on Done when Done threads exist, marks only Done IDs, and hides it when Done is empty", async () => {
    const done2 = thread("done2", { title: "Fix the footer", unseen: true, tab: "DONE", news: "REPORT", report: "Fixed on dev" });
    apiMock.inbox.mockResolvedValue({
      ...page,
      threads: [ask, done, done2, fresh, alert, working, closed],
      summary: { operator: 1, unseen: 4, working: 1, tabs: { needs: 1, done: 2, updates: 3, requests: 1 } },
      badge: 6
    });
    render(<Harness />);
    await screen.findByRole("article", { name: "Pick a colour" });
    openTab(/^Done/);
    expect(titles()).toEqual(["Rename the tab", "Fix the footer"]);
    fireEvent.click(screen.getByRole("button", { name: "Seen all" }));
    await waitFor(() => expect(apiMock.inboxDoneAll).toHaveBeenCalledWith(["inbox_thread:done", "inbox_thread:done2"]));

    // Updates «Seen all» still marks only Updates + Alerts + request news, leaving Done alone.
    apiMock.inboxDoneAll.mockClear();
    openTab(/^Updates/);
    fireEvent.click(screen.getByRole("button", { name: "Seen all" }));
    await waitFor(() => expect(apiMock.inboxDoneAll).toHaveBeenCalledWith(["inbox_thread:working", "inbox_thread:fresh", "inbox_thread:alert"]));

    // When Done is empty, «Seen all» is hidden.
    cleanup();
    apiMock.inbox.mockResolvedValue({ ...page, threads: [fresh, closed], summary: { operator: 0, unseen: 1, working: 0, tabs: { needs: 0, done: 0, updates: 1, requests: 0 } }, badge: 1, attention: false });
    render(<Harness />);
    await screen.findByRole("article", { name: "Tests passed" });
    openTab(/^Done/);
    expect(screen.getByText("You’re up to date")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Seen all" })).toBeNull();
  });

  it("shows an ask's files as chips when the dock has not loaded its decision (nous_msg:acb1aa48)", async () => {
    const files = thread("files", { title: "Approve the outreach", waitingFor: "OPERATOR", tab: "NEEDS", openAsks: [event("d", { type: "ASK", title: "Send the 12 notes?", ref: "nous_decision:d",
      ask: { open: true, forOperator: true, kind: "APPROVAL", options: [], files: ["/home/me/agent-workspace/outreach-12-FINAL.md"] } })] });
    apiMock.inbox.mockResolvedValue({ ...page, threads: [files], summary: { ...page.summary, tabs: { needs: 1, done: 0, updates: 0, requests: 0 } } });
    render(<Harness />);
    const card = await screen.findByRole("article", { name: "Approve the outreach" });
    expect(within(card).getByRole("button", { name: "outreach-12-FINAL.md" }).getAttribute("data-file-ref")).toBe("/home/me/agent-workspace/outreach-12-FINAL.md");
  });

  it("opens when the bell asks for the inbox", async () => {
    render(<Harness />);
    requestInboxView();
    await waitFor(() => expect(screen.getByLabelText("opened").textContent).toBe("1"));
  });
});

describe("Every tab: sent time and sort (operator 28/11)", () => {
  it("shows when each request was sent and its latest update, and sorts by the chosen order, kept", async () => {
    const request = (id: string, createdAt: string, lastEventAt: string) => thread(id, { waitingFor: "NOUS", openRequest: true, tab: "REQUESTS", createdAt, lastEventAt });
    const a = request("a", "2026-11-15T08:00:00.000Z", "2026-11-15T12:00:00.000Z");
    const b = request("b", "2026-11-15T09:00:00.000Z", "2026-11-15T09:00:00.000Z");
    const c = request("c", "2026-11-15T10:00:00.000Z", "2026-11-15T11:00:00.000Z");
    apiMock.inbox.mockResolvedValue({ ...page, threads: [a, c, b], summary: { ...page.summary, tabs: { needs: 0, done: 0, updates: 0, requests: 3 } } });
    const view = render(<Harness />);
    await screen.findByRole("article", { name: "a" });
    expect(titles()).toEqual(["c", "b", "a"]);
    const meta = (id: string) => screen.getByRole("article", { name: id }).querySelector(".inbox-thread-meta")!;
    expect([...meta("a").querySelectorAll("time")].map((time) => time.getAttribute("dateTime"))).toEqual([a.createdAt, a.lastEventAt]);
    expect(meta("b").querySelectorAll("time")).toHaveLength(1);
    const sort = screen.getByRole("combobox", { name: "Sort" });
    for (const [value, order] of [["OLDEST", ["a", "b", "c"]], ["UPDATED", ["a", "c", "b"]], ["QUIET", ["b", "c", "a"]]] as const) {
      fireEvent.change(sort, { target: { value } });
      expect(titles()).toEqual(order);
    }
    view.unmount();
    render(<Harness />);
    await screen.findByRole("article", { name: "a" });
    expect(titles()).toEqual(["b", "c", "a"]);
    // Every tab sorts by the same choice: Done here.
    view.unmount(); cleanup();
    const d = (id: string, createdAt: string) => thread(id, { unseen: true, tab: "DONE", news: "REPORT", createdAt, lastEventAt: createdAt });
    apiMock.inbox.mockResolvedValue({ ...page, threads: [d("x", "2026-11-15T08:00:00.000Z"), d("y", "2026-11-15T09:00:00.000Z")], summary: { ...page.summary, tabs: { needs: 0, done: 2, updates: 0, requests: 0 } } });
    render(<Harness />);
    await screen.findByRole("article", { name: "x" });
    expect(titles()).toEqual(["x", "y"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "NEWEST" } });
    expect(titles()).toEqual(["y", "x"]);
  });
});
