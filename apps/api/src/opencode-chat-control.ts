import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import {
  createOpenCodeSession,
  openCodeServerIsHealthy,
  openCodeSessionExists,
  openCodeSpaceChatStateRoot,
  opencodeDirectParityRoot,
  opencodeServerControlPath,
  readOpenCodeServerControl,
  resolveOpenCodeTitleFallbackControl,
  type OpenCodeServerControl
} from "@space/opencode-control";
import { SpaceFeatureDisabledError, type SpaceStore } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";

/**
 * OpenCode for Chat panes: the shared server for the provider catalog, and one isolated OpenCode session per Space agent
 * session in its pane's or room's folder, created once (concurrent callers share it) and kept in a 0600 control file.
 * Dev never reaches stable's OpenCode.
 */
export function createOpenCodeChatControl(options: { opencodeStateRoot?: string }, config: SpaceApiConfig, store: SpaceStore) {
  const openCodeChatControlPromises = new Map<string, Promise<OpenCodeServerControl>>();
  // Dev runs as stable's user: it must never read stable's OpenCode access files or reach stable's shared server.
  const assertChatOpenCodeHere = () => { if (config.instance === "dev") throw new SpaceFeatureDisabledError("OPENCODE_SESSION_CONTROL_UNAVAILABLE", "OpenCode Chat is unavailable on dev: it runs only on the stable instance."); };
  const resolveChatOpenCodeCatalogControl = async (): Promise<OpenCodeServerControl> => {
    assertChatOpenCodeHere();
    const stateRoot = options.opencodeStateRoot ?? opencodeDirectParityRoot + "/state";
    const sharedControl = await resolveOpenCodeTitleFallbackControl(stateRoot);
    if (sharedControl && await openCodeServerIsHealthy(sharedControl)) return sharedControl;
    throw new SpaceFeatureDisabledError(
      "OPENCODE_SESSION_CONTROL_UNAVAILABLE",
      "Live OpenCode model control is unavailable; the Chat provider catalog could not be loaded."
    );
  };
  const resolveChatPaneOpenCodeControl = async (spaceAgentSessionId: string): Promise<OpenCodeServerControl> => {
    assertChatOpenCodeHere();
    if (!/^agent_session:[A-Za-z0-9_-]+$/.test(spaceAgentSessionId)) {
      throw new SpaceFeatureDisabledError(
        "OPENCODE_SESSION_CONTROL_UNAVAILABLE",
        "OpenCode Chat requires a valid isolated Space agent session."
      );
    }
    let targetDirectory = "/etc";
    try {
      const session = await store.getSpaceAgentSession(spaceAgentSessionId);
      if (session) {
        const pane = await store.getPane(session.paneId);
        if (pane?.cwd && pane.cwd.startsWith("/") && pane.cwd !== "/etc") {
          targetDirectory = pane.cwd;
        } else {
          const room = await store.getRoom(session.roomId);
          if (room?.projectPath && room.projectPath.startsWith("/")) {
            targetDirectory = room.projectPath;
          }
        }
      }
    } catch {
      // Best-effort lookup
    }
    const existing = await readOpenCodeServerControl(spaceAgentSessionId, openCodeSpaceChatStateRoot);
    if (
      existing &&
      (!existing.directory || existing.directory === targetDirectory) &&
      await openCodeServerIsHealthy(existing) &&
      await openCodeSessionExists(existing, existing.nativeSessionId)
    ) return existing;

    const inFlight = openCodeChatControlPromises.get(spaceAgentSessionId);
    if (inFlight) return inFlight;
    const createControl = (async () => {
      const sharedControl = await resolveChatOpenCodeCatalogControl();
      const nativeSessionId = await createOpenCodeSession(
        sharedControl,
        `Space Chat ${spaceAgentSessionId.slice(-12)}`,
        targetDirectory
      );
      if (!nativeSessionId) {
        throw new SpaceFeatureDisabledError(
          "OPENCODE_SESSION_CONTROL_UNAVAILABLE",
          "OpenCode could not create an isolated session for this Chat task."
        );
      }
      const control: OpenCodeServerControl = {
        ...sharedControl,
        spaceSessionId: spaceAgentSessionId,
        nativeSessionId,
        directory: targetDirectory,
        updatedAt: new Date().toISOString()
      };
      const controlPath = opencodeServerControlPath(spaceAgentSessionId, openCodeSpaceChatStateRoot);
      const temporaryPath = `${controlPath}.${process.pid}.${nanoid(8)}.tmp`;
      await mkdir(dirname(controlPath), { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, JSON.stringify(control, null, 2), { encoding: "utf8", mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, controlPath);
      const stored = await readOpenCodeServerControl(spaceAgentSessionId, openCodeSpaceChatStateRoot);
      if (!stored || stored.nativeSessionId !== nativeSessionId) {
        throw new SpaceFeatureDisabledError(
          "OPENCODE_SESSION_CONTROL_UNAVAILABLE",
          "The isolated OpenCode Chat session could not be persisted."
        );
      }
      return stored;
    })();
    openCodeChatControlPromises.set(spaceAgentSessionId, createControl);
    try {
      return await createControl;
    } finally {
      openCodeChatControlPromises.delete(spaceAgentSessionId);
    }
  };
  return { resolveChatOpenCodeCatalogControl, resolveChatPaneOpenCodeControl };
}
