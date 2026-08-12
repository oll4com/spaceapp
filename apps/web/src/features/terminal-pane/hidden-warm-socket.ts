/** After PREFILL is ready on a hidden warm pane, park the live WS to free host/browser sockets. */
export const HIDDEN_WARM_SOCKET_PARK_MS = 30_000;

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
