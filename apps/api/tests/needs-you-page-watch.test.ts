import type { SpaceNotification } from "@space/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_CONTROL_IDLE_RELEASE_MS } from "../src/browser-control-activity.js";
import { boundToBrowser, createNeedsYouPageWatch, NEEDS_YOU_PAGE_WATCH_POLL_MS } from "../src/needs-you-page-watch.js";

const card = (id: string, browserPaneId: string) => ({ id, source: "AGENT", kind: "NEEDS_YOU", paneId: "pane:cli", title: "Enter the Braintrust 2FA code",
  payload: { browserPage: { roomId: "room:1", paneId: browserPaneId } } }) as unknown as SpaceNotification;

function setup(cards = [card("n1", "pane:b"), card("n2", "pane:other")], failAcks = 0) {
  let page = { url: "https://www.braintrust.dev/sign-in/factor-two", title: "Verify" };
  const told: Array<[string, string]> = [];
  const acked: Array<[string, Record<string, unknown> | undefined]> = [];
  const watch = createNeedsYouPageWatch({
    store: { getPane: async (id: string) => ({ id, roomId: "room:1", isClosed: false, paneName: "Braintrust", title: "Browser" }),
      getRoom: async () => ({ ownerUserId: "user:1" }) } as never,
    pages: async () => ({ pages: [{ pageId: "p1", isActive: true, ...page }] as never }),
    notifications: { list: async () => cards, setStatus: async (_owner: string, id: string, _status: string, payload?: Record<string, unknown>) => {
      if (failAcks-- > 0) throw new Error("db down");
      acked.push([id, payload]);
      return null;
    } } as never,
    tell: async (paneId, text) => { told.push([paneId, text]); },
    log: () => undefined
  });
  return { watch, told, acked, go: (url: string, title: string) => { page = { url, title }; } };
}

describe("needs-you page watch", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("wakes the asking CLI and marks the card answered in the page once the page moves after operator input", async () => {
    vi.useFakeTimers();
    const { watch, told, acked, go } = setup();
    watch.use("pane:b");
    await vi.advanceTimersByTimeAsync(NEEDS_YOU_PAGE_WATCH_POLL_MS);
    expect(told).toEqual([]);
    go("https://www.braintrust.dev/app?code=123456", "Braintrust");
    watch.use("pane:b");
    await vi.advanceTimersByTimeAsync(NEEDS_YOU_PAGE_WATCH_POLL_MS);
    expect(told).toHaveLength(1);
    expect(told[0]![0]).toBe("pane:cli");
    expect(told[0]![1]).toContain("The operator acted in Braintrust");
    expect(told[0]![1]).toContain("https://www.braintrust.dev/app?code=%5BREDACTED%5D (\"Braintrust\")");
    expect(told[0]![1]).not.toContain("123456");
    expect(acked.map(([id]) => id)).toEqual(["n1"]);
    expect(acked[0]![1]).toMatchObject({ answer: { routed: "PAGE" } });
    // The watch is over: nothing more is sent.
    go("https://www.braintrust.dev/app/projects", "Projects");
    await vi.advanceTimersByTimeAsync(NEEDS_YOU_PAGE_WATCH_POLL_MS * 2);
    expect(told).toHaveLength(1);
    watch.close();
  });

  it("DEV3D-064: a card whose ACK failed after its prompt went out is not told again at the next read", async () => {
    vi.useFakeTimers();
    const { watch, told, acked, go } = setup(undefined, 1);
    watch.use("pane:b");
    await vi.advanceTimersByTimeAsync(NEEDS_YOU_PAGE_WATCH_POLL_MS);
    go("https://www.braintrust.dev/app", "Braintrust");
    await vi.advanceTimersByTimeAsync(NEEDS_YOU_PAGE_WATCH_POLL_MS * 3);
    expect(told).toHaveLength(1);
    expect(acked.map(([id]) => id)).toEqual(["n1"]);
    watch.close();
  });

  it("stops watching a page that does not move within the idle window", async () => {
    vi.useFakeTimers();
    const { watch, told, go } = setup();
    watch.use("pane:b");
    await vi.advanceTimersByTimeAsync(BROWSER_CONTROL_IDLE_RELEASE_MS + NEEDS_YOU_PAGE_WATCH_POLL_MS);
    go("https://www.braintrust.dev/app", "Braintrust");
    await vi.advanceTimersByTimeAsync(NEEDS_YOU_PAGE_WATCH_POLL_MS * 2);
    expect(told).toEqual([]);
    watch.close();
  });

  it("19/11 REVIEW (Braintrust LOGIN card 01fedf92 on Work/Bob): a hands card raised on the browser itself closes once the page moves, with no agent to wake", async () => {
    vi.useFakeTimers();
    const own = { id: "n3", source: "NOUS", kind: "NEEDS_HANDS", paneId: "pane:b", title: "Sign in to Braintrust", body: "", link: { roomId: "room:1", paneId: "pane:b" },
      payload: { paneMode: "BROWSER" } } as unknown as SpaceNotification;
    const question = { ...own, id: "n4", title: "Which plan?", payload: { paneMode: "BROWSER", ask: { question: "Which plan?", options: ["A", "B"], answer: { kind: "NOUS" } } } } as unknown as SpaceNotification;
    expect(boundToBrowser(own, "pane:b")).toBe(true);
    expect(boundToBrowser(question, "pane:b")).toBe(false);
    expect(boundToBrowser(own, "pane:other")).toBe(false);
    const { watch, told, acked, go } = setup([own, question]);
    watch.use("pane:b");
    await vi.advanceTimersByTimeAsync(NEEDS_YOU_PAGE_WATCH_POLL_MS);
    go("https://app.usebraintrust.com/talent/dashboard/welcome/", "Braintrust");
    await vi.advanceTimersByTimeAsync(NEEDS_YOU_PAGE_WATCH_POLL_MS);
    expect(told).toEqual([]);
    expect(acked.map(([id]) => id)).toEqual(["n3"]);
    watch.close();
  });
});
