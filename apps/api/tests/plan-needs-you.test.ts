import { describe, expect, it } from "vitest";
import { eventSchema, type ClipboardItem, type NousDecision } from "@space/contracts";
import { InMemoryNousRepository, InMemorySpaceNotificationsRepository } from "@space/db";
import { makeSpaceId, SpaceEventBus } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";
import { agentNeedsYouKey } from "../src/pane-reports.js";
import { closePlanWaitOnAnswer, createPlanNeedsYou, planNoticeKey } from "../src/nous/plan-needs-you.js";

// Operator 13/11 (nous_msg:2e24947d): every plan waiting on the operator has a Needs you item; a closed pane's asks move to their plan's.
const owner = "user:operator";
const plan = (id: string, extra: Partial<ClipboardItem> = {}) => ({ id, title: `Plan ${id}`, text: "", roomId: "room:r1", paneId: null, isCompleted: false,
  executionStatus: "IN_PROGRESS", waitsOn: { kind: "OPERATOR", what: "Choose the hosting plan", until: null }, ...extra }) as unknown as ClipboardItem;

function fixture(plans: ClipboardItem[]) {
  const repository = new InMemorySpaceNotificationsRepository(undefined, true);
  const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
    recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
    nous: { held: async () => false, raised: () => {} } });
  const state = { plans };
  const decisions: NousDecision[] = [];
  const needs = createPlanNeedsYou({ notifications: service, plans: async () => state.plans, decisions: async () => decisions });
  const waiting = async () => (await service.list(owner, { status: "NEEDS_YOU", limit: 200 }));
  return { service, needs, state, waiting, decisions };
}

