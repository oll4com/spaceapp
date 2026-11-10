import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import type { Pane, PaneBrowserSession } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { activeTabProfilePath, readChromeAutomationEndpoint } from "./cli-browser-cdp.js";
import { CdpClient } from "./browser-sessions.js";
import type { SpaceApiConfig } from "./config.js";
import { deniedPath } from "./nous/files.js";

/**
 * Upload a file into the pane browser's file input (31/10, Job Copilot: Index.dev, SuccessFactors and Workday ask for the CV after
 * the Vault filled the password, and a fenced page has no Playwright). Setting a file input writes into the page and reads no
 * value back, so the pane holding a Vault fence may do it (vault/protection.ts). It runs over the API's own connection to the
 * tab's Chrome, never the agent's CDP proxy, so it leaves the document clean for the next fill.
 */

/** Each path resolved (symlinks too) to a readable file inside the agent workspace or the owner's Job Copilot files; else refused. */
export async function uploadablePaths(paths: readonly string[], allowed: { roots: readonly string[]; files: readonly string[] }): Promise<string[]> {
  const roots = (await Promise.all(allowed.roots.map((root) => realpath(root).catch(() => null)))).filter((root): root is string => root !== null);
  const files = await Promise.all(allowed.files.map((file) => realpath(file).catch(() => null)));
  return Promise.all(paths.map(async (path) => {
    const real = isAbsolute(path) ? await realpath(path).catch(() => null) : null;
    if (!real) throw new SpaceConflictError(`${path} was not found: give the file's absolute path.`);
    const root = roots.find((candidate) => real.startsWith(`${candidate}${sep}`));
    if (!files.includes(real) && (!root || deniedPath(relative(root, real)))) {
      throw new SpaceConflictError(`${path} is not one of this pane's files: upload only from ~/agent-workspace or the Job Copilot's own files (CV, cover letter, photo), never a secret.`);
    }
    if (!(await stat(real)).isFile()) throw new SpaceConflictError(`${path} is not a file.`);
    // The Browser Host's Chrome runs as the API's user: what the API cannot read, Chrome cannot upload.
    await access(real, constants.R_OK).catch(() => { throw new SpaceConflictError(`${path} is private to the agent that wrote it: chmod 644 it, then upload again.`); });
    return real;
  }));
}

export async function uploadBrowserFiles(options: {
  config: Pick<SpaceApiConfig, "browserSessionsProfileRoot">;
  pane: Pane;
  session: PaneBrowserSession;
  /** Paths uploadablePaths returned. */
  paths: readonly string[];
  index?: number;
}, connect: (endpoint: string, timeoutMs: number) => Promise<Pick<CdpClient, "send" | "close">> = CdpClient.connect) {
  const { config, pane, session, paths, index } = options;
  const targetId = session.activePageId;
  if (!targetId || !session.pages.some((page) => page.pageId === targetId)) throw new SpaceConflictError("The browser's active tab is unavailable.");
  const endpoint = await readChromeAutomationEndpoint(await activeTabProfilePath(config.browserSessionsProfileRoot, pane, session));
  if (!endpoint) throw new SpaceConflictError("The browser's live connection is unavailable.");
  const client = await connect(endpoint, 3_000);
  let sessionId: string | undefined;
  try {
    ({ sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
    // shortcut: the top document only; a file input inside an iframe needs that frame's document, add it when a site needs it.
    const { root } = await client.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 }, sessionId);
    // A fixed selector: an agent's own one would turn the match count into a read of a fenced page (:placeholder-shown, :valid).
    const { nodeIds } = await client.send<{ nodeIds: number[] }>("DOM.querySelectorAll", { nodeId: root.nodeId, selector: 'input[type="file"]' }, sessionId);
    if (!nodeIds.length) throw new SpaceConflictError("No file input on this page: click the page's upload button or Next first.");
    if (index === undefined && nodeIds.length > 1) throw new SpaceConflictError(`${nodeIds.length} file inputs on this page: pass index (0 is the first in the page).`);
    const chosen = index ?? 0;
    if (chosen >= nodeIds.length) throw new SpaceConflictError(`Only ${nodeIds.length} file input(s) on this page: index ${chosen} is past them.`);
    await client.send("DOM.setFileInputFiles", { files: [...paths], nodeId: nodeIds[chosen] }, sessionId);
    return { uploaded: paths.map((path) => basename(path)), fileInputs: nodeIds.length, index: chosen,
      note: "Check with space_browser_masked_screenshot that the page shows the file name." };
  } finally {
    if (sessionId) await client.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    client.close();
  }
}
