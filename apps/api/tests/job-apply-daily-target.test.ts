import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import type { JobApplyRun, Pane } from "@space/contracts";
import { createConnectorCrypto } from "../src/dot-connectors.js";
import { createJobApplyRunKick } from "../src/job-apply/routes.js";
import { InMemoryJobApplyRepository } from "../src/job-apply/memory-repository.js";
import { createJobApplyService } from "../src/job-apply/service.js";
import type { RoomPaneObservation } from "../src/room-pane-control.js";

// Operator 13/11 20:52 BKK: "the target was 200 a day". 12:00 in the owner's default zone (Asia/Bangkok): half the day is gone.
const NOON_BKK = Date.parse("2026-11-13T05:00:00.000Z");
const idle = { sessionId: "cli_session:1", promptFingerprint: "f", state: "IDLE", usageLimited: false, text: "✻ Done.\n────\n❯ \n────" } as RoomPaneObservation;

function fixture() {
  let clock = NOON_BKK;
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Jobs", initialPaneCount: 0 }, "trace:t", "user:owner");
  const pane = store.createPane({ roomId: room.id, title: "Bob", mode: "JOB_APPLY", terminalRuntimeId: "cli:claude" });
  const service = createJobApplyService({
    repository: new InMemoryJobApplyRepository(() => new Date(clock).toISOString()), store, artifactRoot: "/nonexistent", jobApplyRoot: "/nonexistent/job-apply", now: () => new Date(clock).toISOString(),
    crypto: createConnectorCrypto({ key: "synthetic-connector-key-with-enough-length-0123456789", legacySecrets: ["test-secret-with-enough-length-0123456789"] })
  });
  const kickoffs: Array<{ runId: string; discover: boolean }> = [];
  const kickoff = vi.fn(async (_pane: Pane, run: JobApplyRun, discover: boolean) => { kickoffs.push({ runId: run.id, discover }); });
  let observed = idle;
  let asking = false;
  const waited = vi.fn(async () => undefined);
  const kick = createJobApplyRunKick(service, { store, kickoff, log: { warn: () => undefined }, now: () => clock, inspect: async () => observed,
    holds: async () => asking, waited });
  return { store, room, pane, service, kick, kickoff, kickoffs, waited, advance: (ms: number) => { clock += ms; },
    observe: (next: RoomPaneObservation) => { observed = next; }, ask: (open: boolean) => { asking = open; } };
}

