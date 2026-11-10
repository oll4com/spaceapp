import { describe, expect, it, vi } from "vitest";
import { needsYou, notificationListQuerySchema, type ClipboardItem, type NousRequestStatus } from "@space/contracts";
import { InMemoryNousRepository, InMemorySpaceNotificationsRepository } from "@space/db";
import { SpaceEventBus } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";
import { createNousRequests, deriveNousRequests } from "../src/nous/requests.js";
import { createNousRequestDone, dispatchedAnswerOnly, priorityPanesOf, quietRequestsOf } from "../src/nous/request-done.js";
import { createNousTools, nousToolDefinitions, type NousToolDeps } from "../src/nous/tools.js";
import { nousSubagentTools } from "../src/nous/subagents.js";
import { itemActed } from "../src/nous/turn-items.js";
import { createNousFiles } from "../src/nous/files.js";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerNotificationRoutes } from "../src/notifications/routes.js";

const owner = "user:operator";
const ctx = { owner, turnId: "turn:operator001", callId: "call:done0001", traceId: "trace:done0001", turn: { reason: "OPERATOR", operatorMessage: { id: "nous_msg:operator001", content: "Build a Done tab", person: true } } };
const args = { plan: "clipboard:done0001", request: "Πρόσθεσε Done στο Nous", summary: "Προστέθηκε η καρτέλα Done με επιβεβαίωση.", where: "dev" as const, verified: "Read the Done tab route on dev: the record shows", tickets: ["q-20261029-060000-abcd"] };

const PROMOTE_TICKET = "q-20261030-203351-eb04";
function fixture(quiet = false, evidence: { pane?: () => string | null; ticket?: () => boolean; statuses?: Record<string, NousRequestStatus>; open?: (paneId: string) => boolean | null; derived?: boolean } = {}) {
  const notes = new InMemoryNousRepository();
  const repository = new InMemorySpaceNotificationsRepository(() => "2026-10-29T12:00:00.000Z", true);
  const push = { send: vi.fn(async () => "SENT" as const) };
  const notifications = createNotificationService({ repository, push, eventBus: new SpaceEventBus(),
    now: () => quiet ? "2026-10-29T23:30:00.000Z" : "2026-10-29T12:00:00.000Z",
    userSettings: async () => ({ dateTime: { timeZone: "UTC" }, notifications: { quietHours: { enabled: quiet, start: "23:00", end: "09:00" } } }) as never,
    recordRoomEvent: async () => { throw new Error("Done is roomless"); } });
  let plan = { id: args.plan, source: "PLAN", title: "Done tab", progressPercentage: 70, executionStatus: "IN_PROGRESS" } as ClipboardItem;
  const notice = vi.fn(async (_owner: string, _key: string, _line: string, onDone?: () => Promise<void>) => { await onDone?.(); });
  // The repository stamps records at 29/10 12:00; the 24 h window is read on this clock.
  const clock = { now: Date.parse("2026-10-29T12:30:00.000Z") };
  // derived: the Requests tab's own derivation judges the messages and feeds space_open_requests' notDone.
  const requests = evidence.derived ? createNousRequests({ repository: notes, notifications, plan: async () => null }) : undefined;
  const done = createNousRequestDone({ notes, notifications, plan: async (who, id) => who === owner && id === plan.id ? plan : null, notice, now: () => clock.now,
    ticketSummary: async (id) => id === PROMOTE_TICKET ? "Promote dev a6a234ec0d to stable" : "Nous: a Done tab beside Needs you",
    paneFinished: async () => evidence.pane?.() ?? null, paneOpen: async (paneId) => evidence.open?.(paneId) ?? true, ticketOnStable: async () => evidence.ticket?.() ?? false,
    requestStatus: async (who, ids) => requests ? requests.statuses(who, ids) : new Map(ids.flatMap((id) => evidence.statuses?.[id] ? [[id, evidence.statuses[id]!] as const] : [])) });
  const tools = createNousTools({ requestDone: done, requests, clipboard: { save: async () => plan } } as unknown as NousToolDeps);
  return { notes, repository, notifications, done, tools, notice, push, clock, complete: () => { plan = { ...plan, progressPercentage: 100, executionStatus: "COMPLETED" }; } };
}

