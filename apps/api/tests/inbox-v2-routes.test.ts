// «Εισερχόμενα» v2 step 2 (plan clipboard:aE7U1J_gU9OV, spec §10): the Threads read, the verbs through the sources' own paths, and the stream.
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { eventSchema, type InboxPage, type NousDecision, type NousOperatorRequest, type Pane, type Room } from "@space/contracts";
import { InMemoryInboxRepository, InMemorySpaceNotificationsRepository, type PaneReport } from "@space/db";
import { makeSpaceId, SpaceConflictError, SpaceEventBus, SpaceNotFoundError } from "@space/runtime";
import { ZodError } from "zod";
import { createInboxService } from "../src/inbox/service.js";
import { dayIn, registerInboxRoutes, searchDays } from "../src/inbox/routes.js";
import { installPollEtag } from "../src/poll-etag.js";
import { createNotificationService } from "../src/notifications/service.js";
import { registerNousPaneBoardRoutes } from "../src/nous/pane-board-routes.js";
import { parseBody, parseQuery } from "../src/route-parsing.js";

const owner = "user:operator";
const room = { id: "room:alpha0001", name: "Alpha" } as Room;
const pane = { id: "pane:andy0001", paneName: "Andy", title: "Andy", roomId: room.id } as Pane;

describe("the v2 inbox routes", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  async function fixture() {
    const notifications = createNotificationService({ repository: new InMemorySpaceNotificationsRepository(), eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }) });
    const decisions = new Map<string, NousDecision>();
    const repository = new InMemoryInboxRepository();
    const changed = vi.fn();
    const requests: NousOperatorRequest[] = [];
    const inbox = createInboxService({ repository, notifications, requests: { page: async () => ({ requests: [...requests], hasMore: false }) },
      decisions: { list: async (_owner, query) => [...decisions.values()].filter((item) => !query.statuses || query.statuses.includes(item.status)), get: async (_owner, id) => decisions.get(id) ?? null },
      paneOpen: async (id) => id === pane.id, panePlans: async () => new Map(), onChange: changed });
    const settle = (id: string, status: NousDecision["status"], answer: string) => { const item = { ...decisions.get(id)!, status, answer }; decisions.set(id, item); return item; };
    const answerDecision = vi.fn(async (_owner: string, id: string, input: { answer: string }) => {
      if (decisions.get(id)!.status !== "OPEN") throw new SpaceConflictError("This decision was already answered.");
      return settle(id, input.answer === "DECLINE" ? "DECLINED" : "APPROVED", input.answer);
    });
    const dismissDecision = vi.fn(async (_owner: string, id: string) => settle(id, "CANCELLED", "Closed by the operator without an answer"));
    const app = Fastify();
    apps.push(app);
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof SpaceNotFoundError ? 404 : error instanceof SpaceConflictError ? 409 : error instanceof ZodError ? 422
      : (error as { statusCode?: number }).statusCode ?? 500).send({ error: error.message }));
    const board = registerNousPaneBoardRoutes(app, { routeOptions: {}, owner: async () => owner, parseBody, parseQuery, rememberAlways: async () => {}, alwaysKinds: async () => [],
      assertPerson: () => {}, board: { board: vi.fn(), tick: vi.fn() } as never, notifications, pane: async (_owner, paneId) => paneId === pane.id ? { room, pane } : null,
      answerPrompt: vi.fn(), answerCopilot: vi.fn(), send: vi.fn(async () => ({})), sendToPane: vi.fn(async () => ({ ok: true, display: "Sent to Andy", result: "ok" })), decideCopilot: vi.fn() } as never);
    registerInboxRoutes(app, { routeOptions: {}, owner: async () => owner, assertPerson: () => {}, parseBody, parseQuery, repository, inbox, notifications,
      answerNeedsYou: (request, id, input) => board.operatorAnswer(request, id, input), answerDecision, dismissDecision });
    const raise = async (kind: string, extra: { severity?: "INFO" | "ATTENTION" | "URGENT"; payload?: Record<string, unknown>; title?: string } = {}) => {
      const { id } = await notifications.raise({ ownerUserId: owner, roomId: room.id, paneId: pane.id, source: "AGENT", kind, severity: extra.severity ?? "ATTENTION",
        title: extra.title ?? `${kind} card`, body: "Body", link: {}, dedupeKey: `test:${makeSpaceId("k")}`, payload: extra.payload ?? {} });
      await inbox.syncNotification(owner, id);
      return id;
    };
    const decide = async (id: string, title: string) => {
      decisions.set(id, { id, ownerUserId: owner, category: "DIRECTION", title, body: "", options: ["Approve", "Decline"], recommendation: "Approve", refs: {}, action: null,
        status: "OPEN", answer: null, outcome: null, createdAt: new Date().toISOString(), answeredAt: null } as NousDecision);
      await inbox.syncDecision(owner, id);
    };
    const get = async (query = "") => { const reply = await app.inject({ method: "GET", url: `/api/inbox${query}` }); expect(reply.statusCode).toBe(200); return reply.json() as InboxPage; };
    const act = (id: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/inbox/threads/${encodeURIComponent(id)}/act`, payload });
    const threadOf = async (ref: string) => (await repository.threadOfRef(owner, ref))!.id;
    return { app, raise, decide, get, act, threadOf, changed, answerDecision, dismissDecision, notifications, settle, inbox, repository, requests };
  }

  it("lists what waits on the operator first, answers an ask through its card's own path, and pages the closed Threads", async () => {
    const f = await fixture();
    const alert = await f.raise("RUN_FAILED", { severity: "URGENT", title: "Deploy failed" });
    const card = await f.raise("NEEDS_YOU", { payload: { ask: { question: "Red or blue?", options: ["red", "blue"], recommended: "red", answer: { kind: "PANE" } } } });
    await f.decide("nous_decision:d1", "Ship the inbox?");
    const first = await f.get();
    expect(first.summary).toEqual({ operator: 2, unseen: 1, working: 0, held: 0, tabs: { needs: 2, done: 0, updates: 1, requests: 0 } });
    expect(first).toMatchObject({ badge: 3, attention: true, cursor: null });
    expect(first.threads.slice(0, 2).map((thread) => thread.openAsks[0]!.ref).sort()).toEqual([card, "nous_decision:d1"].sort());
    expect(f.changed).toHaveBeenCalledWith(owner, await f.threadOf(card));

    const cardThread = await f.threadOf(card);
    expect((await f.act(cardThread, { verb: "DONE" })).statusCode).toBe(409);
    expect((await f.act(cardThread, { verb: "ANSWER", askId: "notification:other", option: "red" })).statusCode).toBe(409);
    const answered = await f.act(cardThread, { verb: "ANSWER", askId: card, option: "red" });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toMatchObject({ badge: 2, thread: { closedBy: "SOURCE", openAsks: [] } });
    expect((await f.notifications.get(owner, card))!.status).toBe("ACKED");

    const approved = await f.act(await f.threadOf("nous_decision:d1"), { verb: "APPROVE", askId: "nous_decision:d1" });
    expect(approved.json()).toMatchObject({ badge: 1, attention: false });
    expect(f.answerDecision).toHaveBeenCalledWith(owner, "nous_decision:d1", { answer: "APPROVE" });

    const done = await f.act(await f.threadOf(alert), { verb: "DONE" });
    expect(done.json()).toMatchObject({ badge: 0, thread: { closedBy: "OPERATOR" } });
    expect((await f.notifications.get(owner, alert))!.status).toBe("ACKED");

    const page = await f.get("?limit=2");
    expect(page.threads).toHaveLength(2);
    expect(page.cursor).not.toBeNull();
    const next = await f.get(`?limit=2&cursor=${encodeURIComponent(page.cursor!)}`);
    expect(next).toMatchObject({ cursor: null });
    expect(new Set([...page.threads, ...next.threads].map((thread) => thread.id)).size).toBe(3);
    expect((await f.get("?q=deploy")).threads.map((thread) => thread.id)).toEqual([await f.threadOf(alert)]);
    // A date is a day (UTC here), with or without words: today's Threads only.
    const [y, m, d] = new Date().toISOString().slice(0, 10).split("-");
    expect((await f.get(`?q=${encodeURIComponent(`deploy ${d}/${m}/${y}`)}`)).threads.map((thread) => thread.id)).toEqual([await f.threadOf(alert)]);
    expect((await f.get(`?q=${encodeURIComponent(`${d}/${m}/${y}`)}`)).threads).toHaveLength(3);
    expect((await f.get(`?q=${encodeURIComponent("deploy 1/1/2001")}`)).threads).toEqual([]);
  });

  it("reads a date in the search as a day in the operator's zone, day first", () => {
    const now = new Date("2026-11-27T08:00:00Z");
    expect(searchDays("all good closed greenhouse 20/11/2026", now, "Asia/Bangkok")).toEqual({ days: new Set(["2026-11-20"]), words: "all good closed greenhouse" });
    expect(searchDays("20.11 mail 2026-11-21 3-1-26", now, "UTC")).toEqual({ days: new Set(["2026-11-20", "2026-11-21", "2026-01-03"]), words: "mail" });
    expect(searchDays("q-20261127-081859 32/13", now, "UTC")).toEqual({ days: new Set(), words: "q-20261127-081859 32/13" });
    expect(dayIn("2026-11-20T18:30:00Z", "Asia/Bangkok")).toBe("2026-11-21");
  });

  it("16/11 12:05 (plan LkwKdOOh2mXK step 1): a card held for Nous is held, last and out of the header's counts; a line never carries internal ids", async () => {
    const f = await fixture();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const review = await f.raise("REVIEW_REQUESTED", { title: "Marketing Copilot needs you", payload: { heldForNous: { until, allowance: "maySend" },
      ask: { question: "Review", options: ["Approve", "Reject"], answer: { kind: "PANE" } } } });
    const card = await f.raise("NEEDS_YOU", { payload: { ask: { question: "Red or blue?", options: ["red", "blue"], answer: { kind: "PANE" } } } });
    const page = await f.get();
    expect(page.summary).toEqual({ operator: 1, unseen: 0, working: 0, held: 1, tabs: { needs: 1, done: 0, updates: 0, requests: 0 } });
    expect(page.badge).toBe(1);
    expect(page.threads.map((thread) => [thread.openAsks[0]?.ref, thread.held ?? false])).toEqual([[card, false], [review, true]]);
  });

  it("16/11: Approve on an ask answered elsewhere (a stale Thread still held it) closes it as already answered; a bogus ask still fails", async () => {
    const f = await fixture();
    await f.decide("nous_decision:d3", "Buy 20 Connects?");
    const thread = await f.threadOf("nous_decision:d3");
    f.settle("nous_decision:d3", "APPROVED", "APPROVE");
    const first = await f.act(thread, { verb: "APPROVE", askId: "nous_decision:d3" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ display: "Already answered.", badge: 0, thread: { openAsks: [] } });
    // A second tap (another client, a retry) finds the ask in the Thread's history: still done, not an error.
    const again = await f.act(thread, { verb: "APPROVE", askId: "nous_decision:d3" });
    expect(again.json()).toMatchObject({ display: "Already answered.", thread: { openAsks: [] } });
    expect((await f.act(thread, { verb: "APPROVE", askId: "nous_decision:never" })).statusCode).toBe(409);
    expect((await f.get()).threads.filter((item) => item.openAsks.length)).toEqual([]);
  });

  it("16/11: resolve announces the card it closed, not the newest record, so the inbox follows a decision answered anywhere", async () => {
    const eventBus = new SpaceEventBus();
    const published: string[] = [];
    eventBus.subscribe((event) => { if (event.type === "NOTIFICATION_UPDATED") published.push(String(event.payload.notificationId)); });
    const notifications = createNotificationService({ repository: new InMemorySpaceNotificationsRepository(), eventBus, userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }) });
    const raise = (dedupeKey: string) => notifications.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "NOUS", kind: "DECISION_CARD", severity: "ATTENTION",
      title: dedupeKey, body: "", link: {}, dedupeKey, payload: {}, telegram: false });
    const card = await raise("nous:decision:nous_decision:d4");
    await raise("nous:decision:nous_decision:d5");
    published.length = 0;
    expect(await notifications.resolve(owner, "nous:decision:nous_decision:d4")).toBe(1);
    expect(published).toEqual([card.id]);
  });

  it("16/11: a plan's Thread is named after its plan, and Threads stored before are renamed on the next backfill", async () => {
    const notifications = createNotificationService({ repository: new InMemorySpaceNotificationsRepository(), eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }) });
    const repository = new InMemoryInboxRepository();
    const deps = { repository, notifications, requests: { page: async () => ({ requests: [], hasMore: false }) }, decisions: { list: async () => [], get: async () => null },
      paneOpen: async () => true, panePlans: async () => new Map() };
    const raise = (planId: string, title: string) => notifications.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "AGENT", kind: "RUN_DONE", severity: "INFO",
      title, body: "", link: {}, dedupeKey: `test:${makeSpaceId("k")}`, payload: { planId }, telegram: false });
    const old = await raise("clipboard:old", "My answer to \"Braintrust 2FA\": Now");
    await createInboxService(deps).syncNotification(owner, old.id);
    const inbox = createInboxService({ ...deps, planTitle: async (_owner, id) => ({ "clipboard:old": "Upwork AI Engineer", "clipboard:new": "Freelance leads" })[id] ?? null });
    const fresh = await raise("clipboard:new", "Unrelated first record");
    await inbox.syncNotification(owner, fresh.id);
    expect((await repository.threadOfRef(owner, fresh.id))!.title).toBe("Freelance leads");
    expect((await repository.threadOfRef(owner, old.id))!.title).toContain("Braintrust");
    await inbox.backfill(owner);
    expect((await repository.threadOfRef(owner, old.id))!.title).toBe("Upwork AI Engineer");
  });

  it("DISMISS cancels a decision unanswered and closes its Thread; done-all skips what still waits for an answer", async () => {
    const f = await fixture();
    await f.decide("nous_decision:d2", "Rename the bell?");
    const thread = await f.threadOf("nous_decision:d2");
    const dismissed = await f.act(thread, { verb: "DISMISS" });
    expect(dismissed.json()).toMatchObject({ badge: 0, thread: { closedAt: expect.any(String) } });
    expect(f.dismissDecision).toHaveBeenCalledWith(owner, "nous_decision:d2");

    const update = await f.raise("RUN_DONE", { title: "Tests passed" });
    const card = await f.raise("NEEDS_YOU", { payload: { ask: { question: "Merge?", options: ["yes", "no"] } } });
    const reply = await f.app.inject({ method: "POST", url: "/api/inbox/done-all", payload: { ids: [await f.threadOf(update), await f.threadOf(card), "inbox_thread:missing"] } });
    expect(reply.json()).toMatchObject({ done: [await f.threadOf(update)], skipped: [await f.threadOf(card), "inbox_thread:missing"], badge: 1 });
    expect((await f.app.inject({ method: "GET", url: "/api/inbox/threads/nope" })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "GET", url: `/api/inbox/threads/${encodeURIComponent(thread)}` })).json().events.map((event: { type: string }) => event.type))
      .toEqual(["ASK", "CLOSED", "CLOSED"]);
  });

  it("done-all closes REQUEST_DONE threads, acknowledges their notifications, skips open asks and leaves Updates alone", async () => {
    const f = await fixture();
    const at = new Date().toISOString();
    const ask = await f.raise("NEEDS_YOU", { payload: { ask: { question: "Ship?", options: ["yes", "no"], answer: { kind: "PANE" } } } });
    const update = (await f.notifications.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "NOUS", kind: "OPERATOR_UPDATE", severity: "ATTENTION",
      title: "Heads up", body: "", link: {}, dedupeKey: "nous:update:note:done-all-test", payload: { report: "Details", links: [] } })).id;
    await f.inbox.syncNotification(owner, update);
    f.requests.push(
      { messageId: "nous_msg:done1", createdAt: at, text: "First task", status: "DONE", doneAt: at, doneSummary: "Shipped 1", where: "dev" },
      { messageId: "nous_msg:done2", createdAt: at, text: "Second task", status: "DONE", doneAt: at, doneSummary: "Shipped 2", where: "dev" }
    );
    await f.inbox.syncRequests(owner);
    const doneNotif1 = (await f.notifications.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "NOUS", kind: "REQUEST_DONE", severity: "ATTENTION",
      title: "First done", body: "Shipped 1", link: {}, dedupeKey: "nous:done:nous_msg:done1", payload: {} })).id;
    const doneNotif2 = (await f.notifications.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "NOUS", kind: "REQUEST_DONE", severity: "ATTENTION",
      title: "Second done", body: "Shipped 2", link: {}, dedupeKey: "nous:done:nous_msg:done2", payload: {} })).id;
    await f.inbox.syncNotification(owner, doneNotif1);
    await f.inbox.syncNotification(owner, doneNotif2);
    const [done1, done2, askThread, updateThread] = [await f.threadOf("nous_msg:done1"), await f.threadOf("nous_msg:done2"), await f.threadOf(ask), await f.threadOf(update)];
    expect((await f.get()).summary.tabs).toEqual({ needs: 1, done: 2, updates: 1, requests: 0 });

    const reply = await f.app.inject({ method: "POST", url: "/api/inbox/done-all", payload: { ids: [done1, done2, askThread] } });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ done: [done1, done2], skipped: [askThread], badge: 2 });
    expect((await f.notifications.get(owner, doneNotif1))!.status).toBe("ACKED");
    expect((await f.notifications.get(owner, doneNotif2))!.status).toBe("ACKED");
    expect(await f.repository.thread(owner, done1)).toMatchObject({ closedBy: "OPERATOR" });
    expect(await f.repository.thread(owner, done2)).toMatchObject({ closedBy: "OPERATOR" });
    expect((await f.repository.thread(owner, updateThread))!.closedAt).toBeNull();
    expect((await f.get()).summary.tabs).toEqual({ needs: 1, done: 0, updates: 1, requests: 0 });
  });

  it("16/11 12:41: a request Nous still works on is In progress with its news; «All new OK» and Done leave it there, Not relevant closes it", async () => {
    const f = await fixture();
    f.requests.push({ messageId: "nous_msg:live", createdAt: new Date().toISOString(), text: "Fix the inbox", status: "IN_PROGRESS" });
    await f.inbox.syncRequests(owner);
    const { id } = await f.notifications.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "NOUS", kind: "REQUEST_DONE", severity: "ATTENTION", title: "Step 1 shipped",
      body: "", link: {}, dedupeKey: "nous:done:nous_msg:live", payload: {} });
    await f.inbox.syncNotification(owner, id);
    const thread = await f.threadOf("nous_msg:live");
    expect((await f.get())).toMatchObject({ summary: { unseen: 0, working: 1 }, threads: [{ id: thread, unseen: true, openRequest: true }] });
    const reply = await f.app.inject({ method: "POST", url: "/api/inbox/done-all", payload: { ids: [thread] } });
    expect(reply.json()).toMatchObject({ done: [thread] });
    expect(await f.repository.thread(owner, thread)).toMatchObject({ closedAt: null, unseen: false, waitingFor: "NOUS" });
    expect((await f.get()).summary).toMatchObject({ unseen: 0, working: 1 });
    expect((await f.act(thread, { verb: "DONE" })).json()).toMatchObject({ thread: { closedAt: null, openRequest: true } });
    expect((await f.act(thread, { verb: "DISMISS" })).json()).toMatchObject({ thread: { closedBy: "OPERATOR" } });
    await f.inbox.syncRequests(owner);
    expect((await f.repository.thread(owner, thread))!.closedAt).not.toBeNull();
  });

  it("plan LkwKdOOh2mXK step 10: the badge is the waiting-for-you and new chips, one per Thread: a program's newer update shares its Thread, news on an open request is not counted", async () => {
    const f = await fixture();
    const update = async (title: string, key: string) => {
      const { id } = await f.notifications.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "NOUS", kind: "OPERATOR_UPDATE", severity: "ATTENTION", title, body: "",
        link: {}, dedupeKey: `nous:update:program:blacksmith-startup:${key}`, payload: { report: title, links: [], programId: "blacksmith-startup" } });
      await f.inbox.syncNotification(owner, id);
      return id;
    };
    const approved = await update("Approved: Blacksmith", "APPROVED:a");
    const amount = await update("New amount: Blacksmith", "APPROVED:b");
    f.requests.push({ messageId: "nous_msg:live", createdAt: new Date().toISOString(), text: "Fix the inbox", status: "IN_PROGRESS" });
    await f.inbox.syncRequests(owner);
    const { id } = await f.notifications.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "NOUS", kind: "REQUEST_DONE", severity: "ATTENTION", title: "Step 1 shipped",
      body: "", link: {}, dedupeKey: "nous:done:nous_msg:live", payload: {} });
    await f.inbox.syncNotification(owner, id);
    await f.raise("NEEDS_YOU", { payload: { ask: { question: "Merge?", options: ["yes", "no"] } } });
    expect(await f.threadOf(amount)).toBe(await f.threadOf(approved));
    const page = await f.get();
    expect(page.summary).toMatchObject({ operator: 1, unseen: 1, working: 1 });
    expect(page.badge).toBe(2);
    expect((await f.inbox.check(owner)).threadBadge).toBe(2);
  });

  it("plan JD8EbQgQdRls: every open Thread has its tab, the tabs' counters add up to the badge, and news on a request with a plan counts once until it is seen", async () => {
    const f = await fixture();
    const nous = async (kind: string, title: string, dedupeKey: string, payload: Record<string, unknown> = {}) => {
      const { id } = await f.notifications.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "NOUS", kind, severity: "ATTENTION", title, body: kind === "REQUEST_DONE" ? "Renamed\nChecked: the tab reads Updates on dev" : "", link: {}, dedupeKey, payload });
      await f.inbox.syncNotification(owner, id);
      return id;
    };
    const at = new Date().toISOString();
    await f.raise("NEEDS_YOU", { payload: { ask: { question: "Merge?", options: ["yes", "no"], answer: { kind: "PANE" } } } });
    const alert = await f.raise("RUN_FAILED", { title: "Deploy failed" });
    const update = await nous("OPERATOR_UPDATE", "Approved: Blacksmith", "nous:update:note:a", { report: "The full report", links: [] });
    f.requests.push({ messageId: "nous_msg:done", createdAt: at, text: "Rename the tab", status: "DONE", doneAt: at, doneSummary: "Renamed", where: "dev" },
      { messageId: "nous_msg:live", createdAt: at, text: "Bring the tabs back", status: "IN_PROGRESS", planId: "clipboard:plan0001", planPercent: 20 },
      { messageId: "nous_msg:plain", createdAt: at, text: "Check the logs", status: "IN_PROGRESS" });
    await f.inbox.syncRequests(owner);
    await nous("REQUEST_DONE", "Your request is done", "nous:done:nous_msg:done");
    const [done, live, plain] = [await f.threadOf("nous_msg:done"), await f.threadOf("nous_msg:live"), await f.threadOf("nous_msg:plain")];
    const read = async (query = "") => { const page = await f.get(query); return { page, of: (id: string) => page.threads.find((thread) => thread.id === id)! }; };

    let { page, of } = await read();
    expect(page.summary.tabs).toEqual({ needs: 1, done: 1, updates: 2, requests: 2 });
    expect(page.badge).toBe(4);
    expect(of(done)).toMatchObject({ tab: "DONE", news: "REPORT", refs: { where: "dev" }, report: "Renamed\nChecked: the tab reads Updates on dev" });
    expect(of(live).report).toBeUndefined();
    expect([of(await f.threadOf(update)), of(await f.threadOf(alert)), of(live)]).toMatchObject([{ tab: "UPDATES", news: "UPDATE" }, { tab: "UPDATES", news: "ALERT" }, { tab: "REQUESTS" }]);

    // A pane's reports on the request's plan: one line each, once per report; a start, or another plan's report, is not the request's news.
    const report = (step: number, extra: Partial<PaneReport> = {}): PaneReport => ({ id: `r${step}`, roomId: room.id, paneId: pane.id, at, source: "AGENT", status: "PROGRESS", summary: `Step ${step} is live`,
      planId: "clipboard:plan0001", step, percent: step * 20, ticket: null, next: null, needs: null, body: null, ...extra });
    for (const entry of [report(1), report(1), report(2), report(3, { status: "STARTED" }), report(4, { planId: "clipboard:other001" })]) await f.inbox.progress(owner, entry, "Andy");
    ({ page, of } = await read());
    expect(of(live)).toMatchObject({ tab: "REQUESTS", news: "PROGRESS", requestNews: true, now: "Step 2 · 40%: Step 2 is live" });
    expect((await f.repository.events(owner, live)).filter((event) => event.type === "PROGRESS").map((event) => event.title)).toEqual(["Step 1 · 20%: Step 1 is live", "Step 2 · 40%: Step 2 is live"]);
    expect(page.summary.tabs).toEqual({ needs: 1, done: 1, updates: 3, requests: 2 });
    expect([page.badge, (await f.inbox.badge(owner)).badge, (await f.inbox.check(owner)).threadBadge]).toEqual([5, 5, 5]);

    // Nous's update naming the plan or the request joins that request's Thread; the Thread still counts once, and only a request with a plan counts.
    const milestone = await nous("OPERATOR_UPDATE", "The tabs are on dev", "nous:update:note:b", { report: "Full", links: [], planId: "clipboard:plan0001" });
    const note = await nous("OPERATOR_UPDATE", "The logs are clean", "nous:update:note:c", { report: "Full", links: [], requestId: "nous_msg:plain" });
    expect([await f.threadOf(milestone), await f.threadOf(note)]).toEqual([live, plain]);
    ({ page, of } = await read());
    expect([of(live), of(plain)]).toMatchObject([{ tab: "REQUESTS", news: "UPDATE", requestNews: true }, { tab: "REQUESTS", news: "UPDATE" }]);
    expect(of(plain).requestNews).toBeUndefined();
    expect(page.badge).toBe(5);

    // Seen: the request stays under Requests with its last progress line, and counts again with its next report.
    expect((await f.act(live, { verb: "DONE" })).json()).toMatchObject({ badge: 4, thread: { closedAt: null, tab: "REQUESTS", unseen: false, now: "Step 2 · 40%: Step 2 is live" } });
    expect((await f.notifications.get(owner, milestone))!.status).toBe("ACKED");
    await f.inbox.progress(owner, report(5, { status: "BLOCKED", summary: "The queue is paused" }), "Andy");
    expect((await read()).of(live)).toMatchObject({ news: "PROGRESS", requestNews: true, now: "Blocked · 100%: The queue is paused" });

    // The Updates tab's read ones: only the closed Threads that hold an update of Nous's.
    for (const ref of [update, alert]) await f.act(await f.threadOf(ref), { verb: "DONE" });
    expect((await f.get()).threads.filter((thread) => thread.closedAt).map((thread) => thread.id).sort()).toEqual([await f.threadOf(update), await f.threadOf(alert)].sort());
    expect((await f.get("?tab=UPDATES")).threads.filter((thread) => thread.closedAt).map((thread) => thread.id)).toEqual([await f.threadOf(update)]);
    expect((await f.app.inject({ method: "GET", url: "/api/inbox?tab=NOPE" })).statusCode).toBe(422);
  });

  it("spec v2 §7 (step 4): a push names its Thread as its tag, and a Thread that stops alerting sends every phone one silent clear", async () => {
    const sent: Array<Record<string, string>> = [];
    const notifications = createNotificationService({ repository: new InMemorySpaceNotificationsRepository(), eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
      now: () => "2026-11-15T05:00:00.000Z", push: { send: async (_token, data) => { sent.push(data); return "SENT"; } } });
    const repository = new InMemoryInboxRepository();
    const inbox = createInboxService({ repository, notifications, requests: { page: async () => ({ requests: [], hasMore: false }) }, decisions: { list: async () => [], get: async () => null },
      paneOpen: async () => true, panePlans: async () => new Map(), onCleared: (owner, threadId) => void notifications.clearThreadPush(owner, threadId) });
    notifications.setThreadOf(async (owner, id) => { await inbox.syncNotification(owner, id); return (await repository.threadOfRef(owner, id))?.id ?? null; });
    await notifications.registerPushDevice(owner, { token: `phone:${"d".repeat(40)}`, platform: "ANDROID", appVersion: null });
    const raise = (severity: "INFO" | "ATTENTION", key: string) => notifications.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "MAIL_COPILOT", kind: "MAIL_RECEIVED",
      severity, title: key, body: "", link: {}, dedupeKey: key, payload: {}, telegram: false });
    const mail = await raise("ATTENTION", "mail:1");
    const info = await raise("INFO", "mail:2");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const thread = (await repository.threadOfRef(owner, mail.id))!.id;
    expect(sent[0]).toMatchObject({ notificationId: mail.id, threadId: thread, tag: thread });

    await notifications.setStatus(owner, mail.id, "ACKED");
    await inbox.syncNotification(owner, mail.id);
    await notifications.setStatus(owner, info.id, "ACKED");
    await inbox.syncNotification(owner, info.id);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // INFO never alerted, so it clears nothing.
    expect(sent[1]).toEqual({ threadId: thread, tag: thread, clear: "1" });
  });

  it("speed audit 21/11: GET /api/inbox batches thread events in one call and answers 304 when unchanged", async () => {
    const f = await fixture();
    installPollEtag(f.app);
    await f.raise("RUN_FAILED", { severity: "URGENT", title: "Failure 1" });
    await f.raise("RUN_FAILED", { severity: "ATTENTION", title: "Failure 2" });
    await f.raise("NEEDS_YOU", { payload: { ask: { question: "Ship?", options: ["Yes", "No"], answer: { kind: "PANE" } } } });
    let singleEventCalls = 0;
    let batchEventCalls = 0;
    const origEvents = f.repository.events.bind(f.repository);
    const origBatch = f.repository.eventsOfThreads.bind(f.repository);
    f.repository.events = async (who, id) => { singleEventCalls += 1; return origEvents(who, id); };
    f.repository.eventsOfThreads = async (who, ids) => { batchEventCalls += 1; return origBatch(who, ids); };

    const first = await f.app.inject({ method: "GET", url: "/api/inbox" });
    expect(first.statusCode).toBe(200);
    expect(singleEventCalls).toBe(0);
    expect(batchEventCalls).toBe(1);
    expect(first.headers.etag).toMatch(/^W\/"/);

    const again = await f.app.inject({ method: "GET", url: "/api/inbox", headers: { "if-none-match": first.headers.etag as string } });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
  });
});
