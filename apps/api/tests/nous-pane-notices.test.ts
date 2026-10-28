import { describe, expect, it } from "vitest";
import { eventSchema, type Pane, type Room } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { makeSpaceId, SpaceEventBus } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";
import { createNousPaneNotices } from "../src/nous/pane-notices.js";
import { sweepCopilotQuestions } from "../src/nous/copilot-questions.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

// One card per pane for what only the operator's hands can do (plan clipboard:8FfXWclYUfOH).
const owner = "user:operator";
const room = { id: "room:freelance01", name: "Freelance", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const pane = (id: string, paneName: string) => ({ id, roomId: room.id, paneName, title: paneName, mode: "TERMINAL", isClosed: false }) as unknown as Pane;
const andy = pane("pane:andy0001", "Andy");
const bob = pane("pane:bob00001", "Bob");

function fixture(held = false) {
  const repository = new InMemorySpaceNotificationsRepository(undefined, true);
  const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
    recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
    nous: { held: async () => held, raised: () => {} } });
  return { repository, service, notices: createNousPaneNotices({ notifications: service }) };
}

describe("Nous's cards to the operator", () => {
  it("keeps one card per pane: a new list replaces the items, unread again and alerted once; the same list changes nothing", async () => {
    const f = fixture();
    const first = await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you", items: [{ text: "Pass the Cloudflare check" }] });
    expect(first).toMatchObject({ ok: true, display: "Sent the operator's card for Andy in Freelance (1 item)" });
    const [card] = await f.service.list(owner, { status: "ALL", limit: 50 });
    expect(card).toMatchObject({ source: "NOUS", kind: "NEEDS_HANDS", severity: "ATTENTION", paneId: andy.id, roomId: room.id, dedupeKey: "nous:pane:pane:andy0001",
      link: { roomId: room.id, paneId: andy.id }, body: "• Pass the Cloudflare check", status: "OPEN" });
    await f.service.setStatus(owner, card!.id, "READ");

    const same = await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you", items: [{ text: "Pass the Cloudflare check" }] });
    expect(same.display).toBe("The card for Andy in Freelance already lists this");
    expect(f.repository.telegram).toHaveLength(1);

    await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you",
      items: [{ text: "Pass the Cloudflare check" }, { text: "Enter the 2FA code", ref: "notification:abc123" }] });
    const cards = await f.service.list(owner, { status: "ALL", limit: 50 });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: card!.id, status: "OPEN", body: "• Pass the Cloudflare check\n• Enter the 2FA code" });
    expect(f.repository.telegram).toHaveLength(2);

    await f.notices.notify(owner, room, bob, { room: "Freelance", pane: "Bob", title: "Sign in to LinkedIn", items: [{ text: "Sign in" }] });
    await f.notices.notify(owner, room, null, { room: "Freelance", title: "Send the invoice PDF", items: [{ text: "Download it from the bank" }] });
    expect((await f.service.list(owner, { status: "OPEN", limit: 50 })).map((item) => item.dedupeKey).sort())
      .toEqual(["nous:general", "nous:pane:pane:andy0001", "nous:pane:pane:bob00001"]);
    expect(await f.notices.summary(owner, { room: () => "Freelance", pane: (id) => id === andy.id ? "Andy" : id === bob.id ? "Bob" : null }))
      .toContain(`- [${card!.id}] Upwork needs you · Andy in Freelance · 2 items`);
  });

  it("asks its first item's question with the options and Nous's recommendation; a changed question alerts again (plan clipboard:5AQvaoSR-IZa)", async () => {
    const f = fixture();
    const items = [{ text: "Pick the Upwork profile" }, { text: "Which profile should Andy use?", question: "Which profile should Andy use?", options: ["Agency", "Freelancer"], recommended: "Freelancer" }];
    await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you", items });
    const [card] = await f.service.list(owner, { status: "ALL", limit: 50 });
    expect(card!.payload.ask).toEqual({ question: "Which profile should Andy use?", options: ["Agency", "Freelancer"], recommended: "Freelancer", answer: { kind: "NOUS" } });
    const changed = await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you",
      items: [items[0]!, { ...items[1]!, recommended: "Agency" }] });
    expect(changed.display).toContain("Updated");
    expect((await f.service.list(owner, { status: "ALL", limit: 50 }))[0]!.payload.ask).toMatchObject({ recommended: "Agency" });
    await f.notices.notify(owner, room, bob, { room: "Freelance", pane: "Bob", title: "Sign in", items: [{ text: "Sign in", question: "Signed in?", options: ["Yes"], recommended: "No" }] });
    expect((await f.service.list(owner, { status: "ALL", limit: 50 })).find((item) => item.paneId === bob.id)!.payload.ask).toEqual({ question: "Signed in?", options: ["Yes"], answer: { kind: "NOUS" } });
  });

  it("reaches the operator at once even while Nous holds other notifications, and resolves the cards of closed panes", async () => {
    const f = fixture(true);
    await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you", items: [{ text: "Pass the check" }] });
    await f.notices.notify(owner, room, null, { room: "Freelance", title: "A document", items: [{ text: "Get it" }] });
    expect(f.repository.telegram).toHaveLength(2);
    expect(await f.notices.reconcile(owner, new Set([bob.id]))).toBe(1);
    expect((await f.service.list(owner, { status: "OPEN", limit: 50 })).map((item) => item.dedupeKey)).toEqual(["nous:general"]);
  });

  it("is a Nous tool that reaches only the owner's rooms and panes", async () => {
    const f = fixture();
    const tools = createNousTools({ paneNotices: f.notices, rooms: async (who: string) => who === owner ? [room] : [], listPanes: async () => [andy, bob] } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "nous_turn:n1", callId: "toolu_n", traceId: "trace:n" };
    const checked = ["Vault: no Upwork login", "pane reports: Andy waits on a CAPTCHA since 10:02"];
    // Ask last (goal ee5a573e): a card without what Nous checked first is refused with the rule.
    const unchecked = await tools.execute("space_notify_operator", { room: "freelance", pane: "andy", title: "Upwork needs you", items: [{ text: "Pass the check" }] }, ctx);
    expect(unchecked).toMatchObject({ ok: false, result: expect.stringContaining("checked: Ask last (operator goal ee5a573e") });
    expect(await tools.execute("space_notify_operator", { room: "freelance", pane: "andy", title: "Upwork needs you", items: [{ text: "Pass the check" }], checked }, ctx))
      .toMatchObject({ ok: true, result: expect.stringMatching(/^Notification notification:/) });
    const card = (await f.service.list(owner, { status: "OPEN", limit: 10 }))[0]!;
    expect(card.body).toBe("• Pass the check\n\nChecked first:\n• Vault: no Upwork login\n• pane reports: Andy waits on a CAPTCHA since 10:02");
    expect(card.payload.checked).toEqual(checked);
    // Other wording of what was checked is no new list: no second alert.
    expect((await tools.execute("space_notify_operator", { room: "Freelance", pane: "Andy", title: "Upwork needs you", items: [{ text: "Pass the check" }], checked: ["Vault: nothing"] }, ctx)).result).toContain("Unchanged");
    expect((await tools.execute("space_notify_operator", { room: "Freelance", pane: "Zed", title: "x", items: [{ text: "y" }] }, ctx)).ok).toBe(false);
    expect((await tools.execute("space_notify_operator", { room: "Freelance", title: "x".repeat(81), items: [{ text: "y" }] }, ctx)).ok).toBe(false);
    expect((await tools.execute("space_notify_operator", { room: "Freelance", title: "x", items: [] }, ctx)).ok).toBe(false);
    expect((await tools.execute("space_notify_operator", { room: "Freelance", pane: "Andy", title: "x", items: [{ text: "y" }] }, { ...ctx, owner: "user:other" })).ok).toBe(false);
  });
});

