import { describe, expect, it, vi } from "vitest";
import { nousSettingsSchema, type Pane, type Room } from "@space/contracts";
import { InMemoryNousPaneChecksRepository, InMemoryNousPaneCloseoutsRepository, InMemoryNousPlanMarksRepository } from "@space/db";
import { createStuckPanes, NOUS_STUCK_SAMPLE_MS } from "../src/nous/stuck-panes.js";
import { createStandingOrders, type StandingOrdersDeps } from "../src/nous/standing-orders.js";
import { itemActed, type NousTurnItem } from "../src/nous/turn-items.js";
import { createNousPaneWatch } from "../src/nous/pane-watch.js";
import { createNousTools } from "../src/nous/tools.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-01T18:50:00.000Z");
const owner = "user:operator";
const rule = "─".repeat(60);
// 2/11 01:50-05:40 BKK: Alex/Emma's Claude Code stood on this frame for 3.7 hours.
const frozen = ["● Bash(npx tsx scripts/devnet-flow.ts)", "  ⎿  Running…", "✢ Moonwalking… (7m 1s · esc to interrupt)", rule, "❯ ", rule, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const idle = ["● Done: the devnet flow passed.", "✻ Cooked for 7m 1s", rule, "❯ ", rule, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const sample = (screen: string, extra: Partial<Parameters<ReturnType<typeof createStuckPanes>["observe"]>[0]> = {}) =>
  ({ owner, paneId: "pane:kDGQgEZG1Ws1", label: "Alex/Emma", screen, state: "done|done|2026-11-01T18:50:38.000Z|cli_session:a", queuedAt: null, ...extra });

describe("R35-1: a CLI pane frozen on a spinner, or never taking a queued text, is STUCK (2/11 Alex/Emma)", () => {
  it("names a spinner whose screen and CLI state stood still 30 minutes; any change starts the clock again", () => {
    const stuck = createStuckPanes();
    expect(stuck.observe(sample(frozen), T0)).toBeNull();
    expect(stuck.due("pane:kDGQgEZG1Ws1", sample(frozen).state, T0 + MIN)).toBe(false);
    expect(stuck.due("pane:kDGQgEZG1Ws1", sample(frozen).state, T0 + NOUS_STUCK_SAMPLE_MS)).toBe(true);
    // A restart (a new CLI session) is sampled at once.
    expect(stuck.due("pane:kDGQgEZG1Ws1", "idle|idle|2026-11-01T22:36:00.000Z|cli_session:b", T0 + MIN)).toBe(true);
    expect(stuck.observe(sample(frozen), T0 + 25 * MIN)).toBeNull();
    const line = stuck.observe(sample(frozen), T0 + 30 * MIN)?.line;
    expect(line).toBe("STUCK: screen and CLI state unchanged 30 min (since 18:50 UTC), a spinner that does not move (Space holds texts for it while it shows)"
      + " → read it (space_read_pane), restart it (space_restart_pane) and send its work again");
    expect(stuck.get("pane:kDGQgEZG1Ws1")?.line).toBe(line);
    expect(stuck.list(owner)).toHaveLength(1);
    expect(stuck.list("user:other")).toEqual([]);
    // A live spinner's clock moves: never stuck.
    expect(stuck.observe(sample(frozen.replace("7m 1s", "7m 6s")), T0 + 35 * MIN)).toBeNull();
    expect(stuck.observe(sample(frozen.replace("7m 1s", "7m 6s")), T0 + 60 * MIN)).toBeNull();
    // The same screen with a new recorded CLI state (the transcript moved) starts over too.
    expect(stuck.observe(sample(frozen.replace("7m 1s", "7m 6s"), { state: "working|working|2026-11-01T19:50:00.000Z|cli_session:a" }), T0 + 70 * MIN)).toBeNull();
    stuck.retain(new Set());
    expect(stuck.get("pane:kDGQgEZG1Ws1")).toBeNull();
  });

  it("names an idle pane only when a text waited 30 minutes for it; a question or a usage limit waits on purpose", () => {
    const stuck = createStuckPanes();
    stuck.observe(sample(idle), T0);
    expect(stuck.observe(sample(idle), T0 + 40 * MIN)).toBeNull();
    const queuedAt = "2026-11-01T18:55:00.000Z";
    expect(stuck.observe(sample(idle, { queuedAt }), T0 + 40 * MIN)?.line).toContain("unchanged 40 min (since 18:50 UTC), a text queued for it since 18:55 UTC never typed →");
    expect(stuck.observe(sample(idle, { queuedAt: "2026-11-01T19:10:00.000Z" }), T0 + 41 * MIN)).toBeNull();
    expect(stuck.observe(sample(frozen), T0)).toBeNull();
    expect(stuck.observe(sample(frozen, { waiting: true }), T0 + 31 * MIN)).toBeNull();
  });

  it("counts only a restart, stop or close of the pane as acting on a stuck item; a text sent to it waits like the ones before", () => {
    const item: NousTurnItem = { key: "stuck:pane:kDGQgEZG1Ws1", kind: "STUCK", pane: "pane:kDGQgEZG1Ws1", paneName: "Alex/Emma", line: "Alex/Emma · STUCK" };
    const act = (name: string, args: Record<string, unknown>) => ({ name, args, ok: true, subjects: [] });
    expect(itemActed(item, [act("space_send_to_pane", { room: "Alex", pane: "Emma", text: "go on" })])).toBe(false);
    expect(itemActed(item, [act("space_pane_checked", { room: "Alex", pane: "Emma", verdict: "WAITING_DATE" })])).toBe(false);
    expect(itemActed(item, [act("space_restart_pane", { room: "Alex", pane: "Emma" })])).toBe(true);
    expect(itemActed(item, [act("space_execute", { actions: [{ kind: "pane", operation: "restart", target: { paneIds: ["pane:kDGQgEZG1Ws1"] } }] })])).toBe(true);
    expect(itemActed(item, [act("space_restart_pane", { room: "Alex", pane: "Bob" })])).toBe(false);
  });

  it("brings a Standing orders turn with the stuck pane as an item, again only after 8 hours while it stays stuck", async () => {
    let clock = T0;
    const standing = vi.fn<StandingOrdersDeps["standing"]>(async () => "STARTED");
    let stuck = [{ paneId: "pane:kDGQgEZG1Ws1", label: "Alex/Emma", line: "STUCK: screen and CLI state unchanged 30 min (since 18:50 UTC), a spinner that does not move" }];
    const orders = createStandingOrders({ closeouts: new InMemoryNousPaneCloseoutsRepository(), marks: new InMemoryNousPlanMarksRepository(),
      settings: async () => nousSettingsSchema.parse({ enabled: true, standingOrders: { dailyReview: false, closeFinishedPanes: false } }), owners: async () => [owner],
      collect: async () => ({ rooms: [], reports: [], notifications: [], decisions: [], copilotItems: [], plans: [], checks: [], tasks: [], executions: [], summaries: [] }),
      reportsSince: async () => [], lowToken: async () => false, standing, notice: vi.fn(async () => {}), now: () => clock, stuck: async () => stuck });
    await orders.tick();
    expect(standing).toHaveBeenCalledTimes(1);
    const [, reason, text, options] = standing.mock.calls[0]!;
    expect(reason).toBe("STANDING");
    expect(text).toContain("## Stuck panes (screen and CLI state unchanged 30+ min on a spinner, or a text queued for it never typed; the world may call them idle)\n"
      + "- Alex/Emma (pane:kDGQgEZG1Ws1) · STUCK: screen and CLI state unchanged 30 min (since 18:50 UTC), a spinner that does not move");
    expect(options).toEqual({ items: [{ key: "stuck:pane:kDGQgEZG1Ws1", kind: "STUCK", pane: "pane:kDGQgEZG1Ws1", paneName: "Alex/Emma",
      line: "Alex/Emma (pane:kDGQgEZG1Ws1) · STUCK: screen and CLI state unchanged 30 min (since 18:50 UTC), a spinner that does not move" }] });
    clock += 10 * MIN;
    await orders.tick();
    expect(standing).toHaveBeenCalledTimes(1);
    clock += 20 * MIN;
    await orders.tick();
    expect(standing).toHaveBeenCalledTimes(1);
    // Still stuck: listed again 8 hours on (operator 5/11 20:44 BKK: checks only on a change, otherwise a few times a day).
    clock += 8 * 60 * MIN - 30 * MIN;
    await orders.tick();
    expect(standing).toHaveBeenCalledTimes(2);
    stuck = [];
    clock += 40 * MIN;
    await orders.tick();
    expect(standing).toHaveBeenCalledTimes(2);
  });

  it("refuses a verdict that hides a stuck pane (frozen Emma was checked ok working and waiting date)", async () => {
    const room = { id: "room:alex0001", name: "Alex", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null, order: 1 } as unknown as Room;
    const emma = { id: "pane:kDGQgEZG1Ws1", roomId: room.id, paneName: "Emma", title: "Emma", mode: "TERMINAL", isClosed: false, terminalRuntimeId: "cli:claude" } as unknown as Pane;
    const watch = createNousPaneWatch({ repository: new InMemoryNousPaneChecksRepository(), now: () => T0 });
    const tools = createNousTools({ rooms: async () => [room], listPanes: async () => [emma], paneWatch: watch, inspectPane: async () => ({ state: "IDLE" }),
      stuckPane: (paneId: string) => paneId === emma.id ? "STUCK: screen and CLI state unchanged 40 min" : null } as never);
    const ctx = { owner, turnId: "turn:1", callId: "call:1", traceId: "trace:1" };
    for (const verdict of ["OK_WORKING", "WAITING_DATE"]) {
      expect(await tools.execute("space_pane_checked", { room: "Alex", pane: "Emma", verdict, nextCheckInMinutes: 30 }, ctx)).toMatchObject({ ok: false, refused: true,
        result: `Emma: STUCK: screen and CLI state unchanged 40 min. A ${verdict} verdict would hide it; act on it, or record NEEDS_ACTION or BLOCKED.` });
    }
    expect((await tools.execute("space_pane_checked", { room: "Alex", pane: "Emma", verdict: "NEEDS_ACTION", note: "restarting it" }, ctx)).ok).toBe(true);
  });
});
