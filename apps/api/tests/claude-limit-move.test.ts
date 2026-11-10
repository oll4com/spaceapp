import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Pane, PaneCliSession } from "@space/contracts";
import { InMemoryControlRepository, InMemoryRoomAgentMonitorRepository } from "@space/db";
import type { GatewayAccount, RoomAgentEvent, SpaceNotification } from "@space/contracts";
import { switchClaudePaneAccount, type ClaudeAccountSwitchDeps } from "../src/claude-account-switch.js";
import { CLAUDE_LAUNCH_ENV_SINCE, CLAUDE_LIMIT_CONTINUE, claudeLimitMoveDeps, controlPaceHolds, createClaudeDirectPins, createClaudeLimitMove, type ClaudeLimitMoveDeps } from "../src/claude-limit-move.js";
import { atEmptyPrompt } from "../src/room-agent-autopilot.js";
import type { RoomPaneObservation } from "../src/room-pane-control.js";

// Operator order 2026-10-20 (plan clipboard:UxdCDqktJhAN): a Claude pane at its account's usage limit moves to Space Gateway and continues.
const pane = (mode: Pane["mode"] = "TERMINAL") => ({ id: "pane:limited1", roomId: "room:alex1", title: "Paul", paneName: "Paul", mode,
  terminalRuntimeId: "cli:claude", isClosed: false }) as Pane;
const session = (sessionId: string, accountProfileId: string | null) => ({ sessionId, paneId: "pane:limited1", runtimeId: "cli:claude",
  purpose: "NORMAL", isActive: true, status: "RUNNING", accountProfileId }) as PaneCliSession;
const observation = (sessionId: string, extra: Partial<RoomPaneObservation> = {}): RoomPaneObservation => ({ paneId: "pane:limited1", title: "Paul",
  runtimeId: "cli:claude", sessionId, state: "IDLE", nativeTaskRef: null, modelId: null, nativeMode: null, checkedAt: "2026-10-20T14:00:00.000Z",
  tasks: [], text: "────\n❯ \n────", promptFingerprint: `fp-${sessionId}`, ...extra });

function fixture(options: { mode?: Pane["mode"]; account?: string | null; ready?: boolean; pinned?: boolean; after?: Partial<RoomPaneObservation>;
  limitedState?: RoomPaneObservation["state"] } = {}) {
  let active = session("cli_session:direct1", options.account === undefined ? null : options.account);
  const calls: string[] = [];
  const records: Array<{ outcome: string; text: string }> = [];
  const deps: ClaudeLimitMoveDeps = {
    listPanes: async () => [pane(options.mode)],
    activeSession: async () => active,
    inspect: async () => active.sessionId === "cli_session:direct1"
      ? observation(active.sessionId, { usageLimited: true, state: options.limitedState ?? "IDLE" })
      : observation(active.sessionId, options.after),
    gatewayReady: async () => options.ready ?? true,
    pinnedDirect: async () => options.pinned ?? false,
    switchToGateway: async (_pane, from) => { calls.push(`switch ${from.sessionId}`); active = session("cli_session:gateway1", "space-gateway"); },
    answer: async (_pane, input) => { calls.push(`type ${input.answer} into ${input.expectedSessionId}`); },
    record: async (_pane, outcome, text) => { records.push({ outcome, text }); }
  };
  return { mover: createClaudeLimitMove(deps), calls, records };
}

