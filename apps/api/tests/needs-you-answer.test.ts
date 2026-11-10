// Needs you as questions (operator request 2026-10-27, plan clipboard:5AQvaoSR-IZa): the operator answers a needs-you record from its card;
// its ask routes the answer (a pane's next prompt, a copilot's question or decision, Mail Copilot's Send to AI, Nous, or a plain acknowledgement).
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { eventSchema, makeNeedsYouAsk, type NeedsYouAsk, type NousMessage, type Pane, type Room } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { makeSpaceId, SpaceConflictError, SpaceEventBus, SpaceNotFoundError } from "@space/runtime";
import { ZodError } from "zod";
import { createNotificationService } from "../src/notifications/service.js";
import { registerNousPaneBoardRoutes, type PaneBoardRouteDeps } from "../src/nous/pane-board-routes.js";
import { parseBody, parseQuery } from "../src/route-parsing.js";

const owner = "user:operator";
const room = { id: "room:alpha0001", name: "Alpha" } as Room;
const pane = { id: "pane:andy0001", paneName: "Andy", title: "Andy", roomId: room.id } as Pane;

describe("answering a needs-you record from its card", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  async function fixture(person = true, phone = false) {
    const late: { answers?: ReturnType<typeof registerNousPaneBoardRoutes> } = {};
    const always: Array<{ key: string; label: string }> = [];
    const clock = { quiet: false };
    const notifications = createNotificationService({ repository: new InMemorySpaceNotificationsRepository(), eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
      nous: { held: async () => false, raised: () => {}, autoAnswer: async (record) => (await late.answers!.autoAnswer(record))?.notification ?? null } });
    const deps = {
      answerPrompt: vi.fn<PaneBoardRouteDeps["answerPrompt"]>(),
      answerCopilot: vi.fn<PaneBoardRouteDeps["answerCopilot"]>(async () => "Answered; the copilot continues with it."),
      send: vi.fn<PaneBoardRouteDeps["send"]>(async () => ({}) as NousMessage),
      sendToPane: vi.fn<PaneBoardRouteDeps["sendToPane"]>(async () => ({ ok: true, display: "Sent to Andy", result: "ok" })),
      decideCopilot: vi.fn<PaneBoardRouteDeps["decideCopilot"]>(async () => "The mail copilot's review was approved."),
      requestMailFix: vi.fn<NonNullable<PaneBoardRouteDeps["requestMailFix"]>>(async () => {}),
      briefCopilot: vi.fn<NonNullable<PaneBoardRouteDeps["briefCopilot"]>>(async () => "The Freelance Copilot has the brief."),
      ledger: vi.fn<NonNullable<PaneBoardRouteDeps["ledger"]>>(async () => {}),
      inbox: vi.fn<NonNullable<PaneBoardRouteDeps["inbox"]>>(async () => {})
    };
    const app = Fastify();
    apps.push(app);
    // What the mobile gate sets for a paired phone's request (apps/api/src/mobile/gate.ts).
    if (phone) app.addHook("onRequest", async (request) => { request.mobileDevice = { id: "appdev:phone0001", scopes: ["read", "act"], person: true, rule: { scope: "act", person: true } }; });
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof SpaceNotFoundError ? 404 : error instanceof SpaceConflictError ? 409 : error instanceof ZodError ? 422
      : (error as { statusCode?: number }).statusCode ?? 500).send({ error: error.message }));
    late.answers = registerNousPaneBoardRoutes(app, { routeOptions: {}, owner: async () => owner, parseBody, parseQuery,
      rememberAlways: async (_owner, kind) => { always.push(kind); }, alwaysKinds: async () => always.map((kind) => kind.key), quiet: async () => clock.quiet,
      assertPerson: () => { if (!person) throw Object.assign(new Error("Only the operator answers."), { statusCode: 403 }); },
      board: { board: vi.fn(), tick: vi.fn() } as never, notifications,
      pane: async (_owner, paneId) => paneId === pane.id ? { room, pane } : null, ...deps });
    const raise = async (ask: NeedsYouAsk | null, kind = "NEEDS_YOU", source: "AGENT" | "MAIL_COPILOT" | "FREELANCE_COPILOT" | "NOUS" = "AGENT", link: Record<string, string> = {}) => (await notifications.raise({ ownerUserId: owner, roomId: room.id, paneId: pane.id, source, kind,
      severity: "ATTENTION", title: "Andy needs you", body: "Pick the colour\nNeeds: red or blue", link, dedupeKey: `test:${makeSpaceId("k")}`, payload: ask ? { ask } : {} })).id;
    const answer = (id: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: `/api/notifications/${id}/answer`, payload, headers });
    return { notifications, deps, raise, answer, always, clock };
  }

  it("from a paired phone, answers bound for a pane or a copilot question go to Nous and type nothing (Nous Pro 1b-4b, review P1-1)", async () => {
    const f = await fixture(true, true);
    const pane = await f.raise({ question: "Pick the colour", options: ["red", "blue"], recommended: "red", answer: { kind: "PANE" } });
    expect((await f.answer(pane, { option: "red" })).json()).toMatchObject({ routed: "NOUS" });
    expect(f.deps.sendToPane).not.toHaveBeenCalled();
    expect(f.deps.send).toHaveBeenLastCalledWith(owner, expect.stringContaining("Space typed nothing into the pane"), expect.objectContaining({ person: true, mobile: { device: "appdev:phone0001", scopes: ["read", "act"] } }));
    const question = await f.raise({ question: "Which CV?", options: ["A", "B"], recommended: "A", answer: { kind: "COPILOT_QUESTION", copilot: "JOB", questionId: "jobq:1" } });
    expect((await f.answer(question, { option: "A" })).json()).toMatchObject({ routed: "NOUS" });
    expect(f.deps.answerCopilot).not.toHaveBeenCalled();
    // A copilot decision keeps its route; the channel itself asks for decide and the signature (1b-5).
    const review = await f.raise({ question: "Send the reply to Maria?", options: ["Approve", "Decline"], answer: { kind: "COPILOT_DECISION", copilot: "MAIL", item: "REVIEW", itemId: "mailrev:abc000002" } });
    expect((await f.answer(review, { option: "Decline" })).json()).toMatchObject({ routed: "COPILOT_DECISION" });
  });

  it("R27-2: Go now on a Nous hands card keeps it READ for the visit, is scored once and starts no Nous turn", async () => {
    // Mercor card 11:52 (1/11) went unscored; the operator answered «open the page and go to the point» 2/2.
    const f = await fixture();
    const id = await f.raise({ question: "Sign in to Mercor", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now", answer: { kind: "NOUS" } }, "NEEDS_HANDS", "NOUS");
    expect((await f.answer(id, { option: "Go now" })).json()).toMatchObject({ routed: "NOUS", display: "Going to Andy: the card stays until its work is done." });
    expect(await f.notifications.get(owner, id)).toMatchObject({ status: "READ", payload: { answer: { text: "Go now", routed: "NOUS" } } });
    // Going again (the banner after the card's button) is the same answer: one ledger row, and the record keeps waiting for the work.
    expect((await f.answer(id, { option: "Go now" })).statusCode).toBe(200);
    expect(f.deps.ledger).toHaveBeenCalledTimes(1);
    expect(f.deps.ledger).toHaveBeenCalledWith(owner, expect.objectContaining({ source: "NEEDS_YOU:NOUS", predicted: "Go now", answer: "Go now", match: true, ref: id }));
    expect(f.deps.send).not.toHaveBeenCalled();
    // A READ card (the operator said Not now first) takes the answer too; any other option still goes to Nous and closes the card.
    const later = await f.raise({ question: "Sign in to Contra", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now", answer: { kind: "NOUS" } }, "NEEDS_HANDS", "NOUS");
    await f.notifications.setStatus(owner, later, "READ");
    await f.answer(later, { option: "Go now" });
    expect(await f.notifications.get(owner, later)).toMatchObject({ status: "READ", payload: { answer: { text: "Go now" } } });
    expect((await f.answer(later, { option: "Failed" })).json()).toMatchObject({ routed: "NOUS" });
    expect(f.deps.send).toHaveBeenCalledWith(owner, expect.stringContaining('My answer to "Sign in to Contra": Failed'), expect.anything());
    expect(await f.notifications.get(owner, later)).toMatchObject({ status: "ACKED" });
  });

  it("R27-3: a one-time code goes into the pane's prompt and is kept nowhere: not the record, the ledger, Nous or an inbox line", async () => {
    const f = await fixture();
    const ask: NeedsYouAsk = { question: "The 6-digit Upwork code from your SMS", code: true, answer: { kind: "PANE" } };
    const id = await f.raise(ask, "NEEDS_HANDS", "NOUS");
    expect((await f.answer(id, { option: "Go now" })).statusCode).toBe(409);
    expect((await f.answer(id, { text: " 481 516 " })).json()).toMatchObject({ routed: "PANE", display: "Typed into Andy; the code is kept nowhere." });
    expect(f.deps.sendToPane).toHaveBeenCalledWith(owner, room, pane, "Operator's one-time code for your needs-you (The 6-digit Upwork code from your SMS): 481 516");
    const record = await f.notifications.get(owner, id);
    expect(record).toMatchObject({ status: "ACKED", payload: { answer: { text: "(a one-time code, typed into the pane; not kept)", routed: "PANE" } } });
    // The whole code, either way it was typed: "481" alone is in about 1 random id in 200 (CI 42895663412).
    for (const code of ["481516", "481 516"]) expect(JSON.stringify(record)).not.toContain(code);
    expect(f.deps.ledger).not.toHaveBeenCalled();
    expect(f.deps.send).not.toHaveBeenCalled();
    // A pane that does not take it: 409 without the code, the card stays open, Nous hears why without the code.
    const again = await f.raise(ask, "NEEDS_HANDS", "NOUS");
    f.deps.sendToPane.mockResolvedValueOnce({ ok: false, display: "Not sent", result: "Not sent: Andy: \"Operator's one-time code …: 902211\" was refused (pane closed)" });
    const failed = await f.answer(again, { text: "902211" });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toContain("The code is not kept");
    expect(JSON.stringify([failed.json(), f.deps.inbox.mock.calls, await f.notifications.get(owner, again)])).not.toContain("902211");
    expect(await f.notifications.get(owner, again)).toMatchObject({ status: "OPEN" });
    // From a phone Space types into no pane, and a code goes nowhere else.
    const phone = await fixture(true, true);
    const fromPhone = await phone.raise(ask, "NEEDS_HANDS", "NOUS");
    expect((await phone.answer(fromPhone, { text: "481516" })).statusCode).toBe(409);
    expect(phone.deps.sendToPane).not.toHaveBeenCalled();
    expect(phone.deps.send).not.toHaveBeenCalled();
  });

  it("a browser handoff's one-time code goes to the CLI that asked (codePane), not the browser pane the card is about (6/11 PayPal)", async () => {
    const f = await fixture();
    const id = (await f.notifications.raise({ ownerUserId: owner, roomId: room.id, paneId: "pane:dana0001", source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED", severity: "ATTENTION",
      title: "PayPal sent an SMS code", body: "MFA: PayPal sent an SMS code", link: { roomId: room.id, paneId: "pane:dana0001", target: "tab:page:paypal01" }, dedupeKey: "browser-handoff:pane:dana0001",
      payload: { codePane: pane.id, ask: { question: "Enter the sign-in code on paypal.com", code: true, answer: { kind: "PANE" } } } })).id;
    expect((await f.answer(id, { text: "123456" })).json()).toMatchObject({ routed: "PANE", display: "Typed into Andy; the code is kept nowhere." });
    expect(f.deps.sendToPane).toHaveBeenCalledWith(owner, room, pane, "Operator's one-time code for your needs-you (Enter the sign-in code on paypal.com): 123456");
  });

  it("keeps the card waiting with the reason when its route fails, answers 409 with the copilot's words and tells Nous once (R13-6)", async () => {
    // 29/10 11:22 BKK: Approve answered INTERNAL_ERROR and the card looked answered.
    const f = await fixture();
    f.deps.decideCopilot.mockRejectedValueOnce(new Error("Gmail refused the send: token sk-abcdefghijklmnopqrstuvwx expired"));
    const id = await f.raise({ question: "Send the reply to Maria?", options: ["Approve", "Decline"], answer: { kind: "COPILOT_DECISION", copilot: "MAIL", item: "REVIEW", itemId: "mailrev:abc000001" } });
    const failed = await f.answer(id, { option: "Approve" });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toMatch(/^Not done: Gmail refused the send: .* The card stays open: try again, or answer in the pane\.$/);
    expect(failed.json().error).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    const record = await f.notifications.get(owner, id);
    expect(record).toMatchObject({ status: "OPEN", payload: { answerError: { text: expect.stringContaining("Gmail refused the send") } } });
    expect(f.deps.inbox).toHaveBeenCalledWith(owner, `needs-you-answer-failed:${id}`, expect.stringContaining("did not go through: Gmail refused the send"));
    expect(f.deps.ledger).not.toHaveBeenCalled();
    // The next try goes through and answers the card.
    expect((await f.answer(id, { option: "Approve" })).json()).toMatchObject({ routed: "COPILOT_DECISION", notification: { status: "ACKED" } });
  });

  it("R21-pred-1: words confirming the affirmative recommended option are that option, kept with the words, and a match", async () => {
    const f = await fixture();
    const card = await f.raise({ question: "Did the download work?", options: ["Installed, download works", "Still fails"], recommended: "Installed, download works", answer: { kind: "PANE" } });
    expect((await f.answer(card, { text: "ναι δουλεψε μια χαρα" })).json()).toMatchObject({ notification: { payload: { answer: { text: "Installed, download works: ναι δουλεψε μια χαρα" } } } });
    expect(f.deps.ledger).toHaveBeenLastCalledWith(owner, expect.objectContaining({ predicted: "Installed, download works", answer: "Installed, download works: ναι δουλεψε μια χαρα", match: true, ref: card }));
    const failed = await f.raise({ question: "Did the download work?", options: ["Installed, download works", "Still fails"], recommended: "Still fails", answer: { kind: "PANE" } });
    await f.answer(failed, { text: "ναι δουλεψε" });
    expect(f.deps.ledger).toHaveBeenLastCalledWith(owner, expect.objectContaining({ answer: "ναι δουλεψε", match: false }));
  });

  it("answers the next card of a kind the operator chose \"Always answer like this\" for, never one with another recommendation or a hands item (goal 7365014c-d)", async () => {
    const f = await fixture();
    const ask = (question: string, recommended = "Blue"): NeedsYouAsk => ({ question, options: ["Red", "Blue"], recommended, answer: { kind: "PANE" } });
    const first = await f.raise(ask("Which colour for 3 panes?"));
    expect((await f.answer(first, { option: "Blue", always: true, text: "darker" })).statusCode).toBe(409);
    expect((await f.answer(first, { option: "Red", always: true })).statusCode).toBe(409);
    expect((await f.answer(await f.raise(ask("Sign in?"), "SIGN_IN_NEEDED"), { option: "Blue", always: true })).statusCode).toBe(409);
    expect(f.always).toEqual([]);
    expect((await f.answer(first, { option: "Blue", always: true })).json()).toMatchObject({ routed: "PANE", notification: { status: "ACKED" } });
    expect(f.always).toEqual([expect.objectContaining({ label: expect.stringContaining('answer "Blue"') })]);
    // Goal 7365014c-e: the operator's answer goes to the decision ledger; Space's own answers below do not.
    expect(f.deps.ledger).toHaveBeenCalledTimes(1);
    expect(f.deps.ledger).toHaveBeenCalledWith(owner, expect.objectContaining({ source: "NEEDS_YOU:AGENT", title: "Which colour for 3 panes?", predicted: "Blue", answer: "Blue", match: true, ref: first }));
    // The same question (other numbers) and the same recommendation: answered at once, no alert, nothing sent to Nous as the operator.
    f.deps.sendToPane.mockClear();
    const next = await f.notifications.get(owner, await f.raise(ask("Which colour for 5 panes?")));
    expect(next).toMatchObject({ status: "ACKED", payload: { answer: { text: "Blue", routed: "PANE", by: "ALWAYS" } } });
    expect(f.deps.sendToPane).toHaveBeenCalledWith(owner, room, pane, "Operator's answer to your needs-you (Which colour for 5 panes?): Blue");
    // Another recommendation, or another question, still waits for the operator.
    expect((await f.notifications.get(owner, await f.raise(ask("Which colour for 5 panes?", "Red"))))?.status).toBe("OPEN");
    expect((await f.notifications.get(owner, await f.raise(ask("Delete the branch?"))))?.status).toBe("OPEN");
    expect(f.deps.sendToPane).toHaveBeenCalledTimes(1);
    expect(f.deps.ledger).toHaveBeenCalledTimes(1);
  });

  it("answers the next vouched review of the same rail by its decision alone, never an unvouched one or another rail's (R15-2)", async () => {
    const f = await fixture();
    const review = (copilot: string, itemId: string, question: string, vouched = true): NeedsYouAsk => ({ question, options: ["Approve", "Decline"],
      ...(vouched ? { recommended: "Approve" } : {}), answer: { kind: "COPILOT_DECISION", copilot, item: "REVIEW", itemId } });
    const first = await f.raise(review("MAIL", "mailrev:a", "Reply to Maria about the invoice?"), "REVIEW_REQUESTED", "MAIL_COPILOT");
    expect((await f.answer(first, { option: "Approve", always: true })).json()).toMatchObject({ routed: "COPILOT_DECISION", notification: { status: "ACKED" } });
    expect(f.always).toEqual([{ key: "needs-you:MAIL_COPILOT:REVIEW:Approve", label: 'answer "Approve" on every vouched Mail Copilot review' }]);
    // Another vouched Mail review in other words: decided at once by Space, with no alert.
    const next = await f.notifications.get(owner, await f.raise(review("MAIL", "mailrev:b", "Send the delivery note to Telnyx?"), "REVIEW_REQUESTED", "MAIL_COPILOT"));
    expect(next).toMatchObject({ status: "ACKED", payload: { answer: { text: "Approve", routed: "COPILOT_DECISION", by: "ALWAYS" } } });
    expect(f.deps.decideCopilot).toHaveBeenCalledTimes(2);
    // An unvouched Mail review, and a vouched review of another rail, still wait for the operator.
    expect((await f.notifications.get(owner, await f.raise(review("MAIL", "mailrev:c", "Reply to Bob?", false), "REVIEW_REQUESTED", "MAIL_COPILOT")))?.status).toBe("OPEN");
    expect((await f.notifications.get(owner, await f.raise(review("FREELANCE", "frev:d", "Send the proposal?"), "REVIEW_REQUESTED", "FREELANCE_COPILOT")))?.status).toBe("OPEN");
    expect(f.deps.decideCopilot).toHaveBeenCalledTimes(2);
  });

  it("answers an ask about WHEN to hand over with «now» by day, and leaves it to the morning in quiet hours (R16-3)", async () => {
    // 29/10: three «Now, one by one» answers in a day (e89c27d5, b7ae7844, 82c28247); Space Memory operator rule 16:25 BKK.
    const f = await fixture();
    const when = (question: string): NeedsYouAsk => ({ question, options: ["Now, one by one", "Later today", "Tomorrow as a batch"], answer: { kind: "PANE" } });
    const record = await f.notifications.get(owner, await f.raise(when("When should I hand over the 3 sign-ups?")));
    expect(record).toMatchObject({ status: "ACKED", payload: { answer: { text: "Now, one by one", routed: "PANE", by: "TIMING" } } });
    expect(f.deps.sendToPane).toHaveBeenCalledWith(owner, room, pane, "Operator's standing answer to your needs-you (When should I hand over the 3 sign-ups?): now, one by one; request the handoff.");
    expect(f.deps.ledger).not.toHaveBeenCalled();
    // Quiet hours: the card waits for the morning; options not about timing wait for the operator.
    f.clock.quiet = true;
    expect((await f.notifications.get(owner, await f.raise(when("When should I hand over the CAPTCHA?"))))?.status).toBe("OPEN");
    f.clock.quiet = false;
    expect((await f.notifications.get(owner, await f.raise({ question: "Which colour?", options: ["Now red", "Blue"], answer: { kind: "PANE" } })))?.status).toBe("OPEN");
    expect(f.deps.sendToPane).toHaveBeenCalledTimes(1);
  });

  it("carries where the operator answered from to Nous; Space's own answers carry none (plan clipboard:4TXfIZzj8ITW)", async () => {
    const f = await fixture();
    const id = await f.raise(makeNeedsYouAsk("Which colour?", { kind: "NOUS" }, ["Red", "Blue"], "Blue"));
    const phone = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36";
    expect((await f.answer(id, { option: "Red" }, { "user-agent": phone, "x-space-client": "app=WEB; view=nous:needs-you; vp=412x915" })).statusCode).toBe(200);
    expect(f.deps.send).toHaveBeenCalledWith(owner, expect.stringContaining("Red"), expect.objectContaining({ person: true,
      client: { app: "WEB", os: "ANDROID", form: "PHONE", view: "nous:needs-you", viewport: "412x915" } }));
  });

  it("sends a pane's answer as its next prompt, keeps it on the record and acknowledges it once", async () => {
    const f = await fixture();
    const id = await f.raise({ question: "Which colour?", options: ["Red", "Blue"], recommended: "Blue", answer: { kind: "PANE" } });
    const sent = await f.answer(id, { option: "Blue", text: "the darker one" });
    expect(sent.json()).toMatchObject({ routed: "PANE", display: "Sent to Andy: it gets your answer as its next prompt.", notification: { status: "ACKED", payload: { answer: { text: "Blue: the darker one", routed: "PANE" } } } });
    expect(f.deps.sendToPane).toHaveBeenCalledWith(owner, room, pane, "Operator's answer to your needs-you (Which colour?): Blue: the darker one");
    expect((await f.answer(id, { option: "Red" })).statusCode).toBe(409);
    expect((await f.answer(await f.raise({ question: "Which colour?", options: ["Red"], answer: { kind: "PANE" } }), { option: "Green" })).statusCode).toBe(409);
    // Text the safety check holds goes to Nous with the reason instead.
    f.deps.sendToPane.mockResolvedValueOnce({ ok: false, refused: true, display: "Held back", result: "That text asks for a release." });
    expect((await f.answer(await f.raise({ question: "Release?", answer: { kind: "PANE" } }), { text: "promote it" })).json()).toMatchObject({ routed: "NOUS" });
    expect(f.deps.send).toHaveBeenLastCalledWith(owner, "[Alpha · Andy] My answer to \"Release?\": promote it\n(Space did not type it: That text asks for a release.)", { person: true, refs: { roomId: room.id, paneId: pane.id }, client: { app: "UNKNOWN" } });
  });

  it("answers a copilot's question, decides its review, hands a mail to Mail Copilot, acknowledges, and reaches Nous without an ask", async () => {
    const f = await fixture();
    expect((await f.answer(await f.raise({ question: "Greek or English?", options: ["Greek", "English"], answer: { kind: "COPILOT_QUESTION", copilot: "JOB", questionId: "jobq:1" } }), { option: "Greek" })).json())
      .toMatchObject({ routed: "COPILOT_QUESTION", display: "Answered; the copilot continues with it." });
    expect(f.deps.answerCopilot).toHaveBeenCalledWith(owner, { copilot: "JOB", questionId: "jobq:1", paneId: pane.id, answer: "Greek" });

    const review = await f.raise({ question: "Send the reply?", options: ["Approve", "Decline"], answer: { kind: "COPILOT_DECISION", copilot: "MAIL", item: "REVIEW", itemId: "mailr:1" } });
    expect((await f.answer(review, { text: "no option" })).statusCode).toBe(409);
    expect((await f.answer(review, { option: "Decline", text: "too formal" })).json()).toMatchObject({ routed: "COPILOT_DECISION" });
    expect(f.deps.decideCopilot).toHaveBeenCalledWith(owner, { type: "COPILOT", copilot: "MAIL", item: "REVIEW", itemId: "mailr:1", paneId: pane.id, decision: "reject", note: "too formal" });
    await f.answer(await f.raise({ question: "Restart nginx?", options: ["Approve", "Decline"], answer: { kind: "COPILOT_DECISION", copilot: "SECURITY", item: "REVIEW", itemId: "secevt:1" } }), { option: "Approve" });
    expect(f.deps.decideCopilot).toHaveBeenLastCalledWith(owner, expect.objectContaining({ copilot: "SECURITY", decision: "approve" }));

    const mail = { question: "What should Mail Copilot do with this mail?", options: ["I handled it", "Ignore it"], answer: { kind: "MAIL_FIX" as const, account: "op@example.com", threadId: "t1" } };
    expect((await f.answer(await f.raise(mail), { text: "Reply that I sign on Monday" })).json()).toMatchObject({ routed: "MAIL_FIX" });
    expect(f.deps.requestMailFix).toHaveBeenCalledWith(owner, pane, { account: "op@example.com", threadId: "t1", note: "Reply that I sign on Monday" });
    expect((await f.answer(await f.raise(mail), { option: "I handled it" })).json()).toMatchObject({ routed: "ACK", display: "Noted: I handled it." });
    expect(f.deps.requestMailFix).toHaveBeenCalledTimes(1);

    expect((await f.answer(await f.raise(null), { text: "Use the staging key" })).json()).toMatchObject({ routed: "NOUS", display: "Sent to Nous about Andy." });
    expect(f.deps.send).toHaveBeenLastCalledWith(owner, "[Alpha · Andy] My answer to \"Pick the colour\": Use the staging key", { person: true, refs: { roomId: room.id, paneId: pane.id }, client: { app: "UNKNOWN" } });
    expect((await f.answer("notification:missing0001", { text: "x" })).statusCode).toBe(404);
    expect((await f.answer(await f.raise(null), {})).statusCode).toBe(422);
  });

  it("treats an Approve with a note of more than a few words on a Mail, Marketing or Freelance review as a redraft: nothing is sent (R20-9)", async () => {
    // Operator P1 30/10 21:15 BKK: "Approve: <another reply>" on mailrev:AJYxemplyr0e sent the old draft unchanged.
    const f = await fixture();
    const decide = (copilot: "MAIL" | "FREELANCE", itemId: string) => ({ question: "Send the reply?", options: ["Approve", "Decline"], answer: { kind: "COPILOT_DECISION" as const, copilot, item: "REVIEW", itemId } });
    const mail = await f.raise(decide("MAIL", "mailrev:AJYxemplyr0e"), "REVIEW_REQUESTED", "MAIL_COPILOT", { target: "thread:op@example.com:t9" });
    expect((await f.answer(mail, { option: "Approve", text: "say we ship on Monday, not Friday" })).json())
      .toMatchObject({ routed: "COPILOT_DECISION", display: "Not sent: your note went back to the copilot, which drafts a new version for you to review." });
    expect(f.deps.decideCopilot).toHaveBeenLastCalledWith(owner, expect.objectContaining({ copilot: "MAIL", itemId: "mailrev:AJYxemplyr0e", decision: "reject", note: "Redraft requested: say we ship on Monday, not Friday" }));
    expect(f.deps.requestMailFix).toHaveBeenCalledWith(owner, pane, { account: "op@example.com", threadId: "t9",
      note: expect.stringMatching(/^The operator did not approve review mailrev:AJYxemplyr0e as it is; draft it again following their note \(the old draft was not sent\): say we ship on Monday, not Friday$/) });
    await f.answer(await f.raise(decide("FREELANCE", "flmsg:1"), "REVIEW_REQUESTED", "FREELANCE_COPILOT"), { option: "Approve", text: "lower the rate to 45 an hour please" });
    expect(f.deps.briefCopilot).toHaveBeenCalledWith(owner, pane, expect.stringContaining("lower the rate to 45 an hour please"));
    // A short note still approves.
    await f.answer(await f.raise(decide("MAIL", "mailrev:short001"), "REVIEW_REQUESTED", "MAIL_COPILOT", { target: "thread:op@example.com:t10" }), { option: "Approve", text: "looks good" });
    expect(f.deps.decideCopilot).toHaveBeenLastCalledWith(owner, expect.objectContaining({ itemId: "mailrev:short001", decision: "approve", note: "looks good" }));
  });

  it("operator 4/11 18:42 BKK: a value the card asks for (answerKind text) is typed on the card and reaches Nous as the operator's answer", async () => {
    const f = await fixture();
    const id = await f.raise({ question: "Which phone goes on Form A as the applicant's phone?", answerKind: "text", answer: { kind: "NOUS" } }, "NEEDS_HANDS", "NOUS");
    expect((await f.answer(id, { text: "+66 00 000 0000" })).json()).toMatchObject({ routed: "NOUS", display: "Sent to Nous about Andy." });
    expect(f.deps.send).toHaveBeenLastCalledWith(owner, "[Alpha · Andy] My answer to \"Which phone goes on Form A as the applicant's phone?\": +66 00 000 0000",
      { person: true, refs: { roomId: room.id, paneId: pane.id }, client: { app: "UNKNOWN" } });
    expect((await f.notifications.list(owner, { status: "WAITING", limit: 20 })).map((item) => item.id)).not.toContain(id);
  });

  it("takes answers from a person only", async () => {
    const f = await fixture(false);
    expect((await f.answer(await f.raise({ question: "Which colour?", answer: { kind: "PANE" } }), { text: "Blue" })).statusCode).toBe(403);
    expect(f.deps.sendToPane).not.toHaveBeenCalled();
  });
});
