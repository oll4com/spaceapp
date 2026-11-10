import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  openCodeServerIsHealthy,
  opencodeDirectParityRoot,
  readOpenCodeServerControl,
  resolveOpenCodeTitleFallbackControl,
  type OpenCodeServerControl
} from "@space/opencode-control";
import type { PaneCliSession } from "@space/contracts";
import { SpaceFeatureDisabledError } from "@space/runtime";

/**
 * The live OpenCode server control of a pane's CLI session: its control file, else its session mapping on the shared
 * server; refused (OPENCODE_SESSION_CONTROL_UNAVAILABLE) when neither answers, so the session is left unchanged.
 */
export function createOpenCodeServerControlResolver(options: { opencodeStateRoot?: string }) {
  const readOpenCodeServerControlFromMapping = async (spaceSessionId: string, stateRoot?: string): Promise<OpenCodeServerControl | null> => {
    const resolvedStateRoot = stateRoot ?? join(opencodeDirectParityRoot, "state");
    const safeName = spaceSessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
    const mappingPath = join(resolvedStateRoot, "opencode", "space-cli-sessions", `${safeName}.json`);
    try {
      const text = await readFile(mappingPath, "utf8");
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const nativeSessionId = typeof parsed.nativeSessionId === "string" ? parsed.nativeSessionId : "";
      if (!/^ses_[A-Za-z0-9]+$/.test(nativeSessionId)) return null;
      const fallback = await resolveOpenCodeTitleFallbackControl(resolvedStateRoot);
      if (!fallback) return null;
      return {
        ...fallback,
        spaceSessionId,
        nativeSessionId,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt
      };
    } catch {
      return null;
    }
  };
  const resolveOpenCodeServerControl = async (session: PaneCliSession): Promise<OpenCodeServerControl> => {
    let control = await readOpenCodeServerControl(session.sessionId, options.opencodeStateRoot);
    if (!control) {
      control = await readOpenCodeServerControlFromMapping(session.sessionId, options.opencodeStateRoot);
    }
    if (!control || !(await openCodeServerIsHealthy(control))) {
      throw new SpaceFeatureDisabledError(
        "OPENCODE_SESSION_CONTROL_UNAVAILABLE",
        "Live OpenCode model control is unavailable; the current CLI session was left unchanged."
      );
    }
    if (!control.directory && session.cwd) {
      control.directory = session.cwd;
    }
    return control;
  };
  return { readOpenCodeServerControlFromMapping, resolveOpenCodeServerControl };
}