describe("Job Copilot daily application target", () => {
  it("keeps the target in the profile, counts today's pace and names a day's misses in the stats", async () => {
    const { service } = fixture();
    expect((await service.getProfile("user:owner")).dailyTarget).toBe(0);
    await service.noteTargetMiss("user:owner", "QUEUE_EMPTY"); // no target: nothing recorded
    expect((await service.stats("user:owner", "Asia/Bangkok")).days).toEqual([]);
    expect((await service.updateProfile("user:owner", { dailyTarget: 200 })).dailyTarget).toBe(200);
    expect(await service.targetPace("user:owner")).toEqual({ target: 200, applied: 0, due: 101 });
    await service.noteTargetMiss("user:owner", "QUEUE_DEFERRED");
    await service.noteTargetMiss("user:owner", "QUEUE_DEFERRED");
    await service.noteTargetMiss("user:owner", "CLI_BUSY");
    const stats = await service.stats("user:owner", "Asia/Bangkok");
    expect(stats.target).toBe(200);
    expect(stats.days).toEqual([{ day: "2026-11-13", applied: 0, verified: 0, failed: 0, missed: ["QUEUE_DEFERRED", "CLI_BUSY"] }]);
  });

  it("starts a run on a pane behind the target's pace, finds postings first, and starts again at most hourly", async () => {
    const { pane, service, kick, kickoffs, advance } = fixture();
    expect(await kick.tick()).toBe(0); // no target: nothing starts
    await service.updateProfile("user:owner", { dailyTarget: 200 });
    expect(await kick.tick()).toBe(1);
    const run = (await service.runView("user:owner", pane.id)).run!;
    expect(run.status).toBe("RUNNING");
    expect(kickoffs).toEqual([{ runId: run.id, discover: true }]);
    // Discovery found nothing: the run ends itself and the day records why.
    await service.nextJob("user:owner", pane.id, { waitMs: 0, metadata: null });
    expect((await service.stats("user:owner", "Asia/Bangkok")).days[0]?.missed).toEqual(["QUEUE_EMPTY"]);
    advance(10 * 60_000);
    expect(await kick.tick()).toBe(0);
    advance(51 * 60_000);
    expect(await kick.tick()).toBe(1);
  });

  it("never starts after the operator's Stop, never types over an open ask, and reports a 30-minute wait once", async () => {
    const { pane, service, kick, kickoff, waited, advance, ask, observe } = fixture();
    await service.updateProfile("user:owner", { dailyTarget: 200 });
    await service.startRun("user:owner", pane.id);
    await service.stopRun("user:owner", pane.id);
    expect(await kick.tick()).toBe(0); // the operator's Stop holds until they start again
    await service.startRun("user:owner", pane.id);
    await service.nextJob("user:owner", pane.id, { waitMs: 0, metadata: null }); // that run finishes itself: the keeper may start
    ask(true);
    expect(await kick.tick()).toBe(0);
    advance(31 * 60_000);
    expect(await kick.tick()).toBe(0);
    expect(waited).toHaveBeenCalledTimes(1);
    expect(waited).toHaveBeenCalledWith("user:owner", expect.objectContaining({ id: pane.id }), "WAITS_ON_OPERATOR");
    advance(60_000);
    await kick.tick();
    expect(waited).toHaveBeenCalledTimes(1);
    ask(false);
    observe({ ...idle, text: "✻ Working… (esc to interrupt)", state: "BUSY" } as RoomPaneObservation);
    expect(await kick.tick()).toBe(0);
    observe(idle);
    expect(await kick.tick()).toBe(1);
    expect(kickoff).toHaveBeenCalledTimes(1);
    expect((await service.stats("user:owner", "Asia/Bangkok")).days[0]?.missed).toEqual(expect.arrayContaining(["WAITS_ON_OPERATOR"]));
  });

  it("ends a RUNNING run with nothing to take once its agent sits idle, behind pace, and starts one that finds postings (13/11, jobrun:ez_x261xkw30)", async () => {
    const { pane, service, kick, kickoffs, advance, observe } = fixture();
    const first = (await service.startRun("user:owner", pane.id)).run; // the operator's Start; its agent ended its turn without space_job_next
    advance(11 * 60_000);
    expect(await kick.tick()).toBe(0); // no target: the run is left alone
    await service.updateProfile("user:owner", { dailyTarget: 200 });
    observe({ ...idle, text: "✻ Working… (esc to interrupt)", state: "BUSY" } as RoomPaneObservation);
    expect(await kick.tick()).toBe(0); // the agent is still at work (discovery): nothing ends
    expect((await service.runView("user:owner", pane.id)).run?.id).toBe(first.id);
    observe(idle);
    expect(await kick.tick()).toBe(1);
    const next = (await service.runView("user:owner", pane.id)).run!;
    expect(next.id).not.toBe(first.id);
    expect(kickoffs).toEqual([{ runId: next.id, discover: true }]);
    const [stopped] = await service.listEvents("user:owner", { paneId: pane.id, types: ["RUN_STOPPED"], limit: 1 });
    expect(stopped?.payload).toMatchObject({ keeper: true }); // the keeper's own end never holds it like the operator's Stop
    expect((await service.stats("user:owner", "Asia/Bangkok")).days[0]?.missed).toEqual(["QUEUE_EMPTY"]);
    // The new run finds nothing and sits idle too: it ends, and the next start waits out the hour.
    advance(11 * 60_000);
    expect(await kick.tick()).toBe(0);
    expect((await service.runView("user:owner", pane.id)).run).toBeNull();
    advance(50 * 60_000);
    expect(await kick.tick()).toBe(1);
  });

  it("undoes a run whose kickoff could not be typed without holding the keeper, and starts one pane at a time", async () => {
    const { store, room, pane, service, kick, kickoff, advance } = fixture();
    await service.updateProfile("user:owner", { dailyTarget: 200 });
    kickoff.mockRejectedValueOnce(new Error("no CLI"));
    expect(await kick.tick()).toBe(0);
    expect((await service.runView("user:owner", pane.id)).run).toBeNull();
    store.createPane({ roomId: room.id, title: "Second", mode: "JOB_APPLY", terminalRuntimeId: "cli:claude" });
    advance(61 * 60_000);
    expect(await kick.tick()).toBe(1); // one of the two panes starts, the other sees its run
    expect(kickoff).toHaveBeenCalledTimes(2);
  });
});
