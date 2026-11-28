// Operator 27/11 (nous_msg:766ca4f6): a Crosschq ID.me identity check from Mail Copilot waited an hour for Nous, Nous's card on it was refused by a
// rule that folds identity mail into a list, and the operator saw nothing until the hour ended.
import { describe, expect, it, vi } from "vitest";
import { eventSchema, makeNeedsYouAsk, needsOperatorHandsText, type NotificationRaiseInput, type Pane, type Room } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { SpaceEventBus, makeSpaceId } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";
import { cardStems, createNousPaneNotices, ruleRecommendation } from "../src/nous/pane-notices.js";
import { cardAsk, createNousTools, noQuestionRefusal, type NousToolDeps } from "../src/nous/tools.js";

const owner = "user:operator";
const ctx = { owner, turnId: "turn:1", callId: "call:1", traceId: "trace:1" };
const room = { id: "room:felix", name: "Felix", kind: "WORKSPACE", ownerUserId: owner } as Room;
const pane = { id: "pane:felix-bob", roomId: room.id, title: "Bob", paneName: "Bob", mode: "TERMINAL", isClosed: false } as unknown as Pane;
const ID_ME = "Υπενθύμιση από Crosschq να επαληθεύσεις την ταυτότητά σου μέσω ID.me (πιθανώς έλεγχος στοιχείων για πρόσληψη). Μένει στο inbox: απαιτεί δική σου ενέργεια.";
const RULE = "Learned rule 28/10: Mail Copilot NEEDS_USER cards on the operator's personal, identity or government mail → \"I handled it\"; fold them into the one list";

function fixture() {
  const notifications = createNotificationService({ repository: new InMemorySpaceNotificationsRepository(), eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
    recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
    nous: { held: async () => true, raised: () => undefined, holdsCopilotQuestions: async () => true } });
  const mail = (body: string): NotificationRaiseInput => ({ ownerUserId: owner, roomId: room.id, paneId: pane.id, source: "MAIL_COPILOT", kind: "NEEDS_USER", severity: "ATTENTION",
    title: "Mail Copilot needs you (Mail Copilot 2)", body, link: {}, dedupeKey: `mail-copilot:${makeSpaceId("mailevt")}`, telegram: null,
    payload: { ask: makeNeedsYouAsk("What should Mail Copilot do with this mail?", { kind: "MAIL_FIX", account: "a@b.gr", threadId: "t1" }, ["I handled it", "Ignore it"]) } });
  const shown = async () => (await notifications.list(owner, { status: "NEEDS_YOU", limit: 50 })).map((item) => item.id);
  return { notifications, mail, shown };
}

