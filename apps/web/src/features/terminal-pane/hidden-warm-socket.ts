/** Legacy deadline, retained for the guarded parking/recovery path. */
export const HIDDEN_WARM_SOCKET_PARK_MS = 30_000;

// Warm rooms must retain their live terminal connection as well as their room
// layer. Parking after 30s caused a fresh ticket, xterm rebuild and replay on
// return, even with warm cache enabled. User-requested restoration 2026-09-05.
// The bounded room cache still disposes terminals when a room is evicted.
export const HIDDEN_WARM_SOCKET_PARK_ENABLED = false;

/** Controller heartbeats run less often while the pane is not interactive. */
export const HIDDEN_TERMINAL_CONTROL_HEARTBEAT_MIN_MS = 30_000;

export function shouldParkHiddenWarmSocket(input: {
  prefillEnabled: boolean;
  prefillReady: boolean;
  isVisible: boolean;
  isMinimized: boolean;
  documentHidden: boolean;
  hasOpenSocket: boolean;
  alreadyParked: boolean;
}): boolean {
  return (
    HIDDEN_WARM_SOCKET_PARK_ENABLED &&
    input.prefillEnabled &&
    input.prefillReady &&
    !input.isVisible &&
    !input.isMinimized &&
    !input.documentHidden &&
    input.hasOpenSocket &&
    !input.alreadyParked
  );
}

export function resolveTerminalControlHeartbeatIntervalMs(
  configuredIntervalMs: number,
  input: { isVisible: boolean; isController: boolean }
): number {
  const base = Math.max(1_000, Math.floor(configuredIntervalMs) || 10_000);
  if (!input.isController) return base;
  if (input.isVisible) return base;
  return Math.max(base, HIDDEN_TERMINAL_CONTROL_HEARTBEAT_MIN_MS);
}

export function shouldRefreshModelSettingsFromOutput(input: {
  isVisible: boolean;
  isMinimized: boolean;
  documentHidden: boolean;
}): boolean {
  return input.isVisible && !input.isMinimized && !input.documentHidden;
}
