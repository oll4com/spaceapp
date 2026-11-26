import { describe, expect, it, vi } from "vitest";
import { InMemoryNousFollowupsRepository } from "@space/db";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNousFollowups, datedHolds, noteCore, ticketMergedOnMain } from "../src/nous/followups.js";

// Nous's follow-ups (plan clipboard:8s0ZNiO3q5ZT S3).
const owner = "user:operator";
function fixture() {
  let clock = Date.parse("2026-10-17T13:00:00.000Z");
  const repository = new InMemoryNousFollowupsRepository();
  const notice = vi.fn(async () => {});
  const tickets = new Map<string, string>();
  const followups = createNousFollowups({ repository, notice, ticketStatus: async (id) => (tickets.get(id) ?? null) as never, now: () => clock });
  return { repository, notice, tickets, followups, advance: (ms: number) => { clock += ms; } };
}

describe("Nous's follow-ups", () => {
  // 21/11 REVIEW: the same wait set again with no `replaces` (an id-less one) is the open follow-up, not a second one.
  it("refuses an id-less wait that only moves dates of an open one, and accepts a reworded wait", async () => {
    const f = fixture();
    const first = await f.followups.run(owner, { op: "add", note: "Utilization item waits for the operator's reply, until 2026-11-22 09:00.", at: "2026-10-18T02:00:00.000Z" }, null);
    const id = /\[(nous_followup:[^\]]+)\]/.exec(first.result)![1]!;
    const dup = await f.followups.run(owner, { op: "add", note: "Re-checked 14:00 UTC: still waiting. Utilization item waits for the operator's reply, until 23/11 10:00.", at: "2026-10-19T02:00:00.000Z" }, null);
    expect(dup).toMatchObject({ ok: false, refused: true, result: expect.stringMatching(new RegExp(`^no change, keep ${id}: `)) });
    expect((await f.repository.list(owner, 0)).filter((item) => item.status === "OPEN")).toHaveLength(1);
    const other = await f.followups.run(owner, { op: "add", note: "Utilization item: the operator replied, apply the answer.", at: "2026-10-19T02:00:00.000Z" }, null);
    expect(other.ok).toBe(true);
  });
  // 17/11 REVIEW (16/11: nous_msg:b3744e80's follow-up rewritten ×22, the Utilization one ~15 times, all waiting on the operator's low mode until 09:07 BKK).
  it("keeps the open follow-up when a replacement only moves its dates or adds Re-checked words, and names what dated waits hold", async () => {
    const f = fixture();
    const note = "Resume nous_msg:b3744e80aa once the operator's low mode ends 2026-11-17 09:07 BKK.";
    const first = await f.followups.run(owner, { op: "add", note, at: "2026-10-18T02:07:00.000Z" }, null);
    const id = /\[(nous_followup:[^\]]+)\]/.exec(first.result)![1]!;
    const again = await f.followups.run(owner, { op: "add", note: `Re-checked 14:26 UTC: still low. Resume nous_msg:b3744e80aa once the operator's low mode ends 18/10 09:07 BKK.`,
      at: "2026-10-18T03:00:00.000Z", replaces: id } as never, null);
    expect(again).toMatchObject({ ok: false, refused: true, result: expect.stringMatching(new RegExp(`^no change, keep ${id}: `)) });
    expect((await f.repository.get(owner, id))!.status).toBe("OPEN");
    // A note that says something new replaces it.
    const changed = await f.followups.run(owner, { op: "add", note: "Resume nous_msg:b3744e80aa: the operator lifted low mode, send its next step to Cody.", inMinutes: 5, replaces: id } as never, null);
    expect(changed.ok).toBe(true);
    expect((await f.repository.get(owner, id))!.status).toBe("CANCELLED");
    expect(noteCore("Check clipboard:abcdefgh on Monday 17 Nov at 09:00")).toBe(noteCore("Check clipboard:abcdefgh on Tuesday 18 Nov at 10:30"));

    const at = Date.parse("2026-10-17T13:00:00.000Z");
    const row = (note: string, dueAt: string, status = "OPEN") => ({ id: `nous_followup:${note.length}x${dueAt.slice(11, 13)}`, ownerUserId: owner, note, status, trigger: { kind: "TIME", dueAt },
      createdAt: "2026-10-17T12:00:00.000Z", closedAt: null, outcome: null }) as never;
    expect([...datedHolds([
      row("Utilization low; plan clipboard:pZwo1234567 waits too (wait reason: the operator's low mode until 09:07)", "2026-10-18T02:07:00.000Z"),
      row("Request nous_msg:f46457b8xyz (wait reason: its deadline is 2026-10-20)", "2026-10-20T00:00:00.000Z"),
      // Past due, closed, or held by no operator order or date: the push lines still carry them.
      // 22/11: a date, "operator" or "approve" in the note's text, or a bare date as the reason, is no wait (the overnight 21-22/11 silences).
      row("Request nous_msg:plaindt1 waits on 2026-10-20", "2026-10-20T00:00:00.000Z"),
      row("Utilization 13%: re-check 2026-10-18 03:00, nous_msg:opword01 waits on the operator pairing card", "2026-10-18T03:00:00.000Z"),
      row("Check Gmail for approve/reject mail on nous_msg:tparty01 (wait reason: Night: no runnable work; moderation is a third party wait.)", "2026-10-18T01:40:00.000Z"),
      row("Request nous_msg:bareday1 (wait reason: 2026-10-18 09:00)", "2026-10-18T09:00:00.000Z"),
      row("Request nous_msg:pastdue1 waits on the operator", "2026-10-17T12:00:00.000Z"),
      row("Request nous_msg:closed01 waits on the operator", "2026-10-18T00:00:00.000Z", "FIRED"),
      row("Request nous_msg:vague001 after Cody resumes", "2026-10-18T00:00:00.000Z")], at)].sort())
      .toEqual(["clipboard:pZwo1234", "nous_msg:f46457b8", "utilization"]);
  });

  it("takes exactly one trigger, a future time (any distance since 31/10), and a note", async () => {
    const f = fixture();
    const add = (args: object, pane: { paneId: string; paneLabel: string } | null = null) => f.followups.run(owner, { op: "add", ...args } as never, pane);
    expect((await add({ inMinutes: 30 })).result).toContain("Give the note");
    // Daily Nous errors 14/11 slice 5: an argument mistake is a refusal naming the fix, not a failed tool.
    expect(await add({ note: "x" })).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("exactly one trigger") });
    expect((await add({ note: "x", inMinutes: 5, ticket: "q-20261017-124353-7e46" })).result).toContain("exactly one trigger");
    expect((await add({ note: "x", at: "2026-10-17T12:00:00.000Z" })).result).toContain("in the future");
    expect((await add({ note: "x", at: "2026-12-01T12:00:00.000Z" })).ok).toBe(true);
    expect(await add({ note: "Check Finn's merge", inMinutes: 30 })).toMatchObject({ ok: true, display: "Set a follow-up at 2026-10-17T13:30:00.000Z" });
    expect(await add({ note: "Read Andy's report", room: "Dino", pane: "Andy" }, { paneId: "pane:andy0001", paneLabel: "Andy" }))
      .toMatchObject({ ok: true, display: "Set a follow-up when Andy finishes" });
    expect((await f.followups.run(owner, { op: "list" }, null)).result.split("\n")).toHaveLength(3);
    expect((await f.followups.run("user:someone", { op: "list" }, null)).result).toBe("No follow-ups.");
  });

  it("fires when the time comes, a ticket ends or a pane finishes, closes only once the turn that saw it completed, and never after a cancel", async () => {
    const f = fixture();
    await f.followups.run(owner, { op: "add", note: "Look at the deploy", inMinutes: 10 }, null);
    await f.followups.run(owner, { op: "add", note: "Merge dev into S3", ticket: "q-20261017-124931-f2cc" }, null);
    await f.followups.run(owner, { op: "add", note: "Read Andy", pane: "Andy" }, { paneId: "pane:andy0001", paneLabel: "Andy" });
    const cancelled = await f.repository.add({ ownerUserId: owner, note: "never", trigger: { kind: "TIME", dueAt: "2026-10-17T13:01:00.000Z" } });
    expect((await f.followups.run(owner, { op: "cancel", followup: cancelled.id }, null)).ok).toBe(true);
    // Cancelling one that already ended is what cancel wants: ok, with how it ended (review 2026-10-20: 30 failures in 7 days).
    expect(await f.followups.run(owner, { op: "cancel", followup: cancelled.id }, null)).toMatchObject({ ok: true, result: expect.stringContaining("Already cancelled") });
    expect(await f.followups.run(owner, { op: "cancel", followup: "nous_followup:000000000000000000000000" }, null)).toMatchObject({ ok: false, result: expect.stringContaining("op list") });

    f.tickets.set("q-20261017-124931-f2cc", "VERIFYING");
    expect(await f.followups.tick()).toBe(0);
    f.advance(11 * 60_000);
    f.tickets.set("q-20261017-124931-f2cc", "DEPLOYED");
    expect(await f.followups.tick()).toBe(2);
    // Until the turn that carried the line completes, the row stays OPEN; R22-3: its line is not noticed again meanwhile.
    expect(await f.followups.tick()).toBe(0);
    await f.followups.paneFinished("pane:other0001");
    await f.followups.paneFinished("pane:andy0001");

    // The created time comes from the repository's own clock, so only the part after it is compared.
    const calls = f.notice.mock.calls as unknown as Array<[string, string, string, () => Promise<void>]>;
    expect(calls.map((call) => call[2].replace(/^Follow-up you set \S+ /, ""))).toEqual([
      "(time came): Look at the deploy", "(ticket q-20261017-124931-f2cc DEPLOYED): Merge dev into S3", "(Andy finished): Read Andy"
    ]);
    expect(calls[0]![1]).toMatch(/^followup:nous_followup:/);
    expect(calls[1]![1]).toBe("followups-ticket:q-20261017-124931-f2cc");
    expect((await f.repository.list(owner, 10)).map((item) => item.status).sort()).toEqual(["CANCELLED", "OPEN", "OPEN", "OPEN"]);
    // The turn completed: each line's onDone closes its follow-up as FIRED, once; the tick has nothing left.
    for (const call of calls) await call[3]();
    expect(await f.followups.tick()).toBe(0);
    await f.followups.paneFinished("pane:andy0001");
    expect(calls).toHaveLength(3);
    expect((await f.repository.list(owner, 10)).map((item) => item.status).sort()).toEqual(["CANCELLED", "FIRED", "FIRED", "FIRED"]);
  });

  it("1057 (13/11 REVIEW): a time wait whose note names a running ticket fires when that ticket ends; an ended or unknown ticket keeps the time", async () => {
    const f = fixture();
    f.tickets.set("q-20261113-010203-ab12", "VERIFYING");
    f.tickets.set("q-20261113-010203-cd34", "DEPLOYED");
    const running = await f.followups.run(owner, { op: "add", note: "Check the UpCloud lag after q-20261113-010203-ab12", inMinutes: 240 }, null);
    expect(running).toMatchObject({ ok: true, display: "Set a follow-up when ticket q-20261113-010203-ab12 ends", result: expect.stringContaining("still VERIFYING") });
    expect(running).not.toHaveProperty("meta");
    expect(await f.followups.run(owner, { op: "add", note: "Re-read q-20261113-010203-cd34", inMinutes: 30 }, null)).toMatchObject({ display: "Set a follow-up at 2026-10-17T13:30:00.000Z" });
    expect(await f.followups.run(owner, { op: "add", note: "Re-read q-20261113-010203-ef56", inMinutes: 30 }, null)).toMatchObject({ display: "Set a follow-up at 2026-10-17T13:30:00.000Z" });
    f.tickets.set("q-20261113-010203-ab12", "DEPLOYED");
    expect(await f.followups.tick()).toBe(1);
  });

  it("R22-3 (1/11: promote 46ed's follow-ups came back in 3-4 turns): ONE line per ticket end with every note, closed by the turn that saw it", async () => {
    const f = fixture();
    await f.followups.run(owner, { op: "add", note: "Run live:verify:dev for R21-1", ticket: "q-20261031-223319-46ed" }, null);
    // Two rows on one ticket, as before R23-4 (a later add joins the open one).
    await f.repository.add({ ownerUserId: owner, note: "Mark R21-1..5 DONE in the queue", trigger: { kind: "TICKET", ticketId: "q-20261031-223319-46ed" } });
    await f.followups.run(owner, { op: "add", note: "Re-check the revert", ticket: "q-20261031-224500-16ee" }, null);
    f.tickets.set("q-20261031-223319-46ed", "DEPLOYED");
    expect(await f.followups.tick()).toBe(2);
    const calls = f.notice.mock.calls as unknown as Array<[string, string, string, () => Promise<void>, () => Promise<void>]>;
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBe("followups-ticket:q-20261031-223319-46ed");
    expect(calls[0]![2]).toMatch(/^Ticket q-20261031-223319-46ed ended DEPLOYED: 2 follow-ups you set on it: \S+: Run live:verify:dev for R21-1; \S+: Mark R21-1\.\.5 DONE in the queue$/);
    // While a turn carries it, the minute tick says nothing more; a dropped line (a failed turn) comes again, once.
    expect(await f.followups.tick()).toBe(0);
    await calls[0]![4]();
    expect(await f.followups.tick()).toBe(2);
    expect(calls).toHaveLength(2);
    // The turn that saw it completed: both rows FIRED with the ticket's outcome; the other ticket still waits.
    await calls[1]![3]();
    expect((await f.repository.list(owner, 10)).map((item) => [item.note, item.status, item.outcome]).sort()).toEqual([
      ["Mark R21-1..5 DONE in the queue", "FIRED", "ticket q-20261031-223319-46ed DEPLOYED"], ["Re-check the revert", "OPEN", null],
      ["Run live:verify:dev for R21-1", "FIRED", "ticket q-20261031-223319-46ed DEPLOYED"]]);
    expect(await f.followups.tick()).toBe(0);
    f.tickets.set("q-20261031-224500-16ee", "FAILED");
    expect(await f.followups.tick()).toBe(1);
    expect(calls.at(-1)![2]).toMatch(/\(ticket q-20261031-224500-16ee FAILED\): Re-check the revert$/);
  });

  it("R23-4 (1/11 00:00 UTC: four follow-ups on ticket cb3d each asked a promote): a ticket Nous already watches keeps one follow-up, and a new note joins it", async () => {
    const f = fixture();
    const ticket = "q-20261101-000000-cb3d";
    const first = await f.followups.run(owner, { op: "add", note: "Promote once cb3d is on dev", ticket }, null);
    expect(first).toMatchObject({ ok: true, display: `Set a follow-up when ticket ${ticket} ends` });
    const joined = await f.followups.run(owner, { op: "add", note: "Then run live:verify:dev", ticket }, null);
    expect(joined).toMatchObject({ ok: true, display: `Added to the follow-up on ticket ${ticket}`, result: expect.stringContaining("this note joined it") });
    // The same note again changes nothing; another ticket gets its own follow-up.
    expect((await f.followups.run(owner, { op: "add", note: "Then run live:verify:dev", ticket }, null)).result).toContain("it already holds this note");
    await f.followups.run(owner, { op: "add", note: "Other ticket", ticket: "q-20261101-000100-abcd" }, null);
    const open = await f.repository.list(owner, 0);
    expect(open.filter((item) => item.trigger.kind === "TICKET" && item.trigger.ticketId === ticket).map((item) => item.note)).toEqual(["Promote once cb3d is on dev\nThen run live:verify:dev"]);
    expect(open).toHaveLength(2);
    // It fires once with both notes; once it fired, a new add on that ticket is a new follow-up.
    f.tickets.set(ticket, "DEPLOYED");
    expect(await f.followups.tick()).toBe(1);
    const calls = f.notice.mock.calls as unknown as Array<[string, string, string, () => Promise<void>]>;
    expect(calls[0]![2]).toMatch(/\(ticket q-20261101-000000-cb3d DEPLOYED\): Promote once cb3d is on dev\nThen run live:verify:dev$/);
    await calls[0]![3]();
    expect((await f.followups.run(owner, { op: "add", note: "A later check", ticket }, null)).display).toBe(`Set a follow-up when ticket ${ticket} ends`);
  });

  it("R44-2 (2/11: four follow-ups for one Temu approval): a second open follow-up naming the same decision, review, mailrev or mktpost id is refused with the first one's id", async () => {
    const f = fixture();
    const first = await f.followups.run(owner, { op: "add", note: "Check nous_decision:temu12345678 ran (Temu approval)", inMinutes: 30 }, null);
    const firstId = /^\[(nous_followup:[^\]]+)\]/.exec(first.result)![1]!;
    const again = await f.followups.run(owner, { op: "add", note: "Did the Temu approval nous_decision:temu12345678 go through?", ticket: "q-20261102-070000-abcd" }, null);
    expect(again).toMatchObject({ ok: false, refused: true, display: `${firstId} already follows nous_decision:temu12345678`, result: expect.stringContaining(firstId) });
    await f.followups.run(owner, { op: "add", note: "Read mailrev:Ad2HiP-_y5SI's outcome", inMinutes: 20 }, null);
    expect((await f.followups.run(owner, { op: "add", note: "mailrev:Ad2HiP-_y5SI sent?", pane: "Emma" }, { paneId: "pane:emma0001", paneLabel: "Emma" })).refused).toBe(true);
    // Another id, or the same id once the first follow-up ended: a new follow-up.
    expect((await f.followups.run(owner, { op: "add", note: "Check mktpost:vibe00000002 published", inMinutes: 30 }, null)).ok).toBe(true);
    await f.followups.run(owner, { op: "cancel", followup: firstId }, null);
    expect((await f.followups.run(owner, { op: "add", note: "Check nous_decision:temu12345678 again", inMinutes: 30 }, null)).ok).toBe(true);
    expect((await f.repository.list(owner, 0)).filter((item) => item.status === "OPEN")).toHaveLength(3);
    // R47-2: a mail campaign (and every copilot item a decision decides) is followed once too.
    const campaign = await f.followups.run(owner, { op: "add", note: "Check mcamp:pilot0000001 started sending", inMinutes: 30 }, null);
    expect((await f.followups.run(owner, { op: "add", note: "Did mcamp:pilot0000001 go out?", inMinutes: 60 }, null))).toMatchObject({ refused: true, result: expect.stringContaining(/^\[(nous_followup:[^\]]+)\]/.exec(campaign.result)![1]!) });
    expect((await f.followups.run(owner, { op: "add", note: "flmsg:contra000001 sent? mktcamp:launch00001 approved?", inMinutes: 30 }, null)).ok).toBe(true);
    expect((await f.followups.run(owner, { op: "add", note: "Read mktcamp:launch00001", inMinutes: 30 }, null)).refused).toBe(true);
  });

  it("token audit 21/11: one nous_msg sent to several panes waits on each; the same pane again is already set, not refused", async () => {
    const f = fixture();
    const leo = { paneId: "pane:leo00001", paneLabel: "Leo" };
    expect((await f.followups.run(owner, { op: "add", note: "Read Leo's report for nous_msg:919141ec", pane: "Leo" }, leo)).ok).toBe(true);
    expect((await f.followups.run(owner, { op: "add", note: "Read Emma's report for nous_msg:919141ec", pane: "Emma" }, { paneId: "pane:emma0001", paneLabel: "Emma" })).ok).toBe(true);
    expect((await f.followups.run(owner, { op: "add", note: "Verify dev for nous_msg:919141ec", ticket: "q-20261121-150000-abcd" }, null)).ok).toBe(true);
    expect((await f.followups.run(owner, { op: "add", note: "Check nous_msg:919141ec in 30 min", inMinutes: 30 }, null)).ok).toBe(true);
    const again = await f.followups.run(owner, { op: "add", note: "Leo's report for nous_msg:919141ec", pane: "Leo" }, leo);
    expect(again).toMatchObject({ ok: true, display: expect.stringMatching(/already waits on Leo$/) });
    expect(again.refused).toBeUndefined();
    // A second time wait on the same request is still that follow-up (R44-2).
    expect((await f.followups.run(owner, { op: "add", note: "nous_msg:919141ec again", inMinutes: 60 }, null)).refused).toBe(true);
    expect((await f.repository.list(owner, 0)).filter((item) => item.status === "OPEN")).toHaveLength(4);
  });

  it("9/11 REVIEW: a fired line says which room its panes are in now, so a deleted room's name in the note is not called again", async () => {
    const repository = new InMemoryNousFollowupsRepository();
    const notice = vi.fn<(owner: string, key: string, line: string) => Promise<void>>(async () => {});
    const followups = createNousFollowups({ repository, notice, paneWhere: async (paneId) => paneId === "pane:andy0001" ? "Andy (pane:andy0001) in room Cleo (room:cleo0001)" : null });
    await followups.run(owner, { op: "add", note: "Read Andy's report in Bruno", pane: "Andy" }, { paneId: "pane:andy0001", paneLabel: "Andy" });
    await followups.paneFinished("pane:andy0001");
    expect(notice.mock.calls[0]![2]).toMatch(/: Read Andy's report in Bruno \(now: Andy \(pane:andy0001\) in room Cleo \(room:cleo0001\)\)$/);
  });

  it("ends a pane's follow-up as cancelled when the pane closes before it finished, and keeps it while the pane cannot be read (queue item 14)", async () => {
    const repository = new InMemoryNousFollowupsRepository();
    const notice = vi.fn<(owner: string, key: string, line: string, onDone?: () => Promise<void>) => Promise<void>>(async () => {});
    const open = new Map<string, boolean | null>([["pane:finn0001", true], ["pane:kate0001", null]]);
    const followups = createNousFollowups({ repository, notice, paneOpen: async (paneId) => open.has(paneId) ? open.get(paneId)! : false });
    await followups.run(owner, { op: "add", note: "Read Finn's report", pane: "Finn" }, { paneId: "pane:finn0001", paneLabel: "Finn" });
    await followups.run(owner, { op: "add", note: "Read Kate", pane: "Kate" }, { paneId: "pane:kate0001", paneLabel: "Kate" });
    expect(await followups.tick()).toBe(0);
    open.set("pane:finn0001", false);
    expect(await followups.tick()).toBe(1);
    expect(notice.mock.calls[0]![2]).toMatch(/\(Finn closed before it finished\): Read Finn's report$/);
    expect(notice.mock.calls[0]![1]).toBe("followups-cancelled");
    await notice.mock.calls[0]![3]!();
    expect((await repository.list(owner, 10)).map((item) => [item.note, item.status, item.outcome])).toEqual(expect.arrayContaining([
      ["Read Finn's report", "CANCELLED", "Finn closed before it finished"], ["Read Kate", "OPEN", null]]));
  });

  it("1045 (12/11: post-boot checks by Hugo, whose pane closed at the reboot): the server re-arms the check 10 min later, and it fires with the worker gone", async () => {
    let clock = Date.parse("2026-11-12T19:30:00.000Z");
    const repository = new InMemoryNousFollowupsRepository();
    const notice = vi.fn<(owner: string, key: string, line: string, onDone?: () => Promise<void>) => Promise<void>>(async () => {});
    let hugoOpen = true;
    const followups = createNousFollowups({ repository, notice, now: () => clock, paneOpen: async () => hugoOpen });
    expect((await followups.run(owner, { op: "add", note: "Post-boot checks after the reboot: services up, plan pZwo step 7", pane: "Hugo" }, { paneId: "pane:hugo0001", paneLabel: "Hugo" })).result)
      .toContain("the server arms this check itself 10 min later");
    hugoOpen = false; // the reboot closes the worker's pane
    expect(await followups.tick()).toBe(0);
    expect(notice).not.toHaveBeenCalled();
    const open = (await repository.list(owner, 10)).filter((item) => item.status === "OPEN");
    expect(open).toMatchObject([{ trigger: { kind: "TIME", dueAt: "2026-11-12T19:40:00.000Z" }, note: expect.stringContaining("armed by the server (Hugo closed at the reboot)") }]);
    clock += 10 * 60_000;
    expect(await followups.tick()).toBe(1);
    expect(notice.mock.calls[0]![2]).toMatch(/Post-reboot check armed by the server .*plan pZwo step 7[\s\S]*keep the plan step IN_PROGRESS until it reports/);
    await notice.mock.calls[0]![3]!();
    expect((await repository.list(owner, 10)).every((item) => item.status === "FIRED")).toBe(true);
  });

  it("folds every follow-up whose pane closed into ONE inbox line, closed by the turn that saw it (queue item 40, 28/10 10:48: 17 lines)", async () => {
    const repository = new InMemoryNousFollowupsRepository();
    const notice = vi.fn<(owner: string, key: string, line: string, onDone?: () => Promise<void>) => Promise<void>>(async () => {});
    const followups = createNousFollowups({ repository, notice, paneOpen: async (paneId) => paneId === "pane:open0001" });
    for (const [paneId, paneLabel, note] of [["pane:andy0001", "Andy", "Check the merge"], ["pane:andy0001", "Andy", "Read the report"], ["pane:kate0001", "Kate", "Ask for the PDF"], ["pane:open0001", "Bob", "Still open"]]) {
      await followups.run(owner, { op: "add", note: note!, pane: paneLabel }, { paneId: paneId!, paneLabel: paneLabel! });
    }
    expect(await followups.tick()).toBe(3);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0]![2]).toBe("3 follow-ups cancelled, their panes closed before they finished: Andy: Check the merge; Andy: Read the report; Kate: Ask for the PDF");
    await notice.mock.calls[0]![3]!();
    expect((await repository.list(owner, 10)).map((item) => item.status).sort()).toEqual(["CANCELLED", "CANCELLED", "CANCELLED", "OPEN"]);
    // Nothing left to say on the next minute.
    expect(await followups.tick()).toBe(0);
    expect(notice).toHaveBeenCalledTimes(1);
    // Bound by pane id since creation: a later pane with the same name (a new "Andy") neither fires nor keeps the old one.
    await followups.run(owner, { op: "add", note: "Old Andy's step", pane: "Andy" }, { paneId: "pane:andy0001", paneLabel: "Andy" });
    await followups.paneFinished("pane:andy0002");
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it("has no limit on open follow-ups: adds past the old 50, lists every one, fires and cancels past the old windows (operator 2026-10-27)", async () => {
    const f = fixture();
    const first = await f.repository.add({ ownerUserId: owner, note: "n0", trigger: { kind: "TICKET", ticketId: "q-20261017-000000-0000" } });
    for (let index = 1; index < 250; index += 1) await f.repository.add({ ownerUserId: owner, note: `n${index}`, trigger: { kind: "TICKET", ticketId: "q-20261017-000000-0000" } });
    expect(await f.followups.run(owner, { op: "add", note: "one more", inMinutes: 5 }, null)).toMatchObject({ ok: true });
    expect((await f.followups.run(owner, { op: "list" }, null)).result.split("\n")).toHaveLength(251);
    f.advance(6 * 60_000);
    expect(await f.followups.tick()).toBe(1);
    expect(f.notice.mock.calls.map((call) => (call as unknown as [string, string, string])[2])).toEqual([expect.stringContaining("(time came): one more")]);
    // The oldest one, behind 249 open rows: cancel finds it by id, also once it has ended (the old 200-row window missed it).
    expect((await f.followups.run(owner, { op: "cancel", followup: first.id }, null)).ok).toBe(true);
    expect(await f.followups.run(owner, { op: "cancel", followup: first.id }, null)).toMatchObject({ ok: true, result: expect.stringContaining("Already cancelled") });
  });

  it("15/11 REVIEW (51563d56 → e77e225f): a note held only by a reason naming no hold waits once; re-armed after it fired, it runs now", async () => {
    const f = fixture();
    const note = "Check the stale Marketing post item; else re-arm 12 h.";
    const add = (reason: string) => f.followups.run(owner, { op: "add", note: `${note} (wait reason: ${reason})`, inMinutes: 720 }, null);
    const first = await add("the proof needs a real post; none is known yet");
    expect(first).toMatchObject({ ok: true });
    expect(await add("the proof needs a real post; none is known yet")).toMatchObject({ ok: true });
    await f.repository.close(owner, first.result.match(/^\[(\S+)\]/)![1]!, "FIRED", "time came");
    expect(await add("still none")).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Do the check in this turn") });
    // A reason naming a real hold, or another note, still waits.
    expect(await add("the operator's approval of the post")).toMatchObject({ ok: true });
    // 2026-11-15 REVIEW 6 (A): once that fired too, the same note with the same reason is refused, whatever the reason names.
    const second = (await f.repository.list(owner, 0)).find((item) => item.status === "OPEN" && item.note.includes("operator's approval"))!;
    await f.repository.close(owner, second.id, "FIRED", "time came");
    expect(await add("the operator's approval of the post")).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("is unchanged") });
    expect(await add("the operator's approval, asked again on 15/11")).toMatchObject({ ok: true });
    expect(await f.followups.run(owner, { op: "add", note: "Another check (wait reason: still none)", inMinutes: 720 }, null)).toMatchObject({ ok: true });
  });
});

describe("ticketMergedOnMain", () => {
  it("finds a pruned ticket by its queue merge commit on main only", async () => {
    const root = mkdtempSync(join(tmpdir(), "ticket-main-"));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "Merge queue q-20261105-134554-e18f: fix");
      git("checkout", "-q", "-b", "dev");
      git("commit", "-q", "--allow-empty", "-m", "Merge queue q-20261113-162136-1eb2: dev only");
      expect(await ticketMergedOnMain("q-20261105-134554-e18f", root)).toBe(true);
      expect(await ticketMergedOnMain("q-20261113-162136-1eb2", root)).toBe(false);
      expect(await ticketMergedOnMain("q-20261105-134554-e18f", join(root, "missing"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
