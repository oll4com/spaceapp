import { describe, expect, it } from "vitest";
import {
  HIDDEN_TERMINAL_CONTROL_HEARTBEAT_MIN_MS,
  resolveTerminalControlHeartbeatIntervalMs,
  shouldParkHiddenWarmSocket,
  shouldRefreshModelSettingsFromOutput
} from "../src/features/terminal-pane/hidden-warm-socket.js";

describe("hidden warm socket policy", () => {
  it("keeps hidden warm terminal connections alive instead of rebuilding on return", () => {
    expect(
      shouldParkHiddenWarmSocket({
        prefillEnabled: true,
        prefillReady: true,
        isVisible: false,
        isMinimized: false,
        documentHidden: false,
        hasOpenSocket: true,
        alreadyParked: false
      })
    ).toBe(false);

    expect(
      shouldParkHiddenWarmSocket({
        prefillEnabled: true,
        prefillReady: true,
        isVisible: true,
        isMinimized: false,
        documentHidden: false,
        hasOpenSocket: true,
        alreadyParked: false
      })
    ).toBe(false);

    expect(
      shouldParkHiddenWarmSocket({
        prefillEnabled: true,
        prefillReady: false,
        isVisible: false,
        isMinimized: false,
        documentHidden: false,
        hasOpenSocket: true,
        alreadyParked: false
      })
    ).toBe(false);

    expect(
      shouldParkHiddenWarmSocket({
        prefillEnabled: true,
        prefillReady: true,
        isVisible: false,
        isMinimized: true,
        documentHidden: false,
        hasOpenSocket: true,
        alreadyParked: false
      })
    ).toBe(false);
  });

  it("stretches controller heartbeats while hidden", () => {
    expect(
      resolveTerminalControlHeartbeatIntervalMs(10_000, {
        isVisible: true,
        isController: true
      })
    ).toBe(10_000);
    expect(
      resolveTerminalControlHeartbeatIntervalMs(10_000, {
        isVisible: false,
        isController: true
      })
    ).toBe(HIDDEN_TERMINAL_CONTROL_HEARTBEAT_MIN_MS);
  });

  it("keeps every controller heartbeat strictly inside the 30s API control lease", () => {
    const apiControlLeaseTtlMs = 30_000;
    for (const isVisible of [true, false]) {
      for (const configured of [0, 1_000, 10_000, 20_000, 60_000]) {
        const interval = resolveTerminalControlHeartbeatIntervalMs(configured, {
          isVisible,
          isController: true
        });
        expect(interval).toBeGreaterThan(0);
        expect(interval).toBeLessThan(apiControlLeaseTtlMs);
      }
    }
  });

  it("skips model-settings output refresh when the terminal is not interactive", () => {
    expect(
      shouldRefreshModelSettingsFromOutput({
        isVisible: true,
        isMinimized: false,
        documentHidden: false
      })
    ).toBe(true);
    expect(
      shouldRefreshModelSettingsFromOutput({
        isVisible: false,
        isMinimized: false,
        documentHidden: false
      })
    ).toBe(false);
  });
});
