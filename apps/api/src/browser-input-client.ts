import { BrowserHostClient } from "@space/browser-host";
import { keepBrowserHostErrorMessages, withBrowserHostErrorText } from "./browser-host-errors.js";
import { createBrowserHostProxy, type BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import type { SpaceApiConfig } from "./config.js";

/** The proxy's own default client and bounds, keeping the host's error messages (browser-host-errors.ts); its input goes below. */
export const messageKeepingBrowserHostClient = (config: SpaceApiConfig) => keepBrowserHostErrorMessages(new BrowserHostClient({
  socketPath: config.browserHostSocketPath, requestTimeoutMs: 30_000, healthTimeoutMs: 3_000, closeTimeoutMs: 1_000
}));

/**
 * Operator input on its own Browser Host socket whose timeout outlasts the host's own 30 s bound, so the host answers a
 * slow input itself. The proxy's 5 s input client dropped its shared socket on a timeout and failed every other pane's
 * in-flight input (Chrome acks inputs to a background tab 5 s late: all browsers, 2026-10-20). API only, same protocol.
 */
export function withHostBoundBrowserInput(
  manager: BrowserSessionManagerWithHostHealth,
  config: SpaceApiConfig,
  client = keepBrowserHostErrorMessages(new BrowserHostClient({ socketPath: config.browserHostSocketPath, requestTimeoutMs: 35_000, closeTimeoutMs: 1_000 }))
): BrowserSessionManagerWithHostHealth {
  if (config.browserHostTransport !== "unix") return manager;
  const input = createBrowserHostProxy({ config, client });
  const closeAll = manager.closeAll.bind(manager);
  // Round 9 item 4: an answer the host failed itself names its code instead of "unavailable" (browser-host-errors.ts).
  return withBrowserHostErrorText({
    ...manager,
    dispatchInput: input.dispatchInput,
    async closeAll() { await closeAll(); await input.closeAll(); }
  });
}
