import { describe, expect, it, vi } from "vitest";
import { InMemoryNousRepository } from "@space/db";
import { activePaceCapEmergency, createPaceCapEmergency, emergencyReleases, PACE_CAP_EMERGENCY_NOTE, paceCapEmergencyText, parsePaceCapEmergency } from "../src/nous/pace-cap-emergency.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

// Operator 6/11 11:31 BKK (nous_msg:1d470cc93b194f03ae7f7706): Nous opens and closes Space Gateway's pace cap for the operator's work.
const owner = "user:operator";
const ctx = { owner, turnId: "turn:1", callId: "call:1", traceId: "trace:1" };
const start = Date.parse("2026-11-06T04:30:00Z");

function setup() {
  let clock = start;
  const notes = new InMemoryNousRepository();
  const push = vi.fn(async () => {});
  const emergency = createPaceCapEmergency({ notes, push, now: () => clock });
  const nous = createNousTools({ rooms: async () => [], listPanes: async () => [], paceCapEmergency: { ...emergency, sends: true } } as unknown as NousToolDeps);
  return { notes, push, emergency, nous, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

describe("Space Gateway pace cap emergency (space_pace_cap_emergency)", () => {
  it("opens the cap for named panes with a reason, shows it, sends it to the gateway at once, and closes it with off", async () => {
    const f = setup();
    const opened = await f.nous.execute("space_pace_cap_emergency", { action: "on", panes: ["pane:dino0001", "pane:andy0001"], reason: "find a server", hours: 2 }, ctx);
    expect(opened).toMatchObject({ ok: true, display: "Opened the pace cap" });
    expect(opened.result).toBe("PACE CAP EMERGENCY ON until 13:30 Asia/Bangkok — find a server — panes: pane:dino0001, pane:andy0001. off closes it at once.");
    expect(f.push).toHaveBeenCalledTimes(1);
    const note = parsePaceCapEmergency((await f.notes.listNotes(owner)).find((entry) => entry.key === PACE_CAP_EMERGENCY_NOTE)?.text);
    expect(note).toMatchObject({ all: false, panes: ["pane:dino0001", "pane:andy0001"], reason: "find a server", until: "2026-11-06T06:30:00.000Z" });
    expect((await f.nous.execute("space_pace_cap_emergency", { action: "status" }, ctx)).result).toMatch(/^PACE CAP EMERGENCY ON until 13:30 Asia\/Bangkok — find a server/);
    const closed = await f.nous.execute("space_pace_cap_emergency", { action: "off" }, ctx);
    expect(closed.result).toMatch(/^Closed: PACE CAP EMERGENCY ON until 13:30/);
    expect(f.push).toHaveBeenCalledTimes(2);
    expect(await f.emergency.active(owner)).toBeNull();
    expect((await f.nous.execute("space_pace_cap_emergency", { action: "status" }, ctx)).result).toBe("PACE CAP EMERGENCY off.");
  });

  it("opens it for all background work, 12 hours by default and a week at most, and ends by itself", async () => {
    const f = setup();
    const all = await f.emergency.on(owner, { panes: "all", reason: "find more free tokens" });
    expect(all).toMatchObject({ all: true, panes: [], until: "2026-11-06T16:30:00.000Z" });
    expect(paceCapEmergencyText(all, "Asia/Bangkok")).toBe("PACE CAP EMERGENCY ON until 23:30 Asia/Bangkok — find more free tokens — panes: all background work");
    expect((await f.emergency.on(owner, { panes: "all", reason: "find more free tokens", hours: 500 })).until).toBe("2026-11-13T04:30:00.000Z");
    f.advance(168 * 3_600_000);
    expect(await f.emergency.active(owner)).toBeNull();
    expect(activePaceCapEmergency(all, f.now())).toBeNull();
    expect((await f.nous.execute("space_pace_cap_emergency", { action: "status" }, ctx)).result).toBe("PACE CAP EMERGENCY off.");
  });

  it("refuses on without panes or a reason, and bad shapes (bad pane ids, more than a week)", async () => {
    const f = setup();
    expect(await f.nous.execute("space_pace_cap_emergency", { action: "on", panes: "all" }, ctx)).toMatchObject({ ok: false });
    expect(await f.nous.execute("space_pace_cap_emergency", { action: "on", reason: "find a server" }, ctx)).toMatchObject({ ok: false });
    expect(await f.nous.execute("space_pace_cap_emergency", { action: "on", panes: ["Dino"], reason: "find a server" }, ctx)).toMatchObject({ ok: false });
    expect(await f.nous.execute("space_pace_cap_emergency", { action: "on", panes: "all", reason: "find a server", hours: 169 }, ctx)).toMatchObject({ ok: false });
    expect(f.push).not.toHaveBeenCalled();
    expect(await f.emergency.active(owner)).toBeNull();
  });

  it("says when the instance does not send the gateway its list (dev)", async () => {
    const f = setup();
    const dev = createNousTools({ rooms: async () => [], listPanes: async () => [], paceCapEmergency: { ...f.emergency, sends: false } } as unknown as NousToolDeps);
    expect((await dev.execute("space_pace_cap_emergency", { action: "on", panes: "all", reason: "find a server" }, ctx)).result)
      .toMatch(/This instance does not send Space Gateway its list \(dev\): the gateway is unchanged\.$/);
  });

  // Plan clipboard:DotwYXVD2N3n: under the emergency the gateway holds a turn only when no account with week room is left; typing it at once looped.
  it("releases a held turn at once only when the emergency covering its pane was set after the hold", async () => {
    const f = setup();
    const all = await f.emergency.on(owner, { panes: "all", reason: "find a server" });
    const named = await f.emergency.on(owner, { panes: ["pane:emma0001"], reason: "find a server" });
    const before = new Date(start - 60_000).toISOString(), under = new Date(start + 60_000).toISOString();
    expect([emergencyReleases([all], "pane:andy0001", before), emergencyReleases([all], "pane:andy0001", under)]).toEqual([true, false]);
    expect([emergencyReleases([named], "pane:emma0001", before), emergencyReleases([named], "pane:andy0001", before)]).toEqual([true, false]);
    expect(emergencyReleases([{ ...all, setAt: "" }], "pane:andy0001", under)).toBe(true);
  });
});