describe("Nous Done", () => {
  it("records one completion, alerts once, and preserves acknowledgement across retries and restarts", async () => {
    const f = fixture();
    await f.repository.registerPushDevice(owner, { token: "android-token-0000000000", platform: "ANDROID", appVersion: null });
    expect(await f.tools.execute("space_request_done", args, ctx)).toMatchObject({ ok: true });
    const [record] = await f.notifications.list(owner, notificationListQuerySchema.parse({ source: "NOUS", kind: "REQUEST_DONE" }));
    expect(record).toMatchObject({ kind: "REQUEST_DONE", source: "NOUS", severity: "ATTENTION", roomId: null, paneId: null,
      dedupeKey: `nous:done:${args.plan}`, link: { surface: "nous", target: "done" }, payload: { request: args.request, summary: args.summary, planId: args.plan, where: "dev", tickets: args.tickets } });
    expect(needsYou(record!)).toBe(false);
    expect(await f.notifications.list(owner, { status: "NEEDS_YOU", limit: 200 })).toEqual([]);
    await f.notifications.setStatus(owner, record!.id, "READ");
    await f.notifications.setStatus(owner, record!.id, "ACKED");
    await f.tools.execute("space_request_done", args, ctx);
    const restarted = createNousRequestDone({ notes: f.notes, notifications: f.notifications, plan: async () => null, notice: f.notice });
    await restarted.run(owner, args);
    expect((await f.notifications.get(owner, record!.id))?.status).toBe("ACKED");
    expect(await f.notifications.setStatus(owner, record!.id, "READ")).toMatchObject({ status: "ACKED" });
    expect(f.repository.telegram).toHaveLength(1);
    await vi.waitFor(() => expect(f.push.send).toHaveBeenCalledTimes(1));
    expect(await f.notifications.list("user:other", notificationListQuerySchema.parse({ kind: "REQUEST_DONE" }))).toEqual([]);
  });

  it("clips the operator quote and Nous summary with feedback, validates tickets, and excludes helpers", async () => {
    const f = fixture();
    const result = await f.tools.execute("space_request_done", { ...args, request: "x".repeat(800), summary: "s".repeat(900) }, ctx);
    expect(result).toMatchObject({ ok: true, result: expect.stringContaining("Clipped to fit") });
    const [record] = await f.notifications.list(owner, { status: "ALL", limit: 50 });
    expect(String(record!.payload.request).length).toBeLessThanOrEqual(300);
    expect(String(record!.payload.summary).length).toBeLessThanOrEqual(600);
    expect((await f.tools.execute("space_request_done", { ...args, tickets: ["javascript:alert(1)"] }, ctx)).ok).toBe(false);
    expect(nousToolDefinitions({ copilots: false }).some((tool) => tool.name === "space_request_done")).toBe(true);
    expect(nousSubagentTools(nousToolDefinitions({ copilots: false })).some((tool) => tool.name === "space_request_done")).toBe(false);
  });

  it("31/10 00:33 BKK: a promote ticket carries many requests and never makes two records one request; a feature ticket does", async () => {
    const f = fixture();
    const { plan: _plan, ...noPlan } = args;
    await f.tools.execute("space_request_done", { ...noPlan, tickets: [PROMOTE_TICKET] }, ctx);
    const other = { ...ctx, turnId: "turn:operator003", turn: { ...ctx.turn, operatorMessage: { ...ctx.turn.operatorMessage, id: "nous_msg:operator003" } } };
    const mail = { ...noPlan, request: "Fix the Gmail check", summary: "Gmail reads are paced per account and retried on rate limits.", tickets: [PROMOTE_TICKET] };
    expect(await f.tools.execute("space_request_done", mail, other)).toMatchObject({ ok: true, display: "Recorded the completed request in Done" });
  });

  it("dedupes retries by request id, and a second record of the same work within 24 h by plan, ticket or summary words (30/10: three records of one fix)", async () => {
    const f = fixture();
    const { plan: _plan, ...noPlan } = args;
    await f.tools.execute("space_request_done", noPlan, ctx);
    expect(await f.tools.execute("space_request_done", noPlan, ctx)).toMatchObject({ ok: true, display: "This request is already in Done" });
    const [first] = await f.notifications.list(owner, { status: "ALL", limit: 50 });
    // Another turn's id, the same work: refused (a hold), naming the record that is already in Done.
    const other = { ...ctx, turnId: "turn:operator002", turn: { ...ctx.turn, operatorMessage: { ...ctx.turn.operatorMessage, id: "nous_msg:operator002" } } };
    const again = await f.tools.execute("space_request_done", noPlan, other);
    expect(again).toMatchObject({ ok: false, refused: true, display: "Already in Done", result: expect.stringContaining(first!.id) });
    const { tickets: _tickets, ...noTicket } = noPlan;
    expect(await f.tools.execute("space_request_done", { ...noTicket, request: "Done tab", summary: "Η καρτέλα Done προστέθηκε με επιβεβαίωση στο Nous." }, other)).toMatchObject({ refused: true });
    expect(await f.tools.execute("space_request_done", { ...noTicket, summary: "Something else entirely", tickets: args.tickets }, other)).toMatchObject({ refused: true });
    expect(await f.tools.execute("space_request_done", { ...noTicket, summary: "Something else entirely" }, other)).toMatchObject({ ok: true, display: "Recorded the completed request in Done" });
    // An inbox turn completing a no-code request can carry the original request id across retries in later turns.
    await f.tools.execute("space_request_done", { ...noPlan, id: "nous_msg:operator001" }, { ...ctx, turnId: "turn:inbox", turn: { reason: "INBOX", operatorMessage: null } });
    expect(await f.notifications.list(owner, { status: "ALL", limit: 50 })).toHaveLength(2);
    // After 24 h the same words are a new request.
    f.clock.now = Date.parse("2026-10-30T12:30:00.000Z");
    const later = { ...ctx, turnId: "turn:operator003", turn: { ...ctx.turn, operatorMessage: { ...ctx.turn.operatorMessage, id: "nous_msg:operator003" } } };
    expect(await f.tools.execute("space_request_done", noPlan, later)).toMatchObject({ ok: true, display: "Recorded the completed request in Done" });
  });

  it("refuses an operator turn's outcome while a completed request has no Done record, with the ready call; answerOnly and recorded ones pass (operator 31/10)", async () => {
    const f = fixture();
    const requests = [{ summary: "Fixed the Vault inbox import for every waiting login", outcome: "SELF" as const },
      { summary: "Answered which panes are open", outcome: "SELF" as const, answerOnly: true },
      { summary: "Release waits for the operator", outcome: "OPERATOR" as const }, { summary: "Mercor interviews", outcome: "PENDING" as const }];
    const held = await f.tools.execute("space_nous_outcome", { requests }, ctx);
    expect(held).toMatchObject({ ok: false, refused: true, display: "1 completed request not in Done" });
    expect(held.result).toContain("Fixed the Vault inbox import for every waiting login");
    expect(held.result).toContain('space_request_done {"request":"Fixed the Vault inbox import for every waiting login"');
    expect(held.result).toContain('"id":"nous_msg:operator001"');
    expect(held.result).not.toContain("Answered which panes");
    expect(held).not.toHaveProperty("outcomes");
    // Background turns are not checked.
    expect(await f.tools.execute("space_nous_outcome", { requests }, { ...ctx, turn: { reason: "INBOX", operatorMessage: null } })).toMatchObject({ ok: true });
    // Recorded with words that share 60 % of the outcome's: it passes, and the outcomes keep answerOnly for the Requests tab (plan clipboard:2NOOFNJDUIMO).
    await f.tools.execute("space_request_done", { request: "φτιάξε το vault", summary: "Fixed the Vault inbox import: every waiting login imports on its own.", where: "stable", verified: "Checked on the surface the operator uses" }, ctx);
    const passed = await f.tools.execute("space_nous_outcome", { requests }, ctx);
    expect(passed).toMatchObject({ ok: true });
    expect(passed.outcomes).toEqual(requests);
  });

  it("matches a completed request to its Done record by plan or by request id", async () => {
    const f = fixture();
    await f.tools.execute("space_request_done", args, ctx);
    await f.tools.execute("space_request_done", { request: "Ρώτα το Mercor", summary: "Mercor listings written to listings.md", where: "no code", id: "nous_msg:mercor001" }, ctx);
    const outcome = (summary: string, extra: Record<string, unknown>) => f.tools.execute("space_nous_outcome", { requests: [{ summary, outcome: "HELPER", ...extra }] }, ctx);
    expect(await outcome("Unrelated words here entirely", { plan: args.plan })).toMatchObject({ ok: true });
    expect(await outcome("Unrelated words here entirely", { id: "nous_msg:mercor001" })).toMatchObject({ ok: true });
    expect(await outcome("Unrelated words here entirely", { id: "nous_msg:other0001" })).toMatchObject({ ok: false, refused: true, result: expect.stringContaining('"id":"nous_msg:other0001"') });
    expect(await outcome("Unrelated words here entirely", { plan: "clipboard:other0001" })).toMatchObject({ refused: true, result: expect.stringContaining('"plan":"clipboard:other0001"') });
    // A record older than 24 h no longer counts.
    f.clock.now = Date.parse("2026-10-30T12:30:00.000Z");
    expect(await outcome("Unrelated words here entirely", { plan: args.plan })).toMatchObject({ refused: true });
  });

  it("keeps quiet-hours completions in the tab without push, Telegram or a morning hands alert", async () => {
    const f = fixture(true);
    await f.repository.registerPushDevice(owner, { token: "android-token-0000000000", platform: "ANDROID", appVersion: null });
    await f.done.run(owner, args);
    expect(f.repository.telegram).toHaveLength(0);
    expect(f.push.send).not.toHaveBeenCalled();
    const [record] = await f.notifications.list(owner, { status: "ALL", limit: 50 });
    expect(record!.payload.heldUntil).toBeTruthy();
  });

  it("filters completions through the notification route and acknowledges forward only", async () => {
    const f = fixture();
    await f.done.run(owner, args);
    await f.notifications.raise({ ownerUserId: owner, source: "NOUS", kind: "OTHER", severity: "INFO", roomId: null, paneId: null, title: "Other", body: "", link: {}, payload: {}, dedupeKey: null, telegram: false });
    const app = Fastify();
    registerNotificationRoutes(app, f.notifications, { routeOptions: {}, authenticatedOwner: async () => owner,
      parseBody: (schema, value) => schema.parse(value), parseQuery: (schema, value) => schema.parse(value) });
    try {
      const response = await app.inject({ method: "GET", url: "/api/notifications?source=NOUS&kind=REQUEST_DONE&status=ALL&limit=200" });
      expect(response.statusCode).toBe(200);
      const rows = response.json().notifications;
      expect(rows).toHaveLength(1);
      const id = rows[0].id;
      expect((await app.inject({ method: "POST", url: `/api/notifications/${id}/ack` })).json().notification.status).toBe("ACKED");
      expect((await app.inject({ method: "POST", url: `/api/notifications/${id}/read` })).json().notification.status).toBe("ACKED");
    } finally { await app.close(); }
  });

  it("reminds once for a completed OPERATOR-created plan, persists it, and skips inbox plans and delivered requests", async () => {
    const f = fixture();
    await f.tools.execute("space_plan_create", { title: "Done tab", text: "Build it", minimumModel: "gpt-6.1-sol" }, ctx);
    await f.done.tick(owner);
    expect(f.notice).not.toHaveBeenCalled();
    f.complete();
    await f.done.tick(owner);
    expect(f.notice).toHaveBeenCalledTimes(1);
    expect(f.notice.mock.calls[0]?.[2]).toContain("space_request_done");
    const restarted = createNousRequestDone({ notes: f.notes, notifications: f.notifications, plan: async () => ({ progressPercentage: 100 }) as ClipboardItem, notice: f.notice });
    await restarted.tick(owner);
    expect(f.notice).toHaveBeenCalledTimes(1);
    const inbox = fixture();
    await inbox.tools.execute("space_plan_create", { title: "Background", text: "Work", minimumModel: "gpt-6.1-sol" }, { ...ctx, turn: { ...ctx.turn, reason: "INBOX" } });
    inbox.complete();
    await inbox.done.tick(owner);
    expect(inbox.notice).not.toHaveBeenCalled();
    const delivered = fixture();
    await delivered.tools.execute("space_plan_create", { title: "Done tab", text: "Build", minimumModel: "gpt-6.1-sol" }, ctx);
    await delivered.done.run(owner, args);
    delivered.complete();
    await delivered.done.tick(owner);
    expect(delivered.notice).not.toHaveBeenCalled();
  });

  // Operator 31/10 10:17 BKK («Ξεχνάς να μου περνάς πράγματα στο done»): about 80 PENDING requests in 30 hours, most with no id or plan, never came back.
  // Operator 6/11 nous_msg:2c610048: a task this turn sent somewhere is PENDING, never an answered question.
  it("names the answerOnly outcomes whose message this turn sent work for", () => {
    const [m1, m2] = ["nous_msg:aaaaaaaa1111", "nous_msg:bbbbbbbb2222"];
    const requests = [{ summary: "Background", id: m1, answerOnly: true }, { summary: "Question", id: m2, answerOnly: true }, { summary: "Task", id: m1 }];
    const sent = (name: string, args: Record<string, unknown>, ok = true) => [{ name, args, ok }];
    expect(dispatchedAnswerOnly(requests, sent("space_send_to_pane", { text: "For nous_msg:aaaaaaaa: background" }), [m1, m2])).toEqual(["Background"]);
    expect(dispatchedAnswerOnly(requests, sent("space_plan_create", { title: "Background", text: "nous_msg:aaaaaaaa" }), [m1, m2])).toEqual(["Background"]);
    expect(dispatchedAnswerOnly(requests, sent("space_send_to_pane", { text: "nous_msg:aaaaaaaa" }, false), [m1, m2])).toEqual([]);
    expect(dispatchedAnswerOnly(requests, sent("space_world", {}), [m1, m2])).toEqual([]);
    // One message in the turn: any dispatch is its own.
    expect(dispatchedAnswerOnly([{ summary: "Only", answerOnly: true }], sent("space_send_to_pane", { text: "do it" }), [m1])).toEqual(["Only"]);
  });

  describe("open requests", () => {
    const m1 = "nous_msg:open00000001", m2 = "nous_msg:open00000002";
    const turnCtx = { ...ctx, turn: { ...ctx.turn, replyTo: [m1, m2] } };
    const lines = (f: ReturnType<typeof fixture>) => f.notice.mock.calls.filter(([, key]) => String(key).startsWith("request-open:")).map(([, key, line]) => [key, line] as const);

    it("binds each PENDING request to the operator message it answers, keeps it open, and closes it on its Done record or real outcome", async () => {
      const f = fixture();
      const reported = await f.tools.execute("space_nous_outcome", { requests: [
        { summary: "Build the Requests tab for the operator", outcome: "PENDING", pane: "pane:bob0000001" },
        { summary: "Move the Telegram buttons", outcome: "PENDING", id: `${m2}-2`, tickets: ["q-20261029-060000-abcd"] }] }, turnCtx);
      expect(reported).toMatchObject({ ok: true, outcomes: [{ messageIds: [m1] }, { messageIds: [m2] }] });
      const byMessage = async () => (await f.done.openList(owner)).sort((left, right) => String(left.messageId).localeCompare(String(right.messageId)));
      expect((await byMessage()).map((entry) => [entry.messageId, entry.summary, entry.pane ?? entry.tickets])).toEqual([
        [m1, "Build the Requests tab for the operator", "pane:bob0000001"], [m2, "Move the Telegram buttons", ["q-20261029-060000-abcd"]]]);
      // Reported again in a later turn: the same open request, refreshed, never a second one.
      await f.tools.execute("space_nous_outcome", { requests: [{ summary: "Build the Requests tab for the operator: tests left", outcome: "PENDING" }] }, turnCtx);
      expect((await byMessage()).map((entry) => entry.summary)).toEqual(["Build the Requests tab for the operator: tests left", "Move the Telegram buttons"]);
      await f.tools.execute("space_request_done", { request: "tab με τα μηνύματα", summary: "Requests tab for the operator: built, the tests left are written.", where: "dev", verified: "Checked on the surface the operator uses" }, turnCtx);
      expect((await f.done.openList(owner)).map((entry) => entry.messageId)).toEqual([m2]);
      // Its real end in a later outcome closes it too (here: it is the operator's now).
      await f.tools.execute("space_nous_outcome", { requests: [{ summary: "Move the Telegram buttons", outcome: "OPERATOR", id: `${m2}-2` }] }, turnCtx);
      expect(await f.done.openList(owner)).toEqual([]);
    });

    it("brings an open request back once when its plan, pane or ticket finishes, and the quiet ones in one line a day", async () => {
      const state = { pane: null as string | null, ticket: false };
      const f = fixture(false, { pane: () => state.pane, ticket: () => state.ticket });
      await f.tools.execute("space_nous_outcome", { requests: [
        { summary: "Ship the plan for the dock", outcome: "PENDING", plan: args.plan }, { summary: "Bob fixes the pane board", outcome: "PENDING", pane: "pane:bob0000001", id: m2 },
        { summary: "Hotfix the Vault import", outcome: "PENDING", tickets: ["q-20261029-070000-beef"] }, { summary: "Answer the accountant", outcome: "PENDING" }] }, turnCtx);
      await f.done.tick(owner);
      expect(lines(f)).toEqual([]);
      f.complete();
      state.pane = "pane:bob0000001 reported done 12:40 UTC: pane board fixed";
      state.ticket = true;
      await f.done.tick(owner);
      expect(lines(f).map(([, line]) => line).sort()).toEqual([
        expect.stringMatching(/^Request "Bob fixes the pane board" \(nous_msg:open00000002\) looks finished: pane:bob0000001 reported done 12:40 UTC/),
        expect.stringMatching(/^Request "Hotfix the Vault import" \(nous_msg:open00000001\) looks finished: ticket q-20261029-070000-beef is live on stable/),
        expect.stringMatching(/^Request "Ship the plan for the dock" \(nous_msg:open00000001\) looks finished: plan clipboard:done0001 is 100% \(completed\); record it with space_request_done/)]);
      await f.done.tick(owner);
      expect(lines(f)).toHaveLength(3);
      // Six quiet hours later: one line for all four, once that day, again the next day.
      f.clock.now += 7 * 3_600_000;
      await f.done.tick(owner);
      await f.done.tick(owner);
      expect(lines(f).slice(3)).toEqual([["request-open:daily", expect.stringMatching(/^4 open requests of the operator's had nothing new for 6 hours .+space_open_requests/)]]);
      f.clock.now += 24 * 3_600_000;
      await f.done.tick(owner);
      expect(lines(f)).toHaveLength(5);
      expect((await f.tools.execute("space_open_requests", {}, turnCtx)).result).toContain("Answer the accountant");
    });

    it("hold A and D (plan clipboard:ZWJJdBgHm64Z): a looks-finished line carries its request as an item; an act on it restarts the 6-hour no-act count", async () => {
      const state = { pane: null as string | null };
      const f = fixture(false, { pane: () => state.pane });
      await f.tools.execute("space_nous_outcome", { requests: [{ summary: "Bob fixes the pane board", outcome: "PENDING", pane: "pane:bob0000001", id: m2 }] }, turnCtx);
      state.pane = "pane:bob0000001 reported done 12:40 UTC: pane board fixed";
      await f.done.tick(owner);
      const [entry] = await f.done.openList(owner);
      // The turn that carries the line acts on this request before it may answer NOTHING_NEW (31/10 11:18 UTC: consumed with nothing done).
      expect((f.notice.mock.calls.at(-1) as unknown[])[4]).toMatchObject({ items: [{ key: `request:${entry!.key}`, kind: "REQUEST", requestKey: entry!.key, messageId: m2, pane: "pane:bob0000001" }] });
      expect(await f.done.evidence(owner, entry!)).toBe("pane:bob0000001 reported done 12:40 UTC: pane board fixed");
      // D: seven quiet hours read as no act; an act on it (hold A reports it) starts the count over.
      f.clock.now += 7 * 3_600_000;
      expect(quietRequestsOf(await f.notes.listNotes(owner), f.clock.now)).toHaveLength(1);
      await f.done.acted(owner, [entry!.key]);
      expect(quietRequestsOf(await f.notes.listNotes(owner), f.clock.now)).toEqual([]);
    });

    it("R21-5 (REVIEW 1/11: a725f601 waited 6+ hours on a closed pane): a request whose pane closed or went is an item at once, reopen or reassign, once per pane", async () => {
      const panes: Record<string, boolean | null> = { "pane:bob0000001": true, "pane:dana000001": null };
      const f = fixture(false, { open: (paneId) => paneId in panes ? panes[paneId]! : false });
      await f.tools.execute("space_nous_outcome", { requests: [{ summary: "Bob fixes the pane board", outcome: "PENDING", pane: "pane:bob0000001", id: m2 },
        { summary: "Dana reads the bank mail", outcome: "PENDING", pane: "pane:dana000001" }] }, turnCtx);
      await f.done.tick(owner);
      const gone = () => f.notice.mock.calls.filter(([, key]) => String(key).startsWith("request-pane:"));
      expect(gone()).toEqual([]);
      // Closed, not after 6 hours: at the next minute tick; an unreadable pane (null) waits.
      panes["pane:bob0000001"] = false;
      await f.done.tick(owner);
      const bob = (await f.done.openList(owner)).find((entry) => entry.pane === "pane:bob0000001")!;
      expect(gone()).toHaveLength(1);
      expect(gone()[0]![2]).toMatch(/^Request "Bob fixes the pane board" \(nous_msg:open00000002\) lost its pane: pane:bob0000001 is closed or gone\. Reopen it .+"operation":"reopen".+or reassign/);
      expect((gone()[0] as unknown[])[4]).toMatchObject({ items: [{ key: `request:${bob.key}`, kind: "REQUEST", requestKey: bob.key, messageId: m2, pane: "pane:bob0000001" }] });
      await f.done.tick(owner);
      expect(gone()).toHaveLength(1);
      // Reassigned to another pane that closes too: one line for that pane.
      await f.tools.execute("space_nous_outcome", { requests: [{ summary: "Bob fixes the pane board", outcome: "PENDING", pane: "pane:cody000001", id: m2 }] }, turnCtx);
      await f.done.tick(owner);
      expect(gone().map(([, , line]) => String(line).match(/pane:\w+ is closed/)?.[0])).toEqual(["pane:bob0000001 is closed", "pane:cody000001 is closed"]);
      // A reopen naming the pane is the act that moves the item.
      expect(itemActed({ key: "k", kind: "REQUEST", line: "", pane: "pane:cody000001" }, [{ name: "space_execute", ok: true, subjects: [],
        args: { room: "Alex", actions: [{ kind: "pane", operation: "reopen", target: { paneIds: ["pane:cody000001"] } }] } }])).toBe(true);
    });

    it("R22-4 (1/11: nous_msg:cc96… read \"lost its pane\" while its plan was COMPLETED and \"looks finished\" was said): a finished request never reads lost its pane", async () => {
      const panes: Record<string, boolean | null> = { "pane:bob0000001": true, "pane:cody000001": true };
      const f = fixture(false, { open: (paneId) => panes[paneId] ?? false });
      await f.tools.execute("space_nous_outcome", { requests: [{ summary: "Ship the plan for the dock", outcome: "PENDING", plan: args.plan, pane: "pane:bob0000001", id: m2 },
        { summary: "Cody checks the dock on mobile", outcome: "PENDING", pane: "pane:cody000001", id: `${m2}-2` }] }, turnCtx);
      await f.done.tick(owner);
      // The plan completes and the standing orders close both panes: the tick says "looks finished" once, and no "lost its pane".
      f.complete();
      panes["pane:bob0000001"] = false;
      panes["pane:cody000001"] = false;
      await f.done.tick(owner);
      const gone = () => f.notice.mock.calls.filter(([, key]) => String(key).startsWith("request-pane:")).map(([, , line]) => String(line));
      expect(lines(f).map(([, line]) => line)).toEqual([expect.stringMatching(/^Request "Ship the plan for the dock" \(nous_msg:open00000002\) looks finished: plan clipboard:done0001 is 100%/)]);
      expect(gone()).toEqual([]);
      // Later ticks: the finished one still never does; the other request of that message, not finished, is named once that line was said.
      await f.done.tick(owner);
      await f.done.tick(owner);
      expect(gone()).toEqual([expect.stringMatching(/^Request "Cody checks the dock on mobile" .+lost its pane: pane:cody000001 is closed or gone/)]);
    });

    it("queue 1002 (8/11: requests sat 6+ hours on panes of a closed room): a send naming the request moves it to that pane only when its own pane is closed", async () => {
      const panes: Record<string, boolean | null> = { "pane:bob0000001": true };
      const f = fixture(false, { open: (paneId) => panes[paneId] ?? false });
      await f.tools.execute("space_nous_outcome", { requests: [{ summary: "Bob fixes the pane board", outcome: "PENDING", pane: "pane:bob0000001", id: m2 }] }, turnCtx);
      const sent = { paneId: "pane:dana000001", text: `Take over ${m2.slice(0, "nous_msg:".length + 8)}: the pane board.` };
      // Its pane still open: a helper sent the same work keeps the request where it is.
      await f.done.rebound(owner, [sent]);
      expect((await f.done.openList(owner))[0]!.pane).toBe("pane:bob0000001");
      panes["pane:bob0000001"] = false;
      await f.done.tick(owner);
      await f.done.rebound(owner, [{ paneId: "pane:erin000001", text: "Unrelated work" }, sent]);
      const [moved] = await f.done.openList(owner);
      expect(moved).toMatchObject({ pane: "pane:dana000001" });
      expect(moved!.paneGone).toBeUndefined();
    });

    it("backfills once the last 7 days' PENDING outcomes that have no Done record, bound to their turn's oldest message", async () => {
      const f = fixture();
      const asked = await f.notes.addMessage({ ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content: "Telegram και vault" });
      await f.notes.addMessage({ ownerUserId: owner, turnId: "nous_turn:back001", kind: "ANSWER", status: "DONE", content: "ok", meta: { reason: "OPERATOR", startedAt: asked.createdAt, replyTo: [asked.id] } });
      const facts = (turnId: string, at: string, outcomes: Array<{ summary: string; outcome: "SELF" | "PENDING" }>) => f.notes.addTurnFacts({ turnId, ownerUserId: owner, reason: "OPERATOR",
        status: "DONE", tools: {}, planPoints: 0, outcomes, startedAt: at, endedAt: at, model: null, effort: null, costUsd: null, tokens: null, goalId: null, error: null });
      await facts("nous_turn:old00001", "2026-10-20T10:00:00.000Z", [{ summary: "Something from long ago", outcome: "PENDING" }]);
      await facts("nous_turn:back001", "2026-10-28T10:00:00.000Z", [{ summary: "Telegram buttons on decisions", outcome: "PENDING" }, { summary: "Fixed the Vault inbox import", outcome: "PENDING" }]);
      // 31/10: the backfill opened 478, mostly decision, inbox and standing turns' and operator turns with no message: none of them opens.
      await facts("nous_turn:nomsg001", "2026-10-28T09:00:00.000Z", [{ summary: "An operator turn that answered no message", outcome: "PENDING" }]);
      for (const reason of ["DECISION", "INBOX", "STANDING"] as const) await f.notes.addTurnFacts({ turnId: `nous_turn:${reason.toLowerCase()}01`, ownerUserId: owner, reason, status: "DONE", tools: {},
        planPoints: 0, outcomes: [{ summary: `Inbox round: no action (${reason})`, outcome: "PENDING", messageIds: [asked.id] }], startedAt: "2026-10-28T08:00:00.000Z",
        endedAt: "2026-10-28T08:00:00.000Z", model: null, effort: null, costUsd: null, tokens: null, goalId: null, error: null });
      await f.tools.execute("space_request_done", { request: "vault", summary: "Fixed the Vault inbox import: every waiting login imports.", where: "stable", verified: "Checked on the surface the operator uses" }, ctx);
      await f.done.tick(owner);
      expect((await f.done.openList(owner)).map((entry) => [entry.messageId, entry.summary, entry.turnId])).toEqual([[asked.id, "Telegram buttons on decisions", "nous_turn:back001"]]);
      await facts("nous_turn:back002", "2026-10-28T11:00:00.000Z", [{ summary: "Another one after the backfill", outcome: "PENDING" }]);
      await f.done.tick(owner);
      expect(await f.done.openList(owner)).toHaveLength(1);
    });

    it("opens only an operator turn's PENDING request bound to an operator message; other turns refresh or close but never open", async () => {
      const f = fixture();
      const inbox = { ...ctx, turnId: "turn:inbox001", turn: { reason: "INBOX", operatorMessage: null } };
      await f.tools.execute("space_nous_outcome", { requests: [{ summary: "Inbox round: no action", outcome: "PENDING", id: m1 }] }, inbox);
      await f.tools.execute("space_nous_outcome", { requests: [{ summary: "Approved the release decision", outcome: "PENDING" }] }, { ...inbox, turn: { reason: "DECISION", operatorMessage: null } });
      await f.tools.execute("space_nous_outcome", { requests: [{ summary: "A turn that answered no message", outcome: "PENDING" }] }, { ...ctx, turn: { ...ctx.turn, replyTo: [] } });
      expect(await f.done.openList(owner)).toEqual([]);
      await f.tools.execute("space_nous_outcome", { requests: [{ summary: "Build the Requests tab for the operator", outcome: "PENDING" }] }, turnCtx);
      await f.tools.execute("space_nous_outcome", { requests: [{ summary: "Build the Requests tab for the operator: tests left", outcome: "PENDING" }] }, inbox);
      expect((await f.done.openList(owner)).map((entry) => entry.summary)).toEqual(["Build the Requests tab for the operator: tests left"]);
      await f.tools.execute("space_nous_outcome", { requests: [{ summary: "Build the Requests tab for the operator: tests left", outcome: "SELF" }] }, inbox);
      expect(await f.done.openList(owner)).toEqual([]);
      // Closed, never deleted (nous_notes is class A): the note keeps its data with why it closed.
      const kept = (await f.notes.listNotes(owner)).filter((note) => note.key.startsWith("request-done:open:")).map((note) => JSON.parse(note.text));
      expect(kept).toEqual([expect.objectContaining({ messageId: m1, summary: "Build the Requests tab for the operator: tests left", closedReason: "outcome SELF", closedAt: expect.any(String) })]);
    });

    it("closes once, silently, the open requests that are no operator request or whose message is already done or answered; the daily line counts the rest", async () => {
      const [a, b, c, d] = ["nous_msg:clean0000001", "nous_msg:clean0000002", "nous_msg:clean0000003", "nous_msg:clean0000004"];
      const f = fixture(false, { statuses: { [a]: "DONE", [b]: "ANSWERED", [c]: "IN_PROGRESS", [d]: "DONE" } });
      const open = (key: string, messageId: string | null, turnId: string, openedAt: string) => f.notes.setNote(owner, `request-done:open:${key}`,
        JSON.stringify({ messageId, summary: `Request ${key}`, turnId, openedAt, reportedAt: openedAt }));
      const facts = (turnId: string, reason: "OPERATOR" | "INBOX") => f.notes.addTurnFacts({ turnId, ownerUserId: owner, reason, status: "DONE", tools: {}, planPoints: 0,
        outcomes: [], startedAt: "2026-10-28T10:00:00.000Z", endedAt: "2026-10-28T10:00:00.000Z", model: null, effort: null, costUsd: null, tokens: null, goalId: null, error: null });
      await facts("nous_turn:oper0001", "OPERATOR");
      await facts("nous_turn:inbx0001", "INBOX");
      // As stable had it on 31/10: the backfill ran this morning.
      await f.notes.setNote(owner, "request-done:open-backfill", "2026-10-29T08:00:00.000Z");
      await open("000000000000000000000001", null, "nous_turn:dec00001", "2026-10-26T10:00:00.000Z");
      await open("000000000000000000000002", a, "nous_turn:inbx0001", "2026-10-26T11:00:00.000Z");
      await open("000000000000000000000003", a, "nous_turn:oper0001", "2026-10-26T12:00:00.000Z");
      await open("000000000000000000000004", b, "nous_turn:oper0001", "2026-10-27T12:00:00.000Z");
      await open("000000000000000000000005", c, "nous_turn:oper0001", "2026-10-27T13:00:00.000Z");
      // Opened after the backfill: its message's status is not judged.
      await open("000000000000000000000006", d, "nous_turn:oper0001", "2026-10-29T09:00:00.000Z");
      await f.done.tick(owner);
      expect((await f.done.openList(owner)).map((entry) => entry.key.slice(-1))).toEqual(["6", "5"]);
      const reasons = Object.fromEntries((await f.notes.listNotes(owner)).filter((note) => note.key.startsWith("request-done:open:")).map((note) => [note.key.slice(-1), JSON.parse(note.text).closedReason]));
      expect(reasons).toEqual({ 1: "backfill: not an operator request", 2: "backfill: not an operator request", 3: "already done", 4: "already done", 5: undefined, 6: undefined });
      expect(await f.notifications.list(owner, { status: "ALL", limit: 50 })).toEqual([]);
      // The daily line counts only what remains open and quiet (6 is 3.5 hours old).
      expect(lines(f)).toEqual([["request-open:daily", expect.stringMatching(/^1 open request of the operator's had nothing new for 6 hours \(oldest 2026-10-27 13:00 UTC/)]]);
      // Once: a request opened later whose message reads done stays open.
      await open("000000000000000000000007", a, "nous_turn:oper0001", "2026-10-28T10:00:00.000Z");
      await f.done.tick(owner);
      expect(await f.done.openList(owner)).toHaveLength(3);
    });

    it("lists newest first, 50 a call with the total, and closes ONE a call by key or message, with this turn's evidence, no Done notification unless done (operator 9/11)", async () => {
      const f = fixture();
      for (let n = 0; n < 60; n += 1) {
        const at = new Date(Date.parse("2026-10-29T00:00:00.000Z") + n * 60_000).toISOString();
        await f.notes.setNote(owner, `request-done:open:${String(n).padStart(24, "0")}`, JSON.stringify({ messageId: `nous_msg:bulk${String(n).padStart(8, "0")}`,
          summary: `Subject${n} topic${n} item${n}`, turnId: "nous_turn:oper0001", openedAt: at, reportedAt: at }));
      }
      await f.notes.setNote(owner, "request-done:open-backfill", "2026-10-28T00:00:00.000Z");
      await f.notes.setNote(owner, "request-done:open-cleanup", "2026-10-28T00:00:00.000Z");
      const read = async (args: Record<string, unknown>, context = ctx) => {
        const result = await f.tools.execute("space_open_requests", args, context);
        return { result, list: JSON.parse(result.result.slice(result.result.indexOf("{"))) as { total: number; shown: number; requests: Array<{ key: string; messageId: string }> } };
      };
      const first = await read({});
      expect(first.list).toMatchObject({ total: 60, offset: 0, shown: 50 });
      expect(first.list.requests[0]).toMatchObject({ key: "000000000000000000000059", messageId: "nous_msg:bulk00000059" });
      expect((await read({ offset: 50 })).list.requests.at(-1)!.key).toBe("000000000000000000000000");
      const drop = "Inbox round, not an operator request";
      // Helpers read, never close.
      const helper = await f.tools.execute("space_open_requests", { close: [{ key: "000000000000000000000059", outcome: "DROPPED", note: drop }] }, { ...ctx, turn: { reason: "HELPER", operatorMessage: null } });
      expect(helper).toMatchObject({ ok: false, refused: true });
      expect(nousSubagentTools(nousToolDefinitions({ copilots: false })).some((tool) => tool.name === "space_open_requests")).toBe(true);
      // 9/11 03:28 UTC: 35 closed in one call; now more than one item is refused whole.
      const bulk = await f.tools.execute("space_open_requests", { close: [{ key: "000000000000000000000000", outcome: "DROPPED", note: drop },
        { key: "000000000000000000000001", outcome: "DROPPED", note: drop }] }, ctx);
      expect(bulk).toMatchObject({ ok: false, refused: true, display: "Not closed: 2 requests in one call", result: expect.stringContaining("Check one, close one") });
      expect(await f.done.openList(owner)).toHaveLength(60);
      const one = async (item: Record<string, unknown>) => (await read({ close: [item] })).result.result;
      expect(await one({ key: "000000000000000000000000", outcome: "DROPPED", note: "x" })).toMatch(/^Closed 0\.\n000000000000000000000000: DROPPED needs a note naming why/);
      expect(await one({ key: "000000000000000000000000", outcome: "DROPPED", note: drop })).toMatch(/^Closed 1\./);
      expect(await one({ messageId: "nous_msg:bulk00000058", outcome: "SELF", note: "Done long ago" })).toMatch(/^Closed 1\./);
      expect(await one({ messageId: "nous_msg:bulk00000057", outcome: "OPERATOR", note: "x", done: true })).toContain("nous_msg:bulk00000057: done takes SELF or HELPER");
      expect(await one({ key: "request-done:open:000000000000000000000056", outcome: "SELF", note: "x", done: true })).toContain("done needs where");
      expect(await one({ key: "000000000000000000000056", outcome: "SELF", note: "x", done: true, where: "dev", verified: "looked at it" })).toContain("done needs verified");
      expect(await one({ key: "000000000000000000000056", outcome: "SELF", note: "x", done: true, where: "dev" })).toContain("done needs verified");
      expect(await one({ messageId: "nous_msg:missing00001", outcome: "SELF", note: "x" })).toContain("nous_msg:missing00001: no open request");
      expect((await read({})).list).toMatchObject({ total: 58 });
      expect(await f.notifications.list(owner, { status: "ALL", limit: 50 })).toEqual([]);
      // done: its Done record, bound to its operator message.
      const done = await read({ close: [{ key: "000000000000000000000057", outcome: "SELF", note: "Το bulk 57 έγινε.", done: true, where: "dev", verified: "Checked on the surface the operator uses" }] });
      expect(done.result.result).toMatch(/^Closed 1, 1 recorded in Done\./);
      const records = await f.notifications.list(owner, { status: "ALL", limit: 50 });
      expect(records).toEqual([expect.objectContaining({ kind: "REQUEST_DONE", dedupeKey: "nous:done:nous_msg:bulk00000057", body: "Το bulk 57 έγινε.\nChecked: Checked on the surface the operator uses", payload: expect.objectContaining({ verified: "Checked on the surface the operator uses" }) })]);
      expect(done.list.total).toBe(57);
    });

    it("closes an operator message with no open request by its messageId: DROPPED reads Answered, done reads Done, with no notification (Nous 6/11, 801 Not done)", async () => {
      const ids = ["nous_msg:noopen000001", "nous_msg:noopen000002", "nous_msg:noopen000003"];
      const f = fixture(false, { statuses: { [ids[0]!]: "NOT_DONE", [ids[1]!]: "NOT_DONE", [ids[2]!]: "DONE" } });
      await f.notes.setNote(owner, "request-done:open-backfill", "2026-10-28T00:00:00.000Z");
      await f.notes.setNote(owner, "request-done:open-cleanup", "2026-10-28T00:00:00.000Z");
      const drop = "Ερώτηση, απαντήθηκε στο chat";
      const close = async (item: Record<string, unknown>) => (await f.tools.execute("space_open_requests", { close: [item] }, ctx)).result;
      expect(await close({ messageId: ids[0], outcome: "DROPPED", note: drop })).toMatch(/^Closed 1\./);
      expect(await close({ messageId: ids[1], outcome: "SELF", note: "Έγινε, commit abc1234 στο stable", done: true, where: "stable", verified: "commit abc1234 on main" })).toMatch(/^Closed 1, 1 recorded in Done\./);
      const result = [await close({ messageId: ids[1], outcome: "SELF", note: "Έγινε, commit abc1234 στο stable", done: true, where: "stable", verified: "commit abc1234 on main" }),
        await close({ messageId: ids[2], outcome: "DROPPED", note: drop }), await close({ messageId: "nous_msg:missing00001", outcome: "DROPPED", note: drop })].join("\n");
      expect(result).toContain(`${ids[1]}: already done`);
      expect(result).toContain(`${ids[2]}: already done`);
      expect(result).toContain("nous_msg:missing00001: no open request");
      expect(await f.notifications.list(owner, { status: "ALL", limit: 50 })).toEqual([]);
      expect(await f.done.openList(owner)).toEqual([]);
      const message = (id: string) => ({ id, ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content: "Κάνε κάτι", meta: {},
        createdAt: "2026-10-29T10:00:00.000Z", updatedAt: "2026-10-29T10:00:00.000Z" }) as never;
      const answers = [{ turnId: "nous_turn:a", createdAt: "2026-10-29T10:05:00.000Z", startedAt: "2026-10-29T10:01:00.000Z", replyTo: ids.slice(0, 2) }];
      const derived = deriveNousRequests(ids.slice(0, 2).map(message), { answers, turns: [], done: [], notes: await f.notes.listNotes(owner), openDecisions: [] } as never, new Map());
      expect(derived.map((row) => row.status)).toEqual(["ANSWERED", "DONE"]);
    });

    it("lists the Requests tab's Not done messages as notDone until each is closed DROPPED or done (operator 9/11 10:21 BKK «Βλέπω 43 όπως έβλεπα»)", async () => {
      const f = fixture(false, { derived: true });
      await f.notes.setNote(owner, "request-done:open-backfill", "2026-10-28T00:00:00.000Z");
      await f.notes.setNote(owner, "request-done:open-cleanup", "2026-10-28T00:00:00.000Z");
      const [a, b] = [await f.notes.addMessage({ ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content: "Φτιάξε το Vault ".repeat(30) }),
        await f.notes.addMessage({ ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content: "Τρέξε το backup" })];
      const at = new Date(Date.now() + 1_000).toISOString();
      await f.notes.addMessage({ ownerUserId: owner, turnId: "nous_turn:nd000001", kind: "ANSWER", status: "DONE", content: "ok", meta: { reason: "OPERATOR", startedAt: a.createdAt, replyTo: [a.id, b.id] } });
      await f.notes.addTurnFacts({ turnId: "nous_turn:nd000001", ownerUserId: owner, reason: "OPERATOR", status: "DONE", tools: {}, planPoints: 0, startedAt: at, endedAt: at,
        outcomes: [{ summary: "Vault", outcome: "PENDING", messageIds: [a.id] }, { summary: "Backup", outcome: "PENDING", messageIds: [b.id] }],
        model: null, effort: null, costUsd: null, tokens: null, goalId: null, error: null });
      const read = async () => (await f.tools.execute("space_open_requests", {}, ctx)).result;
      const list = JSON.parse(await read()) as { total: number; notDone: { total: number; items: Array<{ messageId: string; createdAt: string; text: string }> } };
      expect(list).toMatchObject({ total: 0, notDone: { total: 2, items: [{ messageId: b.id, createdAt: b.createdAt, text: "Τρέξε το backup" }, { messageId: a.id }] } });
      expect(list.notDone.items[1]!.text).toHaveLength(300);
      await f.tools.execute("space_open_requests", { close: [{ messageId: a.id, outcome: "DROPPED", note: "Ο operator το άφησε, δεν το θέλει πια" }] }, ctx);
      await f.tools.execute("space_open_requests", { close: [{ messageId: b.id, outcome: "SELF", note: "Το backup έτρεξε.", done: true, where: "dev", verified: "Read the backup log on dev" }] }, ctx);
      expect(await read()).toBe("No open requests.");
    });

    it("closeFile: closes a file of ONE close item like close, refuses a file of more, never defaults verified, and a repeat answers already done (nous_msg:72999c27, operator 9/11)", async () => {
      const ids = ["nous_msg:file00000001", "nous_msg:file00000002", "nous_msg:file00000003"];
      const f = fixture(false, { statuses: { [ids[0]!]: "NOT_DONE", [ids[1]!]: "NOT_DONE", [ids[2]!]: "IN_PROGRESS" } });
      await f.notes.setNote(owner, "request-done:open-backfill", "2026-10-28T00:00:00.000Z");
      await f.notes.setNote(owner, "request-done:open-cleanup", "2026-10-28T00:00:00.000Z");
      await f.notes.setNote(owner, `request-done:open:${"a".repeat(24)}`, JSON.stringify({ messageId: ids[2], summary: "Fix the board", turnId: "nous_turn:oper0001",
        openedAt: "2026-10-29T10:00:00.000Z", reportedAt: "2026-10-29T10:00:00.000Z" }));
      const base = await mkdtemp(join(tmpdir(), "nous-close-file-"));
      const root = join(base, "agent-workspace");
      await mkdir(join(root, "audit"), { recursive: true });
      const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
      const drop = "Ερώτηση, απαντήθηκε στο chat";
      await writeFile(join(base, "outside.jsonl"), `${line({ messageId: ids[0], outcome: "DROPPED", note: drop })}\n`);
      await symlink(join(base, "outside.jsonl"), join(root, "audit", "link.jsonl"));
      await writeFile(join(root, "audit", "many.jsonl"), [line({ messageId: ids[0], outcome: "DROPPED", note: drop }), "", line({ messageId: ids[1], outcome: "DROPPED", note: drop }), "{not json"].join("\n"));
      await writeFile(join(root, "audit", "unverified.jsonl"), line({ messageId: ids[1], outcome: "SELF", done: true, where: "stable", note: "Έγινε στο stable" }));
      await writeFile(join(root, "audit", "one.jsonl"), `${line({ messageId: ids[2], outcome: "HELPER", done: false, where: "dev", note: "n".repeat(900) })}\n`);
      const files = createNousFiles({ root, artifactRoot: base, rooms: async () => [], listArtifacts: async () => [], getArtifact: async () => { throw new Error("none"); } });
      const tools = createNousTools({ requestDone: f.done, files } as unknown as NousToolDeps);
      const run = async (closeFile: string, context = ctx) => tools.execute("space_open_requests", { closeFile }, context);

      expect(await run("audit/one.jsonl", { ...ctx, turn: { reason: "HELPER", operatorMessage: null } })).toMatchObject({ ok: false, refused: true });
      expect(await run("/etc/passwd")).toMatchObject({ ok: false });
      expect(await run("audit/link.jsonl")).toMatchObject({ ok: false, result: expect.stringContaining("outside the agent workspace") });
      expect(await run("audit/many.jsonl")).toMatchObject({ ok: false, refused: true, display: expect.stringMatching(/^Not closed: 3 lines in /), result: expect.stringContaining("Check one, close one") });
      expect(await f.done.openList(owner)).toHaveLength(1);
      expect(await f.notes.listNotes(owner).then((notes) => notes.filter((note) => note.key.startsWith("request-done:open:")))).toHaveLength(1);

      // The old default "audit 6/11 results2" is gone: done with no verified is refused like a close item.
      const unverified = JSON.parse((await run(`${root}/audit/unverified.jsonl`)).result) as { lines: number; closed: number; errors: string[] };
      expect(unverified).toMatchObject({ lines: 1, closed: 0 });
      expect(unverified.errors.join("\n")).toMatch(/nous_msg:file00000002: done needs verified/);

      const first = await run(`${root}/audit/one.jsonl`);
      expect(first.ok).toBe(true);
      expect(JSON.parse(first.result)).toMatchObject({ lines: 1, closed: 1, alreadyDone: 0, notOpen: 0, errors: [], open: 0 });
      expect(await f.notifications.list(owner, { status: "ALL", limit: 50 })).toEqual([]);
      const closed = (await f.notes.listNotes(owner)).filter((note) => note.key.startsWith("request-done:open:")).map((note) => JSON.parse(note.text) as { messageId: string; closedReason?: string });
      expect(closed.find((entry) => entry.messageId === ids[2])?.closedReason).toMatch(/^HELPER: n+…$/);
      // Idempotent: the same file again closes nothing new.
      expect(JSON.parse((await run("~/agent-workspace/audit/one.jsonl")).result)).toMatchObject({ lines: 1, closed: 0, alreadyDone: 1, notOpen: 0, open: 0 });
      expect((await f.notes.listNotes(owner)).filter((note) => note.key.startsWith("request-done:open:"))).toHaveLength(closed.length);
    });

    it("reopen: a message closed DROPPED (Answered) goes back to In progress with an audit line, other messages untouched, and closes again (operator 9/11 nous_msg:a45dfd55)", async () => {
      const f = fixture(false, { derived: true });
      await f.notes.setNote(owner, "request-done:open-backfill", "2026-10-28T00:00:00.000Z");
      await f.notes.setNote(owner, "request-done:open-cleanup", "2026-10-28T00:00:00.000Z");
      const [a, b] = [await f.notes.addMessage({ ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content: "Φτιάξε το Vault" }),
        await f.notes.addMessage({ ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content: "Τρέξε το backup" })];
      const at = new Date(Date.now() + 1_000).toISOString();
      await f.notes.addMessage({ ownerUserId: owner, turnId: "nous_turn:re000001", kind: "ANSWER", status: "DONE", content: "ok", meta: { reason: "OPERATOR", startedAt: a.createdAt, replyTo: [a.id, b.id] } });
      await f.notes.addTurnFacts({ turnId: "nous_turn:re000001", ownerUserId: owner, reason: "OPERATOR", status: "DONE", tools: {}, planPoints: 0, startedAt: at, endedAt: at,
        outcomes: [{ summary: "Vault", outcome: "PENDING", messageIds: [a.id] }, { summary: "Backup", outcome: "PENDING", messageIds: [b.id] }],
        model: null, effort: null, costUsd: null, tokens: null, goalId: null, error: null });
      const requests = createNousRequests({ repository: f.notes, notifications: f.notifications, plan: async () => null });
      const status = async (id: string) => (await requests.page(owner, { limit: 50 })).requests.find((row) => row.messageId === id)?.status;
      const call = (args: Record<string, unknown>) => f.tools.execute("space_open_requests", args, ctx);
      const drop = "Ο operator το άφησε, δεν το θέλει πια";
      await call({ close: [{ messageId: a.id, outcome: "DROPPED", note: drop }] });
      await call({ close: [{ messageId: b.id, outcome: "SELF", note: "Το backup έτρεξε.", done: true, where: "dev", verified: "Read the backup log on dev" }] });
      expect(await status(a.id)).toBe("ANSWERED");
      expect(await status(b.id)).toBe("DONE");
      const notesBefore = (await f.notes.listNotes(owner)).filter((note) => note.key.startsWith("request-done:sent:")).map((note) => note.key);

      f.clock.now += 60_000;
      expect(await call({ reopen: { messageId: a.id, note: "short" } })).toMatchObject({ ok: false });
      expect(await call({ reopen: { messageId: a.id, note: "Το Vault δεν ανοίγει ακόμα στο stable" }, close: [{ messageId: b.id, outcome: "DROPPED", note: drop }] })).toMatchObject({ ok: false });
      expect(await call({ reopen: { messageId: a.id, note: "Το Vault δεν ανοίγει ακόμα στο stable" } })).toMatchObject({ ok: true, display: expect.stringMatching(/^Reopened /) });
      expect(await call({ reopen: { messageId: a.id, note: "Το Vault δεν ανοίγει ακόμα στο stable" } })).toMatchObject({ ok: false, result: expect.stringContaining("already open") });
      expect(await call({ reopen: { messageId: "nous_msg:nowhere00001", note: "Το Vault δεν ανοίγει ακόμα στο stable" } })).toMatchObject({ ok: false, result: expect.stringContaining("no such operator message") });
      expect(["IN_PROGRESS", "NOT_DONE"]).toContain(await status(a.id));
      expect(await status(b.id)).toBe("DONE");
      expect((await f.notes.listNotes(owner)).filter((note) => note.key.startsWith("request-done:sent:")).map((note) => note.key)).toEqual(notesBefore);
      const entries = (await f.notes.listNotes(owner)).filter((note) => note.key.startsWith("request-done:open:")).map((note) => JSON.parse(note.text) as { messageId: string; closedAt?: string; reopenedAt?: string; reopenNote?: string; reopens?: boolean });
      expect(entries.filter((entry) => entry.messageId === a.id)).toEqual(expect.arrayContaining([expect.objectContaining({ closedAt: expect.any(String), reopenedAt: expect.any(String), reopenNote: "Το Vault δεν ανοίγει ακόμα στο stable" })]));
      expect(entries.filter((entry) => entry.messageId === a.id && entry.reopens && !entry.closedAt)).toHaveLength(1);
      f.clock.now += 60_000;

      // It closes again, one at a time, with this turn's evidence.
      expect((await call({ close: [{ messageId: a.id, outcome: "SELF", note: "Το Vault ανοίγει.", done: true, where: "stable", verified: "Opened the Vault on stable and read an item" }] })).result).toMatch(/^Closed 1, 1 recorded in Done\./);
      expect(await status(a.id)).toBe("DONE");
    });
  });
});

describe("priority panes for Space Gateway's pace cap (operator rule 31/10, 6/11)", () => {
  it("names each pane of an open operator request once; closed requests, requests without a pane and malformed ids do not count", () => {
    const note = (key: string, entry: Record<string, unknown>) => ({ key: `request-done:open:${key}`, text: JSON.stringify({ messageId: null, summary: "Fix the focus", openedAt: "2026-11-06T03:00:00.000Z", reportedAt: "2026-11-06T03:00:00.000Z", ...entry }) });
    expect(priorityPanesOf([
      note("a", { pane: "pane:emma0001" }), note("b", { pane: "pane:emma0001" }), note("c", { pane: "pane:hugo0001" }),
      note("d", { pane: "pane:finn0001", closedAt: "2026-11-06T04:00:00.000Z" }), note("e", {}), note("f", { pane: "Emma" }),
      { key: "other:note", text: JSON.stringify({ pane: "pane:cody0001", summary: "x" }) }
    ])).toEqual(["pane:emma0001", "pane:hugo0001"]);
  });
});
