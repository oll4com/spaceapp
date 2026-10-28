// Needs you as questions (operator request 2026-10-27, plan clipboard:5AQvaoSR-IZa): the operator answers a needs-you record from its card;
// its ask routes the answer (a pane's next prompt, a copilot's question or decision, Mail Copilot's Send to AI, Nous, or a plain acknowledgement).
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { eventSchema, type NeedsYouAsk, type NousMessage, type Pane, type Room } from "@space/contracts";
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

  async function fixture(person = true) {
    const late: { answers?: ReturnType<typeof registerNousPaneBoardRoutes> } = {};
    const always: Array<{ key: string; label: string }> = [];
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
      ledger: vi.fn<NonNullable<PaneBoardRouteDeps["ledger"]>>(async () => {})
    };
    const app = Fastify();
    apps.push(app);
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof SpaceNotFoundError ? 404 : error instanceof SpaceConflictError ? 409 : error instanceof ZodError ? 422
      : (error as { statusCode?: number }).statusCode ?? 500).send({ error: error.message }));
    late.answers = registerNousPaneBoardRoutes(app, { routeOptions: {}, owner: async () => owner, parseBody, parseQuery,
      rememberAlways: async (_owner, kind) => { always.push(kind); }, alwaysKinds: async () => always.map((kind) => kind.key),
      assertPerson: () => { if (!person) throw Object.assign(new Error("Only the operator answers."), { statusCode: 403 }); },
      board: { board: vi.fn(), tick: vi.fn() } as never, notifications,
      pane: async (_owner, paneId) => paneId === pane.id ? { room, pane } : null, ...deps });
    const raise = async (ask: NeedsYouAsk | null, kind = "NEEDS_YOU") => (await notifications.raise({ ownerUserId: owner, roomId: room.id, paneId: pane.id, source: "AGENT", kind,
      severity: "ATTENTION", title: "Andy needs you", body: "Pick the colour\nNeeds: red or blue", link: {}, dedupeKey: `test:${makeSpaceId("k")}`, payload: ask ? { ask } : {} })).id;
    const answer = (id: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/notifications/${id}/answer`, payload });
    return { notifications, deps, raise, answer, always };
  }

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
    expect(f.deps.send).toHaveBeenLastCalledWith(owner, "[Alpha · Andy] My answer to \"Release?\": promote it\n(Space did not type it: That text asks for a release.)", { person: true, refs: { roomId: room.id, paneId: pane.id } });
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
    expect(f.deps.send).toHaveBeenLastCalledWith(owner, "[Alpha · Andy] My answer to \"Pick the colour\": Use the staging key", { person: true, refs: { roomId: room.id, paneId: pane.id } });
    expect((await f.answer("notification:missing0001", { text: "x" })).statusCode).toBe(404);
    expect((await f.answer(await f.raise(null), {})).statusCode).toBe(422);
  });

  it("takes answers from a person only", async () => {
    const f = await fixture(false);
    expect((await f.answer(await f.raise({ question: "Which colour?", answer: { kind: "PANE" } }), { text: "Blue" })).statusCode).toBe(403);
    expect(f.deps.sendToPane).not.toHaveBeenCalled();
  });
});
