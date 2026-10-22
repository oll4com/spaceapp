import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Pane, PaneCliSession } from "@space/contracts";
import { InMemoryRoomAgentMonitorRepository } from "@space/db";
import type { GatewayAccount, RoomAgentEvent } from "@space/contracts";
import { CLAUDE_LIMIT_CONTINUE, claudeLimitMoveDeps, createClaudeDirectPins, createClaudeLimitMove, type ClaudeLimitMoveDeps } from "../src/claude-limit-move.js";
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

function fixture(options: { mode?: Pane["mode"]; account?: string | null; ready?: boolean; pinned?: boolean; after?: Partial<RoomPaneObservation> } = {}) {
  let active = session("cli_session:direct1", options.account === undefined ? null : options.account);
  const calls: string[] = [];
  const records: Array<{ outcome: string; text: string }> = [];
  const deps: ClaudeLimitMoveDeps = {
    listPanes: async () => [pane(options.mode)],
    activeSession: async () => active,
    inspect: async () => active.sessionId === "cli_session:direct1"
      ? observation(active.sessionId, { usageLimited: true })
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
    const deps = claudeLimitMoveDeps({ monitor, inspect: async () => observation("x"), pinnedDirect: async () => false, switchToGateway: async () => undefined,
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
