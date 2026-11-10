// 2/11 (operator 10:16 BKK «κλεισε οτι μπορεις να κανεις εσυ -- και αφησε μονο οτι πραγματικα θες απο εμας!! και φτιαξε/αναβαθμησε τον κωδικα σου
// ωστε να μην ξανασυμβει αυτο!!»: ~32 Needs you cards, about 15 his): every card Nous can handle goes to Nous first, the same topic is one card,
// a Mail flag the operator always handles himself is never raised, and the daily review counts what reached him.
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eventSchema, isNousFirstCard, makeNeedsYouAsk, sameNeedsYouTopic, type NotificationRaiseInput, type Pane, type Room, type SpaceNotification } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { makeSpaceId, SpaceEventBus } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";
import { registerNousPaneBoardRoutes } from "../src/nous/pane-board-routes.js";
import { baseRateRecommendation } from "../src/nous/pane-notices.js";
import { heldForNousNote, heldQuestionItem } from "../src/nous/copilot-questions.js";
import { itemActed } from "../src/nous/turn-items.js";
import { needsYouLines } from "../src/nous/daily-review.js";
import { parseBody, parseQuery } from "../src/route-parsing.js";

const owner = "user:operator";
const room = { id: "room:alpha0001", name: "Alpha" } as Room;
const pane = { id: "pane:emma00001", paneName: "Emma", title: "Emma", roomId: room.id } as Pane;

function fixture(ledger: Array<{ source: string; kind: string; answer: string }> = []) {
  const raised: SpaceNotification[] = [];
  const inbox: Array<{ key: string; line: string }> = [];
  const late: { answers?: ReturnType<typeof registerNousPaneBoardRoutes> } = {};
  const notifications = createNotificationService({ repository: new InMemorySpaceNotificationsRepository(), eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
    recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
    nous: { held: async () => false, raised: (item) => { raised.push(item); }, holdsCopilotQuestions: async () => true,
      autoAnswer: async (record) => (await late.answers!.autoAnswer(record))?.notification ?? null, recommend: async (card) => baseRateRecommendation(ledger, card) } });
  late.answers = registerNousPaneBoardRoutes(Fastify(), { routeOptions: {}, owner: async () => owner, parseBody, parseQuery, rememberAlways: async () => {}, alwaysKinds: async () => [],
    assertPerson: () => {}, inbox: async (_owner: string, key: string, line: string) => { inbox.push({ key, line }); }, board: { board: vi.fn(), tick: vi.fn() } as never, notifications, pane: async () => ({ room, pane }),
    answerPrompt: vi.fn(), answerCopilot: vi.fn(), send: vi.fn(), sendToPane: vi.fn(), decideCopilot: vi.fn() } as never);
  const card = (over: Partial<NotificationRaiseInput>): NotificationRaiseInput => ({ ownerUserId: owner, roomId: room.id, paneId: pane.id, source: "MAIL_COPILOT", kind: "NEEDS_USER",
    severity: "ATTENTION", title: "Mail Copilot needs you (Emma)", body: "", link: {}, dedupeKey: `mail-copilot:${makeSpaceId("mailev")}`, telegram: null,
    payload: { ask: makeNeedsYouAsk("What should Mail Copilot do with this mail?", { kind: "MAIL_FIX", account: "a@b.gr", threadId: "t1" }, ["I handled it", "Ignore it"]) }, ...over });
  const waiting = async () => notifications.list(owner, { status: "NEEDS_YOU", limit: 200 });
  return { notifications, raised, inbox, card, waiting };
}