describe("Claude panes at a usage limit move to Space Gateway", () => {
  it("logs a failed pane read instead of an unhandled rejection (API audit 5/11: stable's database in recovery)", async () => {
    const logged: string[] = [];
    const mover = createClaudeLimitMove({ listPanes: async () => { throw new Error("timeout exceeded when trying to connect"); },
      log: (event) => { logged.push(event); } } as unknown as ClaudeLimitMoveDeps);
    await expect(mover.tick()).resolves.toBeUndefined();
    expect(logged).toEqual(["claude_limit.failed"]);
  });

  it("tells Nous once per session when a Claude session starts on a direct account the operator did not pick (R13-13)", async () => {
    // Operator 29/10 13:23 BKK: 9 Claude panes ran on the direct account after a reopen, restart or start_agent and Nous never saw it.
    const notices: Array<{ owner: string; key: string; line: string }> = [];
    let profileReady = false;
    const wired = claudeLimitMoveDeps({ monitor: new InMemoryRoomAgentMonitorRepository(), inspect: async () => observation("x"), pinnedDirect: async () => false,
      switchAccount: async () => true, answer: async () => undefined, gatewayProfileReady: async () => profileReady,
      gatewayAccounts: async () => ({ data: [{ provider: "CLAUDE", status: "ACTIVE", planType: "max" }] as never }),
      store: { getRoom: async () => ({ id: "room:alex1", ownerUserId: "user:operator" }) } as never, onEvent: async () => undefined, onAttention: () => undefined,
      paneReports: () => null, notice: async (owner, key, line) => { notices.push({ owner, key, line }); } });
    let active = session("cli_session:main0001", "main");
    let pinned = false;
    const mover = createClaudeLimitMove({ ...wired, listPanes: async () => [pane()], activeSession: async () => active, pinnedDirect: async () => pinned,
      inspect: async () => observation(active.sessionId), record: async () => undefined });
    // A self-hosted install has no space-gateway profile: nothing to move it to, so Nous hears nothing (1.2.0 lab 2/11).
    await mover.tick();
    expect(notices).toEqual([]);
    profileReady = true;
    await mover.tick();
    await mover.tick();
    expect(notices).toEqual([{ owner: "user:operator", key: "claude-direct-account:cli_session:main0001", line: expect.stringContaining('Paul (pane:limited1) started a Claude session on the direct account "main"') }]);
    expect(notices[0]!.line).toContain('accountProfileId: "space-gateway", when: "AFTER_TURN"');
    // A pane the operator pinned, or a session on Space Gateway, never reaches Nous.
    active = session("cli_session:main0002", "main");
    pinned = true;
    await mover.tick();
    active = session("cli_session:gateway2", "space-gateway");
    pinned = false;
    await mover.tick();
    expect(notices).toHaveLength(1);
  });

  it("moves a limited terminal or copilot pane on its direct account, then types continue at the restarted CLI's empty prompt, once", async () => {
    for (const mode of ["TERMINAL", "DESIGN"] as const) {
      const f = fixture({ mode });
      await f.mover.tick();
      expect(f.calls).toEqual(["switch cli_session:direct1"]);
      await f.mover.tick();
      expect(f.calls).toEqual(["switch cli_session:direct1", `type ${CLAUDE_LIMIT_CONTINUE} into cli_session:gateway1`]);
      expect(f.records).toEqual([{ outcome: "MOVED", text: expect.stringContaining("Space Gateway") }]);
      await f.mover.tick();
      expect(f.calls).toHaveLength(2);
    }
  });

  it("leaves the pane when Space Gateway has no ready Claude account, and says so once", async () => {
    const f = fixture({ ready: false });
    await f.mover.tick();
    await f.mover.tick();
    expect(f.calls).toEqual([]);
    expect(f.records).toEqual([{ outcome: "STAYS", text: expect.stringContaining("no ready Claude account") }]);
  });

  it("says once, after two minutes, that a limited turn Claude keeps running waits, and does not restart it (Cleo/Dana 2026-10-21)", async () => {
    const f = fixture({ limitedState: "RUNNING" });
    for (let tick = 0; tick < 3; tick += 1) await f.mover.tick();
    expect(f.records).toEqual([]);
    for (let tick = 0; tick < 4; tick += 1) await f.mover.tick();
    expect(f.calls).toEqual([]);
    expect(f.records).toEqual([{ outcome: "STAYS", text: expect.stringContaining("while its turn still runs (background agents or shells)") }]);
    expect(await f.mover.gatewayReady()).toBe(true);
  });

  it("leaves a pane the operator put on its direct account", async () => {
    const f = fixture({ pinned: true });
    await f.mover.tick();
    expect(f.calls).toEqual([]);
    expect(f.records).toEqual([{ outcome: "STAYS", text: expect.stringContaining("you picked") }]);
  });

  it("does nothing for a pane already on Space Gateway", async () => {
    const f = fixture({ account: "space-gateway" });
    await f.mover.tick();
    expect(f.calls).toEqual([]);
    expect(f.records).toEqual([]);
  });

  it("never types into a draft: after a few tries it reports the move without continue", async () => {
    const f = fixture({ after: { text: "────\n❯ half-written note\n────" } });
    for (let tick = 0; tick < 10; tick++) await f.mover.tick();
    expect(f.calls).toEqual(["switch cli_session:direct1"]);
    expect(f.records).toEqual([{ outcome: "NOT_CONTINUED", text: expect.stringContaining("continue") }]);
  });

  it("keeps kickoffs and scheduled prompts away from a pane at a usage limit", () => {
    expect(atEmptyPrompt(observation("cli_session:direct1"))).toBe(true);
    expect(atEmptyPrompt(observation("cli_session:direct1", { usageLimited: true }))).toBe(false);
  });

  it("remembers the operator's own account pick for a pane across API restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-direct-pins-"));
    try {
      const path = join(root, "state", "claude-direct-pins.json");
      await createClaudeDirectPins(path).set("pane:limited1", true);
      expect(await createClaudeDirectPins(path).has("pane:limited1")).toBe(true);
      await createClaudeDirectPins(path).set("pane:limited1", false);
      expect(await createClaudeDirectPins(path).has("pane:limited1")).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("counts only an active Claude subscription account as ready, and records a stay, then the move that settles it", async () => {
    const monitor = new InMemoryRoomAgentMonitorRepository();
    const seen: RoomAgentEvent[] = [];
    const attention: string[] = [];
    const notes: string[] = [];
    let accounts = [{ provider: "CLAUDE", status: "ACTIVE", planType: "api" }, { provider: "CLAUDE", status: "RATE_LIMITED", planType: "max5x" }];
    const deps = claudeLimitMoveDeps({ monitor, inspect: async () => observation("x"), pinnedDirect: async () => false, switchAccount: async () => true,
      answer: async () => undefined, gatewayProfileReady: async () => true, gatewayAccounts: async () => ({ data: accounts as GatewayAccount[] }),
      store: { getRoom: async () => ({ id: "room:alex1" }) } as never, onEvent: async (event) => { seen.push(event); },
      onAttention: (event) => attention.push(event.eventId), paneReports: () => ({ note: async (_room: unknown, _pane: unknown, status: string) => { notes.push(status); } }) as never });
    expect(await deps.gatewayReady()).toBe(false);
    accounts = [...accounts, { provider: "CLAUDE", status: "ACTIVE", planType: "max5x" }];
    expect(await deps.gatewayReady()).toBe(true);

    await deps.record(pane(), "STAYS", "hit its Claude usage limit and stays there: Space Gateway has no ready Claude account");
    const stay = seen[0]!;
    expect(stay).toMatchObject({ kind: "USAGE_LIMIT", severity: "ATTENTION", status: "OPEN", title: expect.stringMatching(/^Paul hit/) });
    expect(attention).toEqual([stay.eventId]);
    await deps.record(pane(), "MOVED", "hit its Claude usage limit; Space moved it to Space Gateway");
    expect(await monitor.getEvent(stay.eventId)).toMatchObject({ status: "RESOLVED" });
    expect(seen.at(-1)).toMatchObject({ kind: "USAGE_LIMIT", severity: "INFO", status: "HANDLED" });
    expect(attention).toHaveLength(1);
    expect(notes).toEqual(["BLOCKED", "PROGRESS"]);
  });
});