describe("a question only the operator's own person can answer is never held (27/11)", () => {
  it("knows an identity check and their own interview or test by its words, not a sign-in or an ordinary mail", () => {
    for (const text of [ID_ME, "Complete your KYC with a passport photo and a selfie", "Your Crosschq interview is on Friday", "Take the online coding test by Monday", "Κλείσε τη συνέντευξη"]) {
      expect(needsOperatorHandsText(text)).toBe(true);
    }
    for (const text of ["Hetzner invoice 085001365346 is due", "Sign in to NBG Business", "Example newsletter from Exampleco"]) expect(needsOperatorHandsText(text)).toBe(false);
  });

  it("shows a copilot NEEDS_USER identity check in Needs you at once; an ordinary mail question still waits for Nous", async () => {
    const f = fixture();
    const idme = await f.notifications.raise(f.mail(ID_ME), { realert: true });
    expect(idme.payload.heldForNous).toBeUndefined();
    const plain = await f.notifications.raise(f.mail("Hetzner sent invoice 085001365346 for 129,50 €."), { realert: true });
    expect(plain.payload.heldForNous).toBeTruthy();
    expect(await f.shown()).toEqual([idme.id]);
    // A refresh of a question held before this fix leaves the hold once its words are an identity check.
    const again = await f.notifications.raise({ ...f.mail(ID_ME), dedupeKey: plain.dedupeKey }, { realert: true });
    expect(again.id).toBe(plain.id);
    expect(again.payload.heldForNous).toBeUndefined();
  });

  it("never answers an identity check with the operator's rule; a rule that only groups mail into a list answers no question", async () => {
    const rule = { id: "space_memory:a0e41759", title: RULE, body: RULE, rule: true, stems: cardStems(RULE) };
    const question = "Mail Copilot: what should it do with the Crosschq ID.me identity verification mail?";
    // The incident: the rule names "I handled it", so without the hands check it was held as "Your rule already answers this".
    expect(ruleRecommendation({ question, options: ["I handled it", "Ignore it"] }, [rule])).toMatchObject({ option: "I handled it" });
    const grouping = "Fold Mail Copilot's personal, identity and government mail into the one list";
    expect(ruleRecommendation({ question, options: ["I handled it", "Ignore it"] }, [{ id: "space_memory:group", title: grouping, body: grouping }])).toBeNull();
    const notify = vi.fn(async () => ({ ok: true, display: "Sent the card", result: "ok" }));
    const tools = createNousTools({ rooms: async () => [room], listPanes: async () => [pane], paneNotices: { notify }, cardMemory: async () => [rule] } as unknown as NousToolDeps);
    const outcome = await tools.execute("space_notify_operator", { room: "Felix", pane: "Bob", title: "Crosschq identity check", checked: ["Mail: Crosschq reminder, ID.me link unopened"],
      items: [{ text: "Crosschq asks you to verify your identity through ID.me for a hiring check", question, options: ["I handled it", "Ignore it"], recommended: "I handled it" }] }, ctx);
    expect(outcome).toMatchObject({ ok: true });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("releases the held question a refused card names to Needs you at once", async () => {
    const f = fixture();
    const held = await f.notifications.raise(f.mail("Hetzner sent invoice 085001365346 for 129,50 €."), { realert: true });
    expect(held.payload.heldForNous).toBeTruthy();
    const tools = createNousTools({ rooms: async () => [room], listPanes: async () => [pane], notifications: f.notifications,
      paneNotices: createNousPaneNotices({ notifications: f.notifications }) } as unknown as NousToolDeps);
    // Options with no recommended one: pane-notices refuses the card.
    const refused = await tools.execute("space_notify_operator", { room: "Felix", pane: "Bob", title: "Hetzner invoice", checked: ["Hetzner robot: invoice open"],
      items: [{ text: "Hetzner invoice 085001365346: pay it now?", question: "Pay Hetzner invoice 085001365346 now?", options: ["Pay now", "Not yet"], ref: held.id }] }, ctx);
    expect(refused).toMatchObject({ ok: false, refused: true });
    expect(refused.result).toContain(`${held.id} now shows in the operator's Needs you`);
    const after = (await f.notifications.get(owner, held.id))!;
    expect(after.payload.heldForNous).toBeUndefined();
    expect(after.payload.releasedFromNous).toBeTruthy();
    expect(await f.shown()).toContain(held.id);
  });

  it("never lets Nous close an identity check with a reason, held for it or shown (notification:f04ea31b closed unanswered at 08:49)", async () => {
    const f = fixture();
    const idme = await f.notifications.raise(f.mail(ID_ME), { realert: true });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    for (const held of [false, true]) {
      // The incident card was held before this fix; a held one is fetched as it was then.
      const get = async (o: string, id: string) => { const item = await f.notifications.get(o, id); return item && held ? { ...item, payload: { ...item.payload, heldForNous: until } } : item; };
      const tools = createNousTools({ rooms: async () => [room], listPanes: async () => [pane], notifications: { ...f.notifications, get } } as unknown as NousToolDeps);
      const outcome = await tools.execute("space_resolve_notification", { notification: idme.id, reason: "Rule 28/10: identity mail goes into the one list" }, ctx);
      expect(outcome).toMatchObject({ ok: false, refused: true });
      expect(outcome.result).toContain("the operator's own identity check");
    }
    expect((await f.notifications.get(owner, idme.id))!.status).toBe("OPEN");
  });

  it("takes an identity check as the operator's act, however the card words it (the ID.me card took 3 tries)", () => {
    expect(noQuestionRefusal(cardAsk({ title: "Crosschq identity check", body: null, payload: { items: [{ text: "Crosschq: the ID.me identity verification for the hiring check is still pending, link in the mail" }] } }))).toBeNull();
    expect(noQuestionRefusal(cardAsk({ title: "Hetzner invoice", body: null, payload: { items: [{ text: "Hetzner invoice 085001365346 arrived" }] } }))).toContain("no question and no act");
  });
});
