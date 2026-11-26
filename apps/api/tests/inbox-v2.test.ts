// «Εισερχόμενα» v2 step 1 (plan clipboard:aE7U1J_gU9OV): the one state (§3), the badge (§4), the grouping (§2.2) and the idempotent backfill.
import { describe, expect, it } from "vitest";
import { inboxBadge, inboxPlainLine, inboxThreadState, type InboxEvent, type NousDecision, type NousOperatorRequest, type SpaceNotification } from "@space/contracts";
import { InMemoryInboxRepository } from "@space/db";
import { askTitle, createInboxService, mirrorChanges } from "../src/inbox/service.js";

const OWNER = "user:operator";
const event = (type: InboxEvent["type"], extra: Partial<InboxEvent> = {}): InboxEvent =>
  ({ id: `e${Math.random()}`, threadId: "t", at: "2026-11-15T10:00:00.000Z", type, actor: "x", title: type, body: "", priority: "ATTENTION", ...extra });
const ask = (ref: string, forOperator = true, extra: Partial<InboxEvent> = {}) =>
  event("ASK", { ref, ask: { open: true, forOperator, kind: "QUESTION", options: [] }, ...extra });

describe("inboxThreadState", () => {
  it("waits on the operator while an ask for them is open, on Nous while it is held, and closes when it settles", () => {
    expect(inboxThreadState([ask("a")]).waitingFor).toBe("OPERATOR");
    expect(inboxThreadState([ask("a", false)]).waitingFor).toBe("NOUS");
    const settled = inboxThreadState([ask("a"), event("ANSWER", { ref: "a", at: "2026-11-15T11:00:00.000Z" })]);
    expect(settled).toMatchObject({ waitingFor: "NOBODY", closedBy: "SOURCE", closedAt: "2026-11-15T11:00:00.000Z", openAsks: [] });
  });
  it("keeps every open ask of a Thread, and the newest ask of a ref is the one that counts", () => {
    const state = inboxThreadState([ask("a", true), ask("b"), ask("a", false)]);
    expect(state.openAsks.map((item) => [item.ref, item.ask?.forOperator])).toEqual([["b", true], ["a", false]]);
  });
  it("an operator close never hides an ask for them, and an update after it opens the Thread again", () => {
    expect(inboxThreadState([ask("a"), event("CLOSED")]).closedAt).toBeNull();
    expect(inboxThreadState([event("UPDATE", { ref: "u" }), event("CLOSED")]).closedBy).toBe("OPERATOR");
    expect(inboxThreadState([event("UPDATE", { ref: "u" }), event("CLOSED"), event("ALERT", { ref: "v" })])).toMatchObject({ closedAt: null, unseen: true });
  });
  it("says what is new from the body when the record's title is the Thread's own, so a card never repeats its title", () => {
    expect(inboxThreadState([ask("a", true, { title: "Deploy", body: "\n  Approve the restart?\nmore" })], "Deploy").now).toBe("Approve the restart?");
    expect(inboxThreadState([ask("a", true, { title: "Deploy", body: "Deploy\nSecond" })], "Deploy").now).toBe("Second");
    expect(inboxThreadState([ask("a", true, { title: "Deploy", body: "" })], "Deploy").now).toBe("");
    expect(inboxThreadState([ask("a", true, { title: "Restart now" })], "Deploy").now).toBe("Restart now");
  });
  it("counts what waits on the operator and unseen items above INFO only (E2)", () => {
    const thread = (waitingFor: "OPERATOR" | "NOBODY", unseen: boolean, priority: "INFO" | "ATTENTION", closedAt: string | null = null) => ({ waitingFor, unseen, priority, closedAt });
    expect(inboxBadge([thread("OPERATOR", false, "INFO"), thread("NOBODY", true, "INFO"), thread("NOBODY", true, "ATTENTION"), thread("NOBODY", true, "ATTENTION", "x")]))
      .toEqual({ badge: 2, attention: true });
  });
});

