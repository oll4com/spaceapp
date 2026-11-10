// 28/10 (operator: "many panes showed CLI exit and I had to reconnect them"): Space's usage-limit move resumed six Claude panes
// on a new session, but their open terminals got the old session's exit and stayed on it. A server-side replacement now holds
// that exit and tells the terminals the successor (session_replaced), which TerminalPane already attaches to by itself.
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { CliTerminalManager } from "../src/cli-terminal.js";
import { getApiConfig } from "../src/config.js";

type Internals = {
  sessions: Map<string, unknown>;
  interrupt(sessionId: string): Promise<boolean>;
  broadcast(managed: unknown, message: unknown): void;
  broadcastExit(managed: unknown, message: unknown): void;
};

function harness() {
  const manager = new CliTerminalManager({ store: new InMemorySpaceStore(), config: getApiConfig({}), hostClient: {} as never, discoverRuntimes: vi.fn() });
  const internals = manager as unknown as Internals;
  const sent: Array<[string, unknown]> = [];
  vi.spyOn(internals, "broadcast").mockImplementation((managed, message) => { sent.push([(managed as { sessionId: string }).sessionId, message]); });
  const open = (sessionId: string) => {
    const managed = { sessionId, sockets: new Set(), socketReplayBuffers: new Map() };
    internals.sessions.set(sessionId, managed);
    return managed;
  };
  return { manager, internals, sent, open };
}
const exited = { type: "status", status: "EXITED", statusReason: "CLI process exited by signal 9.", exitCode: null };

describe("server-side CLI session replacement", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("holds the old session's exit and sends its terminals the successor instead", () => {
    const f = harness();
    const old = f.open("cli_session:old0001");
    f.manager.holdExitForReplacement("cli_session:old0001");
    f.internals.sessions.delete("cli_session:old0001");
    f.internals.broadcastExit(old, exited);
    expect(f.sent).toEqual([]);
    f.manager.announceReplacement("cli_session:old0001", "cli_session:new0001");
    expect(f.sent).toEqual([["cli_session:old0001", { type: "session_replaced", sessionId: "cli_session:new0001" }]]);
    // Announced once; a later exit of the same session goes out as before.
    f.manager.announceReplacement("cli_session:old0001", "cli_session:other01");
    f.internals.broadcastExit(old, exited);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toEqual(["cli_session:old0001", exited]);
  });

  it("sends the held exit at once when the replacement fails (policy restart)", async () => {
    const f = harness();
    const old = f.open("cli_session:old0003");
    vi.spyOn(f.internals, "interrupt").mockImplementation(async () => {
      f.internals.broadcastExit(old, exited);
      throw new Error("host gone");
    });
    await expect(f.manager.replaceSessionForPolicyRestart("cli_session:old0003", {} as never, "trace:t", async () => { throw new Error("unused"); })).rejects.toThrow("host gone");
    expect(f.sent).toEqual([["cli_session:old0003", exited]]);
  });

  it("sends the held exit when no successor comes within 30 s, and leaves sessions nobody replaces alone", () => {
    vi.useFakeTimers();
    const f = harness();
    const old = f.open("cli_session:old0002");
    f.manager.holdExitForReplacement("cli_session:old0002");
    f.internals.broadcastExit(old, exited);
    vi.advanceTimersByTime(29_000);
    expect(f.sent).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(f.sent).toEqual([["cli_session:old0002", exited]]);
    const plain = f.open("cli_session:plain01");
    f.internals.broadcastExit(plain, exited);
    expect(f.sent.at(-1)).toEqual(["cli_session:plain01", exited]);
    // A session with no open terminal has nothing to hold.
    f.manager.holdExitForReplacement("cli_session:unknown");
    f.manager.announceReplacement("cli_session:unknown", "cli_session:new0002");
    expect(f.sent).toHaveLength(2);
  });
});
