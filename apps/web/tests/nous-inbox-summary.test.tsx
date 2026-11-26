import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxPage, InboxThreadView } from "@space/contracts";
import { NousInbox } from "../src/features/nous/NousInbox.js";
import { resetNotificationStore } from "../src/features/notifications/notification-store.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";

const apiMock = vi.hoisted(() => ({
  inbox: vi.fn(), inboxThread: vi.fn(async () => ({ thread: null, events: [] })), actInbox: vi.fn(),
  notificationsPending: vi.fn(async () => ({ total: 0, bySource: {}, byRoom: {}, byPane: {}, latest: [] })), notifications: vi.fn(async () => ({ notifications: [] })),
  nousPaneBoard: vi.fn(async () => ({ board: { rooms: [], settings: {} } })),
  // Pane-report text renders AgentFileMentions, which reads the Agent Files index.
  artifacts: vi.fn(async () => ({ data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } }))
}));
vi.mock("../src/api.js", () => ({ api: apiMock }));

const at = "2026-11-16T05:00:00.000Z";
const thread = (id: string, extra: Partial<InboxThreadView>): InboxThreadView => ({ id: `inbox_thread:${id}`, ownerUserId: "user:me", key: id, title: id, origin: "NOUS", originLabel: "Nous",
  waitingFor: "NOBODY", unseen: false, closedAt: null, closedBy: null, priority: "ATTENTION", now: "", progress: null, refs: {}, createdAt: at, lastEventAt: at, openAsks: [], ...extra });
const show = async (page: InboxPage) => {
  resetNotificationStore("user:me");
  apiMock.inbox.mockResolvedValue(page);
  render(<NousInbox active focus={null} sources={{ decisions: [], needs: [], renderDecision: () => null, onOpenPlan: () => undefined }} />);
  await screen.findByRole("article", { name: page.threads[0]!.title });
};

beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Nous › Inbox tabs: no dead controls (plan clipboard:LkwKdOOh2mXK step 9, tabs: plan clipboard:JD8EbQgQdRls)", () => {
  it("shows a counter only on a tab that holds something, and «Seen all» only when Done or Updates has unread items", async () => {
    await show({ threads: [thread("ask", { title: "Pick a colour", waitingFor: "OPERATOR" }), thread("old", { title: "Old report", closedAt: at, closedBy: "SOURCE" })],
      cursor: null, summary: { operator: 1, unseen: 0, working: 0, held: 0, tabs: { needs: 1, done: 0, updates: 0, requests: 0 } }, badge: 1, attention: true });
    const tabs = within(screen.getByRole("group", { name: "Inbox tabs" })).getAllByRole("button");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Needs you1", "Done", "Updates", "Requests"]);
    fireEvent.click(tabs[1]!);
    expect(screen.getByText("You’re up to date")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Seen all" })).toBeNull();
    fireEvent.click(tabs[2]!);
    expect(await screen.findByRole("article", { name: "Old report" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Seen all" })).toBeNull();
  });
});