const at = (minute: number) => new Date(Date.UTC(2026, 10, 15, 10, minute)).toISOString();
function notification(id: string, extra: Partial<SpaceNotification> = {}): SpaceNotification {
  return { id: `notification:${id}`, ownerUserId: OWNER, roomId: "room:r1", paneId: "pane:p1", source: "AGENT", kind: "NEEDS_YOU", severity: "ATTENTION", title: id, body: "",
    link: {}, dedupeKey: null, status: "OPEN", payload: {}, createdAt: at(1), updatedAt: at(1), readAt: null, ackedAt: null, resolvedAt: null, ...extra };
}
function decision(id: string, extra: Partial<NousDecision> = {}): NousDecision {
  return { id: `nous_decision:${id}`, ownerUserId: OWNER, category: "DIRECTION", title: id, body: "", options: ["Approve", "Decline"], recommendation: "Approve", refs: {},
    action: null, status: "OPEN", answer: null, outcome: null, createdAt: at(2), answeredAt: null, ...extra };
}

function setup() {
  const repository = new InMemoryInboxRepository();
  const notes = new Map<string, SpaceNotification>();
  const decisions = new Map<string, NousDecision>();
  const requests: NousOperatorRequest[] = [];
  const open = new Set(["pane:p1"]);
  const plans = new Map<string, string>();
  const service = createInboxService({
    repository,
    notifications: {
      list: async (_owner, query) => [...notes.values()].filter((record) => query.status === "ALL" || record.status === "OPEN" || record.status === "READ")
        .filter((record) => !query.before || record.createdAt < query.before).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, query.limit),
      get: async (_owner, id) => notes.get(id) ?? null
    },
    decisions: { list: async (_owner, query) => [...decisions.values()].filter((item) => !query.statuses || query.statuses.includes(item.status)), get: async (_owner, id) => decisions.get(id) ?? null },
    requests: { page: async () => ({ requests: [...requests].reverse(), hasMore: false }) },
    paneOpen: async (id) => open.has(id),
    panePlans: async () => plans,
    now: () => Date.parse(at(30))
  });
  const put = (record: SpaceNotification) => notes.set(record.id, record);
  const threads = () => repository.threads(OWNER);
  return { repository, service, notes, decisions, requests, open, plans, put, threads };
}