describe("Needs you keeps only what needs the operator (2/11)", () => {
  it("rule 1: every copilot NEEDS_USER and every agent's needs-you go to Nous first; Nous's own cards and hands kinds do not", () => {
    for (const source of ["MAIL_COPILOT", "JOB_COPILOT", "DESIGN", "SECURITY_COPILOT"] as const) expect(isNousFirstCard({ source, kind: "NEEDS_USER", dedupeKey: "k" })).toBe(true);
    expect(isNousFirstCard({ source: "AGENT", kind: "NEEDS_YOU", dedupeKey: "agent:needs-you:pane:x" })).toBe(true);
    expect(isNousFirstCard({ source: "NOUS", kind: "NEEDS_HANDS", dedupeKey: "nous:pane:x" })).toBe(false);
    expect(isNousFirstCard({ source: "BROWSER_HANDOFF", kind: "HANDOFF_REQUESTED", dedupeKey: "k" })).toBe(false);
    expect(isNousFirstCard({ source: "SECURITY_COPILOT", kind: "SECURITY_REVIEW", dedupeKey: "k" })).toBe(false);
  });

  it("rule 1: an agent's needs-you is held out of Needs you, stays held when the agent asks again, and a text to its pane is an act on it", async () => {
    const f = fixture();
    const ask = (question: string) => f.card({ source: "AGENT", kind: "NEEDS_YOU", title: "Emma needs you", body: question, dedupeKey: `agent:needs-you:${pane.id}`,
      payload: { ask: { question, answer: { kind: "PANE" } } } });
    const first = await f.notifications.raise(ask("Paste the Baseten API key from the one-time link"), { realert: true });
    expect(first.payload.heldForNous).toBeTruthy();
    expect(await f.waiting()).toEqual([]);
    // The second ask refreshes the same record: still held (a raise replaces the payload), and Nous hears the new ask.
    const again = await f.notifications.raise(ask("Open the Baseten link and paste the key"), { realert: true });
    expect(again).toMatchObject({ id: first.id, body: "Open the Baseten link and paste the key", payload: { heldForNous: first.payload.heldForNous } });
    expect(await f.waiting()).toEqual([]);
    expect(f.raised.map((item) => item.body)).toEqual(["Paste the Baseten API key from the one-time link", "Open the Baseten link and paste the key"]);
    // Its held line tells Nous to do it or have an agent do it, and a text to the pane by its id settles the turn's item.
    expect(heldForNousNote(again)).toContain(`space_send_to_pane {"pane":"${pane.id}"}`);
    const item = heldQuestionItem(again, "line");
    expect(itemActed(item, [{ name: "space_send_to_pane", args: { room: room.id, pane: pane.id, text: "The key is in the Vault" }, ok: true, subjects: [] }])).toBe(true);
    expect(itemActed(item, [{ name: "space_send_to_pane", args: { room: room.id, pane: "pane:other0001", text: "x" }, ok: true, subjects: [] }])).toBe(false);
  });

  it("rule 2: a second card about the same billing account refreshes the first; resolving either key closes it", async () => {
    const f = fixture();
    const one = await f.notifications.raise(f.card({ body: "Google Cloud billing account 01A2B3-C4D5E6-F7G8H9: the payment failed, update the card", link: { target: "thread:a@b.gr:t1" } }));
    const two = await f.notifications.raise(f.card({ body: "Billing account 01A2B3-C4D5E6-F7G8H9 will be suspended in 3 days", link: { target: "thread:a@b.gr:t2" } }));
    expect(two.id).toBe(one.id);
    expect(two.body).toContain("suspended");
    expect(two.payload.mergedKeys).toEqual([expect.stringMatching(/^mail-copilot:/)]);
    // Nous hears the update of the card it holds; the operator gets no second card.
    expect(f.raised.map((item) => item.id)).toEqual([one.id, one.id]);
    // Another topic on the same pane stays its own card.
    const other = await f.notifications.raise(f.card({ body: "Your example.invalid domain expires on 20/11: renew it", link: { target: "thread:a@b.gr:t3" } }));
    expect(other.id).not.toBe(one.id);
    expect(await f.notifications.resolve(owner, (two.payload.mergedKeys as string[])[0]!)).toBe(1);
    expect((await f.notifications.get(owner, one.id))?.status).toBe("RESOLVED");
    expect((await f.notifications.get(owner, other.id))?.status).toBe("OPEN");
  });

  it("rule 2: the topic test: same thread or page, a shared id or host, or most words; never across panes, sources or into questions", () => {
    const base = { source: "MAIL_COPILOT" as const, kind: "NEEDS_USER", paneId: pane.id, title: "Mail Copilot needs you (Emma)" };
    expect(sameNeedsYouTopic({ ...base, body: "a", link: { target: "thread:x:1" } }, { ...base, body: "b", link: { target: "thread:x:1" } })).toBe(true);
    expect(sameNeedsYouTopic({ ...base, body: "AWS case 172839465 opened" }, { ...base, body: "Reply on AWS case 172839465 waiting" })).toBe(true);
    expect(sameNeedsYouTopic({ ...base, body: "papaki.gr says example.invalid expires" }, { ...base, body: "Renew example.invalid before Friday" })).toBe(true);
    expect(sameNeedsYouTopic({ ...base, body: "Maria (maria@gmail.com) asks to move Friday's lunch" }, { ...base, body: "Your accountant (nikos@gmail.com) needs the VAT receipts" })).toBe(false);
    expect(sameNeedsYouTopic({ ...base, body: "AWS case 172839465 opened" }, { ...base, paneId: "pane:other0001", body: "AWS case 172839465 opened" })).toBe(false);
    expect(sameNeedsYouTopic({ ...base, kind: "QUESTION", body: "AWS case 172839465" }, { ...base, kind: "QUESTION", body: "AWS case 172839465" })).toBe(false);
  });

  it("rule 4: a Mail flag whose base rate is \"I handled it\" (2 answers or more) raises no card and reaches Nous's inbox to act on (5/11)", async () => {
    const answer = { source: "NEEDS_YOU:MAIL_COPILOT", kind: "MAIL_COPILOT:NEEDS_USER", answer: "I handled it" };
    const once = fixture([answer]);
    // One answer is no habit yet: the card is held for Nous like any other.
    expect((await once.notifications.raise(once.card({ body: "example.invalid expires on 20/11" }))).status).toBe("OPEN");
    const f = fixture([answer, answer]);
    const card = await f.notifications.raise(f.card({ body: "Auth0 for Startups approved: activate by 5/11" }));
    expect(card).toMatchObject({ status: "ACKED", payload: { baseRate: { option: "I handled it", answers: 2 }, answer: { text: "I handled it", routed: "NOUS", by: "HANDLED" } } });
    expect(f.raised).toEqual([]);
    expect(await f.waiting()).toEqual([]);
    // The operator's past answers were about earlier mails: Nous gets this one with its summary, account and thread (5/11: Auth0, E2B, Temu closed unread).
    expect(f.inbox).toEqual([{ key: `mail-handled:${card.id}`, line: expect.stringContaining("on a@b.gr, thread t1: Auth0 for Startups approved: activate by 5/11.") }]);
    // Other kinds keep R16-9's five answers.
    expect(baseRateRecommendation([answer, answer].map((row) => ({ ...row, source: "NEEDS_YOU:AGENT", kind: "AGENT:NEEDS_YOU" })), { source: "AGENT", kind: "NEEDS_YOU", options: ["I handled it"] })).toBeNull();
  });

  it("rule 6: the daily review counts Needs you cards, what reached the operator and what closed without him", () => {
    const at = "2026-11-02T03:00:00.000Z";
    const record = (over: Partial<SpaceNotification>): SpaceNotification => ({ id: `notification:${makeSpaceId("n").slice(2)}`, ownerUserId: owner, roomId: room.id, paneId: pane.id,
      source: "MAIL_COPILOT", kind: "NEEDS_USER", severity: "ATTENTION", title: "t", body: "", link: {}, dedupeKey: "k", status: "OPEN", payload: {}, createdAt: at, updatedAt: at,
      readAt: null, ackedAt: null, resolvedAt: null, ...over }) as SpaceNotification;
    const lines = needsYouLines([
      record({ payload: { heldForNous: { until: at } }, status: "RESOLVED" }),
      record({ source: "AGENT", kind: "NEEDS_YOU", payload: { heldForNous: { until: at } }, status: "RESOLVED" }),
      record({ status: "ACKED", payload: { answer: { by: "HANDLED", routed: "NOUS" } } }),
      record({ source: "NOUS", kind: "NEEDS_HANDS" }),
      record({ kind: "MAIL_RECEIVED", severity: "INFO" }),
      record({ createdAt: "2026-10-30T00:00:00.000Z" })
    ], "2026-11-01T03:00:00.000Z");
    expect(lines[0]).toContain("Needs you cards raised: 4; reached the operator: 1; closed without him: 3 (3 never reached him: MAIL_COPILOT 2, AGENT 1); Mail flags his \"I handled it\" base rate gave you to act on: 1; still waiting on him: 1.");
  });
});
