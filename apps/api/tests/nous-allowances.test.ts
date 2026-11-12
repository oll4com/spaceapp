// Nous's allowances (operator DIRECTION decision 2026-10-28, brief 20261028-allowances-design.md; operator 31/10 16:07 BKK «Βγάλε όλα τα
// όρια!! Από παντού!!»): an ON allowance covers its kind with no cap, window, history or screen; only the kind's definition decides.
import { describe, expect, it, vi } from "vitest";
import { nousDecisionKind, nousDecisionRunsWhen, type NousDecision } from "@space/contracts";
import { InMemoryNousRepository, type NewNousDecision } from "@space/db";
import { MAY_RESTART_HOLD_LINE, MAY_SEND_HOLD_LINE, PRICES_LINE, mayDeleteOwnCovers, mayDeleteTestCovers, mayPublishCovers, mayRestartHostsCovers, maySendKind, priceTokens, stableQueueIdle, type OwnArtifact, type PublishFacts, type RestartFacts, type TestResourceRecord } from "../src/nous/allowances.js";
import { createNousService } from "../src/nous/service.js";

const owner = "user:operator";
const action = { type: "PANE_TEXT" as const, roomId: "room:main0001", paneId: "pane:a0000001", text: "Send offer.md to the address in refs.", mode: "PROMPT" as const };
const ask = (refs: Partial<NousDecision["refs"]> = {}, title = "Send the pilot offer to Ann?"): NewNousDecision => ({ ownerUserId: owner, category: "EXTERNAL", title, body: "The offer is in offer.md.",
  options: [], recommendation: "Yes. Πρόβλεψη: ναι (90%)", action, refs: { files: ["active/pilots/offer.md"], sendKind: "pilot-offer", recipients: ["ann@acme.io"], ...refs } });

function fixture(maySend = true, hashes: Array<{ ref: string; sha256: string | null; size: number | null }> | null = null,
  reviewRequiredBy?: (owner: string, action: unknown) => Promise<{ id: string; text: string } | null>) {
  const repository = new InMemoryNousRepository();
  const raise = vi.fn(async () => ({}) as never);
  const resolve = vi.fn(async () => {});
  const executeAction = vi.fn(async () => "Sent to Andy in Main.");
  let settings = { enabled: false, maxTurnsPerHour: 20, maySend };
  const texts = vi.fn(async (_owner: string, files: string[]) => files.map(() => "Hello Ann, would you like to try SpaceApp with your team?"));
  const service = createNousService({ repository, runner: async () => ({ text: "", isError: false }), tools: { execute: vi.fn() } as never,
    world: async () => ({ text: "", overview: { plans: [], needsHands: [], trains: "", planMap: null } }), settings: async () => settings as never,
    saveSettings: async (_owner, value) => { settings = value as never; return value; }, notifications: { raise, resolve } as never, executeAction,
    sendTexts: texts, ...(hashes ? { fileHashes: async () => hashes } : {}), ...(reviewRequiredBy ? { reviewRequiredBy } : {}), timeZone: async () => "Asia/Bangkok" });
  return { repository, raise, resolve, executeAction, service, texts, setSettings: (value: object) => { settings = { ...settings, ...value }; } };
}

describe("May send: what it covers", () => {
  it("is a send with refs.sendKind: a pane instruction or a Mail/Freelance/Job/Marketing review approval or edit, EXTERNAL", () => {
    expect(maySendKind({ category: "EXTERNAL", action, refs: { sendKind: "pilot-offer" } })).toBe("pilot-offer");
    expect(maySendKind({ category: "EXTERNAL", action: { type: "COPILOT", copilot: "MAIL", item: "REVIEW", id: "mailrev:x", decision: "approve" } as never, refs: { sendKind: "mail-reply" } })).toBe("mail-reply");
    // R24-2 (operator 1/11 11:50 BKK; decision e6459429 stayed his card): a Marketing review approve or edit is a send too; a reject is none.
    const review = (copilot: string, decision: string) => ({ category: "EXTERNAL" as const, refs: { sendKind: "marketing-x" },
      action: { type: "COPILOT", copilot, item: "REVIEW", itemId: "mktpost:SUoAkMeF1xpR", paneId: null, decision } as never });
    expect([maySendKind(review("MARKETING", "approve")), maySendKind(review("MARKETING", "edit")), maySendKind(review("FREELANCE", "edit"))]).toEqual(["marketing-x", "marketing-x", "marketing-x"]);
    expect(maySendKind(review("SECURITY", "approve"))).toBeNull();
    // R24-3 (operator rule 5e8bc029, 1/11 11:50 BKK: Nous approves OR sends back every Marketing review): a reject, decline or revise sends nothing
    // and runs at once too, on every review rail, with a kind of its own when Nous gave none; Security and Monitoring reviews stay the operator's.
    expect([maySendKind(review("MARKETING", "reject")), maySendKind(review("MARKETING", "revise")), maySendKind(review("JOB", "decline"))]).toEqual(["marketing-x", "marketing-x", "marketing-x"]);
    expect(maySendKind({ ...review("MAIL", "reject"), refs: {} })).toBe("mail-review-back");
    expect([maySendKind({ ...review("SECURITY", "decline"), refs: {} }), maySendKind({ ...review("MONITORING", "reject"), refs: {} })]).toEqual([null, null]);
    expect(maySendKind({ category: "EXTERNAL", action: { type: "COPILOT", copilot: "MARKETING", item: "REVIEW", id: "mktpost:x", decision: "approve" } as never, refs: { sendKind: "x-reply" } })).toBe("x-reply");
    expect(maySendKind({ category: "EXTERNAL", action: { type: "COPILOT", copilot: "MARKETING", item: "REVIEW", id: "mktpost:x", decision: "reject" } as never, refs: { sendKind: "x-reply" } })).toBe("x-reply");
    expect(maySendKind({ category: "EXTERNAL", action: { type: "COPILOT", copilot: "MARKETING", item: "CAMPAIGN", id: "mktcamp:x", decision: "approve" } as never, refs: { sendKind: "x-reply" } })).toBeNull();
    expect(maySendKind({ category: "EXTERNAL", action, refs: {} })).toBeNull();
    expect(maySendKind({ category: "DIRECTION", action, refs: { sendKind: "pilot-offer" } })).toBeNull();
    expect(priceTokens(["Only €490 / month, 10 % off; η τιμή μένει", null])).toEqual(["10%off", "τιμή", "€490"]);
  });

  it("goal 7365014c step 2 (6/11): a Space Control batch of pane prompts is a send too; any other step keeps it the operator's", () => {
    const prompt = { kind: "pane", operation: "prompt", text: "Apply for the credits.", when: "NOW", target: { paneIds: ["pane:a0000001"] } };
    const control = (actions: Array<Record<string, unknown>>) => ({ category: "EXTERNAL" as const, refs: { sendKind: "credits-application" }, action: { type: "SPACE_CONTROL" as const, roomId: "room:main0001", actions } });
    expect(maySendKind(control([prompt, { ...prompt, text: "And the second one." }]))).toBe("credits-application");
    expect(maySendKind(control([prompt, { kind: "pane", operation: "close", target: { paneIds: ["pane:a0000001"] } }]))).toBeNull();
    expect(maySendKind({ ...control([prompt]), refs: {} })).toBeNull();
    expect(maySendKind({ ...control([prompt]), category: "DIRECTION" })).toBeNull();
  });
});

