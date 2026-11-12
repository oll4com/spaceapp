import { describe, expect, it, vi } from "vitest";
import type { NousDecision, NousMessage, SpaceNotification } from "@space/contracts";
import { InMemoryNousRepository } from "@space/db";
import { createNousRequests, deriveNousRequests, type NousRequestLinks, type NousRequestPlans } from "../src/nous/requests.js";
import { requestDoneReceiptKey } from "../src/nous/request-done.js";

// The Requests tab (operator 31/10 09:55 BKK, plan clipboard:2NOOFNJDUIMO): each operator message's status from exact links; words only for old rows.
const owner = "user:operator";
const message = (n: number, content: string): NousMessage => ({ id: `nous_msg:m${String(n).padStart(6, "0")}`, ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE",
  content, meta: {}, createdAt: `2026-10-31T0${n}:00:00.000Z`, updatedAt: `2026-10-31T0${n}:00:00.000Z` });
const done = (dedupeKey: string, payload: Record<string, unknown>, createdAt = "2026-10-31T09:30:00.000Z") =>
  ({ id: `notification:${dedupeKey.slice(-8)}`, dedupeKey, payload: { where: "dev", summary: "Done.", request: "x", ...payload }, createdAt }) as unknown as SpaceNotification;
const links = (patch: Partial<NousRequestLinks> = {}): NousRequestLinks => ({ answers: [], turns: [], done: [], notes: [], openDecisions: [], ...patch });
const answer = (turnId: string, replyTo: string[], at: string) => ({ turnId, createdAt: at, startedAt: at, replyTo });
const status = (messages: NousMessage[], value: NousRequestLinks, plans: NousRequestPlans = new Map(), latestOperatorAt?: string | null) =>
  Object.fromEntries(deriveNousRequests(messages, value, plans, ...(latestOperatorAt === undefined ? [] : [latestOperatorAt])).map((request) => [request.messageId, request]));

