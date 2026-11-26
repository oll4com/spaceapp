import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxEvent, InboxPage, InboxThreadView } from "@space/contracts";
import { NousInbox } from "../src/features/nous/NousInbox.js";
import { resetNotificationStore } from "../src/features/notifications/notification-store.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";

const apiMock = vi.hoisted(() => ({
  inbox: vi.fn(), inboxThread: vi.fn(async () => ({ thread: null, events: [] })), actInbox: vi.fn(),
  notificationsPending: vi.fn(async () => ({ total: 0, bySource: {}, byRoom: {}, byPane: {}, latest: [] })), notifications: vi.fn(async () => ({ notifications: [] })),
  nousPaneBoard: vi.fn(async () => ({ board: { rooms: [], settings: {} } })), nousRequests: vi.fn(async () => ({ requests: [], hasMore: false, counts: {} })),
  // Pane-report text renders AgentFileMentions, which reads the Agent Files index.
  artifacts: vi.fn(async () => ({ data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } }))
}));
vi.mock("../src/api.js", () => ({ api: apiMock }));

const at = "2026-11-16T05:00:00.000Z";
const thread = (id: string, extra: Partial<InboxThreadView>): InboxThreadView => ({ id: `inbox_thread:${id}`, ownerUserId: "user:me", key: id, title: id, origin: "NOUS", originLabel: "Nous",
  waitingFor: "NOBODY", unseen: false, closedAt: null, closedBy: null, priority: "ATTENTION", now: "", progress: null, refs: {}, createdAt: at, lastEventAt: at, openAsks: [], ...extra });
const body = "Gateway key for spaceapp-hz is missing (nous_msg:ebfdb6b0).\nFACT mktmem_8f2a1c9d timing rule: send between 09:00 and 11:00.";
const ask: InboxEvent = { id: "inbox_event:q", threadId: "inbox_thread:card", at, type: "ASK", actor: "nous", title: "Create the key?", body, priority: "ATTENTION", ref: "notification:q",
  ask: { open: true, forOperator: true, kind: "QUESTION", options: ["yes", "no"], recommended: "yes" } };
const card = thread("card", { title: "Gateway key", waitingFor: "OPERATOR", openAsks: [ask] });
const mine = thread("mine", { title: "Build the inbox", waitingFor: "NOUS", progress: 40 });
const reviews = [1, 2].map((n) => thread(`review${n}`, { title: `Review ${n}`, originLabel: "Marketing Copilot", waitingFor: "NOUS", now: `LinkedIn note ${n}`, held: true }));
const page: InboxPage = { threads: [card, mine, ...reviews], cursor: null, summary: { operator: 1, unseen: 0, working: 1, held: 2, tabs: { needs: 1, done: 0, updates: 0, requests: 1 } }, badge: 1, attention: true };

// The chosen tab lives in the runtime's localStorage, which the test setup empties before each test.
beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Nous › Inbox: held items and short cards (plan clipboard:LkwKdOOh2mXK step 1, operator 16/11 12:05)", () => {
  it("folds what Nous handles into one line each under Requests, counts only the operator's, and shows an ask as one plain line until Details", async () => {
    resetNotificationStore("user:me");
    apiMock.inbox.mockResolvedValue(page);
    render(<NousInbox active focus={null} sources={{ decisions: [], needs: [], renderDecision: () => null, onOpenPlan: () => undefined }} />);
    const cardNode = await screen.findByRole("article", { name: "Gateway key" });

    const titles = () => [...document.querySelectorAll("article.inbox-thread")].map((node) => node.getAttribute("aria-label"));
    expect(titles()).toEqual(["Gateway key"]);
    const askBody = cardNode.querySelector(".inbox-ask-body")!;
    expect(askBody.textContent).toBe("Gateway key for spaceapp-hz is missing.");
    fireEvent.click(within(cardNode).getByRole("button", { name: "Details" }));
    expect(askBody.textContent).toContain("timing rule");
    expect(within(cardNode).getByRole("button", { name: "Less" })).toBeTruthy();

    // The Requests counter is the one request in progress; the two Nous holds are lines in a fold, never cards.
    fireEvent.click(within(screen.getByRole("group", { name: "Inbox tabs" })).getByRole("button", { name: /^Requests\s*1$/ }));
    expect(titles()).toEqual(["Build the inbox"]);
    const held = document.querySelector("details.nous-inbox-held")!;
    expect(held.querySelector("summary")!.textContent).toBe("Nous handles these (2)");
    expect([...held.querySelectorAll("li")].map((line) => line.textContent)).toEqual(["Marketing Copilot LinkedIn note 1", "Marketing Copilot LinkedIn note 2"]);
  });

  it("plan LkwKdOOh2mXK step 7: a card names its open ask once (no «now» line over the ask); a card without one keeps its «now»", async () => {
    resetNotificationStore("user:me");
    apiMock.inbox.mockResolvedValue({ ...page, threads: [{ ...card, now: ask.title }, { ...mine, now: "Step 3 of 5" }] });
    render(<NousInbox active focus={null} sources={{ decisions: [], needs: [], renderDecision: () => null, onOpenPlan: () => undefined }} />);
    const cardNode = await screen.findByRole("article", { name: "Gateway key" });
    expect(within(cardNode).getAllByText("Create the key?")).toHaveLength(1);
    expect(cardNode.querySelector(".inbox-thread-now")).toBeNull();
    fireEvent.click(within(screen.getByRole("group", { name: "Inbox tabs" })).getByRole("button", { name: /^Requests/ }));
    expect(screen.getByRole("article", { name: "Build the inbox" }).querySelector(".inbox-thread-now")!.textContent).toBe("Step 3 of 5");
  });
});