describe("inbox service", () => {
  it("23/11: a settled card that now mirrors as an ALERT (its pane gone) still closes its open ASK", () => {
    const closer = event("CLOSED", { ref: "a" });
    const rows = [ask("a"), event("ALERT", { ref: "a" }), event("CLOSED", { ref: "a" }), ask("a")];
    expect(mirrorChanges(rows, { opener: event("ALERT", { ref: "a" }), open: false, closer }, "2026-11-23T00:00:00.000Z")).toEqual([closer]);
    expect(mirrorChanges([...rows, closer], { opener: event("ALERT", { ref: "a" }), open: false, closer }, "2026-11-23T00:00:00.000Z")).toEqual([]);
  });

  it("groups a request, its plan's cards, decisions and Done into one Thread, and closes it when everything settles", async () => {
    const { service, put, decisions, requests, threads, plans } = setup();
    requests.push({ messageId: "nous_msg:r1", createdAt: at(0), text: "Build the inbox\nmore", status: "IN_PROGRESS", planId: "clipboard:p1", planPercent: 10 });
    await service.syncRequests(OWNER);
    put(notification("plan-card", { roomId: null, paneId: null, source: "NOUS", kind: "NEEDS_YOU", dedupeKey: "nous:plan:clipboard:p1" }));
    await service.syncNotification(OWNER, "notification:plan-card");
    decisions.set("nous_decision:d1", decision("d1", { refs: { planId: "clipboard:p1" } }));
    await service.syncDecision(OWNER, "nous_decision:d1");
    plans.set("pane:p2", "clipboard:p1");
    put(notification("pane-alert", { paneId: "pane:p2", kind: "TURN_ENDED", severity: "INFO" }));
    await service.syncNotification(OWNER, "notification:pane-alert");
    const first = await threads();
    // 17/11: each ask has its own Thread under its own title (the plan kept in its refs); the request's Thread keeps its work.
    expect(first).toHaveLength(3);
    const byKey = (list: typeof first, key: string) => list.find((item) => item.key === key);
    let thread = byKey(first, "nous_msg:r1");
    expect(thread).toMatchObject({ title: "Build the inbox", origin: "OPERATOR", waitingFor: "NOUS", progress: 10, refs: { requestId: "nous_msg:r1", planId: "clipboard:p1" } });
    expect(byKey(first, "notification:plan-card")).toMatchObject({ title: "plan-card", waitingFor: "OPERATOR", refs: { planId: "clipboard:p1" } });
    expect(byKey(first, "nous_decision:d1")).toMatchObject({ title: "d1", waitingFor: "OPERATOR", refs: { planId: "clipboard:p1" } });

    put(notification("plan-card", { roomId: null, paneId: null, source: "NOUS", kind: "NEEDS_YOU", dedupeKey: "nous:plan:clipboard:p1", status: "ACKED", ackedAt: at(5), updatedAt: at(5) }));
    await service.syncNotification(OWNER, "notification:plan-card");
    decisions.set("nous_decision:d1", decision("d1", { refs: { planId: "clipboard:p1" }, status: "APPROVED", answer: "Approve", answeredAt: at(6) }));
    await service.syncDecision(OWNER, "nous_decision:d1");
    requests[0] = { ...requests[0]!, status: "DONE", doneAt: at(9), doneSummary: "Shipped" };
    put(notification("done", { roomId: null, paneId: null, source: "NOUS", kind: "REQUEST_DONE", severity: "ATTENTION", dedupeKey: "nous:done:nous_msg:r1" }));
    await service.syncNotification(OWNER, "notification:done");
    thread = byKey(await threads(), "nous_msg:r1");
    expect(thread).toMatchObject({ waitingFor: "NOBODY", unseen: true, closedAt: null });
    put(notification("done", { roomId: null, paneId: null, source: "NOUS", kind: "REQUEST_DONE", dedupeKey: "nous:done:nous_msg:r1", status: "ACKED", ackedAt: at(10) }));
    put(notification("pane-alert", { paneId: "pane:p2", kind: "TURN_ENDED", severity: "INFO", status: "READ", readAt: at(4) }));
    await service.syncNotification(OWNER, "notification:done");
    await service.syncNotification(OWNER, "notification:pane-alert");
    const last = await threads();
    expect(byKey(last, "nous_msg:r1")).toMatchObject({ waitingFor: "NOBODY", unseen: false, closedBy: "SOURCE" });
    expect(last.every((item) => item.closedAt)).toBe(true);
  });

  it("17/11 (card 7454e78e): a closed pane's carried card is the operator's: listed, counted and no shadow-check miss", async () => {
    const { service, put, threads, repository } = setup();
    put(notification("carry", { roomId: null, paneId: null, source: "NOUS", kind: "NEEDS_HANDS", dedupeKey: "nous:closed-pane:pane:gone" }));
    await service.syncNotification(OWNER, "notification:carry");
    const [thread] = await threads();
    expect(thread).toMatchObject({ waitingFor: "OPERATOR", title: "carry" });
    expect((await repository.events(OWNER, thread!.id)).map((item) => item.ask?.forOperator)).toEqual([true]);
    expect((await service.badge(OWNER)).badge).toBe(1);
    expect((await service.check(OWNER)).missing).toEqual([]);
  });

  it("17/11 (card e90ddf3c): a plan card on a plan an older request names shows under its own title, and backfill moves one filed in the request", async () => {
    const { service, put, requests, threads, repository } = setup();
    requests.push({ messageId: "nous_msg:r1", createdAt: at(0), text: "Plan the usage", status: "IN_PROGRESS", planId: "clipboard:p1", planPercent: 10 });
    await service.syncRequests(OWNER);
    const request = (await threads())[0]!;
    // Filed in the request's Thread before 17/11.
    put(notification("old", { roomId: null, paneId: null, source: "NOUS", kind: "NEEDS_HANDS", title: "Admin key expires today", dedupeKey: "nous:plan:clipboard:p1" }));
    await repository.append(OWNER, "notification:old:ASK:0", { threadId: request.id, type: "ASK", at: at(1), actor: "Nous", title: "Admin key expires today", body: "",
      priority: "ATTENTION", ref: "notification:old", ask: { open: true, forOperator: true, kind: "HANDS", options: [] } });
    await service.backfill(OWNER);
    put(notification("new", { roomId: null, paneId: null, source: "NOUS", kind: "NEEDS_YOU", title: "Approve the plan", dedupeKey: "nous:plan:clipboard:p2", payload: { planId: "clipboard:p1" } }));
    await service.syncNotification(OWNER, "notification:new");
    const list = await threads();
    expect(list.find((item) => item.key === "notification:old")).toMatchObject({ title: "Admin key expires today", waitingFor: "OPERATOR", refs: { planId: "clipboard:p1" } });
    expect(list.find((item) => item.key === "notification:new")).toMatchObject({ title: "Approve the plan", waitingFor: "OPERATOR", refs: { planId: "clipboard:p1" } });
    expect(list.find((item) => item.key === "nous_msg:r1")).toMatchObject({ waitingFor: "NOUS", title: "Plan the usage" });
    expect((await repository.threadOfRef(OWNER, "notification:old"))!.key).toBe("notification:old");
    expect((await service.check(OWNER)).duplicates).toEqual([]);
    expect((await service.check(OWNER)).missing).toEqual([]);
  });

  it("an agent's Go now card goes to the browser pane holding its page, not the asking CLI", async () => {
    const { service, put, repository, threads } = setup();
    const page = { roomId: "room:r1", paneId: "pane:kate", target: "tab:t1" };
    put(notification("waf", { payload: { ask: { question: "Approve the AWS WAF step", options: ["Go now"], answer: { kind: "PANE" } }, browserPage: page } }));
    put(notification("own", { source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED", paneId: "pane:p1" }));
    await service.syncNotification(OWNER, "notification:waf");
    await service.syncNotification(OWNER, "notification:own");
    const ask = async (key: string) => (await repository.events(OWNER, (await threads()).find((item) => item.key === key)!.id))[0]!.ask;
    expect(await ask("notification:waf")).toMatchObject({ kind: "HANDS", goToPane: page });
    expect((await ask("notification:own"))?.goToPane).toMatchObject({ roomId: "room:r1", paneId: "pane:p1" });
  });

  it("asks again when an ask turns to or from the operator, and a card on a closed pane is nobody's", async () => {
    const { service, put, open, threads, repository } = setup();
    put(notification("q"));
    await service.syncNotification(OWNER, "notification:q");
    expect((await threads())[0]!.waitingFor).toBe("OPERATOR");
    open.delete("pane:p1");
    await service.tick(OWNER);
    const [thread] = await threads();
    expect(thread!.waitingFor).toBe("NOUS");
    expect((await repository.events(OWNER, thread!.id)).map((item) => [item.type, item.ask?.forOperator])).toEqual([["ASK", true], ["ASK", false]]);
  });

  it("plan LkwKdOOh2mXK step 8: a copilot's «needs you» question or review is named after what it is and who asks; hands keep their title", async () => {
    const review = notification("r", { source: "MARKETING_COPILOT", kind: "REVIEW_REQUESTED", title: "Marketing Copilot needs you (Marketing Copilot 13)",
      body: "Review: Cold outreach LinkedIn", payload: { review: { id: "marketing_post:1", channel: "LINKEDIN", text: "Hi" }, heldForNous: { until: at(59) } } });
    expect(askTitle(review)).toBe("LinkedIn review from Marketing Copilot 13");
    expect(askTitle(notification("q", { source: "MAIL_COPILOT", kind: "QUESTION", title: "Mail Copilot needs you (Inbox)" }))).toBe("Question from Inbox");
    expect(askTitle(notification("j", { source: "JOB_COPILOT", kind: "NEEDS_USER", title: "Jobs needs you" }))).toBe("Question from Jobs");
    expect(askTitle(notification("a", { title: "Andy needs you" }))).toBe("Andy needs you"); // an agent's go-to-the-pane ask is hands
    expect(askTitle(notification("h", { source: "BROWSER_HANDOFF", kind: "CAPTCHA", title: "Andy needs you" }))).toBe("Andy needs you");
    expect(askTitle(notification("k", { title: "Pick the font" }))).toBe("Pick the font");
    const { service, put, threads } = setup();
    put(review);
    await service.syncNotification(OWNER, review.id);
    expect((await threads()).map((thread) => [thread.title, thread.waitingFor])).toEqual([["LinkedIn review from Marketing Copilot 13", "NOUS"]]);
  });

  it("plan LkwKdOOh2mXK step 5: a copilot's reviews to the same person share one Thread; another person or an untargeted post keeps its own", async () => {
    const review = (id: string, target?: string) => notification(id, { source: "MARKETING_COPILOT", kind: "REVIEW_REQUESTED", title: "Marketing Copilot needs you (Marketing Copilot 13)",
      dedupeKey: `marketing-copilot:review:mktpost:${id}`, payload: { review: { id: `mktpost:${id}`, channel: "LINKEDIN", text: id, ...(target ? { target } : {}) } } });
    const { service, put, threads } = setup();
    const malte = "https://www.linkedin.com/in/maltepietsch/";
    const items = [review("note", malte), review("dm", malte), review("other", "https://www.linkedin.com/in/someone/"), review("post1"), review("post2")];
    for (const item of items) { put(item); await service.syncNotification(OWNER, item.id); }
    const all = await threads();
    expect(all).toHaveLength(4);
    expect(all.filter((thread) => thread.key === `dedupe:MARKETING_COPILOT:to:${malte}`)).toHaveLength(1);
  });

  it("a decision's card stands for the decision, and a held decision is no ask for the operator", async () => {
    const { service, put, decisions, threads } = setup();
    decisions.set("nous_decision:d2", decision("d2", { body: "Held for \"May run guarded host restarts\": restart once this clears: the queue is idle." }));
    put(notification("card", { source: "NOUS", kind: "NEEDS_YOU", dedupeKey: "nous:decision:nous_decision:d2" }));
    await service.syncNotification(OWNER, "notification:card");
    const list = await threads();
    expect(list.map((thread) => [thread.key, thread.waitingFor])).toEqual([["nous_decision:d2", "NOUS"]]);
  });

  it("a one-record Thread's now is its body, and backfill repairs rows stored with the title repeated", async () => {
    const { service, put, repository, threads } = setup();
    put(notification("Test notification", { body: "This is how Space notifies you." }));
    await service.backfill(OWNER);
    let [thread] = await threads();
    expect(thread).toMatchObject({ title: "Test notification", now: "This is how Space notifies you." });
    await repository.saveThread({ ...thread!, now: thread!.title });
    await service.backfill(OWNER);
    [thread] = await threads();
    expect(thread!.now).toBe("This is how Space notifies you.");
  });

  it("backfill records each change once however often it runs, and the shadow check agrees with today's Needs you", async () => {
    const { service, put, decisions, requests, repository, threads } = setup();
    requests.push({ messageId: "nous_msg:old", createdAt: at(0), text: "Old", status: "DONE", doneAt: at(3) });
    put(notification("a"));
    put(notification("b", { status: "RESOLVED", resolvedAt: at(4), updatedAt: at(4) }));
    put(notification("c", { kind: "UPDATE", source: "SYSTEM", status: "OPEN" }));
    decisions.set("nous_decision:d3", decision("d3"));
    const first = await service.backfill(OWNER);
    const again = await service.backfill(OWNER);
    expect(first.appended).toBeGreaterThan(0);
    expect(again.appended).toBe(0);
    expect((await threads()).length).toBe(5);
    const old = await repository.threadByKey(OWNER, "nous_msg:old");
    expect(old).toMatchObject({ closedBy: "SOURCE" });
    const report = await service.check(OWNER);
    expect(report).toMatchObject({ missing: [], stale: [], duplicates: [], threadBadge: 3, attention: true });
  });

  it("16/11: a fresh request not answered yet is an open Thread waiting on Nous, with its status, until it is answered", async () => {
    const { service, requests, threads, repository } = setup();
    requests.push({ messageId: "nous_msg:n1", createdAt: at(0), text: "Where are my messages?", status: "NOT_ANSWERED" });
    await service.syncRequests(OWNER);
    let [thread] = await threads();
    expect(thread).toMatchObject({ origin: "OPERATOR", originLabel: "You", waitingFor: "NOUS", closedAt: null, refs: { requestStatus: "NOT_ANSWERED" } });
    requests[0] = { ...requests[0]!, status: "IN_PROGRESS", planId: "clipboard:p9", planPercent: 40 };
    await service.syncRequests(OWNER);
    [thread] = await threads();
    expect(thread).toMatchObject({ waitingFor: "NOUS", closedAt: null, progress: 40, refs: { requestStatus: "IN_PROGRESS" } });
    requests[0] = { ...requests[0]!, status: "NOT_DONE" };
    await service.syncRequests(OWNER);
    expect((await threads())[0]).toMatchObject({ waitingFor: "NOUS", closedAt: null, refs: { requestStatus: "NOT_DONE" } });
    requests[0] = { ...requests[0]!, status: "ANSWERED", answeredAt: at(5) };
    await service.syncRequests(OWNER);
    [thread] = await threads();
    expect(thread).toMatchObject({ closedBy: "SOURCE" });
    expect((await repository.events(OWNER, thread!.id)).map((event) => [event.type, event.title])).toEqual([["REQUEST", "Where are my messages?"], ["CLOSED", "Answered"]]);
  });

  it("16/11 12:41: a request in progress reopens whatever closed it (the raw-status closer, the operator's Done); his Not relevant stands", async () => {
    const { service, requests, repository } = setup();
    for (const id of ["shut", "done", "dropped"]) {
      requests.push({ messageId: `nous_msg:${id}`, createdAt: at(0), text: id, status: "IN_PROGRESS" });
      const thread = await repository.createThread({ ownerUserId: OWNER, key: `nous_msg:${id}`, title: id, origin: "OPERATOR", originLabel: "You", waitingFor: "NOBODY", unseen: false,
        closedAt: at(1), closedBy: id === "shut" ? "SOURCE" : "OPERATOR", priority: "INFO", now: "", progress: null, refs: { requestId: `nous_msg:${id}` }, createdAt: at(0), lastEventAt: at(1) });
      await repository.append(OWNER, `nous_msg:${id}:REQUEST:0`, { threadId: thread.id, type: "REQUEST", at: at(0), actor: "You", title: id, body: id, priority: "INFO", ref: `nous_msg:${id}` });
      if (id === "shut") await repository.append(OWNER, `nous_msg:${id}:CLOSED:0`, { threadId: thread.id, type: "CLOSED", at: at(1), actor: "Nous", title: "NOT_DONE", body: "", priority: "INFO", ref: `nous_msg:${id}` });
      else await repository.append(OWNER, `${thread.id}:CLOSED:0`, { threadId: thread.id, type: "CLOSED", at: at(1), actor: "You", title: id === "done" ? "Closed" : "Not relevant", body: "", priority: "INFO" });
    }
    await service.tick(OWNER);
    const shut = (await repository.threadOfRef(OWNER, "nous_msg:shut"))!;
    expect(shut).toMatchObject({ waitingFor: "NOUS", closedAt: null });
    expect((await repository.events(OWNER, shut.id)).map((event) => event.type)).toEqual(["REQUEST", "CLOSED", "REQUEST", "REOPENED"]);
    const done = (await repository.threadOfRef(OWNER, "nous_msg:done"))!;
    expect(done).toMatchObject({ waitingFor: "NOUS", closedAt: null });
    expect((await repository.events(OWNER, done.id)).map((event) => event.type)).toEqual(["REQUEST", "CLOSED", "REOPENED"]);
    expect((await repository.threadOfRef(OWNER, "nous_msg:dropped"))!.closedAt).not.toBeNull();
    // Each tick after changes nothing more.
    await service.tick(OWNER);
    expect((await repository.events(OWNER, done.id)).length).toBe(3);
  });

  it("a closed Thread that a new record of its key opens again says so", async () => {
    const { service, put, repository, threads } = setup();
    put(notification("u1", { kind: "UPDATE", source: "SYSTEM", dedupeKey: "sys:x", status: "READ", readAt: at(2) }));
    await service.syncNotification(OWNER, "notification:u1");
    expect((await threads())[0]!.closedAt).not.toBeNull();
    put(notification("u2", { kind: "UPDATE", source: "SYSTEM", dedupeKey: "sys:x", createdAt: at(5) }));
    await service.syncNotification(OWNER, "notification:u2");
    const [thread] = await threads();
    expect(thread!.closedAt).toBeNull();
    expect((await repository.events(OWNER, thread!.id)).map((item) => item.type)).toEqual(["ALERT", "CLOSED", "ALERT", "REOPENED"]);
  });

  it("R73: a Nous update's Thread carries its body, full report and links", async () => {
    const { service, put, repository, threads } = setup();
    put(notification("up", { source: "NOUS", kind: "OPERATOR_UPDATE", roomId: null, paneId: null, body: "Approved, nothing to do.",
      payload: { report: "Full report text.", links: [{ label: "Portal", url: "https://example.com/p" }] } }));
    await service.syncNotification(OWNER, "notification:up");
    const [event] = await repository.events(OWNER, (await threads())[0]!.id);
    expect([event!.type, event!.body]).toEqual(["UPDATE", "Approved, nothing to do.\n\nFull report text.\n\n[Portal](https://example.com/p)"]);
  });

  it("speed audit 21/11: unchanged requests skip DB reads on repeated ticks, while changes and operator closes re-sync", async () => {
    const { service, requests, repository } = setup();
    requests.push(
      { messageId: "nous_msg:s1", createdAt: at(0), text: "First task", status: "DONE", doneAt: at(3) },
      { messageId: "nous_msg:s2", createdAt: at(1), text: "Second task", status: "IN_PROGRESS", planPercent: 20 }
    );
    let eventRefCalls = 0;
    const origEventsOfRefs = repository.eventsOfRefs.bind(repository);
    repository.eventsOfRefs = async (owner, refs) => { eventRefCalls += 1; return origEventsOfRefs(owner, refs); };
    await service.syncRequests(OWNER);
    expect(eventRefCalls).toBe(1);
    await service.syncRequests(OWNER);
    expect(eventRefCalls).toBe(1);
    requests[1] = { ...requests[1]!, planPercent: 60 };
    await service.syncRequests(OWNER);
    expect(eventRefCalls).toBe(2);
    expect((await repository.threadOfRef(OWNER, "nous_msg:s2"))!.progress).toBe(60);
    const openThread = (await repository.threadOfRef(OWNER, "nous_msg:s2"))!;
    await service.closeByOperator(OWNER, openThread.id, false);
    await service.syncRequests(OWNER);
    expect(eventRefCalls).toBe(3);
  });
});

describe("inboxPlainLine (operator 16/11 12:05, plan clipboard:LkwKdOOh2mXK step 1)", () => {
  it("keeps one line without internal ids or the brackets holding them, cut at a word; links and plain brackets stay", () => {
    const review = "Review: Cold outreach LinkedIn από /in/ntheo (εντολή nous_msg:c248534ab92e4880953bd998, brief mktevt:zdgs3tRGWzCE/wHQWVUc-nWPe). Σημείωση σύνδεσης: Julien Danjou, Co-founder & CEO (technical) @ Mergify (6-11). Γιατί: «I have seven Claude Code terminals open right now». Σήμα: https://julien.danjou.info/blog/the-flow-is-gone/. 11 CLIs (FACT h5jQjgM4LAhz), DM με την κάρτα artifact:1or7Add0cb4O.\nSecond line";
    const line = inboxPlainLine(review);
    expect(line.startsWith("Review: Cold outreach LinkedIn από /in/ntheo. Σημείωση σύνδεσης: Julien Danjou, Co-founder & CEO (technical) @ Mergify (6-11).")).toBe(true);
    expect(line).not.toMatch(/nous_msg|mktevt|FACT|artifact|Second line/);
    expect(line.length).toBeLessThanOrEqual(161);
    expect(line.endsWith("…")).toBe(true);
    expect(inboxPlainLine("• Open http://127.0.0.1:4911:4940/x (port 4940)")).toBe("Open http://127.0.0.1:4911:4940/x (port 4940)");
    expect(inboxPlainLine(inboxPlainLine(review))).toBe(line);
    expect(inboxThreadState([ask("a", false, { title: "T", body: review })], "T").now).toBe(line);
  });
});
