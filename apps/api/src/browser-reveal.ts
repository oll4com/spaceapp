import type { Pane, PaneBrowserSession } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { activeTabProfilePath, readChromeAutomationEndpoint } from "./cli-browser-cdp.js";
import { CdpClient } from "./browser-sessions.js";
import type { SpaceApiConfig } from "./config.js";

/**
 * Go now lands on the spot (operator 3/11 12:40 BKK: a long filled form opened at its top, its reCAPTCHA and Submit at the bottom).
 * The first element of a fixed list that waits for the operator is scrolled into the middle of the tab (DOM.scrollIntoViewIfNeeded
 * centres it), over the API's own connection to the tab's Chrome like browser-file-upload.ts: no page script, and the answer names
 * only which kind matched, never page text.
 */
export const BROWSER_REVEAL_TARGETS = [
  ["recaptcha", '.g-recaptcha:not([data-size="invisible"]), iframe[title="reCAPTCHA"]:not(.grecaptcha-badge *)'],
  ["hcaptcha", '.h-captcha, iframe[src*="hcaptcha.com"][src*="checkbox"]'],
  ["turnstile", '.cf-turnstile, iframe[src*="challenges.cloudflare.com"]'],
  ["code", 'input[autocomplete="one-time-code"]'],
  ["required", ':is(input:not([type="hidden"]), select, textarea)[required]:invalid'],
  ["submit", 'button[type="submit"], input[type="submit"]']
] as const;
export type BrowserRevealKind = (typeof BROWSER_REVEAL_TARGETS)[number][0];

export async function revealBrowserNeed(options: {
  config: Pick<SpaceApiConfig, "browserSessionsProfileRoot">;
  pane: Pane;
  session: PaneBrowserSession;
  pageId: string;
}, connect: (endpoint: string, timeoutMs: number) => Promise<Pick<CdpClient, "send" | "close">> = CdpClient.connect): Promise<{ revealed: BrowserRevealKind | null }> {
  const { config, pane, session, pageId } = options;
  if (!session.pages.some((page) => page.pageId === pageId)) throw new SpaceConflictError("That tab is not open in this browser.");
  // The tab may live in another account's Chrome: resolve its profile as if it were the active one.
  const endpoint = await readChromeAutomationEndpoint(await activeTabProfilePath(config.browserSessionsProfileRoot, pane, { ...session, activePageId: pageId }));
  if (!endpoint) throw new SpaceConflictError("The browser's live connection is unavailable.");
  const client = await connect(endpoint, 3_000);
  let sessionId: string | undefined;
  try {
    ({ sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: pageId, flatten: true }));
    // shortcut: the top document only (a form inside an iframe is not searched); add its frame's document when a site needs it.
    const { root } = await client.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 }, sessionId);
    for (const [kind, selector] of BROWSER_REVEAL_TARGETS) {
      const { nodeIds } = await client.send<{ nodeIds: number[] }>("DOM.querySelectorAll", { nodeId: root.nodeId, selector }, sessionId);
      // A node with no box (display:none) throws; the next one, or the next kind, is tried. A header's search button is the first
      // submit in the page, a long form's own Submit the last.
      for (const nodeId of kind === "submit" ? [...nodeIds].reverse() : nodeIds) {
        if (await client.send("DOM.scrollIntoViewIfNeeded", { nodeId }, sessionId).then(() => true, () => false)) return { revealed: kind };
      }
    }
    return { revealed: null };
  } finally {
    if (sessionId) await client.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    client.close();
  }
}