describe("Copilot questions go to Nous first (Ask Last step 7, 2026-10-27)", () => {
  function questions(start = Date.parse("2026-10-27T15:00:00.000Z")) {
    let at = start;
    let holds = true;
    const raised: string[] = [];
    const repository = new InMemorySpaceNotificationsRepository(() => new Date(at).toISOString(), true);
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never, now: () => new Date(at).toISOString(),
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date(at).toISOString() }),
      nous: { held: async () => false, raised: (item) => raised.push(item.id), holdsCopilotQuestions: async () => holds } });
    const ask = (key: string, extra: Partial<Parameters<typeof service.raise>[0]> = {}) => service.raise({ ownerUserId: owner, roomId: room.id, paneId: andy.id,
      source: "JOB_COPILOT", kind: "QUESTION", severity: "ATTENTION", title: "Job Copilot needs you", body: "Your Bangkok postal code?", link: {}, dedupeKey: key, payload: {}, telegram: null, ...extra });
    const needsYou = async () => (await service.list(owner, { status: "NEEDS_YOU", limit: 50 })).map((item) => item.id);
    return { repository, service, notices: createNousPaneNotices({ notifications: service }), ask, needsYou, raised,
      tick: (ms: number) => { at += ms; }, now: () => at, setHolds: (value: boolean) => { holds = value; } };
  }

  it("holds a new copilot question out of Needs you, Telegram and push for Nous, and releases it with the card that names it", async () => {
    const f = questions();
    const question = await f.ask("job-apply:question:jobq:s0O3NpRylU1i");
    expect(question.payload.heldForNous).toEqual({ until: "2026-10-27T16:00:00.000Z" });
    expect(f.raised).toEqual([question.id]);
    expect(f.repository.telegram).toEqual([]);
    expect(await f.needsYou()).toEqual([]);
    // A Nous card (or space_focus_pane) whose item names the question sends it to the operator, re-alerted once.
    await f.notices.notify(owner, room, andy, { room: room.name, pane: "Andy", title: "Job Copilot asks", items: [{ text: "Your Bangkok postal code?", ref: question.id }],
      checked: ["Space Memory and copilot memories: no postal code"] });
    const released = (await f.service.get(owner, question.id))!;
    expect(released.payload.heldForNous).toBeUndefined();
    expect(released.payload.alertAt).toBe("2026-10-27T15:00:00.000Z");
    expect(await f.needsYou()).toContain(question.id);
    // Off: today's behaviour, nothing held.
    f.setHolds(false);
    expect((await f.ask("job-apply:question:jobq:second0001")).payload.heldForNous).toBeUndefined();
  });

  it("each minute resolves questions that no longer wait, keeps a live one, and releases held ones after their hour or when Nous stops holding", async () => {
    const f = questions();
    const live = await f.ask("job-apply:question:jobq:s0O3NpRylU1i", { paneId: null });
    const answered = await f.ask("job-apply:question:jobq:answered01", { paneId: null });
    const byEvent = await f.ask("job-apply:QUESTION:jobevt:old0000001", { paneId: null });
    const marketing = await f.ask("marketing-copilot:question:mktq:open000001", { source: "MARKETING_COPILOT" });
    const design = await f.ask("design:question:dreq:gone000001", { source: "DESIGN", kind: "DESIGN_QUESTION", paneId: "pane:closed001" });
    await f.service.setStatus(owner, answered.id, "READ");
    const sweep = () => sweepCopilotQuestions({ notifications: f.service, sources: ["JOB_COPILOT", "MARKETING_COPILOT", "DESIGN"], holds: async () => holds, now: f.now,
      openItemIds: async () => new Set(["jobq:s0O3NpRylU1i", "mktq:open000001", "dreq:gone000001"]), paneOpen: async (paneId) => paneId !== "pane:closed001" });
    let holds = true;
    expect(await sweep()).toEqual({ resolved: 3, released: 0 });
    for (const [item, status] of [[live, "OPEN"], [answered, "RESOLVED"], [byEvent, "RESOLVED"], [marketing, "OPEN"], [design, "RESOLVED"]] as const) {
      expect((await f.service.get(owner, item.id))?.status).toBe(status);
    }
    // Its hour ends: the question goes to the operator.
    f.tick(61 * 60_000);
    expect(await sweep()).toEqual({ resolved: 0, released: 2 });
    expect((await f.service.get(owner, marketing.id))!.payload.heldForNous).toBeUndefined();
    // Nous switched off or paused: a question held a minute ago goes at once.
    const fresh = await f.ask("job-apply:question:jobq:fresh00001", { paneId: null });
    holds = false;
    const sweepWith = (open: string[]) => sweepCopilotQuestions({ notifications: f.service, sources: ["JOB_COPILOT"], holds: async () => holds, now: f.now,
      openItemIds: async () => new Set(open), paneOpen: async () => true });
    expect(await sweepWith(["jobq:s0O3NpRylU1i", "jobq:fresh00001"])).toEqual({ resolved: 0, released: 1 });
    expect((await f.service.get(owner, fresh.id))!.payload.heldForNous).toBeUndefined();
    // The copilot's own answer resolves it as today; an owner whose items cannot be read is left alone.
    expect(await f.service.resolve(owner, "job-apply:question:jobq:fresh00001")).toBe(1);
    expect(await sweepCopilotQuestions({ notifications: f.service, sources: ["JOB_COPILOT"], holds: async () => true, paneOpen: async () => true,
      openItemIds: async () => { throw new Error("Job Copilot unavailable"); } })).toEqual({ resolved: 0, released: 0 });
  });
});
