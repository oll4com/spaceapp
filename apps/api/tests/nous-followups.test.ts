import { describe, expect, it, vi } from "vitest";
import { InMemoryNousFollowupsRepository } from "@space/db";
import { createNousFollowups, NOUS_FOLLOWUP_OPEN_MAX } from "../src/nous/followups.js";

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
  it("takes exactly one trigger, a future time at most 30 days ahead, and a note", async () => {
    const f = fixture();
    const add = (args: object, pane: { paneId: string; paneLabel: string } | null = null) => f.followups.run(owner, { op: "add", ...args } as never, pane);
    expect((await add({ inMinutes: 30 })).result).toContain("Give the note");
    expect((await add({ note: "x" })).result).toContain("exactly one trigger");
    expect((await add({ note: "x", inMinutes: 5, ticket: "q-20261017-124353-7e46" })).result).toContain("exactly one trigger");
    expect((await add({ note: "x", at: "2026-10-17T12:00:00.000Z" })).result).toContain("in the future");
    expect((await add({ note: "x", at: "2026-12-01T12:00:00.000Z" })).result).toContain("at most 30 days");
    expect(await add({ note: "Check Finn's merge", inMinutes: 30 })).toMatchObject({ ok: true, display: "Set a follow-up at 2026-10-17T13:30:00.000Z" });
    expect(await add({ note: "Read Andy's report", room: "Dino", pane: "Andy" }, { paneId: "pane:andy0001", paneLabel: "Andy" }))
      .toMatchObject({ ok: true, display: "Set a follow-up when Andy finishes" });
    expect((await f.followups.run(owner, { op: "list" }, null)).result.split("\n")).toHaveLength(2);
    expect((await f.followups.run("user:someone", { op: "list" }, null)).result).toBe("No follow-ups.");
  });

  it("fires once when the time comes, a ticket ends or a pane finishes, and never after a cancel", async () => {
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
    expect(await f.followups.tick()).toBe(0);
    await f.followups.paneFinished("pane:other0001");
    await f.followups.paneFinished("pane:andy0001");
    await f.followups.paneFinished("pane:andy0001");

    // The created time comes from the repository's own clock, so only the part after it is compared.
    expect(f.notice.mock.calls.map((call) => (call as unknown as [string, string, string])[2].replace(/^Follow-up you set \S+ /, ""))).toEqual([
      "(time came): Look at the deploy", "(ticket q-20261017-124931-f2cc DEPLOYED): Merge dev into S3", "(Andy finished): Read Andy"
    ]);
    expect((f.notice.mock.calls[0] as unknown as [string, string])[1]).toMatch(/^followup:nous_followup:/);
    const listed = (await f.repository.list(owner, 10)).map((item) => item.status);
    expect(listed.sort()).toEqual(["CANCELLED", "FIRED", "FIRED", "FIRED"]);
  });

  it("keeps at most 50 open follow-ups per owner", async () => {
    const f = fixture();
    for (let index = 0; index < NOUS_FOLLOWUP_OPEN_MAX; index += 1) await f.repository.add({ ownerUserId: owner, note: `n${index}`, trigger: { kind: "TICKET", ticketId: "q-20261017-000000-0000" } });
    expect((await f.followups.run(owner, { op: "add", note: "one more", inMinutes: 5 }, null)).result).toContain("cancel some first");
  });
});
