// The unified «Εισερχόμενα» (plan clipboard:aE7U1J_gU9OV D1-D3): one view of the existing records, one badge, and acts that write to the
// record an item shows (nothing deleted, nothing migrated).
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { eventSchema, OPERATOR_UPDATE_KIND, type NousDecision, type NousMessage, type NousOperatorRequest, type Pane, type Room, type UnifiedInboxPage } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { makeSpaceId, SpaceConflictError, SpaceEventBus, SpaceNotFoundError } from "@space/runtime";
import { ZodError } from "zod";
import { createNotificationService } from "../src/notifications/service.js";
import { registerNousPaneBoardRoutes } from "../src/nous/pane-board-routes.js";
import { registerUnifiedInboxRoutes } from "../src/nous/unified-inbox-routes.js";
import { parseBody, parseQuery } from "../src/route-parsing.js";

const owner = "user:operator";
const room = { id: "room:alpha0001", name: "Alpha" } as Room;
const pane = { id: "pane:andy0001", paneName: "Andy", title: "Andy", roomId: room.id } as Pane;
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe("the unified inbox", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  async function fixture() {
    const notifications = createNotificationService({ repository: new InMemorySpaceNotificationsRepository(), eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }) });
    const decision = { id: "nousdec:abc000001", ownerUserId: owner, category: "APPROVAL", title: "Ship it?", body: "Ready.", options: ["Approve", "Decline"], recommendation: "Approve",
      refs: {}, action: null, status: "OPEN", answer: null, outcome: null, createdAt: at(30), answeredAt: null } as unknown as NousDecision;
    const requests: NousOperatorRequest[] = [
      { messageId: "nous_msg:00000003", createdAt: at(3), text: "Build the inbox", status: "IN_PROGRESS" },
      { messageId: "nous_msg:00000002", createdAt: at(200), text: "Fix the bell", status: "DONE", doneSummary: "Fixed" },
      { messageId: "nous_msg:00000001", createdAt: at(400), text: "Old ask", status: "ANSWERED" }];
    const send = vi.fn(async () => ({}) as NousMessage);
    const answerDecision = vi.fn(async (_owner: string, _id: string, input: { answer: string }) => ({ ...decision, status: input.answer === "DECLINE" ? "DECLINED" : "APPROVED", answer: input.answer }) as NousDecision);
    const page = vi.fn(async (_owner: string, options: { before?: string; limit: number; status?: string; q?: string }) => {
      const matching = requests.filter((request) => (!options.status || request.status === options.status) && (!options.q || request.text.includes(options.q)));
      const start = options.before ? matching.findIndex((request) => request.messageId === options.before) + 1 : 0;
      return { requests: matching.slice(start, start + options.limit), hasMore: start + options.limit < matching.length };
    });
    const app = Fastify();
    apps.push(app);
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof SpaceNotFoundError ? 404 : error instanceof SpaceConflictError ? 409 : error instanceof ZodError ? 422
      : (error as { statusCode?: number }).statusCode ?? 500).send({ error: error.message }));
    const board = registerNousPaneBoardRoutes(app, { routeOptions: {}, owner: async () => owner, parseBody, parseQuery, rememberAlways: async () => {}, alwaysKinds: async () => [],
      assertPerson: () => {}, board: { board: vi.fn(), tick: vi.fn() } as never, notifications, pane: async (_owner, paneId) => paneId === pane.id ? { room, pane } : null,
      answerPrompt: vi.fn(), answerCopilot: vi.fn(), send, sendToPane: vi.fn(async () => ({ ok: true, display: "Sent to Andy", result: "ok" })), decideCopilot: vi.fn() } as never);
    registerUnifiedInboxRoutes(app, { routeOptions: {}, owner: async () => owner, assertPerson: () => {}, parseBody, parseQuery, notifications,
      decisions: async () => [decision, { ...decision, id: "nousdec:abc000002", status: "APPROVED" } as NousDecision], answerDecision,
      inbox: async () => [{ key: "pane:x", text: "Andy finished a step", at: at(5) }], requests: { page }, answerNeedsYou: (request, id, input) => board.operatorAnswer(request, id, input) });
    const raise = async (kind: string, input: { source?: "AGENT" | "NOUS" | "MAIL_COPILOT"; severity?: "INFO" | "ATTENTION" | "URGENT"; payload?: Record<string, unknown>; onPane?: boolean } = {}) =>
      (await notifications.raise({ ownerUserId: owner, roomId: input.onPane === false ? null : room.id, paneId: input.onPane === false ? null : pane.id, source: input.source ?? "AGENT", kind,
        severity: input.severity ?? "ATTENTION", title: `${kind} card`, body: "Body", link: {}, dedupeKey: `test:${makeSpaceId("k")}`, payload: input.payload ?? {} })).id;
    const get = async (query = "") => { const reply = await app.inject({ method: "GET", url: `/api/nous/unified-inbox${query}` }); expect(reply.statusCode).toBe(200); return reply.json() as UnifiedInboxPage; };
    const act = (id: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/nous/unified-inbox/${encodeURIComponent(id)}/act`, payload });
    return { notifications, raise, get, act, send, answerDecision, page };
  }

  it("aggregates needs-you, open decisions, done, updates and alerts into «Όλα» with one badge; Nous's queue and requests under «Σε εξέλιξη»", async () => {
    const f = await fixture();
    const needs = await f.raise("NEEDS_YOU", { payload: { ask: { question: "Red or blue?", options: ["red", "blue"], recommended: "red", answer: { kind: "PANE" } } } });
    const done = await f.raise("REQUEST_DONE", { source: "NOUS", severity: "INFO", onPane: false });
    const update = await f.raise(OPERATOR_UPDATE_KIND, { source: "NOUS", severity: "INFO", onPane: false });
    const alert = await f.raise("RUN_FAILED", { severity: "URGENT", onPane: false });
    await f.raise("MAIL_RECEIVED", { source: "MAIL_COPILOT", severity: "INFO", onPane: false, payload: { heldForNous: { until: at(-60) } } });
    const all = await f.get();
    expect(all.items.map((item) => item.id).slice(0, 2).sort()).toEqual([`notification:${needs}`, "decision:nousdec:abc000001"].sort());
    expect(new Set(all.items.map((item) => item.id))).toEqual(new Set([`notification:${needs}`, "decision:nousdec:abc000001", `notification:${done}`, `notification:${update}`, `notification:${alert}`]));
    expect(all.items.find((item) => item.id === `notification:${needs}`)).toMatchObject({ kind: "ACTION_REQUIRED", status: "ACTION_PENDING", actions: { type: "CHOICE", options: ["red", "blue"], recommended: "red" } });
    expect(all.items.find((item) => item.id === `notification:${done}`)).toMatchObject({ kind: "COMPLETED", status: "UNREAD", actions: { type: "ACKNOWLEDGE" } });
    expect(all.items.find((item) => item.id === `notification:${update}`)).toMatchObject({ kind: "UPDATE", source: "NOUS" });
    expect(all.items.find((item) => item.id === `notification:${alert}`)).toMatchObject({ kind: "ALERT", priority: "URGENT", status: "UNREAD" });
    // Badge: two waiting answers and the one unread above INFO (the done card and the update are INFO).
    expect(all).toMatchObject({ badge: 3, attention: true, counts: { ALL: 5, ACTION: 2, COMPLETED: 1, UPDATES: 2, IN_PROGRESS: 2 } });
    // 3/11: only a card for the operator's hands in a pane gets «Μετάβαση σε pane».
    const signIn = await f.raise("SIGN_IN");
    expect((await f.get("?filter=ACTION")).items.find((item) => item.id === `notification:${signIn}`)).toMatchObject({ actions: { type: "GO_TO_PANE" } });
    const progress = await f.get("?filter=IN_PROGRESS");
    expect(progress.items.map((item) => [item.id, item.kind])).toEqual([["request:nous_msg:00000003", "IN_PROGRESS"], ["inbox:pane:x", "INTERNAL_QUEUE"]]);
    expect(f.page).not.toHaveBeenCalledWith(owner, expect.not.objectContaining({ status: "IN_PROGRESS" }));
  });

  it("«Αρχείο & Αναζήτηση» pages the requests only when chosen, with the search words", async () => {
    const f = await fixture();
    const first = await f.get("?filter=ARCHIVE&limit=2");
    expect(first.items.map((item) => item.id)).toEqual(["request:nous_msg:00000003", "request:nous_msg:00000002"]);
    expect(first.items[1]).toMatchObject({ kind: "COMPLETED", status: "RESOLVED", body: "Fixed" });
    expect(first.before).toBe("nous_msg:00000002");
    const second = await f.get(`?filter=ARCHIVE&limit=2&before=${first.before}`);
    expect(second).toMatchObject({ items: [{ id: "request:nous_msg:00000001" }], before: null });
    expect((await f.get("?filter=ARCHIVE&q=bell")).items.map((item) => item.id)).toEqual(["request:nous_msg:00000002"]);
  });

  it("«Ελήφθη» acknowledges a done card: it leaves «Όλα» and stays under «Ολοκληρωμένα»; Mark read moves an update to its history", async () => {
    const f = await fixture();
    const done = await f.raise("REQUEST_DONE", { source: "NOUS", severity: "INFO", onPane: false });
    const alert = await f.raise("RUN_FAILED", { severity: "ATTENTION", onPane: false });
    expect((await f.get()).badge).toBe(2);
    const acked = await f.act(`notification:${done}`, { action: "ACKNOWLEDGE" });
    expect(acked.json()).toMatchObject({ item: { status: "RESOLVED" }, badge: 2 });
    expect((await f.notifications.get(owner, done))?.status).toBe("ACKED");
    expect((await f.get()).items.map((item) => item.id)).not.toContain(`notification:${done}`);
    expect((await f.get("?filter=COMPLETED")).items).toMatchObject([{ id: `notification:${done}`, status: "RESOLVED" }]);
    expect((await f.act(`notification:${alert}`, { action: "MARK_READ" })).json()).toMatchObject({ item: { status: "READ" }, badge: 1 });
    expect((await f.get()).counts.UPDATES).toBe(0);
    expect((await f.get("?filter=UPDATES")).items).toMatchObject([{ id: `notification:${alert}`, status: "READ" }]);
    // Dismiss keeps the record (retention): acknowledged, marked dismissed.
    const other = await f.raise("RUN_FAILED", { onPane: false });
    await f.act(`notification:${other}`, { action: "DISMISS" });
    expect(await f.notifications.get(owner, other)).toMatchObject({ status: "ACKED", payload: { dismissed: { at: expect.any(String) } } });
  });

  it("ANSWER goes through the needs-you answer path and the decision's own answer; Nous's queue and requests are read-only", async () => {
    const f = await fixture();
    const needs = await f.raise("NEEDS_YOU", { payload: { ask: { question: "Red or blue?", options: ["red", "blue"], recommended: "red", answer: { kind: "NOUS" } } } });
    expect((await f.act(`notification:${needs}`, { action: "ANSWER", option: "green" })).statusCode).toBe(409);
    const answered = await f.act(`notification:${needs}`, { action: "ANSWER", option: "red" });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toMatchObject({ item: { status: "RESOLVED" }, display: expect.any(String), badge: 1 });
    expect(f.send).toHaveBeenCalledWith(owner, expect.stringContaining("red"), expect.objectContaining({ person: true }));
    expect((await f.act("decision:nousdec:abc000001", { action: "ANSWER", option: "Approve" })).json()).toMatchObject({ item: { status: "RESOLVED" } });
    expect(f.answerDecision).toHaveBeenLastCalledWith(owner, "nousdec:abc000001", { answer: "APPROVE" });
    await f.act("decision:nousdec:abc000001", { action: "ANSWER", text: "Wait until Monday" });
    expect(f.answerDecision).toHaveBeenLastCalledWith(owner, "nousdec:abc000001", { answer: "ANSWER", text: "Wait until Monday" });
    expect((await f.act("decision:nousdec:abc000001", { action: "DISMISS" })).statusCode).toBe(409);
    expect((await f.act("request:nous_msg:00000003", { action: "ACKNOWLEDGE" })).statusCode).toBe(409);
    expect((await f.act("notification:notif:missing", { action: "MARK_READ" })).statusCode).toBe(404);
    expect((await f.act(`notification:${needs}`, { action: "ANSWER" })).statusCode).toBe(422);
  });
});