// Operator 6/11 (plan clipboard:DotwYXVD2N3n): Cleo/Finn's three briefs ended on 429 PACE_CAP and read COMPLETED although none ran.
describe("Claude panes on Space Gateway that its pace cap held continue once", () => {
  const gatewaySession = session("cli_session:gateway1", "space-gateway");
  const held = { taskId: "prompt-held1", at: "2026-11-06T04:14:58.000Z", resumesAt: "2026-11-06T21:00:00.000Z" };
  function heldFixture(options: { exempt?: boolean; answerFails?: number } = {}) {
    let clock = Date.parse("2026-11-06T05:00:00.000Z");
    let exempt = options.exempt ?? false;
    let failures = options.answerFails ?? 0;
    let paceHold: RoomPaneObservation["paceHold"] = held;
    const typed: string[] = [];
    const records = new InMemoryControlRepository();
    const deps = {
      listPanes: async () => [pane()], activeSession: async () => gatewaySession,
      inspect: async () => observation(gatewaySession.sessionId, { paceHold, usageLimited: Boolean(paceHold) }),
      gatewayReady: async () => true, pinnedDirect: async () => false, switchToGateway: async () => undefined, record: async () => undefined,
      answer: async (_pane: Pane, input: { answer: string }) => { if (failures-- > 0) throw new Error("the prompt changed"); typed.push(input.answer); },
      paceHolds: controlPaceHolds(records, async () => exempt), now: () => clock
    } as unknown as ClaudeLimitMoveDeps;
    return { mover: createClaudeLimitMove(deps), typed, records, advance: (ms: number) => { clock += ms; }, exempt: () => { exempt = true; },
      ran: () => { paceHold = null; }, heldAgain: (taskId: string) => { paceHold = { ...held, taskId }; } };
  }

  it("waits for the pace day, then types continue once, never twice, and records the held turn", async () => {
    const f = heldFixture();
    await f.mover.tick();
    expect(f.typed).toEqual([]);
    expect((await f.records.get("pane_state", "space", "pace-hold:pane:limited1"))?.value).toMatchObject({ heldTaskId: "prompt-held1", status: "WAITING",
      resumesAt: "2026-11-06T21:00:00.000Z" });
    f.advance(16 * 3_600_000 + 1);
    await f.mover.tick();
    expect(f.typed).toEqual([CLAUDE_LIMIT_CONTINUE]);
    // The screen still shows the held turn for a tick or two: nothing more is typed.
    await f.mover.tick();
    await f.mover.tick();
    expect(f.typed).toEqual([CLAUDE_LIMIT_CONTINUE]);
    expect((await f.records.get("pane_state", "space", "pace-hold:pane:limited1"))?.value).toMatchObject({ status: "TYPED" });
    // A later turn the cap holds again is a new hold: it gets its own single continue.
    f.heldAgain("prompt-held2");
    await f.mover.tick();
    expect(f.typed).toEqual([CLAUDE_LIMIT_CONTINUE, CLAUDE_LIMIT_CONTINUE]);
    await f.mover.tick();
    expect(f.typed).toHaveLength(2);
  });

  it("types at once when the pane becomes exempt (an open operator request, Nous's emergency), and again only after a failed typing", async () => {
    const f = heldFixture({ answerFails: 1 });
    await f.mover.tick();
    expect(f.typed).toEqual([]);
    f.exempt();
    await f.mover.tick();
    expect(f.typed).toEqual([]);
    expect((await f.records.get("pane_state", "space", "pace-hold:pane:limited1"))?.value).toMatchObject({ status: "WAITING" });
    await f.mover.tick();
    expect(f.typed).toEqual([CLAUDE_LIMIT_CONTINUE]);
    await f.mover.tick();
    expect(f.typed).toEqual([CLAUDE_LIMIT_CONTINUE]);
  });

  it("never types twice when two movers race on the same held turn", async () => {
    const f = heldFixture({ exempt: true });
    const second = createClaudeLimitMove({ listPanes: async () => [pane()], activeSession: async () => gatewaySession,
      inspect: async () => observation(gatewaySession.sessionId, { paceHold: held, usageLimited: true }),
      answer: async (_pane: Pane, input: { answer: string }) => { f.typed.push(`second ${input.answer}`); },
      paceHolds: controlPaceHolds(f.records, async () => true) } as unknown as ClaudeLimitMoveDeps);
    await Promise.all([f.mover.tick(), second.tick()]);
    await Promise.all([f.mover.tick(), second.tick()]);
    expect(f.typed).toHaveLength(1);
  });
});

