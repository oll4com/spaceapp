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
  const childSessions: string[] = [];
  try {
    ({ sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
    const inputs = await findFileInputs(client, sessionId, childSessions);
    const nodeIds = inputs.map((input) => input.nodeId);
    if (!nodeIds.length) throw new SpaceConflictError("No file input on this page: click the page's upload button or Next first.");
    if (index === undefined && nodeIds.length > 1) throw new SpaceConflictError(`${nodeIds.length} file inputs on this page: pass index (0 is the first in the page).`);
    const chosen = index ?? 0;
    if (chosen >= nodeIds.length) throw new SpaceConflictError(`Only ${nodeIds.length} file input(s) on this page: index ${chosen} is past them.`);
    await client.send("DOM.setFileInputFiles", { files: [...paths], nodeId: inputs[chosen]!.nodeId }, inputs[chosen]!.sessionId);
    return { uploaded: paths.map((path) => basename(path)), fileInputs: nodeIds.length, index: chosen,
      note: "Check with space_browser_masked_screenshot that the page shows the file name." };
  } finally {
    for (const child of childSessions) await client.send("Target.detachFromTarget", { sessionId: child }).catch(() => undefined);
    if (sessionId) await client.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    client.close();
  }
}

type DomNode = { nodeId: number; nodeName: string; attributes?: string[]; frameId?: string; children?: DomNode[]; shadowRoots?: DomNode[]; contentDocument?: DomNode };

/**
 * File inputs in document order, through iframes and shadow roots (27/11, Azure portal support request: the upload dialog's input
 * sits in the support extension's cross-site iframe). pierce:true walks same-process frames and shadow roots; a frame in another
 * process (no contentDocument) is its own target, whose id is the frame id, so it is attached and walked the same way.
 * Matched here instead of by an agent's selector: a fixed rule keeps the count from reading a fenced page.
 */
async function findFileInputs(client: Pick<CdpClient, "send">, sessionId: string, childSessions: string[]): Promise<Array<{ nodeId: number; sessionId: string }>> {
  const { root } = await client.send<{ root: DomNode }>("DOM.getDocument", { depth: -1, pierce: true }, sessionId);
  const found: Array<{ nodeId: number; sessionId: string }> = [];
  const walk = async (node: DomNode): Promise<void> => {
    const name = node.nodeName.toUpperCase();
    // attributes is a flat [name, value, ...] list.
    const attrs = node.attributes ?? [];
    if (name === "INPUT" && attrs.some((attr, at) => at % 2 === 0 && attr.toLowerCase() === "type" && attrs[at + 1]?.toLowerCase() === "file")) found.push({ nodeId: node.nodeId, sessionId });
    if (node.frameId && !node.contentDocument && (name === "IFRAME" || name === "FRAME")) {
      const child = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: node.frameId, flatten: true }).catch(() => null);
      if (child) {
        childSessions.push(child.sessionId);
        // A frame that went away mid-walk holds no input to set; the rest of the page still counts.
        found.push(...await findFileInputs(client, child.sessionId, childSessions).catch(() => []));
      }
    }
    for (const next of [...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : []), ...(node.children ?? [])]) await walk(next);
  };
  await walk(root);
  return found;
}
