import { afterEach, describe, expect, it, vi } from "vitest";
import { eventSchema } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { InMemorySpaceStore, SpaceEventBus, makeSpaceId } from "@space/runtime";
import { browserHandoffNotificationKey, browserHandoffTarget, browserHandoffTitle, settleBrowserHandoffNotifications, startBrowserHandoffNotifications } from "../src/notifications/browser-handoff.js";
import { createNotificationService } from "../src/notifications/service.js";
import { renderDailyReview } from "../src/nous/daily-review.js";

const owner = "user:operator";
const goNow = (question: string) => ({ question, options: ["Go now"], recommended: "Go now", answer: { kind: "PANE" } });
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const store = new InMemorySpaceStore();
  const repository = new InMemorySpaceNotificationsRepository();
  const notifications = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
    recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }) });
  const room = store.createRoom({ name: "Handoffs", initialPaneCount: 0 });
  /** A browser pane whose agent asked for a handoff, and the notification the producer raised for it. */
  async function handoffPane(title: string, ttlSeconds = 1800) {
    const pane = store.createPane({ roomId: room.id, title, mode: "BROWSER" });
    const sessionId = `browser_session:${pane.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    store.createPaneBrowserSession({ sessionId, paneId: pane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1, profileId: `profile:${pane.id}`,
      profilePath: `/tmp/${pane.id}`, viewport: "desktop", targetUrl: "https://example.test/", currentUrl: "https://example.test/", title, status: "READY", isActive: true });
    const handoff = store.createBrowserHandoffRequest({ sessionId, paneId: pane.id, roomId: room.id, requestedByType: "AGENT", requestedById: "cli:cli_session:test",
      reason: "CAPTCHA: solve it", ttlSeconds });
    const { notification } = await repository.raise({ ownerUserId: owner, roomId: room.id, paneId: pane.id, source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED",
      severity: "ATTENTION", title: "The browser needs you", body: "", link: { roomId: room.id, paneId: pane.id }, dedupeKey: browserHandoffNotificationKey(pane.id), payload: {}, telegram: null });
    return { pane, handoff, notification };
  }
  const statusOf = async (id: string) => (await repository.get(owner, id))?.status;
  store.upsertUser({ id: owner, email: "operator@example.test", role: "ADMIN" });
  /** The operator takes control and gives it back: the handoff is COMPLETED. */
  function complete({ pane, handoff }: { pane: { id: string }; handoff: { handoffRequestId: string; sessionId: string } }) {
    const lease = store.createBrowserControlLease({ leaseId: `browser_lease:${handoff.handoffRequestId.slice(-8)}`, sessionId: handoff.sessionId, paneId: pane.id, roomId: room.id,
      holderType: "OPERATOR", holderId: owner, reason: "Direct browser interaction", ttlSeconds: 60 });
    store.updateBrowserHandoffRequest(handoff.handoffRequestId, { status: "ACCEPTED", operatorUserId: owner, operatorEmail: "operator@example.test", operatorRole: "ADMIN", controlLeaseId: lease.leaseId });
    store.updateBrowserHandoffRequest(handoff.handoffRequestId, { status: "COMPLETED" });
  }
  return { store, repository, notifications, room, handoffPane, statusOf, complete };
}

describe("browser handoff notifications", () => {
  it("records a new handoff on the same pane and site within 30 minutes without an alert, and counts handoffs in the daily review (R20-asks-1)", async () => {
    // 30/10: 50 handoff notices reached the operator, 1 acknowledged.
    const { store, repository, notifications, room } = setup();
    const eventBus = new SpaceEventBus();
    const raise = vi.spyOn(notifications, "raise");
    const stop = startBrowserHandoffNotifications({ store, notifications, eventBus, roomOwner: async () => owner, log: { warn: () => {} } });
    const pane = store.createPane({ roomId: room.id, title: "Job", mode: "BROWSER" });
    store.createPaneBrowserSession({ sessionId: "browser_session:job", paneId: pane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1, profileId: "profile:job",
      profilePath: "/tmp/job", viewport: "desktop", targetUrl: "https://career5.successfactors.eu/", currentUrl: "https://career5.successfactors.eu/", title: "Allianz", status: "READY", isActive: true });
    const kate = store.createPane({ roomId: room.id, title: "Kate", mode: "TERMINAL", terminalRuntimeId: "cli:gemini" });
    const kateCli = store.createPaneCliSession({ paneId: kate.id, roomId: room.id, runtimeId: "cli:gemini", providerId: "gemini", agentId: "gemini", status: "RUNNING", purpose: "NORMAL" });
    const ask = async (reason: string, requestedById = "cli:cli_session:test", taken = false) => {
      const handoff = store.createBrowserHandoffRequest({ sessionId: "browser_session:job", paneId: pane.id, roomId: room.id, requestedByType: "AGENT", requestedById, reason, ttlSeconds: 1800 });
      eventBus.publish(store.listEvents(room.id).find((event) => event.traceId === handoff.handoffRequestId)!);
      await vi.waitFor(() => expect(raise.mock.calls.length).toBeGreaterThan(0));
      const call = raise.mock.calls.at(-1)!;
      raise.mockClear();
      // Taken: the operator went there and gave the browser back; otherwise the agent cancelled it.
      if (taken) store.updateBrowserHandoffRequest(handoff.handoffRequestId, { status: "ACCEPTED", operatorUserId: owner, operatorEmail: "operator@example.test", operatorRole: "ADMIN" });
      store.updateBrowserHandoffRequest(handoff.handoffRequestId, { status: taken ? "COMPLETED" : "CANCELLED" });
      const open = (await repository.list(owner, { status: "ALL", limit: 1 }))[0]!;
      await repository.setStatus(owner, open.id, "RESOLVED");
      return { payload: call[0].payload, options: call[1] };
    };
    expect(await ask("LOGIN: career5.successfactors.eu: sign in")).toEqual({ payload: { site: "career5.successfactors.eu", ask: goNow("Sign in to career5.successfactors.eu") }, options: {} });
    expect(await ask("CAPTCHA: career5.successfactors.eu: tick the box")).toEqual({ payload: { site: "career5.successfactors.eu", repeat: true, ask: goNow("Solve the check on career5.successfactors.eu") }, options: { held: true } });
    // 6/11 PayPal: a one-time code is never held (it expires in minutes), and its card takes the code for the CLI that asked.
    expect(await ask("MFA: career5.successfactors.eu: the SMS code", `cli:${kateCli.sessionId}`)).toEqual({ payload: { site: "career5.successfactors.eu", codePane: kate.id,
      ask: { question: "Enter the sign-in code on career5.successfactors.eu", code: true, answer: { kind: "PANE" } } }, options: {} });
    expect((await ask("LOGIN: www.workday.com: sign in", undefined, true)).options).toEqual({});
    // nous_msg:42ec5f5c (6/11): after the operator took Leo's PayPal sign-in, Kate (another CLI on the same browser) asked for the PayPal code: a new ask, not a repeat.
    expect(await ask("LOGIN: www.workday.com: enter the code")).toEqual({ payload: { site: "www.workday.com", ask: goNow("Sign in to www.workday.com") }, options: {} });
    const handoffs = await repository.list(owner, { status: "ALL", source: "BROWSER_HANDOFF", limit: 10 });
    const since = new Date(Date.now() - 60_000).toISOString();
    expect(renderDailyReview({ facts: [], decisions: [], handoffs, since, day: "2026-10-31", hour: 3 }))
      .toContain("- Browser handoffs asked of the operator: 5 (1 repeats on the same pane and site, held without an alert); acknowledged 0");
    stop();
  });


  it("resolve when the handoff is completed, cancelled, timed out or its pane closed or deleted, and stay while it is active", async () => {
    const start = Date.parse("2026-10-17T06:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const { store, repository, notifications, handoffPane, statusOf, complete } = setup();
    const active = await handoffPane("Active");
    const completed = await handoffPane("Completed");
    const cancelled = await handoffPane("Cancelled");
    const timedOut = await handoffPane("Timed out", 60);
    const closed = await handoffPane("Closed");
    const read = await handoffPane("Read");
    complete(completed);
    store.updateBrowserHandoffRequest(cancelled.handoff.handoffRequestId, { status: "CANCELLED" });
    // A deleted pane leaves pane_id null; the dedupe key still names it.
    const { notification: deleted } = await repository.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED",
      severity: "ATTENTION", title: "The browser needs you", body: "", link: {}, dedupeKey: browserHandoffNotificationKey("pane:deleted01"), payload: {}, telegram: null });
    store.updatePane(closed.pane.id, { isClosed: true, status: "CLOSED" });
    complete(read);
    await repository.setStatus(owner, read.notification.id, "READ");
    // The Job Copilot agent logs the same handoff as its own card; the settle ends it with the browser's.
    const { notification: jobCard } = await repository.raise({ ownerUserId: owner, roomId: completed.pane.roomId, paneId: completed.pane.id, source: "JOB_COPILOT", kind: "HANDOFF_REQUESTED",
      severity: "ATTENTION", title: "Upwork needs you", body: "", link: {}, dedupeKey: `job-apply:handoff:${completed.pane.id}`, payload: {}, telegram: null });
    vi.setSystemTime(start + 61_000);

    // One pane at a time (a closed pane's event) leaves the others for the sweep.
    expect(await settleBrowserHandoffNotifications({ store, notifications }, closed.pane.id)).toBe(1);
    expect(await statusOf(completed.notification.id)).toBe("OPEN");
    expect(await settleBrowserHandoffNotifications({ store, notifications })).toBe(5);
    for (const ended of [completed, cancelled, timedOut, closed, read, { notification: deleted }, { notification: jobCard }]) expect(await statusOf(ended.notification.id)).toBe("RESOLVED");
    expect(store.getBrowserHandoffRequest(timedOut.handoff.handoffRequestId)?.status).toBe("EXPIRED");
    expect(await statusOf(active.notification.id)).toBe("OPEN");
    // Resolved, never deleted: the Notification Center keeps them.
    expect((await repository.list(owner, { status: "ALL", limit: 50 })).length).toBe(8);
    expect(await settleBrowserHandoffNotifications({ store, notifications })).toBe(0);
  });

  it("titles the notification with the agent's reason (site and what to click) and keeps room and pane", async () => {
    expect(browserHandoffTitle("CAPTCHA: Upwork: Cloudflare check, tick the box\nmore")).toBe("Upwork: Cloudflare check, tick the box");
    expect(browserHandoffTitle(null)).toBe("The browser needs you");
    expect(browserHandoffTitle("LOGIN: ")).toBe("The browser needs you");
    expect(browserHandoffTitle(`CAPTCHA: ${"x".repeat(250)}`)).toHaveLength(200);
    const { store, repository, notifications, room } = setup();
    const eventBus = new SpaceEventBus();
    const stop = startBrowserHandoffNotifications({ store, notifications, eventBus, roomOwner: async () => owner, log: { warn: () => {} } });
    const pane = store.createPane({ roomId: room.id, title: "Freelance", mode: "BROWSER" });
    store.createPaneBrowserSession({ sessionId: "browser_session:fl", paneId: pane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1, profileId: "profile:fl",
      profilePath: "/tmp/fl", viewport: "desktop", targetUrl: "https://www.upwork.com/", currentUrl: "https://www.upwork.com/", title: "Upwork", status: "READY", isActive: true });
    const handoff = store.createBrowserHandoffRequest({ sessionId: "browser_session:fl", paneId: pane.id, roomId: room.id, requestedByType: "AGENT",
      requestedById: "cli:cli_session:test", reason: "CAPTCHA: Upwork: Cloudflare check, tick the box", ttlSeconds: 1800 });
    eventBus.publish(store.listEvents(room.id).find((event) => event.traceId === handoff.handoffRequestId)!);
    await vi.waitFor(async () => expect((await repository.list(owner, { status: "ALL", limit: 5 }))[0]).toMatchObject({
      title: "Upwork: Cloudflare check, tick the box", body: "CAPTCHA: Upwork: Cloudflare check, tick the box", roomId: room.id, paneId: pane.id,
      link: { roomId: room.id, paneId: pane.id, target: "url:https://www.upwork.com/" }, payload: { ask: goNow("Solve the check on upwork.com") } }));
    // A closed pane needs nobody: a CLI's needs-you card and Nous's card for it resolve at once (Needs you, operator request 2026-10-24).
    const cards = await Promise.all([`agent:needs-you:${pane.id}`, `nous:pane:${pane.id}`].map((dedupeKey) => repository.raise({ ownerUserId: owner, roomId: room.id, paneId: pane.id,
      source: dedupeKey.startsWith("agent") ? "AGENT" : "NOUS", kind: dedupeKey.startsWith("agent") ? "NEEDS_YOU" : "NEEDS_HANDS", severity: "ATTENTION", title: "Freelance needs you", body: "",
      link: {}, dedupeKey, payload: {}, telegram: null })));
    store.updatePane(pane.id, { isClosed: true, status: "CLOSED" });
    eventBus.publish(eventSchema.parse({ id: makeSpaceId("event"), roomId: room.id, paneId: pane.id, turnId: null, workflowId: null, traceId: "pane-closed", type: "PANE_CLOSED",
      message: "closed", payload: {}, createdAt: new Date().toISOString() }));
    await vi.waitFor(async () => { for (const { notification } of cards) expect((await repository.get(owner, notification.id))?.status).toBe("RESOLVED"); });
    stop();
  });

  it("points Go now at the handoff's own page and asks one short question, the agent's steps behind Details (operator nous_msg:4b36b80e)", async () => {
    // 6/11: Finn's Google sign-in arrived as a list of steps while the pane showed remoterocketship.com, and Go now had no page to go to.
    const { store, repository, notifications, room } = setup();
    const eventBus = new SpaceEventBus();
    const stop = startBrowserHandoffNotifications({ store, notifications, eventBus, roomOwner: async () => owner, log: { warn: () => {} } });
    const pane = store.createPane({ roomId: room.id, title: "Finn", mode: "BROWSER" });
    const google = "https://accounts.google.com/v3/signin/identifier?continue=x";
    const pages = [{ pageId: "page:rocket", kind: "PAGE" as const, url: "https://www.remoterocketship.com/jobs", title: "Jobs", isActive: true, openerPageId: null },
      { pageId: "page:google", kind: "POPUP" as const, url: google, title: "Sign in", isActive: false, openerPageId: "page:rocket" }];
    store.createPaneBrowserSession({ sessionId: "browser_session:finn", paneId: pane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1, profileId: "profile:finn",
      profilePath: "/tmp/finn", viewport: "desktop", targetUrl: google, currentUrl: google, title: "Sign in", status: "READY", isActive: true });
    store.updatePaneBrowserSession("browser_session:finn", { pages, activePageId: "page:rocket" });
    const handoff = store.createBrowserHandoffRequest({ sessionId: "browser_session:finn", paneId: pane.id, roomId: room.id, requestedByType: "AGENT", requestedById: "cli:cli_session:test",
      reason: "LOGIN: [site:google.com] Sign in with the operator's account. Page https://accounts.google.com (open in the pane's browser) 1) Pick the account 2) Enter the password 3) Approve on the phone", ttlSeconds: 1800 });
    eventBus.publish(store.listEvents(room.id).find((event) => event.traceId === handoff.handoffRequestId)!);
    await vi.waitFor(async () => expect((await repository.list(owner, { status: "ALL", limit: 5 }))[0]).toMatchObject({
      link: { roomId: room.id, paneId: pane.id, target: "tab:page:google" }, payload: { site: "google.com", ask: goNow("Sign in to google.com") },
      body: "LOGIN: [site:google.com] Sign in with the operator's account. Page https://accounts.google.com (open in the pane's browser)\n1) Pick the account\n2) Enter the password\n3) Approve on the phone" }));
    stop();
    // No open tab of that site: the page itself, as a new tab; without a session the address the reason names; nothing to go to: no target.
    expect(browserHandoffTarget({ currentUrl: "https://www.upwork.com/ab/account-security/login", pages }, null)).toBe("url:https://www.upwork.com/ab/account-security/login");
    expect(browserHandoffTarget({ currentUrl: "https://accounts.google.com/", pages }, null)).toBe("tab:page:google");
    // The page the reason names wins over whatever tab is active: the sign-in popup, not the jobs board behind it.
    const rocket = "https://www.remoterocketship.com/jobs";
    expect(browserHandoffTarget({ currentUrl: rocket, pages }, "LOGIN: [site:google.com] sign in", "google.com")).toBe("tab:page:google");
    expect(browserHandoffTarget({ currentUrl: rocket, pages }, "LOGIN: sign in at https://accounts.google.com/v3/signin/identifier?continue=x")).toBe("tab:page:google");
    expect(browserHandoffTarget({ currentUrl: rocket, pages }, "CAPTCHA: tick the box")).toBe("tab:page:rocket");
    expect(browserHandoffTarget(null, "LOGIN: open https://login.gsis.gr/x. 1) sign in")).toBe("url:https://login.gsis.gr/x");
    expect(browserHandoffTarget({ currentUrl: null, pages: [] }, "CAPTCHA: tick the box")).toBeUndefined();
  });
});