describe("Claude CLIs started before the current launch env relaunch on the same conversation at an idle empty prompt (plan qH5emwVaV6yO step 8)", () => {
  // 6/11: five panes started before the 160k compact window still ran 400k, ~600M of 1.40B input; nobody should have to restart them.
  const stale = (startedAt = "2026-11-04T05:08:00.000Z") => ({ ...session("cli_session:old1", "space-gateway"), startedAt }) as PaneCliSession;
  function relauncher(options: { startedAt?: string; seen?: Partial<RoomPaneObservation>; card?: boolean; resumable?: boolean } = {}) {
    const relaunched: string[] = [];
    const logged: string[] = [];
    const deps = { listPanes: async () => [pane()], activeSession: async () => stale(options.startedAt),
      inspect: async () => observation("cli_session:old1", options.seen), waitsOnOperator: async () => options.card ?? false,
      relaunch: async (_pane: Pane, from: PaneCliSession) => { relaunched.push(from.sessionId); return options.resumable ?? true; },
      log: (event: string) => { logged.push(event); } } as unknown as ClaudeLimitMoveDeps;
    return { mover: createClaudeLimitMove(deps), relaunched, logged };
  }

  it("relaunches a stale CLI at its idle empty prompt, and never one started on the current env", async () => {
    const old = relauncher();
    await old.mover.tick();
    expect(old.relaunched).toEqual(["cli_session:old1"]);
    expect(old.logged).toEqual(["claude_launch_env.relaunched"]);
    const current = relauncher({ startedAt: CLAUDE_LAUNCH_ENV_SINCE });
    await current.mover.tick();
    expect(current.relaunched).toEqual([]);
  });

  it("waits while a turn runs, a draft is typed, a pace hold waits or a card for the operator is open on the pane", async () => {
    for (const options of [{ seen: { state: "RUNNING" as const } }, { seen: { text: "────\n❯ fix the login bug\n────" } },
      { seen: { paceHold: { taskId: "t1", at: null, resumesAt: "2026-11-07T00:00:00.000Z" } } }, { seen: { usageLimited: true } }, { card: true }]) {
      const waiting = relauncher(options);
      await waiting.mover.tick();
      expect(waiting.relaunched).toEqual([]);
    }
  });

  it("counts only an open needs-you card on the pane as waiting on the operator", async () => {
    const cards: Array<Partial<SpaceNotification>> = [];
    const wired = claudeLimitMoveDeps({ monitor: new InMemoryRoomAgentMonitorRepository(), inspect: async () => observation("x"), pinnedDirect: async () => false,
      switchAccount: async () => true, answer: async () => undefined, gatewayProfileReady: async () => true, gatewayAccounts: async () => ({ data: [] }),
      store: { getRoom: async () => ({ id: "room:alex1", ownerUserId: "user:operator" }) } as never, onEvent: async () => undefined, onAttention: () => undefined,
      paneReports: () => null,
      notifications: { list: async (_owner, query) => (query.status === "WAITING" && query.paneId === "pane:limited1" ? cards : []) as SpaceNotification[] } });
    expect(await wired.waitsOnOperator!(pane())).toBe(false);
    cards.push({ kind: "PROGRESS", severity: "INFO", paneId: "pane:limited1", roomId: "room:alex1" });
    expect(await wired.waitsOnOperator!(pane())).toBe(false);
    cards.push({ kind: "QUESTION", severity: "ATTENTION", paneId: "pane:limited1", roomId: "room:alex1" });
    expect(await wired.waitsOnOperator!(pane())).toBe(true);
  });

  it("resumes the same profile's conversation, and leaves a CLI with no native conversation alone", async () => {
    const calls: string[] = [];
    const switchDeps = (nativeTaskRef: string | null): ClaudeAccountSwitchDeps => ({
      store: { getCliAccountProfile: async () => ({}), getCliTaskRevision: async () => ({ nativeTaskRef }),
        updatePaneCliSession: async () => { calls.push("exited"); } } as never,
      inspect: async () => ({ state: "IDLE" }), now: () => "2026-11-06T06:00:00.000Z",
      resume: async (target, input) => { calls.push(`resume ${input.taskId} on ${input.accountProfileId}`); return { pane: target }; },
      ensureReady: async () => { calls.push("ready"); }, interrupt: async () => { calls.push("interrupt"); } });
    const from = { ...stale(), cliTaskId: "cli_task:1", cliTaskRevisionId: "cli_task_revision:1" } as PaneCliSession;
    expect(await switchClaudePaneAccount(switchDeps("5f0c2d1e-8a4b-4c3d-9e2f-1a2b3c4d5e6f"), pane(), from, "space-gateway", "trace:1", { relaunch: true })).toBe(true);
    expect(calls).toEqual(["resume cli_task:1 on space-gateway", "ready"]);
    calls.length = 0;
    expect(await switchClaudePaneAccount(switchDeps(null), pane(), from, "space-gateway", "trace:1", { relaunch: true })).toBe(false);
    expect(await switchClaudePaneAccount(switchDeps(null), pane(), from, "space-gateway", "trace:1")).toBe(false);
    expect(calls).toEqual([]);
  });
});