describe("May send in the decision flow", () => {
  it("is an ordinary card while the allowance is off, with the prices the send names; Nous's own prices and hold lines are neutralized", async () => {
    const f = fixture(false);
    f.texts.mockImplementationOnce(async (_owner: string, files: string[]) => files.map(() => "Hello Ann, SpaceApp for your team: €490 a month."));
    const decision = await f.service.ask({ ...ask(), body: `${MAY_SEND_HOLD_LINE} 00:00\n${PRICES_LINE} €1` }, { checked: [`${PRICES_LINE} €2`] });
    expect(decision.status).toBe("OPEN");
    expect(decision.body).toMatch(/^Prices in this send: €490\n\nNous: Approved by allowance maySend: goes out at 00:00\nPrices \(Nous's words\): €1/);
    expect(decision.body).not.toContain(`${PRICES_LINE} €2`);
    expect(f.raise).toHaveBeenCalledWith(expect.objectContaining({ severity: "ATTENTION" }));
    expect(await f.service.releaseAllowanceSends(owner)).toBe(0);
    expect(f.executeAction).not.toHaveBeenCalled();
  });

  it("approves a Marketing review at once with the allowance on (operator 1/11 11:53 BKK: no card for a reply post)", async () => {
    const f = fixture();
    const review = { type: "COPILOT" as const, copilot: "MARKETING" as const, item: "REVIEW" as const, itemId: "mktpost:r1", paneId: "pane:kate0001", decision: "approve" };
    const done = await f.service.ask({ ...ask({ sendKind: "x-reply", files: [] }, "Approve the X reply post?"), action: review });
    expect([done.status, done.answer]).toEqual(["APPROVED", "Approved by allowance maySend (send kind x-reply)"]);
    expect(f.executeAction).toHaveBeenCalledTimes(1);
    expect(f.raise).not.toHaveBeenCalled();
  });

  it("Nous Pro step 7, P1-3 (C7 remainder): an ask from a turn the operator's phone started is his card, not an allowance's or Always approve's", async () => {
    const f = fixture();
    const review = { type: "COPILOT" as const, copilot: "MARKETING" as const, item: "REVIEW" as const, itemId: "mktpost:p1", paneId: "pane:kate0001", decision: "approve" };
    const input = { ...ask({ sendKind: "x-reply", files: [] }, "Approve the X reply post?"), action: review };
    f.setSettings({ alwaysApprove: [{ ...nousDecisionKind(input)!, at: "2026-11-01T00:00:00.000Z" }] });
    const held = await f.service.ask(input, { phone: true });
    expect(held.status).toBe("OPEN");
    expect(f.executeAction).not.toHaveBeenCalled();
    expect(f.raise).toHaveBeenCalledTimes(1);
    // The same ask from a computer's turn runs as before.
    expect((await f.service.ask({ ...input, title: "Approve the other X reply post?" })).status).toBe("APPROVED");
  });

  it("R24-3 (1/11 05:49 UTC: stale X reply mktpost:SUoAkMeF1xpR could not be closed): a Marketing review reject runs at once with no sendKind; off, it is a card", async () => {
    const f = fixture();
    const reject = { type: "COPILOT" as const, copilot: "MARKETING" as const, item: "REVIEW" as const, itemId: "mktpost:SUoAkMeF1xpR", paneId: "pane:kate0001", decision: "reject", note: "Stale: the thread moved on." };
    const { sendKind: _kind, ...refs } = ask({ files: [] }).refs;
    const done = await f.service.ask({ ...ask({}, "Send back the stale X reply?"), refs, action: reject });
    expect([done.status, done.answer]).toEqual(["APPROVED", "Approved by allowance maySend (send kind marketing-review-back)"]);
    expect(f.executeAction).toHaveBeenCalledTimes(1);
    expect(f.raise).not.toHaveBeenCalled();
    const off = fixture(false);
    expect((await off.service.ask({ ...ask({}, "Send back the stale X reply?"), refs, action: reject })).status).toBe("OPEN");
  });

  it("Nous 13/11 (mailrev:oLB398mFW7pu went out at 18:56Z on an inferred kind): a Mail review a rule memory holds for the operator is his card, with or without sendKind", async () => {
    const memory = { id: "mailmem:SLvZ9IZgCRc4", text: "Funding mail always gets a DRAFT + space_mail_review_request:\nthe operator reads it before it goes out." };
    const held = vi.fn(async () => memory);
    const f = fixture(true, null, held);
    const review = { type: "COPILOT" as const, copilot: "MAIL" as const, item: "REVIEW" as const, itemId: "mailrev:oLB398mFW7pu", paneId: null, decision: "approve" };
    const refs = { files: [], recipients: ["ann@acme.io"] };
    const inferred = await f.service.ask({ ...ask({}, "Approve the Arize reply?"), refs, action: review });
    const given = await f.service.ask({ ...ask({ sendKind: "mail-reply", files: [] }, "Approve the edited Arize reply?"), action: { ...review, decision: "edit", text: "Hi Arize team," } });
    for (const decision of [inferred, given]) {
      expect(decision.status).toBe("OPEN");
      expect(decision.body).toMatch(/^Not covered by "May send to third parties": copilot memory mailmem:SLvZ9IZgCRc4 requires that you read this review \("Funding mail always gets a DRAFT \+ space_mail_review_request: the operator reads it/);
    }
    expect(held).toHaveBeenCalledWith(owner, review);
    expect(f.executeAction).not.toHaveBeenCalled();
    expect(f.raise).toHaveBeenCalledTimes(2);
    // Sending it back sends nothing: maySend still runs it, and no memory is read.
    held.mockClear();
    expect((await f.service.ask({ ...ask({}, "Send back the Arize reply?"), refs, action: { ...review, decision: "reject" } })).status).toBe("APPROVED");
    expect(held).not.toHaveBeenCalled();
    // Memories that cannot be read hold it too; with no such memory the allowance runs it as before.
    const unread = fixture(true, null, async () => { throw new Error("db down"); });
    expect(await unread.service.ask({ ...ask({}, "Approve the Arize reply?"), refs, action: review })).toMatchObject({ status: "OPEN",
      body: expect.stringMatching(/^Not covered by "May send to third parties": the copilot's rule memories could not be read/) });
    const free = fixture(true, null, async () => null);
    expect(await free.service.ask({ ...ask({}, "Approve the Arize reply?"), refs, action: review })).toMatchObject({ status: "APPROVED", answer: "Approved by allowance maySend (send kind mail-review)" });
  });

  it("Nous 13/11: an ask that replaces an open decision of the same title is a new card with the new text and action, never that decision", async () => {
    const f = fixture(false);
    const first = await f.service.ask(ask());
    const fixed = { ...ask(), body: "The offer is in offer-v2.md.", action: { ...action, text: "Send offer-v2.md to the address in refs." } };
    expect((await f.service.ask(fixed)).id).toBe(first.id);
    const replacing = await f.service.ask(fixed, { replaces: first.id });
    expect(replacing.id).not.toBe(first.id);
    expect(replacing).toMatchObject({ status: "OPEN", action: fixed.action, body: expect.stringContaining("offer-v2.md") });
  });

  it("sends at once with the allowance on: a first kind, a new recipient, prices, payment and contract words, past the old caps; ledger ALLOWANCE, no card", async () => {
    const f = fixture();
    f.texts.mockImplementation(async (_owner: string, files: string[]) => files.map(() => "Our pricing: €590 a month, 20% off. The invoice and the NDA follow."));
    const recipients = ["new@other.io", "a@acme.io", "b@acme.io", "c@acme.io", "d@acme.io"];
    for (let index = 0; index < 30; index += 1) {
      const done = await f.service.ask(ask({ sendKind: "first-kind", recipients }, `Send offer ${index}?`));
      expect([done.status, done.answer, done.outcome]).toEqual(["APPROVED", "Approved by allowance maySend (send kind first-kind)", "Sent to Andy in Main."]);
    }
    expect(f.executeAction).toHaveBeenCalledTimes(30);
    expect(f.raise).not.toHaveBeenCalled();
    const rows = await f.repository.listLedger(owner, "2000-01-01T00:00:00.000Z");
    expect(rows.every((row) => row.source === "ALLOWANCE" && row.kind === "send:first-kind" && row.match === null)).toBe(true);
    const done = (await f.repository.listDecisions(owner, { statuses: ["APPROVED"], limit: 1 }))[0]!;
    const { renderDailyReview } = await import("../src/nous/daily-review.js");
    expect(renderDailyReview({ facts: [], decisions: [done], since: "2000-01-01T00:00:00.000Z", day: "2026-10-28", hour: 3 }))
      .toContain("- Approved by allowances (no operator answer): 1:");
  });

  it("goal 7365014c step 2: sends a Space Control batch of pane prompts at once, and leaves it to the operator when its file changed", async () => {
    const control = { type: "SPACE_CONTROL" as const, roomId: "room:main0001", actions: [{ kind: "pane", operation: "prompt", text: "Apply for the credits.", when: "NOW", target: { paneIds: ["pane:a0000001"] } }] };
    const f = fixture();
    const done = await f.service.ask({ ...ask({ sendKind: "credits-application" }), action: control });
    expect([done.status, done.answer]).toEqual(["APPROVED", "Approved by allowance maySend (send kind credits-application)"]);
    expect(f.raise).not.toHaveBeenCalled();
    const held = fixture(true, [{ ref: "active/pilots/offer.md", sha256: "b".repeat(64), size: 10 }]);
    const open = await held.service.ask({ ...ask({ sendKind: "credits-application", fileHashes: [{ ref: "active/pilots/offer.md", sha256: "a".repeat(64), size: 10 }] } as never), action: control });
    expect([open.status, held.executeAction.mock.calls.length]).toEqual(["OPEN", 0]);
  });

  it("leaves a send whose file changed since the ask to the operator (R10-18)", async () => {
    const f = fixture(true, [{ ref: "active/pilots/offer.md", sha256: "b".repeat(64), size: 10 }]);
    const decision = await f.service.ask(ask({ fileHashes: [{ ref: "active/pilots/offer.md", sha256: "a".repeat(64), size: 10 }] } as never));
    expect([decision.status, f.executeAction.mock.calls.length]).toEqual(["OPEN", 0]);
    expect(f.raise).toHaveBeenCalledWith(expect.objectContaining({ severity: "ATTENTION", body: expect.stringContaining("changed since you were asked") }));
  });

  it("releases a send held by the old 10-minute hold at once, or makes it the operator's card when the switch is off", async () => {
    const f = fixture();
    const legacy = await f.repository.createDecision({ ...ask(), body: `${MAY_SEND_HOLD_LINE} 12:00 unless you press Decline (Stop).` });
    // Held by the allowance, it is no ask (operator 31/10 17:00 BKK): served with what it waits for, never counted.
    expect((await f.service.decisions(owner))[0]!.runsWhen).toMatch(/minute check sends it/);
    expect((await f.service.state(owner)).openDecisions).toBe(0);
    expect(await f.service.releaseAllowanceSends(owner)).toBe(1);
    expect(await f.repository.getDecision(owner, legacy.id)).toMatchObject({ status: "APPROVED", answer: "Approved by allowance maySend (send kind pilot-offer)", outcome: "Sent to Andy in Main." });
    const off = fixture(false);
    const held = await off.repository.createDecision({ ...ask(), body: `${MAY_SEND_HOLD_LINE} 12:00 unless you press Decline (Stop).` });
    expect(await off.service.releaseAllowanceSends(owner)).toBe(0);
    expect((await off.repository.getDecision(owner, held.id))!.outcome).toBe('Held for you: "May send to third parties" no longer covers it (the allowance is off).');
    expect(off.raise).toHaveBeenCalledWith(expect.objectContaining({ severity: "ATTENTION", body: expect.stringContaining("Held for you") }));
  });
});

describe("May delete what Nous created (brief B, the stricter reading: only Nous's own Agent Files)", () => {
  const room = "room:main0001";
  const del = (ids: string[], operation = "files.delete") => ({ ownerUserId: owner, category: "DESTRUCTIVE" as const, title: `Delete ${ids.length} old reports?`, body: "Superseded.",
    options: [], recommendation: "Yes.", refs: {}, action: { type: "SPACE_CONTROL" as const, roomId: room, actions: ids.map((id) => ({ kind: "resource", operation, id, input: { confirm: true } })) } });
  const own = (id: string, extra: Partial<OwnArtifact> = {}): OwnArtifact => ({ id, roomId: room, createdAt: "2026-10-27T10:00:00.000Z", deletedAt: null,
    metadata: { runtimeId: "nous", source: "AGENT_OUTPUT", originalFilename: "report.md" }, ...extra });

  it("covers Agent File or Media deletes by id of files Nous published, with no count, age, room or daily cap (operator 31/10 16:07 BKK)", () => {
    const check = (decision: ReturnType<typeof del>, artifacts: Array<OwnArtifact | null>) => {
      const result = mayDeleteOwnCovers({ decision, artifacts });
      return result.covered ? `covered ${result.ids.join(",")}` : result.reason;
    };
    expect(check(del(["artifact:a1", "artifact:a1", "artifact:a2"]), [own("artifact:a1"), own("artifact:a2")])).toBe("covered artifact:a1,artifact:a2");
    expect(check(del(["artifact:a1"], "media.delete"), [own("artifact:a1")])).toBe("covered artifact:a1");
    expect(check(del(["task:t1"], "tasks.delete"), [])).toMatch(/only deletes it covers/);
    expect(check({ ...del(["artifact:a1"]), category: "EXTERNAL" } as never, [own("artifact:a1")])).toMatch(/only deletes it covers/);
    expect(check(del(["artifact:a1"]), [null])).toMatch(/has no record/);
    expect(check(del(["artifact:a1"]), [own("artifact:a1", { deletedAt: "2026-10-28T00:00:00.000Z" })])).toMatch(/has no record/);
    expect(check(del(["artifact:a1"]), [own("artifact:a1", { metadata: { runtimeId: "cli:claude", source: "AGENT_OUTPUT" } })])).toMatch(/not made by Nous/);
    expect(check(del(["artifact:a1"]), [own("artifact:a1", { metadata: { runtimeId: "nous", source: "USER_UPLOAD" } })])).toMatch(/not made by Nous/);
    expect(check(del(["artifact:a1"]), [own("artifact:a1", { createdAt: "2026-10-16T23:59:59.000Z" })])).toBe("covered artifact:a1");
    expect(check(del(["artifact:a1"]), [own("artifact:a1", { roomId: "room:other001" })])).toBe("covered artifact:a1");
    const many = Array.from({ length: 60 }, (_, index) => `artifact:m${index}`);
    expect(check(del(many), many.map((id) => own(id)))).toBe(`covered ${many.join(",")}`);
  });

  function deleteFixture(mayDeleteOwn = true, keep: () => Promise<string> = async () => "nous/deleted/2026-10-28") {
    const repository = new InMemoryNousRepository();
    const raise = vi.fn(async () => ({}) as never);
    const executeAction = vi.fn(async () => "Ran 1 action in Main.");
    const order: string[] = [];
    const deleteOwn = { artifacts: vi.fn(async (ids: string[]) => ids.map((id) => id === "artifact:op1" ? own(id, { metadata: { runtimeId: "browser", source: "USER_UPLOAD" } }) : own(id))),
      keep: vi.fn(async () => { order.push("keep"); return keep(); }), audit: vi.fn(async () => { order.push("audit"); }) };
    executeAction.mockImplementation(async () => { order.push("delete"); return "Ran 1 action in Main."; });
    const service = createNousService({ repository, runner: async () => ({ text: "", isError: false }), tools: { execute: vi.fn() } as never,
      world: async () => ({ text: "", overview: { plans: [], needsHands: [], trains: "", planMap: null } }), settings: async () => ({ enabled: false, maxTurnsPerHour: 20, mayDeleteOwn }) as never,
      saveSettings: async (_owner, value) => value, notifications: { raise, resolve: vi.fn(async () => {}) } as never, executeAction, deleteOwn });
    return { repository, raise, executeAction, deleteOwn, order, service };
  }

  it("deletes Nous's own files at once after keeping a copy, audits them and marks the ledger ALLOWANCE; anything else stays a card with the reason", async () => {
    const f = deleteFixture();
    const done = await f.service.ask(del(["artifact:a1", "artifact:a2"]));
    expect([done.status, done.answer, done.outcome]).toEqual(["APPROVED", "Approved by allowance mayDeleteOwn", "Ran 1 action in Main."]);
    expect(done.body).toMatch(/^Approved by allowance mayDeleteOwn: files Nous made itself; a copy of each is kept in nous\/deleted\/2026-10-28\./);
    expect(f.order).toEqual(["keep", "audit", "delete"]);
    expect(f.deleteOwn.audit).toHaveBeenCalledWith(owner, done.id, ["artifact:a1", "artifact:a2"], "nous/deleted/2026-10-28");
    expect(f.raise).not.toHaveBeenCalled();
    const [row] = await f.repository.listLedger(owner, "2000-01-01T00:00:00.000Z");
    expect([row!.source, row!.kind, row!.match]).toEqual(["ALLOWANCE", "delete-own", null]);
    // The operator's file in the same batch: nothing runs, the card says why.
    const mixed = await f.service.ask({ ...del(["artifact:a3", "artifact:op1"]), title: "Delete these too?" });
    expect([mixed.status, f.executeAction.mock.calls.length]).toEqual(["OPEN", 1]);
    expect(mixed.body).toMatch(/^Not covered by "May delete what Nous created": artifact:op1 was not made by Nous\./);
    expect(f.raise).toHaveBeenCalledWith(expect.objectContaining({ severity: "ATTENTION" }));
  });

  it("stays a card while the allowance is off, or when the copy cannot be kept", async () => {
    const off = deleteFixture(false);
    expect((await off.service.ask(del(["artifact:a1"]))).status).toBe("OPEN");
    expect(off.deleteOwn.keep).not.toHaveBeenCalled();
    const noCopy = deleteFixture(true, async () => { throw new Error("disk full"); });
    const held = await noCopy.service.ask(del(["artifact:a1"]));
    expect([held.status, noCopy.executeAction.mock.calls.length]).toEqual(["OPEN", 0]);
    expect(held.body).toMatch(/a copy could not be kept first/);
  });
});

describe("R27-1: May delete what Nous created covers test VMs/CTs and snapshots an agent pane recorded creating (operator yes 2/2, decisions f913, 8494)", () => {
  // Decision 8494's text, as approved on 1/11.
  const text905 = "From Nous: operator approved removing the throwaway VM 905 (Option A copy test, plan clipboard:oZdvUieC4_Zl). On pve: confirm VM 905 is the "
    + "'ora2008-sen-copy' clone and stopped; `qm destroy 905 --purge`; then `zfs destroy` each of vmdata/data/vm-105-disk-{0,1,2}@sencopy-20261101 (one command each). "
    + "Verify: `zfs list -t snapshot | grep sencopy` empty, `qm status 105` running, `pct status 401` running, zfs vmdata usage before/after. Touch nothing else.";
  const targets = [{ host: "pve", vmid: 905 }, { host: "pve", vmid: 105, snapshot: "sencopy-20261101" }];
  const del = (text = text905, testDeletes: NousDecision["refs"]["testDeletes"] = targets): NewNousDecision => ({ ownerUserId: owner, category: "DESTRUCTIVE",
    title: "Delete test VM 905 and its source snapshots?", body: "Throwaway copy test.", options: [], recommendation: "Yes. Πρόβλεψη: ναι (90%)",
    action: { type: "PANE_TEXT", roomId: "room:main0001", paneId: "pane:zoe00001", text, mode: "PROMPT" }, refs: { testDeletes } });
  const records: TestResourceRecord[] = [{ id: "audit:vm905", host: "pve", vmid: 905, snapshot: null, paneId: "pane:zoe00001" },
    { id: "audit:snap105", host: "pve", vmid: 105, snapshot: "sencopy-20261101", paneId: "pane:zoe00001" }];
  const check = (decision: NewNousDecision, rows = records) => { const result = mayDeleteTestCovers({ decision, records: rows }); return result.covered ? `covered ${result.ids.join(", ")}` : result.reason; };

  it("covers exactly the recorded targets the text names, and nothing the text removes beyond them", () => {
    expect(check(del())).toBe("covered pve 905, pve 105@sencopy-20261101");
    // A whole VM's record covers its own snapshots.
    expect(check(del("On pve: `qm delsnapshot 905 before-test`.", [{ host: "pve", vmid: 905, snapshot: "before-test" }]))).toBe("covered pve 905@before-test");
    // Operator data: VM 105 itself has no creation record, nor does an unknown-origin VM.
    expect(check(del("On pve: `qm destroy 105 --purge`.", [{ host: "pve", vmid: 105 }]))).toMatch(/pve 105 has no creation record of an agent pane/);
    expect(check(del("On pve: `qm destroy 906`.", [{ host: "pve", vmid: 906 }]))).toMatch(/pve 906 has no creation record/);
    expect(check(del(), [records[0]!])).toMatch(/pve 105@sencopy-20261101 has no creation record/);
    // The text removes something else, or not what it names.
    expect(check(del(`${text905} Then \`qm destroy 212\`.`))).toMatch(/destroys 212/);
    expect(check(del(`${text905} Also zfs destroy vmdata/data/vm-105-disk-0@sec-20261027-0647.`))).toMatch(/@sec-20261027-0647, not in refs.testDeletes/);
    expect(check(del(`${text905} Then zfs destroy vmdata/data/vm-905-disk-0.`))).toMatch(/whole ZFS dataset vmdata\/data\/vm-905-disk-0/);
    expect(check(del(`${text905} Then rm -rf /var/lib/vz/dump/old.`))).toMatch(/also runs "rm -rf"/);
    expect(check(del("On pve: `qm destroy 905 --purge`."))).toMatch(/does not name pve 105@sencopy-20261101/);
    expect(check({ ...del(), category: "EXTERNAL" })).toMatch(/not a DESTRUCTIVE pane prompt/);
  });

  function testFixture(rows: TestResourceRecord[] = records) {
    const repository = new InMemoryNousRepository();
    const raise = vi.fn(async () => ({}) as never);
    const executeAction = vi.fn(async () => "Sent to Zoe in Main.");
    const deleteOwn = { artifacts: vi.fn(async () => []), keep: vi.fn(async () => "never"), audit: vi.fn(async () => {}), testResources: vi.fn(async () => rows) };
    const service = createNousService({ repository, runner: async () => ({ text: "", isError: false }), tools: { execute: vi.fn() } as never,
      world: async () => ({ text: "", overview: { plans: [], needsHands: [], trains: "", planMap: null } }), settings: async () => ({ enabled: false, maxTurnsPerHour: 20, mayDeleteOwn: true }) as never,
      saveSettings: async (_owner, value) => value, notifications: { raise, resolve: vi.fn(async () => {}) } as never, executeAction, deleteOwn });
    return { repository, raise, executeAction, deleteOwn, service };
  }

  it("runs a provenance-matched delete by the allowance with no card (ledger ALLOWANCE, one audit row); an unknown-origin VM still asks", async () => {
    const f = testFixture();
    const done = await f.service.ask(del());
    expect([done.status, done.answer, done.outcome]).toEqual(["APPROVED", "Approved by allowance mayDeleteOwn", "Sent to Zoe in Main."]);
    expect(done.body).toMatch(/^Approved by allowance mayDeleteOwn: test VMs, CTs or snapshots agent panes recorded creating \(records audit:vm905, audit:snap105\)\./);
    expect(f.deleteOwn.audit).toHaveBeenCalledWith(owner, done.id, ["pve 905", "pve 105@sencopy-20261101"], "records audit:vm905, audit:snap105");
    expect(f.deleteOwn.keep).not.toHaveBeenCalled();
    expect(f.raise).not.toHaveBeenCalled();
    const [row] = await f.repository.listLedger(owner, "2000-01-01T00:00:00.000Z");
    expect([row!.source, row!.kind]).toEqual(["ALLOWANCE", "delete-own"]);
    const unknown = await testFixture([]).service.ask(del());
    expect(unknown.status).toBe("OPEN");
    expect(unknown.body).toMatch(/^Not covered by "May delete what Nous created": pve 905 has no creation record of an agent pane/);
  });
});

describe("May publish after a green lab proof (brief C)", () => {
  const sha = "b5e2d1c0aa";
  const lab = { acceptanceSha256: "a".repeat(64), allCasesPass: true, freshInstall: true, ciGreen: true, versionVerified: true, warm: "NONE" as const, previousVersion: "1.1.9",
    sourceSha: sha, recordedAt: "2026-10-28T05:00:00.000Z", by: "Jack" };
  const train = (extra: Record<string, unknown> = {}) => ({ product: "run-spaceapp", status: "OPEN" as const, sourceSha: sha, approvedSha: null, lab, ...extra });
  const facts = (extra: Partial<PublishFacts> = {}): PublishFacts => ({ train: train(), ...extra });
  const release = { ownerUserId: owner, category: "RELEASE" as const, title: "Publish run-spaceapp 1.1.10?", body: "", options: [], recommendation: "Yes.", refs: {},
    action: { type: "RELEASE_APPROVE" as const, product: "run-spaceapp" } };

  it("covers a RELEASE_APPROVE whose candidate has the captain's green lab proof, nothing else (operator 31/10 16:07 BKK)", () => {
    const reason = (input: Partial<Parameters<typeof mayPublishCovers>[0]>) => {
      const check = mayPublishCovers({ decision: release, facts: facts(), ...input });
      return check.covered ? `covered ${check.sourceSha}` : check.reason;
    };
    expect(reason({})).toBe(`covered ${sha}`);
    expect(reason({ decision: { category: "RELEASE", action: { type: "PANE_TEXT", roomId: "room:a", paneId: "pane:a", text: "space-queue promote", mode: "PROMPT" } } })).toMatch(/only release it covers/);
    expect(reason({ facts: facts({ train: null }) })).toMatch(/no open train/);
    expect(reason({ facts: facts({ train: train({ status: "PUBLISHING" }) }) })).toMatch(/no open train/);
    expect(reason({ facts: facts({ train: train({ approvedSha: sha }) }) })).toMatch(/already approved/);
    expect(reason({ facts: facts({ train: train({ lab: null }) }) })).toMatch(/no lab proof recorded for candidate b5e2d1c0aa/);
    expect(reason({ facts: facts({ train: train({ lab: { ...lab, sourceSha: "0000000aaa" } }) }) })).toMatch(/no lab proof recorded/);
    expect(reason({ facts: facts({ train: train({ lab: { ...lab, allCasesPass: false, freshInstall: false } }) }) })).toMatch(/not green: not every case PASS, no fresh install/);
    expect(reason({ facts: facts({ train: train({ lab: { ...lab, ciGreen: false } }) }) })).toMatch(/CI not green/);
    expect(reason({ facts: facts({ train: train({ lab: { ...lab, versionVerified: false } }) }) })).toMatch(/space-version verify not passed/);
    expect(reason({ facts: facts({ train: train({ lab: { ...lab, warm: "UNAPPROVED" } }) }) })).toMatch(/unapproved Warm change/);
  });

  function publishFixture(mayPublish = true, current: PublishFacts = facts()) {
    const repository = new InMemoryNousRepository();
    const raise = vi.fn(async () => ({}) as never);
    const executeAction = vi.fn(async () => "unused");
    const mayPublishDeps = { facts: vi.fn(async () => current), approve: vi.fn(async () => {}) };
    const service = createNousService({ repository, runner: async () => ({ text: "", isError: false }), tools: { execute: vi.fn() } as never,
      world: async () => ({ text: "", overview: { plans: [], needsHands: [], trains: "", planMap: null } }), settings: async () => ({ enabled: false, maxTurnsPerHour: 20, mayPublish }) as never,
      saveSettings: async (_owner, value) => value, notifications: { raise, resolve: vi.fn(async () => {}) } as never, executeAction, mayPublish: mayPublishDeps });
    return { repository, raise, executeAction, mayPublishDeps, service };
  }

  it("approves the checked candidate at once (bound to its commit, ledger ALLOWANCE); a red proof or the switch off leaves the operator's card", async () => {
    const f = publishFixture();
    const done = await f.service.ask(release);
    expect([done.status, done.answer, done.outcome]).toEqual(["APPROVED", `Approved by allowance mayPublish (run-spaceapp at ${sha}, lab proof green)`,
      `Approved the run-spaceapp release train at ${sha} (lab proof green).`]);
    expect(f.mayPublishDeps.approve).toHaveBeenCalledWith("run-spaceapp", sha);
    expect(f.executeAction).not.toHaveBeenCalled();
    expect(f.raise).not.toHaveBeenCalled();
    const [row] = await f.repository.listLedger(owner, "2000-01-01T00:00:00.000Z");
    expect([row!.source, row!.kind, row!.match]).toEqual(["ALLOWANCE", "publish:run-spaceapp", null]);
    // A second release the same day runs too (the 24-hour rule is gone).
    expect((await f.service.ask({ ...release, title: "Publish again?" })).status).toBe("APPROVED");
    expect(f.raise).not.toHaveBeenCalled();
    const red = publishFixture(true, facts({ train: train({ lab: { ...lab, freshInstall: false } }) }));
    const card = await red.service.ask(release);
    expect([card.status, red.mayPublishDeps.approve.mock.calls.length]).toEqual(["OPEN", 0]);
    expect(red.raise).toHaveBeenCalledWith(expect.objectContaining({ severity: "ATTENTION" }));
    const off = publishFixture(false);
    expect((await off.service.ask(release)).status).toBe("OPEN");
    // R13-15b reads the train for every release approval (a newer candidate of an approved version runs on that yes); this one has none.
    expect(off.mayPublishDeps.approve).not.toHaveBeenCalled();
  });
});

describe("May run guarded host restarts (R16-1; operator 31/10 16:07 BKK: no window, commit or HEAD rule, preconditions only wait)", () => {
  const restart = (text: string) => ({ ownerUserId: owner, category: "RELEASE" as const, title: "Guarded Browser Host restart?", body: "", options: [], recommendation: "Yes. Πρόβλεψη: ναι (95%)", refs: {},
    action: { type: "PANE_TEXT" as const, roomId: "room:main0001", paneId: "pane:bob00001", text, mode: "PROMPT" as const } });
  const browser = restart("Run the guarded Browser Host restart at 466b7af4ac, then live:verify.");
  const facts = (extra: Partial<RestartFacts> = {}): RestartFacts => ({ stableQueueIdle: true, browsersHeld: 0, panesMidTurn: 0, ...extra });

  it("covers a guarded restart of one host; unmet preconditions only make it wait", () => {
    const reason = (input: Partial<Parameters<typeof mayRestartHostsCovers>[0]>) => {
      const check = mayRestartHostsCovers({ decision: browser, facts: facts(), ...input });
      return check.covered ? `covered ${check.host} ${check.commit}` : `${check.waits ? "waits" : "no"}: ${check.reason}`;
    };
    expect(reason({})).toBe("covered BROWSER_HOST 466b7af4ac");
    expect(reason({ decision: restart("Run the guarded pane host restart at 466b7af4ac.") })).toBe("covered PANE_HOST 466b7af4ac");
    // No commit named, or any commit: covered (no stable-HEAD or per-commit rule).
    expect(reason({ decision: restart("Run the guarded Browser Host restart now.") })).toBe("covered BROWSER_HOST null");
    expect(reason({ decision: restart("Run the guarded Browser Host restart at 0123456789.") })).toBe("covered BROWSER_HOST 0123456789");
    expect(reason({ decision: restart("Restart the Browser Host now.") })).toMatch(/^no: not a guarded restart/);
    expect(reason({ decision: restart("Guarded restart of the Browser Host and the pane host at 466b7af4ac.") })).toMatch(/^no: not a guarded restart/);
    // R37-3 (215335c7 went to the operator): the other host named outside the restart phrase does not void it; two restart phrases still do.
    expect(reason({ decision: restart("Guarded Browser Host restart on stable for OBS-001 (15cd). Then run d-host-restart.sh browser at stable HEAD. "
      + "Then run the OBS-001 live proof for the Browser Host part; the pane host part waits for decision da790917's restart.") })).toMatch(/^covered BROWSER_HOST/);
    expect(reason({ decision: restart("Guarded Browser Host restart now, then restart the pane host.") })).toMatch(/^no: not a guarded restart/);
    expect(reason({ decision: restart("Guarded restart: Browser Host, then pane host.") })).toMatch(/^no: not a guarded restart/);
    expect(reason({ decision: { ...browser, category: "DESTRUCTIVE" } })).toMatch(/^no: not a guarded restart/);
    expect(reason({ facts: facts({ stableQueueIdle: false }) })).toMatch(/^waits: the stable merge queue has a ticket in flight/);
    expect(reason({ facts: facts({ stableQueueIdle: null }) })).toMatch(/^waits: the stable merge queue could not be read/);
    expect(reason({ facts: facts({ browsersHeld: 2 }) })).toMatch(/^waits: 2 pane browsers hold a handoff/);
    expect(reason({ facts: facts({ browsersHeld: null }) })).toMatch(/^waits: .*census could not be read/);
    expect(reason({ decision: restart("Run the guarded pane host restart at 466b7af4ac."), facts: facts({ panesMidTurn: 1 }) })).toMatch(/^waits: 1 CLI pane is in a turn/);
  });

  it("waits only for the stable queue: the dev queue never touches stable's hosts (operator 31/10 17:00 BKK)", () => {
    const queue = (busy: boolean) => ({ available: true, active: busy ? [{ id: "q-1" }] : [], current: null });
    expect(stableQueueIdle([{ name: "stable", report: queue(false) }, { name: "dev", report: queue(true) }])).toBe(true);
    expect(stableQueueIdle([{ name: "stable", report: { ...queue(false), current: { id: "q-2" } } }, { name: "dev", report: queue(false) }])).toBe(false);
    expect(stableQueueIdle([{ name: "stable", report: queue(true) }])).toBe(false);
    expect(stableQueueIdle([{ name: "stable", report: { ...queue(false), available: false } }])).toBeNull();
    expect(stableQueueIdle([{ name: "dev", report: queue(false) }])).toBeNull();
    expect(stableQueueIdle(null)).toBeNull();
  });

  const run = (mayRestartHosts: boolean, current: RestartFacts) => {
    const repository = new InMemoryNousRepository();
    const raise = vi.fn(async () => ({}) as never);
    const executeAction = vi.fn(async () => "Sent to Bob in Main.");
    const deps = { facts: vi.fn(async () => current), audit: vi.fn(async () => {}) };
    let settings = { enabled: false, maxTurnsPerHour: 20, mayRestartHosts };
    const service = createNousService({ repository, runner: async () => ({ text: "", isError: false }), tools: { execute: vi.fn() } as never,
      world: async () => ({ text: "", overview: { plans: [], needsHands: [], trains: "", planMap: null } }), settings: async () => settings as never,
      saveSettings: async (_owner, value) => value, notifications: { raise, resolve: vi.fn(async () => {}) } as never, executeAction, mayRestartHosts: deps });
    return { repository, raise, executeAction, deps, service, switchOff: () => { settings = { ...settings, mayRestartHosts: false }; } };
  };

  it("runs a covered restart at once (ledger ALLOWANCE, one audit row), again an hour later at the same commit, with no card", async () => {
    const f = run(true, facts());
    const done = await f.service.ask(browser);
    expect([done.status, done.answer, done.outcome]).toEqual(["APPROVED", "Approved by allowance mayRestartHosts (Browser Host at 466b7af4ac)", "Sent to Bob in Main."]);
    expect(f.deps.audit).toHaveBeenCalledWith(owner, done.id, "BROWSER_HOST", "466b7af4ac");
    const [row] = await f.repository.listLedger(owner, "2000-01-01T00:00:00.000Z");
    expect([row!.source, row!.kind]).toEqual(["ALLOWANCE", "restart:BROWSER_HOST"]);
    // The old limiting situation (decision 8f7cda8a): a restart of the same host shortly before, at the same commit; it runs now.
    expect((await f.service.ask({ ...browser, title: "Guarded Browser Host restart again?" })).status).toBe("APPROVED");
    expect(f.raise).not.toHaveBeenCalled();
  });

  it("holds a restart whose preconditions wait with no card and runs it the minute they clear; the switch off makes it the operator's card", async () => {
    const held = run(true, facts({ browsersHeld: 1 }));
    const waiting = await held.service.ask(browser);
    expect([waiting.status, held.executeAction.mock.calls.length]).toEqual(["OPEN", 0]);
    expect(waiting.body).toMatch(new RegExp(`^${MAY_RESTART_HOLD_LINE.replace(/"/g, ".")} runs by itself once this clears: 1 pane browser holds a handoff`));
    expect(held.raise).not.toHaveBeenCalled();
    expect(await held.service.recheckRestarts(owner)).toBe(0);
    // Operator 31/10 17:00 BKK «You are asking me for approve AGAIN!!!»: a held restart is no ask: not counted, served with what it waits for now.
    expect([nousDecisionRunsWhen(waiting), waiting.runsWhen]).toEqual(Array(2).fill("1 pane browser holds a handoff, a lease or a Vault fence"));
    expect((await held.service.state(owner)).openDecisions).toBe(0);
    held.deps.facts.mockImplementation(async () => facts({ stableQueueIdle: false }));
    expect(await held.service.recheckRestarts(owner)).toBe(0);
    expect((await held.service.decisions(owner)).find((decision) => decision.id === waiting.id)?.runsWhen).toBe("the stable merge queue has a ticket in flight");
    held.deps.facts.mockImplementation(async () => facts());
    expect(await held.service.recheckRestarts(owner)).toBe(1);
    expect((await held.repository.listDecisions(owner, { statuses: ["APPROVED"] }))[0]).toMatchObject({ id: waiting.id, answer: "Approved by allowance mayRestartHosts (Browser Host at 466b7af4ac)", outcome: "Sent to Bob in Main." });
    expect(held.raise).not.toHaveBeenCalled();
    const later = run(true, facts({ stableQueueIdle: false }));
    const parked = await later.service.ask(browser);
    later.switchOff();
    expect(await later.service.recheckRestarts(owner)).toBe(0);
    expect((await later.repository.getDecision(owner, parked.id))!.outcome).toBe('Held for you: "May run guarded host restarts" is off.');
    // Given back to the operator, it asks again: counted, no runsWhen.
    expect((await later.service.state(owner)).openDecisions).toBe(1);
    expect((await later.service.decisions(owner))[0]!.runsWhen).toBeUndefined();
    expect(later.raise).toHaveBeenCalledWith(expect.objectContaining({ severity: "ATTENTION", body: expect.stringContaining("Held for you") }));
    const off = run(false, facts());
    expect((await off.service.ask(browser)).status).toBe("OPEN");
    expect(off.deps.facts).not.toHaveBeenCalled();
    expect(off.raise).toHaveBeenCalledTimes(1);
  });
});
