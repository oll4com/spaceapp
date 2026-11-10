import type { BrowserHostActorContext } from "@space/browser-host";
import { browserSelectStateSchema, type BrowserToolActionInput, type Pane } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { activeTabProfilePath, readChromeAutomationEndpoint } from "./cli-browser-cdp.js";
import { CdpClient, chooseOpenBrowserSelectOption, readOpenBrowserSelect, type BrowserSessionManager } from "./browser-sessions.js";
import type { SpaceApiConfig } from "./config.js";

type SelectAction = Extract<BrowserToolActionInput, { type: "select_state" | "select_choose" }>;

/**
 * The running Unix host may still have the top-document reader. Authorize through its normal action first, then use
 * the API's existing access to this tab's Chrome for an iframe dropdown's state and for every pick. No host restart or
 * automation lease is needed.
 */
export async function executeBrowserSelectAction(options: {
  manager: Pick<BrowserSessionManager, "action" | "captureFrame">;
  config: Pick<SpaceApiConfig, "browserHostTransport" | "browserSessionsProfileRoot">;
  pane: Pane;
  input: SelectAction;
  traceId: string;
  context: BrowserHostActorContext;
}, connect: (endpoint: string, timeoutMs: number) => Promise<Pick<CdpClient, "send" | "close">> = CdpClient.connect) {
  const { manager, config, pane, input, traceId, context } = options;
  if (config.browserHostTransport !== "unix") return manager.action(pane, input, traceId, context);
  // Preserve the host's session-id and control-lease checks before any direct CDP access, for both reads and picks.
  const checked = await manager.action(pane, { type: "select_state", sessionId: input.sessionId }, traceId, context);
  const existing = browserSelectStateSchema.nullable().safeParse(JSON.parse(checked.text ?? "null"));
  if (!existing.success) throw new SpaceConflictError("The dropdown state is unavailable.");
  // R20-3: the pick runs here for a top-document dropdown too: the running host's own copy still counts arrow keys from the selected option.
  if (existing.data && input.type === "select_state") return checked;
  const targetId = checked.session.activePageId;
  if (!targetId || !checked.session.pages.some(page => page.pageId === targetId)) {
    throw new SpaceConflictError("The browser's active tab is unavailable.");
  }
  const profile = await activeTabProfilePath(config.browserSessionsProfileRoot, pane, checked.session);
  const endpoint = await readChromeAutomationEndpoint(profile);
  if (!endpoint) throw new SpaceConflictError("The browser's live connection is unavailable.");
  const client = await connect(endpoint, 3_000);
  let sessionId: string | undefined;
  try {
    ({ sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
    const text = input.type === "select_state"
      ? JSON.stringify(await readOpenBrowserSelect((method, params, sid) => client.send(method, params, sid), sessionId))
      : await chooseOpenBrowserSelectOption(client, sessionId, input.index);
    const frame = input.type === "select_choose" ? await manager.captureFrame(checked.session.sessionId) : null;
    return { ...checked, text, frame };
  } finally {
    if (sessionId) await client.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    client.close();
  }
}