describe("Nous Requests", () => {
  it("is Done by the message's own id, a turn that answered it, its plan or a durable receipt, with the record's summary, where and tickets", () => {
    const [a, b, c, d] = [message(1, "Πρόσθεσε το tab"), message(2, "Φτιάξε το bug"), message(3, "Ξεκίνα το plan"), message(4, "Παλιό αίτημα")];
    const value = links({
      answers: [answer("turn:b", [b.id], "2026-10-31T02:10:00.000Z"), answer("turn:c", [c.id], "2026-10-31T03:10:00.000Z"), answer("turn:d", [d.id], "2026-10-31T04:10:00.000Z")],
      done: [done(`nous:done:${a.id}-2`, { summary: "Το tab υπάρχει.", where: "stable", tickets: ["q-20261031-020000-abcd"] }), done("nous:done:turn:b", { summary: "Bug fixed." }),
        done("nous:done:clipboard:plan0000c", { planId: "clipboard:plan0000c", summary: "Plan done." })],
      notes: [{ key: "request-done:plan:clipboard:plan0000c", text: JSON.stringify({ planId: "clipboard:plan0000c", title: "c", operatorTurn: "turn:c" }), updatedAt: "2026-10-31T03:00:00.000Z" },
        { key: requestDoneReceiptKey("turn:d"), text: "notification:pruned", updatedAt: "2026-10-31T04:20:00.000Z" }]
    });
    const result = status([a, b, c, d], value, new Map([["clipboard:plan0000c", { progressPercentage: 100, isCompleted: true, executionStatus: "COMPLETED" }]]));
    expect(result[a.id]).toEqual({ messageId: a.id, createdAt: a.createdAt, text: "Πρόσθεσε το tab", status: "DONE", doneSummary: "Το tab υπάρχει.", where: "stable", tickets: ["q-20261031-020000-abcd"], answeredAt: "2026-10-31T02:10:00.000Z", repliedAt: "2026-10-31T02:10:00.000Z", doneAt: "2026-10-31T09:30:00.000Z" });
    expect(result[b.id]).toMatchObject({ status: "DONE", doneSummary: "Bug fixed.", answeredAt: "2026-10-31T02:10:00.000Z" });
    expect(result[c.id]).toMatchObject({ status: "DONE", doneSummary: "Plan done.", planId: "clipboard:plan0000c", planPercent: 100 });
    // A record pruned 30 days after Got it leaves its receipt: still Done, without a summary.
    expect(result[d.id]).toMatchObject({ status: "DONE" });
    expect(result[d.id]!.doneSummary).toBeUndefined();
    // The Score's Done time comes from the record; a receipt alone has none.
    expect(result[d.id]!.doneAt).toBeUndefined();
  });

  it("counts a plan-keyed Done record or receipt for a linked message only once that plan is completed (9/11: 7 of 20 \"done\" were not)", () => {
    const [c, d] = [message(3, "Ξεκίνα το plan"), message(4, "Και το δεύτερο")];
    const plan = "clipboard:planOpen0002";
    const value = links({
      answers: [answer("turn:c", [c.id, d.id], "2026-10-31T05:10:00.000Z")],
      done: [done(`nous:done:${plan}`, { planId: plan, summary: "Plan done." })],
      notes: [{ key: `request-done:plan:${plan}`, text: JSON.stringify({ planId: plan, title: "c", operatorTurn: "turn:c" }), updatedAt: "2026-10-31T05:00:00.000Z" },
        { key: requestDoneReceiptKey(plan), text: "notification:x", updatedAt: "2026-10-31T09:30:00.000Z" }]
    });
    const open = status([c, d], value, new Map([[plan, { progressPercentage: 78, isCompleted: false, executionStatus: "IN_PROGRESS" }]]));
    expect(open[c.id]).toMatchObject({ status: "ANSWERED", planId: plan });
    expect(open[d.id]).toMatchObject({ status: "ANSWERED", planId: plan });
    // The receipt alone (record pruned) holds nothing either while the plan is open.
    expect(status([c], links({ ...value, done: [] }), new Map([[plan, { progressPercentage: 78, isCompleted: false, executionStatus: "IN_PROGRESS" }]]))[c.id]!.status).toBe("ANSWERED");
    const completed = status([c, d], value, new Map([[plan, { progressPercentage: 100, isCompleted: true, executionStatus: "COMPLETED" }]]));
    expect(completed[c.id]).toMatchObject({ status: "DONE", doneSummary: "Plan done." });
    expect(completed[d.id]).toMatchObject({ status: "DONE" });
  });

  it("takes an operator turn's space_reply_now as the first reply, never as the answer that covers the message", () => {
    const [a, b] = [message(1, "Τρέξε το"), message(2, "Και αυτό")];
    const value = links({ answers: [{ ...answer("turn:1", [a.id], "2026-10-31T01:01:00.000Z"), interim: true as const }, answer("turn:1", [a.id], "2026-10-31T01:30:00.000Z"),
      { ...answer("turn:2", [b.id], "2026-10-31T02:01:00.000Z"), interim: true as const }] });
    const result = status([b, a], value);
    expect(result[a.id]).toMatchObject({ status: "NOT_DONE", answeredAt: "2026-10-31T01:30:00.000Z", repliedAt: "2026-10-31T01:01:00.000Z" });
    // Only an interim reply so far: replied, not answered.
    expect(result[b.id]).toMatchObject({ status: "NOT_ANSWERED", repliedAt: "2026-10-31T02:01:00.000Z" });
    expect(result[b.id]!.answeredAt).toBeUndefined();
  });

  it("waits for the operator, is in progress, answered or not answered yet from the outcomes kept per message, open plans and decisions", () => {
    const [a, b, c, d, e, f, g] = [message(1, "Αποφάσισε"), message(2, "Τρέξε"), message(3, "Plan"), message(4, "Ερώτηση;"), message(5, "Decision plan"), message(6, "Μόλις τώρα"),
      message(0, "Ρώτησε με στο chat")];
    const value = links({
      answers: [answer("turn:0", [g.id], "2026-10-31T00:30:00.000Z"), answer("turn:1", [a.id, b.id, c.id, d.id, e.id], "2026-10-31T05:30:00.000Z")],
      turns: [
        { turnId: "turn:0", endedAt: "2026-10-31T00:30:00.000Z", outcomes: [{ summary: "Asked in the chat", outcome: "OPERATOR", messageIds: [g.id] }] },
        { turnId: "turn:old", endedAt: "2026-10-31T05:00:00.000Z", outcomes: [{ summary: "Asked", outcome: "OPERATOR", messageIds: [b.id] }] },
        { turnId: "turn:1", endedAt: "2026-10-31T05:30:00.000Z", outcomes: [
          { summary: "Your call", outcome: "OPERATOR", messageIds: [a.id] }, { summary: "Running", outcome: "PENDING", messageIds: [b.id] },
          { summary: "Planned", outcome: "SELF", messageIds: [c.id], plan: "clipboard:plan00open" }, { summary: "Answered", outcome: "SELF", answerOnly: true, messageIds: [d.id] },
          { summary: "Asked on a plan", outcome: "SELF", messageIds: [e.id], plan: "clipboard:plan0dec1" }] }],
      openDecisions: [{ id: "nous_decision:abcdef123456", refs: { planId: "clipboard:plan0dec1" }, status: "OPEN", createdAt: "2026-10-31T07:00:00.000Z" } as unknown as NousDecision,
        { id: "nous_decision:asked0000001", refs: {}, status: "OPEN", createdAt: "2026-10-31T05:20:00.000Z" } as unknown as NousDecision]
    });
    const plans: NousRequestPlans = new Map([["clipboard:plan00open", { progressPercentage: 40, isCompleted: false, executionStatus: "IN_PROGRESS" }],
      ["clipboard:plan0dec1", { progressPercentage: 10, isCompleted: false, executionStatus: "IN_PROGRESS" }]]);
    const result = status([f, e, d, c, b, a, g], value, plans);
    // The operator wrote again (f) after both turns: a still waits on the decision its turn asked; g's question in the chat was answered by writing, its task not done.
    expect(result[a.id]!.status).toBe("WAITS_FOR_YOU");
    expect(result[g.id]!.status).toBe("NOT_DONE");
    expect(status([g], value, plans, "2026-10-31T00:00:00.000Z")[g.id]!.status).toBe("WAITS_FOR_YOU");
    // The newest turn's outcome counts: the earlier OPERATOR became PENDING, which no open request tracks: not done.
    expect(result[b.id]!.status).toBe("NOT_DONE");
    expect(result[c.id]).toMatchObject({ status: "ANSWERED", planId: "clipboard:plan00open", planPercent: 40 });
    expect(result[d.id]).toMatchObject({ status: "ANSWERED", answeredAt: "2026-10-31T05:30:00.000Z" });
    expect(result[e.id]).toMatchObject({ status: "WAITS_FOR_YOU", planId: "clipboard:plan0dec1" });
    expect(result[f.id]!.status).toBe("NOT_ANSWERED");
  });

  it("links an old turn's outcomes through its answer, covers rows from before replyTo by time, and keeps words for rows with no exact link", () => {
    const [a, b, c] = [message(1, "Βάλε το Telegram να απαντά στα μηνύματα μου"), message(2, "Κάτι άλλο εντελώς"), message(3, "Ρώτα με")];
    const value = links({
      // Before 21/10 an answer named nothing: it covers what was written before its turn began.
      answers: [{ turnId: "turn:old", createdAt: "2026-10-31T02:30:00.000Z", startedAt: "2026-10-31T02:20:00.000Z", replyTo: [] }, answer("turn:c", [c.id], "2026-10-31T03:30:00.000Z")],
      turns: [{ turnId: "turn:c", endedAt: "2026-10-31T03:30:00.000Z", outcomes: [{ summary: "Asked", outcome: "OPERATOR" }] }],
      done: [done("nous:done:clipboard:telegram01", { request: "Telegram να απαντά στα μηνύματα", summary: "Telegram answers." }),
        done("nous:done:nous_msg:elsewhere01", { request: "Κάτι άλλο εντελώς", summary: "Another message's." })]
    });
    const result = status([c, b, a], value);
    expect(result[a.id]).toMatchObject({ status: "DONE", doneSummary: "Telegram answers.", answeredAt: "2026-10-31T02:30:00.000Z" });
    // A record another message's id names is that message's, whatever its words: b was answered, never done.
    expect(result[b.id]).toMatchObject({ status: "NOT_DONE" });
    expect(result[c.id]!.status).toBe("WAITS_FOR_YOU");
  });

  // Operator 31/10 10:17 BKK: a request Nous left PENDING reads In progress until its Done record or real outcome closes it.
  it("keeps a message with an open request In progress, with the open request's plan", () => {
    const asked = message(1, "Φτιάξε το Telegram");
    const value = links({ answers: [answer("turn:a", [asked.id], "2026-10-31T01:10:00.000Z")],
      turns: [{ turnId: "turn:a", endedAt: "2026-10-31T01:10:00.000Z", outcomes: [{ summary: "Telegram", outcome: "SELF", answerOnly: true, messageIds: [asked.id] }] }],
      notes: [{ key: "request-done:open:abc", text: JSON.stringify({ messageId: asked.id, summary: "Telegram buttons", plan: "clipboard:planTele001", turnId: "turn:b",
        openedAt: "2026-10-31T02:00:00.000Z", reportedAt: "2026-10-31T02:00:00.000Z" }), updatedAt: "2026-10-31T02:00:00.000Z" }] });
    const result = status([asked], value, new Map([["clipboard:planTele001", { progressPercentage: 100, isCompleted: true, executionStatus: "COMPLETED" }]]));
    expect(result[asked.id]).toMatchObject({ status: "IN_PROGRESS", planId: "clipboard:planTele001", planPercent: 100 });
  });

  // 31/10: the one-time cleanup of the backfilled open requests judges each message as the tab would without its own open request.
  it("reads messages' status without their open requests for the cleanup, while the page reads In progress only through them", async () => {
    const repository = new InMemoryNousRepository();
    const [a, b] = [await repository.addMessage({ ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content: "Τρέξε το" }),
      await repository.addMessage({ ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content: "Ρώτα με" })];
    const at = new Date(Date.now() + 1_000).toISOString();
    await repository.addMessage({ ownerUserId: owner, turnId: "nous_turn:st000001", kind: "ANSWER", status: "DONE", content: "ok", meta: { reason: "OPERATOR", startedAt: a.createdAt, replyTo: [a.id, b.id] } });
    await repository.addTurnFacts({ turnId: "nous_turn:st000001", ownerUserId: owner, reason: "OPERATOR", status: "DONE", tools: {}, planPoints: 0, startedAt: at, endedAt: at,
      outcomes: [{ summary: "Running", outcome: "PENDING", messageIds: [a.id] }, { summary: "Answered", outcome: "SELF", answerOnly: true, messageIds: [b.id] }],
      model: null, effort: null, costUsd: null, tokens: null, goalId: null, error: null });
    await repository.setNote(owner, "request-done:open:000000000000000000000001", JSON.stringify({ messageId: b.id, summary: "Ρώτα με", turnId: "nous_turn:old", openedAt: at, reportedAt: at }));
    const requests = createNousRequests({ repository, notifications: { list: async () => [] }, plan: async () => null });
    expect(await requests.statuses(owner, [a.id, b.id, "nous_msg:unknown00001"])).toEqual(new Map([[a.id, "IN_PROGRESS"], [b.id, "ANSWERED"]]));
    expect(Object.fromEntries((await requests.page(owner, { limit: 10 })).requests.map((request) => [request.messageId, request.status]))).toEqual({ [a.id]: "NOT_DONE", [b.id]: "IN_PROGRESS" });
    // History period (plan clipboard:8riKjb1krKyL): past `since` an answered request leaves the tab and its count; one in progress or not done stays.
    const later = await requests.page(owner, { limit: 10, since: new Date(Date.now() + 60_000).toISOString() });
    expect([later.requests.map((request) => request.messageId), later.counts.NOT_DONE, later.counts.IN_PROGRESS]).toEqual([[b.id, a.id], 1, 1]);
  });

  // Operator 31/10 13:03 BKK: requests Nous closed (space_open_requests close) kept reading In progress from the PENDING that opened them.
  it("ends In progress once the message's open request is closed, also on an open plan, unless an open request holds it; HELPER is not In progress", () => {
    const [a, b, c, d, e] = [message(1, "Κλειστό"), message(2, "Ξανά σε εξέλιξη"), message(3, "Plan ανοιχτό"), message(4, "Από pane"), message(5, "Δύο αιτήματα")];
    const closed = (n: number, messageId: string, closedAt: string, extra: Record<string, unknown> = {}) => ({ key: `request-done:open:closed${n}`,
      text: JSON.stringify({ messageId, summary: "x", turnId: "turn:1", openedAt: "2026-10-31T06:00:00.000Z", reportedAt: "2026-10-31T06:00:00.000Z", closedAt, closedReason: "DROPPED: no", ...extra }),
      updatedAt: closedAt });
    const value = links({
      turns: [{ turnId: "turn:1", endedAt: "2026-10-31T06:00:00.000Z", outcomes: [{ summary: "Running", outcome: "PENDING", messageIds: [a.id, b.id, c.id, e.id] },
        { summary: "A pane did it", outcome: "HELPER", messageIds: [d.id] }] },
      { turnId: "turn:2", endedAt: "2026-10-31T08:00:00.000Z", outcomes: [{ summary: "Again", outcome: "PENDING", messageIds: [b.id] }] }],
      notes: [closed(1, a.id, "2026-10-31T07:00:00.000Z"), closed(2, b.id, "2026-10-31T07:00:00.000Z"), closed(3, c.id, "2026-10-31T07:00:00.000Z", { plan: "clipboard:planOpen0001" }),
        closed(4, e.id, "2026-10-31T07:00:00.000Z"),
        { key: "request-done:open:still", text: JSON.stringify({ messageId: e.id, summary: "y", turnId: "turn:1", openedAt: "2026-10-31T06:00:00.000Z", reportedAt: "2026-10-31T06:00:00.000Z" }), updatedAt: "2026-10-31T06:00:00.000Z" }]
    });
    const result = status([e, d, c, b, a], value, new Map([["clipboard:planOpen0001", { progressPercentage: 50, isCompleted: false, executionStatus: "IN_PROGRESS" }]]));
    expect(result[a.id]!.status).toBe("ANSWERED");
    // A later PENDING that opened no request holds nothing.
    expect(result[b.id]!.status).toBe("ANSWERED");
    // Its open plan no longer holds a dropped message (operator 11/11 nous_msg:81e47d83).
    expect(result[c.id]).toMatchObject({ status: "ANSWERED", planId: "clipboard:planOpen0001" });
    expect(result[d.id]!.status).toBe("NOT_DONE");
    expect(result[e.id]!.status).toBe("IN_PROGRESS");
    // done: true on the close wrote a Done record named by the message: Done.
    expect(status([a], links({ ...value, done: [done(`nous:done:${a.id}`, { summary: "Closed and done." })] }))[a.id]).toMatchObject({ status: "DONE", doneSummary: "Closed and done." });
  });

  // Operator 11/11 09:10 BKK (nous_msg:bd13f6b2): Requests cover only what waits in the chat; the Plans tab tracks plans.
  it("reads a message held only by its open plan Answered, also a PENDING one", () => {
    const [a, b, c] = [message(1, "Ολοκληρώθηκε;"), message(2, "Άσ' το"), message(3, "Τρέξε το βήμα")];
    const plan = "clipboard:planOpen0003";
    const value = links({
      turns: [{ turnId: "turn:1", endedAt: "2026-10-31T06:00:00.000Z", outcomes: [{ summary: "At 40%", outcome: "SELF", answerOnly: true, messageIds: [a.id], plan },
        { summary: "Running", outcome: "PENDING", messageIds: [b.id, c.id], plan }] }],
      notes: [{ key: "request-done:open:dropped3", text: JSON.stringify({ messageId: b.id, summary: "x", turnId: "turn:1", openedAt: "2026-10-31T06:00:00.000Z",
        reportedAt: "2026-10-31T06:00:00.000Z", closedAt: "2026-10-31T07:00:00.000Z", closedReason: "DROPPED: no" }), updatedAt: "2026-10-31T07:00:00.000Z" }] });
    const result = status([c, b, a], value, new Map([[plan, { progressPercentage: 40, isCompleted: false, executionStatus: "IN_PROGRESS" }]]));
    expect([a, b, c].map((entry) => result[entry.id]!.status)).toEqual(["ANSWERED", "ANSWERED", "ANSWERED"]);
    expect(result[c.id]).toMatchObject({ planId: plan, planPercent: 40 });
  });

  // Operator 31/10 16:12 BKK: 99 messages read In progress from PENDING outcomes no open request ever tracked (11 open requests existed); 6/11: they read Not done.
  it("reads an untracked PENDING as not done, also one an old turn's answer spread over several messages, and an open request's as In progress", () => {
    const [a, b, c] = [message(1, "Πρώτο"), message(2, "Δεύτερο"), message(3, "Τρίτο")];
    const value = links({ answers: [answer("turn:old", [a.id, b.id, c.id], "2026-10-31T03:30:00.000Z")],
      turns: [{ turnId: "turn:old", endedAt: "2026-10-31T03:30:00.000Z", outcomes: [{ summary: "Running", outcome: "PENDING" }] }],
      notes: [{ key: "request-done:open:tracked1", text: JSON.stringify({ messageId: c.id, summary: "Τρίτο", turnId: "turn:old", openedAt: "2026-10-31T03:30:00.000Z",
        reportedAt: "2026-10-31T03:30:00.000Z" }), updatedAt: "2026-10-31T03:30:00.000Z" }] });
    const result = status([c, b, a], value);
    expect([result[a.id]!.status, result[b.id]!.status, result[c.id]!.status]).toEqual(["NOT_DONE", "NOT_DONE", "IN_PROGRESS"]);
  });

  // Operator 6/11 13:21 BKK (nous_msg:2c610048): an answer does NOT mean completion; only a pure question reads Answered.
  it("reads Answered only for a pure question, Not done for an answer without an outcome or a task without Done, Done by its record, Answered once dropped", () => {
    const [a, b, c, d, e] = [message(1, "Βάλε background διαστημόπλοιο"), message(2, "Τι ώρα είναι;"), message(3, "Ανάθεσε στον Bruno"), message(4, "Φτιάξε το"), message(5, "Άσ' το")];
    const value = links({ answers: [answer("turn:1", [a.id, b.id, c.id, d.id, e.id], "2026-10-31T06:00:00.000Z")],
      turns: [{ turnId: "turn:1", endedAt: "2026-10-31T06:00:00.000Z", outcomes: [{ summary: "Answered", outcome: "SELF", answerOnly: true, messageIds: [b.id] },
        { summary: "Bruno", outcome: "SELF", messageIds: [c.id] }, { summary: "Fixed", outcome: "SELF", messageIds: [d.id] }, { summary: "Dropped", outcome: "PENDING", messageIds: [e.id] }]}],
      done: [done(`nous:done:${d.id}`, { summary: "Fixed." })],
      notes: [{ key: "request-done:open:dropped1", text: JSON.stringify({ messageId: e.id, summary: "x", turnId: "turn:1", openedAt: "2026-10-31T06:00:00.000Z",
        reportedAt: "2026-10-31T06:00:00.000Z", closedAt: "2026-10-31T07:00:00.000Z", closedReason: "DROPPED: the operator dropped it" }), updatedAt: "2026-10-31T07:00:00.000Z" }] });
    const result = status([e, d, c, b, a], value);
    expect([a, b, c, d, e].map((entry) => result[entry.id]!.status)).toEqual(["NOT_DONE", "ANSWERED", "NOT_DONE", "DONE", "ANSWERED"]);
  });

  it("pages every message by status and counts them all", async () => {
    const repository = new InMemoryNousRepository();
    const added: NousMessage[] = [];
    for (const content of ["one", "two", "three"]) added.push(await repository.addMessage({ ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content }));
    const at = new Date(Date.now() + 1_000).toISOString();
    await repository.addTurnFacts({ turnId: "nous_turn:pg000001", ownerUserId: owner, reason: "OPERATOR", status: "DONE", tools: {}, planPoints: 0, startedAt: at, endedAt: at,
      outcomes: [{ summary: "Running", outcome: "PENDING", messageIds: [added[0]!.id, added[2]!.id] }], model: null, effort: null, costUsd: null, tokens: null, goalId: null, error: null });
    for (const [n, entry] of [added[0]!, added[2]!].entries()) await repository.setNote(owner, `request-done:open:00000000000000000000000${n}`,
      JSON.stringify({ messageId: entry.id, summary: entry.content, turnId: "nous_turn:pg000001", openedAt: at, reportedAt: at }));
    const requests = createNousRequests({ repository, notifications: { list: async () => [] }, plan: async () => null });
    const counts = { DONE: 0, ANSWERED: 0, IN_PROGRESS: 2, WAITS_FOR_YOU: 0, NOT_DONE: 0, NOT_ANSWERED: 1 };
    expect(await requests.page(owner, { limit: 1, status: "IN_PROGRESS" })).toEqual({ requests: [expect.objectContaining({ messageId: added[2]!.id })], hasMore: true, counts });
    expect(await requests.page(owner, { limit: 1, status: "IN_PROGRESS", before: added[2]!.id })).toEqual({ requests: [expect.objectContaining({ messageId: added[0]!.id })], hasMore: false, counts });
    expect((await requests.page(owner, { limit: 5, status: "NOT_ANSWERED" })).requests.map((request) => request.text)).toEqual(["two"]);
    expect((await requests.page(owner, { limit: 5, before: "nous_msg:unknown00001" })).requests).toEqual([]);
  });

  // Operator 6/11 13:02 BKK: search every request, open and closed, by any of the words, accents and case folded, with the status filter.
  it("searches by any of the words without accents, with the status filter, counts and paging", async () => {
    const repository = new InMemoryNousRepository();
    const added: NousMessage[] = [];
    for (const content of ["Δες τα αιτήματα", "Azure VM", "κάτι άλλο", "Μετέφερε το site"]) added.push(await repository.addMessage({ ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content }));
    const at = new Date(Date.now() + 1_000).toISOString();
    await repository.setNote(owner, "request-done:open:000000000000000000000001", JSON.stringify({ messageId: added[1]!.id, summary: "Azure", turnId: "nous_turn:sr000001", openedAt: at, reportedAt: at }));
    const record = done(`nous:done:${added[3]!.id}`, { request: "site", summary: "Ανέβηκε στο AZURE" }, at);
    const requests = createNousRequests({ repository, notifications: { list: async () => [record] }, plan: async () => null });
    const texts = async (options: Partial<Parameters<typeof requests.page>[1]>) => (await requests.page(owner, { limit: 10, ...options })).requests.map((request) => request.text);
    expect(await texts({ q: "αιτηματα" })).toEqual(["Δες τα αιτήματα"]);
    expect(await texts({ q: "  azure   ΑΙΤΗΜΑΤΑ " })).toEqual(["Μετέφερε το site", "Azure VM", "Δες τα αιτήματα"]);
    expect(await texts({ q: "azure", status: "IN_PROGRESS" })).toEqual(["Azure VM"]);
    expect((await requests.page(owner, { limit: 10, q: "azure" })).counts).toEqual({ DONE: 1, ANSWERED: 0, IN_PROGRESS: 1, WAITS_FOR_YOU: 0, NOT_DONE: 0, NOT_ANSWERED: 0 });
    expect(await requests.page(owner, { limit: 1, q: "azure" })).toMatchObject({ requests: [{ text: "Μετέφερε το site" }], hasMore: true });
    expect(await texts({ limit: 1, q: "azure", before: added[3]!.id })).toEqual(["Azure VM"]);
    expect(await texts({ q: "τιποτα" })).toEqual([]);
  });

  // CPU report 12/11: the operator messages stay between derives (only the newest are read again), calls that meet share one derive.
  it("reads as a fresh instance after a new message, answer, outcome and Done record, and shares one derive between calls that meet", async () => {
    const repository = new InMemoryNousRepository();
    const records: SpaceNotification[] = [];
    const deps = { repository, notifications: { list: async () => records }, plan: async () => null };
    const requests = createNousRequests(deps);
    const fresh = () => createNousRequests(deps).page(owner, { limit: 10 });
    const add = (content: string) => repository.addMessage({ ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content });
    const first = await add("Φτιάξε το bug");
    expect(await requests.page(owner, { limit: 10 })).toEqual(await fresh());
    const second = await add("Ανέβασε το site");
    await repository.addMessage({ ownerUserId: owner, turnId: "nous_turn:fx000001", kind: "ANSWER", status: "DONE", content: "Ok", meta: { reason: "OPERATOR", startedAt: second.createdAt, replyTo: [second.id] } });
    const at = new Date(Date.now() + 1_000).toISOString();
    await repository.addTurnFacts({ turnId: "nous_turn:fx000001", ownerUserId: owner, reason: "OPERATOR", status: "DONE", tools: {}, planPoints: 0, startedAt: at, endedAt: at,
      outcomes: [{ summary: "Uploaded", outcome: "SELF", messageIds: [second.id] }], model: null, effort: null, costUsd: null, tokens: null, goalId: null, error: null });
    records.push(done(`nous:done:${first.id}`, { summary: "Fixed." }, at));
    const read = vi.spyOn(repository, "listOperatorMessages");
    const after = await requests.page(owner, { limit: 10 });
    expect(after).toEqual(await fresh());
    expect(after.requests.map((request) => [request.messageId, request.status])).toEqual([[second.id, "NOT_DONE"], [first.id, "DONE"]]);
    expect(read.mock.calls[0]![1]).toMatchObject({ since: expect.any(String) });
    read.mockClear();
    const [all, doneOnly] = await Promise.all([requests.page(owner, { limit: 10 }), requests.page(owner, { limit: 10, status: "DONE" })]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(doneOnly).toEqual({ ...all, requests: [all.requests[1]] });
    expect(await requests.since(owner, second.createdAt)).toEqual(all.requests.filter((request) => request.createdAt >= second.createdAt));
    expect(await requests.since(owner, "2999-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("strips the files block from a message's text", () => {
    const result = deriveNousRequests([message(1, "Δες αυτό\n\n[[Attachments: 1 file]]\n- a.png")], links(), new Map());
    expect(result[0]!.text).toBe("Δες αυτό");
  });

  it("takes the first answer in list order that replies to a message or started after it, also when startedAt runs out of order", () => {
    const [a, b] = [message(1, "Πρώτο"), message(3, "Δεύτερο")];
    // Listed by createdAt; the first one started late, the second early: only the first started after b.
    const value = links({ answers: [{ turnId: "turn:x", createdAt: "2026-10-31T04:00:00.000Z", startedAt: "2026-10-31T03:30:00.000Z", replyTo: [] },
      { turnId: "turn:y", createdAt: "2026-10-31T05:00:00.000Z", startedAt: "2026-10-31T02:00:00.000Z", replyTo: [a.id], interim: true as const },
      answer("turn:z", [a.id], "2026-10-31T06:00:00.000Z")] });
    const result = status([b, a], value);
    expect(result[a.id]).toMatchObject({ answeredAt: "2026-10-31T04:00:00.000Z", repliedAt: "2026-10-31T04:00:00.000Z" });
    expect(result[b.id]).toMatchObject({ answeredAt: "2026-10-31T04:00:00.000Z" });
    expect(deriveNousRequests([message(9, "Μετά")], value, new Map())[0]!.answeredAt).toBeUndefined();
  });
});