describe("Plan Needs you", () => {
  it("operator 13/11 23:56 BKK (nous_msg:4258ef8d): a plan waiting on the operator with no card gets Space's card; a real card is shown instead", async () => {
    const f = fixture([plan("clipboard:mmmeF0-e3x4G"), plan("clipboard:planBBBB", { paneId: "pane:p1" }), plan("clipboard:planCCCC", { waitsOn: null })]);
    await f.service.raise({ ownerUserId: owner, roomId: "room:r1", paneId: "pane:p1", source: "NOUS", kind: "NEEDS_HANDS", severity: "ATTENTION", title: "Sign in",
      body: "Sign in to Hetzner", link: { roomId: "room:r1", paneId: "pane:p1" }, dedupeKey: "nous:pane:pane:p1", telegram: null, payload: {} });
    expect(await f.needs.sync(owner)).toEqual({ raised: 1, resolved: 0, missing: [] });
    const own = (await f.waiting()).filter((card) => card.dedupeKey?.startsWith("nous:plan:"));
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ dedupeKey: planNoticeKey("clipboard:mmmeF0-e3x4G"), paneId: null, roomId: "room:r1", title: "Plan clipboard:mmmeF0-e3x4G",
      payload: { planId: "clipboard:mmmeF0-e3x4G", derived: true, ask: { question: "This plan waits on you: Choose the hosting plan", options: ["Done", "Need help from an agent", "Not now"] } } });
    expect(own[0]!.payload.ask).not.toHaveProperty("recommended");
    // Unchanged: nothing new; a new wait raises it again with the new text.
    expect(await f.needs.sync(owner)).toEqual({ raised: 0, resolved: 0, missing: [] });
    f.state.plans = [plan("clipboard:mmmeF0-e3x4G", { waitsOn: { kind: "OPERATOR", what: "Pay the invoice", until: null } as never })];
    expect(await f.needs.sync(owner)).toEqual({ raised: 1, resolved: 0, missing: [] });
    expect((await f.waiting()).find((card) => card.dedupeKey === planNoticeKey("clipboard:mmmeF0-e3x4G"))?.payload.what).toBe("Pay the invoice");
    // Nous's real card for the plan replaces Space's (same key, not derived) and stays: never both.
    await f.service.raise({ ownerUserId: owner, roomId: "room:r1", paneId: null, source: "NOUS", kind: "NEEDS_YOU", severity: "ATTENTION", title: "Invoice",
      body: "Pay the Hetzner invoice", link: { roomId: "room:r1" }, dedupeKey: planNoticeKey("clipboard:mmmeF0-e3x4G"), telegram: null,
      payload: { planId: "clipboard:mmmeF0-e3x4G", ask: { question: "Pay invoice 4411 (EUR 38)?", options: ["Approve", "Reject"], recommended: "Approve", answer: { kind: "NOUS" } } } });
    expect(await f.needs.sync(owner)).toEqual({ raised: 0, resolved: 0, missing: [] });
    const left = (await f.waiting()).filter((card) => card.dedupeKey?.startsWith("nous:plan:"));
    expect(left.map((card) => [card.dedupeKey, Boolean(card.payload.derived)])).toEqual([[planNoticeKey("clipboard:mmmeF0-e3x4G"), false]]);
  });

  it("a decision that asks for the plan resolves Space's card, and so does the wait clearing", async () => {
    const f = fixture([plan("clipboard:-VCYK0c2heK9"), plan("clipboard:9ehKTs9DuKtQ")]);
    expect((await f.needs.sync(owner)).raised).toBe(2);
    f.decisions.push({ id: "decision:d1", refs: { planId: "clipboard:-VCYK0c2heK9" } } as unknown as NousDecision);
    f.state.plans = [plan("clipboard:-VCYK0c2heK9"), plan("clipboard:9ehKTs9DuKtQ", { waitsOn: { kind: "NOUS", what: "Nous checks", until: null } as never })];
    expect(await f.needs.sync(owner)).toEqual({ raised: 0, resolved: 2, missing: [] });
    expect(await f.waiting()).toEqual([]);
  });

  it("a closed plan still parked on an open OPERATOR condition gets Space's card; a met condition resolves it", async () => {
    const condition = { id: "c1", who: "OPERATOR", what: "Sign the contract", check: { kind: "MANUAL" }, checkedAt: null, metAt: null, evidence: null };
    const parked = (state: string) => ({ reason: "Waits", since: "2026-11-13T05:00:00.000Z", resumedAt: null, conditions: [{ ...condition, state }] });
    const f = fixture([plan("clipboard:a1HyMJ9g-0eC", { waitsOn: null, isCompleted: true, executionStatus: "COMPLETED", parked: parked("OPEN") } as never)]);
    expect((await f.needs.sync(owner)).raised).toBe(1);
    expect((await f.waiting())[0]!.payload.what).toBe("Sign the contract");
    f.state.plans = [{ ...f.state.plans[0]!, parked: parked("MET") } as never];
    expect(await f.needs.sync(owner)).toEqual({ raised: 0, resolved: 1, missing: [] });
  });

  it("operator 14/11 00:41 BKK (nous_msg:f8a4d2df): an item answered before the fix (left READ) or dismissed goes, and Space raises none again for that wait", async () => {
    const f = fixture([plan("clipboard:-VCYK0c2heK9"), plan("clipboard:9ehKTs9DuKtQ")]);
    expect((await f.needs.sync(owner)).raised).toBe(2);
    const [first, second] = await f.waiting();
    await f.service.setStatus(owner, first!.id, "READ", { answer: { text: "Need help from an agent", at: "2026-11-13T17:40:00.000Z", routed: "NOUS" } });
    await f.service.setStatus(owner, second!.id, "ACKED");
    expect(await f.needs.sync(owner)).toEqual({ raised: 0, resolved: 1, missing: [] });
    expect(await f.needs.sync(owner)).toEqual({ raised: 0, resolved: 0, missing: [] });
    expect(await f.waiting()).toEqual([]);
  });

  it("a raise that fails is named as missing (the Score lever asks Nous to raise it)", async () => {
    const f = fixture([plan("clipboard:planAAAA")]);
    const needs = createPlanNeedsYou({ notifications: { list: f.service.list, resolve: f.service.resolve, raise: async () => { throw new Error("db down"); } },
      plans: async () => f.state.plans, decisions: async () => [] });
    expect(await needs.sync(owner)).toEqual({ raised: 0, resolved: 0, missing: ["clipboard:planAAAA"] });
    expect(needs.missing(owner, "clipboard:planAAAA")).toBe(true);
  });

  it("a pane closing keeps the plan's item: Space's card stays, a pane's card moves to the plan", async () => {
    const f = fixture([plan("clipboard:planAAAA", { paneId: "pane:p1" }), plan("clipboard:planBBBB", { paneId: "pane:p2" })]);
    await f.service.raise({ ownerUserId: owner, roomId: "room:r1", paneId: "pane:p2", source: "AGENT", kind: "NEEDS_HANDS", severity: "ATTENTION", title: "Press the key",
      body: "Press the YubiKey", link: { roomId: "room:r1", paneId: "pane:p2" }, dedupeKey: agentNeedsYouKey("pane:p2"), telegram: null, payload: {} });
    expect((await f.needs.sync(owner)).raised).toBe(1);
    for (const pane of ["pane:p1", "pane:p2"]) {
      await f.needs.carry(owner, pane);
      await f.service.resolve(owner, agentNeedsYouKey(pane), "its pane is gone");
    }
    expect(await f.needs.sync(owner)).toEqual({ raised: 0, resolved: 0, missing: [] });
    expect((await f.waiting()).map((card) => [card.dedupeKey, card.title]).sort()).toEqual([[planNoticeKey("clipboard:planAAAA"), "Plan clipboard:planAAAA"],
      [planNoticeKey("clipboard:planBBBB"), "Press the key"]]);
  });

  it("fix 2: a closing pane's open cards move to its plan's item instead of vanishing", async () => {
    const f = fixture([plan("clipboard:planAAAA", { paneId: "pane:p1", waitsOn: null })]);
    await f.service.raise({ ownerUserId: owner, roomId: "room:r1", paneId: "pane:p1", source: "AGENT", kind: "NEEDS_HANDS", severity: "ATTENTION", title: "Pay the invoice",
      body: "The Hetzner invoice needs your card", link: { roomId: "room:r1", paneId: "pane:p1" }, dedupeKey: agentNeedsYouKey("pane:p1"), telegram: null, payload: {} });
    expect(await f.needs.carry(owner, "pane:p1")).toBe(1);
    await f.service.resolve(owner, agentNeedsYouKey("pane:p1"), "its pane is gone");
    const left = await f.waiting();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ dedupeKey: planNoticeKey("clipboard:planAAAA"), paneId: null, title: "Pay the invoice", payload: { planId: "clipboard:planAAAA", derived: false } });
    // A carried card stays while the plan is open, whatever its waitsOn says.
    expect(await f.needs.sync(owner)).toEqual({ raised: 0, resolved: 0, missing: [] });
  });

  it("fix 3: Space's old text item clears, and a plan card clears when its plan closes", async () => {
    const f = fixture([plan("clipboard:planAAAA", { waitsOn: { kind: "NOUS", what: "Nous checks the prices", until: null } as never })]);
    for (const id of ["clipboard:planAAAA", "clipboard:planBBBB"]) {
      await f.service.raise({ ownerUserId: owner, roomId: "room:r1", paneId: null, source: "NOUS", kind: "NEEDS_HANDS", severity: "ATTENTION", title: id, body: "Pick",
        link: {}, dedupeKey: planNoticeKey(id), telegram: null, payload: { planId: id, ask: { question: "Pick?", options: ["Approve", "Reject"], recommended: "Approve", answer: { kind: "NOUS" } } } });
    }
    expect(await f.needs.sync(owner)).toEqual({ raised: 0, resolved: 1, missing: [] });
    expect((await f.waiting()).map((card) => card.dedupeKey)).toEqual([planNoticeKey("clipboard:planAAAA")]);
  });

  it("operator 13/11 15:37 BKK: an answered decision of plan S6PyXKwpBrit ends its wait on the operator, and its text item goes", async () => {
    const f = fixture([plan("clipboard:S6PyXKwpBrit", { waitsOn: { kind: "OPERATOR", what: "EXTERNAL decision (13/11 12:50 BKK): submit the case", until: null } })]);
    await f.service.raise({ ownerUserId: owner, roomId: "room:r1", paneId: null, source: "NOUS", kind: "NEEDS_YOU", severity: "ATTENTION", title: "EXTERNAL decision",
      body: "submit the case", link: {}, dedupeKey: planNoticeKey("clipboard:S6PyXKwpBrit"), payload: { planId: "clipboard:S6PyXKwpBrit", derived: true }, telegram: null });
    const repository = new InMemoryNousRepository();
    const store = { getClipboardItem: (_owner: string, id: string) => f.state.plans.find((entry) => entry.id === id) ?? null,
      updateClipboardItemProgress: (_owner: string, id: string, patch: { waitsOn?: null }) => { f.state.plans = f.state.plans.map((entry) => entry.id === id ? { ...entry, ...patch } : entry); return null; } };
    closePlanWaitOnAnswer(repository, store as never);
    const ask = (planId: string) => repository.createDecision({ ownerUserId: owner, category: "EXTERNAL", title: "Submit the case?", body: "", options: [], recommendation: null,
      action: null, refs: { planId } } as never);
    const other = await ask("clipboard:other0001");
    await repository.answerDecision(owner, other.id, { status: "APPROVED", answer: null });
    expect(f.state.plans[0]!.waitsOn).not.toBeNull();
    const decision = await ask("clipboard:S6PyXKwpBrit");
    expect((await repository.answerDecision(owner, decision.id, { status: "APPROVED", answer: null }))?.status).toBe("APPROVED");
    expect(f.state.plans[0]!.waitsOn).toBeNull();
    expect(await f.needs.sync(owner)).toEqual({ raised: 0, resolved: 1, missing: [] });
    expect(await f.waiting()).toEqual([]);
  });

  it("operator 13/11 nous_msg:0fa7d370 (Partner Advantage, decision c65eeee0): an approved decision meets the parked plan's operator condition and resolves Nous's card", async () => {
    const parked = { reason: "Waits on the operator", since: "2026-11-13T05:00:00.000Z", resumedAt: null, conditions: [
      { id: "c1", who: "OPERATOR", what: "Submit the case", check: { kind: "MANUAL" }, state: "OPEN", checkedAt: null, metAt: null, evidence: null },
      { id: "c2", who: "PLAN", what: "Plan clipboard:dep00001 is done", check: { kind: "PLAN", planId: "clipboard:dep00001" }, state: "OPEN", checkedAt: null, metAt: null, evidence: null }] };
    const f = fixture([plan("clipboard:S6PyXKwpBrit", { waitsOn: null, parked } as never), plan("clipboard:carried01", { parked } as never)]);
    const raise = (planId: string, payload: Record<string, unknown>) => f.service.raise({ ownerUserId: owner, roomId: "room:r1", paneId: null, source: "NOUS", kind: "NEEDS_YOU",
      severity: "ATTENTION", title: "Partner Advantage", body: "Submit the case?", link: {}, dedupeKey: planNoticeKey(planId), payload: { planId, ...payload }, telegram: null });
    await raise("clipboard:S6PyXKwpBrit", { derived: false });
    await raise("clipboard:carried01", { derived: false, carried: [{ paneId: "pane:gone", dedupeKey: "nous:pane:pane:gone", id: "notification:x" }] });
    const repository = new InMemoryNousRepository();
    const store = { getClipboardItem: (_owner: string, id: string) => f.state.plans.find((entry) => entry.id === id) ?? null,
      updateClipboardItemProgress: (_owner: string, id: string, patch: object) => { f.state.plans = f.state.plans.map((entry) => entry.id === id ? { ...entry, ...patch } : entry); return null; } };
    closePlanWaitOnAnswer(repository, store as never, f.service);
    const ask = (planId: string) => repository.createDecision({ ownerUserId: owner, category: "EXTERNAL", title: "Submit the case?", body: "", options: [], recommendation: null,
      action: null, refs: { planId } } as never);
    const conditions = (id: string) => f.state.plans.find((entry) => entry.id === id)!.parked!.conditions;
    // A cancelled decision leaves the wait and the card.
    await repository.answerDecision(owner, (await ask("clipboard:S6PyXKwpBrit")).id, { status: "CANCELLED", answer: null });
    expect(conditions("clipboard:S6PyXKwpBrit")[0]!.state).toBe("OPEN");
    expect((await f.waiting()).length).toBe(2);
    const approved = await ask("clipboard:S6PyXKwpBrit");
    await repository.answerDecision(owner, approved.id, { status: "APPROVED", answer: null });
    expect(conditions("clipboard:S6PyXKwpBrit").map((entry) => [entry.id, entry.state, entry.evidence])).toEqual([["c1", "MET", `Decision ${approved.id} approved`], ["c2", "OPEN", null]]);
    // A card carried from a closed pane holds that pane's own ask: its plan's condition is met, the card stays.
    await repository.answerDecision(owner, (await ask("clipboard:carried01")).id, { status: "APPROVED", answer: null });
    expect(conditions("clipboard:carried01")[0]!.state).toBe("MET");
    expect((await f.waiting()).map((card) => card.dedupeKey)).toEqual([planNoticeKey("clipboard:carried01")]);
  });
});
