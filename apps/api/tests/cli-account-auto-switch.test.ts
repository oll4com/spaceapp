import { describe, expect, it, vi } from "vitest";
import type { Pane, PaneCliSession } from "@space/contracts";
import { createCliAccountAutoSwitch } from "../src/cli-account-auto-switch.js";

const limitScreen = "● Working on the migration\n\nYou've reached your monthly quota for premium requests.\n\n❯ ";
const idleScreen = "Done. The tests pass.\n\n❯ ";

function setup(options: { runtimeId?: string; screen?: string; next?: string | null } = {}) {
  let clock = Date.parse("2026-10-12T12:10:00.000Z");
  let screen = options.screen ?? limitScreen;
  const runtimeId = options.runtimeId ?? "cli:copilot";
  let session = { sessionId: "cli_session:a", paneId: "pane:one", runtimeId, purpose: "NORMAL", isActive: true, status: "RUNNING",
    accountProfileId: "work", startedAt: "2026-10-12T12:00:00.000Z" } as unknown as PaneCliSession;
  const pane = { id: "pane:one", isClosed: false } as unknown as Pane;
  const balancer = {
    autoPanes: vi.fn(async () => ({ "pane:one": runtimeId as "cli:copilot" })),
    setAuto: vi.fn(async () => undefined),
    markExhausted: vi.fn(async () => new Date("2026-11-01T00:00:00.000Z")),
    pick: vi.fn(async () => (options.next === undefined ? "spare" : options.next))
  };
  const restart = vi.fn(async (_pane: Pane, _session: PaneCliSession, profileId: string) => {
    session = { ...session, sessionId: "cli_session:b", accountProfileId: profileId, startedAt: new Date(clock).toISOString() } as PaneCliSession;
  });
  const switcher = createCliAccountAutoSwitch({
    balancer, restart, now: () => clock,
    getPane: async () => pane,
    activeSession: async () => session,
    screenText: async () => screen
  });
  return { switcher, balancer, restart, advance: (ms: number) => { clock += ms; }, setScreen: (text: string) => { screen = text; } };
}

describe("CLI account Auto switch", () => {
  it("moves a Copilot pane to the next account after the limit stays on screen for two ticks, continuing the conversation", async () => {
    const { switcher, balancer, restart } = setup();
    await switcher.tick();
    expect(restart).not.toHaveBeenCalled();
    await switcher.tick();
    expect(balancer.markExhausted).toHaveBeenCalledWith("cli:copilot", "work");
    expect(balancer.pick).toHaveBeenCalledWith("cli:copilot", ["work"]);
    expect(restart).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: "cli_session:a" }), "spare", "RESUME",
      "Account work ran out of quota; Space moved this pane to account spare and continued the conversation.");
  });

  it("starts Cursor fresh, since its accounts share no conversations", async () => {
    const { switcher, restart } = setup({ runtimeId: "cli:cursor" });
    await switcher.tick();
    await switcher.tick();
    expect(restart.mock.calls[0]?.[3]).toBe("FRESH");
  });

  it("ignores a limit message that goes away, a session that just started, and switches at most once per cooldown", async () => {
    const { switcher, restart, advance, setScreen } = setup();
    await switcher.tick();
    setScreen(idleScreen);
    await switcher.tick();
    setScreen(limitScreen);
    await switcher.tick();
    expect(restart).not.toHaveBeenCalled();
    await switcher.tick();
    expect(restart).toHaveBeenCalledTimes(1);
    // The new session settles first, then the cooldown holds.
    advance(61_000);
    await switcher.tick();
    await switcher.tick();
    expect(restart).toHaveBeenCalledTimes(1);
    advance(5 * 60_000);
    await switcher.tick();
    await switcher.tick();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("marks the account but keeps the pane when no other account has room", async () => {
    const { switcher, balancer, restart } = setup({ next: null });
    await switcher.tick();
    await switcher.tick();
    expect(balancer.markExhausted).toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });
});
