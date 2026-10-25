import { describe, expect, it } from "vitest";
import {
  isRecoverableTerminalControlDenial,
  nextTerminalControlReplayBudget,
  terminalControlDenialReplay,
  terminalControlDenialReplayBudgetWindowMs,
  terminalControlDenialReplayMaxAttempts,
  terminalControlDenialReplayWindowMs,
  type RecordedTerminalControlMutation,
  type TerminalControlReplayBudget
} from "../src/features/terminal-pane/terminal-control-recovery.js";

const nowMs = 1_000_000;

function record(overrides: Partial<RecordedTerminalControlMutation> = {}): RecordedTerminalControlMutation {
  return {
    data: "sk-live-key\r",
    source: "react paste text",
    display: "hidden",
    preserveNotice: false,
    options: {},
    leaseId: "lease_1",
    sentAtMs: nowMs,
    ...overrides
  };
}

const freshBudget: TerminalControlReplayBudget = { attempts: 0, windowStartedAtMs: 0 };

describe("terminal control denial recovery", () => {
  it("treats only missing or stale lease denials as recoverable", () => {
    expect(isRecoverableTerminalControlDenial("CLI_CONTROL_REQUIRED")).toBe(true);
    expect(isRecoverableTerminalControlDenial("CLI_LEASE_STALE")).toBe(true);
    expect(isRecoverableTerminalControlDenial("CLI_CONTROL_HELD")).toBe(false);
    expect(isRecoverableTerminalControlDenial("CLI_OBSERVER_MUTATION_DENIED")).toBe(false);
  });

  it("replays the mutation the API rejected as stale", () => {
    expect(
      terminalControlDenialReplay({
        code: "CLI_LEASE_STALE",
        record: record(),
        nowMs,
        replayBudget: freshBudget
      })
    ).toBe("REPLAY");
  });

  it("ignores denials that are not about a lost lease", () => {
    expect(
      terminalControlDenialReplay({
        code: "CLI_CONTROL_HELD",
        record: record(),
        nowMs,
        replayBudget: freshBudget
      })
    ).toBe("NOT_A_CONTROL_DENIAL");
  });

  it("does nothing when no mutation is pending acknowledgement", () => {
    expect(
      terminalControlDenialReplay({
        code: "CLI_CONTROL_REQUIRED",
        record: null,
        nowMs,
        replayBudget: freshBudget
      })
    ).toBe("NO_PENDING_MUTATION");
  });

  it("does not resurrect input the operator sent long before the denial", () => {
    expect(
      terminalControlDenialReplay({
        code: "CLI_CONTROL_REQUIRED",
        record: record({ sentAtMs: nowMs - terminalControlDenialReplayWindowMs - 1 }),
        nowMs,
        replayBudget: freshBudget
      })
    ).toBe("STALE_MUTATION");
  });

  it("stops retrying once the replay budget inside the window is spent", () => {
    const spent: TerminalControlReplayBudget = { attempts: terminalControlDenialReplayMaxAttempts, windowStartedAtMs: nowMs - 1_000 };
    expect(
      terminalControlDenialReplay({
        code: "CLI_CONTROL_REQUIRED",
        record: record(),
        nowMs,
        replayBudget: spent
      })
    ).toBe("REPLAY_BUDGET_EXHAUSTED");
  });

  it("credits a fresh budget once the budget window has passed", () => {
    const spent: TerminalControlReplayBudget = {
      attempts: terminalControlDenialReplayMaxAttempts,
      windowStartedAtMs: nowMs - terminalControlDenialReplayBudgetWindowMs - 1
    };
    expect(
      terminalControlDenialReplay({
        code: "CLI_CONTROL_REQUIRED",
        record: record(),
        nowMs,
        replayBudget: spent
      })
    ).toBe("REPLAY");
  });

  it("counts attempts inside the window and restarts the window after it", () => {
    const first = nextTerminalControlReplayBudget(freshBudget, nowMs);
    expect(first).toEqual({ attempts: 1, windowStartedAtMs: nowMs });
    const second = nextTerminalControlReplayBudget(first, nowMs + 5_000);
    expect(second).toEqual({ attempts: 2, windowStartedAtMs: nowMs });
    const later = nextTerminalControlReplayBudget(second, nowMs + terminalControlDenialReplayBudgetWindowMs + 1);
    expect(later).toEqual({ attempts: 1, windowStartedAtMs: nowMs + terminalControlDenialReplayBudgetWindowMs + 1 });
  });
});
