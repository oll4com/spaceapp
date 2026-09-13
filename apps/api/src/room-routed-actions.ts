import { PANE_CATALOG_VERSION, type RoomMiniRoute } from "@space/contracts";
import type { BrowserHostActorContext } from "@space/browser-host";
import { SpaceConflictError } from "@space/runtime";
import type { createRoomPaneCommands } from "./room-pane-commands.js";
import type { createRoomQuickActions, RoomQuickActionResult } from "./room-quick-actions.js";

/** Decisions arrive only after Room Agent has durably claimed the original request. */
export function createRoomRoutedActions(options: {
  panes: Pick<ReturnType<typeof createRoomPaneCommands>, "execute">;
  quick: ReturnType<typeof createRoomQuickActions>;
  publish(roomId: string): Promise<void>;
  control?(roomId: string, command: Extract<RoomMiniRoute,{type:"CONTROL"}>, requestId: string, actor?: BrowserHostActorContext): Promise<RoomQuickActionResult>;
}) {
  return async (roomId: string, command: Exclude<RoomMiniRoute, { type: "ADVANCED" }>, requestId: string,
    traceId: string, actor?: BrowserHostActorContext): Promise<RoomQuickActionResult> => {
    if (command.type === "CONTROL") {
      if (!options.control) throw new SpaceConflictError("Space control is unavailable.");
      return options.control(roomId,command,requestId,actor);
    }
    if (command.type === "CLARIFY") return { summary: command.reason };
    if (command.type === "OPEN_PANES") {
      if (!actor || actor.holderType !== "OPERATOR") throw new SpaceConflictError("An authenticated operator is required to open room panes.");
      const result = await options.panes.execute(roomId, actor.holderId, {
        requestId, catalogVersion: PANE_CATALOG_VERSION, action: command
      }, traceId);
      await options.publish(roomId);
      return { summary: `Created ${result.data.length} pane${result.data.length === 1 ? "" : "s"}. Connecting the panes…` };
    }
    return options.quick(roomId, command.type === "PLAYBACK" ? { ...command, type: "MUSIC" } : command, traceId, actor);
  };
}
